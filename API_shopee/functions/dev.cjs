const path = require('node:path');
const fs = require('node:fs');
const envFile = path.join(__dirname, '../.env.local');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
process.env.SHOPEE_LOCAL_MODE = 'true';
const express = require('express');
const { shopeeConsole } = require('./index');
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.get('/', (_req, res) => res.redirect('/shopee'));
app.use('/shopee', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin !== new URL(process.env.SHOPEE_REDIRECT_URL || 'http://localhost:3000').origin) {
    return res.status(403).json({ error: 'Origin tidak diizinkan.' });
  }
  next();
});
app.use(shopeeConsole);
const port = Number(process.env.PORT || 3087);
app.listen(port, '127.0.0.1', () => console.log(`Connector: http://127.0.0.1:${port}/shopee`));
