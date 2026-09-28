"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { usePanel } from "./store";
import {
  Modal,
  Notice,
  Pagination,
  ProductImage,
  Search,
  StoreTabs,
} from "./ui";
import { type Product } from "../../lib/panel-data";
import { readStockChanges, stockCsv } from "../../lib/stock-csv";

type Mode = "products" | "master" | "stock";
export default function Products({ mode }: { mode: Mode }) {
  const { state, update, ready, storageError } = usePanel();
  const [query, setQuery] = useState("");
  const [shop, setShop] = useState("Semua");
  const [status, setStatus] = useState("Aktif");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [sort, setSort] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [editing, setEditing] = useState<Product | null>(null);
  const [dialog, setDialog] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [importText, setImportText] = useState("");
  const source = mode === "stock" ? state.stocks : state.products;
  const filtered = source.filter(
    (p) =>
      `${p.name} ${p.sku} ${p.variant}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (mode !== "products" ||
        ((shop === "Semua" || p.shop === shop) && p.status === status)),
  );
  const sorted = sort
    ? [...filtered].sort((a, b) => a.stock - b.stock)
    : filtered;
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(sorted.length / size)),
  );
  const rows = sorted.slice((currentPage - 1) * size, currentPage * size);
  const changeQuery = (s: string) => {
    setQuery(s);
    setPage(1);
  };
  function openEdit(p: Product) {
    setEditing({ ...p });
    setError("");
  }
  function save() {
    if (!editing) return;
    if (
      !editing.name.trim() ||
      !editing.sku.trim() ||
      !Number.isSafeInteger(editing.stock) ||
      editing.stock < 0 ||
      !Number.isFinite(editing.price) ||
      editing.price < 0
    ) {
      setError("Nama, SKU, harga, dan stok harus valid.");
      return;
    }
    if (source.some((p) => p.id !== editing.id && p.sku === editing.sku)) {
      setError("SKU sudah digunakan.");
      return;
    }
    const previous = source.find((p) => p.id === editing.id);
    const value = {
      ...editing,
      status:
        editing.stock === 0
          ? "Stok Habis"
          : editing.status === "Stok Habis"
            ? "Aktif"
            : editing.status,
    };
    update((s) => ({
      ...s,
      [mode === "stock" ? "stocks" : "products"]: previous
        ? source.map((p) => (p.id === value.id ? value : p))
        : [value, ...source],
      history:
        previous && previous.stock !== value.stock
          ? [
              {
                id: crypto.randomUUID(),
                name: value.name,
                sku: value.sku,
                delta: value.stock - previous.stock,
                stock: value.stock,
                time: new Date().toISOString(),
              },
              ...s.history,
            ]
          : s.history,
    }));
    setEditing(null);
    setMessage("Perubahan disimpan di browser ini.");
  }
  function exportStock() {
    const blob = new Blob(
      [
        stockCsv(
          selected.length
            ? filtered.filter((p) => selected.includes(p.id))
            : filtered,
        ),
      ],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "komplace-stok.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("CSV stok sudah diekspor.");
  }
  function importStock() {
    try {
      const changes = readStockChanges(
        importText,
        new Set(state.stocks.map((p) => p.sku)),
      );
      update((s) => ({
        ...s,
        stocks: s.stocks.map((p) =>
          changes.has(p.sku)
            ? {
                ...p,
                stock: changes.get(p.sku)!,
                status:
                  changes.get(p.sku)! === 0
                    ? "Stok Habis"
                    : p.status === "Stok Habis"
                      ? "Aktif"
                      : p.status,
              }
            : p,
        ),
        history: [
          ...s.stocks
            .filter((p) => changes.has(p.sku) && changes.get(p.sku) !== p.stock)
            .map((p) => ({
              id: crypto.randomUUID(),
              name: p.name,
              sku: p.sku,
              delta: changes.get(p.sku)! - p.stock,
              stock: changes.get(p.sku)!,
              time: new Date().toISOString(),
            })),
          ...s.history,
        ],
      }));
      setDialog("");
      setError("");
      setImportText("");
      setMessage(`${changes.size} baris stok berhasil diimpor secara lokal.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main
      className="product-page"
      aria-label={
        mode === "stock"
          ? "Daftar Stok"
          : mode === "master"
            ? "Master Produk"
            : "Produk Saya"
      }
    >
      {mode === "products" && (
        <StoreTabs
          value={shop}
          onChange={(s) => {
            setShop(s);
            setPage(1);
          }}
        />
      )}
      {mode === "stock" ? (
        <Notice>
          Perhatian! Stok barang yang di-return oleh pembeli tidak akan kembali
          ke Master Stok secara otomatis. Silakan cek kondisi barang dan lakukan
          push stok secara manual!{" "}
          <Link href="/panel/product/master/stock/setting">
            Ubah Pengaturan
          </Link>
        </Notice>
      ) : mode === "products" ? (
        <Notice>
          Disarankan untuk selalu melakukan edit produk dan menambahkan variasi
          produk melalui Komplace.
        </Notice>
      ) : (
        <div className="page-heading">
          <h1>Master Produk</h1>
          <span>{source.length} produk contoh</span>
        </div>
      )}
      <div className="table-toolbar">
        <Search
          value={query}
          onChange={changeQuery}
          placeholder={
            mode === "stock"
              ? "Cari Produk Berdasarkan Nama atau Master SKU"
              : "Cari Nama Produk atau SKU"
          }
        />
        <div className="toolbar-actions">
          {mode === "stock" ? (
            <>
              <button className="outline" onClick={exportStock}>
                ⇩ EXPORT STOK
              </button>
              <button
                className="primary"
                onClick={() => {
                  setDialog("Import Stok");
                  setError("");
                  setImportText("");
                }}
              >
                ⇧ IMPORT STOK
              </button>
            </>
          ) : (
            <>
              <button
                className="neutral-button"
                onClick={() => setDialog("Sinkron Produk")}
              >
                SINKRON PRODUK ⌄
              </button>
              <button
                className="primary"
                onClick={() =>
                  openEdit({
                    id: crypto.randomUUID(),
                    name: "",
                    sku: "",
                    variant: "Original",
                    stock: 0,
                    price: 0,
                    shop: "A2HShop",
                    status: "Draft",
                  })
                }
              >
                + TAMBAH PRODUK
              </button>
            </>
          )}
        </div>
      </div>
      {mode === "products" && (
        <div className="tabs">
          {[
            "Aktif",
            "Draft",
            "Stok Habis",
            "Sedang Diperiksa",
            "Diarsipkan",
            "Ditolak",
          ].map((t) => (
            <button
              className={status === t ? "selected" : ""}
              key={t}
              onClick={() => {
                setStatus(t);
                setPage(1);
              }}
            >
              {t} (
              {
                source.filter(
                  (p) =>
                    p.status === t && (shop === "Semua" || p.shop === shop),
                ).length
              }
              )
            </button>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <div className="selection-bar">
          {selected.length} dipilih{" "}
          <button onClick={() => setSelected([])}>Batalkan pilihan</button>
          {mode !== "stock" && (
            <button
              onClick={() => {
                update((s) => ({
                  ...s,
                  products: s.products.map((p) =>
                    selected.includes(p.id)
                      ? { ...p, status: "Diarsipkan" }
                      : p,
                  ),
                }));
                setSelected([]);
                setMessage("Produk diarsipkan secara lokal.");
              }}
            >
              Arsipkan
            </button>
          )}
        </div>
      )}
      {message && (
        <div className="success-message" role="status">
          {message}
          <button aria-label="Tutup pesan" onClick={() => setMessage("")}>
            ×
          </button>
        </div>
      )}
      <div className="table-scroll">
        <table className="product-table">
          <thead>
            <tr>
              <th className="check-cell">
                <input
                  type="checkbox"
                  aria-label="Pilih semua di halaman ini"
                  checked={
                    rows.length > 0 &&
                    rows.every((p) => selected.includes(p.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? Array.from(
                            new Set([...selected, ...rows.map((p) => p.id)]),
                          )
                        : selected.filter(
                            (id) => !rows.some((p) => p.id === id),
                          ),
                    )
                  }
                />
              </th>
              <th>{mode === "stock" ? "Nama" : "Nama Produk"}</th>
              {mode !== "stock" && <th>Master SKU</th>}
              {mode === "products" && <th>Harga</th>}
              <th>
                <button onClick={() => setSort(!sort)}>
                  Stok {sort ? "↑" : "↕"}
                </button>
              </th>
              {mode === "stock" && (
                <>
                  <th>Varian Terikat</th>
                  <th>Terakhir Diubah</th>
                </>
              )}
              <th>
                <span className="sr-only">Aksi</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <Fragment key={p.id}>
                <tr>
                  <td className="check-cell">
                    <input
                      aria-label={`Pilih ${p.name} ${p.variant}`}
                      type="checkbox"
                      checked={selected.includes(p.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, p.id]
                            : selected.filter((id) => id !== p.id),
                        )
                      }
                    />
                  </td>
                  <td>
                    <div className="product-name">
                      <ProductImage name={p.name} image={p.image} />
                      <div>
                        <span>{p.name}</span>
                        {mode === "stock" ? (
                          <>
                            <small>{p.variant}</small>
                            <small>♧ MSKU: {p.sku}</small>
                          </>
                        ) : (
                          <small>
                            <mark>{p.shop}</mark> SKU : {p.sku}
                          </small>
                        )}
                      </div>
                    </div>
                  </td>
                  {mode !== "stock" && <td className="sku-cell">{p.sku}</td>}
                  {mode === "products" && (
                    <td className="price-cell">
                      Rp {p.price.toLocaleString("id-ID")}
                    </td>
                  )}
                  <td>{p.stock}</td>
                  {mode === "stock" && (
                    <>
                      <td>
                        <button
                          className="text-orange"
                          onClick={() => {
                            setEditing(p);
                            setDialog("Varian Terikat");
                          }}
                        >
                          1 Varian Terikat
                        </button>
                      </td>
                      <td className="muted">
                        {state.history.find((h) => h.sku === p.sku)?.time
                          ? new Date(
                              state.history.find((h) => h.sku === p.sku)!.time,
                            ).toLocaleString("id-ID")
                          : "22/09/2026 13:15"}
                      </td>
                    </>
                  )}
                  <td>
                    <button
                      className="neutral-button small"
                      onClick={() => openEdit(p)}
                    >
                      ATUR ⌄
                    </button>
                  </td>
                </tr>
                {mode !== "stock" && (
                  <tr className="variant-row">
                    <td />
                    <td colSpan={mode === "products" ? 5 : 4}>
                      <button
                        onClick={() =>
                          setExpanded(
                            expanded.includes(p.id)
                              ? expanded.filter((id) => id !== p.id)
                              : [...expanded, p.id],
                          )
                        }
                        aria-expanded={expanded.includes(p.id)}
                      >
                        {mode === "master"
                          ? "Lihat Semua Varian"
                          : "Lihat Varian Produk"}
                        <span>⌄</span>
                      </button>
                      {expanded.includes(p.id) && (
                        <div className="variant-detail">
                          <span>{p.variant}</span>
                          <span>{p.sku}</span>
                          <span>Stok: {p.stock}</span>
                          <button
                            className="text-orange"
                            onClick={() => openEdit(p)}
                          >
                            Edit varian
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={7} className="table-empty">
                  Tidak ada produk yang cocok dengan filter Anda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={currentPage}
        setPage={setPage}
        total={filtered.length}
        size={size}
        setSize={setSize}
      />
      <p className="local-note">
        {storageError
          ? "Penyimpanan browser tidak tersedia; perubahan hanya berlaku selama sesi ini."
          : mode === "stock"
            ? "Data awal dari list-komplace-stock.xlsx. Perubahan disimpan lokal di browser."
            : "Data produk contoh dari rekaman. Perubahan disimpan lokal di browser."}
        {!ready && " Memuat…"}
      </p>
      {editing && !dialog && (
        <Modal
          title={mode === "stock" ? "Atur Stok" : "Atur Produk"}
          close={() => setEditing(null)}
        >
          <form
            className="panel-form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label>
              Nama produk
              <input
                required
                value={editing.name}
                disabled={mode === "stock"}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </label>
            <label>
              Master SKU
              <input
                required
                value={editing.sku}
                disabled={mode === "stock"}
                onChange={(e) =>
                  setEditing({ ...editing, sku: e.target.value })
                }
              />
            </label>
            <div className="form-columns">
              <label>
                Stok
                <input
                  type="number"
                  min="0"
                  step="1"
                  required
                  value={Number.isNaN(editing.stock) ? "" : editing.stock}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      stock:
                        e.target.value === "" ? NaN : Number(e.target.value),
                    })
                  }
                />
              </label>
              {mode !== "stock" && (
                <label>
                  Harga (Rp)
                  <input
                    type="number"
                    min="0"
                    required
                    value={editing.price}
                    onChange={(e) =>
                      setEditing({ ...editing, price: Number(e.target.value) })
                    }
                  />
                </label>
              )}
            </div>
            {mode !== "stock" && (
              <label>
                Status
                <select
                  value={editing.status}
                  onChange={(e) =>
                    setEditing({ ...editing, status: e.target.value })
                  }
                >
                  {["Aktif", "Draft", "Stok Habis", "Diarsipkan"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="neutral-button"
                onClick={() => setEditing(null)}
              >
                Batal
              </button>
              <button className="primary">Simpan</button>
            </div>
          </form>
        </Modal>
      )}
      {dialog && (
        <Modal
          title={dialog}
          close={() => {
            setDialog("");
            setEditing(null);
          }}
        >
          {dialog === "Import Stok" ? (
            <div className="panel-form">
              <p>
                Gunakan CSV hasil Export Stok. Ubah hanya kolom Stok. Perubahan
                berlaku pada data lokal.
              </p>
              <input
                aria-label="File CSV stok"
                type="file"
                accept=".csv,text/csv"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setImportText(await file.text());
                    setError("");
                  }
                }}
              />
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
              <button
                disabled={!importText}
                className="primary"
                onClick={importStock}
              >
                Import Stok
              </button>
            </div>
          ) : dialog === "Varian Terikat" ? (
            <>
              <p>{editing?.name}</p>
              <div className="variant-detail">
                <span>Shopee · {editing?.shop}</span>
                <span>{editing?.variant}</span>
                <span>Stok: {editing?.stock}</span>
              </div>
            </>
          ) : (
            <p>
              Sinkronisasi membutuhkan koneksi marketplace. Daftar ini
              menggunakan data lokal dan tidak mengubah toko asli.
            </p>
          )}
        </Modal>
      )}
    </main>
  );
}
