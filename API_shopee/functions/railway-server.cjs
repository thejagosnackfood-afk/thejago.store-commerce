process.env.SHOPEE_LOCAL_MODE = 'false';

const express = require('express');
const { shopeeConsole } = require('./index');

const required = [
  'SHOPEE_PARTNER_ID',
  'SHOPEE_PARTNER_KEY',
  'SHOPEE_REDIRECT_URL',
  'SHOPEE_TOKEN_STORAGE',
  'FIREBASE_SERVICE_ACCOUNT_JSON',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Railway connector belum dikonfigurasi: ${missing.join(', ')}`);
}
if (process.env.SHOPEE_TOKEN_STORAGE !== 'firestore') {
  throw new Error('Railway connector wajib menggunakan SHOPEE_TOKEN_STORAGE=firestore.');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.get('/', (_req, res) => res.redirect('/shopee'));
app.use('/shopee', shopeeConsole);

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`Shopee connector listening on port ${port}`);
});
