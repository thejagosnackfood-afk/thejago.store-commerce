const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LocalTokenStore } = require('./local-token-store.cjs');
test('encrypted tokens survive restart, rotate, isolate sessions and delete', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shopee-store-'));
  try {
    const id = 'a'.repeat(64), key = 'b'.repeat(64);
    const token = { access_token: 'private-access', refresh_token: 'private-refresh', shop_id: 123, expired_at: Date.now() + 3600000 };
    const store = new LocalTokenStore(dir, key);
    await store.store(id, token);
    const raw = await fs.readFile(store.file(id), 'utf8');
    assert.ok(!raw.includes(token.access_token));
    assert.ok(!raw.includes(token.refresh_token));
    assert.equal((await fs.stat(store.file(id))).mode & 0o777, 0o600);
    const restarted = new LocalTokenStore(dir, key);
    assert.deepEqual(await restarted.get(id), token);
    assert.equal(await restarted.get('c'.repeat(64)), null);
    await restarted.store(id, { ...token, refresh_token: 'rotated' });
    assert.equal((await store.get(id)).refresh_token, 'rotated');
    await assert.rejects(new LocalTokenStore(dir, 'd'.repeat(64)).get(id));
    await assert.rejects(store.get('../escape'));
    const data = JSON.parse(await fs.readFile(store.file(id), 'utf8'));
    data.tag = '0'.repeat(32);
    await fs.writeFile(store.file(id), JSON.stringify(data));
    await assert.rejects(store.get(id));
    await store.clear(id);
    assert.equal(await store.get(id), null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
