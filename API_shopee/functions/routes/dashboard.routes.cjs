const express = require('express');
const { wrap } = require('./shared.cjs');

module.exports = function dashboardRoutes(handlers) {
  const router = express.Router();
  router.all('/api/dashboard/*', wrap((req, res) => {
    const path = req.path.slice('/api/dashboard'.length);
    return require('../dashboard-api.cjs').handleDashboard(req, res, path);
  }, handlers));
  return router;
};
