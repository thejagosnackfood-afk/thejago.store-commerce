const crypto = require('crypto');
const functions = require('firebase-functions');
const { LocalTokenStore } = require('./local-token-store.cjs');
const LOCAL_MODE = process.env.SHOPEE_LOCAL_MODE === 'true';
const CLOUD_MODE = process.env.SHOPEE_TOKEN_STORAGE === 'firestore' && !LOCAL_MODE;
const { createCloudTokenStore } = require('./cloud-token-store.cjs');
const { refreshShopeeToken } = require('./token-refresh.cjs');

const DEFAULT_SHOPEE_REGION = 'GLOBAL';
const SUPPORTED_REGIONS = new Set(['GLOBAL', 'CHINA', 'BRAZIL', 'TEST_GLOBAL', 'TEST_CHINA']);
const SHOPEE_BASE_URLS = {
  GLOBAL: 'https://partner.shopeemobile.com/api/v2',
  CHINA: 'https://openplatform.shopee.cn/api/v2',
  BRAZIL: 'https://openplatform.shopee.com.br/api/v2',
  TEST_GLOBAL: 'https://openplatform.sandbox.test-stable.shopee.sg/api/v2',
  TEST_CHINA: 'https://openplatform.test-stable.shopee.cn/api/v2',
};
const SHOPEE_AUTH_URLS = {
  GLOBAL: 'https://open.shopee.com/auth',
  CHINA: 'https://open.shopee.cn/auth',
  BRAZIL: 'https://open.shopee.com.br/auth',
  TEST_GLOBAL: 'https://open.sandbox.test-stable.shopee.com/auth',
  TEST_CHINA: 'https://open.sandbox.test-stable.shopee.cn/auth',
};
const STATE_COOKIE = 'shopee_oauth_state';
const SESSION_COOKIE = 'shopee_oauth_session';
const STATE_MAX_AGE_SECONDS = 10 * 60;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function readSetting(envKey, fallback = null) {
  const envValue = process.env[envKey];

  if (typeof envValue === 'string' && envValue.trim() !== '') {
    return envValue.trim();
  }

  return fallback;
}

function requiredSetting(envKey, message) {
  const value = readSetting(envKey);

  if (value === null) {
    throw new Error(message);
  }

  return value;
}

function normalizeUrl(url, message = 'SHOPEE_REDIRECT_URL harus berupa URL valid.') {
  try {
    return new URL(url).toString();
  } catch {
    throw new Error(message);
  }
}

function parseOptionalPositiveInt(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }

  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized) || Number(normalized) <= 0) {
    throw new Error(`${label} harus berupa angka positif.`);
  }

  return Number(normalized);
}

function parseOptionalInteger(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }

  const normalized = String(value).trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`${label} harus berupa angka bulat.`);
  }

  return Number(normalized);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function loadShopeeConfig() {
  const partnerId = requiredSetting(
    'SHOPEE_PARTNER_ID',
    'Environment variable SHOPEE_PARTNER_ID belum diatur.'
  );

  if (!/^\d+$/.test(partnerId) || Number(partnerId) <= 0) {
    throw new Error('SHOPEE_PARTNER_ID harus berupa angka positif.');
  }

  const region = (readSetting('SHOPEE_REGION', DEFAULT_SHOPEE_REGION) || DEFAULT_SHOPEE_REGION).toUpperCase();
  if (!SUPPORTED_REGIONS.has(region)) {
    throw new Error(`SHOPEE_REGION tidak didukung: ${region}`);
  }

  return {
    partnerId: Number(partnerId),
    partnerKey: requiredSetting(
      'SHOPEE_PARTNER_KEY',
      'Environment variable SHOPEE_PARTNER_KEY belum diatur.'
    ),
    redirectUrl: normalizeUrl(
      requiredSetting(
        'SHOPEE_REDIRECT_URL',
        'Environment variable SHOPEE_REDIRECT_URL belum diatur.'
      )
    ),
    region,
  };
}

function base64UrlEncode(value) {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function signValue(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function encodeSignedPayload(payload, secret) {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = signValue(secret, encoded);
  return `${encoded}.${signature}`;
}

function decodeSignedPayload(token, secret, label) {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new Error(`${label} tidak valid.`);
  }

  const [encoded, signature] = token.split('.', 2);
  const expected = signValue(secret, encoded);
  const actualBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error(`${label} signature tidak valid.`);
  }

  try {
    return JSON.parse(base64UrlDecode(encoded));
  } catch {
    throw new Error(`${label} payload tidak valid.`);
  }
}

function parseCookies(req) {
  const cookieHeader = req.headers && req.headers.cookie ? req.headers.cookie : '';
  const cookies = {};

  for (const part of String(cookieHeader).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    cookies[name] = decodeURIComponent(value);
  }

  if (cookies.__session) {
    try {
      const bundle = JSON.parse(base64UrlDecode(cookies.__session));
      for (const name of [STATE_COOKIE, SESSION_COOKIE]) {
        if (typeof bundle[name] === 'string') cookies[name] = bundle[name];
      }
    } catch { /* Invalid cookies are treated as missing sessions. */ }
  }
  return cookies;
}

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookieValue]);
    return;
  }

  const next = Array.isArray(existing) ? existing.concat(cookieValue) : [existing, cookieValue];
  res.setHeader('Set-Cookie', next);
}

function setCookie(res, name, value, options = {}) {
  if (!LOCAL_MODE && (name === STATE_COOKIE || name === SESSION_COOKIE)) {
    const bundle = res.shopeeCookieBundle || (res.shopeeCookieBundle = {});
    if (options.maxAge === 0) delete bundle[name];
    else bundle[name] = value;
    const headers = res.getHeader('Set-Cookie');
    const existing = Array.isArray(headers) ? headers : headers ? [headers] : [];
    res.setHeader('Set-Cookie', existing.filter(cookie => !cookie.startsWith('__session=')));
    return setCookie(res, '__session', base64UrlEncode(JSON.stringify(bundle)), {
      maxAge: Object.keys(bundle).length ? SESSION_MAX_AGE_SECONDS : 0,
    });
  }
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || '/shopee'}`, 'HttpOnly', ...(LOCAL_MODE && !(process.env.SHOPEE_REDIRECT_URL || '').startsWith('https:') ? [] : ['Secure']), 'SameSite=Lax'];

  if (typeof options.maxAge === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }

  appendSetCookie(res, parts.join('; '));
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

function buildStateToken(config) {
  const issuedAt = Date.now();
  return encodeSignedPayload(
    {
      nonce: crypto.randomBytes(16).toString('hex'),
      issuedAt,
      expiresAt: issuedAt + STATE_MAX_AGE_SECONDS * 1000,
    },
    config.partnerKey
  );
}

function buildSessionToken(token, config) {
  return encodeSignedPayload(
    {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expire_in: token.expire_in,
      expired_at: token.expired_at ?? null,
      shop_id: token.shop_id ?? null,
      merchant_id: token.merchant_id ?? null,
      request_id: token.request_id ?? null,
      saved_at: Date.now(),
    },
    config.partnerKey
  );
}

function readStateFromCookie(req, config) {
  const cookies = parseCookies(req);
  const rawValue = cookies[STATE_COOKIE];

  if (!rawValue) {
    return null;
  }

  return decodeSignedPayload(rawValue, config.partnerKey, 'OAuth state');
}

function readSessionFromCookie(req, config) {
  const cookies = parseCookies(req);
  const rawValue = cookies[SESSION_COOKIE];

  if (!rawValue) {
    return null;
  }

  return decodeSignedPayload(rawValue, config.partnerKey, 'OAuth session');
}

function readSeedTokenFromEnv() {
  const accessToken = readSetting('SHOPEE_ACCESS_TOKEN');
  const refreshToken = readSetting('SHOPEE_REFRESH_TOKEN');

  if (!accessToken || !refreshToken) {
    return null;
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expire_in: parseOptionalInteger(readSetting('SHOPEE_TOKEN_EXPIRE_IN'), 'SHOPEE_TOKEN_EXPIRE_IN') ?? 0,
    expired_at: parseOptionalInteger(readSetting('SHOPEE_TOKEN_EXPIRED_AT'), 'SHOPEE_TOKEN_EXPIRED_AT'),
    shop_id: parseOptionalPositiveInt(readSetting('SHOPEE_SHOP_ID'), 'SHOPEE_SHOP_ID'),
    merchant_id: parseOptionalPositiveInt(readSetting('SHOPEE_MERCHANT_ID'), 'SHOPEE_MERCHANT_ID'),
    request_id: null,
  };
}

class RequestTokenStorage {
  constructor(req, res, config) {
    this.req = req;
    this.res = res;
    this.config = config;
    this.cachedToken = null;
    this.cachedSource = null;
    if (LOCAL_MODE || CLOUD_MODE) {
      this.local = CLOUD_MODE ? createCloudTokenStore(config.partnerKey) : new LocalTokenStore(require('node:path').join(__dirname, '../.local/tokens'), process.env.SHOPEE_LOCAL_KEY);
      const id = parseCookies(req)[SESSION_COOKIE];
      this.localId = /^[a-f0-9]{64}$/.test(id || '') ? id : crypto.randomBytes(32).toString('hex');
    }
  }

  async get({ refresh = true } = {}) {
    if (this.cachedToken) {
      return this.cachedToken;
    }

    if (this.local) {
      this.cachedToken = await this.local.get(this.localId);
      if (CLOUD_MODE && this.cachedToken && refresh) {
        this.cachedToken = await this.local.refreshDocument(this.local.document(this.localId),
          old => refreshShopeeToken(this.config, SHOPEE_BASE_URLS[this.config.region], old));
      }
      this.cachedSource = this.cachedToken ? (CLOUD_MODE ? 'firestore_encrypted' : 'local_encrypted_file') : 'none';
      return this.cachedToken;
    }
    const cookieToken = readSessionFromCookie(this.req, this.config);
    if (cookieToken && typeof cookieToken.access_token === 'string' && typeof cookieToken.refresh_token === 'string') {
      this.cachedToken = cookieToken;
      this.cachedSource = 'cookie';
      return cookieToken;
    }

    const envToken = readSeedTokenFromEnv();
    if (envToken) {
      this.cachedToken = envToken;
      this.cachedSource = 'env';
      return envToken;
    }

    this.cachedSource = 'none';
    return null;
  }

  async store(token) {
    if (this.local) {
      await this.local.store(this.localId, token);
      setCookie(this.res, SESSION_COOKIE, this.localId, { maxAge: SESSION_MAX_AGE_SECONDS });
      this.cachedToken = token;
      this.cachedSource = (CLOUD_MODE ? 'firestore_encrypted' : 'local_encrypted_file');
      return;
    }
    this.cachedToken = token;
    this.cachedSource = 'cookie';
    setCookie(this.res, SESSION_COOKIE, buildSessionToken(token, this.config), {
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  }

  async clear() {
    if (this.local) await this.local.clear(this.localId);
    this.cachedToken = null;
    this.cachedSource = 'none';
    clearCookie(this.res, SESSION_COOKIE);
  }

  async getStatus(options) {
    const token = await this.get(options);
    return {
      source: this.cachedSource || 'none',
      token,
    };
  }
}

async function createShopeeSdk(config, tokenStorage, token) {
  const { default: ShopeeSDK } = await import('@congminh1254/shopee-sdk');

  const sdk = new ShopeeSDK(
    {
      partner_id: config.partnerId,
      partner_key: config.partnerKey,
      base_url: SHOPEE_BASE_URLS[config.region],
      base_auth_url: SHOPEE_AUTH_URLS[config.region],
      shop_id: token && token.shop_id ? token.shop_id : undefined,
    },
    tokenStorage
  );
  if (CLOUD_MODE) {
    sdk.refreshToken = async () => {
      const expected = tokenStorage.cachedToken?.access_token;
      const next = await tokenStorage.local.refreshDocument(tokenStorage.local.document(tokenStorage.localId),
        old => refreshShopeeToken(config, SHOPEE_BASE_URLS[config.region], old), expected);
      tokenStorage.cachedToken = next;
      return next;
    };
  }
  return sdk;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderJson(res, statusCode, payload) {
  res.status(statusCode).set('Content-Type', 'application/json; charset=UTF-8').send(payload);
}

function renderPage(res, statusCode, title, body) {
  res.status(statusCode).set('Content-Type', 'text/html; charset=UTF-8').send(`<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f7fb;
      --panel: #ffffff;
      --text: #15202b;
      --muted: #5f6b7a;
      --line: #d8e1ea;
      --accent: #ee4d2d;
      --accent-soft: rgba(238, 77, 45, 0.12);
      --ok-soft: rgba(22, 163, 74, 0.12);
      --ok-text: #166534;
      --error-soft: rgba(220, 38, 38, 0.12);
      --error-text: #991b1b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(238, 77, 45, 0.12), transparent 30%),
        linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
      color: var(--text);
      min-height: 100vh;
      padding: 28px;
    }
    main {
      max-width: 1024px;
      margin: 0 auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: 0 24px 60px rgba(21, 32, 43, 0.10);
      overflow: hidden;
    }
    header {
      padding: 28px 28px 18px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(135deg, rgba(238, 77, 45, 0.08), rgba(255, 255, 255, 0));
    }
    h1 {
      margin: 0;
      font-size: 30px;
      letter-spacing: -0.02em;
    }
    p {
      margin: 10px 0 0;
      color: var(--muted);
      line-height: 1.55;
    }
    .content {
      padding: 28px;
      display: grid;
      gap: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
      background: #fff;
    }
    .label {
      display: block;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .value, code {
      font: 14px/1.6 Consolas, Monaco, monospace;
      word-break: break-word;
    }
    code {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 2px 6px;
    }
    .status {
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid transparent;
      font-size: 14px;
      line-height: 1.5;
    }
    .status.ok {
      background: var(--ok-soft);
      color: var(--ok-text);
      border-color: rgba(22, 163, 74, 0.22);
    }
    .status.info {
      background: var(--accent-soft);
      color: #7a2f1c;
      border-color: rgba(238, 77, 45, 0.22);
    }
    .status.error {
      background: var(--error-soft);
      color: var(--error-text);
      border-color: rgba(220, 38, 38, 0.22);
    }
    a.button {
      display: inline-block;
      text-decoration: none;
      border-radius: 999px;
      padding: 12px 18px;
      font-weight: 700;
      font-size: 14px;
      background: var(--accent);
      color: #fff;
    }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    ul {
      margin: 0;
      padding-left: 20px;
      line-height: 1.6;
    }
    @media (max-width: 760px) {
      body { padding: 16px; }
      .grid { grid-template-columns: 1fr; }
      header, .content { padding: 20px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(title)}</h1>
      <p>Flow ini memakai <code>shopee-sdk</code> dengan state-protected OAuth, penyimpanan sesi server, auto refresh token, dan endpoint helper untuk shop, orders, serta products.</p>
    </header>
    <div class="content">
      ${body}
    </div>
  </main>
</body>
</html>`);
}

function renderHome(res, model) {
  renderPage(
    res,
    200,
    'Shopee Open Platform Console',
    `${LOCAL_MODE ? setupGuide() : ""}<div class="status info">Mulai OAuth lewat tombol di bawah. Setelah authorize sukses, endpoint helper siap dipakai tanpa menampilkan token mentah di browser.</div>
    <div class="grid">
      <div class="card">
        <span class="label">Partner ID</span>
        <div class="value">${escapeHtml(model.partnerId)}</div>
      </div>
      <div class="card">
        <span class="label">Region</span>
        <div class="value">${escapeHtml(model.region)}</div>
      </div>
      <div class="card">
        <span class="label">Redirect URL</span>
        <div class="value">${escapeHtml(model.redirectUrl)}</div>
      </div>
      <div class="card">
        <span class="label">Token Source</span>
        <div class="value">${escapeHtml(model.tokenSource)}</div>
      </div>
    </div>
    <div class="card">
      <span class="label">Authorization URL</span>
      <div class="value">${escapeHtml(model.authUrl)}</div>
    </div>
    <div class="actions">
      <a class="button" href="${escapeHtml(model.authUrl)}" target="_blank" rel="noopener">Start OAuth</a>
      <a class="button" href="/shopee/api/shopee-auth" target="_blank" rel="noopener" style="background:#111827;">View Auth JSON</a>
      <a class="button" href="/shopee/api/shopee-token-status" target="_blank" rel="noopener" style="background:#374151;">Token Status</a>
    </div>
    <form method="post" action="/shopee/api/logout"><button type="submit">Hapus sesi Shopee</button></form>
    <div class="card">
      <span class="label">API Helper Endpoints</span>
      <ul>
        <li><code>/shopee/api/shop/info</code></li>
        <li><code>/shopee/api/orders?page_size=20</code></li>
        <li><code>/shopee/api/products?offset=0&page_size=20&amp;item_status=NORMAL</code></li>
      </ul>
    </div>`
  );
}

function renderCallbackSuccess(res, model) {
  renderPage(
    res,
    200,
    'Shopee OAuth Berhasil',
    `<div class="status ok">Token sudah disimpan ke penyimpanan sesi server untuk browser ini. Token mentah sengaja tidak ditampilkan.</div>
    <div class="grid">
      <div class="card">
        <span class="label">Shop ID</span>
        <div class="value">${escapeHtml(model.shopId ?? '-')}</div>
      </div>
      <div class="card">
        <span class="label">Merchant ID</span>
        <div class="value">${escapeHtml(model.merchantId ?? '-')}</div>
      </div>
      <div class="card">
        <span class="label">Expire In</span>
        <div class="value">${escapeHtml(model.expireIn ?? '-')}</div>
      </div>
      <div class="card">
        <span class="label">Request ID</span>
        <div class="value">${escapeHtml(model.requestId ?? '-')}</div>
      </div>
    </div>
    <div class="actions">
      <a class="button" href="/shopee/api/shop/info" rel="noopener">Test Shop Info</a>
      <a class="button" href="/shopee/api/orders?page_size=20" rel="noopener" style="background:#111827;">Test Orders</a>
      <a class="button" href="/shopee" rel="noopener" style="background:#374151;">Back to Console</a>
    </div>`
  );
}

function renderError(res, statusCode, message) {
  renderPage(
    res,
    statusCode,
    'Shopee OAuth Error',
    `<div class="status error">${escapeHtml(message)}</div>`
  );
}

function requireToken(token) {
  if (!token || typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string') {
    throw new Error('Token Shopee belum tersedia. Jalankan OAuth dulu atau isi token seed di .env.');
  }
}

function normalizeTokenSummary(token, source) {
  return {
    exists: Boolean(token),
    source,
    shopId: token && typeof token.shop_id === 'number' ? token.shop_id : null,
    merchantId: token && typeof token.merchant_id === 'number' ? token.merchant_id : null,
    expiredAt: token && typeof token.expired_at === 'number' ? token.expired_at : null,
    hasAccessToken: Boolean(token && token.access_token),
    hasRefreshToken: Boolean(token && token.refresh_token),
  };
}

function asBoolean(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}

function buildSampleProduct(index, options) {
  const suffix = String(index).padStart(2, '0');
  const namePrefix = options.namePrefix || 'JAGO Sandbox Produk';
  const skuPrefix = options.skuPrefix || 'JAGO-SANDBOX';
  const imageId = options.imageId || '-';
  const logisticId = options.logisticId || 4000;

  return {
    original_price: options.price + index * 1000,
    description: `${namePrefix} ${suffix}. Produk test dibuat otomatis lewat Shopee Open API sandbox.`,
    weight: options.weight,
    item_name: `${namePrefix} ${suffix}`,
    item_status: 'UNLIST',
    dimension: {
      package_height: options.height,
      package_length: options.length,
      package_width: options.width,
    },
    logistic_info: [
      {
        enabled: true,
        logistic_id: logisticId,
        is_free: false,
      },
    ],
    category_id: options.categoryId,
    image: {
      image_id_list: [imageId],
    },
    pre_order: {
      is_pre_order: false,
      days_to_ship: 2,
    },
    item_sku: `${skuPrefix}-${Date.now()}-${suffix}`,
    condition: 'NEW',
    brand: {
      brand_id: 0,
      original_brand_name: options.brandName || 'No Brand',
    },
    item_dangerous: 0,
    normal_stock: options.stock,
    seller_stock: [
      {
        stock: options.stock,
      },
    ],
  };
}

async function buildAuthModel(req, res) {
  const config = loadShopeeConfig();
  const tokenStorage = new RequestTokenStorage(req, res, config);
  // Reauthorization must remain available even when the existing token cannot refresh.
  // This summary describes stored credentials, not a verified live connection.
  let status = { token: null, source: 'none' };
  try { status = await tokenStorage.getStatus({ refresh: false }); }
  catch { /* A failed session read must not prevent starting a new OAuth flow. */ }
  const sdk = await createShopeeSdk(config, tokenStorage, status.token);
  const state = buildStateToken(config);

  setCookie(res, STATE_COOKIE, state, { maxAge: STATE_MAX_AGE_SECONDS });

  return {
    config,
    authUrl: sdk.getAuthorizationUrl(config.redirectUrl, { state }),
    tokenStatus: normalizeTokenSummary(status.token, status.source),
  };
}

async function createSdkContext(req, res) {
  const config = loadShopeeConfig();
  const tokenStorage = new RequestTokenStorage(req, res, config);
  const status = await tokenStorage.getStatus();
  const sdk = await createShopeeSdk(config, tokenStorage, status.token);

  return {
    config,
    sdk,
    tokenStorage,
    token: status.token,
    tokenSource: status.source,
  };
}

async function handleAuthApi(req, res) {
  const { config, authUrl, tokenStatus } = await buildAuthModel(req, res);
  return renderJson(res, 200, {
    partnerId: config.partnerId,
    region: config.region,
    redirectUrl: config.redirectUrl,
    mode: 'sdk_session_oauth',
    tokenStatus,
    authUrl,
  });
}

async function handleTokenStatus(req, res) {
  const { token, tokenSource } = await createSdkContext(req, res);
  return renderJson(res, 200, normalizeTokenSummary(token, tokenSource));
}

async function handleCallback(req, res) {
  const code = req.query && typeof req.query.code === 'string' ? req.query.code.trim() : '';
  if (!code) {
    throw new Error('Parameter code tidak ditemukan pada callback Shopee.');
  }

  const config = loadShopeeConfig();
  const rawState = req.query && typeof req.query.state === 'string' ? req.query.state.trim() : '';
  const cookieState = parseCookies(req)[STATE_COOKIE];
  let stateVerified = false;

  if (!rawState || !cookieState) throw new Error('State OAuth tidak ditemukan. Mulai ulang OAuth dari console.');

  if (rawState) {
    if (!cookieState) {
      throw new Error('State cookie OAuth tidak ditemukan. Mulai ulang OAuth dari console.');
    }

    readStateFromCookie(req, config);

    if (rawState !== cookieState) {
      throw new Error('State OAuth tidak cocok. Mulai ulang OAuth dari console.');
    }

    const decodedState = decodeSignedPayload(rawState, config.partnerKey, 'OAuth state');
    if (
      !decodedState ||
      typeof decodedState.expiresAt !== 'number' ||
      decodedState.expiresAt < Date.now()
    ) {
      throw new Error('State OAuth sudah expired. Mulai ulang OAuth dari console.');
    }

    stateVerified = true;
  }

  const shopId = parseOptionalPositiveInt(req.query && req.query.shop_id, 'shop_id');
  const merchantId = parseOptionalPositiveInt(
    req.query && (req.query.main_account_id ?? req.query.merchant_id),
    'merchant_id'
  );
  const tokenStorage = new RequestTokenStorage(req, res, config);
  const sdk = await createShopeeSdk(config, tokenStorage, { shop_id: shopId, merchant_id: merchantId });
  const token = await sdk.authenticateWithCode(code, shopId, merchantId);

  clearCookie(res, STATE_COOKIE);

  const payload = {
    ok: true,
    shopId: token.shop_id ?? shopId ?? null,
    merchantId: token.merchant_id ?? merchantId ?? null,
    expireIn: token.expire_in,
    expiredAt: token.expired_at ?? null,
    requestId: token.request_id ?? null,
    tokenStored: CLOUD_MODE ? 'firestore_encrypted' : LOCAL_MODE ? 'local_encrypted_file' : 'signed_session_cookie',
    stateVerified,
  };

  if ((req.accepts && req.accepts('json')) || String(req.headers.accept || '').includes('application/json')) {
    return renderJson(res, 200, payload);
  }

  const successRedirectUrl = normalizeUrl(
    readSetting('SHOPEE_SUCCESS_REDIRECT_URL', 'http://localhost:3000/')
  );
  return res.redirect(302, successRedirectUrl);
}

async function handleLogout(req, res) {
  const config = loadShopeeConfig();
  const tokenStorage = new RequestTokenStorage(req, res, config);
  await tokenStorage.clear();
  clearCookie(res, STATE_COOKIE);

  if ((req.accepts && req.accepts('json')) || String(req.headers.accept || '').includes('application/json')) {
    return renderJson(res, 200, { ok: true, message: 'Token session berhasil dihapus.' });
  }

  renderPage(res, 200, 'Logout Berhasil', `
    <div class="status ok">Token session berhasil dihapus. Akun sudah di-unlink dari browser ini.</div>
    <div class="actions">
      <a class="button" href="/shopee" rel="noopener">Kembali ke Console</a>
    </div>`
  );
}

async function handleShopInfo(req, res) {
  const { sdk, token, tokenSource } = await createSdkContext(req, res);
  requireToken(token);
  const data = await sdk.shop.getShopInfo();
  return renderJson(res, 200, {
    tokenSource,
    shopId: token.shop_id ?? null,
    data,
  });
}

async function handleOrders(req, res) {
  const { sdk, token, tokenSource } = await createSdkContext(req, res);
  requireToken(token);
  const now = Math.floor(Date.now() / 1000);
  const defaultTimeFrom = now - 24 * 60 * 60;
  const timeFrom = parseOptionalInteger(req.query && req.query.time_from, 'time_from') ?? defaultTimeFrom;
  const timeTo = parseOptionalInteger(req.query && req.query.time_to, 'time_to') ?? now;
  const pageSize = clamp(parseOptionalInteger(req.query && req.query.page_size, 'page_size') ?? 20, 1, 100);
  const cursor = req.query && typeof req.query.cursor === 'string' ? req.query.cursor.trim() : undefined;
  const orderStatus = req.query && typeof req.query.order_status === 'string' ? req.query.order_status.trim() : undefined;
  const responseOptionalFields =
    req.query && typeof req.query.response_optional_fields === 'string'
      ? req.query.response_optional_fields.trim()
      : undefined;

  const data = await sdk.order.getOrderList({
    time_range_field: 'create_time',
    time_from: timeFrom,
    time_to: timeTo,
    page_size: pageSize,
    cursor,
    order_status: orderStatus,
    response_optional_fields: responseOptionalFields,
  });

  return renderJson(res, 200, {
    tokenSource,
    shopId: token.shop_id ?? null,
    query: {
      time_from: timeFrom,
      time_to: timeTo,
      page_size: pageSize,
      cursor: cursor || null,
      order_status: orderStatus || null,
    },
    data,
  });
}

async function handleProducts(req, res) {
  const { sdk, token, tokenSource } = await createSdkContext(req, res);
  requireToken(token);
  const offset = clamp(parseOptionalInteger(req.query && req.query.offset, 'offset') ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const pageSize = clamp(parseOptionalInteger(req.query && req.query.page_size, 'page_size') ?? 20, 1, 100);
  const updateTimeFrom = parseOptionalInteger(req.query && req.query.update_time_from, 'update_time_from');
  const updateTimeTo = parseOptionalInteger(req.query && req.query.update_time_to, 'update_time_to');
  const itemStatus =
    req.query && typeof req.query.item_status === 'string' && req.query.item_status.trim()
      ? req.query.item_status
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : ['NORMAL'];
  const data = await sdk.product.getItemList({
    offset,
    page_size: pageSize,
    update_time_from: updateTimeFrom,
    update_time_to: updateTimeTo,
      item_status: itemStatus,
  });

  const itemRows = data.response?.item ?? [];
  const baseRows = [];
  for (let start = 0; start < itemRows.length; start += 50) {
    const itemIds = itemRows.slice(start, start + 50).map((item) => item.item_id);
    if (!itemIds.length) continue;
    const base = await sdk.product.getItemBaseInfo({ item_id_list: itemIds });
    baseRows.push(...(base.response?.item_list ?? []));
  }
  const baseById = new Map(baseRows.map((item) => [String(item.item_id), item]));
  const products = itemRows.map((row) => {
    const item = baseById.get(String(row.item_id)) || row;
    return {
      itemId: item.item_id,
      name: item.item_name || `Shopee item ${item.item_id}`,
      hasModel: Boolean(item.has_model),
      sku: item.item_sku || '',
      status: item.item_status || row.item_status || 'NORMAL',
      price: item.price_info?.[0]?.current_price ?? item.price_info?.[0]?.original_price ?? null,
      stock: item.stock_info_v2?.summary_info?.total_available_stock
        ?? item.stock_info_v2?.seller_stock?.reduce((sum, stock) => sum + (Number(stock.stock) || 0), 0)
        ?? null,
      image: item.image?.image_url_list?.[0] || null,
    };
  });

  return renderJson(res, 200, {
    tokenSource,
    shopId: token.shop_id ?? null,
    products,
    hasNextPage: Boolean(data.response?.has_next_page),
    nextOffset: data.response?.next_offset ?? null,
    query: {
      offset,
      page_size: pageSize,
      update_time_from: updateTimeFrom ?? null,
      update_time_to: updateTimeTo ?? null,
      item_status: itemStatus,
    },
    data,
  });
}

function handleProductSyncPage(req, res) {
  const panelOrigin = new URL(readSetting('SHOPEE_PANEL_ORIGIN', 'http://localhost:3000')).origin;
  return renderPage(res, 200, 'Sinkron Produk Shopee', `
    <div class="status info" id="sync-status">Mengambil produk Shopee…</div>
    <script>
      (async () => {
        const status = document.getElementById('sync-status');
        const allowedParentOrigin = ${JSON.stringify(panelOrigin)};
        const send = (payload) => window.opener?.postMessage({ type: 'shopee-products-sync', ...payload }, allowedParentOrigin);
        try {
          // Referrer is intentionally disabled by handleRequest; the parent validates
          // both this connector origin and the exact popup window before accepting data.
          if (!window.opener) throw new Error('Buka sinkronisasi dari panel Komplace.');
          const params = new URLSearchParams(location.search);
          if (params.get('action') === 'update') {
            const itemId = Number(params.get('itemId'));
            const price = Number(params.get('price'));
            const stock = Number(params.get('stock'));
            const response = await fetch('/shopee/api/products/update', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ itemId, price, stock }),
            });
            const result = await response.json();
            if (!response.ok || !result.ok) throw new Error(result.error || 'Shopee menolak perubahan produk.');
            send({ ok: true, action: 'update', itemId, result });
            status.className = 'status ok';
            status.textContent = 'Perubahan harga dan stok berhasil dikirim ke Shopee.';
            setTimeout(() => window.close(), 800);
            return;
          }
          const response = await fetch('/shopee/api/products?offset=0&page_size=100&item_status=NORMAL,UNLIST', { credentials: 'same-origin' });
          const result = await response.json();
          if (!response.ok || !Array.isArray(result.products)) throw new Error(result.error || 'Gagal mengambil produk. Pastikan OAuth Shopee sudah terhubung.');
          send({ ok: true, shopId: result.shopId, products: result.products, hasNextPage: result.hasNextPage });
          status.className = 'status ok';
          status.textContent = result.products.length + ' produk diterima panel. Jendela ini akan ditutup.';
          setTimeout(() => window.close(), 800);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Sinkronisasi gagal.';
          send({ ok: false, action: new URLSearchParams(location.search).get('action') || 'sync', error: message });
          status.className = 'status error';
          status.textContent = message + ' Buka halaman connector untuk menghubungkan ulang.';
        }
      })();
    </script>`);
}

async function handleUpdateProduct(req, res) {
  const config = loadShopeeConfig();
  if (req.method !== 'POST' || req.headers.origin !== new URL(config.redirectUrl).origin) {
    return renderJson(res, 403, { ok: false, error: 'Permintaan update harus berasal dari connector Shopee.' });
  }
  const { sdk, token } = await createSdkContext(req, res);
  requireToken(token);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const itemId = parseOptionalPositiveInt(body.itemId, 'itemId');
  const price = parseOptionalInteger(body.price, 'price');
  const stock = parseOptionalInteger(body.stock, 'stock');
  if (!itemId || price === undefined || price < 1 || stock === undefined || stock < 0) {
    return renderJson(res, 400, { ok: false, error: 'ID produk, harga positif, dan stok non-negatif wajib diisi.' });
  }

  const baseInfo = await sdk.product.getItemBaseInfo({ item_id_list: [itemId] });
  const item = baseInfo.response?.item_list?.[0];
  if (!item) return renderJson(res, 404, { ok: false, error: 'Produk tidak ditemukan di toko Shopee.' });
  if (item.has_model) return renderJson(res, 409, { ok: false, error: 'Produk bervariasi belum bisa diedit dari panel. Edit variasinya langsung di Shopee.' });

  let locationId = item.stock_info_v2?.seller_stock?.find((entry) => entry.location_id)?.location_id;
  if (!locationId) {
    const warehouses = await sdk.shop.getWarehouseDetail({ warehouse_type: 1 });
    locationId = warehouses.response?.find((entry) => entry.location_id)?.location_id;
  }
  if (!locationId) return renderJson(res, 409, { ok: false, error: 'Lokasi gudang Shopee tidak ditemukan; stok tidak diubah.' });

  const [priceResult, stockResult] = await Promise.all([
    sdk.product.updatePrice({ item_id: itemId, price_list: [{ model_id: 0, original_price: price }] }),
    sdk.product.updateStock({ item_id: itemId, stock_list: [{ model_id: 0, seller_stock: [{ location_id: locationId, stock }] }] }),
  ]);
  const priceOk = !priceResult.error && (priceResult.response?.success_list || []).some((entry) => entry.model_id === 0);
  const stockOk = !stockResult.error && (stockResult.response?.success_list || []).some((entry) => entry.model_id === 0);
  if (!priceOk || !stockOk) {
    return renderJson(res, 502, {
      ok: false,
      error: 'Sebagian perubahan ditolak Shopee. Periksa hasilnya sebelum mencoba lagi.',
      updated: { price: priceOk, stock: stockOk },
      failures: { price: priceResult.response?.failure_list ?? [], stock: stockResult.response?.failure_list ?? [] },
    });
  }
  return renderJson(res, 200, { ok: true, shopId: token.shop_id, itemId, updated: { price, stock } });
}

async function handleLogisticsChannels(req, res) {
  const { sdk, token, tokenSource } = await createSdkContext(req, res);
  requireToken(token);
  const data = await sdk.logistics.getChannelList();
  return renderJson(res, 200, {
    tokenSource,
    shopId: token.shop_id ?? null,
    data,
  });
}

async function handleAddSampleProducts(req, res) {
  const { sdk, token, tokenSource } = await createSdkContext(req, res);
  requireToken(token);

  const confirm = req.query && typeof req.query.confirm === 'string' ? req.query.confirm.trim() : '';
  if (confirm !== 'ADD5') {
    return renderJson(res, 400, {
      error: 'Tambahkan ?confirm=ADD5 untuk membuat 5 produk sample UNLIST.',
      example: '/api/products/add-sample-5?confirm=ADD5&category_id=14695&image_id=ISI_IMAGE_ID',
    });
  }

  const categoryId = parseOptionalPositiveInt(req.query && req.query.category_id, 'category_id') ?? 14695;
  const imageId = req.query && typeof req.query.image_id === 'string' && req.query.image_id.trim()
    ? req.query.image_id.trim()
    : '-';
  const count = clamp(parseOptionalInteger(req.query && req.query.count, 'count') ?? 5, 1, 5);
  const price = clamp(parseOptionalInteger(req.query && req.query.price, 'price') ?? 15000, 1000, 999999999);
  const stock = clamp(parseOptionalInteger(req.query && req.query.stock, 'stock') ?? 10, 0, 999999);
  const logisticId = parseOptionalPositiveInt(req.query && req.query.logistic_id, 'logistic_id');
  const namePrefix = req.query && typeof req.query.name_prefix === 'string' && req.query.name_prefix.trim()
    ? req.query.name_prefix.trim()
    : undefined;
  const skuPrefix = req.query && typeof req.query.sku_prefix === 'string' && req.query.sku_prefix.trim()
    ? req.query.sku_prefix.trim()
    : undefined;
  const brandName = req.query && typeof req.query.brand_name === 'string' && req.query.brand_name.trim()
    ? req.query.brand_name.trim()
    : undefined;

  let selectedLogisticId = logisticId;
  let logisticsSource = 'query';
  if (!selectedLogisticId) {
    const channels = await sdk.logistics.getChannelList();
    const enabledChannel = channels &&
      channels.response &&
      Array.isArray(channels.response.logistics_channel_list)
      ? channels.response.logistics_channel_list.find((channel) => asBoolean(channel.enabled))
      : null;

    selectedLogisticId = enabledChannel ? enabledChannel.logistics_channel_id : 4000;
    logisticsSource = enabledChannel ? 'first_enabled_channel' : 'fallback_4000';
  }

  const options = {
    categoryId,
    imageId,
    logisticId: selectedLogisticId,
    price,
    stock,
    weight: 0.2,
    height: 10,
    length: 10,
    width: 10,
    namePrefix,
    skuPrefix,
    brandName,
  };

  const results = [];
  for (let index = 1; index <= count; index += 1) {
    const payload = buildSampleProduct(index, options);
    try {
      const data = await sdk.product.addItem(payload);
      results.push({
        ok: true,
        index,
        itemName: payload.item_name,
        sku: payload.item_sku,
        data,
      });
    } catch (error) {
      results.push({
        ok: false,
        index,
        itemName: payload.item_name,
        sku: payload.item_sku,
        error: error && error.message ? error.message : String(error),
        payload,
      });
    }
  }

  return renderJson(res, 200, {
    ok: results.every((item) => item.ok),
    tokenSource,
    shopId: token.shop_id ?? null,
    count,
    categoryId,
    imageId,
    logisticId: selectedLogisticId,
    logisticsSource,
    results,
  });
}

function normalizeRequestPath(req) {
  const pathname = (req.path || req.originalUrl || req.url || '/').split('?')[0];
  return pathname.replace(/^\/shopee(?=\/|$)/, '') || '/';
}
function setupGuide() {
  return `<div class="card"><h2>Persiapan middleware lokal</h2>
  <ol><li>Siapkan aplikasi dan akun toko di Shopee Open Platform.</li>
  <li>Salin <code>API_shopee/.env.example</code> menjadi <code>API_shopee/.env.local</code>.</li>
  <li>Isi <code>SHOPEE_PARTNER_ID</code> dan <code>SHOPEE_PARTNER_KEY</code> dari aplikasi yang sama.</li>
  <li>Pilih <code>SHOPEE_REGION</code>: GLOBAL untuk produksi atau TEST_GLOBAL untuk sandbox sesuai aplikasi.</li>
  <li>Isi <code>SHOPEE_REDIRECT_URL</code> dengan URL callback yang terdaftar, berakhiran <code>/shopee/callback</code>. Untuk callback HTTPS gunakan alamat penerusan port 3000 yang dapat diakses browser.</li>
  <li>Buat <code>SHOPEE_LOCAL_KEY</code> menggunakan <code>node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"</code>.</li>
  <li>Restart <code>npm run shopee:dev</code>, buka halaman ini, lalu Start OAuth dan izinkan akses toko.</li>
  <li>Periksa Token Status, kemudian Shop Info. Access token, refresh token, Shop ID, dan masa berlaku diisi otomatis dari OAuth.</li></ol>
  <p>Token disimpan terenkripsi di <code>API_shopee/.local/tokens</code>; browser hanya menyimpan ID sesi HttpOnly. Simpan kunci lokal yang sama agar token tetap dapat dibaca setelah restart. Menghapus cookie mengharuskan OAuth ulang. Penyimpanan token belum membuktikan akses API live.</p>
  <a href="/shopee/api/shop/info">Shop Info</a></div>`;
}

async function handleRequest(req, res) {
  try {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const incoming = parseCookies(req);
    res.shopeeCookieBundle = Object.fromEntries([STATE_COOKIE, SESSION_COOKIE].filter(name => incoming[name]).map(name => [name, incoming[name]]));
    const requestPath = normalizeRequestPath(req);
    if (requestPath.startsWith('/api/dashboard/')) {
      return await require('./dashboard-api.cjs').handleDashboard(req, res, requestPath.slice('/api/dashboard'.length));
    }
    if (LOCAL_MODE && requestPath === '/' && (!readSetting('SHOPEE_PARTNER_ID') || !readSetting('SHOPEE_PARTNER_KEY') || !readSetting('SHOPEE_LOCAL_KEY'))) {
      return renderPage(res, 200, 'Persiapan Shopee Lokal', setupGuide());
    }

    if (requestPath === '/api/shopee-auth') {
      return await handleAuthApi(req, res);
    }

    if (requestPath === '/api/shopee-token-status') {
      return await handleTokenStatus(req, res);
    }

    if (requestPath === '/api/shop/info') {
      return await handleShopInfo(req, res);
    }

    if (requestPath === '/api/orders') {
      return await handleOrders(req, res);
    }

    if (requestPath === '/api/products') {
      return await handleProducts(req, res);
    }

    if (requestPath === '/api/products/update') {
      return await handleUpdateProduct(req, res);
    }

    if (requestPath === '/sync-products') {
      return handleProductSyncPage(req, res);
    }

    if (requestPath === '/api/logistics/channels') {
      return await handleLogisticsChannels(req, res);
    }

    if (requestPath === '/api/products/add-sample-5' && LOCAL_MODE) {
      return await handleAddSampleProducts(req, res);
    }

    if (requestPath === '/callback' || (req.query && typeof req.query.code === 'string')) {
      return await handleCallback(req, res);
    }

    if (requestPath === '/api/logout') {
      const expectedOrigin = new URL(loadShopeeConfig().redirectUrl).origin;
      if (req.method !== 'POST' || req.headers.origin !== expectedOrigin) {
        return renderJson(res, 403, { error: 'Logout harus POST dari halaman konektor.' });
      }
      return await handleLogout(req, res);
    }

    const { config, authUrl, tokenStatus } = await buildAuthModel(req, res);
    return renderHome(res, {
      partnerId: config.partnerId,
      region: config.region,
      redirectUrl: config.redirectUrl,
      authUrl,
      tokenSource: tokenStatus.source,
    });
  } catch (error) {
    const message = error && error.message ? error.message : 'Terjadi kesalahan tidak dikenal.';

    if ((req.accepts && req.accepts('json')) || String(req.headers.accept || '').includes('application/json')) {
      return renderJson(res, 500, { error: `Shopee API Console error: ${message}` });
    }

    return renderError(res, 500, `Shopee API Console error: ${message}`);
  }
}

exports.shopeeConsole = functions.https.onRequest(
  CLOUD_MODE ? { serviceAccount: 'shopee-connector@thejagosnackfood-420.iam.gserviceaccount.com' } : {},
  handleRequest
);

exports.shopeeTokenRefresh = require('firebase-functions/v2/scheduler').onSchedule({
  schedule: 'every 5 minutes', timeZone: 'Etc/UTC', region: 'us-central1',
  serviceAccount: 'shopee-connector@thejagosnackfood-420.iam.gserviceaccount.com',
  timeoutSeconds: 540, maxInstances: 1, concurrency: 1,
}, async () => {
  const config = loadShopeeConfig();
  const store = createCloudTokenStore(config.partnerKey);
  const result = await store.refreshDue(old => refreshShopeeToken(config, SHOPEE_BASE_URLS[config.region], old));
  console.log('Shopee scheduled refresh', result);
  if (result.failed) throw new Error('Sebagian token gagal diperbarui; akan dicoba lagi pada jadwal berikutnya.');
});
