const express = require('express');
const { wrap } = require('./shared.cjs');

module.exports = function productRoutes(handlers) {
  const router = express.Router();
  router.all('/api/products', wrap(handlers.products, handlers));
  router.all('/api/products/update', wrap(handlers.updateProduct, handlers));
  router.all('/sync-products', wrap(handlers.syncProductsPage, handlers));
  if (handlers.localMode) router.all('/api/products/add-sample-5', wrap(handlers.addSampleProducts, handlers));
  return router;
};
