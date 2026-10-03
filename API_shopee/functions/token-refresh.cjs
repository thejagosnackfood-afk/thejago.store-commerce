const crypto = require('node:crypto');
function sourceIpFrom(message) {
  const ip = String(message || '').match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
  return ip && ip.split('.').every(part => Number(part) <= 255) ? ip : undefined;
}
async function refreshShopeeToken(config, baseUrl, old, request = fetch) {
  const url = new URL(`${baseUrl}/auth/access_token/get`);
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHmac('sha256', config.partnerKey).update(`${config.partnerId}${url.pathname}${timestamp}`).digest('hex');
  url.search = new URLSearchParams({ partner_id: String(config.partnerId), timestamp: String(timestamp), sign }).toString();
  const response = await request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ partner_id: config.partnerId, refresh_token: old.refresh_token, ...(old.shop_id ? { shop_id: old.shop_id } : { merchant_id: old.merchant_id }) }),
  });
  const token = await response.json();
  if (!response.ok || token.error || !token.access_token || !token.refresh_token || !(Number(token.expire_in) > 0)) {
    const code = typeof token.error === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(token.error) ? token.error : 'invalid_refresh_response';
    const isIp = code === 'source_ip_undeclared' || response.status === 403;
    const error = new Error(isIp
      ? 'Shopee menolak IP server konektor. Daftarkan IP keluar server di whitelist aplikasi Shopee Open Platform, lalu ulangi sinkronisasi. Login Google tidak perlu diulang.'
      : 'Refresh token Shopee gagal. Hubungkan ulang toko melalui halaman konektor, lalu ulangi sinkronisasi.');
    error.status = response.status;
    error.code = code;
    let reason = typeof token.message === 'string' ? token.message : '';
    for (const secret of [config.partnerKey, old.access_token, old.refresh_token, token.access_token, token.refresh_token]) {
      if (typeof secret === 'string' && secret) reason = reason.split(secret).join('[redacted]');
    }
    error.upstreamReason = reason.slice(0, 400);
    error.sourceIp = sourceIpFrom(reason);
    error.shopeeRefreshError = true;
    throw error;
  }
  return { ...old, ...token, expired_at: Date.now() + Number(token.expire_in) * 1000 - 60000 };
}
module.exports = { refreshShopeeToken };
