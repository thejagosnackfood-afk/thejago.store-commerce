const { PAGE_SIZE, pageNumber, normalizeRows } = require('./mysql-master/protocol.cjs');
class SourceError extends Error { constructor(status, message) { super(message); this.status = status; } }
function configuration(env) {
  if (!env.MASTER_MYSQL_URL || !env.MASTER_MYSQL_TOKEN) return null;
  try {
    const url = new URL(env.MASTER_MYSQL_URL);
    const octets = url.hostname.split('.').map(Number);
    const privateHost = url.hostname === '127.0.0.1' || (octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && !privateHost) || env.MASTER_MYSQL_TOKEN.length < 32) throw new Error();
    return { url, token: env.MASTER_MYSQL_TOKEN };
  } catch { throw new SourceError(503, 'Konfigurasi middleware MySQL tidak valid.'); }
}
async function readPage(page, env = process.env, fetcher = fetch) {
  let parsedPage;
  try { parsedPage = pageNumber(page); } catch { throw new SourceError(400, 'Halaman tidak valid.'); }
  const config = configuration(env);
  if (!config) throw new SourceError(503, 'Middleware MySQL belum dikonfigurasi.');
  const url = new URL('/v1/master-products', config.url); url.searchParams.set('page', String(parsedPage));
  try {
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    let text = '', bytes = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error(); text += decoder.decode(chunk, { stream: true }); }
    text += decoder.decode();
    const data = JSON.parse(text);
    if (data.ok !== true || data.source !== 'mysql' || data.readOnly !== true || data.page !== parsedPage || typeof data.hasMore !== 'boolean' || !Number.isFinite(Date.parse(data.fetchedAt)) || (data.hasMore && data.rows?.length !== PAGE_SIZE)) throw new Error();
    return { rows: normalizeRows(data.rows), page: parsedPage, hasMore: data.hasMore, fetchedAt: data.fetchedAt, source: 'mysql', readOnly: true };
  } catch { throw new SourceError(502, 'Data MySQL belum dapat dibaca. Periksa middleware dan koneksi Tailscale.'); }
}
function normalizeName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function similarity(a, b) {
  const left = normalizeName(a), right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const tokensA = new Set(left.split(' ')), tokensB = new Set(right.split(' '));
  const tokenDice = 2 * [...tokensA].filter(x => tokensB.has(x)).length / (tokensA.size + tokensB.size);
  const grams = value => { const padded = ` ${value} `, set = new Set(); for (let i = 0; i < padded.length - 1; i++) set.add(padded.slice(i, i + 2)); return set; };
  const gramsA = grams(left), gramsB = grams(right);
  const bigramDice = 2 * [...gramsA].filter(x => gramsB.has(x)).length / (gramsA.size + gramsB.size);
  return 0.55 * tokenDice + 0.45 * bigramDice;
}
async function allSnapshotRows(ctx) {
  const snapshot = require('./master-mysql-snapshot.cjs');
  const meta = await snapshot.metadata(ctx);
  if (!meta || !Number.isSafeInteger(meta.count) || meta.count < 1) throw new SourceError(503, 'Snapshot master MySQL belum tersedia.');
  const pages = Math.ceil(meta.count / PAGE_SIZE), rows = [];
  for (let start = 0; start < pages; start += 20) {
    const batch = await Promise.all(Array.from({ length: Math.min(20, pages - start) }, (_, offset) => snapshot.readSnapshot(ctx, start + offset, meta.snapshotId)));
    if (batch.some(result => !result)) throw new SourceError(503, 'Snapshot master MySQL belum lengkap.');
    for (const result of batch) rows.push(...result.rows);
  }
  return rows;
}
async function findMatches(ctx) {
  const [masterRows, onlineMeta, linkedDocs] = await Promise.all([
    allSnapshotRows(ctx), ctx.shop.get(), ctx.shop.collection('masterOnlineMappings').get(),
  ]);
  const activeSnapshot = onlineMeta.data()?.activeSnapshot;
  if (!activeSnapshot) throw new SourceError(503, 'Sinkronkan katalog Shopee sebelum mencocokkan nama.');
  const online = (await ctx.shop.collection('snapshots').doc(activeSnapshot).collection('products').get()).docs.map(doc => doc.data());
  const linkedItems = new Set(linkedDocs.docs.map(doc => Number(doc.id)));
  const linkedSkus = new Set(linkedDocs.docs.map(doc => String(doc.data().masterSku || '').toLowerCase()));
  const usedItems = new Set(linkedItems), usedSkus = new Set(linkedSkus), pairs = [];
  for (const master of masterRows) {
    if (usedSkus.has(master.sku.toLowerCase())) continue;
    let best = null;
    for (const product of online) {
      if (usedItems.has(Number(product.itemId)) || product.status !== 'NORMAL' || product.hasModel) continue;
      const score = similarity(master.name, product.name);
      if (!best || score > best.score) best = { masterSku: master.sku, masterName: master.name, itemId: Number(product.itemId), productName: product.name, score };
    }
    if (best && !usedItems.has(best.itemId) && best.score > 0.5) pairs.push(best);
  }
  pairs.sort((a, b) => b.score - a.score);
  const unique = [];
  for (const pair of pairs) if (!usedItems.has(pair.itemId) && !usedSkus.has(pair.masterSku.toLowerCase())) { unique.push(pair); usedItems.add(pair.itemId); usedSkus.add(pair.masterSku.toLowerCase()); }
  return { candidates: unique, activeSnapshot, onlineCount: online.length, masterCount: masterRows.length, matchedCount: linkedItems.size };
}
async function matches(ctx) {
  const result = await findMatches(ctx);
  return { suggestions: result.candidates.slice(0, 100), count: result.candidates.length, onlineCount: result.onlineCount, masterCount: result.masterCount, matchedCount: result.matchedCount };
}
async function autoLinkMatches(ctx) {
  const result = await findMatches(ctx);
  if (!result.candidates.length) return { linkedCount: 0, candidateCount: 0, threshold: 50 };
  const [currentMeta, currentLinks] = await Promise.all([
    ctx.shop.get(),
    ctx.shop.collection('masterOnlineMappings').get(),
  ]);
  if (currentMeta.data()?.activeSnapshot !== result.activeSnapshot) throw new SourceError(409, 'Katalog Shopee berubah saat pencocokan berlangsung. Muat ulang lalu coba lagi.');
  const linkedItems = new Set(currentLinks.docs.map(doc => Number(doc.id)));
  const linkedSkus = new Set(currentLinks.docs.map(doc => String(doc.data().masterSku || '').toLowerCase()));
  if (result.candidates.some(match => linkedItems.has(match.itemId) || linkedSkus.has(match.masterSku.toLowerCase()))) {
    throw new SourceError(409, 'Tautan Master SKU berubah saat pencocokan berlangsung. Muat ulang lalu coba lagi.');
  }
  for (let start = 0; start < result.candidates.length; start += 400) {
    const batch = ctx.db.batch();
    for (const match of result.candidates.slice(start, start + 400)) {
      const ref = ctx.shop.collection('masterOnlineMappings').doc(String(match.itemId));
      batch.create(ref, {
        itemId: match.itemId,
        masterSku: match.masterSku,
        masterName: match.masterName,
        productName: match.productName,
        linkedAt: Date.now(),
        updatedAt: Date.now(),
        matchType: 'fuzzy-auto',
        matchScore: match.score,
      });
    }
    await batch.commit();
  }
  return { linkedCount: result.candidates.length, candidateCount: result.candidates.length, threshold: 50 };
}
async function linkProduct(ctx, body) {
  const itemId = Number(body.itemId), masterSku = String(body.masterSku || '');
  if (!Number.isSafeInteger(itemId) || itemId <= 0 || !masterSku.trim() || masterSku.length > 200) throw new SourceError(400, 'Master SKU atau produk online tidak valid.');
  const [masterRows, metaSnap, catalog] = await Promise.all([allSnapshotRows(ctx), ctx.shop.get(), ctx.shop.collection('masterOnlineMappings').get()]);
  const master = masterRows.find(row => row.sku === masterSku);
  if (!master) throw new SourceError(409, 'Master SKU tidak lagi tersedia pada snapshot terbaru.');
  const meta = metaSnap.data() || {};
  if (!meta.activeSnapshot) throw new SourceError(409, 'Katalog online belum disinkronkan.');
  const product = (await ctx.shop.collection('snapshots').doc(meta.activeSnapshot).collection('products').doc(String(itemId)).get()).data();
  if (!product || product.status !== 'NORMAL') throw new SourceError(409, 'Produk Shopee tidak aktif atau katalog berubah.');
  if (catalog.docs.some(doc => Number(doc.id) !== itemId && String(doc.data().masterSku).toLowerCase() === masterSku.toLowerCase())) throw new SourceError(409, 'Master SKU ini sudah terhubung ke produk online lain.');
  const ref = ctx.shop.collection('masterOnlineMappings').doc(String(itemId));
  const previous = (await ref.get()).data();
  if (previous && previous.masterSku !== masterSku) throw new SourceError(409, 'Produk online ini sudah memiliki Master SKU.');
  await ref.set({ itemId, masterSku, masterName: master.name, productName: product.name, linkedAt: previous?.linkedAt || Date.now(), updatedAt: Date.now(), matchType: 'fuzzy-approved' }, { merge: true });
  return { ok: true, itemId, masterSku, productName: product.name };
}
async function listLinks(ctx) {
  const data = await ctx.shop.collection('masterOnlineMappings').get();
  return { links: data.docs.map(doc => doc.data()).sort((a, b) => String(a.masterSku).localeCompare(String(b.masterSku))) };
}
async function unlinkProduct(ctx, body) {
  const itemId = Number(body.itemId);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) throw new SourceError(400, 'ID produk online tidak valid.');
  await ctx.shop.collection('masterOnlineMappings').doc(String(itemId)).delete();
  return { ok: true, itemId };
}
async function route(req, path, ctx) {
  if (req.method === 'GET' && path === '/master/mysql/matches') return matches(ctx);
  if (req.method === 'GET' && path === '/master/mysql/links') return listLinks(ctx);
  if (req.method === 'POST' && path === '/master/mysql/auto-link') return autoLinkMatches(ctx);
  if (req.method === 'POST' && path === '/master/mysql/link') return linkProduct(ctx, req.body || {});
  if (req.method === 'POST' && path === '/master/mysql/unlink') return unlinkProduct(ctx, req.body || {});
  if (path === '/master/mysql/sync') {
    const ref = ctx.shop.collection('mysqlMasterSync').doc('control');
    if (req.method === 'POST') {
      const body = req.body || {};
      if (typeof body.enabled !== 'boolean') throw new SourceError(400, 'Status sinkronisasi tidak valid.');
      const current = (await ref.get()).data() || {};
      if (body.enabled && (!Number.isFinite(current.agentLastSeenAt) || Date.now() - current.agentLastSeenAt > 90000))
        throw new SourceError(503, 'Agen sinkronisasi pada server tailnet belum terhubung.');
      await ref.set({ enabled: body.enabled, requestedAt: Date.now() }, { merge: true });
      const agentOnline = Number.isFinite(current.agentLastSeenAt) && Date.now() - current.agentLastSeenAt <= 90000;
      return { enabled: body.enabled, state: body.enabled ? current.agentState || 'starting' : 'paused', agentOnline, agentLastSeenAt: current.agentLastSeenAt || null, lastSyncAt: current.lastSyncAt || null, lastCount: current.lastCount || null, lastError: current.lastError || null };
    }
    if (req.method !== 'GET') throw new SourceError(405, 'Metode sinkronisasi tidak didukung.');
    const current = (await ref.get()).data() || {};
    const agentOnline = Number.isFinite(current.agentLastSeenAt) && Date.now() - current.agentLastSeenAt <= 90000;
    return { enabled: current.enabled === true, state: agentOnline ? current.agentState || 'idle' : 'offline', agentOnline, agentLastSeenAt: current.agentLastSeenAt || null, lastSyncAt: current.lastSyncAt || null, lastCount: current.lastCount || null, lastError: current.lastError || null };
  }
  if (req.method !== 'GET') throw new SourceError(405, 'Sumber MySQL hanya dapat dibaca.');
  if (ctx) {
    const snapshot = require('./master-mysql-snapshot.cjs');
    if (path === '/master/mysql/status') {
      const meta = await snapshot.metadata(ctx);
      if (meta) return { configured: true, readOnly: true, mode: 'snapshot', fetchedAt: meta.fetchedAt, count: meta.count, liveVerified: false };
    }
    if (path === '/master/mysql/products') {
      let page;
      try { page = pageNumber(req.query?.page ?? '0'); } catch { throw new SourceError(400, 'Halaman tidak valid.'); }
      if (req.query?.snapshotId && !/^[a-f0-9]{32}$/.test(req.query.snapshotId)) throw new SourceError(400, 'Snapshot tidak valid.');
      const result = await snapshot.readSnapshot(ctx, page, req.query?.snapshotId);
      if (result) return result;
      if (req.query?.snapshotId) throw new SourceError(404, 'Snapshot tidak ditemukan.');
    }
  }
  if (path === '/master/mysql/status') return { configured: Boolean(configuration(process.env)), readOnly: true, mode: 'middleware', liveVerified: false };
  if (path === '/master/mysql/products') return readPage(req.query?.page ?? '0');
  throw new SourceError(404, 'Endpoint MySQL tidak ditemukan.');
}
module.exports = { SourceError, configuration, readPage, allSnapshotRows, route, similarity };
