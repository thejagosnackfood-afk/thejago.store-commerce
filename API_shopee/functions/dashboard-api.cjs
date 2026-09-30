const crypto = require('node:crypto');
const { createCloudTokenStore } = require('./cloud-token-store.cjs');
const { refreshShopeeToken } = require('./token-refresh.cjs');
const { getAuth } = require('firebase-admin/auth');
const BASE = 'https://partner.shopeemobile.com/api/v2';
const SHOP = () => Number(process.env.SHOPEE_DASHBOARD_SHOP_ID);
const OWNER = () => (process.env.SHOPEE_DASHBOARD_OWNER_EMAIL || '').trim().toLowerCase();
class ApiError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }
const fail = (status, message, details) => { throw new ApiError(status, message, details); };
function positive(value, label) { if (!Number.isSafeInteger(value) || value <= 0) fail(400, `${label} tidak valid.`); return value; }
function checkResult(data) {
  if (!data || typeof data !== 'object' || data.error) fail(502, `Shopee: ${data?.message || data?.error || 'Respons tidak valid'}`, { code: data?.error, requestId: data?.request_id });
  const r = data.response;
  const failures = [...(r?.failure_list || []), ...(r?.result_list || []).filter(x => x.fail_error || x.error)];
  if (failures.length) fail(502, 'Sebagian operasi ditolak Shopee.', { failures });
  return r || {};
}
function assertOwner(claims) {
  if (!OWNER() || claims.email_verified !== true || String(claims.email || '').toLowerCase() !== OWNER() || claims.firebase?.sign_in_provider !== 'google.com') fail(403, 'Akun ini tidak memiliki akses dashboard toko.');
}
async function verifyDashboardUser(bearer, verify = token => getAuth().verifyIdToken(token, true)) {
  let user;
  try { user = await verify(bearer); }
  catch (error) {
    if (['auth/insufficient-permission', 'auth/internal-error', 'auth/invalid-credential'].includes(error.code)) {
      fail(503, 'Layanan verifikasi login belum tersedia. Coba lagi beberapa saat.');
    }
    fail(401, 'Login kedaluwarsa atau tidak valid. Silakan masuk kembali.');
  }
  assertOwner(user);
  return user;
}
function storeContext() {
  if (!SHOP() || !OWNER() || !process.env.SHOPEE_PARTNER_KEY) fail(503, 'Dashboard belum dikonfigurasi.');
  const store = createCloudTokenStore(process.env.SHOPEE_PARTNER_KEY);
  return { store, db: store.database, shop: store.database.collection('shopeeDashboardShops').doc(String(SHOP())) };
}
async function shopContext() {
  const context = storeContext();
  const { store, db } = context;
  // Existing OAuth sessions are server-only. Select the newest valid session for the configured shop.
  // No caller can select another shop or supply a token document ID.
  const docs = await db.collection('shopeeConnectorSessions').limit(200).get();
  const sessions = [];
  for (const doc of docs.docs) {
    try {
      if (doc.data().version !== 2) continue;
      const record = store.decode(doc.data(), doc.id);
      if (record.expiresAt > Date.now() && Number(record.token.shop_id) === SHOP()) sessions.push({ ref: doc.ref, token: record.token });
    } catch { /* A different partner's encrypted record is not readable here. */ }
  }
  sessions.sort((a, b) => Number(b.token.expired_at) - Number(a.token.expired_at));
  if (!sessions.length) fail(409, 'Hubungkan ulang akun Shopee melalui halaman konektor.');
  const ref = sessions[0].ref;
  const config = { partnerId: Number(process.env.SHOPEE_PARTNER_ID), partnerKey: process.env.SHOPEE_PARTNER_KEY };
  const token = await store.refreshDocument(ref, old => refreshShopeeToken(config, BASE, old));
  if (!token?.access_token) fail(409, 'Sesi Shopee tidak tersedia. Hubungkan ulang akun.');
  async function api(path, params = {}, method = 'GET', binary = false) {
    const url = new URL(BASE + path);
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = crypto.createHmac('sha256', config.partnerKey).update(`${config.partnerId}${url.pathname}${timestamp}${token.access_token}${SHOP()}`).digest('hex');
    url.search = new URLSearchParams({ partner_id: String(config.partnerId), timestamp: String(timestamp), sign, access_token: token.access_token, shop_id: String(SHOP()) }).toString();
    if (method === 'GET') for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(entry));
    }
    let response;
    try { response = await fetch(url, { method, redirect: 'error', headers: { 'Content-Type': 'application/json' }, ...(method !== 'GET' ? { body: JSON.stringify(params) } : {}), signal: AbortSignal.timeout(25000) }); }
    catch { fail(502, 'Koneksi ke Shopee terputus. Periksa status sebelum mengulangi perubahan.'); }
    if (binary) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (response.ok && bytes.subarray(0, 5).toString() === '%PDF-') return bytes;
      try { checkResult(JSON.parse(bytes.toString())); } catch (e) { if (e instanceof ApiError) throw e; }
      fail(502, 'Dokumen PDF belum tersedia dari Shopee. Coba lagi setelah status resi siap.');
    }
    let data;
    try { data = await response.json(); } catch { fail(502, 'Respons Shopee tidak dapat dibaca.'); }
    if (!response.ok) fail(502, `Shopee menolak permintaan (HTTP ${response.status}).`);
    return checkResult(data);
  }
  return { ...context, api };
}
function productRow(item) {
  const stock = item.stock_info_v2?.summary_info?.total_available_stock;
  return { itemId: item.item_id, name: item.item_name, sku: item.item_sku || '', status: item.item_status, hasModel: Boolean(item.has_model),
    price: item.price_info?.[0]?.current_price ?? item.price_info?.[0]?.original_price ?? null,
    stock: stock ?? item.stock_info_v2?.seller_stock?.reduce((sum, x) => sum + (Number(x.stock) || 0), 0) ?? null,
    image: item.image?.image_url_list?.[0] || null, weight: Number(item.weight) || null, dimension: item.dimension || {}, logisticInfo: item.logistic_info || [], updatedAt: Date.now() };
}
async function productDetail(ctx, itemId) {
  const r = await ctx.api('/product/get_item_base_info', { item_id_list: itemId });
  const item = r.item_list?.find(x => x.item_id === itemId);
  if (!item) fail(404, 'Produk tidak ditemukan di toko ini.');
  return item;
}
async function syncProducts() {
  const ctx = await shopContext();
  const { shop, db, api } = ctx;
  const owner = crypto.randomUUID();
  await db.runTransaction(async tx => {
    const data = (await tx.get(shop)).data() || {};
    if (data.syncLeaseUntil > Date.now()) fail(409, 'Sinkronisasi masih berjalan.');
    tx.set(shop, { syncOwner: owner, syncLeaseUntil: Date.now() + 10 * 60000, syncStatus: 'running' }, { merge: true });
  });
  const generation = shop.collection('snapshots').doc(owner);
  let count = 0, offset = 0;
  try {
    for (let page = 0; page < 500; page++) {
      const list = await api('/product/get_item_list', { offset, page_size: 100, item_status: ['NORMAL', 'UNLIST'] });
      if (!Array.isArray(list.item)) fail(502, 'Daftar produk Shopee tidak lengkap.');
      const items = [];
      for (let i = 0; i < list.item.length; i += 50) {
        const ids = list.item.slice(i, i + 50).map(x => x.item_id);
        const base = await api('/product/get_item_base_info', { item_id_list: ids.join(',') });
        if (base.item_list?.length !== ids.length) fail(502, 'Detail produk belum lengkap; snapshot lama dipertahankan.');
        items.push(...base.item_list);
      }
      if (items.length) {
        const batch = db.batch();
        for (const item of items) batch.set(generation.collection('products').doc(String(item.item_id)), productRow(item));
        await batch.commit(); count += items.length;
      }
      if (!list.has_next_page) break;
      if (!(Number(list.next_offset) > offset) || page === 499) fail(502, 'Pagination produk Shopee tidak valid.');
      offset = Number(list.next_offset);
    }
    await db.runTransaction(async tx => {
      if ((await tx.get(shop)).data()?.syncOwner !== owner) fail(409, 'Sinkronisasi digantikan proses lain.');
      tx.set(shop, { activeSnapshot: owner, productCount: count, syncedAt: Date.now(), syncStatus: 'ok', syncLeaseUntil: 0 }, { merge: true });
    });
    // Only server-owned old snapshots are removed; a failed sync never changes the active snapshot.
    const old = await shop.collection('snapshots').listDocuments();
    for (const doc of old) if (doc.id !== owner) await db.recursiveDelete(doc);
    return { count, syncedAt: Date.now() };
  } catch (error) {
    await db.runTransaction(async tx => { if ((await tx.get(shop)).data()?.syncOwner === owner) tx.set(shop, { syncStatus: 'failed', syncLeaseUntil: 0 }, { merge: true }); });
    throw error;
  }
}
async function readProducts() {
  const { shop } = storeContext(); const meta = (await shop.get()).data() || {};
  const products = meta.activeSnapshot ? (await shop.collection('snapshots').doc(meta.activeSnapshot).collection('products').get()).docs.map(x => x.data()) : [];
  return { products, count: products.length, syncedAt: meta.syncedAt || null, syncStatus: meta.syncStatus || 'never', shopId: SHOP() };
}
async function cacheProduct(ctx, itemId) {
  const item = productRow(await productDetail(ctx, itemId));
  const meta = (await ctx.shop.get()).data();
  if (meta?.activeSnapshot) await ctx.shop.collection('snapshots').doc(meta.activeSnapshot).collection('products').doc(String(itemId)).set(item);
  return item;
}
function shipmentInput(body, parameters) {
  const mode = body.mode;
  if (!['pickup', 'dropoff'].includes(mode) || !Object.hasOwn(parameters.info_needed || {}, mode)) fail(400, 'Metode pengiriman tidak tersedia untuk paket ini.');
  const values = body[mode] || {}, selected = {};
  const fields = mode === 'pickup' ? ['address_id', 'pickup_time_id', 'tracking_number'] : ['branch_id', 'sender_real_name', 'tracking_number', 'slug'];
  for (const key of parameters.info_needed[mode] || []) if (!fields.includes(key)) fail(409, `Pengiriman memerlukan ${key}; gunakan Seller Centre.`);
  for (const key of fields) if (values[key] !== undefined && values[key] !== '') selected[key] = key.endsWith('_id') && key !== 'pickup_time_id' ? positive(Number(values[key]), key) : String(values[key]).slice(0, 150);
  for (const key of parameters.info_needed[mode] || []) if (selected[key] === undefined) fail(400, `${key} wajib diisi.`);
  if (mode === 'pickup') {
    const address = parameters.pickup?.address_list?.find(x => x.address_id === selected.address_id);
    if (!address) fail(400, 'Alamat pickup tidak tersedia.');
    if (selected.pickup_time_id && !address.time_slot_list?.some(x => String(x.pickup_time_id) === selected.pickup_time_id)) fail(400, 'Jadwal pickup tidak tersedia.');
  }
  if (selected.branch_id && !parameters.dropoff?.branch_list?.some(x => x.branch_id === selected.branch_id)) fail(400, 'Cabang drop-off tidak tersedia.');
  if (selected.slug && !parameters.dropoff?.slug_list?.some(x => x.slug === selected.slug)) fail(400, 'Mitra drop-off tidak tersedia.');
  return { [mode]: selected };
}
async function getOrder(ctx, orderSn, packageNumber) {
  if (typeof orderSn !== 'string' || !/^[A-Z0-9]{6,40}$/.test(orderSn)) fail(400, 'Nomor pesanan tidak valid.');
  const data = await ctx.api('/order/get_order_detail', { order_sn_list: orderSn, response_optional_fields: 'package_list,item_list,shipping_carrier' });
  const order = data.order_list?.find(x => x.order_sn === orderSn);
  if (!order) fail(404, 'Pesanan tidak ditemukan di toko ini.');
  const packages = order.package_list || [];
  if (packageNumber && !packages.some(x => x.package_number === packageNumber)) fail(400, 'Paket tidak cocok dengan pesanan.');
  if (packages.length > 1 && !packageNumber) fail(400, 'Pilih paket untuk pesanan dengan lebih dari satu paket.');
  return order;
}
async function listOrders(ctx, cursor = '') {
  const to = Math.floor(Date.now() / 1000);
  const list = await ctx.api('/order/get_order_list', { time_range_field: 'create_time', time_from: to - 14 * 86400, time_to: to, page_size: 50, cursor, response_optional_fields: 'order_status' });
  const sns = (list.order_list || []).map(x => x.order_sn);
  const result = sns.length ? await ctx.api('/order/get_order_detail', { order_sn_list: sns.join(','), response_optional_fields: 'package_list,item_list,shipping_carrier' }) : { order_list: [] };
  // Recipient addresses are deliberately not requested or stored in the product database.
  return { orders: (result.order_list || []).map(x => ({ orderSn: x.order_sn, status: x.order_status, createdAt: x.create_time, carrier: x.shipping_carrier || '', packages: x.package_list || [], items: (x.item_list || []).map(i => ({ name: i.item_name, quantity: i.model_quantity_purchased })) })), hasNextPage: Boolean(list.more), nextCursor: list.next_cursor || '' };
}
async function mutate(ctx, user, action, body, fn) {
  if (body.confirm !== true) fail(400, 'Konfirmasi perubahan diperlukan.');
  if (typeof body.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.operationId)) fail(400, 'ID operasi tidak valid.');
  const ref = ctx.shop.collection('operations').doc(body.operationId);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ action, body })).digest('hex');
  let previous;
  await ctx.db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data();
      if (data.fingerprint !== fingerprint) fail(409, 'ID operasi sudah digunakan untuk perubahan berbeda.');
      if (data.status === 'ok') { previous = data.result; return; }
      fail(409, 'Operasi sudah dikirim. Muat ulang data dan periksa hasil sebelum mencoba lagi.');
    }
    tx.create(ref, { action, fingerprint, uid: user.uid, status: 'pending', createdAt: Date.now() });
  });
  if (previous) return previous;
  try { const result = await fn(); await ref.update({ status: 'ok', result, finishedAt: Date.now() }); return result; }
  catch (error) { await ref.update({ status: 'review_required', finishedAt: Date.now() }); throw error; }
}
async function route(ctx, path, req, user) {
  const b = req.body || {}, q = req.query || {};
  if (req.method === 'GET' && path === '/orders') return listOrders(ctx, String(q.cursor || '').slice(0, 200));
  if (req.method === 'GET' && path === '/channels') return ctx.api('/logistics/get_channel_list');
  if (req.method === 'GET' && path === '/product') return { product: productRow(await productDetail(ctx, positive(Number(q.itemId), 'Produk'))) };
  if (req.method === 'GET' && path === '/shipping/parameters') {
    await getOrder(ctx, q.orderSn, q.packageNumber);
    return ctx.api('/logistics/get_shipping_parameter', { order_sn: q.orderSn, ...(q.packageNumber ? { package_number: q.packageNumber } : {}) });
  }
  if (req.method !== 'POST') fail(404, 'Endpoint tidak ditemukan.');
  if (path === '/channels/update') return mutate(ctx, user, path, b, async () => {
    positive(b.channelId, 'Kurir'); if (typeof b.enabled !== 'boolean') fail(400, 'Status kurir tidak valid.');
    const channels = await ctx.api('/logistics/get_channel_list');
    if (!channels.logistics_channel_list?.some(x => x.logistics_channel_id === b.channelId)) fail(400, 'Kurir tidak tersedia untuk toko.');
    await ctx.api('/logistics/update_channel', { logistics_channel_id: b.channelId, enabled: b.enabled }, 'POST');
    return { ok: true };
  });
  if (path === '/product/update') return mutate(ctx, user, path, b, async () => {
    const id = positive(b.itemId, 'Produk'); const item = await productDetail(ctx, id);
    if (item.has_model) fail(409, 'Harga dan stok produk bervariasi harus diubah per variasi di Seller Centre.');
    if (!Number.isFinite(b.price) || b.price <= 0 || !Number.isSafeInteger(b.stock) || b.stock < 0) fail(400, 'Harga atau stok tidak valid.');
    const stocks = item.stock_info_v2?.seller_stock || [];
    if (stocks.length > 1) fail(409, 'Produk memiliki beberapa gudang. Ubah stok melalui Seller Centre.');
    const stock = { stock: b.stock, ...(stocks[0]?.location_id ? { location_id: stocks[0].location_id } : {}) };
    const priceResult = await ctx.api('/product/update_price', { item_id: id, price_list: [{ model_id: 0, original_price: b.price }] }, 'POST');
    if (!priceResult.success_list?.some(x => x.model_id === 0)) fail(502, 'Shopee belum mengonfirmasi perubahan harga.');
    try {
      const stockResult = await ctx.api('/product/update_stock', { item_id: id, stock_list: [{ model_id: 0, seller_stock: [stock] }] }, 'POST');
      if (!stockResult.success_list?.some(x => x.model_id === 0)) fail(502, 'Shopee belum mengonfirmasi perubahan stok.');
    } catch (e) { await cacheProduct(ctx, id); fail(502, 'Harga sudah dikirim, tetapi perubahan stok gagal. Muat ulang dan periksa produk.', { partial: true }); }
    return { ok: true, product: await cacheProduct(ctx, id) };
  });
  if (path === '/product/shipping') return mutate(ctx, user, path, b, async () => {
    const id = positive(b.itemId, 'Produk'); await productDetail(ctx, id);
    if (!Number.isFinite(b.weight) || b.weight <= 0 || b.weight > 100000) fail(400, 'Berat paket dalam kg tidak valid.');
    const dimension = {};
    for (const key of ['package_length', 'package_width', 'package_height']) { const n = b.dimension?.[key]; if (!Number.isSafeInteger(n) || n < 1 || n > 100000) fail(400, 'Ukuran paket harus bilangan bulat positif dalam cm.'); dimension[key] = n; }
    const channels = (await ctx.api('/logistics/get_channel_list')).logistics_channel_list || [];
    if (!Array.isArray(b.logisticInfo) || !b.logisticInfo.length || b.logisticInfo.length > 100) fail(400, 'Pilih pengaturan kurir produk.');
    const logistic_info = b.logisticInfo.map(x => { if (typeof x.enabled !== 'boolean' || !channels.some(c => c.logistics_channel_id === x.logistic_id)) fail(400, 'Kurir produk tidak valid.'); return { logistic_id: positive(x.logistic_id, 'Kurir'), enabled: x.enabled }; });
    await ctx.api('/product/update_item', { item_id: id, weight: b.weight, dimension, logistic_info }, 'POST');
    return { ok: true, product: await cacheProduct(ctx, id) };
  });
  const orderParams = { order_sn: b.orderSn, ...(b.packageNumber ? { package_number: b.packageNumber } : {}) };
  if (path === '/shipping/ship') return mutate(ctx, user, path, b, async () => {
    const order = await getOrder(ctx, b.orderSn, b.packageNumber);
    if (order.order_status !== 'READY_TO_SHIP') fail(409, 'Pesanan sudah berubah atau tidak siap dikirim. Muat ulang daftar.');
    const parameters = await ctx.api('/logistics/get_shipping_parameter', orderParams);
    const mode = shipmentInput(b, parameters);
    // A per-package lock also prevents double submission from different browser tabs.
    const lock = ctx.shop.collection('shipments').doc(crypto.createHash('sha256').update(JSON.stringify(orderParams)).digest('hex'));
    try { await lock.create({ operationId: b.operationId, status: 'submitted', createdAt: Date.now() }); }
    catch (e) { if (e.code === 6) fail(409, 'Paket ini sudah pernah diproses dashboard. Periksa status di Shopee.'); throw e; }
    await ctx.api('/logistics/ship_order', { ...orderParams, ...mode }, 'POST');
    await lock.update({ status: 'accepted' });
    return { ok: true, orderSn: b.orderSn };
  });
  if (path === '/shipping/document/create') return mutate(ctx, user, path, b, async () => {
    await getOrder(ctx, b.orderSn, b.packageNumber);
    const p = await ctx.api('/logistics/get_shipping_document_parameter', { order_list: [orderParams] }, 'POST');
    const result = p.result_list?.[0];
    const type = result?.suggest_shipping_document_type || result?.selectable_shipping_document_type?.[0];
    if (!type || !['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL'].includes(type)) fail(409, 'Format resi ini belum didukung. Gunakan Seller Centre.');
    const tracking = await ctx.api('/logistics/get_tracking_number', orderParams);
    if (!tracking.tracking_number) fail(409, 'Nomor resi belum tersedia. Tunggu setelah pengiriman diproses.');
    await ctx.api('/logistics/create_shipping_document', { order_list: [{ ...orderParams, tracking_number: tracking.tracking_number, shipping_document_type: type }] }, 'POST');
    return { ok: true, type };
  });
  if (path === '/shipping/document/download') {
    await getOrder(ctx, b.orderSn, b.packageNumber);
    if (!['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL'].includes(b.type)) fail(400, 'Format resi tidak valid.');
    const result = await ctx.api('/logistics/get_shipping_document_result', { order_list: [orderParams] }, 'POST');
    if (result.result_list?.[0]?.status !== 'READY') fail(409, 'Resi sedang disiapkan Shopee. Coba unduh lagi beberapa saat.');
    return ctx.api('/logistics/download_shipping_document', { shipping_document_type: b.type, order_list: [orderParams] }, 'POST', true);
  }
  fail(404, 'Endpoint tidak ditemukan.');
}
async function handleDashboard(req, res, path) {
  res.set('Cache-Control', 'private, no-store');
  const origin = req.headers.origin;
  const allowed = (process.env.SHOPEE_PANEL_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
  if (origin && !allowed.includes(origin)) return res.status(403).json({ error: 'Origin dashboard tidak diizinkan.' });
  if (origin) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); }
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (!bearer) fail(401, 'Silakan login Google terlebih dahulu.');
    storeContext();
    const user = await verifyDashboardUser(bearer);
    if (path === '/master' || path.startsWith('/master/')) return res.json(await require('./master-stock.cjs').route(storeContext(), req, path, user, shopContext));
    if (req.method === 'GET' && path === '/me') return res.json({ email: user.email, shopId: SHOP() });
    if (req.method === 'GET' && path === '/products') return res.json(await readProducts());
    if (req.method === 'POST' && path === '/products/sync') return res.json(await syncProducts());
    const result = await route(await shopContext(), path, req, user);
    if (Buffer.isBuffer(result)) return res.type('application/pdf').set('Content-Disposition', 'attachment; filename="resi.pdf"').send(result);
    return res.json(result);
  } catch (e) {
    if (e instanceof require('./master-stock.cjs').MasterError) return res.status(e.status).json({ error: e.message });
    if (e.shopeeRefreshError) {
      console.error('dashboard_connection_error', JSON.stringify({ code: e.code, sourceIp: e.sourceIp || null, path }));
      return res.status(e.code === 'source_ip_undeclared' ? 503 : 409).json({ error: e.message, code: e.code });
    }
    console.error('dashboard_operation_error', JSON.stringify({ code: typeof e.code === 'number' ? e.code : null, status: e.status || 500, path }));
    return res.status(e.status || 500).json({ error: e instanceof ApiError ? e.message : 'Operasi gagal. Muat ulang dan periksa hasil; hubungkan ulang Shopee jika sesi tidak valid.', ...(e.details ? { details: e.details } : {}) });
  }
}
function startDashboardSync() {
  if (process.env.SHOPEE_DASHBOARD_SYNC !== 'true') return;
  const run = async () => { try { const r = await syncProducts(); console.log('Dashboard product sync', r.count); } catch (e) {
    const code = e.shopeeRefreshError ? e.code : e.details?.code;
    console.log('Dashboard product sync failed', JSON.stringify({ status: e.status || 500, code: typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : null }));
  } };
  setTimeout(run, 15000).unref(); setInterval(run, 5 * 60000).unref();
}
async function checkDashboardConnection() {
  if (!OWNER() || !SHOP()) return;
  try {
    const ctx = await shopContext();
    await ctx.api('/shop/get_shop_info');
    console.log('dashboard_connection_check', JSON.stringify({ ok: true, shopId: SHOP() }));
  } catch (e) {
    const code = e.shopeeRefreshError ? e.code : e.details?.code;
    console.error('dashboard_connection_check', JSON.stringify({ ok: false, shopId: SHOP(), partnerId: Number(process.env.SHOPEE_PARTNER_ID), sourceIp: e.sourceIp || null, reason: e.shopeeRefreshError ? e.upstreamReason : null, code: typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : 'connection_failed', status: e.status || 500 }));
  }
}
module.exports = { storeContext, checkDashboardConnection, handleDashboard, startDashboardSync, syncProducts, readProducts, shopContext, assertOwner, verifyDashboardUser, checkResult, shipmentInput, productRow, route, ApiError };
