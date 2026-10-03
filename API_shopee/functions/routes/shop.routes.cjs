const express = require('express');
const { wrap } = require('./shared.cjs');

module.exports = function shopRoutes(handlers) {
  const router = express.Router();
  router.all('/api/shop/info', wrap(handlers.shopInfo, handlers));
  router.all('/api/logistics/channels', wrap(handlers.logisticsChannels, handlers));
  return router;
};
