const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CloudTokenStore } = require('./cloud-token-store.cjs');
function fakeDatabase(rows = new Map()) {
  const convert = obj => Object.fromEntries(Object.entries(obj).map(([k,v]) => [k,v instanceof Date ? { toMillis: () => v.getTime() } : v]));
  const doc = id => ({ id,
    get: async () => ({ exists: rows.has(id), data: () => rows.get(id) }),
    set: async data => { rows.set(id, convert(data)); },
    delete: async () => { rows.delete(id); },
  });
  let queue = Promise.resolve();
  return { collection: () => ({ doc, where: () => ({ limit: count => ({ get: async () => {
    const docs = [...rows.entries()].filter(([,data]) => data.refreshAt?.toMillis() <= Date.now()).slice(0,count).map(([id]) => ({ref:doc(id)}));
    return {size:docs.length,docs};
  } }) }) }), runTransaction: action => {
    const work = queue.then(() => action({get: ref => ref.get(), set: (ref,data) => ref.set(data), delete: ref => ref.delete(), update: (ref,data) => ref.set({...rows.get(ref.id),...data})}));
    queue = work.catch(() => {}); return work;
  } };
}
test('cloud token is encrypted, session-bound, persistent, rotated and deleted', async () => {
  const rows = new Map();
  const db = fakeDatabase(rows);
  const id = 'a'.repeat(64), other = 'b'.repeat(64);
  const store = new CloudTokenStore(db, 'test-secret');
  const token = { access_token: 'private-access-token', refresh_token: 'private-refresh-token', shop_id: 123 };
  await store.store(id, token);
  assert.ok(!rows.has(id));
  assert.ok(!JSON.stringify([...rows.values()]).includes(token.access_token));
  assert.deepEqual(await new CloudTokenStore(db, 'test-secret').get(id), token);
  assert.equal(await store.get(other), null);
  const [name, data] = [...rows.entries()][0];
  await store.store(other, token);
  const otherName = [...rows.keys()].find(key => key !== name);
  rows.set(otherName, data);
  await assert.rejects(store.get(other));
  await store.store(id, { ...token, refresh_token: 'rotated' });
  assert.equal((await store.get(id)).refresh_token, 'rotated');
  const current = rows.get(name);
  rows.set(name, { ...current, tag: '0'.repeat(32) });
  await assert.rejects(store.get(id));
  await assert.rejects(store.store('../escape', token));
  await assert.rejects(store.store(id, {}));
  await store.clear(id);
  assert.equal(await store.get(id), null);
});

test('refresh lease prevents duplicate rotation and preserves tokens after failure', async () => {
  const rows = new Map(), store = new CloudTokenStore(fakeDatabase(rows), 'secret');
  const id = 'a'.repeat(64), ref = store.document(id);
  const old = {access_token:'old', refresh_token:'refresh', shop_id:123, expired_at:Date.now()+1000};
  await store.store(id,old);
  let calls=0, release;
  const gate = new Promise(resolve => {release=resolve;});
  const rotate = async () => {calls++; await gate; return {...old,access_token:'new',refresh_token:'rotated',expired_at:Date.now()+4*3600000};};
  const first=store.refreshDocument(ref,rotate);
  await new Promise(resolve=>setTimeout(resolve,10));
  await store.refreshDocument(ref,rotate);
  release(); await first;
  assert.equal(calls,1);
  assert.equal((await store.get(id)).refresh_token,'rotated');
  await store.refreshDocument(ref,rotate);
  assert.equal(calls,1);
  await store.store(id,old);
  await assert.rejects(store.refreshDocument(ref,async()=>{throw Error('network');}));
  assert.equal((await store.get(id)).refresh_token,'refresh');
  assert.equal(rows.get(ref.id).refreshStatus,'retry_pending');
});
test('logout during refresh cannot recreate the deleted token', async () => {
  const store = new CloudTokenStore(fakeDatabase(), 'secret'), id='a'.repeat(64);
  const token={access_token:'a',refresh_token:'r',expired_at:Date.now()};
  await store.store(id,token);
  await store.refreshDocument(store.document(id),async()=>{await store.clear(id);return {...token,access_token:'b'};});
  assert.equal(await store.get(id),null);
});
test('legacy token migrates with its browser ID and becomes decryptable by scheduler',async()=>{
  const crypto=require('node:crypto'), rows=new Map(), store=new CloudTokenStore(fakeDatabase(rows),'secret');
  const id='a'.repeat(64),ref=store.document(id),iv=crypto.randomBytes(12);
  const token={access_token:'legacy',refresh_token:'r',expired_at:Date.now()+3600000};
  const cipher=crypto.createCipheriv('aes-256-gcm',store.key,iv);cipher.setAAD(Buffer.from(id));
  const data=Buffer.concat([cipher.update(JSON.stringify({token,expiresAt:Date.now()+86400000})),cipher.final()]);
  rows.set(ref.id,{version:1,iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('hex')});
  assert.deepEqual(await store.get(id),token);
  assert.equal(rows.get(ref.id).version,2);
  assert.deepEqual(store.decode(rows.get(ref.id),ref.id).token,token);
});

test('scheduler refreshes due sessions, skips fresh tokens, and reports failures',async()=>{
  const store=new CloudTokenStore(fakeDatabase(),'secret');
  const token={access_token:'old',refresh_token:'r',expired_at:Date.now()};
  await store.store('a'.repeat(64),token);
  await store.store('b'.repeat(64),{...token,expired_at:Date.now()+4*3600000});
  await store.store('c'.repeat(64),{...token,access_token:'fail'});
  const result=await store.refreshDue(async old=>{
    if(old.access_token==='fail') throw Error('network');
    return {...old,access_token:'new',expired_at:Date.now()+4*3600000};
  });
  assert.deepEqual(result,{checked:2,refreshed:1,failed:1});
  assert.equal((await store.get('a'.repeat(64))).access_token,'new');
});
