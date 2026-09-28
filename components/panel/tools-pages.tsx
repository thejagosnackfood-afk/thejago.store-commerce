"use client";

import Link from "next/link";
import { useState } from "react";
import { usePanel } from "./store";
import { Icon } from "./icon";
import { Modal, Notice, ProductImage, Search, stores, Switch } from "./ui";

const shopeeConsoleUrl =
  process.env.NEXT_PUBLIC_SHOPEE_CONSOLE_URL ||
  "https://dasboardmarket.firebaseapp.com/shopee";

export function Scrape() {
  const [tab, setTab] = useState("Semua");
  const [query, setQuery] = useState("");
  const [info, setInfo] = useState("");
  const [market, setMarket] = useState("Semua");
  return (
    <main className="product-page">
      <div className="tabs">
        <span className="selected">Scrape By Extension</span>
      </div>
      <Notice>
        Mohon Maaf, terdapat ketidakakuratan data stok pada fitur scrape karena
        adanya pembatasan dari platform!
      </Notice>
      <section className="scrape-instructions">
        <h2>
          3 Langkah menggunakan Scrape by Extension untuk hasil yang lebih
          akurat
        </h2>
        <ol>
          <li>Wajib menggunakan Google Chrome 🌐</li>
          <li>
            Unduh Extension{" "}
            <button onClick={() => setInfo("Extension")}>Disini</button>
          </li>
          <li>
            Tutorial menggunakan Scrape by Extension{" "}
            <button onClick={() => setInfo("Tutorial")}>Disini</button>
          </li>
        </ol>
        <p>
          ♧ Marketplace yang didukung <span className="shopee">S</span>{" "}
          <span className="shopee">J</span>
        </p>
      </section>
      <h2 className="subheading">Hasil Scrape</h2>
      <div className="tabs">
        {["Semua", "Belum Disalin", "Pernah Disalin"].map((t) => (
          <button
            className={tab === t ? "selected" : ""}
            key={t}
            onClick={() => setTab(t)}
          >
            {t} (0)
          </button>
        ))}
      </div>
      <div className="table-toolbar">
        <Search value={query} onChange={setQuery} />
        <select
          aria-label="Filter marketplace"
          value={market}
          onChange={(e) => setMarket(e.target.value)}
        >
          {["Semua", "Shopee", "Lazada"].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </div>
      <div className="table-scroll">
        <table className="product-table">
          <thead>
            <tr>
              <th>Nama Produk</th>
              <th>Harga</th>
              <th>Stok</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={3} className="table-empty">
                Tidak ada data scrape{query ? ` untuk “${query}”` : ""}.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="local-note">
        Tampilan berdasarkan rekaman. Untuk koneksi resmi Shopee Open API,
        gunakan console server-side agar partner key tetap aman.
      </p>
      <div className="actions-row">
        <a
          className="outline"
          href={`${shopeeConsoleUrl}/api/shopee-connection`}
          target="_blank"
          rel="noreferrer"
        >
          CEK KONEKSI SHOPEE
        </a>
        <a
          className="primary"
          href={shopeeConsoleUrl}
          target="_blank"
          rel="noreferrer"
        >
          HUBUNGKAN TOKO SHOPEE
        </a>
      </div>
      {info && (
        <Modal title={info} close={() => setInfo("")}>
          <p>
            Rekaman tidak menyertakan tautan {info.toLowerCase()}. Fitur scrape
            membutuhkan ekstensi dan integrasi resmi.
          </p>
        </Modal>
      )}
    </main>
  );
}

const markets = ["Shopee", "Toco", "Tokopedia", "Lazada", "Tiktok"];
const marketIcons = ["🟠", "🟡", "🟢", "🟣", "⚫"];
export function CloneStore() {
  const { state, update } = usePanel();
  const [fromMarket, setFromMarket] = useState("Shopee");
  const [toMarket, setToMarket] = useState("Shopee");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [scope, setScope] = useState("Semua");
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const available = state.products.filter(
    (p) => p.shop === from && (scope === "Semua" || p.status === "Aktif"),
  );
  const canCopy = Boolean(from && to && from !== to && available.length);
  function copy() {
    update((s) => ({
      ...s,
      products: [
        ...s.products,
        ...available.map((p) => ({
          ...p,
          id: crypto.randomUUID(),
          sku: `${p.sku}-COPY-${crypto.randomUUID().slice(0, 6)}`,
          shop: to,
          status: "Draft",
        })),
      ],
    }));
    setConfirm(false);
    setMessage(
      `${available.length} produk disalin sebagai draft lokal ke ${to}.`,
    );
  }
  return (
    <main className="product-page">
      <div className="clone-layout">
        {[false, true].map((target) => {
          const market = target ? toMarket : fromMarket;
          const shop = target ? to : from;
          return (
            <section className="clone-card" key={String(target)}>
              <div className="clone-visual">
                <Icon name="shop" size={66} />
                <span>{marketIcons[markets.indexOf(market)]}</span>
                <h2>{shop || " "}</h2>
              </div>
              <div className="clone-form">
                <h2>{target ? "Tujuan Salin" : "Salin Dari"}</h2>
                <label>Marketplace</label>
                <div className="market-options">
                  {markets.map((m, i) => (
                    <button
                      className={market === m ? "selected" : ""}
                      key={m}
                      onClick={() => {
                        if (target) {
                          setToMarket(m);
                          setTo("");
                        } else {
                          setFromMarket(m);
                          setFrom("");
                        }
                        setMessage("");
                      }}
                    >
                      {marketIcons[i]} {m}
                      {market === m && <span>✓</span>}
                    </button>
                  ))}
                </div>
                <label htmlFor={target ? "to-store" : "from-store"}>
                  Pilih Toko
                </label>
                <select
                  id={target ? "to-store" : "from-store"}
                  value={shop}
                  onChange={(e) =>
                    target ? setTo(e.target.value) : setFrom(e.target.value)
                  }
                >
                  <option value="">Pilih Toko</option>
                  {market === "Shopee" &&
                    stores
                      .filter((s) => (target ? s !== from : true))
                      .map((s) => <option key={s}>{s}</option>)}
                </select>
                {market !== "Shopee" && (
                  <p className="muted">Belum ada toko {market} terintegrasi.</p>
                )}
                {!target && (
                  <>
                    <label>Produk</label>
                    <div className="radio-row">
                      {["Semua", "Aktif"].map((x) => (
                        <label key={x}>
                          <input
                            type="radio"
                            name="scope"
                            checked={scope === x}
                            onChange={() => setScope(x)}
                          />
                          {x} (
                          {
                            state.products.filter(
                              (p) =>
                                p.shop === from &&
                                (x === "Semua" || p.status === "Aktif"),
                            ).length
                          }
                          )
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <div className="clone-actions">
        <button
          className="primary"
          disabled={!canCopy}
          onClick={() => setConfirm(true)}
        >
          SALIN PRODUK
        </button>
      </div>
      {message && (
        <div role="status" className="success-message">
          {message}{" "}
          <Link href="/panel/product/mp/shopee">Lihat Produk Saya →</Link>
        </div>
      )}
      <p className="local-note">
        Penyalinan hanya membuat draft di browser ini. Hubungkan Shopee Open API
        resmi untuk membaca toko, pesanan, dan produk dari server console.
      </p>
      <div className="actions-row">
        <a
          className="outline"
          href={`${shopeeConsoleUrl}/api/products?page_size=20`}
          target="_blank"
          rel="noreferrer"
        >
          TEST PRODUK SHOPEE
        </a>
        <a
          className="primary"
          href={shopeeConsoleUrl}
          target="_blank"
          rel="noreferrer"
        >
          OPEN API CONSOLE
        </a>
      </div>
      {confirm && (
        <Modal title="Salin Produk" close={() => setConfirm(false)}>
          <p>
            Salin {available.length} produk dari {from} ke {to} sebagai draft
            lokal?
          </p>
          <div className="form-actions">
            <button
              className="neutral-button"
              onClick={() => setConfirm(false)}
            >
              Batal
            </button>
            <button className="primary" onClick={copy}>
              Salin sekarang
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

export function Boost({
  detail = false,
  storeId = "a2hshop",
}: {
  detail?: boolean;
  storeId?: string;
}) {
  const { state, update } = usePanel();
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState(false);
  const [delay, setDelay] = useState(4);
  const [message, setMessage] = useState("");
  const idx = storeId === "jago" ? 1 : 0;
  const cards = ["chocolatos", "beras", "bumbu", "bihun", "pulen"];
  const featured = state.products
    .slice(16, 20)
    .concat(state.products.slice(3, 4));
  return (
    <main className="product-page">
      {detail ? (
        <div className="boost-detail">
          <div className="page-heading">
            <div>
              <Link href="/panel/product/boost">← Naikan Produk</Link>
              <h1>{stores[idx]}</h1>
            </div>
            <Switch
              label="Aktifkan naikan produk"
              checked={state.boost[idx]!}
              onChange={() =>
                update((s) => ({
                  ...s,
                  boost: s.boost.map((b, i) => (i === idx ? !b : b)),
                }))
              }
            />
          </div>
          <div className="boost-settings">
            <label>
              Jeda naik{" "}
              <select
                value={delay}
                onChange={(e) => setDelay(Number(e.target.value))}
              >
                {[4, 6, 8, 12].map((n) => (
                  <option key={n} value={n}>
                    {n} jam
                  </option>
                ))}
              </select>
            </label>
            <span>
              {state.boost[idx]
                ? "Naikan otomatis aktif (simulasi)"
                : "Naikan otomatis nonaktif"}
            </span>
          </div>
          <div className="featured-products">
            {featured.map((p, i) => (
              <article key={p.id}>
                <ProductImage name={p.name} image={cards[i]} />
                <p>{p.name}</p>
                <span className="countdown">
                  ♧ {String(delay).padStart(2, "0")}:43:18
                </span>
              </article>
            ))}
          </div>
          <p className="local-note">
            ⓘ Pastikan Anda telah menonaktifkan naikan otomatis di platform
            pihak ketiga lainnya. Waktu di atas merupakan contoh.
          </p>
          <div className="section-heading queue-heading">
            <h2>Antrean Dinaikkan</h2>
            <button className="outline" onClick={() => setPick(true)}>
              + TAMBAH ANTREAN
            </button>
          </div>
          <div className="queue-list">
            {state.queue.map((id, i) => {
              const p = state.products.find((p) => p.id === id);
              return p ? (
                <div key={id}>
                  <ProductImage name={p.name} image={p.image} />
                  <div>
                    <p>{p.name}</p>
                    <small>
                      {i < 5
                        ? "♧ Dinaikkan Berikutnya"
                        : `♧ Antrean ke ${i + 1}`}
                    </small>
                  </div>
                  <button
                    aria-label={`Hapus ${p.name} dari antrean`}
                    onClick={() =>
                      update((s) => ({
                        ...s,
                        queue: s.queue.filter((x) => x !== id),
                      }))
                    }
                  >
                    ♲
                  </button>
                </div>
              ) : null;
            })}
            {!state.queue.length && (
              <p className="table-empty">Antrean kosong. Tambahkan produk.</p>
            )}
          </div>
        </div>
      ) : (
        <>
          <Search
            value={query}
            onChange={setQuery}
            placeholder="Cari Nama Toko Anda"
          />
          <div className="boost-stores">
            {stores
              .filter((s) => s.toLowerCase().includes(query.toLowerCase()))
              .map((shop) => {
                const i = stores.indexOf(shop);
                return (
                  <section className="boost-card" key={shop}>
                    <div className="section-heading">
                      <h2>
                        <span className="shopee">S</span>
                        {shop}
                      </h2>
                      <Switch
                        checked={state.boost[i]!}
                        label={`Naikan otomatis ${shop}`}
                        onChange={() =>
                          update((s) => ({
                            ...s,
                            boost: s.boost.map((b, j) => (j === i ? !b : b)),
                          }))
                        }
                      />
                    </div>
                    <div className="boost-product-grid">
                      {cards.map((image, j) => (
                        <div key={image}>
                          <ProductImage
                            name={`Produk ${shop} ${j + 1}`}
                            image={
                              i === 1 && j < 2 ? ["frozen", "bakso"][j] : image
                            }
                          />
                          <span>
                            {state.boost[i] ? "00:43:23" : "Nonaktif"}
                          </span>
                        </div>
                      ))}
                    </div>
                    <Link
                      className="outline boost-link"
                      href={`/panel/product/boost/${i === 0 ? "a2hshop" : "jago"}/setting`}
                    >
                      ♧ ATUR NAIKAN ({state.queue.length} ANTREAN)
                    </Link>
                  </section>
                );
              })}
          </div>
          {!stores.some((s) =>
            s.toLowerCase().includes(query.toLowerCase()),
          ) && <p className="table-empty">Toko tidak ditemukan.</p>}
          <p className="local-note">
            Naikan produk merupakan simulasi lokal, tanpa jadwal atau koneksi
            marketplace aktif.
          </p>
        </>
      )}
      {message && <p role="status">{message}</p>}
      {pick && (
        <Modal title="Tambah Antrean" close={() => setPick(false)}>
          <div className="pick-list">
            {state.products
              .filter((p) => !state.queue.includes(p.id))
              .map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    update((s) => ({ ...s, queue: [...s.queue, p.id] }));
                    setMessage("Produk ditambahkan ke antrean lokal.");
                    setPick(false);
                  }}
                >
                  <ProductImage name={p.name} image={p.image} />
                  {p.name}
                  <span>+</span>
                </button>
              ))}
            {state.products.every((p) => state.queue.includes(p.id)) && (
              <p>Semua produk sudah masuk antrean.</p>
            )}
          </div>
        </Modal>
      )}
    </main>
  );
}
