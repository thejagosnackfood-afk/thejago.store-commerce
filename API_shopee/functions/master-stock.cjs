const crypto = require('node:crypto');
class MasterError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new MasterError(status, message); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stockNumber = n => { if (!Number.isSafeInteger(n) || n < 0 || n > 2147483647) fail(400, 'Stok harus bilangan bulat 0–2147483647.'); return n; };
const idNumber = n => { if (!Number.isSafeInteger(n) || n < 0) fail(400, 'ID produk/variasi tidak valid.'); return n; };
function parseStockCsv(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 300000) fail(400, 'CSV maksimal 300 KB.');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted) { quoted = false; closed = true; }
      else if (!cell && !closed) quoted = true;
      else fail(400, 'Format kutip CSV tidak valid.');
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(cell); cell = ''; closed = false;
      if (c !== ',') { if (c === '\r' && text[i + 1] === '\n') i++; if (row.some(Boolean)) rows.push(row); row = []; }
    } else { if (closed) fail(400, 'Karakter setelah kutip CSV tidak valid.'); cell += c; }
  }
  if (quoted) fail(400, 'Tanda kutip CSV tidak lengkap.');
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  const header = rows.shift() || [];
  if (header.length !== 3 || header[0] !== 'Master SKU' || header[1] !== 'Stok' || header[2] !== 'Versi') fail(400, 'Gunakan kolom persis: Master SKU,Stok,Versi. Unduh template terbaru terlebih dahulu.');
  if (!rows.length || rows.length > 100) fail(400, 'Impor harus berisi 1–100 baris.');
  const seen = new Set();
  return rows.map((r, i) => {
    if (r.length !== 3 || !r[0] || !/^\d+$/.test(r[1]) || !/^\d+$/.test(r[2])) fail(400, `Baris ${i + 2}: SKU, stok atau versi tidak valid.`);
    if (seen.has(r[0])) fail(400, `Master SKU ganda pada baris ${i + 2}.`);
    seen.add(r[0]); const version = Number(r[2]); if (!Number.isSafeInteger(version) || version < 1) fail(400, `Versi baris ${i + 2} tidak valid.`);
    return { id: hash(r[0]), sku: r[0], stock: stockNumber(Number(r[1])), version };
  });
}
function candidates(item, models) {
  const units = item.has_model ? models : [{ model_id: 0, model_name: '', model_sku: item.item_sku, stock_info_v2: item.stock_info_v2 }];
  return units.flatMap(m => (m.stock_info_v2?.seller_stock || []).filter(s => Number.isSafeInteger(s.stock) && s.stock >= 0).map(s => ({ itemId: item.item_id, modelId: m.model_id, locationId: String(s.location_id || ''), name: item.item_name, variant: m.model_name || '', shopSku: m.model_sku || item.item_sku || '', stock: s.stock })));
}
async function options(ctx, itemId) {
  idNumber(itemId); if (!itemId) fail(400, 'Pilih produk.');
  const base = await ctx.api('/product/get_item_base_info', { item_id_list: itemId });
  const item = base.item_list?.find(x => x.item_id === itemId); if (!item) fail(404, 'Produk tidak ditemukan di toko ini.');
  const models = item.has_model ? (await ctx.api('/product/get_model_list', { item_id: itemId })).model || [] : [];
  return candidates(item, models);
}
function mappingKey(row) { return hash(`${row.itemId}:${row.modelId}:${row.locationId}`); }
async function liveMapping(ctx, row) {
  const match = (await options(ctx, row.itemId)).find(x => x.modelId === row.modelId && x.locationId === row.locationId);
  if (!match) fail(409, 'Pemetaan produk/variasi/gudang tidak lagi tersedia.');
  return match;
}
function validateChange(row, stock, version) {
  stockNumber(stock);
  if (!row || row.version !== version) fail(409, 'Versi stok berubah. Muat ulang atau unduh template CSV terbaru.');
  if (['queued', 'processing', 'review'].includes(row.status)) fail(409, 'SKU masih dalam antrean atau perlu ditinjau. Selesaikan proses sebelumnya dahulu.');
  if (!Number.isFinite(row.observedAt) || row.observedAt < Date.now() - 10 * 60000) fail(409, 'Data stok terlalu lama. Klik Periksa stok Shopee sebelum mengubah stok.');
}
async function list(ctx) {
  const rows = (await ctx.shop.collection('masterProducts').get()).docs.map(d => ({ id: d.id, ...d.data() }));
  const imports = (await ctx.shop.collection('stockImports').orderBy('createdAt', 'desc').limit(15).get()).docs.map(d => { const { csv, changes, ...data } = d.data(); return { id: d.id, ...data }; });
  const worker = (await ctx.shop.collection('stockControl').doc('worker').get()).data() || {};
  return { rows, imports, worker: { lastRunAt: worker.lastRunAt || null, lastError: worker.lastError || null }, intervalSeconds: 60 };
}
async function create(ctx, user, b) {
  if (b.confirm !== true) fail(400, 'Konfirmasi pemetaan diperlukan.');
  const sku = typeof b.sku === 'string' ? b.sku.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(sku)) fail(400, 'Master SKU: 1–80 huruf, angka, titik, garis bawah atau tanda hubung.');
  const row = await liveMapping(ctx, { itemId: idNumber(b.itemId), modelId: idNumber(b.modelId), locationId: String(b.locationId || '') });
  const id = hash(sku), ref = ctx.shop.collection('masterProducts').doc(id), map = ctx.shop.collection('masterMappings').doc(mappingKey(row));
  await ctx.db.runTransaction(async tx => {
    const [existing, mapped] = await Promise.all([tx.get(ref), tx.get(map)]);
    if (existing.exists || mapped.exists) fail(409, 'Master SKU atau pemetaan Shopee sudah terdaftar.');
    tx.create(ref, { ...row, sku, stock: row.stock, observedStock: row.stock, observedAt: Date.now(), version: 1, status: 'synced', source: 'shopee', createdAt: Date.now(), updatedAt: Date.now(), createdBy: user.uid });
    tx.create(map, { masterId: id });
  });
  return { ok: true, id };
}
async function observe(ctx, id, expectedVersion, resolve = false) {
  if (!/^[a-f0-9]{64}$/.test(id || '')) fail(400, 'Master SKU tidak valid.');
  const ref = ctx.shop.collection('masterProducts').doc(id); const snap = await ref.get(); if (!snap.exists) fail(404, 'Master tidak ditemukan.');
  const old = snap.data(); if (old.status === 'queued' || old.status === 'processing') fail(409, 'Tunggu antrean stok selesai.');
  if (old.status === 'review' && !resolve) fail(409, 'Tinjau hasil operasi sebelumnya terlebih dahulu.');
  const actual = await liveMapping(ctx, old);
  await ctx.db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (current.version !== old.version || (expectedVersion !== undefined && current.version !== expectedVersion) || current.status !== old.status) fail(409, 'Stok berubah saat diperiksa. Muat ulang.');
    const changed = current.stock !== actual.stock || current.status !== 'synced';
    tx.update(ref, { stock: actual.stock, observedStock: actual.stock, observedAt: Date.now(), status: 'synced', message: '', version: current.version + (changed ? 1 : 0), updatedAt: Date.now(), ...(changed ? { source: 'shopee' } : {}) });
  });
  return { ok: true, stock: actual.stock };
}
async function queueChanges(ctx, user, changes, operationId, source, csv = null, filename = '') {
  if (!/^[a-f0-9-]{36}$/.test(operationId || '')) fail(400, 'ID operasi tidak valid.');
  const operation = ctx.shop.collection('stockImports').doc(operationId);
  const fingerprint = hash(JSON.stringify({ changes, source, csv }));
  await ctx.db.runTransaction(async tx => {
    const previous = await tx.get(operation);
    if (previous.exists) { if (previous.data().fingerprint !== fingerprint) fail(409, 'ID operasi telah dipakai.'); return; }
    const refs = changes.map(c => ctx.shop.collection('masterProducts').doc(c.id));
    const snapshots = await Promise.all(refs.map(ref => tx.get(ref)));
    snapshots.forEach((snap, i) => validateChange(snap.data(), changes[i].stock, changes[i].version));
    changes.forEach((c, i) => {
      const old = snapshots[i].data(); if (old.sku !== c.sku) fail(409, 'Pemetaan SKU tidak sesuai.');
      const changed = c.stock !== old.stock;
      tx.update(refs[i], { stock: c.stock, expectedStock: old.observedStock, version: old.version + 1, status: changed ? 'queued' : 'synced', operationId, source, updatedAt: Date.now(), requestedBy: user.uid, queuedAt: Date.now(), message: '' });
    });
    tx.create(operation, { source, fingerprint, createdAt: Date.now(), count: changes.length, filename: String(filename).slice(0,120), createdBy: user.uid, changes, ...(csv === null ? {} : { csv }) });
  });
  return { ok: true, count: changes.length, operationId };
}
async function preview(ctx, csv) {
  const changes = parseStockCsv(csv);
  const result = [];
  for (const c of changes) {
    const row = (await ctx.shop.collection('masterProducts').doc(c.id).get()).data(); validateChange(row, c.stock, c.version);
    result.push({ ...c, name: row.name, previous: row.stock, changed: row.stock !== c.stock });
  }
  return { changes: result, checksum: hash(csv) };
}
async function route(ctx, req, path, user, getLiveContext) {
  const b = req.body || {};
  if (req.method === 'GET' && path === '/master') return list(ctx);
  if (req.method === 'GET' && path === '/master/options') return { options: await options(await getLiveContext(), Number(req.query.itemId)) };
  if (req.method !== 'POST') fail(404, 'Endpoint master tidak ditemukan.');
  if (path === '/master/create') return create(await getLiveContext(), user, b);
  if (path === '/master/observe') return observe(await getLiveContext(), b.id, b.version, false);
  if (path === '/master/resolve') { if (b.confirm !== true) fail(400, 'Konfirmasi penerimaan stok Shopee diperlukan.'); return observe(await getLiveContext(), b.id, b.version, true); }
  if (path === '/master/csv/preview') return preview(ctx, b.csv);
  if (path === '/master/csv/commit') {
    if (b.confirm !== true || hash(String(b.csv)) !== b.checksum) fail(400, 'Tinjau dan konfirmasi CSV terlebih dahulu.');
    return queueChanges(ctx, user, parseStockCsv(b.csv), b.operationId, 'csv', b.csv, b.filename);
  }
  if (path === '/master/update') {
    if (b.confirm !== true || typeof b.sku !== 'string') fail(400, 'Konfirmasi perubahan stok diperlukan.');
    return queueChanges(ctx, user, [{ id: hash(b.sku), sku: b.sku, stock: b.stock, version: b.version }], b.operationId, 'database');
  }
  fail(404, 'Endpoint master tidak ditemukan.');
}
function decideStock(actual, job) {
  if (actual.stock === job.stock) return 'already_applied';
  if (actual.stock !== job.expectedStock) return 'conflict';
  return 'write';
}
async function processJob(ctx, ref) {
  let job;
  await ctx.db.runTransaction(async tx => {
    const row = (await tx.get(ref)).data();
    if (!row || row.status !== 'queued') return;
    job = row; tx.update(ref, { status: 'processing', startedAt: Date.now(), message: '' });
  });
  if (!job) return;
  let attemptedWrite = false;
  try {
    const actual = await liveMapping(ctx, job); const decision = decideStock(actual, job);
    if (decision === 'conflict') fail(409, 'Stok Shopee berubah sejak data dibaca. Periksa stok lalu kirim penyesuaian baru.');
    if (decision === 'write') {
      attemptedWrite = true;
      const result = await ctx.api('/product/update_stock', { item_id: job.itemId, stock_list: [{ model_id: job.modelId, seller_stock: [{ stock: job.stock, ...(job.locationId ? { location_id: job.locationId } : {}) }] }] }, 'POST');
      if (result.failure_list?.length || !result.success_list?.some(x => Number(x.model_id) === job.modelId && (!job.locationId || x.location_id === job.locationId))) fail(502, 'Shopee belum mengonfirmasi pembaruan stok. Periksa hasil sebelum mengulang.');
    }
    const verified = await liveMapping(ctx, job);
    if (verified.stock !== job.stock) fail(409, 'Stok setelah pengiriman berbeda dari target. Periksa penjualan atau perubahan lain.');
    await ctx.db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data(); if (current?.version !== job.version || current.status !== 'processing') return;
      tx.update(ref, { status: 'synced', observedStock: verified.stock, observedAt: Date.now(), syncedAt: Date.now(), message: '', updatedAt: Date.now() });
    });
  } catch (e) {
    await ctx.db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data(); if (current?.version !== job.version || current.status !== 'processing') return;
      tx.update(ref, { status: 'review', message: e instanceof MasterError ? e.message : attemptedWrite ? 'Hasil pengiriman belum pasti. Periksa stok Shopee sebelum mencoba lagi.' : 'Pembacaan stok gagal. Periksa koneksi dan stok Shopee.', updatedAt: Date.now() });
    });
  }
}
let running = false;
async function runWorker(getStoreContext, getLiveContext) {
  if (running) return; running = true;
  let ctx, control, owner;
  try {
    ctx = getStoreContext(); control = ctx.shop.collection('stockControl').doc('worker'); owner = crypto.randomUUID();
    const claimed = await ctx.db.runTransaction(async tx => { const data = (await tx.get(control)).data(); if (data?.leaseUntil > Date.now()) return false; tx.set(control, { owner, leaseUntil: Date.now() + 180000, lastRunAt: Date.now(), lastError: null }, { merge: true }); return true; });
    if (!claimed) return;
    // An interrupted write is never blindly replayed. It needs an explicit reconciliation.
    const processing = await ctx.shop.collection('masterProducts').where('status', '==', 'processing').limit(100).get();
    for (const doc of processing.docs) if (doc.data().startedAt < Date.now() - 180000) await ctx.db.runTransaction(async tx => { const d = (await tx.get(doc.ref)).data(); if (d?.status === 'processing' && d.startedAt < Date.now() - 180000) tx.update(doc.ref, { status: 'review', message: 'Proses terhenti. Periksa hasil stok Shopee sebelum mengulang.' }); });
    const pending = await ctx.shop.collection('masterProducts').where('status', '==', 'queued').limit(3).get();
    const live = pending.size ? await getLiveContext() : null;
    for (const doc of pending.docs) {
      // Renew and verify the lease before each operation; operations have bounded upstream timeouts.
      const held = await ctx.db.runTransaction(async tx => { if ((await tx.get(control)).data()?.owner !== owner) return false; tx.update(control, { leaseUntil: Date.now() + 180000 }); return true; });
      if (!held) break;
      await processJob(live, doc.ref);
    }
    // Observe current seller stock in rotation; old CSV values are never replayed.
    const ready = await ctx.shop.collection('masterProducts').where('status', '==', 'synced').get();
    const lastCheck = doc => Math.max(doc.data().observedAt || 0, doc.data().lastCheckAt || 0);
    const due = ready.docs.filter(doc => lastCheck(doc) < Date.now() - 60000).sort((a, b) => lastCheck(a) - lastCheck(b)).slice(0, 5);
    const readContext = due.length ? live || await getLiveContext() : null;
    for (const doc of due) {
      const held = await ctx.db.runTransaction(async tx => { if ((await tx.get(control)).data()?.owner !== owner) return false; tx.update(control, { leaseUntil: Date.now() + 180000 }); return true; });
      if (!held) break;
      try { await observe(readContext, doc.id, doc.data().version); }
      catch {
        // Rotate past unavailable items so they cannot starve the rest of the catalog.
        await ctx.db.runTransaction(async tx => { const current = (await tx.get(doc.ref)).data(); if (current?.version === doc.data().version && current.status === 'synced') tx.update(doc.ref, { lastCheckAt: Date.now(), message: 'Pemeriksaan stok terakhir gagal. Coba Periksa stok Shopee.' }); });
      }
    }
  } catch { if (control && owner) await ctx.db.runTransaction(async tx => { if ((await tx.get(control)).data()?.owner === owner) tx.set(control, { lastError: 'Koneksi Shopee/database belum tersedia. Antrean dicoba pada siklus berikutnya.' }, { merge: true }); }).catch(() => {}); }
  finally { if (control && owner) await ctx.db.runTransaction(async tx => { if ((await tx.get(control)).data()?.owner === owner) tx.set(control, { leaseUntil: 0 }, { merge: true }); }).catch(() => {}); running = false; }
}
function startMasterWorker(getStoreContext, getLiveContext) {
  setTimeout(() => void runWorker(getStoreContext, getLiveContext), 20000).unref();
  setInterval(() => void runWorker(getStoreContext, getLiveContext), 60000).unref();
}
module.exports = { MasterError, parseStockCsv, candidates, decideStock, validateChange, route, startMasterWorker, processJob, queueChanges, observe, hash };
