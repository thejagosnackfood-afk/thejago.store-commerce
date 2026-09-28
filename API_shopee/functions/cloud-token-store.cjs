const crypto = require('node:crypto');
const REFRESH_MARGIN = 30 * 60 * 1000;
class CloudTokenStore {
  constructor(database, secret) {
    this.database = database;
    this.key = crypto.createHash('sha256').update(`shopee-server-token-v1:${secret}`).digest();
  }
  document(id) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('ID sesi tidak valid.');
    const name = crypto.createHmac('sha256', this.key).update(id).digest('hex');
    return this.database.collection('shopeeConnectorSessions').doc(name);
  }
  decode(envelope, aad) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'hex'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'hex')), decipher.final()]).toString());
  }
  encode(name, token, expiresAt = Date.now() + 30 * 86400000) {
    if (!token || typeof token.access_token !== 'string' || !token.access_token || typeof token.refresh_token !== 'string' || !token.refresh_token) throw new Error('Respons token Shopee tidak lengkap.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(name));
    const data = Buffer.concat([cipher.update(JSON.stringify({ token, expiresAt })), cipher.final()]);
    return { version: 2, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex'), expiresAt: new Date(expiresAt), refreshAt: new Date(Math.max(Date.now(), (Number(token.expired_at) || Date.now()) - REFRESH_MARGIN)) };
  }
  async get(id) {
    const ref = this.document(id);
    return this.database.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) return null;
      const envelope = snapshot.data();
      const record = this.decode(envelope, envelope.version === 2 ? ref.id : id);
      if (record.expiresAt <= Date.now()) { tx.delete(ref); return null; }
      // Upgrade old cookies only after authenticated decryption; never extend their session.
      if (envelope.version !== 2) tx.set(ref, this.encode(ref.id, record.token, record.expiresAt));
      return record.token;
    });
  }
  async store(id, token) {
    const ref = this.document(id);
    await ref.set(this.encode(ref.id, token));
  }
  async clear(id) { await this.document(id).delete(); }
  async refreshDocument(ref, refresh, expectedAccessToken) {
    const owner = crypto.randomBytes(16).toString('hex');
    const claim = await this.database.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().version !== 2) return null;
      const data = snap.data();
      const record = this.decode(data, ref.id);
      if (record.expiresAt <= Date.now()) { tx.delete(ref); return null; }
      if (data.leaseUntil?.toMillis() > Date.now()) return { token: record.token };
      if (expectedAccessToken && record.token.access_token !== expectedAccessToken) return { token: record.token };
      if (!expectedAccessToken && Number(record.token.expired_at) > Date.now() + REFRESH_MARGIN) return { token: record.token };
      tx.update(ref, { leaseOwner: owner, leaseUntil: new Date(Date.now() + 120000) });
      return { token: record.token, claimed: true, expiresAt: record.expiresAt };
    });
    if (!claim?.claimed) return claim?.token || null;
    try {
      const token = await refresh(claim.token);
      const envelope = this.encode(ref.id, token);
      await this.database.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (snap.exists && snap.data().leaseOwner === owner) tx.set(ref, { ...envelope, lastRefreshAt: new Date(), refreshStatus: 'ok' });
      });
      return token;
    } catch (error) {
      await this.database.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (snap.exists && snap.data().leaseOwner === owner) tx.update(ref, { leaseOwner: '', leaseUntil: new Date(0), refreshAt: new Date(Date.now() + 5 * 60000), refreshStatus: 'retry_pending' });
      });
      throw error;
    }
  }
  async refreshDue(refresh) {
    const snapshot = await this.database.collection('shopeeConnectorSessions').where('refreshAt', '<=', new Date()).limit(10).get();
    const result = { checked: snapshot.size, refreshed: 0, failed: 0 };
    for (const doc of snapshot.docs) {
      try {
        await this.refreshDocument(doc.ref, async token => { const next = await refresh(token); result.refreshed++; return next; });
      } catch { result.failed++; }
    }
    return result;
  }
}
function createCloudTokenStore(secret) {
  const { cert, getApps, initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (serviceAccountJson) {
      let serviceAccount;
      try { serviceAccount = JSON.parse(serviceAccountJson); }
      catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON harus berisi JSON service account yang valid.'); }
      initializeApp({ credential: cert(serviceAccount) });
    } else {
      initializeApp();
    }
  }
  return new CloudTokenStore(getFirestore(), secret);
}
module.exports = { CloudTokenStore, createCloudTokenStore };
