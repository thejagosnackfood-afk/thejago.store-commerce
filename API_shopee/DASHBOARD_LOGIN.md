# Login dashboard online

- Dashboard: https://thejago-commerce-panel.web.app/panel/product/mp/shopee/
- Konektor: https://shopee-api-apishopee.up.railway.app/shopee
- Provider: Firebase Authentication Google, project `thejagosnackfood-420`.
- Hanya email Google terverifikasi `thejagosnackfood@gmail.com` yang diizinkan backend.
- Backend memvalidasi Firebase ID token dengan pemeriksaan pencabutan sesi (`verifyIdToken(token, true)`). Service account konektor menggunakan `roles/firebaseauth.viewer`, disetujui pemilik pada 30 September 2026.
- Token login Google terpisah dari access token Shopee. Token Shopee kedaluwarsa tidak memblokir endpoint login `/api/dashboard/me`.

## Build dan deployment

Set konfigurasi publik saat build (bukan rahasia partner Shopee):

```
NEXT_PUBLIC_FIREBASE_CONFIG={...konfigurasi Firebase Web JSON...}
NEXT_PUBLIC_SHOPEE_CONSOLE_URL=https://shopee-api-apishopee.up.railway.app/shopee
```

Jalankan `npm run build:dashboard`, lalu Firebase CLI:

```
firebase deploy --only hosting --config firebase.dashboard.json --project thejagosnackfood-420
```

Script build menolak konfigurasi kosong dan mengaktifkan login serta static export. Jangan deploy build demo menggunakan konfigurasi hosting dashboard ini.

Backend Railway environment `API_shopee`, service `shopee-api` membutuhkan:

- `SHOPEE_DASHBOARD_OWNER_EMAIL=thejagosnackfood@gmail.com`
- `SHOPEE_DASHBOARD_SHOP_ID=59604858`
- `SHOPEE_PANEL_ORIGIN`: daftar origin HTTPS, dipisahkan koma; termasuk kedua domain Hosting dashboard.
- Konfigurasi partner dan Firestore konektor yang sudah ada.

## Verifikasi

`npm run shopee:test` mencakup penolakan akun lain, email belum terverifikasi, provider lain, token dicabut/kedaluwarsa, origin lain, serta permintaan tanpa token. `npm run typecheck` memeriksa frontend.

Uji browser tanpa login harus menampilkan tombol Masuk dengan Google. Tombol tersebut harus membuka halaman Google. Login interaktif final menggunakan akun pemilik harus dilakukan oleh pemilik; jangan membuat token palsu atau mengganti allowlist untuk meloloskan pengujian.

## Hasil verifikasi 30 September 2026

- Firebase Hosting: deployment berhasil, halaman produk merespons HTTP 200.
- Railway backend: deployment `2feb661c-68d7-4799-b01b-ed28ba1e2152`, healthcheck berhasil.
- Browser Chromium: tombol login tampil tanpa JavaScript error dan membuka `accounts.google.com/v3/signin/identifier`.
- Backend: CORS preflight origin dashboard HTTP 204; tanpa token dan token palsu HTTP 401; origin lain HTTP 403.
- Lookup akun pemilik menggunakan service account berhasil; akun aktif dan provider Google sudah terhubung.
- TypeScript, build produksi, dan pengujian auth/konektor lolos.
- Login interaktif final dengan akun pemilik belum dibuktikan oleh pengujian otomatis; tidak ada kredensial Google yang dimasukkan.

## Penolakan IP Shopee — 30 September 2026

Login pemilik berhasil. Error saat POST `/api/dashboard/products/sync` berasal dari refresh Shopee, bukan Google Auth atau pembacaan Firestore. Pemeriksaan dari server Railway mengembalikan `source_ip_undeclared`.

IP keluar tetap telah diaktifkan pada service `shopee-api`, environment `API_shopee`, region Singapore. Tambahkan semua alamat berikut ke IP Address Whitelist aplikasi Shopee, dengan mempertahankan entri lama yang masih dipakai:

- `208.77.246.240`
- `208.77.246.241`
- `208.77.246.242`

Perubahan whitelist memerlukan akses pemilik ke Shopee Open Platform. Sesudah disimpan, ulangi sinkronisasi. Bila Shopee kemudian menyatakan refresh token tidak valid, lakukan OAuth ulang melalui konektor. Jangan meminta pengguna login Google ulang untuk masalah whitelist.

Backend kini mencatat hasil pemeriksaan koneksi saat startup tanpa mencatat token; kegagalan refresh mengembalikan kode yang disanitasi dan petunjuk yang sesuai. Status `source_ip_undeclared` belum berarti refresh token dicabut.

## Pemulihan OAuth ketika refresh token ditolak

Halaman `/shopee` dan `/shopee/api/shopee-auth` kini membuat URL OAuth tanpa melakukan refresh token lama. Ringkasan token di halaman tersebut hanya menunjukkan token tersimpan, bukan bukti akses API berhasil. Pembacaan sesi lama yang gagal juga tidak menghalangi pembuatan URL OAuth baru.

Endpoint data tetap menggunakan validasi dan refresh token biasa; callback tetap mensyaratkan state OAuth yang cocok. Regresi diuji di `functions/oauth-recovery.test.cjs`: token kedaluwarsa dan sesi tidak terbaca tidak memblokir OAuth, tetapi kegagalan refresh tetap memblokir endpoint data.
