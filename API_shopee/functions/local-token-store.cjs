const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class LocalTokenStore {
  constructor(directory, secret) {
    if (!/^[a-f0-9]{64}$/i.test(secret || '')) throw new Error('SHOPEE_LOCAL_KEY harus 64 karakter hex.');
    this.directory = directory;
    this.key = Buffer.from(secret, 'hex');
  }
  file(id) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('ID sesi lokal tidak valid.');
    return path.join(this.directory, `${id}.json`);
  }
  async get(id) {
    let data;
    try { data = JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(data.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
    const record = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.data, 'hex')), decipher.final()]).toString());
    if (record.expiresAt < Date.now()) { await this.clear(id); return null; }
    return record.token;
  }
  async store(id, token) {
    if (!token || !token.access_token || !token.refresh_token) throw new Error('Respons token tidak lengkap.');
    const target = this.file(id);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const record = JSON.stringify({ token, expiresAt: Date.now() + 30 * 86400000 });
    const data = Buffer.concat([cipher.update(record), cipher.final()]);
    const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') }), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async clear(id) { await fs.rm(this.file(id), { force: true }); }
}
module.exports = { LocalTokenStore };
