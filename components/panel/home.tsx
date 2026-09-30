"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icon";
import { onlineEnabled } from "../../lib/online-dashboard";
import CommerceOverview from "./commerce-overview";

const totals = [
  ["Nilai Total Pesanan", "Rp 8.312.155"],
  ["Nilai Total Pesanan Bersih", "Rp 2.365.657"],
  ["Nilai Total Pesanan Selesai", "Rp 1.982.417"],
  ["Nilai Total Pesanan Dibatalkan", "Rp 2.834.552"],
];
const counts = [
  ["166", "Jumlah Pesanan", "bag", "orange"],
  ["15", "Pesanan Siap Dikirim", "box", "amber"],
  ["8", "Pesanan Dikirim", "order", "teal"],
  ["30", "Pesanan Dibatalkan", "order", "pink"],
];
const shortcuts = [
  ["Produk Saya", "box"],
  ["Naikan Produk", "chart"],
  ["Scrape", "link"],
  ["Frame", "image"],
  ["Chat", "chat"],
  ["Order", "order"],
  ["Riset", "kolkit"],
  ["Billing", "order"],
  ["Clone Toko", "shop"],
  ["Kelola Admin", "users"],
];

export default function Home() {
  return onlineEnabled ? <CommerceOverview /> : <DemoHome />;
}
function DemoHome() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [marketplace, setMarketplace] = useState("Semua Marketplace");
  const [dialog, setDialog] = useState("");
  const [shop, setShop] = useState("A2HShop");
  const [draft, setDraft] = useState("");
  const [start, setStart] = useState("2026-09-10");
  const [end, setEnd] = useState("2026-09-24");
  const visible =
    shop.toLowerCase().includes(query.toLowerCase()) &&
    ["Semua Marketplace", "Shopee"].includes(marketplace);

  function open(title: string) {
    const routes: Record<string, string> = {
      "Produk Saya": "mp/shopee",
      Produk: "mp/shopee",
      "Naikan Produk": "boost",
      Scrape: "scrape",
      Frame: "frame/shopee",
      "Clone Toko": "clone",
    };
    if (routes[title]) {
      router.push(`/panel/product/${routes[title]}`);
      return;
    }
    setDialog(title);
    setDraft(shop);
  }

  return (
    <>
      <main className="dashboard">
        <section className="statistics" aria-labelledby="statistics-title">
          <h1 id="statistics-title">Statistik</h1>
          <div className="filters">
            <button
              className="date-filter"
              onClick={() => open("Periode statistik")}
            >
              <Icon name="calendar" size={15} />
              <span>
                {new Date(start + "T00:00:00").toLocaleDateString("id-ID", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}{" "}
                -{" "}
                {new Date(end + "T00:00:00").toLocaleDateString("id-ID", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}
              </span>
            </button>
            <select
              aria-label="Marketplace"
              value={marketplace}
              onChange={(event) => setMarketplace(event.target.value)}
            >
              {["Semua Marketplace", "Shopee", "Lazada", "Tiktok", "Toco"].map(
                (name) => (
                  <option key={name}>{name}</option>
                ),
              )}
            </select>
          </div>
          <div className="stats-grid">
            {totals.map(([label, value]) => (
              <article className="stat" key={label}>
                <p>{label}</p>
                <strong>{value}</strong>
              </article>
            ))}
            {counts.map(([value, label, icon, color]) => (
              <article className="stat count" key={label}>
                <div>
                  <strong>{value}</strong>
                  <p>{label}</p>
                </div>
                <span className={`stat-icon ${color}`}>
                  <Icon name={icon!} size={16} />
                </span>
              </article>
            ))}
          </div>
        </section>
        <section className="panel integrations">
          <div className="section-heading">
            <h2>Integrasi Akun</h2>
            <button className="outline" onClick={() => open("Integrasi Baru")}>
              + INTEGRASI BARU
            </button>
          </div>
          <label className="search">
            <Icon name="search" size={17} />
            <input
              placeholder="Cari Toko"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="shop-list">
            <div className="account-table-head">
              <span>Nama Toko</span>
              <span>Negara</span>
              <span>Status</span>
              <span>Waktu Otorisasi</span>
            </div>
            {visible ? (
              <div className="shop-row">
                <span className="shopee">
                  S<span />
                </span>
                <span>{shop}</span>
                <button
                  className="icon-button"
                  aria-label="Edit nama toko"
                  onClick={() => open("Edit nama toko")}
                >
                  <Icon name="edit" size={15} />
                </button>
                <span className="account-country">ID</span>
                <span className="account-status">● Toko Terhubung</span>
                <span className="account-time">22-09-2026 23:37</span>
                <button
                  className="info"
                  aria-label="Informasi toko"
                  onClick={() => open("Informasi toko")}
                >
                  ⓘ
                </button>
              </div>
            ) : null}
            {["Semua Marketplace", "Shopee"].includes(marketplace) &&
              "the jago snack & frozen food".includes(query.toLowerCase()) && (
                <div className="shop-row second-shop">
                  <span className="shopee">
                    S<span />
                  </span>
                  <span>the jago snack & frozen food</span>
                  <span className="account-country">ID</span>
                  <span className="account-status">● Toko Terhubung</span>
                  <span className="account-time">17-09-2026 11:44</span>
                  <button
                    className="info"
                    aria-label="Informasi toko Jago"
                    onClick={() => open("Integrasi Akun")}
                  >
                    ⓘ
                  </button>
                </div>
              )}
            {!visible &&
              (!"the jago snack & frozen food".includes(query.toLowerCase()) ||
                !["Semua Marketplace", "Shopee"].includes(marketplace)) && (
                <p className="empty">Tidak ada toko yang cocok.</p>
              )}
          </div>
          <div className="pagination">
            <select aria-label="Jumlah toko per halaman">
              <option>10 / Halaman</option>
              <option>25 / Halaman</option>
              <option>50 / Halaman</option>
            </select>
            <div>
              <button disabled aria-label="Halaman sebelumnya">
                ‹
              </button>
              <span className="current-page">1</span>
              <button disabled aria-label="Halaman berikutnya">
                ›
              </button>
            </div>
          </div>
        </section>
        <section className="promotions" aria-label="Aplikasi Komplace">
          {[
            "Komplace App Mobile",
            "Komplace Chat Mobile",
            "KOL Execution Platform",
          ].map((title, index) => (
            <button className="promo" key={title} onClick={() => open(title)}>
              {index < 2 ? (
                <span className="play-badge">
                  <span className="play-triangle">▶</span>
                  <span>
                    <small>GET IT ON</small>Google Play
                  </span>
                </span>
              ) : (
                <span className="kolkit-badge">
                  ◎ KOLKIT<small>by Komerce</small>
                </span>
              )}
              {index === 2 && <span className="new-tag promo-new">New</span>}
              <h2>{title}</h2>
              <p>
                {index < 2
                  ? "Kelola Toko lebih mudah kapanpun dan dimanapun"
                  : "Temukan ribuan KOL & Affiliate siap bantu promosikan produkmu di Shopee & TikTok lewat Kolkit!"}
              </p>
            </button>
          ))}
        </section>
        <section className="panel shortcuts">
          <h2>Pintasan</h2>
          <div className="shortcut-grid">
            {shortcuts.map(([title, icon], index) => (
              <button key={title} onClick={() => open(title!)}>
                <span className="shortcut-icon">
                  <Icon name={icon!} size={25} />
                  {index > 7 && <span className="new-tag">New</span>}
                </span>
                <span>{title}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="panel membership">
          <p>Level Membership</p>
          <div className="section-heading">
            <h2>Medium</h2>
            <button
              className="primary"
              onClick={() => open("Upgrade Membership")}
            >
              UPGRADE
            </button>
          </div>
          <p className="expiry">Aktif sampai 24/10/2026</p>
          <div className="membership-details">
            <h3>Detail Membership</h3>
            <details open>
              <summary>Integrasi Marketplace</summary>
              <div className="quota">
                <span>🟠 Shopee</span>
                <span>2/50</span>
              </div>
              <div className="quota">
                <span>🟣 Lazada</span>
                <span>0/50</span>
              </div>
              <div className="quota">
                <span>⚫ Tiktok</span>
                <span>0/50</span>
              </div>
              <div className="quota">
                <span>🟡 Toco</span>
                <span>0/50</span>
              </div>
            </details>
            <details open>
              <summary>Frame</summary>
              <div className="quota">
                <span>🟠 Shopee</span>
                <span>Unlimited</span>
              </div>
            </details>
            {[
              ["Naikan Produk", "Unlimited"],
              ["Chat", "0/15"],
              ["Master Sku", "1677/50000"],
              ["Admin", "0/5"],
              ["Order", "166/5000"],
            ].map(([label, value]) => (
              <div className="quota feature" key={label}>
                <span>{label}</span>
                <span>{value}</span>
              </div>
            ))}
          </div>
        </section>
        <p className="demo-note">
          Pratinjau tampilan · Data contoh, belum terhubung ke marketplace.
        </p>
      </main>
      {dialog && (
        <div className="modal-backdrop" onClick={() => setDialog("")}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDialog("");
              if (event.key === "Tab") {
                const controls =
                  event.currentTarget.querySelectorAll<HTMLElement>(
                    "button, input, select, a[href]",
                  );
                const first = controls[0];
                const last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <div className="section-heading">
              <h2 id="dialog-title">{dialog}</h2>
              <button
                autoFocus
                className="icon-button"
                aria-label="Tutup dialog"
                onClick={() => setDialog("")}
              >
                ×
              </button>
            </div>
            {dialog === "Edit nama toko" ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (draft.trim()) {
                    setShop(draft.trim());
                    setDialog("");
                  }
                }}
              >
                <label>
                  Nama toko
                  <input
                    value={draft}
                    required
                    onChange={(event) => setDraft(event.target.value)}
                  />
                </label>
                <button className="primary">Simpan</button>
              </form>
            ) : dialog === "Periode statistik" ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setDialog("");
                }}
              >
                <label>
                  Tanggal mulai
                  <input
                    type="date"
                    required
                    value={start}
                    max={end}
                    onChange={(event) => setStart(event.target.value)}
                  />
                </label>
                <label>
                  Tanggal akhir
                  <input
                    type="date"
                    required
                    value={end}
                    min={start}
                    onChange={(event) => setEnd(event.target.value)}
                  />
                </label>
                <p>Angka statistik tetap menggunakan data contoh.</p>
                <button className="primary">Terapkan</button>
              </form>
            ) : (
              <>
                <p>
                  {dialog === "Informasi toko"
                    ? `${shop} · Shopee. Informasi ini merupakan data contoh.`
                    : "Ini adalah pratinjau halaman utama. Fitur ini belum terhubung ke layanan Komplace atau marketplace."}
                </p>
                <button className="primary" onClick={() => setDialog("")}>
                  Mengerti
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
