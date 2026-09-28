# Konektor Shopee di Firebase

- Proyek: `thejagosnackfood-420`
- Hosting site khusus: `thejagosidconnect`
- Halaman: https://thejagosidconnect.firebaseapp.com/shopee
- Callback: https://thejagosidconnect.firebaseapp.com/shopee/callback

Domain utama mengarahkan ke `/shopee`. Hosting meneruskan `/shopee` dan turunannya ke Function `shopeeConsole` di `us-central1`. Konfigurasi khusus berada di `firebase.shopee.json`, agar deployment tidak memilih site dashboard lain.

## Pengisian di Shopee

1. Buka konfigurasi aplikasi di Shopee Open Platform untuk Partner ID/Key yang digunakan.
2. Daftarkan callback persis `https://thejagosidconnect.firebaseapp.com/shopee/callback` (jika portal meminta domain, gunakan `thejagosidconnect.firebaseapp.com`).
3. Pastikan lingkungan aplikasi sesuai `SHOPEE_REGION` di konfigurasi server.
4. Buka halaman konektor pada domain yang sama, pilih **Start OAuth**, login dan izinkan akses toko.
5. Periksa **Token Status** dan **Shop Info**. Status token saja bukan verifikasi akses API live.

Konfigurasi Functions: `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, `SHOPEE_REGION`, `SHOPEE_REDIRECT_URL`, dan `SHOPEE_TOKEN_STORAGE=firestore`. Jangan set `SHOPEE_LOCAL_MODE=true` di Firebase. Berkas `.env.local` hanya sumber konfigurasi lokal; perubahan di sana membutuhkan deployment ulang agar berlaku di Firebase.

## Penyimpanan token

Access token dan refresh token disimpan dengan enkripsi AES-256-GCM pada koleksi Firestore `shopeeConnectorSessions`. ID dokumen adalah HMAC dari ID sesi; cookie `__session` hanya berisi ID acak dan state OAuth bertanda tangan. Kunci enkripsi diturunkan dari Partner Key sehingga rotasi Partner Key memerlukan OAuth ulang.

Browser menggunakan cookie HttpOnly, Secure, SameSite=Lax pada `/shopee`. Menghapus sesi melalui tombol pada halaman menghapus dokumen token di server; izin aplikasi di Shopee tetap terpisah. Sesi yang kedaluwarsa ditolak dan dihapus saat diakses. Belum ada pembersihan terjadwal untuk dokumen sesi yang ditinggalkan. Pembaruan token otomatis mengikuti SDK; pembaruan bersamaan dikoordinasikan dengan lease transaksi Firestore.

## Deployment

Dari `API_shopee`, setelah mengisi `functions/.env.thejagosnackfood-420`:

```sh
firebase deploy --only functions:shopeeConsole,functions:shopeeTokenRefresh,hosting --config firebase.shopee.json --project thejagosnackfood-420
```

Gunakan konfigurasi khusus ini, bukan `firebase.json` lama. Tidak diperlukan server localhost untuk konektor Firebase.

Rujukan cookie Firebase: https://firebase.google.com/docs/hosting/manage-cache#using_cookies

Function memakai akun layanan khusus `shopee-connector@thejagosnackfood-420.iam.gserviceaccount.com` dengan `roles/datastore.user` dibatasi database `(default)` melalui kondisi IAM.

## Refresh token otomatis

Function `shopeeTokenRefresh` berjalan setiap 5 menit (UTC) dan memperbarui token ketika sisa masa berlaku kurang dari 30 menit. Maksimal 10 sesi jatuh tempo diproses per putaran. Access token dan refresh token penggantinya disimpan bersama secara terenkripsi. Permintaan API juga memakai jalur refresh terkunci yang sama. Kegagalan dicatat tanpa token mentah dan dijadwalkan kembali 5 menit kemudian; status tersimpan `retry_pending`.

Sesi versi lama perlu membuka `/shopee/api/shopee-token-status` **sekali dari browser OAuth yang sama**. Pembacaan berhasil memigrasikan enkripsi versi 1 ke versi 2 secara transaksional. Tanpa cookie lama, scheduler tidak dapat mendekripsi sesi versi 1; alternatifnya OAuth ulang. Versi 2 mengikat ciphertext ke ID dokumen dan tidak membutuhkan browser untuk refresh terjadwal.

Token yang terus berhasil diperbarui memperpanjang retensi server. Cookie browser tetap memiliki masa berlaku sendiri. Izin yang dicabut, refresh token tidak valid, atau gangguan layanan berkepanjangan bisa memerlukan otorisasi ulang; refresh otomatis tidak menjamin token tidak pernah kedaluwarsa.

Jadwal menggunakan Cloud Scheduler, yang dapat menimbulkan biaya sesuai kuota proyek. Dokumentasi: https://firebase.google.com/docs/functions/schedule-functions
