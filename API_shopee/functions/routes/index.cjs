const express = require('express');
const authRoutes = require('./auth.routes.cjs');
const orderRoutes = require('./order.routes.cjs');
const productRoutes = require('./product.routes.cjs');
const shopRoutes = require('./shop.routes.cjs');
const dashboardRoutes = require('./dashboard.routes.cjs');

module.exports = function createRoutes(handlers) {
  const router = express.Router();
  router.use(dashboardRoutes(handlers));
  router.use(authRoutes(handlers));
  router.use(orderRoutes(handlers));
  router.use(productRoutes(handlers));
  router.use(shopRoutes(handlers));
  return router;
};
