# Master produk online dan impor stok CSV

Halaman `/panel/product/master` menggunakan Firestore melalui backend Railway, dengan autentikasi pemilik dashboard yang sudah ada. Semua pemetaan, target stok, antrean, versi dan file CSV tersimpan di server. Browser tidak mengakses koleksi Firestore secara langsung.

## Cara pakai

1. Klik **Hubungkan produk**, pilih produk Shopee, variasi dan lokasi stok. Masukkan Master SKU unik. Konfirmasi hanya menyimpan pemetaan dan membaca stok awal, tanpa mengubah Shopee.
2. **Database online**: klik Edit stok. Server membaca stok terbaru sebelum formulir dibuka. Tinjau lalu konfirmasi untuk menyimpan target ke antrean.
3. **Impor CSV**: pilih maksimal 100 SKU atau unduh template 100 hasil pertama. Kolom persis `Master SKU,Stok,Versi`. Ubah Stok saja, unggah (maksimal 300 KB), tinjau, lalu konfirmasi. Stok nol diperbolehkan.
4. Setelah penyimpanan berhasil, PC boleh mati. Server memproses antrean. Pantau status **Sesuai Shopee**, **Dalam antrean**, **Sedang dikirim**, atau **Perlu ditinjau**.
5. Untuk status Perlu ditinjau, periksa toko lalu pilih **Tinjau / terima Shopee**. Ini menerima stok live ke master dan membatalkan target lama. Setelah itu buat penyesuaian baru bila perlu.

## Aturan sumber data dan konflik

Database online adalah master kerja. CSV merupakan masukan satu kali ke database yang sama, bukan sumber cadangan yang diputar ulang saat PC mati. File yang belum diunggah tidak dapat diakses server. Mengunduh CSV bukan mengirim stok.

Master memantau stok penjual Shopee per lokasi (`seller_stock`), bukan stok fisik gudang atau total stok tersedia setelah reservasi. Perubahan stok di Shopee (misalnya pesanan atau perubahan penjual) diterima ke master ketika tidak ada pekerjaan tertunda. Versi master bertambah bila nilai berubah, sehingga CSV lama ditolak. Pembaruan pesanan, stok fisik toko, dan reservasi belum merupakan buku besar inventori terpisah.

Impor divalidasi seluruhnya dalam transaksi: SKU harus terdaftar, versi harus sama, data stok harus diperiksa dalam 10 menit terakhir, dan tidak boleh ada pekerjaan tertunda/perlu ditinjau. Satu baris gagal membatalkan seluruh penyimpanan impor. Pengiriman ke Shopee diproses per SKU; beberapa SKU dapat berhasil sementara lainnya perlu ditinjau. Status tabel adalah hasil terkini; riwayat impor menampilkan penyimpanan, bukan bukti seluruh pengiriman berhasil.

Setiap operasi memiliki ID idempoten. Pengiriman memeriksa stok live sebelum menulis, memeriksa respons sukses dan membaca ulang setelahnya. Perubahan di antara pemeriksaan awal dan penulisan absolut tetap mungkin karena API upstream tidak menyediakan transaksi bersama database master. Sistem tidak menjamin bebas overselling. Hasil timeout/tidak pasti dan proses yang terputus masuk peninjauan, tanpa pengulangan buta.

## Jadwal dan batas

Worker berjalan di proses Railway aktif: mulai 20 detik setelah startup, memeriksa setiap 60 detik, maksimal 3 pekerjaan dan 5 pembacaan stok per siklus. Satu siklus dapat lebih lama bila API lambat; siklus yang masih berjalan tidak ditumpuk. Banyak SKU membutuhkan beberapa siklus. Ini polling berkala, bukan real-time seketika/webhook. Halaman memperbarui tampilan setiap 10 detik saat terbuka.

Lease Firestore mencegah worker beberapa replika memproses antrean bersamaan. File CSV disimpan di `stockImports`, pemetaan di `masterProducts`/`masterMappings` di bawah toko terkonfigurasi. Tidak ada fallback ke localStorage. Worker butuh backend aktif, koneksi Shopee valid, whitelist IP dan akses database. Gangguan koneksi sebelum klaim pekerjaan mempertahankan antrean untuk siklus berikutnya.

Saat ini satu Master SKU dipetakan ke satu produk/variasi/lokasi pada satu toko. Belum mencakup SKU bundel, banyak marketplace, sinkronisasi POS lokal, atau pengurangan stok fisik berdasarkan buku besar pesanan.

## Validasi

`npm run shopee:test` mencakup parser/limit CSV, stok nol, versi kedaluwarsa, transaksi atomik, idempotensi, edit bersamaan, pemetaan variasi/lokasi, hasil upstream tidak pasti, dan rekonsiliasi. Pengujian tidak mengubah stok toko nyata. Uji UI memakai fixture terpisah di luar build produksi; uji produksi tanpa login hanya memverifikasi gate autentikasi, bukan keberhasilan kirim stok.
