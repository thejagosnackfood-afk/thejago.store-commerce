const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyDashboardUser, handleDashboard } = require('./dashboard-api.cjs');
process.env.SHOPEE_DASHBOARD_OWNER_EMAIL = 'thejagosnackfood@gmail.com';
const owner = { uid: 'test-owner', email: 'thejagosnackfood@gmail.com', email_verified: true, firebase: { sign_in_provider: 'google.com' } };
test('allows a verified Google owner after token verification', async () => {
  let verified = false;
  const user = await verifyDashboardUser('test-token', async token => { assert.equal(token, 'test-token'); verified = true; return owner; });
  assert.equal(verified, true); assert.equal(user.uid, owner.uid);
});
test('rejects other accounts, unverified emails and other providers', async () => {
  for (const claims of [{ ...owner, email: 'other@example.com' }, { ...owner, email_verified: false }, { ...owner, firebase: { sign_in_provider: 'password' } }]) {
    await assert.rejects(verifyDashboardUser('test', async () => claims), { status: 403 });
  }
});
test('rejects expired and revoked tokens, separates server permission errors', async () => {
  for (const [code, status] of [['auth/id-token-expired', 401], ['auth/id-token-revoked', 401], ['auth/insufficient-permission', 503]]) {
    await assert.rejects(verifyDashboardUser('test', async () => { throw Object.assign(new Error('private upstream detail'), { code }); }), e => e.status === status && !e.message.includes('private upstream detail'));
  }
});
test('API denies missing credentials and unapproved origins before data access', async () => {
  process.env.SHOPEE_PANEL_ORIGIN = 'https://thejago-commerce-panel.web.app';
  for (const [headers, expected] of [[{}, 401], [{ origin: 'https://untrusted.example' }, 403]]) {
    const res = { set() { return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    for (const path of ['/me', '/master', '/master/csv/commit', '/master/update']) {
      await handleDashboard({ headers, method: path.endsWith('commit') || path.endsWith('update') ? 'POST' : 'GET' }, res, path);
      assert.equal(res.code, expected); assert.ok(res.body.error);
    }
  }
});
