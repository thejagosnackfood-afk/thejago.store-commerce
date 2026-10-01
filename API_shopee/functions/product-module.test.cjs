const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { editPayload, createPayload, writeProduct, matchMaster, renderProductModule } = require('./product-module.cjs');
const sample = { name:'Sosis Mawar 500g',sku:'MAWAR-500',description:'Sosis kemasan 500 gram.',categoryId:123,price:15000,stock:5,weight:0.5,imageIds:['image-1'],logisticId:4000 };
test('create validates metadata and forces UNLIST',()=>{
 const payload=createPayload({...sample,item_status:'NORMAL',item_id:44});assert.equal(payload.item_status,'UNLIST');assert.equal(payload.item_id,undefined);assert.deepEqual(payload.seller_stock,[{stock:5}]);
 for(const changes of [{stock:-1},{imageIds:[]},{categoryId:0},{price:NaN},{sku:''},{stock:'5'}])assert.throws(()=>createPayload({...sample,...changes}));
});
test('edit whitelists title and item SKU',()=>assert.deepEqual(editPayload({itemId:1,name:sample.name,sku:sample.sku,price:1,stock:1000}),{item_id:1,item_name:sample.name,item_sku:sample.sku}));
test('changed, absent and variant products never write',async()=>{
 for(const current of [undefined,{item_id:1,has_model:true},{item_id:1,item_name:'Changed',item_sku:'OLD'}]){
 let writes=0;const sdk={product:{getItemBaseInfo:async()=>({response:{item_list:current?[current]:[]}}),updateItem:async()=>{writes++;}}};
 await assert.rejects(writeProduct({action:'edit',body:{itemId:1,name:sample.name,sku:sample.sku,before:{name:'Old',sku:'OLD'}},sdk}));assert.equal(writes,0);
 }
});
test('edit succeeds only after readback',async()=>{
 let current={item_id:1,item_name:'Old',item_sku:'OLD'};let writes=0;
 const sdk={product:{getItemBaseInfo:async()=>({response:{item_list:[current]}}),updateItem:async payload=>{writes++;current={...current,...payload};return {response:{}};}}};
 const result=await writeProduct({action:'edit',body:{itemId:1,name:sample.name,sku:sample.sku,before:{name:'Old',sku:'OLD'}},sdk});assert.equal(result.ok,true);assert.equal(writes,1);
 sdk.product.updateItem=async()=>({response:{}});
 await assert.rejects(writeProduct({action:'edit',body:{itemId:1,name:'Other',sku:sample.sku,before:{name:current.item_name,sku:current.item_sku}},sdk}),/belum terverifikasi/);
});
test('upstream HTTP 200 error and missing item ID are failures',async()=>{
 for(const data of [{error:'invalid_category',message:'Category rejected'},{response:{}}])await assert.rejects(writeProduct({action:'create',body:sample,sdk:{product:{addItem:async()=>data}}}));
 assert.equal((await writeProduct({action:'create',body:sample,sdk:{product:{addItem:async()=>({response:{item_id:123}})}}})).itemId,123);
});
test('fuzzy normalizes units and flags size conflicts even for exact SKU',()=>{
 const rows=matchMaster({name:'Mawar Sosis 1 kg',sku:'MASTER'},[{name:'Sosis Mawar 500g',sku:'MASTER'},{name:'Sosis Mawar 1000gr',sku:'GOOD'}]);assert.equal(rows[0].sku,'GOOD');assert.equal(rows[0].score,100);assert.equal(rows[1].conflict,true);
});
test('module renders status 200 with valid browser script',()=>{
 let html;renderProductModule((res,status,title,content)=>{assert.equal(status,200);html=content;},{});assert.ok(html.includes('Tinjau perubahan'));new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
});
test('write routes reject other origins and missing OAuth',async()=>{
 const context=vm.createContext({require,exports:{},Buffer,URL,console,process});vm.runInContext(fs.readFileSync(`${__dirname}/index.js`,'utf8'),context);vm.runInContext("loadShopeeConfig=()=>({redirectUrl:'https://connector.example/shopee/callback'});createSdkContext=async()=>({token:null});",context);
 for(const headers of [{origin:'https://evil.example',accept:'application/json'},{origin:'https://connector.example',accept:'application/json'}]){
 let code;const res={setHeader(){},status(value){code=value;return this;},set(){return this;},send(){}};context.req={method:'POST',path:'/shopee/api/products/create',headers,body:sample};context.res=res;await vm.runInContext('handleRequest(req,res)',context);assert.equal(code,headers.origin.includes('evil')?403:401);
 }
});
