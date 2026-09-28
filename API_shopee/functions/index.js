const crypto = require('crypto');
const functions = require('firebase-functions');

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
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || '/'}`, 'HttpOnly', 'Secure', 'SameSite=Lax'];

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
  }

  async get() {
    if (this.cachedToken) {
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
    this.cachedToken = token;
    this.cachedSource = 'cookie';
    setCookie(this.res, SESSION_COOKIE, buildSessionToken(token, this.config), {
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  }

  async clear() {
    this.cachedToken = null;
    this.cachedSource = 'none';
    clearCookie(this.res, SESSION_COOKIE);
  }

  async getStatus() {
    const token = await this.get();
    return {
      source: this.cachedSource || 'none',
      token,
    };
  }
}

async function createShopeeSdk(config, tokenStorage, token) {
  const { default: ShopeeSDK } = await import('@congminh1254/shopee-sdk');

  return new ShopeeSDK(
    {
      partner_id: config.partnerId,
      partner_key: config.partnerKey,
      base_url: SHOPEE_BASE_URLS[config.region],
      base_auth_url: SHOPEE_AUTH_URLS[config.region],
      shop_id: token && token.shop_id ? token.shop_id : undefined,
    },
    tokenStorage
  );
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
      <p>Flow ini memakai <code>shopee-sdk</code> dengan state-protected OAuth, session cookie terenkripsi, auto refresh token, dan endpoint helper untuk shop, orders, serta products.</p>
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
    `<div class="status info">Mulai OAuth lewat tombol di bawah. Setelah authorize sukses, endpoint helper siap dipakai tanpa menampilkan token mentah di browser.</div>
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
      <a class="button" href="/api/shopee-auth" target="_blank" rel="noopener" style="background:#111827;">View Auth JSON</a>
      <a class="button" href="/api/shopee-token-status" target="_blank" rel="noopener" style="background:#374151;">Token Status</a>
    </div>
    <div class="card">
      <span class="label">API Helper Endpoints</span>
      <ul>
        <li><code>/api/shop/info</code></li>
        <li><code>/api/orders?page_size=20</code></li>
        <li><code>/api/products?offset=0&page_size=20&amp;item_status=NORMAL</code></li>
      </ul>
    </div>`
  );
}

function renderCallbackSuccess(res, model) {
  renderPage(
    res,
    200,
    'Shopee OAuth Berhasil',
    `<div class="status ok">Token sudah disimpan ke session cookie terenkripsi untuk browser ini. Token mentah sengaja tidak ditampilkan.</div>
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
      <a class="button" href="/api/shop/info" rel="noopener">Test Shop Info</a>
      <a class="button" href="/api/orders?page_size=20" rel="noopener" style="background:#111827;">Test Orders</a>
      <a class="button" href="/" rel="noopener" style="background:#374151;">Back to Console</a>
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
  const status = await tokenStorage.getStatus();
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
    tokenStored: 'session_cookie',
    stateVerified,
  };

  if ((req.accepts && req.accepts('json')) || String(req.headers.accept || '').includes('application/json')) {
    return renderJson(res, 200, payload);
  }

  return renderCallbackSuccess(res, payload);
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
      <a class="button" href="/" rel="noopener">Kembali ke Console</a>
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

  return renderJson(res, 200, {
    tokenSource,
    shopId: token.shop_id ?? null,
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

async function handleRequest(req, res) {
  try {
    const requestPath = (req.path || req.originalUrl || req.url || '/').split('?')[0];

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

    if (requestPath === '/api/logistics/channels') {
      return await handleLogisticsChannels(req, res);
    }

    if (requestPath === '/api/products/add-sample-5') {
      return await handleAddSampleProducts(req, res);
    }

    if (requestPath === '/callback' || (req.query && typeof req.query.code === 'string')) {
      return await handleCallback(req, res);
    }

    if (requestPath === '/api/logout') {
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

exports.shopeeConsole = functions.https.onRequest(handleRequest);
