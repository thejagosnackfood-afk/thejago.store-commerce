const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { checkIntegration } = require('./integration');

const config = { appKey: 'sample-key', appSecret: 'sample-secret', shopId: 'sample-shop' };
const sdk = { order: { getOrderList: async () => ({ response: { order_list: [{ order_sn: 'SAMPLE-001' }] } }) } };
const success = async (url, options) => {
  assert.equal(url, 'https://api.ginee.com/openapi/v3/oms/order/item/batch-get');
  assert.deepEqual(JSON.parse(options.body), { externalOrderIds: ['SAMPLE-001'], shopId: 'sample-shop' });
  assert.match(options.headers.Authorization, /^sample-key:/);
  return { status: 200, json: async () => ({ code: 'SUCCESS', data: [{ orderId: 'sample-ginee-order' }] }) };
};

test('Python client receives sample HTTP 200 through the shared bridge', async () => {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/shopee/api/integration/check') {
      res.writeHead(404).end(); return;
    }
    const result = await checkIntegration({ sdk, config, fetchImpl: success });
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...result.body, mode: 'sample', liveVerified: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn('python3', [path.resolve(__dirname, '../../sample database csv/test_ginee_api.py'),
        '--connector-url', `http://127.0.0.1:${server.address().port}/shopee`]);
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(output)));
    });
    assert.match(output, /HTTP Status\] 200/);
    assert.match(output, /"ok": true/);
    console.log(output);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('HTTP 200 with Ginee rejection is not a successful integration', async () => {
  const result = await checkIntegration({ sdk, config, fetchImpl: async () => ({ status: 200, json: async () => ({ code: 'IAM_FAILED' }) }) });
  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
});

test('missing credentials and empty orders never report connected', async () => {
  assert.equal((await checkIntegration({ sdk, config: {} })).status, 503);
  const empty = { order: { getOrderList: async () => ({ response: { order_list: [] } }) } };
  assert.equal((await checkIntegration({ sdk: empty, config })).status, 409);
});
