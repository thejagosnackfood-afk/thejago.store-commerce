# JAGO Seller workspace

Perubahan UI 30 September 2026 mengikuti prioritas pemilik: produk, pesanan, pengiriman. Sidebar, header, kartu ringkasan, filter dan tabel menggunakan susunan aplikasi operasional toko. Branding tetap JAGO Seller.

## Halaman online

- `/panel/home`: jumlah produk dan stok dari snapshot Firestore; alur pesanan dari respons halaman pertama API, dengan cakupan eksplisit.
- `/panel/product/mp/shopee`: foto produk, pencarian nama/SKU/ID, status, filter stok, urutan nama/harga/stok, paginasi, pemilihan untuk ekspor CSV, edit harga/stok produk tanpa variasi, paket dan kurir.
- `/panel/product/orders`: status pesanan, pencarian, filter kurir, ekspor hasil yang dimuat, paginasi upstream, pickup/drop-off dan resi.
- `/panel/product/shipping`: pesanan READY_TO_SHIP/PROCESSED/SHIPPED dari halaman yang telah dimuat; alur dokumen PDF tetap mengikuti readiness Shopee.
- `/panel/product/logistics`: pengaturan kurir toko dengan konfirmasi.
- `/panel/inventory`: pantauan stok produk tersimpan, stok menipis 1–10 unit dan stok nol, pencarian dan tautan ke produk.
- `/panel/settings`: identitas toko, status snapshot, cakupan fitur dan akses konektor OAuth.

Route `/panel/product/master` membuka [Master produk online dan impor CSV](MASTER_PRODUCTS.md). Route stok lama tetap mengarah ke pantauan stok. Route tools demo menampilkan status belum terhubung pada build online agar data contoh tidak terlihat sebagai data toko. Build lokal non-online mempertahankan komponen demo lama.

## Batasan yang ditampilkan

Tidak ada klaim total penjualan atau pendapatan dari data pesanan parsial. Pesanan mengikuti jendela 14 hari dan halaman API yang dimuat. Tab status menunjukkan jumlah dalam data tersebut. Data tidak diklaim sebagai laporan keuangan.

Master mendukung perubahan stok variasi per lokasi dan antrean impor CSV. Belum ada CRUD produk baru, edit atribut variasi, proses massal perubahan harga/pengiriman, manajemen gudang fisik, pembelian, chat, iklan, retur atau rekonsiliasi keuangan. Pemilihan massal produk dipakai untuk ekspor CSV saja. Mengubah data toko dan memproses pengiriman tetap melalui konfirmasi endpoint yang sudah ada.

## Verifikasi

- Build produksi dan TypeScript.
- Tes CSV untuk kutip, koma, baris baru, stok nol dan perlindungan formula spreadsheet.
- Browser Chromium memakai fixture terisolasi di `/tmp/jago-ui-check`, tidak dimasukkan ke bundle produksi: ringkasan, pencarian, pilihan/CSV, konfirmasi harga, pickup, payload pengiriman, daftar pengiriman, navigasi mobile dan overflow.
- Tidak melakukan pengiriman atau perubahan harga nyata sebagai bagian pengujian UI.
