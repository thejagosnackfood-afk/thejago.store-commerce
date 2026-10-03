const DAY = 86400000;
const WIB = 7 * 3600000;
const INCLUDED = new Set(['paid', 'processing', 'shipped', 'completed']);
const STATUSES = new Set([...INCLUDED, 'cancelled', 'unpaid', 'refunded']);
class AnalyticsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new AnalyticsError(status, message); }
function dayLabel(time) { return new Date(time + WIB).toISOString().slice(0, 10); }
function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, 'Tanggal harus berformat YYYY-MM-DD.');
  const time = Date.parse(`${value}T00:00:00+07:00`);
  if (!Number.isFinite(time) || dayLabel(time) !== value) fail(400, 'Tanggal tidak valid.');
  return time;
}
function period(query, now = Date.now()) {
  const from = parseDay(query.from), end = parseDay(query.to);
  if (end < from || end - from >= 31 * DAY || end > parseDay(dayLabel(now))) fail(400, 'Pilih periode 1-31 hari, paling akhir hari ini (WIB).');
  return { from: query.from, to: query.to, fromTime: from, toTime: end + DAY, timezone: 'Asia/Jakarta' };
}
function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(502, `${label} sumber tidak valid.`);
  return value.trim();
}
function amount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) fail(502, 'Nilai penjualan sumber tidak valid.');
  return Math.round(value * 100);
}
function sum(a, b) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) fail(502, 'Total data melebihi batas perhitungan.');
  return result;
}
function imageUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function normalize(data) {
  if (!Array.isArray(data.stores) || !Array.isArray(data.orders) || data.orders.length > 50000) fail(502, 'Data analisis sumber tidak lengkap.');
  const stores = new Map();
  for (const raw of data.stores) {
    const store = { id: text(raw.id, 'ID toko'), name: text(raw.name, 'Nama toko'), marketplace: text(raw.marketplace, 'Marketplace', 60), currency: text(raw.currency, 'Mata uang', 3).toUpperCase(), connected: raw.connected };
    if (!/^[A-Z]{3}$/.test(store.currency) || typeof store.connected !== 'boolean') fail(502, 'Identitas toko sumber tidak valid.');
    if (stores.has(store.id) && JSON.stringify(stores.get(store.id)) !== JSON.stringify(store)) fail(502, 'Identitas toko sumber tidak konsisten.');
    stores.set(store.id, store);
  }
  const orders = new Map();
  for (const raw of data.orders) {
    const id = text(raw.id, 'ID pesanan'), storeId = text(raw.storeId, 'ID toko');
    const store = stores.get(storeId);
    if (!store) fail(502, 'Pesanan merujuk toko yang tidak dikenal.');
    if (!STATUSES.has(raw.status) || typeof raw.createdAt !== 'number' || !Number.isSafeInteger(raw.createdAt) || raw.createdAt <= 0 || raw.createdAt > 8640000000000000) fail(502, 'Status atau waktu pesanan sumber tidak valid.');
    if (raw.currency !== store.currency) fail(502, 'Mata uang pesanan berbeda dari toko.');
    const included = INCLUDED.has(raw.status);
    if (included && (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 1000)) fail(502, 'Rincian produk pesanan belum lengkap.');
    const items = included ? raw.items.map(item => {
      if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 1e7) fail(502, 'Kuantitas produk sumber tidak valid.');
      return { productId: text(item.productId, 'ID produk'), name: text(item.name, 'Nama produk', 500), sku: typeof item.sku === 'string' ? item.sku.slice(0, 120) : '', quantity: item.quantity, imageUrl: imageUrl(item.imageUrl) };
    }) : [];
    const order = { id, storeId, status: raw.status, createdAt: raw.createdAt, currency: raw.currency, salesMinor: included ? amount(raw.totalAmount) : 0, items };
    const key = JSON.stringify([storeId, id]);
    if (orders.has(key) && JSON.stringify(orders.get(key)) !== JSON.stringify(order)) fail(502, 'Versi pesanan sumber berbeda. Perbarui laporan.');
    orders.set(key, order);
  }
  return { stores: [...stores.values()], orders: [...orders.values()] };
}
function aggregate(raw, range, filters = {}) {
  const data = normalize(raw);
  const allStores = data.stores.filter(store => store.connected);
  const marketplaces = [...new Set(allStores.map(store => store.marketplace))].sort();
  const currencies = [...new Set(allStores.map(store => store.currency))].sort();
  const currency = typeof filters.currency === 'string' && filters.currency ? filters.currency : currencies.includes('IDR') ? 'IDR' : currencies[0] || 'IDR';
  const marketplace = typeof filters.marketplace === 'string' ? filters.marketplace : '';
  const storeId = typeof filters.storeId === 'string' ? filters.storeId : '';
  if (currencies.length && !currencies.includes(currency)) fail(400, 'Mata uang tidak tersedia pada toko terhubung.');
  if (marketplace && !marketplaces.includes(marketplace)) fail(400, 'Marketplace tidak tersedia pada sumber ini.');
  if (storeId && !allStores.some(store => store.id === storeId && (!marketplace || store.marketplace === marketplace))) fail(400, 'Toko tidak sesuai dengan filter marketplace.');
  const stores = allStores.filter(store => store.currency === currency && (!marketplace || store.marketplace === marketplace) && (!storeId || store.id === storeId));
  const byStore = new Map(stores.map(store => [store.id, { ...store, salesMinor: 0, orders: 0, units: 0 }]));
  const daily = new Map();
  for (let time = range.fromTime; time < range.toTime; time += DAY) daily.set(dayLabel(time), { date: dayLabel(time), salesMinor: 0, orders: 0, units: 0 });
  const products = new Map();
  let salesMinor = 0, orderCount = 0, units = 0, excludedOrders = 0;
  for (const order of data.orders) {
    const store = byStore.get(order.storeId);
    if (!store || order.createdAt < range.fromTime || order.createdAt >= range.toTime) continue;
    if (!INCLUDED.has(order.status)) { excludedOrders++; continue; }
    const day = daily.get(dayLabel(order.createdAt));
    salesMinor = sum(salesMinor, order.salesMinor); orderCount++;
    store.salesMinor = sum(store.salesMinor, order.salesMinor); store.orders++;
    day.salesMinor = sum(day.salesMinor, order.salesMinor); day.orders++;
    const seenProducts = new Set();
    for (const item of order.items) {
      units = sum(units, item.quantity); store.units = sum(store.units, item.quantity); day.units = sum(day.units, item.quantity);
      // Product identity stays scoped to its store; equal names/SKUs across stores are not mappings.
      const key = JSON.stringify([store.id, item.productId]);
      const product = products.get(key) || { key, productId: item.productId, name: item.name, sku: item.sku, imageUrl: item.imageUrl, storeId: store.id, storeName: store.name, marketplace: store.marketplace, quantity: 0, orders: 0 };
      product.quantity = sum(product.quantity, item.quantity);
      if (!seenProducts.has(key)) { product.orders++; seenProducts.add(key); }
      products.set(key, product);
    }
  }
  return {
    period: { from: range.from, to: range.to, timezone: range.timezone }, filters: { marketplace, storeId, currency },
    options: { stores: allStores, marketplaces, currencies },
    totals: { sales: salesMinor / 100, orders: orderCount, units, averageOrderValue: orderCount ? salesMinor / 100 / orderCount : 0, stores: stores.length, excludedOrders },
    daily: [...daily.values()].map(({ salesMinor, ...row }) => ({ ...row, sales: salesMinor / 100 })),
    stores: [...byStore.values()].sort((a, b) => b.salesMinor - a.salesMinor || a.id.localeCompare(b.id)).map(({ salesMinor, ...row }) => ({ ...row, sales: salesMinor / 100 })),
    topProducts: [...products.values()].sort((a, b) => b.quantity - a.quantity || b.orders - a.orders || a.key.localeCompare(b.key)).slice(0, 10),
    productCount: products.size,
  };
}
async function destyData(range, env, fetcher) {
  let url;
  try { url = new URL(env.DESTY_ANALYTICS_URL); } catch { fail(503, 'URL konektor analisis the jago belum valid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !env.DESTY_ANALYTICS_API_KEY) fail(503, 'Konfigurasi konektor analisis the jago belum lengkap.');
  const stores = [], orders = [], seen = new Set();
  let cursor = '', snapshotId = null, syncedAt = null;
  const signal = AbortSignal.timeout(45000);
  for (let page = 0; page < 100; page++) {
    let data;
    try {
      const response = await fetcher(url.href, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${env.DESTY_ANALYTICS_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'business_analytics', from: new Date(range.fromTime).toISOString(), toExclusive: new Date(range.toTime).toISOString(), timezone: range.timezone, cursor }) });
      if (!response.ok) throw new Error('upstream');
      data = await response.json();
    } catch { fail(502, 'Data the jago belum dapat diambil. Periksa konektor lalu coba lagi; laporan parsial tidak ditampilkan.'); }
    if (!data || !Array.isArray(data.stores) || !Array.isArray(data.orders) || typeof data.snapshotId !== 'string' || !data.snapshotId || !Number.isSafeInteger(data.syncedAt) || data.syncedAt <= 0 || data.syncedAt > Date.now() + 60000) fail(502, 'Respons analisis the jago tidak lengkap.');
    if (snapshotId !== null && (snapshotId !== data.snapshotId || syncedAt !== data.syncedAt)) fail(502, 'Snapshot the jago berubah saat dimuat. Coba perbarui laporan.');
    snapshotId = data.snapshotId; syncedAt = data.syncedAt;
    stores.push(...data.stores); orders.push(...data.orders);
    if (orders.length > 50000 || stores.length > 10000) fail(422, 'Data terlalu besar. Pilih periode lebih pendek.');
    if (data.nextCursor === null) {
      if (data.complete !== true) fail(502, 'Konektor the jago belum menyelesaikan semua halaman data.');
      return { stores, orders, syncedAt };
    }
    if (typeof data.nextCursor !== 'string' || !data.nextCursor || data.nextCursor.length > 1000 || seen.has(data.nextCursor)) fail(502, 'Paginasi analisis the jago tidak valid.');
    seen.add(data.nextCursor); cursor = data.nextCursor;
  }
  fail(422, 'Data terlalu besar. Pilih periode lebih pendek.');
}
async function shopeeData(range, context, env, now) {
  const ctx = await context();
  const storeId = String(env.SHOPEE_DASHBOARD_SHOP_ID || '');
  if (!storeId) fail(503, 'Toko Shopee belum dikonfigurasi.');
  const ids = new Set(); let calls = 0;
  const deadline = Date.now() + 45000;
  function budget() { if (++calls > 200 || Date.now() > deadline) fail(422, 'Pengambilan data terlalu besar. Pilih periode lebih pendek.'); }
  // Shopee limits order-list time windows. Read every page in non-overlapping 14-day slices.
  const end = Math.min(range.toTime, now + 1000);
  for (let start = range.fromTime; start < end; start += 14 * DAY) {
    const stop = Math.min(start + 14 * DAY, end); let cursor = ''; const seen = new Set();
    for (;;) {
      budget();
      const data = await ctx.api('/order/get_order_list', { time_range_field: 'create_time', time_from: Math.floor(start / 1000), time_to: Math.floor(stop / 1000) - 1, page_size: 100, cursor });
      if (!Array.isArray(data.order_list) || typeof data.more !== 'boolean') fail(502, 'Daftar pesanan Shopee belum lengkap.');
      for (const order of data.order_list) ids.add(text(order.order_sn, 'ID pesanan'));
      if (!data.more) break;
      if (typeof data.next_cursor !== 'string' || !data.next_cursor || seen.has(data.next_cursor)) fail(502, 'Paginasi pesanan Shopee tidak valid.');
      seen.add(data.next_cursor); cursor = data.next_cursor;
    }
  }
  const orders = [], list = [...ids]; let currency = null;
  const mapping = { UNPAID: 'unpaid', READY_TO_SHIP: 'paid', PROCESSED: 'processing', SHIPPED: 'shipped', TO_CONFIRM_RECEIVE: 'shipped', COMPLETED: 'completed', IN_CANCEL: 'cancelled', CANCELLED: 'cancelled', TO_RETURN: 'refunded' };
  for (let offset = 0; offset < list.length; offset += 50) {
    budget(); const batch = list.slice(offset, offset + 50);
    const details = await ctx.api('/order/get_order_detail', { order_sn_list: batch.join(','), response_optional_fields: 'item_list,total_amount' });
    if (!Array.isArray(details.order_list) || details.order_list.length !== batch.length || new Set(details.order_list.map(order => order.order_sn)).size !== batch.length || details.order_list.some(order => !batch.includes(order.order_sn))) fail(502, 'Rincian pesanan Shopee belum lengkap.');
    for (const order of details.order_list) {
      if (currency && order.currency !== currency) fail(502, 'Mata uang toko Shopee tidak konsisten.');
      currency = order.currency;
      if (!mapping[order.order_status]) fail(502, `Status pesanan Shopee belum didukung: ${String(order.order_status).slice(0, 40)}.`);
      orders.push({ id: order.order_sn, storeId, createdAt: order.create_time * 1000, status: mapping[order.order_status], currency: order.currency, totalAmount: order.total_amount,
        items: Array.isArray(order.item_list) ? order.item_list.map(item => ({ productId: String(item.item_id), name: item.item_name, sku: item.item_sku || item.model_sku || '', quantity: item.model_quantity_purchased, imageUrl: item.image_info?.image_url || item.item_image?.image_url })) : null });
    }
  }
  return { stores: [{ id: storeId, name: env.SHOPEE_DASHBOARD_SHOP_NAME || `Toko Shopee ${storeId}`, marketplace: 'Shopee', currency: currency || 'IDR', connected: true }], orders, syncedAt: Date.now() };
}
async function report(query, dependencies = {}) {
  const env = dependencies.env || process.env;
  const now = dependencies.now || Date.now();
  const range = period(query, now);
  const useDesty = Boolean(env.DESTY_ANALYTICS_URL || env.DESTY_ANALYTICS_API_KEY);
  const data = useDesty ? await destyData(range, env, dependencies.fetch || fetch) : await shopeeData(range, dependencies.shopContext, env, now);
  return { ...aggregate(data, range, query), source: { kind: useDesty ? 'desty' : 'shopee', name: useDesty ? 'the jago' : 'Shopee langsung', scope: useDesty ? 'Semua toko terhubung yang disediakan konektor the jago.' : 'Hanya toko Shopee dashboard. Konektor analisis the jago belum dikonfigurasi.', syncedAt: data.syncedAt },
    definition: 'Total penjualan memakai nilai total pesanan dari sumber, termasuk ongkir pembeli bila disertakan sumber; bukan laba atau pencairan bersih. Pesanan belum dibayar, dibatalkan, dan dikembalikan penuh dikecualikan. Retur sebagian belum direkonsiliasi. Periode mengikuti tanggal pesanan dibuat (WIB).' };
}
module.exports = { report, aggregate, period, AnalyticsError };
