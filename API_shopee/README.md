# Shopee Open API connector

Firebase Function ini menjadi backend aman untuk Shopee Open API V2. Secret seperti
`SHOPEE_PARTNER_KEY`, access token, dan refresh token hanya dipakai di server.

## Konfigurasi

1. Salin `.env.example` menjadi `.env`.
2. Isi nilai dari Shopee Open Platform Console:
   - `SHOPEE_PARTNER_ID`
   - `SHOPEE_PARTNER_KEY`
   - `SHOPEE_REDIRECT_URL`
   - `SHOPEE_REGION`
3. Pastikan redirect URL di Shopee Open Platform sama dengan
   `SHOPEE_REDIRECT_URL`, misalnya:

```txt
https://thejagosidconnect.firebaseapp.com/shopee/callback
```

Untuk sandbox, salin `.env.sandbox.example` menjadi `.env.sandbox`.

## Endpoint

| Endpoint | Fungsi |
| --- | --- |
| `/` | Console OAuth untuk authorize toko |
| `/api/shopee-connection` | Cek base URL, auth URL, token status, dan public API probe |
| `/api/shopee-auth` | Ambil authorization URL dalam JSON |
| `/callback` | Callback OAuth dari Shopee |
| `/api/shopee-token-status` | Ringkasan token tanpa membocorkan token mentah |
| `/api/shop/info` | Test shop API setelah OAuth |
| `/api/orders?page_size=20` | Ambil order terbaru |
| `/api/products?page_size=20` | Ambil daftar produk |
| `/api/logistics/channels` | Ambil channel logistik |
| `/api/webhook/shopee` | Webhook real-time dari Shopee Developer Console |

## Deploy

```sh
npm run deploy
```

atau sandbox:

```sh
npm run deploy:sandbox
```

Default deploy hanya mengirim **Functions** agar tidak mengganggu Firebase
Hosting yang sudah berjalan.

Untuk project dashboard:

```sh
npm run deploy -- --project=dasboardmarket --only=functions
```

## Gabung ke hosting utama

Untuk menampilkan console di sub halaman:

```txt
https://thejagosidconnect.firebaseapp.com/shopee
```

gabungkan rewrite berikut ke `firebase.json` hosting utama:

```json
{
  "source": "/api/webhook/shopee",
  "function": "shopeeConsole"
},
{
  "source": "/shopee",
  "function": "shopeeConsole"
},
{
  "source": "/shopee/**",
  "function": "shopeeConsole"
}
```

Snippet yang sama tersedia di `firebase.hosting.rewrites.snippet.json`.

Di Shopee Developer Console, isi Webhook URL:

```txt
https://dasboardmarket.firebaseapp.com/api/webhook/shopee
```

Jangan pakai rewrite catch-all `**` untuk connector ini karena bisa mengambil
alih halaman hosting utama.

Jangan deploy hosting dari folder `API_shopee` sebagai hosting utama karena
`public/` di folder ini sengaja kosong. Deploy hosting harus dilakukan dari repo
dashboard utama setelah rewrite `/shopee` digabung.

## Catatan signature

Connector ini memakai SDK lokal `@congminh1254/shopee-sdk`. Signature Shopee V2
dibuat server-side dengan HMAC-SHA256:

- Public/auth API: `partner_id + api_path + timestamp`
- Shop API: `partner_id + api_path + timestamp + access_token + shop_id`

Access token akan disimpan ke session cookie terenkripsi setelah OAuth sukses.
# Halaman bersama Shopee dan Ginee

Halaman `/shopee` memiliki tombol uji koneksi pesanan. Endpoint
`POST /shopee/api/integration/check` membaca maksimal 20 pesanan Shopee dari
24 jam terakhir dan meneruskan nomor pesanan ke Ginee sebagai `externalOrderIds`.
Ini pemeriksaan baca, bukan sinkronisasi stok atau penulisan pesanan.
HTTP 200 hanya dikembalikan bila kedua panggilan berhasil dan Ginee mengembalikan
`SUCCESS`. Pesanan kosong tidak dinyatakan sebagai koneksi lintas API terverifikasi.

Tambahkan `GINEE_APP_KEY`, `GINEE_APP_SECRET`, dan `GINEE_SHOP_ID` ke `.env`
connector. ID toko Ginee harus merujuk toko Shopee yang sama. Browser menggunakan
sesi OAuth Shopee; pengujian Python tanpa cookie membutuhkan token seed Shopee
di environment server. Jangan masukkan secret ke halaman atau argumen CLI.

Jalankan dari folder API_shopee:

```sh
npm run dev
npm run test:integration
```

Pengujian sample menjalankan script Python terhadap server sementara dengan
respons upstream simulasi. Hasil `mode: sample, liveVerified: false` tidak
membuktikan kredensial live bekerja.

Script Python juga dapat menguji server nyata:

```sh
python3 "sample database csv/test_ginee_api.py" --connector-url http://127.0.0.1:3087/shopee
```

## Middleware lokal

Panduan pengisian konfigurasi, OAuth, dan penyimpanan token: [LOCAL_SETUP.md](LOCAL_SETUP.md). Dari root jalankan `npm run shopee:dev` bersama `npm run dev`, lalu buka `/shopee`.

## Konektor Firebase

Domain khusus `thejagosidconnect.firebaseapp.com`: lihat [FIREBASE_SETUP.md](FIREBASE_SETUP.md) untuk callback, penyimpanan Firestore, dan deployment khusus site.
