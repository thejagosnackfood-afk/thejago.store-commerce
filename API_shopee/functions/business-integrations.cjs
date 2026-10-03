const crypto = require('node:crypto');

const catalog = {
  fulfillment: [{ id: 'kompack', name: 'Kompack' }, { id: 'shipper', name: 'Shipper' }, { id: 'crewdible', name: 'Crewdible' }, { id: 'custom', name: 'Layanan lainnya' }],
  accounting: [{ id: 'accurate', name: 'Accurate Online' }, { id: 'jurnal', name: 'the jago Books' }, { id: 'custom', name: 'Sistem lainnya' }],
  erp: [{ id: 'desty', name: 'the jago' }, { id: 'odoo', name: 'Odoo' }, { id: 'sap', name: 'SAP' }, { id: 'internal', name: 'Sistem internal' }, { id: 'custom', name: 'ERP lainnya' }],
};
class IntegrationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new IntegrationError(status, message); }
function field(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f]/.test(value)) fail(400, `${label} tidak valid.`);
  return value.trim();
}
function adapterUrl(kind, provider, env) {
  let config;
  try { config = JSON.parse(env.BUSINESS_INTEGRATION_ADAPTERS || '{}'); } catch { return null; }
  const value = config?.[kind]?.[provider];
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) return null;
    return url.href;
  } catch { return null; }
}
function key(env) {
  if (!env.SHOPEE_PARTNER_KEY) fail(503, 'Penyimpanan kredensial belum dikonfigurasi.');
  return crypto.createHash('sha256').update(`business-integrations-v1:${env.SHOPEE_PARTNER_KEY}`).digest();
}
function encrypt(secret, aad, env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(env), iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') };
}
function decrypt(secret, aad, env) {
  try {
    const cipher = crypto.createDecipheriv('aes-256-gcm', key(env), Buffer.from(secret.iv, 'hex'));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(Buffer.from(secret.tag, 'hex'));
    return Buffer.concat([cipher.update(Buffer.from(secret.data, 'hex')), cipher.final()]).toString('utf8');
  } catch { fail(503, 'Kredensial tidak dapat dibaca. Simpan ulang API key.'); }
}
function publicRow(id, data) {
  return { id, provider: data.provider, name: data.name, referenceId: data.referenceId, status: data.status,
    hasCredential: Boolean(data.credential), revision: data.revision, updatedAt: data.updatedAt,
    checkedAt: data.checkedAt || null, accountName: data.accountName || '', lastError: data.lastError || '', exchange: data.exchange || null };
}
async function route(ctx, req, path, user, dependencies = {}) {
  const env = dependencies.env || process.env;
  const fetcher = dependencies.fetch || fetch;
  const match = /^\/integrations\/(fulfillment|accounting|erp)(?:\/(save|verify|disconnect|delete))?$/.exec(path);
  if (!match) fail(404, 'Endpoint integrasi tidak ditemukan.');
  const [, kind, action] = match;
  const collection = ctx.shop.collection(`businessIntegrations_${kind}`);
  const providers = catalog[kind].map(p => ({ ...p, configured: Boolean(adapterUrl(kind, p.id, env)) }));
  if (!action && req.method === 'GET') {
    const snapshot = await collection.get();
    return { providers, integrations: snapshot.docs.map(doc => publicRow(doc.id, doc.data())).sort((a, b) => b.updatedAt - a.updatedAt) };
  }
  if (!action || req.method !== 'POST') fail(405, 'Metode tidak didukung.');
  const body = req.body || {};
  const id = body.id === undefined && action === 'save' ? crypto.randomUUID() : field(body.id, 'ID integrasi', 36);
  if (!/^[a-f0-9-]{36}$/.test(id)) fail(400, 'ID integrasi tidak valid.');
  const ref = collection.doc(id);
  const aad = `${ctx.shop.path}/${kind}/${id}`;
  const readCurrent = async tx => {
    const snapshot = await tx.get(ref);
    const current = snapshot.exists ? snapshot.data() : null;
    if (!current && (action !== 'save' || body.id !== undefined)) fail(404, 'Integrasi tidak ditemukan.');
    if (current && body.revision !== current.revision) fail(409, 'Konfigurasi berubah. Perbarui daftar sebelum mencoba lagi.');
    return current;
  };
  if (action === 'verify') {
    const snapshot = await ref.get();
    if (!snapshot.exists) fail(404, 'Integrasi tidak ditemukan.');
    const current = snapshot.data();
    if (body.revision !== current.revision) fail(409, 'Konfigurasi berubah. Perbarui daftar sebelum mencoba lagi.');
    const url = adapterUrl(kind, current.provider, env);
    if (!url) fail(503, 'Konektor penyedia belum tersedia. Konfigurasi tetap tersimpan sebagai draf.');
    if (!current.credential) fail(400, 'Simpan API key sebelum memverifikasi koneksi.');
    const token = decrypt(current.credential, aad, env);
    let accountName = '', error = '';
    try {
      // Only server-configured adapters receive credentials; clients cannot supply URLs.
      const response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ operation: 'verify', kind, provider: current.provider, referenceId: current.referenceId, exchange: current.exchange || null }) });
      if (!response.ok) throw new Error('rejected');
      const data = await response.json();
      if (data.connected !== true || typeof data.accountName !== 'string' || !data.accountName.trim() || data.accountName.length > 160) throw new Error('invalid');
      accountName = data.accountName.trim();
    } catch { error = 'Verifikasi gagal. Periksa API key, ID akun, dan ketersediaan layanan.'; }
    return ctx.db.runTransaction(async tx => {
      const latest = await readCurrent(tx);
      const next = { ...latest, status: error ? 'error' : 'connected', accountName, lastError: error,
        checkedAt: Date.now(), updatedAt: Date.now(), updatedBy: user.uid, revision: latest.revision + 1 };
      tx.set(ref, next);
      return { integration: publicRow(id, next) };
    });
  }
  return ctx.db.runTransaction(async tx => {
    const current = await readCurrent(tx);
    if (action === 'delete') {
      if (current.status === 'connected') fail(409, 'Putuskan koneksi sebelum menghapus konfigurasi.');
      tx.delete(ref);
      return { ok: true };
    }
    let next;
    if (action === 'disconnect') {
      next = { ...current, credential: null, status: 'disconnected', accountName: '', lastError: '', checkedAt: null };
    } else {
      const provider = field(body.provider, 'Penyedia');
      if (!catalog[kind].some(p => p.id === provider)) fail(400, 'Penyedia tidak didukung.');
      const name = field(body.name, 'Nama integrasi');
      const referenceId = field(body.referenceId, kind === 'fulfillment' ? 'ID gudang' : 'ID perusahaan');
      let exchange = null;
      if (kind === 'erp') {
        const input = body.exchange;
        if (!input || typeof input !== 'object') fail(400, 'Konfigurasi pertukaran data wajib diisi.');
        const targetSystem = field(input.targetSystem, 'Sistem tujuan');
        if (!['import', 'export', 'bidirectional'].includes(input.direction)) fail(400, 'Arah pertukaran data tidak valid.');
        if (!Array.isArray(input.entities) || !input.entities.length || input.entities.length > 4 || input.entities.some(value => !['products', 'inventory', 'orders', 'invoices'].includes(value))) fail(400, 'Pilih jenis data yang valid.');
        exchange = { targetSystem, direction: input.direction, entities: [...new Set(input.entities)] };
      }
      const credential = body.apiKey === undefined || body.apiKey === '' ? current?.credential || null : encrypt(field(body.apiKey, 'API key', 4096), aad, env);
      if (current && current.provider !== provider && !body.apiKey) fail(400, 'Isi API key baru saat mengganti penyedia.');
      next = { provider, name, referenceId, credential, exchange, status: 'draft', checkedAt: null, accountName: '', lastError: '' };
    }
    next = { ...next, revision: (current?.revision || 0) + 1, updatedAt: Date.now(), updatedBy: user.uid };
    tx.set(ref, next);
    return { integration: publicRow(id, next) };
  });
}
module.exports = { route, IntegrationError };
