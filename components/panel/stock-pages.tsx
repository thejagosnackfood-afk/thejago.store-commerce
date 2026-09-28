"use client";

import { useState } from "react";
import { usePanel } from "./store";
import { Notice, Pagination, ProductImage, Search, Switch } from "./ui";
import { productPhoto } from "../../lib/panel-data";

export function StockSettings() {
  const { state, update } = usePanel();
  return (
    <main className="product-page settings-page">
      <section className="setting-card">
        <div>
          <h1>Monitor Stok dan Sinkronasi</h1>
          <Switch
            label="Monitor Stok dan Sinkronasi"
            checked={state.monitor}
            onChange={() => update((s) => ({ ...s, monitor: !s.monitor }))}
          />
        </div>
        <p>
          <span className="text-orange">ⓘ</span> Untuk memastikan keakuratan
          Stok, sinkronisasikan semua produk dan pesanan dan set Stok Master SKU
          sebelum mengaktifkannya.
        </p>
        <p>
          Setelah diaktifkan, Komplace secara otomatis akan menambah atau
          mengurangi Stok Master SKU sesuai dengan status pesanan setelah
          sinkronisasi pesanan, dan menyinkronkan stok tersedia dari Master SKU
          ke toko tempat barang yang telah diikat.
        </p>
      </section>
      {state.monitor && (
        <section className="setting-card">
          <div>
            <h2>Return Stok Otomatis</h2>
            <Switch
              label="Return Stok Otomatis"
              checked={state.returns}
              onChange={() => update((s) => ({ ...s, returns: !s.returns }))}
            />
          </div>
          <p>
            <span className="text-orange">ⓘ</span> Stok akan dikembalikan ke
            Master Stok ketika pesanan dibatalkan atau dikembalikan.
          </p>
          <p>Pastikan kondisi barang sebelum mengembalikan stok.</p>
        </section>
      )}
      <p className="local-note" role="status">
        Pengaturan tersimpan di browser ini. Sinkronisasi marketplace belum
        terhubung.
      </p>
    </main>
  );
}
export function StockHistory() {
  const { state } = usePanel();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [filter, setFilter] = useState("Semua");
  const [reverse, setReverse] = useState(false);
  const filtered = state.history.filter(
    (h) =>
      `${h.name} ${h.sku}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "Semua" ||
        (filter === "Penambahan" ? h.delta > 0 : h.delta < 0)),
  );
  const rows = reverse ? [...filtered].reverse() : filtered;
  return (
    <main className="product-page">
      <Notice>
        Perhatian! Perubahan stok dari Lazada akan di-update setiap 1 menit,
        silakan cek secara berkala!
      </Notice>
      <div className="table-toolbar">
        <Search
          value={query}
          onChange={(s) => {
            setQuery(s);
            setPage(1);
          }}
          placeholder="Cari Nama Produk atau Master SKU"
        />
        <select
          aria-label="Jenis perubahan"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
        >
          {["Semua", "Penambahan", "Pengurangan"].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </div>
      <div className="table-scroll">
        <table className="product-table">
          <thead>
            <tr>
              <th>Nama</th>
              <th>Master SKU</th>
              <th>Perubahan Stok</th>
              <th>Stok Baru</th>
              <th>
                <button onClick={() => setReverse(!reverse)}>
                  Waktu Perubahan {reverse ? "↑" : "↓"}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice((page - 1) * size, page * size).map((h) => (
              <tr key={h.id}>
                <td>
                  <div className="product-name">
                    <ProductImage name={h.name} image={productPhoto(h.name)} />
                    <div>
                      {h.name}
                      <small>
                        ▣{" "}
                        {h.id.startsWith("history")
                          ? "Pesanan contoh"
                          : "Perubahan lokal"}
                      </small>
                    </div>
                  </div>
                </td>
                <td className="sku-cell">♧ {h.sku}</td>
                <td className={h.delta < 0 ? "negative" : "positive"}>
                  {h.delta > 0 ? "+" : ""}
                  {h.delta}
                </td>
                <td>{h.stock}</td>
                <td>
                  {new Date(h.time).toLocaleString("id-ID")}
                  <small className="cell-note">
                    {h.id.startsWith("history")
                      ? "Sinkron Otomatis · contoh"
                      : "Edit stok lokal"}
                  </small>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="table-empty">
                  Belum ada riwayat yang cocok.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        setPage={setPage}
        total={rows.length}
        size={size}
        setSize={setSize}
      />
      <p className="local-note">
        Riwayat contoh dan perubahan stok yang Anda lakukan di browser ini.
      </p>
    </main>
  );
}
