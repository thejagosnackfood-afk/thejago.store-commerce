const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function fixture(readFails = false) {
  let refreshes = 0;
  const old = { access_token: 'old-access', refresh_token: 'old-refresh', shop_id: 59604858, expired_at: 1 };
  const store = { get: async () => { if (readFails) throw Error('Storage unavailable'); return old; }, document: id => id, refreshDocument: async () => { refreshes++; throw Error('Refresh rejected'); } };
  const context = vm.createContext({ Buffer, URL, console, exports: {}, process: { env: { SHOPEE_TOKEN_STORAGE: 'firestore', SHOPEE_PARTNER_ID: '123', SHOPEE_PARTNER_KEY: 'test', SHOPEE_REDIRECT_URL: 'https://example.com/shopee/callback' } }, require: name => name === './cloud-token-store.cjs' ? { createCloudTokenStore: () => store } : require(name) });
  vm.runInContext(fs.readFileSync(`${__dirname}/index.js`, 'utf8'), context);
  vm.runInContext(`createShopeeSdk = async () => ({ getAuthorizationUrl: (redirect, {state}) => 'https://open.shopee.com/auth?state=' + encodeURIComponent(state) });`, context);
  const headers = {};
  context.req = { headers: {} };
  context.res = { getHeader: k => headers[k], setHeader: (k, v) => { headers[k] = v; } };
  return { context, headers, refreshes: () => refreshes };
}
test('expired stored token cannot prevent fresh OAuth URL and state cookie', async () => {
  const f = fixture();
  const model = await vm.runInContext('buildAuthModel(req, res)', f.context);
  assert.match(model.authUrl, /^https:\/\/open.shopee.com\/auth\?state=.+/);
  assert.ok(f.headers['Set-Cookie'].some(x => x.startsWith('__session=')));
  assert.equal(f.refreshes(), 0);
  assert.equal(model.tokenStatus.expiredAt, 1);
  assert.ok(!JSON.stringify(model).includes('old-access'));
  await assert.rejects(vm.runInContext('createSdkContext(req, res)', f.context), /Refresh rejected/);
  assert.equal(f.refreshes(), 1);
});
test('OAuth URL remains available when old session storage read fails', async () => {
  const f = fixture(true);
  const model = await vm.runInContext('buildAuthModel(req, res)', f.context);
  assert.match(model.authUrl, /state=/);
  assert.equal(model.tokenStatus.exists, false);
  assert.equal(f.refreshes(), 0);
});
