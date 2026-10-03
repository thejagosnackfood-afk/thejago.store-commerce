const crypto = require('node:crypto');
const { PAGE_SIZE, pageNumber, normalizeRows } = require('./mysql-master/protocol.cjs');
async function metadata(ctx, snapshotId) {
  if (snapshotId && !/^[a-f0-9]{32}$/.test(snapshotId)) throw new Error('Snapshot tidak valid.');
  const ref = snapshotId ? ctx.shop.collection('mysqlMasterCatalog').doc(snapshotId) : ctx.shop.collection('mysqlMasterState').doc('current');
  return (await ref.get()).data() || null;
}
async function readSnapshot(ctx, page, snapshotId) {
  page = pageNumber(page);
  const meta = await metadata(ctx, snapshotId);
  if (!meta) return null;
  if (!/^[a-f0-9]{32}$/.test(meta.snapshotId) || !Number.isSafeInteger(meta.count) || meta.count < 1) throw new Error('Snapshot tidak lengkap.');
  const data = (await ctx.shop.collection('mysqlMasterCatalog').doc(meta.snapshotId).collection('pages').doc(String(page)).get()).data();
  if (!data && page * PAGE_SIZE < meta.count) throw new Error('Halaman snapshot belum tersedia.');
  return { rows: normalizeRows(data?.rows || []), page, hasMore: (page + 1) * PAGE_SIZE < meta.count, fetchedAt: meta.fetchedAt, source: 'mysql', readOnly: true, mode: 'snapshot', snapshotId: meta.snapshotId, count: meta.count, skuColumn: 'kode_barcode', stockBasis: 'toko + gudang' };
}
async function publishSnapshot(ctx, rows, fetchedAt, fingerprint = null) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100000 || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('Snapshot kosong/tidak valid.');
  const seen = new Set(), pages = [];
  for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
    const page = normalizeRows(rows.slice(offset, offset + PAGE_SIZE));
    for (const row of page) { if (seen.has(row.sku)) throw new Error('Barcode ganda pada snapshot.'); seen.add(row.sku); }
    pages.push(page);
  }
  const snapshotId = crypto.randomBytes(16).toString('hex');
  const generation = ctx.shop.collection('mysqlMasterCatalog').doc(snapshotId);
  // All pages must be durable before the current pointer becomes visible.
  for (let i = 0; i < pages.length; i++) await generation.collection('pages').doc(String(i)).set({ rows: pages[i] });
  const meta = { snapshotId, count: rows.length, fetchedAt, publishedAt: new Date().toISOString(), source: 'mysql', skuColumn: 'kode_barcode', stockBasis: 'toko + gudang', ...(fingerprint ? { fingerprint } : {}) };
  await generation.set(meta);
  await ctx.shop.collection('mysqlMasterState').doc('current').set(meta);
  return meta;
}
module.exports = { metadata, readSnapshot, publishSnapshot };
