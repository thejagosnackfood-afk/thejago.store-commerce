# Integrasi SID Retail → Shopee

Aplikasi pada root repository ini adalah storefront Next.js yang memakai Shopify. Integrasi operasional ditempatkan di direktori ini supaya kode storefront dan proses sinkronisasi tidak tercampur.

## Alur yang disiapkan

1. Agent di PC/server toko membaca **view SQL SID yang hanya memiliki izin SELECT**. Nama tabel dan kolom asli SID belum diketahui, jadi query produksi belum dibuat.
2. Agent mengirim snapshot stok melalui HTTPS ke layanan integrasi yang memiliki autentikasi, validasi, dan pencatatan waktu.
3. Layanan mencocokkan `sid_product_code` dengan `shop_id`, `item_id`, dan `model_id` Shopee dari tabel mapping terpisah.
4. Layanan menghitung stok yang boleh dijual, menyimpan rencana perubahan, dan menjalankan pengiriman hanya setelah koneksi Open Platform resmi, otorisasi seller, serta mode sinkronisasi disetujui.
5. Hasil dan kegagalan disimpan sebagai log. Perubahan stok SID akibat order Shopee membutuhkan jalur transaksi yang didukung SID dan penanganan order ganda.

Tidak ada endpoint Shopee atau kredensial SQL yang dipanggil oleh kode dalam direktori ini. Modul `stock.ts` hanya memvalidasi snapshot dan menyiapkan keputusan yang aman untuk dipakai adapter setelah skema dan akses tersedia.

## Data yang perlu dicocokkan

| Data SID | Data Shopee | Catatan |
| --- | --- | --- |
| kode barang unik | shop_id + item_id + model_id | Wajib unik per varian, jangan cocokkan berdasarkan nama |
| barcode | SKU penjual | Bantuan pencocokan; cek duplikasi dan satuan |
| stok tersedia | stok model | Tentukan lokasi/gudang, stok tertahan, dan batas aman |
| waktu perubahan | waktu snapshot | Tolak snapshot lama agar stok tidak kembali ke angka sebelumnya |

Setiap perubahan stok harus menggunakan mapping yang disetujui. Produk tanpa mapping atau dengan mapping ganda masuk daftar pemeriksaan dan tidak dikirim ke Shopee.

## Sebelum mengaktifkan sinkronisasi

- Pastikan engine, versi, contoh **struktur** tabel/view SID (tanpa data pelanggan atau kata sandi), lokasi stok, satuan, dan aturan stok tersedia.
- Dapatkan akses Shopee Open Platform yang aktif, partner ID/key dan otorisasi toko. Simpan rahasia hanya di secret manager/environment runtime, bukan GitHub.
- Tentukan host agent toko, tujuan HTTPS, database integrasi terpisah, dan frekuensi pengiriman. Jangan buka port SQL toko ke internet.
- Uji dengan beberapa SKU dan mode simulasi; verifikasi variasi/model, stok nol, konflik mapping, pembatalan order, serta batas rate API sebelum mengaktifkan penulisan.

## Struktur

```
integrations/
  README.md               alur dan prasyarat
  shopee/
    stock.ts              validasi snapshot dan rencana perubahan
    stock.test.ts         uji keputusan tanpa akses jaringan
```
