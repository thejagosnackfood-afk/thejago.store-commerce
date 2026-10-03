const express = require('express');
const { wrap } = require('./shared.cjs');

module.exports = function authRoutes(handlers) {
  const router = express.Router();
  router.all('/api/shopee-auth', wrap(handlers.auth, handlers));
  router.all('/api/shopee-token-status', wrap(handlers.tokenStatus, handlers));
  router.all('/callback', wrap(handlers.callback, handlers));
  router.all('/api/logout', wrap(handlers.logout, handlers));
  return router;
};
