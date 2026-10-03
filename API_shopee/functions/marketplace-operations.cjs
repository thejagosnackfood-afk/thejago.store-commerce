const crypto = require('node:crypto');
class OperationsError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new OperationsError(status, message); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const STAGES = ['unpaid', 'new', 'ready', 'processed', 'shipped', 'completed', 'cancelled', 'return', 'unknown'];
const STATUS_MAP = { UNPAID: 'unpaid', READY_TO_SHIP: 'ready', PROCESSED: 'processed', SHIPPED: 'shipped', TO_CONFIRM_RECEIVE: 'shipped', COMPLETED: 'completed', CANCELLED: 'cancelled', IN_CANCEL: 'cancelled', TO_RETURN: 'return' };
const RETURN_MAP = { REQUESTED: 'pending', ACCEPTED: 'pending', PROCESSING: 'pending', JUDGING: 'dispute', DISPUTE: 'dispute', REFUND_PAID: 'completed', CLOSED: 'completed', CANCELLED: 'cancelled' };
function string(value, label, max = 200) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail(400, `${label} tidak valid.`); return value.trim(); }
function safeImage(value) { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } }
function validItems(items) {
  if (!Array.isArray(items)) fail(502, 'Daftar barang tidak lengkap.');
  return items.map(item => {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) fail(502, 'Jumlah barang sumber tidak valid.');
    return { name: string(item.name, 'Nama barang', 500), sku: typeof item.sku === 'string' ? item.sku.slice(0, 120) : '', quantity: item.quantity, image: safeImage(item.image) };
  });
}
function orderRow(raw, source) {
  if (!raw || !STAGES.includes(raw.stage) || !Number.isSafeInteger(raw.createdAt) || raw.createdAt <= 0 || !Array.isArray(raw.packages)) fail(502, 'Data pesanan sumber tidak valid.');
  const row = { source, orderSn: string(raw.orderSn, 'Nomor pesanan'), storeId: string(raw.storeId, 'ID toko'), storeName: string(raw.storeName, 'Nama toko'), marketplace: string(raw.marketplace, 'Marketplace', 60), stage: raw.stage, status: String(raw.status || raw.stage).slice(0, 60), createdAt: raw.createdAt,
    carrier: typeof raw.carrier === 'string' ? raw.carrier.slice(0, 100) : '', totalAmount: typeof raw.totalAmount === 'number' && Number.isFinite(raw.totalAmount) && raw.totalAmount >= 0 ? raw.totalAmount : null, currency: /^[A-Z]{3}$/.test(raw.currency || '') ? raw.currency : 'IDR', items: validItems(raw.items),
    packages: raw.packages.map(p => ({ packageNumber: typeof p.packageNumber === 'string' ? p.packageNumber.slice(0, 200) : '', trackingNumber: typeof p.trackingNumber === 'string' ? p.trackingNumber.slice(0, 200) : '', labelReady: p.labelReady === true })),
  };
  if (!row.packages.length) row.packages.push({ packageNumber: '', trackingNumber: '', labelReady: false });
  if (new Set(row.packages.map(p => p.packageNumber)).size !== row.packages.length) fail(502, 'Identitas paket sumber berulang.');
  return row;
}
function shopeeRow(raw, env) {
  return orderRow({ orderSn: raw.orderSn || raw.order_sn, storeId: String(env.SHOPEE_DASHBOARD_SHOP_ID), storeName: env.SHOPEE_DASHBOARD_SHOP_NAME || `Toko Shopee ${env.SHOPEE_DASHBOARD_SHOP_ID}`, marketplace: 'Shopee', stage: STATUS_MAP[raw.status || raw.order_status] || 'unknown', status: raw.status || raw.order_status,
    createdAt: (raw.createdAt || raw.create_time) * 1000, carrier: raw.carrier || raw.shipping_carrier, currency: raw.currency || 'IDR', totalAmount: raw.totalAmount ?? raw.total_amount,
    packages: (raw.packages || raw.package_list || []).map(p => ({ packageNumber: p.package_number, trackingNumber: p.tracking_number || '' })),
    items: raw.items || (raw.item_list || []).map(item => ({ name: item.item_name, sku: item.model_sku || item.item_sku || '', quantity: item.model_quantity_purchased, image: item.image_info?.image_url })),
  }, 'shopee');
}
function createService(dependencies) {
  const env = dependencies.env || process.env;
  const desty = Boolean(env.DESTY_OPERATIONS_URL || env.DESTY_OPERATIONS_API_KEY);
  const kind = desty ? 'desty' : 'shopee';
  const source = { kind, name: desty ? 'the jago' : 'Shopee langsung', scope: desty ? 'Toko yang diberikan konektor the jago.' : 'Hanya toko Shopee dashboard. Marketplace lain memerlukan konektor the jago.' };
  let context;
  const shop = () => context ||= dependencies.shopContext();
  async function gateway(operation, body = {}) {
    let url;
    try { url = new URL(env.DESTY_OPERATIONS_URL); } catch { fail(503, 'URL konektor operasional the jago belum valid.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !env.DESTY_OPERATIONS_API_KEY) fail(503, 'Konektor operasional the jago belum lengkap.');
    try {
      const response = await (dependencies.fetch || fetch)(url.href, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${env.DESTY_OPERATIONS_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, ...body }) });
      if (!response.ok) throw new Error('upstream');
      return await response.json();
    } catch { fail(502, 'Data operasional the jago belum dapat diambil. Periksa konektor dan coba lagi.'); }
  }
  async function list(cursor = '') {
    const value = String(cursor).slice(0, 1000);
    const result = desty ? await gateway('list_orders', { cursor: value }) : await dependencies.listOrders(await shop(), value);
    if (!Array.isArray(result.orders) || typeof result.hasNextPage !== 'boolean' || (result.hasNextPage && (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor === value))) fail(502, 'Daftar atau paginasi pesanan tidak lengkap.');
    if (result.orders.length > 100) fail(502, 'Halaman pesanan melebihi batas.');
    return { source, orders: result.orders.map(row => desty ? orderRow(row, kind) : shopeeRow(row, env)), hasNextPage: result.hasNextPage, nextCursor: result.hasNextPage ? result.nextCursor : '' };
  }
  async function packageDetail(input) {
    const orderSn = string(input.orderSn, 'Nomor pesanan'), storeId = string(input.storeId, 'ID toko');
    const packageNumber = input.packageNumber ? string(input.packageNumber, 'Nomor paket') : '';
    let order;
    if (desty) {
      const result = await gateway('get_order', { orderSn, storeId });
      order = orderRow(result.order, kind);
    } else {
      if (storeId !== String(env.SHOPEE_DASHBOARD_SHOP_ID)) fail(404, 'Toko tidak ditemukan.');
      const ctx = await shop();
      const raw = await dependencies.getOrder(ctx, orderSn, packageNumber);
      order = shopeeRow(raw, env);
      const params = dependencies.orderApiParams(raw, orderSn, packageNumber);
      const tracking = await ctx.api('/logistics/get_tracking_number', params);
      const document = await ctx.api('/logistics/get_shipping_document_result', { order_list: [params] }, 'POST');
      const selected = order.packages.find(p => p.packageNumber === packageNumber) || (order.packages.length === 1 ? order.packages[0] : null);
      if (selected) { selected.trackingNumber = tracking.tracking_number || ''; selected.labelReady = document.result_list?.[0]?.status === 'READY'; }
    }
    if (order.orderSn !== orderSn || order.storeId !== storeId) fail(502, 'Identitas pesanan sumber tidak cocok.');
    const selected = order.packages.find(p => p.packageNumber === packageNumber) || (!packageNumber && order.packages.length === 1 ? order.packages[0] : null);
    if (!selected) fail(400, 'Pilih paket yang sesuai dengan pesanan.');
    if (order.stage !== 'processed' || !selected.labelReady || !selected.trackingNumber) fail(409, 'Paket harus terproses, memiliki resi siap cetak, dan belum dikirim.');
    return { source: kind, storeId, storeName: order.storeName, marketplace: order.marketplace, orderSn, packageNumber: selected.packageNumber, trackingNumber: selected.trackingNumber, carrier: order.carrier };
  }
  async function returns(cursor = '') {
    if (desty) {
      const data = await gateway('list_returns', { cursor: String(cursor).slice(0, 1000) });
      if (!Array.isArray(data.returns) || data.returns.length > 100 || typeof data.hasNextPage !== 'boolean' || (data.hasNextPage && (!data.nextCursor || data.nextCursor === cursor))) fail(502, 'Daftar pengembalian the jago tidak lengkap.');
      return { source, returns: data.returns.map(returnRow), hasNextPage: data.hasNextPage, nextCursor: data.hasNextPage ? String(data.nextCursor) : '' };
    }
    const page = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(page) || page < 0 || page > 10000) fail(400, 'Halaman pengembalian tidak valid.');
    const end = Math.floor(Date.now() / 1000);
    const data = await (await shop()).api('/returns/get_return_list', { page_no: page, page_size: 40, create_time_from: end - 14 * 86400, create_time_to: end });
    if (!Array.isArray(data.return) || typeof data.more !== 'boolean') fail(502, 'Daftar pengembalian Shopee tidak lengkap.');
    return { source, hasNextPage: data.more, nextCursor: data.more ? String(page + 1) : '', returns: data.return.map(row => returnRow({
      returnSn: row.return_sn, orderSn: row.order_sn, storeId: String(env.SHOPEE_DASHBOARD_SHOP_ID), storeName: env.SHOPEE_DASHBOARD_SHOP_NAME || `Toko Shopee ${env.SHOPEE_DASHBOARD_SHOP_ID}`, marketplace: 'Shopee',
      stage: RETURN_MAP[row.status] || 'unknown', status: row.status, type: row.return_solution === 0 ? 'return_refund' : row.return_solution === 1 ? 'refund' : 'unknown',
      createdAt: row.create_time * 1000, amount: row.refund_amount, currency: row.currency || 'IDR', reason: row.text_reason || row.reason || '',
      items: (row.item || []).map(item => ({ name: item.name, quantity: item.amount, sku: item.variation_sku || item.item_sku || '', image: item.images?.[0] })),
    })) };
  }
  return { source, list, packageDetail, returns };
}
function returnRow(raw) {
  if (!raw || !['pending', 'dispute', 'completed', 'cancelled', 'unknown'].includes(raw.stage) || !['refund', 'replacement', 'return_refund', 'unknown'].includes(raw.type) || !Number.isSafeInteger(raw.createdAt) || raw.createdAt <= 0 || (raw.amount !== null && (typeof raw.amount !== 'number' || !Number.isFinite(raw.amount) || raw.amount < 0))) fail(502, 'Data pengembalian tidak valid.');
  return { returnSn: string(raw.returnSn, 'Nomor pengembalian'), orderSn: string(raw.orderSn, 'Nomor pesanan'), storeId: string(raw.storeId, 'ID toko'), storeName: string(raw.storeName, 'Nama toko'), marketplace: string(raw.marketplace, 'Marketplace', 60), stage: raw.stage, status: String(raw.status || '').slice(0, 60), type: raw.type, createdAt: raw.createdAt, amount: raw.amount,
    currency: /^[A-Z]{3}$/.test(raw.currency || '') ? raw.currency : 'IDR', reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 1000) : '', items: validItems(raw.items) };
}
const packageKey = item => hash([item.source, item.storeId, item.orderSn, item.packageNumber]);
async function registerPackage(ctx, item) {
  const key = packageKey(item);
  const codes = [...new Set([item.orderSn, item.packageNumber, item.trackingNumber].filter(Boolean))];
  await ctx.shop.collection('outboundPackages').doc(key).set({ ...item, key, codes, preparedAt: Date.now() });
  return { ...item, key };
}
async function saveScan(ctx, user, service, body) {
  if (body.confirm !== true || typeof body.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.operationId)) fail(400, 'Konfirmasi dan ID laporan diperlukan.');
  if (!Array.isArray(body.packages) || !body.packages.length || body.packages.length > 30) fail(400, 'Simpan 1-30 paket per laporan.');
  const requested = body.packages.map(item => ({ storeId: string(item.storeId, 'ID toko'), orderSn: string(item.orderSn, 'Nomor pesanan'), packageNumber: item.packageNumber ? string(item.packageNumber, 'Nomor paket') : '' }));
  const fingerprint = hash([service.source.kind, requested]);
  const reportRef = ctx.shop.collection('outboundScanReports').doc(body.operationId);
  const existing = await reportRef.get();
  if (existing.exists) { if (existing.data().fingerprint !== fingerprint) fail(409, 'ID laporan sudah dipakai untuk paket berbeda.'); return publicReport(body.operationId, existing.data()); }
  const packages = []; const deadline = Date.now() + 40000;
  for (const input of requested) {
    if (Date.now() > deadline) fail(422, 'Verifikasi terlalu lama. Simpan lebih sedikit paket sekaligus.');
    const item = await service.packageDetail(input); packages.push({ ...item, key: packageKey(item) });
  }
  if (new Set(packages.map(item => item.key)).size !== packages.length) fail(409, 'Paket duplikat ditemukan dalam laporan.');
  const refs = packages.map(item => ctx.shop.collection('outboundScannedPackages').doc(item.key));
  return ctx.db.runTransaction(async tx => {
    const previous = await tx.get(reportRef);
    if (previous.exists) { if (previous.data().fingerprint !== fingerprint) fail(409, 'ID laporan sudah dipakai.'); return publicReport(body.operationId, previous.data()); }
    const states = await Promise.all(refs.map(ref => tx.get(ref)));
    if (states.some(snapshot => snapshot.exists)) fail(409, 'Ada paket yang sudah disimpan pada laporan barang keluar. Muat ulang daftar.');
    const createdAt = Date.now();
    const report = { fingerprint, packages, createdAt, createdBy: user.uid, number: `SCAN-${new Date(createdAt).toISOString().slice(0, 10).replaceAll('-', '')}-${body.operationId.slice(0, 8).toUpperCase()}` };
    refs.forEach((ref, index) => tx.create(ref, { reportId: body.operationId, scannedAt: createdAt, orderSn: packages[index].orderSn }));
    tx.create(reportRef, report);
    return publicReport(body.operationId, report);
  });
}
function publicReport(id, data) { return { id, number: data.number, createdAt: data.createdAt, packages: data.packages }; }
async function route(ctx, req, path, user, dependencies) {
  const service = createService(dependencies), body = req.body || {}, query = req.query || {};
  if (path === '/marketplace/orders' && req.method === 'GET') {
    const result = await service.list(query.cursor);
    for (const order of result.orders) {
      for (const item of order.packages) {
        const key = packageKey({ ...order, ...item });
        const saved = await ctx.shop.collection('outboundScannedPackages').doc(key).get();
        item.scannedAt = saved.exists ? saved.data().scannedAt : null;
      }
    }
    return result;
  }
  if (path === '/marketplace/returns' && req.method === 'GET') return service.returns(query.cursor);
  if (path === '/outbound/reports' && req.method === 'GET') {
    const result = await ctx.shop.collection('outboundScanReports').orderBy('createdAt', 'desc').limit(20).get();
    return { reports: result.docs.map(doc => publicReport(doc.id, doc.data())) };
  }
  if (path === '/outbound/prepare' && req.method === 'POST') return registerPackage(ctx, await service.packageDetail(body));
  if (path === '/outbound/resolve' && req.method === 'POST') {
    const code = string(body.code, 'Barcode', 200);
    const candidates = await ctx.shop.collection('outboundPackages').where('codes', 'array-contains', code).limit(20).get();
    const matches = candidates.docs.map(doc => doc.data()).filter(item => item.source === service.source.kind);
    if (!matches.length) fail(404, 'Barcode belum dikenali. Klik Siapkan scan pada pesanan terproses terlebih dahulu.');
    if (matches.length !== 1) fail(409, 'Barcode cocok dengan beberapa paket. Scan nomor resi atau paket yang unik.');
    const fresh = await service.packageDetail(matches[0]);
    if (![fresh.orderSn, fresh.packageNumber, fresh.trackingNumber].includes(code)) fail(409, 'Barcode paket berubah. Siapkan scan ulang.');
    const key = packageKey(fresh);
    if ((await ctx.shop.collection('outboundScannedPackages').doc(key).get()).exists) fail(409, 'Paket ini sudah tercatat sebagai barang keluar dan tidak dapat discan kembali.');
    return { ...fresh, key };
  }
  if (path === '/outbound/save' && req.method === 'POST') return saveScan(ctx, user, service, body);
  fail(405, 'Operasi tidak didukung.');
}
module.exports = { route, saveScan, packageKey, createService, OperationsError, orderRow, returnRow };
