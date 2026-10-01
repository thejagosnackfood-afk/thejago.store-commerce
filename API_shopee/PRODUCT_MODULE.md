# Modul produk Shopee

Buka `/shopee/products` dari console atau tombol **TAMBAH / EDIT SHOPEE** di dashboard.

- **Tambah produk:** isi judul, SKU, deskripsi, kategori, harga, stok, berat paket, ID gambar Shopee, dan ID logistik. Atribut kategori dan merek dapat ditambahkan jika diwajibkan Shopee. ID gambar harus sudah diunggah ke Shopee; modul ini belum menyediakan unggah gambar. Produk baru selalu dibuat `UNLIST`.
- **Edit produk:** muat produk toko, pilih produk tanpa variasi, ubah judul/SKU, tinjau sebelum/sesudah, lalu kirim. Harga/stok lama tidak dikirim. Produk diperiksa sebelum update untuk mendeteksi perubahan terbaru dan dibaca ulang untuk memverifikasi judul/SKU.
- **Master SKU:** ekspor `master-sku.json` dari dashboard lalu impor ke modul. SKU persis diprioritaskan; kandidat lain diberi skor kemiripan token judul. Perbedaan berat/volume/isi yang terdeteksi memblokir pemilihan kandidat. Skor bukan probabilitas kebenaran; merek, varian, dan satuan tetap harus ditinjau pengguna. Tidak ada update otomatis/batch dari fuzzy matching.

API baru: `POST /shopee/api/products/create`, `POST /shopee/api/products/edit`. Keduanya memerlukan sesi OAuth dan Origin konektor. Payload diedit melalui whitelist field. Produk varian ditolak karena `item_sku` dan `model_sku` adalah data berbeda.

Validasi lokal:

```sh
cd API_shopee/functions
npm ci
node --test product-module.test.cjs
```

Pengujian menggunakan SDK tiruan, tidak menulis data toko nyata. Respons 200 UI bukan bukti akses API toko. Aktivasi online memerlukan deployment branch, OAuth toko, izin produk Shopee, serta metadata kategori/gambar/logistik yang valid. Jika request gagal/timeout, periksa toko sebelum mengirim ulang agar produk baru tidak duplikat.
