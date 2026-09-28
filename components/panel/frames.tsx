"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { usePanel } from "./store";
import { Modal, Pagination, ProductImage, Search, StoreTabs } from "./ui";

const designs = Array.from({ length: 48 }, (_, i) => ({
  id: i,
  label: [
    "NEW YEAR SALE",
    "12.12 RECOMMENDED",
    "BEST IN TOWN",
    "BIG SALE",
    "NEW YEAR SALE",
    "12.12 PROMO",
    "12.12 SALE",
    "BIG SALE",
    "FLASH SALE",
    "SUPER DEAL",
    "BEST SELLER",
    "BIG SALE !!",
  ][i % 12]!,
  color: [
    "#e56839",
    "#f1a82d",
    "#ec7045",
    "#e08530",
    "#59a44c",
    "#e7653b",
    "#f6aa3a",
    "#61b358",
    "#a22721",
    "#234f2c",
    "#f6b43c",
    "#ed7746",
  ][i % 12]!,
}));
function FrameBorder({ id }: { id: number }) {
  const f = designs[id] || designs[0]!;
  return (
    <span
      className={`frame-border frame-style-${id % 4}`}
      style={{ "--frame-color": f.color } as React.CSSProperties}
    >
      <b>{f.label}</b>
      <small>{id % 2 ? "SPECIAL PROMO" : "RECOMMENDED"}</small>
    </span>
  );
}
export default function Frames({ editor = false }: { editor?: boolean }) {
  const { state, update } = usePanel();
  const router = useRouter();
  const params = useSearchParams();
  const [shop, setShop] = useState("Semua");
  const [pick, setPick] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(12);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState("Frame Komplace");
  const [color, setColor] = useState("Semua");
  const [message, setMessage] = useState("");
  const product =
    state.products.find((p) => p.id === params.get("productId")) ||
    state.products.find((p) => p.id === "product-3") ||
    state.products[0];
  const framed = state.products.filter(
    (p) =>
      state.frames[p.id] !== undefined && (shop === "Semua" || p.shop === shop),
  );
  const options = state.products.filter(
    (p) =>
      (shop === "Semua" || p.shop === shop) &&
      p.name.toLowerCase().includes(query.toLowerCase()),
  );
  const filteredDesigns = designs.filter(
    (f) =>
      color === "Semua" ||
      (color === "Hijau"
        ? ["#59a44c", "#61b358", "#234f2c"].includes(f.color)
        : !["#59a44c", "#61b358", "#234f2c"].includes(f.color)),
  );
  function save() {
    if (product && selected !== null) {
      update((s) => ({
        ...s,
        frames: { ...s.frames, [product.id]: selected },
      }));
      router.push("/panel/product/frame/shopee");
    }
  }
  if (editor && product)
    return (
      <main className="frame-editor-page">
        <div className="frame-editor">
          <section className="frame-preview">
            <div className="preview-product">
              <ProductImage name={product.name} image={product.image} />
              {selected !== null && <FrameBorder id={selected} />}
            </div>
            <div className="preview-thumbnails">
              <ProductImage name={product.name} image={product.image} />
            </div>
          </section>
          <section className="frame-choices">
            <h1>{product.name}</h1>
            <div className="section-heading">
              <div className="tabs">
                {["Frame Komplace", "Frame Saya"].map((t) => (
                  <button
                    key={t}
                    className={tab === t ? "selected" : ""}
                    onClick={() => {
                      setTab(t);
                      setPage(1);
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <select
                aria-label="Filter warna frame"
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                  setPage(1);
                }}
              >
                {["Semua", "Oranye", "Hijau"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            {tab === "Frame Komplace" ? (
              <>
                <div className="frame-grid">
                  {filteredDesigns
                    .slice((page - 1) * size, page * size)
                    .map((f) => (
                      <button
                        aria-label={`Pilih frame ${f.id + 1}`}
                        aria-pressed={selected === f.id}
                        key={f.id}
                        className={selected === f.id ? "selected" : ""}
                        onClick={() => setSelected(f.id)}
                      >
                        <FrameBorder id={f.id} />
                      </button>
                    ))}
                </div>
                <Pagination
                  page={page}
                  setPage={setPage}
                  total={filteredDesigns.length}
                  size={size}
                  setSize={setSize}
                />
              </>
            ) : (
              <div className="saved-frame-grid">
                {Object.values(state.frames).length ? (
                  Array.from(new Set(Object.values(state.frames))).map((id) => (
                    <button
                      key={id}
                      aria-label={`Pilih frame tersimpan ${id + 1}`}
                      onClick={() => setSelected(id)}
                    >
                      <FrameBorder id={id} />
                    </button>
                  ))
                ) : (
                  <p className="table-empty">
                    Belum ada frame tersimpan. Pilih dari Frame Komplace
                    terlebih dahulu.
                  </p>
                )}
              </div>
            )}
            <div className="form-actions">
              <Link
                className="neutral-button"
                href="/panel/product/frame/shopee"
              >
                BATAL
              </Link>
              <button
                className="primary"
                disabled={selected === null}
                onClick={save}
              >
                SIMPAN & TERAPKAN
              </button>
            </div>
            <p className="local-note">
              Frame diterapkan pada pratinjau lokal. Gambar marketplace tidak
              diubah.
            </p>
          </section>
        </div>
      </main>
    );
  return (
    <main className="product-page">
      <StoreTabs value={shop} onChange={setShop} />
      {!framed.length ? (
        <section className="frame-empty">
          <h1>Belum ada Produk</h1>
          <p>Anda belum menambahkan produk yang telah di frame.</p>
          <button
            className="neutral-button"
            onClick={() => {
              setPage(1);
              setQuery("");
              setPick(true);
            }}
          >
            TAMBAH PRODUK ⌄
          </button>
        </section>
      ) : (
        <>
          <div className="table-toolbar">
            <h1>Produk dengan Frame</h1>
            <button
              className="primary"
              onClick={() => {
                setPage(1);
                setQuery("");
                setPick(true);
              }}
            >
              + TAMBAH PRODUK
            </button>
          </div>
          <div className="framed-products">
            {framed.map((p) => (
              <article key={p.id}>
                <div className="preview-product">
                  <ProductImage name={p.name} image={p.image} />
                  <FrameBorder id={state.frames[p.id]!} />
                </div>
                <h2>{p.name}</h2>
                <div className="form-actions">
                  <Link
                    className="outline"
                    href={`/panel/product/frame/shopee/add?productId=${p.id}`}
                  >
                    EDIT FRAME
                  </Link>
                  <button
                    className="neutral-button"
                    onClick={() => {
                      update((s) => {
                        const frames = { ...s.frames };
                        delete frames[p.id];
                        return { ...s, frames };
                      });
                      setMessage("Frame dilepas dari pratinjau lokal.");
                    }}
                  >
                    LEPAS
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {pick && (
        <Modal title="Tambah Produk" close={() => setPick(false)} wide>
          <Search
            value={query}
            onChange={(s) => {
              setQuery(s);
              setPage(1);
            }}
          />
          <div className="product-picker">
            {options.slice((page - 1) * 8, page * 8).map((p) => (
              <article key={p.id}>
                <ProductImage name={p.name} image={p.image} />
                <p>{p.name}</p>
                <Link
                  className="outline"
                  href={`/panel/product/frame/shopee/add?productId=${p.id}`}
                  onClick={() => setPick(false)}
                >
                  ATUR FRAME
                </Link>
              </article>
            ))}
          </div>
          {!options.length && (
            <p className="table-empty">Produk tidak ditemukan.</p>
          )}
          <div className="form-actions">
            <button
              className="neutral-button"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              ← Sebelumnya
            </button>
            <span>
              {page} / {Math.max(1, Math.ceil(options.length / 8))}
            </span>
            <button
              className="neutral-button"
              disabled={page >= Math.ceil(options.length / 8)}
              onClick={() => setPage(page + 1)}
            >
              Berikutnya →
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
