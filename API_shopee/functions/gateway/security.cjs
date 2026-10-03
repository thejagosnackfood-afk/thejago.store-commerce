const WINDOW_MS = 60_000;
const MAX_CLIENTS = 20_000;

function createSecurityGateway({ now = Date.now, generalLimit = 120, sensitiveLimit = 30 } = {}) {
  const counters = new Map();
  let requests = 0;

  return function securityGateway(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const path = (req.originalUrl || req.url || '').split('?')[0];
    if ((req.originalUrl || req.url || '').length > 2048) return res.status(414).json({ error: 'URL terlalu panjang.' });
    if (['TRACE', 'CONNECT'].includes(req.method)) return res.status(405).json({ error: 'Metode tidak diizinkan.' });

    const isDashboard = path === '/shopee/api/dashboard' || path.startsWith('/shopee/api/dashboard/');
    const sensitive = path === '/shopee/callback' || path === '/shopee/api/shopee-auth' ||
      path === '/shopee/api/logout';
    const limit = sensitive ? sensitiveLimit : generalLimit;
    const bucket = sensitive ? 'sensitive' : 'general';
    const key = `${req.ip || 'unknown'}:${bucket}`;
    const current = now();
    if (++requests % 256 === 0) {
      for (const [client, entry] of counters) if (entry.resetAt <= current) counters.delete(client);
    }
    let entry = counters.get(key);
    if (!entry || entry.resetAt <= current) {
      if (counters.size >= MAX_CLIENTS) counters.delete(counters.keys().next().value);
      entry = { count: 0, resetAt: current + WINDOW_MS };
      counters.set(key, entry);
    }
    entry.count += 1;
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAt - current) / 1000)));
    if (entry.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - current) / 1000)));
      return res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
    }
    if (isDashboard) {
      const allowed = (process.env.SHOPEE_PANEL_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
      res.setHeader('Vary', 'Origin');
      const origin = req.headers.origin;
      if (origin && !allowed.includes(origin)) return res.status(403).json({ error: 'Origin dashboard tidak diizinkan.' });
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      if (!['GET', 'POST', 'OPTIONS'].includes(req.method)) return res.status(405).json({ error: 'Metode dashboard tidak diizinkan.' });
      if (req.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        return res.status(415).json({ error: 'Body dashboard harus JSON.' });
      }
    }

    if (isDashboard && req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

module.exports = { createSecurityGateway };
