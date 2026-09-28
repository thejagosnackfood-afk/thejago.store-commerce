const express = require('express');
const { shopeeConsole } = require('./index');
const app = express();
app.use(express.json());
app.get('/', (_req, res) => res.redirect('/shopee'));
app.use(shopeeConsole);
const port = Number(process.env.PORT || 3087);
app.listen(port, '127.0.0.1', () => console.log(`Connector: http://127.0.0.1:${port}/shopee`));
