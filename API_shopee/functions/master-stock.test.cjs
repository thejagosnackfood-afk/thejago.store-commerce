const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { parseStockCsv, candidates, decideStock, validateChange, queueChanges, processJob, observe, route, hash } = require('./master-stock.cjs');
const sku = 'SNACK-001', id = hash(sku);
const row = () => ({ sku, itemId: 12, modelId: 0, locationId: 'IDZ', stock: 10, observedStock: 10, observedAt: Date.now(), version: 1, status: 'synced' });
// Transactions stage writes until all validation succeeds, as Firestore does.
function context(initial = row(), variant = false) {
  const data = new Map([['masterProducts/'+id, structuredClone(initial)]]), calls = [];
  const ref = key => ({ key, id: key.split('/').at(-1), get: async () => snapshot(key) });
  const snapshot = key => ({ exists: data.has(key), data: () => structuredClone(data.get(key)) });
  let tail = Promise.resolve(), actual = initial.observedStock;
  const ctx = {
    shop: { collection: name => ({ doc: key => ref(name+'/'+key) }) },
    db: { runTransaction(fn) { const result = tail.then(async () => { const writes = []; const result = await fn({ get: r => r.get(), update: (r,v) => writes.push(() => data.set(r.key,{...data.get(r.key),...v})), create: (r,v) => writes.push(() => { assert.equal(data.has(r.key),false);data.set(r.key,v); }) }); writes.forEach(fn=>fn());return result; });tail=result.catch(()=>{});return result; } },
    api: async (path, params, method) => {
      calls.push({path,params,method});
      if(path==='/product/get_item_base_info') return {item_list:[{item_id:12,item_name:'Snack',has_model:variant,stock_info_v2:{seller_stock:[{location_id:'IDZ',stock:actual}]}}]};
      if(path==='/product/get_model_list') return {model:[{model_id:88,model_name:'Pedas',stock_info_v2:{seller_stock:[{location_id:'IDZ',stock:actual}]}}]};
      if(path==='/product/update_stock') {actual=params.stock_list[0].seller_stock[0].stock;return {success_list:[{model_id:variant?88:0,location_id:'IDZ',stock:actual}]};}
      throw Error('Unexpected API');
    }
  };
  return { ctx, data, calls, ref:ref('masterProducts/'+id), setActual:n=>actual=n };
}
const change = stock => [{id,sku,stock,version:1}];
test('CSV accepts BOM, CRLF, quoted fields and zero stock', () => {
  assert.deepEqual(parseStockCsv('\uFEFFMaster SKU,Stok,Versi\r\n"SNACK-001",0,1\r\n'),change(0));
});
test('CSV rejects duplicate, negative, fractional, blank, malformed, wrong header and limits', () => {
  for(const csv of ['Master SKU,Stok,Versi\nA,1,1\nA,2,1','Master SKU,Stok,Versi\nA,-1,1','Master SKU,Stok,Versi\nA,1.5,1','Master SKU,Stok,Versi\nA,,1','Master SKU,Stok,Versi\n"A,1,1','Master SKU,Stok,Versi\n"A"x,1,1','SKU,Stok,Versi\nA,1,1','Master SKU,Stok,Versi\nA,1,0','Master SKU,Stok,Versi\nA,2147483648,1','x'.repeat(300001),'Master SKU,Stok,Versi\n'+Array.from({length:101},(_,i)=>`A${i},1,1`).join('\n')]) assert.throws(()=>parseStockCsv(csv),{status:400});
});
test('mapping uses per-variant seller stock and warehouse, not summary available stock', () => {
  const found=candidates({item_id:12,has_model:true,item_name:'Snack'},[{model_id:88,model_name:'Pedas',stock_info_v2:{summary_info:{total_available_stock:99},seller_stock:[{location_id:'IDZ',stock:0},{location_id:'ID2',stock:9},{location_id:'bad',stock:null}]}}]);
  assert.deepEqual(found.map(x=>[x.modelId,x.locationId,x.stock]),[[88,'IDZ',0],[88,'ID2',9]]);
});
test('stale CSV and pending/uncertain jobs cannot overwrite stock', () => {
  for(const r of [{...row(),version:2},{...row(),status:'queued'},{...row(),status:'processing'},{...row(),status:'review'},{...row(),observedAt:Date.now()-600001},{...row(),observedAt:undefined}]) assert.throws(()=>validateChange(r,5,1),{status:409});
  assert.equal(decideStock({stock:8},{stock:20,expectedStock:10}),'conflict');
  assert.equal(decideStock({stock:20},{stock:20,expectedStock:10}),'already_applied');
});
test('import transaction is atomic and operation idempotent after response loss', async () => {
  const {ctx,data}=context(), op=randomUUID();
  await assert.rejects(queueChanges(ctx,{uid:'owner'},[...change(3),{id:hash('missing'),sku:'missing',stock:2,version:1}],op,'csv'),{status:409});
  assert.equal(data.get('masterProducts/'+id).stock,10);
  await queueChanges(ctx,{uid:'owner'},change(3),op,'csv','file');
  await queueChanges(ctx,{uid:'owner'},change(3),op,'csv','file');
  assert.equal(data.get('masterProducts/'+id).version,2);
  assert.equal(data.get('masterProducts/'+id).status,'queued');
  await assert.rejects(queueChanges(ctx,{uid:'owner'},change(4),op,'csv','different'),{status:409});
});
test('only one concurrent edit of the same version can queue', async () => {
  const {ctx,data}=context();
  const result=await Promise.allSettled([3,4].map(n=>queueChanges(ctx,{uid:'owner'},change(n),randomUUID(),'database')));
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(data.get('masterProducts/'+id).version,2);
});
test('worker sends exact variant/location, verifies result and never replays completed job', async () => {
  const {ctx,ref,data,calls}=context({...row(),modelId:88,stock:0,expectedStock:10,status:'queued'},true);
  await processJob(ctx,ref);await processJob(ctx,ref);
  const writes=calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);
  assert.deepEqual(writes[0].params,{item_id:12,stock_list:[{model_id:88,seller_stock:[{stock:0,location_id:'IDZ'}]}]});
  assert.equal(data.get(ref.key).status,'synced');assert.equal(data.get(ref.key).observedStock,0);
});
test('sale before queued update leads to review with no write', async () => {
  const {ctx,ref,data,calls,setActual}=context({...row(),stock:20,expectedStock:10,status:'queued'});setActual(8);
  await processJob(ctx,ref);assert.equal(data.get(ref.key).status,'review');assert.equal(calls.filter(c=>c.method==='POST').length,0);
});
test('uncertain write and semantic upstream failure are reviewed, never blindly retried', async () => {
  for(const response of ['timeout',{success_list:[]},{success_list:[{model_id:0,location_id:'wrong'}]},{success_list:[{model_id:0,location_id:'IDZ'}],failure_list:[{model_id:0}]}]) {
    const {ctx,ref,data}=context({...row(),stock:20,expectedStock:10,status:'queued'}), api=ctx.api;let writes=0;
    ctx.api=async(...args)=>{if(args[0]==='/product/update_stock'){writes++;if(response==='timeout')throw Error('timeout');return response;}return api(...args);};
    await processJob(ctx,ref);await processJob(ctx,ref);assert.equal(writes,1);assert.equal(data.get(ref.key).status,'review');
  }
});
test('observation accepts changed Shopee stock, invalidates old CSV and does not write upstream', async () => {
  const {ctx,ref,data,calls,setActual}=context();setActual(8);
  await observe(ctx,id,1);assert.equal(data.get(ref.key).stock,8);assert.equal(data.get(ref.key).version,2);assert.equal(calls.filter(c=>c.method==='POST').length,0);
  await assert.rejects(queueChanges(ctx,{uid:'owner'},change(10),randomUUID(),'csv'),{status:409});
});
test('review needs explicit resolution; queued job cannot be reconciled away', async () => {
  for(const status of ['review','queued','processing']) {const {ctx}=context({...row(),status});await assert.rejects(observe(ctx,id,1),{status:409});}
  const {ctx,data,ref,setActual}=context({...row(),status:'review',stock:20});setActual(8);await observe(ctx,id,1,true);assert.equal(data.get(ref.key).stock,8);assert.equal(data.get(ref.key).status,'synced');
});
test('master routes require explicit confirmation and CSV checksum', async () => {
  const {ctx}=context();
  for(const path of ['/master/update','/master/csv/commit','/master/resolve','/master/create']) await assert.rejects(route(ctx,{method:'POST',body:{}},path,{uid:'owner'},async()=>ctx),{status:400});
});
