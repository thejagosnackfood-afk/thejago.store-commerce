const crypto = require('node:crypto');
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
    throw new Error('Refresh Shopee gagal; periksa izin aplikasi atau otorisasi ulang jika token telah dicabut.');
  }
  return { ...old, ...token, expired_at: Date.now() + Number(token.expire_in) * 1000 - 60000 };
}
module.exports = { refreshShopeeToken };
