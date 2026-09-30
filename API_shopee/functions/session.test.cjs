const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = vm.createContext({ require, exports: {}, Buffer, URL, console, process });
vm.runInContext(fs.readFileSync(`${__dirname}/index.js`, 'utf8'), context);

test('session cookie is retained when OAuth state is cleared', () => {
  const result = vm.runInContext(`(() => {
    const headers = {};
    const res = { getHeader: name => headers[name], setHeader: (name, value) => { headers[name] = value; } };
    setCookie(res, STATE_COOKIE, 'signed-state');
    setCookie(res, SESSION_COOKIE, 'signed-token');
    clearCookie(res, STATE_COOKIE);
    const cookie = headers['Set-Cookie'].find(value => value.startsWith('__session='));
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

test('Hosting forwards OAuth state and opaque session through __session only', () => {
  const result = vm.runInContext(`(() => {
    const headers = {};
    const res = { getHeader: name => headers[name], setHeader: (name, value) => { headers[name] = value; } };
    setCookie(res, SESSION_COOKIE, 'a'.repeat(64));
    setCookie(res, STATE_COOKIE, 'signed-state');
    const cookie = headers['Set-Cookie'][0];
    const incoming = parseCookies({ headers: { cookie: cookie.split(';')[0] } });
    res.shopeeCookieBundle = { [STATE_COOKIE]: incoming[STATE_COOKIE], [SESSION_COOKIE]: incoming[SESSION_COOKIE] };
    clearCookie(res, STATE_COOKIE);
    const final = headers['Set-Cookie'][0];
    const parsed = parseCookies({ headers: { cookie: final.split(';')[0] } });
    return { initial: incoming[STATE_COOKIE], token: parsed[SESSION_COOKIE], state: parsed[STATE_COOKIE], final };
  })()`, context);
  assert.equal(result.initial, 'signed-state');
  assert.equal(result.token, 'a'.repeat(64));
  assert.equal(result.state, undefined);
  assert.match(result.final, /^__session=/);
  assert.match(result.final, /HttpOnly; Secure; SameSite=Lax/);
});
