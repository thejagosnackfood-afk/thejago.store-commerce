const { getAuth } = require('firebase-admin/auth');

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

function assertOwner(claims) {
  const owner = (process.env.SHOPEE_DASHBOARD_OWNER_EMAIL || '').trim().toLowerCase();
  if (!owner || claims?.email_verified !== true ||
      String(claims.email || '').toLowerCase() !== owner ||
      claims.firebase?.sign_in_provider !== 'google.com') {
    throw new AuthError(403, 'Akun ini tidak memiliki akses dashboard toko.');
  }
}

async function verifyDashboardUser(bearer, verify = token => getAuth().verifyIdToken(token, true)) {
  let claims;
  try {
    claims = await verify(bearer);
  } catch (error) {
    if (['auth/insufficient-permission', 'auth/internal-error', 'auth/invalid-credential'].includes(error.code)) {
      throw new AuthError(503, 'Layanan verifikasi login belum tersedia. Coba lagi beberapa saat.');
    }
    throw new AuthError(401, 'Login kedaluwarsa atau tidak valid. Silakan masuk kembali.');
  }
  assertOwner(claims);
  return claims;
}

async function authenticateDashboardRequest(req, verify, initialize) {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(req.headers?.authorization || '');
  if (!match) throw new AuthError(401, 'Silakan login Google terlebih dahulu.');
  if (initialize) initialize();
  return verifyDashboardUser(match[1], verify);
}

module.exports = { AuthError, assertOwner, verifyDashboardUser, authenticateDashboardRequest };
