const crypto = require('node:crypto');

async function checkIntegration({ sdk, config, fetchImpl = fetch, now = Date.now() }) {
  if (!config.appKey || !config.appSecret || !config.shopId) {
    return { status: 503, body: { ok: false, stage: 'configuration', error: 'Isi GINEE_APP_KEY, GINEE_APP_SECRET, dan GINEE_SHOP_ID.' } };
  }
  let orders;
  try {
    orders = await sdk.order.getOrderList({
      time_range_field: 'create_time', time_from: Math.floor(now / 1000) - 86400,
      time_to: Math.floor(now / 1000), page_size: 20,
    });
  } catch {
    return { status: 502, body: { ok: false, stage: 'shopee', error: 'Permintaan pesanan Shopee gagal.' } };
  }
  if (!orders || orders.error) return { status: 502, body: { ok: false, stage: 'shopee' } };
  const rows = orders.response?.order_list ?? orders.order_list;
  if (!Array.isArray(rows)) return { status: 502, body: { ok: false, stage: 'shopee', error: 'Format respons pesanan tidak dikenali.' } };
  const ids = [...new Set(rows.map(row => row.order_sn).filter(id => typeof id === 'string' && id.trim()))];
  if (!ids.length) return { status: 409, body: { ok: false, stage: 'sample', error: 'Tidak ada pesanan Shopee dalam 24 jam terakhir untuk diuji di Ginee.' } };
  const endpoint = '/openapi/v3/oms/order/item/batch-get';
  const signature = crypto.createHmac('sha256', config.appSecret).update(`POST$${endpoint}$`).digest('base64');
  try {
    const response = await fetchImpl(`https://api.ginee.com${endpoint}`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Advai-Country': 'ID', Authorization: `${config.appKey}:${signature}` },
      body: JSON.stringify({ externalOrderIds: ids, shopId: config.shopId }),
    });
    const data = await response.json();
    const ok = response.status === 200 && data?.code === 'SUCCESS';
    return { status: ok ? 200 : 502, body: {
      ok, stage: 'ginee', shopee: { ok: true, sentOrderCount: ids.length },
      ginee: { ok, httpStatus: response.status, code: data?.code ?? null,
        hasData: Array.isArray(data?.data) ? data.data.length > 0 : Boolean(data?.data && Object.keys(data.data).length) },
    } };
  } catch {
    return { status: 502, body: { ok: false, stage: 'ginee', error: 'Permintaan Ginee gagal atau respons bukan JSON.' } };
  }
}

module.exports = { checkIntegration };
