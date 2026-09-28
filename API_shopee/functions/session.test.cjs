const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = vm.createContext({ require, exports: {}, Buffer, URL, console, process });
vm.runInContext(fs.readFileSync(`${__dirname}/index.js`, 'utf8'), context);

test('Hosting session retains token when OAuth state is cleared', () => {
  const result = vm.runInContext(`(() => {
    const headers = {};
    const res = { setHeader: (name, value) => { headers[name] = value; } };
    setCookie(res, STATE_COOKIE, 'signed-state');
    setCookie(res, SESSION_COOKIE, 'signed-token');
    clearCookie(res, STATE_COOKIE);
    const cookie = headers['Set-Cookie'][0];
    const parsed = parseCookies({ headers: { cookie: cookie.split(';')[0] } });
    return { cookie, state: parsed[STATE_COOKIE], token: parsed[SESSION_COOKIE] };
  })()`, context);
  assert.equal(result.state, undefined);
  assert.equal(result.token, 'signed-token');
  assert.match(result.cookie, /Path=\/shopee;/);
});

test('canonical page and callback route normalize consistently', () => {
  for (const [path, expected] of [['/shopee', '/'], ['/shopee/', '/'], ['/shopee/callback', '/callback']]) {
    context.route = path;
    assert.equal(vm.runInContext('normalizeRequestPath({path: route})', context), expected);
  }
});

test('callback without OAuth state is rejected before token exchange', async () => {
  context.process = { env: {
      SHOPEE_PARTNER_ID: '123', SHOPEE_PARTNER_KEY: 'test',
      SHOPEE_REDIRECT_URL: 'https://example.com/shopee/callback'
  } };
  await assert.rejects(vm.runInContext(
    `handleCallback({query: {code: 'test'}, headers: {}}, {})`, context
  ), /State OAuth tidak ditemukan/);
});
