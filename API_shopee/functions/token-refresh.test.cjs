const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {refreshShopeeToken}=require('./token-refresh.cjs');
test('refresh signs correct path, preserves shop, rotates both tokens and sets expiry',async()=>{
 const old={access_token:'old',refresh_token:'r',shop_id:123};
 const token=await refreshShopeeToken({partnerId:99,partnerKey:'secret'},'https://partner.shopeemobile.com/api/v2',old,async(url,options)=>{
  assert.equal(url.pathname,'/api/v2/auth/access_token/get');
  assert.equal(url.searchParams.get('sign'),crypto.createHmac('sha256','secret').update(`99${url.pathname}${url.searchParams.get('timestamp')}`).digest('hex'));
  assert.deepEqual(JSON.parse(options.body),{partner_id:99,refresh_token:'r',shop_id:123});
  return {ok:true,json:async()=>({access_token:'new',refresh_token:'new-r',expire_in:14400})};
 });
 assert.equal(token.shop_id,123);assert.equal(token.refresh_token,'new-r');assert.ok(token.expired_at>Date.now()+3*3600000);
 await assert.rejects(refreshShopeeToken({partnerId:99,partnerKey:'secret'},'https://example.com/api/v2',old,async()=>({ok:true,json:async()=>({error:'invalid_token'})})));
});
test('refresh reports whitelist rejection without exposing upstream secrets', async()=>{
 await assert.rejects(refreshShopeeToken({partnerId:99,partnerKey:'secret'},'https://example.com/api/v2',{refresh_token:'private'},async()=>({ok:false,json:async()=>({error:'source_ip_undeclared',message:'private upstream data',access_token:'sensitive'})})),e=>e.code==='source_ip_undeclared'&&e.shopeeRefreshError&&e.message.includes('IP server')&&!e.message.includes('private')&&!e.message.includes('sensitive'));
});
test('whitelist diagnostic exposes only a valid source IPv4, never upstream message',async()=>{
 await assert.rejects(refreshShopeeToken({partnerId:99,partnerKey:'secret'},'https://example.com/api/v2',{refresh_token:'private'},async()=>({ok:false,json:async()=>({error:'source_ip_undeclared',message:'Request Source IP (208.77.246.241) is undeclared. sensitive'})})),e=>e.sourceIp==='208.77.246.241'&&!e.message.includes('sensitive'));
});
