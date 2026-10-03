const express = require('express');
const { wrap } = require('./shared.cjs');

module.exports = function orderRoutes(handlers) {
  const router = express.Router();
  router.all('/api/orders', wrap(handlers.orders, handlers));
  router.all('/api/orders/search', wrap(handlers.orderSearch, handlers));
  return router;
};
