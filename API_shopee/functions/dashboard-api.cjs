const crypto = require('node:crypto');
const { createCloudTokenStore } = require('./cloud-token-store.cjs');
const { refreshShopeeToken } = require('./token-refresh.cjs');
const { AuthError, assertOwner, verifyDashboardUser, authenticateDashboardRequest } = require('./services/auth.service.cjs');
const { queryProductResearch, generateListingDraft, productAgentsStatus } = require('./product-agents.cjs');
const DEFAULT_SHOPEE_REGION = 'GLOBAL';
const SHOPEE_BASE_URLS = {
  GLOBAL: 'https://partner.shopeemobile.com/api/v2',
  CHINA: 'https://openplatform.shopee.cn/api/v2',
  BRAZIL: 'https://openplatform.shopee.com.br/api/v2',
  TEST_GLOBAL: 'https://openplatform.sandbox.test-stable.shopee.sg/api/v2',
  TEST_CHINA: 'https://openplatform.test-stable.shopee.cn/api/v2',
};
const SHOP = () => Number(process.env.SHOPEE_DASHBOARD_SHOP_ID);
const OWNER = () => (process.env.SHOPEE_DASHBOARD_OWNER_EMAIL || '').trim().toLowerCase();
class ApiError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }
const fail = (status, message, details) => { throw new ApiError(status, message, details); };
function dashboardBaseUrl() {
  const region = (process.env.SHOPEE_REGION || DEFAULT_SHOPEE_REGION).trim().toUpperCase();
  return SHOPEE_BASE_URLS[region] || SHOPEE_BASE_URLS[DEFAULT_SHOPEE_REGION];
}
function positive(value, label) { if (!Number.isSafeInteger(value) || value <= 0) fail(400, `${label} tidak valid.`); return value; }
function shopeeErrorCode(data) {
  const raw = typeof data?.error === 'string' && data.error ? data.error : typeof data?.code === 'string' && data.code ? data.code : 'upstream_rejected';
  return /^[a-zA-Z0-9_.-]{1,100}$/.test(raw) ? raw : 'upstream_rejected';
}
function redact(value, secrets) {
  let text = String(value || '');
  for (const secret of secrets) if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  return text.slice(0, 400);
}
function sourceIpFrom(message) {
  const ip = String(message || '').match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
  return ip && ip.split('.').every(part => Number(part) <= 255) ? ip : undefined;
}
function shopeeRejectError(response, data, secrets = []) {
  const code = shopeeErrorCode(data);
  const reason = redact(typeof data?.message === 'string' ? data.message : typeof data?.error_description === 'string' ? data.error_description : '', secrets);
  const isIp = code === 'source_ip_undeclared' || response.status === 403;
  const message = isIp
    ? 'Shopee menolak IP server konektor. Daftarkan IP keluar server di whitelist aplikasi Shopee Open Platform, lalu ulangi sinkronisasi. Login Google tidak perlu diulang.'
    : `Shopee menolak permintaan (HTTP ${response.status}).${reason ? ` ${reason}` : ''}`;
  const error = new Error(message);
  error.code = code;
  error.status = response.status;
  error.details = { code, requestId: data?.request_id || null };
  error.upstreamReason = reason;
  error.sourceIp = sourceIpFrom(reason);
  if (isIp) error.shopeeRefreshError = true;
  return error;
}
function checkResult(data) {
  if (!data || typeof data !== 'object' || data.error) fail(502, `Shopee: ${data?.message || data?.error || 'Respons tidak valid'}`, { code: data?.error, requestId: data?.request_id });
  const r = data.response;
  const failures = [...(r?.failure_list || []), ...(r?.result_list || []).filter(x => x.fail_error || x.error)];
  if (failures.length) fail(502, 'Sebagian operasi ditolak Shopee.', { failures });
  return r || {};
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
  const baseUrl = dashboardBaseUrl();
  const config = { partnerId: Number(process.env.SHOPEE_PARTNER_ID), partnerKey: process.env.SHOPEE_PARTNER_KEY };
  const token = await store.refreshDocument(ref, old => refreshShopeeToken(config, baseUrl, old));
  if (!token?.access_token) fail(409, 'Sesi Shopee tidak tersedia. Hubungkan ulang akun.');
  async function api(path, params = {}, method = 'GET', binary = false) {
    const url = new URL(baseUrl + path);
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = crypto.createHmac('sha256', config.partnerKey).update(`${config.partnerId}${url.pathname}${timestamp}${token.access_token}${SHOP()}`).digest('hex');
    url.search = new URLSearchParams({ partner_id: String(config.partnerId), timestamp: String(timestamp), sign, access_token: token.access_token, shop_id: String(SHOP()) }).toString();
    if (method === 'GET') for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      // Match Produk Shopee query format: list values use one comma-separated parameter.
      url.searchParams.set(key, Array.isArray(value) ? value.map(entry => String(entry)).join(',') : String(value));
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
    const rawText = await response.text();
    if (rawText) {
      try { data = JSON.parse(rawText); } catch { data = null; }
    }
    if (!response.ok) throw shopeeRejectError(response, data, [config.partnerKey, token.access_token, token.refresh_token]);
    return checkResult(data || {});
  }
  return { ...context, api };
}
function productRow(item) {
  const stock = item.stock_info_v2?.summary_info?.total_available_stock;
  return { itemId: item.item_id, name: item.item_name, sku: item.item_sku || '', shopSku: item.item_sku || '', status: item.item_status, hasModel: Boolean(item.has_model),
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
  const [catalog, mappings] = await Promise.all([
    meta.activeSnapshot ? shop.collection('snapshots').doc(meta.activeSnapshot).collection('products').get() : Promise.resolve({ docs: [] }),
    shop.collection('masterOnlineMappings').get(),
  ]);
  const byItem = new Map(mappings.docs.map(doc => [Number(doc.id), doc.data()]));
  const products = catalog.docs.map(doc => {
    const product = doc.data(), mapping = byItem.get(Number(product.itemId || doc.id));
    return mapping ? { ...product, shopSku: product.shopSku || product.sku || '', sku: mapping.masterSku, masterSku: mapping.masterSku, skuSource: 'master' } : product;
  });
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
function orderApiParams(order, orderSn, packageNumber) {
  // Shopee rejects package_number for an unsplit order, even when the detail
  // response exposes a single package entry.
  return order.package_list?.length > 1 && packageNumber ? { order_sn: orderSn, package_number: packageNumber } : { order_sn: orderSn };
}
async function listOrders(ctx, cursor = '', shippingOnly = false) {
  const to = Math.floor(Date.now() / 1000);
  let list;
  let packageFilter;
  if (shippingOnly) {
    // The shipping queue must be package based: get_order_list can include an
    // already shipped package when an order has been split.
    list = await ctx.api('/order/search_package_list', { filter: { package_status: 2, fulfillment_type: 2 }, pagination: { page_size: 50, ...(cursor ? { cursor } : {}) }, sort: { sort_field: 'ship_by_date', sort_direction: 'ASC' } }, 'POST');
    packageFilter = new Map((list.package_list || []).map(x => [x.order_sn, x.package_number]));
  } else {
    list = await ctx.api('/order/get_order_list', { time_range_field: 'create_time', time_from: to - 14 * 86400, time_to: to, page_size: 50, cursor, response_optional_fields: 'order_status' });
  }
  const sns = shippingOnly ? [...packageFilter.keys()] : (list.order_list || []).map(x => x.order_sn);
  const result = sns.length ? await ctx.api('/order/get_order_detail', { order_sn_list: sns.join(','), response_optional_fields: 'package_list,item_list,shipping_carrier' }) : { order_list: [] };
  // Reuse the product snapshot so the shipping queue can identify each item visually
  // without requesting recipient data or exposing additional order details.
  const meta = (await ctx.shop.get()).data() || {};
  const imageByItemId = new Map();
  if (meta.activeSnapshot) {
    const products = await ctx.shop.collection('snapshots').doc(meta.activeSnapshot).collection('products').get();
    for (const doc of products.docs) {
      const product = doc.data();
      if (product.image) imageByItemId.set(String(product.itemId || doc.id), product.image);
    }
  }
  // Recipient addresses are deliberately not requested or stored in the product database.
  return { orders: (result.order_list || []).map(x => ({ orderSn: x.order_sn, status: x.order_status, createdAt: x.create_time, carrier: x.shipping_carrier || '', packages: (x.package_list || []).filter(p => !shippingOnly || packageFilter.get(x.order_sn) === p.package_number), items: (x.item_list || []).map(i => ({ itemId: i.item_id, name: i.item_name, quantity: i.model_quantity_purchased, image: imageByItemId.get(String(i.item_id)) || i.item_image?.image_url || i.image_url || null })) })).filter(x => !shippingOnly || x.packages.length), hasNextPage: Boolean(list.more), nextCursor: list.next_cursor || '' };
}
function profitPeriod(q) {
  const from = Number(q.from), to = Number(q.to), now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to <= from || to > now + 60 || to - from > 31 * 86400) fail(400, 'Periode laporan harus 1 sampai 31 hari.');
  return { from, to };
}
function profitOrderDeductions(income, items) {
  const itemSales = items.map(item => Math.max(0, Number(item.discounted_price) || 0) * Math.max(0, Number(item.quantity_purchased) || 0));
  const orderSales = itemSales.reduce((sum, value) => sum + value, 0);
  const share = itemSales.map(value => orderSales ? value / orderSales : 0);
  const amount = (primary, fallback) => {
    const primaryValue = income[primary];
    const value = fallback && (primaryValue === undefined || primaryValue === null || primaryValue === '')
      ? income[fallback]
      : primaryValue;
    if (value === undefined || value === null || value === '') return 0;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) fail(502, `Potongan escrow ${primary} tidak valid.`);
    return parsed;
  };
  const allocated = (value, index) => value * share[index];
  const commission = amount('net_commission_fee', 'commission_fee');
  const service = amount('net_service_fee', 'service_fee');
  const transaction = amount('seller_transaction_fee');
  const itemAms = items.map(item => {
    if (item.ams_commission_fee === undefined || item.ams_commission_fee === null || item.ams_commission_fee === '') return 0;
    const value = Number(item.ams_commission_fee);
    if (!Number.isFinite(value)) fail(502, 'Potongan escrow ams_commission_fee tidak valid.');
    return value;
  });
  const hasOrderAms = income.order_ams_commission_fee !== undefined && income.order_ams_commission_fee !== null && income.order_ams_commission_fee !== '';
  const ams = !hasOrderAms
    ? itemAms
    : share.map((_, index) => allocated(amount('order_ams_commission_fee'), index));
  const otherFeeFields = [
    'seller_order_processing_fee', 'campaign_fee', 'seller_return_refund',
    'seller_coin_cash_back', 'drc_adjustable_refund', 'reverse_shipping_fee',
    'reverse_shipping_fee_sst', 'final_return_to_seller_shipping_fee',
    'withholding_tax', 'withholding_vat_tax', 'withholding_pit_tax', 'escrow_tax',
    'final_product_vat_tax', 'final_shipping_vat_tax', 'shipping_fee_sst',
    'overseas_return_service_fee', 'fbs_fee',
    'ads_escrow_top_up_fee_or_technical_support_fee', 'th_import_duty',
    'vat_on_imported_goods', 'final_escrow_product_gst',
    'final_escrow_shipping_gst', 'delivery_seller_protection_fee_premium_amount',
  ];
  const otherFees = otherFeeFields.reduce((sum, field) => sum + amount(field), 0);
  if (!orderSales && commission + service + transaction + (hasOrderAms ? amount('order_ams_commission_fee') : 0) + otherFees !== 0) {
    fail(502, 'Potongan escrow tidak dapat dialokasikan karena nilai penjualan item kosong.');
  }
  return items.map((_, index) => {
    const commissionFee = allocated(commission, index);
    const serviceFee = allocated(service, index);
    const transactionFee = allocated(transaction, index);
    const amsFee = ams === itemAms ? itemAms[index] : ams[index];
    const otherShopeeFees = allocated(otherFees, index);
    return {
      commissionFee, serviceFee, transactionFee, amsFee, otherShopeeFees,
      deductions: commissionFee + serviceFee + transactionFee + amsFee + otherShopeeFees,
    };
  });
}
async function profitEscrowDetails(ctx, orderSns) {
  const details = [];
  let fallbackCount = 0;
  for (let offset = 0; offset < orderSns.length; offset += 20) {
    const requested = orderSns.slice(offset, offset + 20);
    const batch = await ctx.api('/payment/get_escrow_detail_batch', { order_sn_list: requested }, 'POST');
    const byOrderSn = new Map((Array.isArray(batch?.order_income_list) ? batch.order_income_list : [])
      .filter(detail => typeof detail?.order_sn === 'string' && detail.order_sn)
      .map(detail => [detail.order_sn, detail]));
    const missing = requested.filter(orderSn => !byOrderSn.has(orderSn));
    if (fallbackCount + missing.length > 100) fail(502, 'Rincian escrow batch tidak tersedia untuk periode ini; pilih rentang tanggal yang lebih pendek.');
    for (let index = 0; index < missing.length; index += 5) {
      const recovered = await Promise.all(missing.slice(index, index + 5).map(async orderSn => {
        const detail = await ctx.api('/payment/get_escrow_detail', { order_sn: orderSn });
        if (detail?.order_sn && detail.order_sn !== orderSn) fail(502, 'Rincian escrow Shopee tidak cocok dengan pesanan yang diminta.');
        if (!detail?.order_income || !Array.isArray(detail.order_income.items)) fail(502, 'Rincian escrow pesanan tidak lengkap.');
        return [orderSn, { ...detail, order_sn: orderSn }];
      }));
      for (const [orderSn, detail] of recovered) byOrderSn.set(orderSn, detail);
    }
    fallbackCount += missing.length;
    for (const orderSn of requested) {
      const detail = byOrderSn.get(orderSn);
      if (!detail) fail(502, 'Sebagian rincian escrow belum tersedia; laporan laba belum bisa dihitung lengkap.');
      details.push(detail);
    }
  }
  return { details, fallbackCount };
}
async function profitReport(ctx, q) {
  const { from, to } = profitPeriod(q);
  const escrowOrders = [];
  for (let page = 1; page <= 100; page++) {
    const data = await ctx.api('/payment/get_escrow_list', { release_time_from: from, release_time_to: to, page_size: 100, page_no: page });
    if (!Array.isArray(data.escrow_list)) fail(502, 'Daftar pencairan Shopee tidak lengkap.');
    escrowOrders.push(...data.escrow_list);
    if (!data.more) break;
    if (page === 100) fail(502, 'Periode laporan terlalu besar; pilih rentang tanggal yang lebih pendek.');
  }
  const orderSns = [...new Set(escrowOrders.map(x => x.order_sn).filter(x => typeof x === 'string' && x))];
  const { details: detailLists, fallbackCount } = await profitEscrowDetails(ctx, orderSns);
  if (detailLists.length !== orderSns.length) fail(502, 'Sebagian rincian escrow belum tersedia; laporan laba belum bisa dihitung lengkap.');
  const bySku = new Map();
  let ordersWithDetails = 0;
  for (const detail of detailLists) {
    const income = detail.order_income;
    if (!income || !Array.isArray(income.items)) continue;
    ordersWithDetails++;
    const items = income.items;
    const allocatedDeductions = profitOrderDeductions(income, items);
    for (const [index, item] of items.entries()) {
      const itemId = Number(item.item_id) || 0, modelId = Number(item.model_id) || 0;
      const sku = String(item.model_sku || item.item_sku || '').trim();
      const key = `${itemId}_${modelId}`;
      const quantity = Math.max(0, Number(item.quantity_purchased) || 0);
      const gross = Math.max(0, Number(item.discounted_price) || 0) * quantity;
      const fees = allocatedDeductions[index];
      const row = bySku.get(key) || { key, itemId, modelId, sku, name: item.model_name && item.model_name !== 'No Variation' ? `${item.item_name} · ${item.model_name}` : item.item_name, quantity: 0, gross: 0, commissionFee: 0, serviceFee: 0, transactionFee: 0, amsFee: 0, otherShopeeFees: 0, deductions: 0, orders: new Set() };
      row.quantity += quantity; row.gross += gross;
      row.commissionFee += fees.commissionFee;
      row.serviceFee += fees.serviceFee;
      row.transactionFee += fees.transactionFee;
      row.amsFee += fees.amsFee;
      row.otherShopeeFees += fees.otherShopeeFees;
      row.deductions += fees.deductions;
      row.orders.add(detail.order_sn);
      bySku.set(key, row);
    }
  }
  if (ordersWithDetails !== orderSns.length) fail(502, 'Sebagian pesanan tidak memiliki rincian item escrow; laporan laba belum bisa dihitung lengkap.');
  const [costs, masterLinks, masterMeta] = await Promise.all([
    ctx.shop.collection('profitCosts').get(),
    ctx.shop.collection('masterOnlineMappings').get(),
    require('./master-mysql-snapshot.cjs').metadata(ctx),
  ]);
  const costByKey = new Map(costs.docs.map(doc => [doc.id, doc.data()]));
  const masterByItem = new Map(masterLinks.docs.map(doc => [Number(doc.id), doc.data()]));
  const mysqlBySku = new Map();
  if (masterMeta) {
    const mysqlRows = await require('./master-mysql.cjs').allSnapshotRows(ctx);
    for (const row of mysqlRows) mysqlBySku.set(String(row.sku).toLowerCase(), row);
  }
  const rows = [...bySku.values()].map(row => {
    const manualCost = costByKey.get(row.key);
    const masterLink = row.modelId === 0 ? masterByItem.get(row.itemId) : null;
    const masterRow = masterLink ? mysqlBySku.get(String(masterLink.masterSku || '').toLowerCase()) : null;
    const sourceCost = masterRow && Number.isFinite(Number(masterRow.price)) && Number(masterRow.price) > 0 ? Number(masterRow.price) : null;
    const unitCost = Math.max(0, Number(manualCost?.unitCost ?? sourceCost) || 0);
    const costOfGoods = unitCost * row.quantity;
    const profit = row.gross - row.deductions - costOfGoods;
    const costSource = manualCost ? 'manual' : sourceCost !== null ? 'master_mysql' : null;
    const costConfigured = costSource !== null;
    return { ...row, shopSku: row.sku, sku: masterLink?.masterSku || row.sku, masterSku: masterLink?.masterSku || null, masterPrice: sourceCost, masterName: masterRow?.name || null, costSource, orders: row.orders.size, unitCost, costOfGoods, profit: costConfigured ? profit : null, margin: costConfigured && row.gross ? profit / row.gross * 100 : null, costConfigured };
  }).sort((a, b) => b.profit - a.profit);
  return { rows, from, to, orderCount: orderSns.length, ordersWithDetails, detailLookupFallbacks: fallbackCount, syncedAt: Date.now(), currency: 'IDR', source: 'Shopee escrow' };
}
function scraperConfig() {
  const base = String(process.env.SHOPEE_SCRAPER_URL || '').trim();
  const apiKey = String(process.env.SHOPEE_SCRAPER_API_KEY || '').trim();
  if (!base || !apiKey) fail(503, 'Scraper belum dikonfigurasi pada server dashboard.');
  let url;
  try { url = new URL(base); } catch { fail(503, 'Alamat layanan scraper pada server tidak valid.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail(503, 'Alamat layanan scraper pada server tidak valid.');
  return { base: url.origin, apiKey };
}
function scraperProductUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) fail(400, 'Tautan produk Shopee tidak valid.');
  let url;
  try { url = new URL(value); } catch { fail(400, 'Masukkan tautan produk Shopee yang valid.'); }
  const supportedHost = ['shopee.co.id', 'www.shopee.co.id'].includes(url.hostname.toLowerCase());
  const supportedPath = /^\/product\/\d+\/\d+\/?$/.test(url.pathname) || /-i\.\d+\.\d+$/.test(url.pathname);
  if (url.protocol !== 'https:' || !supportedHost || !supportedPath || url.username || url.password || url.port) fail(400, 'Gunakan tautan produk publik dari shopee.co.id.');
  return url.toString();
}
async function scrapePublicProduct(ctx, body) {
  const url = scraperProductUrl(body.url);
  const { base, apiKey } = scraperConfig();
  let response;
  try {
    response = await fetch(`${base}/api/shopee/id/product`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(60000) });
  } catch { fail(502, 'Layanan scraper tidak merespons. Periksa koneksi layanan lalu coba lagi.'); }
  let payload;
  try { payload = await response.json(); } catch { fail(502, 'Respons layanan scraper tidak dapat dibaca.'); }
  if (!response.ok || payload?.success !== true || !payload.data || typeof payload.data !== 'object') fail(502, 'Scraper gagal mengambil data produk dari Shopee.');
  const data = payload.data;
  const images = Array.isArray(data.images) ? data.images.filter(x => typeof x === 'string' && /^https:\/\//i.test(x)).slice(0, 12) : [];
  const result = { name: String(data.name || '').slice(0, 300), price: String(data.price || '').slice(0, 80), priceBeforeDiscount: String(data.priceBeforeDiscount || '').slice(0, 80), discount: String(data.discount || '').slice(0, 40), rating: String(data.rating || '').slice(0, 30), ratingCount: String(data.ratingCount || '').slice(0, 40), soldCount: String(data.soldCount || '').slice(0, 40), shopName: String(data.shopName || '').slice(0, 200), images, url, scrapedAt: Date.now() };
  if (!result.name) fail(502, 'Data scraper tidak menyertakan nama produk.');
  const ref = ctx.shop.collection('scrapeResults').doc();
  await ref.set({ ...result, createdAt: Date.now() });
  return { result: { id: ref.id, ...result } };
}
function parsePublicShopUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) fail(400, 'Tautan toko Shopee tidak valid.');
  let url;
  try { url = new URL(value); } catch { fail(400, 'Masukkan tautan toko Shopee yang valid.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !['shopee.co.id', 'www.shopee.co.id'].includes(host) || url.username || url.password || url.port) fail(400, 'Gunakan tautan toko publik dari shopee.co.id.');
  const parts = url.pathname.split('/').filter(Boolean);
  let shopId = url.searchParams.get('shopid') || url.searchParams.get('shop_id') || url.searchParams.get('shopId') || '';
  if (!shopId && parts.length >= 2 && parts.at(-2)?.toLowerCase() === 'shop' && /^\d+$/.test(parts.at(-1))) shopId = parts.at(-1);
  else if (!shopId && parts.length && /\.\d+$/.test(parts.at(-1))) shopId = parts.at(-1).match(/\.(\d+)$/)?.[1] || '';
  else if (!shopId && parts.length >= 2 && /^\d+$/.test(parts.at(-1))) shopId = parts.at(-1);
  if (!shopId || !Number.isSafeInteger(Number(shopId)) || Number(shopId) <= 0) fail(400, 'Tautan toko harus memuat ID toko, misalnya shopee.co.id/nama-toko/123456.');
  return { shopId: Number(shopId), shopUrl: `https://shopee.co.id/${parts.join('/')}` };
}
function flattenShopItem(card, shopId) {
  // Lumintu returns Shopee cards wrapped as item_card_data.item; the direct
  // public endpoint returns the card fields at the top level.
  const product = card?.item_card_data?.item || card?.item || card || {};
  const asset = card.item_card_displayed_asset || {};
  const rawPrice = Number(asset.display_price?.price ?? card.item_card_display_price?.price ?? product.price ?? product.price_min ?? 0);
  const image = asset.image || product.image || card.image || '';
  const imageUrl = typeof image === 'string' && image ? (image.startsWith('http') ? image : `https://down-id.img.susercontent.com/file/${encodeURIComponent(image)}`) : '';
  const ratingCounts = product.item_rating?.rating_count;
  const itemId = Number(product.itemid ?? product.item_id ?? 0);
  return {
    itemId, shopId,
    name: String(asset.name || product.name || card.name || `Produk ${itemId}`).slice(0, 300),
    price: Number.isFinite(rawPrice) ? rawPrice / 100000 : null,
    currency: String(product.currency || 'IDR').slice(0, 5),
    rating: Number(product.item_rating?.rating_star ?? product.rating ?? 0) || 0,
    ratingCount: Array.isArray(ratingCounts) ? ratingCounts.reduce((sum, n) => sum + (Number(n) || 0), 0) : Number(product.item_rating?.rating_count || 0),
    soldText: String(product.item_card_display_sold_count?.display_sold_count_text ?? product.item_card_display_sold_count?.text ?? asset.sold_count?.text ?? product.sold ?? '').slice(0, 80),
    image: imageUrl, soldOut: product.is_sold_out === true || Number(product.stock) === 0,
    url: `https://shopee.co.id/product/${shopId}/${itemId}`,
  };
}
async function fetchLumintuCatalogPage(shop, offset) {
  const apiKey = process.env.LUMINTU_SHOPEE_API_KEY;
  if (!apiKey) fail(503, 'API katalog alternatif belum dikonfigurasi.');
  const endpoint = 'https://lumintuscraper.com/api/shopee/scrape/shop_product';
  const headers = { 'Api-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' };
  const payload = { shop_id: shop.shopId, country: 'ID', offset, limit: 20, order: 'desc', by: 'popular' };
  async function request(url, init) {
    let response;
    try { response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(25000) }); }
    catch { fail(502, 'Koneksi ke layanan katalog alternatif terputus.'); }
    let data;
    try { data = await response.json(); } catch { fail(502, 'Layanan katalog alternatif mengirim respons yang tidak dapat dibaca.'); }
    if (!response.ok) fail(502, `Layanan katalog alternatif menolak permintaan (HTTP ${response.status}).`);
    return data;
  }
  let data = await request(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
  // Lumintu can return a completed result directly or an async task ID.
  if (data?.status === 'pending' || data?.status_code === 202) {
    const requestId = data.request_id;
    if (typeof requestId !== 'string' || !requestId) fail(502, 'Layanan katalog mengembalikan tugas tanpa ID.');
    const deadline = Date.now() + 55000;
    do {
      await new Promise(resolve => setTimeout(resolve, 1200));
      data = await request(`https://lumintuscraper.com/scrape/result/${encodeURIComponent(requestId)}`, { method: 'GET', headers });
      if (data?.status === 'completed' || data?.status_code === 200) break;
      if (data?.status === 'failed' || data?.error) fail(502, 'Tugas pengambilan katalog ditolak layanan scraper.');
    } while (Date.now() < deadline);
  }
  if (data?.status !== 'completed' || Number(data.status_code) !== 200 || !data.result || typeof data.result !== 'object') {
    fail(502, 'Layanan scraper belum menyelesaikan pengambilan katalog dengan respons valid.');
  }
  const rows = data.result.items;
  if (!Array.isArray(rows)) fail(502, 'Respons katalog Lumintu tidak berisi daftar produk.');
  const cards = rows.map(row => row?.item_card_data?.item ? row : row?.item ? row : null).filter(Boolean);
  if (rows.length && !cards.length) fail(502, 'Format produk katalog Lumintu tidak didukung.');
  const items = cards.map(card => flattenShopItem(card, shop.shopId)).filter(item => item.itemId > 0 && item.name);
  if (items.length !== cards.length) fail(502, 'Sebagian produk katalog Lumintu tidak memiliki ID atau nama valid.');
  if (rows.length === 0 && offset === 0) fail(502, 'Lumintu mengembalikan katalog kosong; proses tidak ditandai berhasil.');
  const nextOffset = Number(data.result.next_offset);
  const hasMore = rows.length > 0 && Number.isSafeInteger(nextOffset) && nextOffset > offset;
  return { items, rawCount: rows.length, total: 0, noMore: !hasMore };
}
async function fetchShopCatalogPage(shop, offset) {
  if (shop.catalogSource === 'lumintu') return fetchLumintuCatalogPage(shop, offset);
  const url = new URL('https://shopee.co.id/api/v4/shop/search_items');
  url.search = new URLSearchParams({ filter_sold_out: '1', item_card_use_scene: 'search_items_popular', limit: '30', offset: String(offset), order: 'desc', shopid: String(shop.shopId), sort_by: 'pop', use_case: '4' }).toString();
  let response;
  try { response = await fetch(url, { headers: { Accept: 'application/json', Referer: shop.shopUrl, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' }, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { fail(502, 'Koneksi katalog Shopee gagal. Coba lagi beberapa saat.'); }
  let data;
  try { data = await response.json(); } catch { fail(502, 'Shopee tidak mengembalikan data katalog yang dapat dibaca.'); }
  if (!response.ok || Number(data?.error || 0) !== 0) fail(502, 'Shopee menolak permintaan katalog atau membatasi akses. Laporan dapat dicoba lagi nanti.');
  const cards = data?.centralize_item_card?.item_cards ?? data?.data?.centralize_item_card?.item_cards;
  if (!Array.isArray(cards)) fail(502, 'Format daftar katalog Shopee berubah atau tidak didukung.');
  const items = cards.map(card => flattenShopItem(card, shop.shopId)).filter(item => item.itemId > 0 && item.name);
  const total = Number(data.total_count ?? data.data?.total ?? 0);
  const noMore = data.nomore === true || data.data?.no_more === true || cards.length === 0 || (total > 0 && offset + cards.length >= total);
  if (cards.length === 0 && total > offset) fail(502, 'Shopee mengembalikan halaman katalog kosong sebelum seluruh produk terbaca.');
  return { items, rawCount: cards.length, total: Number.isSafeInteger(total) && total >= 0 ? total : 0, noMore };
}
async function startShopScrape(ctx, body) {
  const parsed = parsePublicShopUrl(body.url);
  const catalogSource = process.env.LUMINTU_SHOPEE_API_KEY ? 'lumintu' : 'direct';
  const ref = ctx.shop.collection('shopScrapeRuns').doc(crypto.randomUUID());
  const run = { ...parsed, catalogSource, status: 'running', createdAt: Date.now(), updatedAt: Date.now(), nextOffset: 0, collected: 0, total: null, pages: 0, lockUntil: 0 };
  await ref.create(run);
  return { runId: ref.id, ...run };
}
async function scrapeShopPage(ctx, body) {
  if (typeof body.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.runId)) fail(400, 'ID proses scrape tidak valid.');
  const ref = ctx.shop.collection('shopScrapeRuns').doc(body.runId);
  let run;
  await ctx.db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail(404, 'Proses scrape toko tidak ditemukan.');
    run = snap.data();
    if (run.status === 'complete') fail(409, 'Katalog toko ini sudah selesai diambil.');
    if (run.lockUntil > Date.now()) fail(409, 'Halaman katalog sedang diambil pada tab lain.');
    tx.set(ref, { status: 'running', lockUntil: Date.now() + 30000, updatedAt: Date.now() }, { merge: true });
  });
  try {
    const page = await fetchShopCatalogPage(run, Number(run.nextOffset) || 0);
    const itemsRef = ref.collection('items'); const batch = ctx.db.batch();
    for (const item of page.items) batch.set(itemsRef.doc(String(item.itemId)), { ...item, scrapedAt: Date.now() });
    if (page.items.length) await batch.commit();
    const count = page.items.length ? (await itemsRef.count().get()).data().count : Number(run.collected) || 0;
    const nextOffset = (Number(run.nextOffset) || 0) + page.rawCount;
    const updated = { status: page.noMore ? 'complete' : 'running', nextOffset, collected: count, total: page.total || run.total || null, pages: (Number(run.pages) || 0) + 1, lockUntil: 0, updatedAt: Date.now(), ...(page.noMore ? { completedAt: Date.now() } : {}) };
    await ref.set(updated, { merge: true });
    return { runId: body.runId, ...updated, items: page.items, hasMore: !page.noMore };
  } catch (error) {
    await ref.set({ status: 'paused', lockUntil: 0, updatedAt: Date.now() }, { merge: true }).catch(() => {});
    throw error;
  }
}

function normalizeAdsDate(value, label, required = true) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(400, `${label} wajib diisi.`);
    return undefined;
  }
  const raw = String(value).trim();
  let day, month, year;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match) { year = Number(match[1]); month = Number(match[2]); day = Number(match[3]); }
  else {
    match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
    if (!match) fail(400, `${label} harus berformat YYYY-MM-DD atau DD-MM-YYYY.`);
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fail(400, `${label} tidak valid.`);
  return `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
}
function moneyAmount(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(400, `${label} harus lebih dari 0.`);
  return Number(n.toFixed(2));
}
function optionalNumber(value, label, minimum = 0) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < minimum) fail(400, `${label} tidak valid.`);
  return Number(n.toFixed(1));
}
function optionalString(value, max = 100) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, max) : undefined;
}
function adsReference(prefix, body) {
  const given = optionalString(body.referenceId || body.reference_id, 64);
  if (given) return given;
  const id = typeof body.operationId === 'string' ? body.operationId.replace(/[^a-f0-9-]/gi, '').slice(0, 36) : crypto.randomUUID();
  return `${prefix}_${id}`.slice(0, 64);
}
function manualAdsPayload(body) {
  const itemId = positive(Number(body.itemId ?? body.item_id), 'Produk');
  const biddingMethod = String(body.biddingMethod || body.bidding_method || 'manual').trim().toLowerCase();
  if (!['manual', 'auto'].includes(biddingMethod)) fail(400, 'Metode bidding iklan harus manual atau auto.');
  const payload = {
    reference_id: adsReference('manual_product_ads', body),
    budget: moneyAmount(body.budget, 'Budget iklan'),
    item_id: itemId,
    bidding_method: biddingMethod,
    start_date: normalizeAdsDate(body.startDate || body.start_date, 'Tanggal mulai'),
  };
  const endDate = normalizeAdsDate(body.endDate || body.end_date, 'Tanggal selesai', false);
  if (endDate) payload.end_date = endDate;
  const smart = optionalString(body.smartCreativeSetting || body.smart_creative_setting, 20);
  if (smart && !['default', 'on', 'off'].includes(smart)) fail(400, 'Smart creative harus default, on, atau off.');
  if (smart) payload.smart_creative_setting = smart;
  const roas = optionalNumber(body.roasTarget ?? body.roas_target, 'Target ROAS', 0);
  if (roas !== undefined) payload.roas_target = roas;
  if (body.enhancedCpc !== undefined || body.enhanced_cpc !== undefined) payload.enhanced_cpc = Boolean(body.enhancedCpc ?? body.enhanced_cpc);
  const keywords = Array.isArray(body.keywords) ? body.keywords : Array.isArray(body.selected_keywords) ? body.selected_keywords : [];
  if (biddingMethod === 'manual') {
    if (!keywords.length) fail(400, 'Minimal satu keyword diperlukan untuk manual bidding.');
    payload.selected_keywords = keywords.slice(0, 200).map(entry => {
      const keyword = optionalString(entry.keyword, 100);
      const matchType = String(entry.matchType || entry.match_type || 'broad').trim().toLowerCase();
      if (!keyword) fail(400, 'Keyword iklan wajib diisi.');
      if (!['exact', 'broad'].includes(matchType)) fail(400, 'Match type keyword harus exact atau broad.');
      return { keyword, match_type: matchType, bid_price_per_click: moneyAmount(entry.bidPricePerClick ?? entry.bid_price_per_click ?? entry.bidPrice ?? entry.bid_price, 'Bid keyword') };
    });
  }
  const locations = Array.isArray(body.discoveryLocations) ? body.discoveryLocations : Array.isArray(body.discovery_ads_locations) ? body.discovery_ads_locations : [];
  if (locations.length) payload.discovery_ads_locations = locations.slice(0, 10).map(entry => {
    const location = String(entry.location || '').trim().toLowerCase();
    if (!['daily_discover', 'you_may_also_like'].includes(location)) fail(400, 'Lokasi discovery ads tidak valid.');
    return { location, bid_price: moneyAmount(entry.bidPrice ?? entry.bid_price, 'Bid lokasi discovery') };
  });
  return payload;
}
function gmsCampaignPayload(body) {
  const payload = {
    start_date: normalizeAdsDate(body.startDate || body.start_date, 'Tanggal mulai'),
    daily_budget: moneyAmount(body.dailyBudget ?? body.daily_budget, 'Budget harian'),
  };
  const endDate = normalizeAdsDate(body.endDate || body.end_date, 'Tanggal selesai', false);
  if (endDate) payload.end_date = endDate;
  const referenceId = optionalString(body.referenceId || body.reference_id, 64);
  if (referenceId) payload.reference_id = referenceId;
  else payload.reference_id = adsReference('gms_shop_ads', body);
  const roas = optionalNumber(body.roasTarget ?? body.roas_target, 'Target ROAS', 0);
  if (roas !== undefined && roas > 0) payload.roas_target = roas;
  return payload;
}
async function saveAdsRecord(ctx, kind, payload, result, user) {
  const id = String(result.campaign_id || result.campaignId || payload.reference_id || crypto.randomUUID());
  await ctx.shop.collection('adsCampaigns').doc(`${kind}_${id}`).set({ kind, payload, result, uid: user.uid, createdAt: Date.now(), updatedAt: Date.now() }, { merge: true });
}


function percentRate(value, label = 'Komisi') {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100) fail(400, `${label} harus lebih dari 0 sampai 100 persen.`);
  return Number(n.toFixed(2));
}
function unixSecond(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) fail(400, `${label} tidak valid.`);
  return n;
}
function amsWindow(body, required = true) {
  const startValue = body.periodStartTime ?? body.period_start_time;
  const endValue = body.periodEndTime ?? body.period_end_time;
  if (!required && (startValue === undefined || startValue === null || startValue === '') && (endValue === undefined || endValue === null || endValue === '')) return {};
  if ((startValue === undefined || startValue === null || startValue === '') || (endValue === undefined || endValue === null || endValue === '')) fail(400, 'Waktu mulai dan selesai kampanye harus diisi bersama.');
  const period_start_time = unixSecond(startValue, 'Waktu mulai kampanye');
  const period_end_time = unixSecond(endValue, 'Waktu selesai kampanye');
  if (period_end_time <= period_start_time) fail(400, 'Periode kampanye tidak valid.');
  return { period_start_time, period_end_time };
}
function amsOpenPayload(body) {
  return { commission_rate: percentRate(body.commissionRate ?? body.commission_rate), ...amsWindow(body, false) };
}
function amsBatchPayload(body) {
  if (!Array.isArray(body.itemIdList || body.item_id_list)) fail(400, 'Daftar produk AMS wajib diisi.');
  const item_id_list = [...new Set((body.itemIdList || body.item_id_list).map(Number))];
  if (!item_id_list.length || item_id_list.length > 100 || item_id_list.some(id => !Number.isSafeInteger(id) || id <= 0)) fail(400, 'Daftar produk AMS tidak valid.');
  return { item_id_list, ...amsOpenPayload(body) };
}
function amsTargetedPayload(body) {
  const campaign_name = optionalString(body.campaignName || body.campaign_name, 80);
  if (!campaign_name) fail(400, 'Nama targeted campaign wajib diisi.');
  const seller_message = optionalString(body.sellerMessage || body.seller_message || 'Ayo kolaborasi dengan toko kami.', 500) || 'Ayo kolaborasi dengan toko kami.';
  const itemSource = Array.isArray(body.itemList || body.item_list) ? (body.itemList || body.item_list) : [];
  const affiliateSource = Array.isArray(body.affiliateList || body.affiliate_list) ? (body.affiliateList || body.affiliate_list) : [];
  if (!itemSource.length || itemSource.length > 100) fail(400, 'Targeted campaign memerlukan 1 sampai 100 produk.');
  if (!affiliateSource.length || affiliateSource.length > 100) fail(400, 'Targeted campaign memerlukan 1 sampai 100 affiliate.');
  const item_list = itemSource.map(item => ({ item_id: positive(Number(item.itemId ?? item.item_id), 'Produk'), rate: percentRate(item.rate ?? item.commissionRate ?? item.commission_rate, 'Komisi produk') }));
  const affiliate_list = affiliateSource.map(item => ({ affiliate_id: positive(Number(item.affiliateId ?? item.affiliate_id), 'Affiliate') }));
  const is_set_budget = Boolean(body.isSetBudget ?? body.is_set_budget);
  const payload = { campaign_name, ...amsWindow(body), is_set_budget, seller_message, item_list, affiliate_list };
  if (is_set_budget) payload.budget = moneyAmount(body.budget, 'Budget targeted campaign');
  return payload;
}
function yyyymmdd(value, label) {
  const raw = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) || /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (!match) fail(400, `${label} harus berformat YYYY-MM-DD.`);
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) fail(400, `${label} tidak valid.`);
  return `${y}${m}${d}`;
}
function amsPagination(q) {
  const page_no = q.page_no || q.pageNo ? Math.max(1, Math.min(1000, Number(q.page_no || q.pageNo))) : 1;
  const page_size = q.page_size || q.pageSize ? Math.max(1, Math.min(100, Number(q.page_size || q.pageSize))) : 20;
  return { page_no, page_size };
}
function amsPerformanceParams(q) {
  const allowed = new Set(['Day', 'Week', 'Month', 'Last7d', 'Last30d']);
  const period_type = String(q.period_type || q.periodType || 'Last7d');
  if (!allowed.has(period_type)) fail(400, 'Periode performa AMS tidak valid.');
  const params = { period_type, start_date: yyyymmdd(q.start_date || q.startDate, 'Tanggal mulai'), end_date: yyyymmdd(q.end_date || q.endDate, 'Tanggal selesai'), ...amsPagination(q) };
  if (q.item_id || q.itemId) params.item_id = positive(Number(q.item_id || q.itemId), 'Produk');
  return params;
}
function amsReportParams(q) {
  const params = { ...amsPagination(q) };
  const orderSn = optionalString(q.order_sn || q.orderSn, 32); if (orderSn) params.order_sn = orderSn;
  for (const key of ['affiliate_id', 'item_id', 'verified_status', 'order_status']) if (q[key] !== undefined) params[key] = Number(q[key]);
  if (q.from || q.place_order_time_start) params.place_order_time_start = unixSecond(q.from || q.place_order_time_start, 'Awal laporan');
  if (q.to || q.place_order_time_end) params.place_order_time_end = unixSecond(q.to || q.place_order_time_end, 'Akhir laporan');
  return params;
}
async function saveAmsRecord(ctx, kind, payload, result, user) {
  const id = String(result.campaign_id || result.task_id || payload.campaign_name || crypto.randomUUID());
  await ctx.shop.collection('amsCampaigns').doc(`${kind}_${id}`).set({ kind, payload, result, uid: user.uid, createdAt: Date.now(), updatedAt: Date.now() }, { merge: true });
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
  if (req.method === 'GET' && path === '/payment/income-detail') {
    const dateFrom = String(q.date_from || '').trim(), dateTo = String(q.date_to || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) fail(400, 'date_from dan date_to harus berupa rentang tanggal valid.');
    const incomeStatus = Number(q.income_status);
    if (![0, 1, 2].includes(incomeStatus)) fail(400, 'income_status harus 0, 1, atau 2.');
    const pageSize = Math.max(1, Math.min(100, Number(q.page_size) || 30));
    const cursor = q.cursor ? String(q.cursor).slice(0, 200) : undefined;
    return { shopId: SHOP(), data: await ctx.api('/payment/get_income_detail', { date_from: dateFrom, date_to: dateTo, income_status: incomeStatus, page_size: pageSize, ...(cursor ? { cursor } : {}) }) };
  }
  if (req.method === 'GET' && path === '/product/item-base-info') {
    const rawIds = Array.isArray(q.item_id_list) ? q.item_id_list : String(q.item_id_list || '').split(',').filter(Boolean);
    if (!rawIds.length || rawIds.length > 50) fail(400, 'item_id_list harus berisi 1 sampai 50 item.');
    const itemIds = rawIds.map(id => positive(Number(id), 'item_id_list'));
    return { shopId: SHOP(), data: await ctx.api('/product/get_item_base_info', { item_id_list: itemIds.join(','), ...(q.need_complaint_policy === 'true' ? { need_complaint_policy: true } : {}), ...(q.need_tax_info === 'true' ? { need_tax_info: true } : {}) }) };
  }
  if (req.method === 'GET' && path === '/product/item-extra-info') return { shopId: SHOP(), data: await ctx.api('/product/get_item_extra_info') };
  if (req.method === 'GET' && path === '/product/item-list') {
    const offset = Math.max(0, Number(q.offset) || 0), pageSize = Math.max(1, Math.min(100, Number(q.page_size) || 20));
    if (!Number.isSafeInteger(offset)) fail(400, 'offset tidak valid.');
    const statuses = String(q.item_status || '').split(',').map(x => x.trim()).filter(Boolean);
    if (statuses.some(x => !['NORMAL', 'UNLIST', 'BANNED', 'DELETED'].includes(x))) fail(400, 'item_status tidak valid.');
    return { shopId: SHOP(), data: await ctx.api('/product/get_item_list', { offset, page_size: pageSize, ...(statuses.length ? { item_status: statuses } : {}), ...(q.update_time_from ? { update_time_from: Number(q.update_time_from) } : {}), ...(q.update_time_to ? { update_time_to: Number(q.update_time_to) } : {}) }) };
  }
  if (req.method === 'POST' && path === '/product/delete-item') return mutate(ctx, user, path, b, async () => {
    const itemId = positive(Number(b.item_id ?? b.itemId), 'item_id');
    return ctx.api('/product/delete_item', { item_id: itemId }, 'POST');
  });
  if (req.method === 'POST' && (path === '/product/add-item' || path === '/product/update-item')) return mutate(ctx, user, path, b, async () => {
    const { confirm, operationId, ...payload } = b;
    if (!Number.isSafeInteger(Number(payload.category_id)) || Number(payload.category_id) <= 99999) fail(400, 'category_id harus lebih besar dari 99999.');
    if (path === '/product/update-item') payload.item_id = positive(Number(payload.item_id), 'item_id');
    if (typeof payload.item_name !== 'string' || !payload.item_name.trim()) fail(400, 'item_name wajib diisi.');
    if (payload.image?.image_id_list && (!Array.isArray(payload.image.image_id_list) || payload.image.image_id_list.some(x => typeof x !== 'string'))) fail(400, 'image.image_id_list harus berupa array string.');
    if (payload.video_upload_id && (!Array.isArray(payload.video_upload_id) || payload.video_upload_id.some(x => typeof x !== 'string'))) fail(400, 'video_upload_id harus berupa array string.');
    return ctx.api(path === '/product/add-item' ? '/product/add_item' : '/product/update_item', payload, 'POST');
  });
  if (req.method === 'GET' && path === '/shop/holiday-mode') return { shopId: SHOP(), data: await ctx.api('/shop/get_shop_holiday_mode') };
  if (req.method === 'POST' && path === '/shop/holiday-mode') {
    if (typeof b.holiday_mode_on !== 'boolean') fail(400, 'holiday_mode_on harus berupa boolean.');
    const modeType = Number(b.holiday_mode_type);
    if (!Number.isInteger(modeType) || modeType < 0) fail(400, 'holiday_mode_type tidak valid.');
    const start = Number(b.holiday_mode_start_time), end = Number(b.holiday_mode_end_time);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) fail(400, 'Rentang waktu holiday mode tidak valid.');
    const description = String(b.holiday_mode_description || '').trim();
    if (description.length > 500) fail(400, 'holiday_mode_description terlalu panjang.');
    return { shopId: SHOP(), data: await ctx.api('/shop/set_shop_holiday_mode', { holiday_mode_on: b.holiday_mode_on, holiday_mode_type: modeType, holiday_mode_start_time: start, holiday_mode_end_time: end, holiday_mode_description: description }, 'POST') };
  }
  if (req.method === 'GET' && path === '/shop/br-onboarding') return { shopId: SHOP(), data: await ctx.api('/shop/get_br_shop_onboarding_info') };
  if (req.method === 'GET' && path === '/product/comments') {
    const itemId = positive(Number(q.item_id), 'item_id');
    const commentId = q.comment_id === undefined || q.comment_id === '' ? undefined : positive(Number(q.comment_id), 'comment_id');
    const cursor = q.cursor === undefined ? undefined : String(q.cursor).slice(0, 200);
    const pageSize = Math.max(1, Math.min(100, Number(q.page_size) || 10));
    return { shopId: SHOP(), data: await ctx.api('/product/get_comment', { item_id: itemId, ...(commentId ? { comment_id: commentId } : {}), ...(cursor ? { cursor } : {}), page_size: pageSize }) };
  }
  if (req.method === 'POST' && path === '/product/comments/reply') {
    if (!Array.isArray(b.comment_list) || b.comment_list.length < 1 || b.comment_list.length > 50) fail(400, 'comment_list harus berisi 1 sampai 50 komentar.');
    const commentList = b.comment_list.map((item) => {
      if (!item || typeof item !== 'object') fail(400, 'Format comment_list tidak valid.');
      const commentId = positive(Number(item.comment_id), 'comment_id');
      const comment = String(item.comment || '').trim();
      if (!comment || comment.length > 1000) fail(400, 'Isi balasan komentar tidak valid.');
      return { comment_id: commentId, comment };
    });
    return { shopId: SHOP(), data: await ctx.api('/product/reply_comment', { comment_list: commentList }, 'POST') };
  }
  if (req.method === 'GET' && path === '/shop/profile') {
    return { shopId: SHOP(), data: await ctx.api('/shop/get_profile') };
  }
  if (req.method === 'GET' && path === '/ads/campaigns') {
    const snapshot = await ctx.shop.collection('adsCampaigns').orderBy('createdAt', 'desc').limit(50).get();
    return { campaigns: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) };
  }
  if (req.method === 'POST' && path === '/ads/product/manual') return mutate(ctx, user, path, b, async () => {
    const payload = manualAdsPayload(b);
    const result = await ctx.api('/ads/create_manual_product_ads', payload, 'POST');
    await saveAdsRecord(ctx, 'product_manual', payload, result, user);
    return { ok: true, payload, result };
  });
  if (req.method === 'POST' && path === '/ads/shop/gms') return mutate(ctx, user, path, b, async () => {
    const payload = gmsCampaignPayload(b);
    const result = await ctx.api('/ads/create_gms_product_campaign', payload, 'POST');
    await saveAdsRecord(ctx, 'shop_gms', payload, result, user);
    return { ok: true, payload, result };
  });
  if (req.method === 'GET' && path === '/ams/status') return { integrated: true, apis: ['v2.ams.add_all_products_to_open_campaign', 'v2.ams.batch_add_products_to_open_campaign', 'v2.ams.create_new_targeted_campaign', 'v2.ams.get_open_campaign_performance', 'v2.ams.get_conversion_report', 'v2.ams.get_validation_report'] };
  if (req.method === 'GET' && path === '/ams/campaigns') {
    const snapshot = await ctx.shop.collection('amsCampaigns').orderBy('createdAt', 'desc').limit(50).get();
    return { campaigns: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) };
  }
  if (req.method === 'GET' && path === '/ams/open-campaign/products') return ctx.api('/ams/get_open_campaign_added_product', { page_size: Math.max(1, Math.min(100, Number(q.page_size || q.pageSize) || 20)), ...(q.cursor ? { cursor: String(q.cursor).slice(0, 200) } : {}) });
  if (req.method === 'GET' && path === '/ams/open-campaign/performance') return ctx.api('/ams/get_open_campaign_performance', amsPerformanceParams(q));
  if (req.method === 'GET' && path === '/ams/affiliate-performance') return ctx.api('/ams/get_affiliate_performance', amsPerformanceParams(q));
  if (req.method === 'GET' && path === '/ams/conversion-report') return ctx.api('/ams/get_conversion_report', amsReportParams(q));
  if (req.method === 'GET' && path === '/ams/validation-report') return ctx.api('/ams/get_validation_report', amsReportParams(q));
  if (req.method === 'GET' && path === '/product/boost/rotation') {
    const snap = await ctx.shop.collection('boostRotation').doc('config').get();
    return { ...(snap.data() || { enabled: false, itemIds: [] }), maxProducts: 100, dailyBatchSize: 5 };
  }
  if (req.method === 'POST' && path === '/product/boost/rotation') {
    if (!Array.isArray(b.itemIds) || b.itemIds.length > 100) fail(400, 'Antrean harus berisi maksimal 100 produk.');
    const itemIds = [...new Set(b.itemIds.map(Number))];
    if (itemIds.some(id => !Number.isSafeInteger(id) || id <= 0) || itemIds.length !== b.itemIds.length) fail(400, 'Daftar produk tidak valid atau memiliki duplikat.');
    if (typeof b.enabled !== 'boolean') fail(400, 'Status rotasi tidak valid.');
    if (b.enabled && !itemIds.length) fail(400, 'Pilih minimal 1 produk aktif sebelum mengaktifkan rotasi harian.');
    if (itemIds.length) {
      const meta = (await ctx.shop.get()).data() || {};
      const snapshot = meta.activeSnapshot ? await ctx.shop.collection('snapshots').doc(meta.activeSnapshot).collection('products').get() : { docs: [] };
      const active = new Set(snapshot.docs.filter(doc => doc.data().status === 'NORMAL').map(doc => Number(doc.id)));
      if (itemIds.some(id => !active.has(id))) fail(400, 'Antrean hanya boleh berisi produk aktif dari katalog yang telah disinkronkan.');
    }
    await ctx.shop.collection('boostRotation').doc('config').set({ itemIds, enabled: b.enabled, updatedAt: Date.now(), ...(b.enabled ? {} : { disabledAt: Date.now() }) }, { merge: true });
    return { ok: true, itemIds, enabled: b.enabled };
  }
  if (req.method === 'GET' && path === '/market-intelligence/status') return productAgentsStatus();
  if (req.method === 'POST' && path === '/market-intelligence/query') return queryProductResearch(b, user.uid);
  if (req.method === 'POST' && path === '/product/listing-draft') return generateListingDraft(b, user.uid);
  if (req.method === 'GET' && path === '/scraper/status') return { productServiceConfigured: Boolean(process.env.SHOPEE_SCRAPER_URL && process.env.SHOPEE_SCRAPER_API_KEY), shopCatalogAvailable: true, catalogSource: process.env.LUMINTU_SHOPEE_API_KEY ? 'lumintu' : 'direct', lumintuConfigured: Boolean(process.env.LUMINTU_SHOPEE_API_KEY) };
  if (req.method === 'GET' && path === '/scraper/shop/runs') {
    const snapshot = await ctx.shop.collection('shopScrapeRuns').orderBy('createdAt', 'desc').limit(10).get();
    return { runs: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) };
  }
  if (req.method === 'GET' && path === '/scraper/shop/items') {
    if (typeof q.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(q.runId)) fail(400, 'ID proses scrape tidak valid.');
    const run = await ctx.shop.collection('shopScrapeRuns').doc(q.runId).get();
    if (!run.exists) fail(404, 'Proses scrape toko tidak ditemukan.');
    let query = run.ref.collection('items').orderBy('itemId').limit(101);
    if (typeof q.cursor === 'string' && q.cursor) {
      const cursor = await run.ref.collection('items').doc(q.cursor).get();
      if (!cursor.exists) fail(400, 'Penanda halaman katalog tidak valid.');
      query = run.ref.collection('items').orderBy('itemId').startAfter(cursor).limit(101);
    }
    const docs = (await query.get()).docs;
    return { items: docs.slice(0, 100).map(doc => ({ id: doc.id, ...doc.data() })), hasMore: docs.length > 100, nextCursor: docs.length > 100 ? docs[99].id : '' };
  }
  if (req.method === 'POST' && path === '/scraper/shop/start') return startShopScrape(ctx, b);
  if (req.method === 'POST' && path === '/scraper/shop/page') return scrapeShopPage(ctx, b);
  if (req.method === 'GET' && path === '/scraper/results') {
    const snapshot = await ctx.shop.collection('scrapeResults').orderBy('createdAt', 'desc').limit(100).get();
    return { results: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) };
  }
  if (req.method === 'POST' && path === '/scraper/product') return scrapePublicProduct(ctx, b);
  if (req.method === 'GET' && path === '/profit') return profitReport(ctx, q);
  if (req.method === 'GET' && path === '/profit/costs') {
    const costs = await ctx.shop.collection('profitCosts').get();
    return { costs: costs.docs.map(doc => ({ key: doc.id, ...doc.data() })) };
  }
  if (req.method === 'POST' && path === '/profit/costs') {
    const itemId = positive(Number(b.itemId), 'Produk');
    const modelId = Number(b.modelId);
    if (!Number.isSafeInteger(modelId) || modelId < 0 || !Number.isFinite(b.unitCost) || b.unitCost < 0 || b.unitCost > 1000000000000) fail(400, 'Modal per unit tidak valid.');
    const key = `${itemId}_${modelId}`;
    await ctx.shop.collection('profitCosts').doc(key).set({ itemId, modelId, unitCost: Number(b.unitCost), sku: String(b.sku || '').slice(0, 100), name: String(b.name || '').slice(0, 200), updatedAt: Date.now() });
    return { ok: true, key, unitCost: Number(b.unitCost) };
  }
  if (req.method === 'GET' && path === '/orders') return listOrders(ctx, String(q.cursor || '').slice(0, 200), q.view === 'shipping');
  if (req.method === 'GET' && path === '/channels') return ctx.api('/logistics/get_channel_list');
  if (req.method === 'GET' && path === '/product') return { product: productRow(await productDetail(ctx, positive(Number(q.itemId), 'Produk'))) };
  if (req.method === 'GET' && path === '/product/full') {
    const item = await productDetail(ctx, positive(Number(q.itemId), 'Produk'));
    return { item: { itemId: item.item_id, itemName: item.item_name || '', itemSku: item.item_sku || '', description: item.description || '', hasModel: Boolean(item.has_model), status: item.item_status } };
  }
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
  if (path === '/product/update-details') return mutate(ctx, user, path, b, async () => {
    const id = positive(Number(b.itemId), 'Produk'), item = await productDetail(ctx, id);
    if (typeof b.itemName !== 'string' || !b.itemName.trim() || b.itemName.trim().length > 120) fail(400, 'Nama produk harus 1–120 karakter.');
    if (typeof b.description !== 'string' || !b.description.trim() || b.description.length > 30000) fail(400, 'Deskripsi produk wajib diisi, maksimal 30.000 karakter.');
    if (!item.has_model && (typeof b.itemSku !== 'string' || b.itemSku.length > 200)) fail(400, 'SKU produk maksimal 200 karakter.');
    await ctx.api('/product/update_item', { item_id: id, item_name: b.itemName.trim(), description: b.description.trim(), ...(!item.has_model ? { item_sku: b.itemSku.trim() } : {}) }, 'POST');
    return { ok: true, product: await cacheProduct(ctx, id) };
  });
  if (path === '/product/add') return mutate(ctx, user, path, b, async () => {
    const templateId = positive(Number(b.templateItemId), 'Produk contoh');
    const template = await productDetail(ctx, templateId);
    if (template.has_model) fail(409, 'Pilih produk contoh tanpa variasi. Produk yang memiliki variasi belum dapat disalin melalui fitur ini.');
    const itemName = typeof b.itemName === 'string' ? b.itemName.trim() : '';
    const description = typeof b.description === 'string' ? b.description.trim() : '';
    const itemSku = typeof b.itemSku === 'string' ? b.itemSku.trim() : '';
    const price = Number(b.price), stock = Number(b.stock), weight = Number(b.weight);
    if (!itemName || itemName.length > 120 || !description || description.length > 30000) fail(400, 'Nama (maks. 120 karakter) dan deskripsi produk wajib diisi.');
    if (!Number.isFinite(price) || price <= 0 || price > 1000000000000 || !Number.isSafeInteger(stock) || stock < 0 || stock > 2147483647 || !Number.isFinite(weight) || weight <= 0 || weight > 100000) fail(400, 'Harga, stok, atau berat produk tidak valid.');
    if (itemSku.length > 200) fail(400, 'SKU produk maksimal 200 karakter.');
    if (!['NORMAL', 'UNLIST'].includes(b.itemStatus)) fail(400, 'Status produk baru tidak valid.');
    const images = template.image?.image_id_list || [];
    const logistics = (template.logistic_info || []).filter(x => x.enabled).map(x => ({ logistic_id: x.logistic_id, enabled: true, ...(x.size_id !== undefined ? { size_id: x.size_id } : {}), ...(x.shipping_fee !== undefined ? { shipping_fee: x.shipping_fee } : {}), ...(x.is_free !== undefined ? { is_free: x.is_free } : {}) }));
    if (!images.length || !logistics.length) fail(409, 'Produk contoh harus memiliki foto dan minimal satu kurir aktif.');
    const sellerStocks = template.stock_info_v2?.seller_stock || [];
    if (sellerStocks.length > 1) fail(409, 'Produk contoh menggunakan beberapa gudang. Pilih template dengan satu lokasi stok.');
    const result = await ctx.api('/product/add_item', {
      item_name: itemName, item_sku: itemSku, description, category_id: template.category_id,
      original_price: price, weight, dimension: template.dimension,
      image: { image_id_list: images.slice(0, 9) }, logistic_info: logistics,
      attribute_list: template.attribute_list || [], ...(template.brand ? { brand: template.brand } : {}),
      ...(template.condition ? { condition: template.condition } : {}), ...(template.item_dangerous !== undefined ? { item_dangerous: template.item_dangerous } : {}),
      seller_stock: [{ ...(sellerStocks[0]?.location_id ? { location_id: sellerStocks[0].location_id } : {}), stock }],
      item_status: b.itemStatus,
    }, 'POST');
    const itemId = Number(result.item_id);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) fail(502, 'Shopee tidak mengembalikan ID produk baru. Periksa katalog sebelum mencoba ulang.');
    let product = await cacheProduct(ctx, itemId).catch(() => null);
    if (!product) {
      const locationId = sellerStocks[0]?.location_id;
      const fallback = productRow({ ...template, item_id: itemId, item_name: itemName, item_sku: itemSku, item_status: b.itemStatus, has_model: false, price_info: [{ current_price: price, original_price: price }], weight, stock_info_v2: { seller_stock: [{ ...(locationId ? { location_id: locationId } : {}), stock }], summary_info: { total_available_stock: stock } } });
      const meta = (await ctx.shop.get()).data() || {};
      if (meta.activeSnapshot) await ctx.shop.collection('snapshots').doc(meta.activeSnapshot).collection('products').doc(String(itemId)).set(fallback);
      product = fallback;
    }
    return { ok: true, itemId, product, itemStatus: b.itemStatus };
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
  if (path === '/product/boost') return mutate(ctx, user, path, b, async () => {
    if (!Array.isArray(b.itemIdList) || b.itemIdList.length < 1 || b.itemIdList.length > 5) fail(400, 'Pilih 1 sampai 5 produk untuk dinaikkan.');
    const itemIdList = [...new Set(b.itemIdList.map(Number))];
    if (itemIdList.some(id => !Number.isSafeInteger(id) || id <= 0)) fail(400, 'Produk yang dipilih tidak valid.');
    if (itemIdList.length !== b.itemIdList.length) fail(400, 'Daftar produk memuat ID duplikat.');
    const current = await ctx.api('/product/get_item_base_info', { item_id_list: itemIdList.join(',') });
    if (!Array.isArray(current.item_list) || current.item_list.length !== itemIdList.length) fail(502, 'Status produk belum dapat diverifikasi. Sinkronkan katalog dan coba lagi.');
    if (current.item_list.some(item => item.item_status !== 'NORMAL')) fail(409, 'Hanya produk aktif yang bisa dinaikkan. Muat ulang katalog dan pilih produk aktif.');
    const result = await ctx.api('/product/boost_item', { item_id_list: itemIdList }, 'POST');
    const failedIds = result.failure_list?.map(item => item.item_id) || [];
    const successIds = result.success_list?.item_id_list;
    if (!Array.isArray(successIds) || successIds.length !== itemIdList.length || itemIdList.some(id => !successIds.includes(id)) || failedIds.length) fail(502, 'Shopee belum mengonfirmasi semua produk yang dipilih.', { failedIds });
    return { ok: true, itemIdList };
  });
  if (path === '/discount/create') return mutate(ctx, user, path, b, async () => {
    if (typeof b.discountName !== 'string' || b.discountName.trim().length < 1 || b.discountName.trim().length > 80) fail(400, 'Nama diskon harus 1 sampai 80 karakter.');
    const startTime = Number(b.startTime), endTime = Number(b.endTime);
    if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime < Math.floor(Date.now() / 1000) + 3600 || endTime <= startTime + 3600 || endTime > startTime + 180 * 86400) fail(400, 'Waktu diskon harus dimulai minimal 1 jam lagi dan berlangsung maksimal 180 hari.');
    if (!Array.isArray(b.itemList) || b.itemList.length < 1 || b.itemList.length > 50) fail(400, 'Pilih 1 sampai 50 produk untuk diskon.');
    const itemList = b.itemList.map(item => {
      const itemId = Number(item.itemId), promotionPrice = Number(item.promotionPrice);
      if (!Number.isSafeInteger(itemId) || itemId <= 0 || !Number.isFinite(promotionPrice) || promotionPrice <= 0) fail(400, 'Produk atau harga diskon tidak valid.');
      return { item_id: itemId, item_promotion_price: promotionPrice };
    });
    const created = await ctx.api('/discount/add_discount', { discount_name: b.discountName.trim(), start_time: startTime, end_time: endTime }, 'POST');
    const discountId = Number(created.discount_id);
    if (!Number.isSafeInteger(discountId) || discountId <= 0) fail(502, 'Shopee tidak mengembalikan ID diskon.');
    const added = await ctx.api('/discount/add_discount_item', { discount_id: discountId, item_list: itemList }, 'POST');
    if (added.error_list?.length || Number(added.count) !== itemList.length) fail(502, 'Diskon dibuat tetapi sebagian produk gagal ditambahkan.', { discountId, errorList: added.error_list || [] });
    return { ok: true, discountId, count: added.count };
  });
  if (path === '/ams/open-campaign/add-all-products' || path === '/ams/add-all-products-to-open-campaign') return mutate(ctx, user, path, b, async () => {
    const payload = amsOpenPayload(b);
    const result = await ctx.api('/ams/add_all_products_to_open_campaign', payload, 'POST');
    if (!result.task_id) fail(502, 'Shopee tidak mengembalikan ID tugas kampanye AMS.');
    await saveAmsRecord(ctx, 'open_all_products', payload, result, user);
    return { ok: true, taskId: result.task_id, payload, result };
  });
  if (path === '/ams/open-campaign/batch-add-products' || path === '/ams/batch-add-products-to-open-campaign') return mutate(ctx, user, path, b, async () => {
    const payload = amsBatchPayload(b);
    const result = await ctx.api('/ams/batch_add_products_to_open_campaign', payload, 'POST');
    if (!result.task_id) fail(502, 'Shopee tidak mengembalikan ID tugas kampanye AMS.');
    await saveAmsRecord(ctx, 'open_selected_products', payload, result, user);
    return { ok: true, taskId: result.task_id, payload, result };
  });
  if (path === '/ams/targeted-campaign/create' || path === '/ams/create-new-targeted-campaign') return mutate(ctx, user, path, b, async () => {
    const payload = amsTargetedPayload(b);
    const result = await ctx.api('/ams/create_new_targeted_campaign', payload, 'POST');
    if (!result.campaign_id) fail(502, 'Shopee tidak mengembalikan ID targeted campaign AMS.');
    await saveAmsRecord(ctx, 'targeted_campaign', payload, result, user);
    return { ok: true, campaignId: result.campaign_id, payload, result };
  });
  const orderParams = { order_sn: b.orderSn, ...(b.packageNumber ? { package_number: b.packageNumber } : {}) };
  if (path === '/shipping/ship') return mutate(ctx, user, path, b, async () => {
    const order = await getOrder(ctx, b.orderSn, b.packageNumber);
    if (order.order_status !== 'READY_TO_SHIP') fail(409, 'Pesanan sudah berubah atau tidak siap dikirim. Muat ulang daftar.');
    const shipmentParams = orderApiParams(order, b.orderSn, b.packageNumber);
    const parameters = await ctx.api('/logistics/get_shipping_parameter', shipmentParams);
    const mode = shipmentInput(b, parameters);
    // A per-package lock also prevents double submission from different browser tabs.
    const lock = ctx.shop.collection('shipments').doc(crypto.createHash('sha256').update(JSON.stringify(shipmentParams)).digest('hex'));
    try { await lock.create({ operationId: b.operationId, status: 'submitted', createdAt: Date.now() }); }
    catch (e) { if (e.code === 6) fail(409, 'Paket ini sudah pernah diproses dashboard. Periksa status di Shopee.'); throw e; }
    await ctx.api('/logistics/ship_order', { ...shipmentParams, ...mode }, 'POST');
    await lock.update({ status: 'accepted' });
    return { ok: true, orderSn: b.orderSn };
  });
  if (path === '/shipping/document/create') return mutate(ctx, user, path, b, async () => {
    const order = await getOrder(ctx, b.orderSn, b.packageNumber);
    const documentParams = orderApiParams(order, b.orderSn, b.packageNumber);
    const p = await ctx.api('/logistics/get_shipping_document_parameter', { order_list: [documentParams] }, 'POST');
    const result = p.result_list?.[0];
    const selectable = result?.selectable_shipping_document_type || [];
    const requested = b.documentType;
    if (requested && !['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL'].includes(requested)) fail(400, 'Format resi tidak valid.');
    if (requested && selectable.length && !selectable.includes(requested) && result?.suggest_shipping_document_type !== requested) fail(409, 'Format resi tersebut tidak tersedia untuk paket ini.');
    const type = requested || result?.suggest_shipping_document_type || selectable[0];
    if (!type || !['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL'].includes(type)) fail(409, 'Format resi ini belum didukung. Gunakan Seller Centre.');
    const tracking = await ctx.api('/logistics/get_tracking_number', documentParams);
    if (!tracking.tracking_number) fail(409, 'Nomor resi belum tersedia. Tunggu setelah pengiriman diproses.');
    await ctx.api('/logistics/create_shipping_document', { order_list: [{ ...documentParams, tracking_number: tracking.tracking_number, shipping_document_type: type }] }, 'POST');
    return { ok: true, type };
  });
  if (path === '/shipping/document/download') {
    const order = await getOrder(ctx, b.orderSn, b.packageNumber);
    const documentParams = orderApiParams(order, b.orderSn, b.packageNumber);
    if (!['NORMAL_AIR_WAYBILL', 'THERMAL_AIR_WAYBILL'].includes(b.type)) fail(400, 'Format resi tidak valid.');
    const result = await ctx.api('/logistics/get_shipping_document_result', { order_list: [documentParams] }, 'POST');
    if (result.result_list?.[0]?.status !== 'READY') fail(409, 'Resi sedang disiapkan Shopee. Coba unduh lagi beberapa saat.');
    return ctx.api('/logistics/download_shipping_document', { shipping_document_type: b.type, order_list: [documentParams] }, 'POST', true);
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
    const user = await authenticateDashboardRequest(req, undefined, storeContext);
    if (path.startsWith('/accounting/')) return res.json(await require('./accounting.cjs').route(storeContext(), req, path, user, { shopContext }));
    if (path.startsWith('/marketplace/') || path.startsWith('/outbound/')) return res.json(await require('./marketplace-operations.cjs').route(storeContext(), req, path, user, { shopContext, listOrders, getOrder, orderApiParams }));
    if (path === '/analytics/business') {
      if (req.method !== 'GET') fail(405, 'Metode tidak didukung.');
      return res.json(await require('./business-analytics.cjs').report(req.query || {}, { shopContext }));
    }
    if (path.startsWith('/integrations/')) return res.json(await require('./business-integrations.cjs').route(storeContext(), req, path, user));
    if (path.startsWith('/master/mysql/')) return res.json(await require('./master-mysql.cjs').route(req, path, storeContext()));
    if (path === '/master' || path.startsWith('/master/')) return res.json(await require('./master-stock.cjs').route(storeContext(), req, path, user, shopContext));
    if (req.method === 'GET' && path === '/me') return res.json({ email: user.email, shopId: SHOP() });
    if (req.method === 'GET' && path === '/products') return res.json(await readProducts());
    if (req.method === 'POST' && path === '/products/sync') return res.json(await syncProducts());
    const context = path.startsWith('/scraper/') || path.startsWith('/market-intelligence/') ? storeContext() : await shopContext();
    const result = await route(context, path, req, user);
    if (Buffer.isBuffer(result)) return res.type('application/pdf').set('Content-Disposition', 'attachment; filename="resi.pdf"').send(result);
    return res.json(result);
  } catch (e) {
    if (e instanceof AuthError) return res.status(e.status).json({ error: e.message });
    if (e instanceof require('./accounting.cjs').AccountingError) return res.status(e.status).json({ error: e.message });
    if (e instanceof require('./marketplace-operations.cjs').OperationsError) return res.status(e.status).json({ error: e.message });
    if (e instanceof require('./business-analytics.cjs').AnalyticsError) return res.status(e.status).json({ error: e.message });
    if (e instanceof require('./business-integrations.cjs').IntegrationError) return res.status(e.status).json({ error: e.message });
    if (e instanceof require('./master-mysql.cjs').SourceError) return res.status(e.status).json({ error: e.message });
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
module.exports = { storeContext, checkDashboardConnection, handleDashboard, startDashboardSync, syncProducts, readProducts, shopContext, assertOwner, verifyDashboardUser, checkResult, shipmentInput, productRow, listOrders, route, ApiError, shopeeRejectError, __test: { dashboardBaseUrl, profitOrderDeductions, profitEscrowDetails } };
