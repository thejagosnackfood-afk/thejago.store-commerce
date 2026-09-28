# Deploy connector Shopee di Railway

Railway menjalankan connector pada service terpisah. Token OAuth tetap dienkripsi di koleksi Firestore `shopeeConnectorSessions`; scheduled refresh tetap dijalankan oleh Firebase. Jangan mengarahkan panel ke service sebelum semua env tersedia dan callback OAuth diperbarui.

## Resource Railway yang sudah disiapkan

- Project: `helpful-connection` (`ea199855-7d52-4886-8086-15ba28def368`)
- Environment: `production`
- Service baru: `shopee-api` (`3214b7cf-b4b3-4236-99ad-aab4640cca2d`)
- Domain: `https://shopee-api-production-676a.up.railway.app`
- Variables nonrahasia yang sudah diset: `SHOPEE_REGION`, `SHOPEE_TOKEN_STORAGE`, `SHOPEE_LOCAL_MODE`, dan `SHOPEE_REDIRECT_URL`.
- Service belum terhubung ke source GitHub dan belum memiliki deployment.
- Service masih memerlukan secret Shopee, service account Firebase, dan URL dashboard untuk redirect.
- Service dashboard `thejago.store-commerce` tidak diubah.

## Service

- Repository: `thejagosnackfood-afk/thejago.store-commerce`
- Branch: `main`
- Root directory: `/API_shopee/functions`
- Start command: `npm run start:railway` (sudah ada di `railway.json`)
- Public path: `/shopee`

## Variables

Atur variables sebagai Railway secrets, bukan di GitHub:

- `SHOPEE_PARTNER_ID`
- `SHOPEE_PARTNER_KEY`
- `SHOPEE_REGION=GLOBAL`
- `SHOPEE_TOKEN_STORAGE=firestore`
- `SHOPEE_LOCAL_MODE=false`
- `SHOPEE_REDIRECT_URL=https://shopee-api-production-676a.up.railway.app/shopee/callback` (sudah diset)
- `SHOPEE_SUCCESS_REDIRECT_URL=<dashboard-origin>/`
- `SHOPEE_PANEL_ORIGIN=<dashboard-origin>`
- `FIREBASE_SERVICE_ACCOUNT_JSON` (JSON service account `shopee-connector@thejagosnackfood-420.iam.gserviceaccount.com`)

Service account memerlukan izin Firestore yang sama seperti Function Firebase. Jangan commit key JSON atau menaruhnya di file deploy. Gunakan Railway variable bertipe secret.

## Activation order

1. Pada service `shopee-api`, hubungkan repository di atas dan set root directory `/API_shopee/functions`. Domain sudah dibuat.
2. Isi variables, gunakan domain tadi sebagai `SHOPEE_REDIRECT_URL`, dan daftarkan callback yang sama di Shopee Open Platform.
3. Pada paket Railway Pro, aktifkan **Static Outbound IPs** untuk service connector. Tambahkan setiap IP yang diberikan Railway ke Shopee IP Address Whitelist.
4. Deploy service dan pastikan `GET /shopee/api/shopee-auth` merespons.
5. Jalankan OAuth ulang di browser yang sama pada domain Railway; cookie sesi Firebase lama tidak ikut pindah domain. Token baru akan tersimpan ke Firestore.
6. Arahkan `NEXT_PUBLIC_SHOPEE_CONSOLE_URL` pada dashboard ke `https://<railway-domain>/shopee`, lalu rebuild/redeploy dashboard bila production.
7. Uji Token Status, Shop Info, sinkron produk, lalu edit harga/stok produk tanpa variasi.

Untuk service yang sudah dibuat, gunakan domain callback berikut saat mengisi variable dan mendaftarkannya ke Shopee:
`https://shopee-api-production-676a.up.railway.app/shopee/callback`.

Source GitHub belum ditautkan. Sebelum mengaktifkan GitHub autodeploy, pastikan perubahan connector Railway sudah masuk ke branch `main`; file konfigurasi Railway saat ini masih perubahan lokal. Berikan akses repository kepada Railway GitHub App lalu pilih repository `thejagosnackfood-afk/thejago.store-commerce` dan root directory `/API_shopee/functions`.

`FIREBASE_SERVICE_ACCOUNT_JSON` belum tersedia di workspace. Buat/ambil key untuk service account yang disebut di atas melalui Google Cloud IAM, lalu simpan langsung sebagai Railway secret variable. Jangan memasukkan key ke Git atau mengirimkannya di chat. Static Outbound IP juga belum diaktifkan; cek paket Railway dan aktifkan di service `shopee-api` sebelum whitelist IP Railway di Shopee.

Jangan deploy Firebase Hosting dari konfigurasi `firebase.json` umum. Function Firebase yang lama dapat tetap dipakai sebagai fallback hingga alur Railway diverifikasi.
