# Komplace panel — rekonstruksi UI

Dashboard dan halaman produk Next.js/React berdasarkan screenshot serta rekaman layar yang diberikan. Layout desktop menggunakan navigasi atas dan sidebar, sedangkan layar kecil menggunakan menu lipat dan navigasi bawah.

## Menjalankan

```sh
pnpm install
pnpm dev --hostname 0.0.0.0 --port 3000
```

Buka `/panel/home` di localhost:3000 atau URL port 3000 Codespaces.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

Jika URL Firebase Shopee berbeda dari default, set env publik panel:

```sh
NEXT_PUBLIC_SHOPEE_CONSOLE_URL=https://thejagosidconnect.firebaseapp.com/shopee
```

## Halaman

| Tampilan                   | Rute                                                  |
| -------------------------- | ----------------------------------------------------- |
| Dashboard                  | `/panel/home` (juga `/`)                              |
| Produk Saya                | `/panel/product/mp/shopee`                            |
| Master Produk              | `/panel/product/master`                               |
| Daftar Stok                | `/panel/product/stock`                                |
| Pengaturan Stok            | `/panel/product/master/stock/setting`                 |
| Riwayat Stok               | `/panel/product/stock/log`                            |
| Scrape                     | `/panel/product/scrape`                               |
| Clone Toko                 | `/panel/product/clone`                                |
| Naikan Produk              | `/panel/product/boost`                                |
| Pengaturan antrean A2HShop | `/panel/product/boost/a2hshop/setting`                |
| Pengaturan antrean Jago    | `/panel/product/boost/jago/setting`                   |
| Atur Frame                 | `/panel/product/frame/shopee`                         |
| Editor Frame               | `/panel/product/frame/shopee/add?productId=product-3` |

## Perilaku lokal

- Cari, filter toko/status, urutkan stok, pilih baris, lihat varian, dan pagination.
- Tambah/edit produk, arsipkan pilihan, edit stok, dan riwayat perubahan stok.
- Export/import **CSV** stok menggunakan kolom `Master SKU` dan `Stok`. SKU tak dikenal, duplikat, stok kosong/negatif/pecahan ditolak sebelum perubahan diterapkan. Impor XLSX lewat UI belum tersedia.
- Switch pengaturan stok, clone produk menjadi draft toko tujuan, aktif/nonaktif naikan produk, serta tambah/hapus antrean.
- Pilih produk, pratinjau frame, simpan/ubah/lepas frame.
- Produk, stok, riwayat, pengaturan, antrean, dan frame disimpan di `localStorage` dengan kunci `komplace-demo-v1`. Hapus kunci ini untuk mengembalikan data awal. Pengaturan jeda antrean adalah pratinjau dalam sesi halaman.

Daftar Stok memakai 1.677 baris dari `sample database csv/list-komplace-stock.xlsx`, dikonversi menjadi `lib/stock-seed.json`. File Excel asal tidak diubah. Daftar produk, harga, toko, dan riwayat awal menggunakan data contoh. Daftar produk dan daftar stok adalah kumpulan demo terpisah, belum terhubung melalui Master SKU. Thumbnail berasal dari bagian produk dalam video; produk tanpa aset memakai ikon pengganti. Desain frame, logo, dan ikon dibuat mendekati referensi, bukan aset asli.

Tidak ada login, API marketplace, scraper, publikasi produk, atau penjadwalan naik otomatis yang aktif. Halaman lain yang tidak diperlihatkan dalam rekaman (Chat, Order, Affiliate, dan sebagainya) menampilkan informasi keterbatasan saat dipilih. SDK pada folder `API_shopee` adalah proyek terpisah dan tidak termasuk pemeriksaan TypeScript aplikasi ini.

## Struktur

- `app/panel/[...slug]/page.tsx`: rute halaman yang didukung.
- `components/panel/`: shell, dashboard, tabel, tools, editor frame, dan penyimpanan lokal.
- `app/panel.css`: tampilan desktop/mobile halaman panel.
- `lib/stock-csv.ts`: validasi dan serialisasi CSV stok.
- `tests/stock-csv.test.cjs`: pengujian format CSV serta impor tidak valid.
- `archive/legacy-product-page.tsx.txt`: arsip halaman Shopify lama.
- `API_shopee/`: Firebase Function untuk OAuth dan endpoint Shopee Open API V2 resmi.

## Shopee Open API

Folder `API_shopee` berisi connector server-side untuk Shopee Open API V2:
OAuth, callback, token session, cek koneksi, shop info, order, product, dan
logistics channel. Mulai dari `API_shopee/README.md`, lalu buka console Firebase
di `https://thejagosidconnect.firebaseapp.com/shopee`. Default deploy connector
hanya mengirim Functions agar hosting utama tidak terganggu.
