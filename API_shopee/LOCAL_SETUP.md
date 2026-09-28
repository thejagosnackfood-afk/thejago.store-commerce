# Middleware Shopee lokal

Buka http://localhost:3000/shopee untuk panduan dan OAuth pada konektor yang sama.

## Persiapan

1. Siapkan aplikasi Shopee Open Platform dan akun toko yang dapat memberikan izin.
2. Salin `.env.example` menjadi `.env.local` di folder `API_shopee`. Jika `.env.local` sudah ada, lengkapi tanpa menimpanya.
3. Isi konfigurasi berikut:

| Variabel | Isi |
| --- | --- |
| `SHOPEE_PARTNER_ID` | Partner ID numerik dari aplikasi Shopee |
| `SHOPEE_PARTNER_KEY` | Partner Key dari aplikasi dan lingkungan yang sama; hanya di server |
| `SHOPEE_REGION` | `GLOBAL` untuk produksi, `TEST_GLOBAL` untuk sandbox sesuai aplikasi |
| `SHOPEE_REDIRECT_URL` | URL callback persis yang terdaftar pada aplikasi, dengan path `/shopee/callback` |
| `SHOPEE_SUCCESS_REDIRECT_URL` | Halaman setelah OAuth berhasil; default `http://localhost:3000/` |
| `SHOPEE_PANEL_ORIGIN` | Origin panel yang diizinkan menerima hasil sinkronisasi; default `http://localhost:3000` |
| `SHOPEE_LOCAL_KEY` | 64 karakter hex acak untuk enkripsi token lokal |

Buat kunci dengan `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
Contoh callback lokal: `http://localhost:3000/shopee/callback`. Jika konfigurasi Shopee membutuhkan HTTPS, gunakan URL HTTPS penerusan port 3000/Codespaces yang dapat diakses browser, daftarkan callback tersebut, lalu buka `/shopee` dari origin HTTPS yang sama sebelum OAuth. Persyaratan callback mengikuti aplikasi di portal Shopee.

4. Jalankan `npm run dev` dari root untuk dashboard port 3000.
5. Di terminal kedua jalankan `npm run shopee:dev` dari root. Middleware hanya mendengarkan loopback port 3087 dan diakses melalui `/shopee` pada aplikasi Next.js dalam mode development.
6. Setelah mengganti `.env.local`, restart middleware.
7. Buka `/shopee`, pilih **Start OAuth**, masuk ke akun toko dan berikan izin. Setelah token tersimpan, browser kembali ke `SHOPEE_SUCCESS_REDIRECT_URL`. Jangan mengisi access token atau refresh token secara manual: callback SDK mengisi keduanya beserta Shop ID dan masa berlaku.
8. Buka **Token Status** lalu **Shop Info**. Status tersimpan membuktikan penyimpanan; respons API toko yang sesuai diperlukan untuk memastikan akses live.

## Penyimpanan

Token dienkripsi AES-256-GCM dalam `API_shopee/.local/tokens`, dengan berkas mode 0600 dan direktori baru mode 0700. Folder serta `.env.local` diabaikan Git. Browser hanya memegang ID sesi acak HttpOnly, SameSite=Lax; cookie Secure digunakan pada callback HTTPS. Penyimpanan SDK untuk OAuth dan refresh memakai store yang sama, dengan penggantian berkas atomik.

Restart dengan kunci dan cookie yang sama mempertahankan sesi. Menghapus cookie atau kehilangan kunci membutuhkan OAuth ulang. `/shopee/api/logout` menghapus token sesi lokal; ini tidak mencabut izin aplikasi pada Shopee. Sesi lokal berlaku paling lama 30 hari sejak penyimpanan terakhir, sedangkan validitas token tetap mengikuti Shopee.

Middleware ini untuk penggunaan lokal, bukan layanan multiuser publik. Refresh bersamaan belum dikoordinasikan lintas proses; gunakan satu proses middleware. Tidak ada deployment atau perubahan Hosting yang diperlukan.

Uji: `npm run shopee:test` dan `npm run typecheck`. Tes menggunakan token tiruan, bukan verifikasi akun live.
