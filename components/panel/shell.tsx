"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Icon } from "./icon";
import { Modal } from "./ui";
import CommerceShell from "./commerce-shell";
import { onlineEnabled } from '../../lib/online-dashboard';
import { useOnlineAccount } from './online-provider';

export const navigation = [
  { title: "Produk", items: [["Produk Saya", "mp/shopee", "box"]] },
  ...(onlineEnabled ? [{ title: "Pengiriman", items: [["Pesanan Shopee", "orders", "order"], ["Jasa Kirim", "logistics", "box"]] }] : []),
  {
    title: "Master Produk",
    items: [
      ["Master Produk", "master", "box"],
      ["Daftar Stok", "stock", "order"],
      ["Pengaturan Stok", "master/stock/setting", "grid"],
      ["Riwayat Stok", "stock/log", "chart"],
    ],
  },
  {
    title: "Tools",
    items: [
      ["Scrape", "scrape", "link"],
      ["Clone Toko", "clone", "shop"],
      ["Naikan Produk", "boost", "chart"],
      ["Atur Frame", "frame/shopee", "image"],
    ],
  },
];
export default function Shell({ children }: { children: ReactNode }) {
  return onlineEnabled ? <CommerceShell>{children}</CommerceShell> : <LegacyShell>{children}</LegacyShell>;
}
function LegacyShell({ children }: { children: ReactNode }) {
  const account = useOnlineAccount();
  const pathname = usePathname();
  const home = pathname === "/" || pathname === "/panel/home";
  const [banner, setBanner] = useState(true);
  const [menu, setMenu] = useState(false);
  const [info, setInfo] = useState("");
  const editor = pathname.includes("/frame/shopee/add");
  return (
    <div className={home ? "app-home" : "app-products"}>
      {banner && (
        <aside className="announcement">
          <span>
            🔔 Notif chat sering nggak masuk? Update KomplaceChat App ke versi
            terbaru untuk push notifikasi yang lebih reliable!
          </span>
          <button onClick={() => setInfo("Komplace Chat Mobile")}>
            KLIK DISINI
          </button>
          <button
            className="dismiss"
            aria-label="Tutup pengumuman"
            onClick={() => setBanner(false)}
          >
            ×
          </button>
        </aside>
      )}
      <header className="header">
        <div className="brand-group">
          <button
            className="menu-button"
            aria-label="Buka menu produk"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Icon name="grid" size={19} />
          </button>
          <Link href="/panel/home" className="brand">
            <span className="brand-mark">
              <Icon name="rocket" size={25} />
            </span>
            <span>
              komplace<small>by Komerce</small>
            </span>
          </Link>
        </div>
        <nav className="top-nav" aria-label="Navigasi utama">
          <Link className={home ? "selected" : ""} href="/panel/home">
            Home
          </Link>
          <Link
            className={!home ? "selected" : ""}
            href="/panel/product/mp/shopee"
          >
            Produk
          </Link>
          {onlineEnabled && <Link href="/panel/product/orders">Pengiriman</Link>}
          {["Chat", ...(onlineEnabled ? [] : ["Order"]), "Kolkit", "Affiliate", "Pusat Bantuan"].map(
            (n) => (
              <button key={n} onClick={() => setInfo(n)}>
                {n}
                {n === "Kolkit" && <span className="new-tag">NEW</span>}
              </button>
            ),
          )}
        </nav>
        <div className="header-actions">
          <button
            className="notification"
            aria-label="Notifikasi"
            onClick={() => setInfo("Notifikasi")}
          >
            <Icon name="bell" />
            <b>5</b>
          </button>
          <button className="account" onClick={() => onlineEnabled ? account.logout() : setInfo("Profil akun")}>
            <span className="avatar">M</span>
            <span>{onlineEnabled ? 'Keluar' : 'miftah'}</span>
          </button>
        </div>
      </header>
      <div className={`workspace ${home || editor ? "no-sidebar" : ""}`}>
        {((!home && !editor) || menu) && (
          <>
            <button
              aria-label="Tutup menu"
              className={`sidebar-overlay ${menu ? "visible" : ""}`}
              onClick={() => setMenu(false)}
            />
            <aside className={`product-sidebar ${menu ? "is-open" : ""}`}>
              <Link
                className="sidebar-home"
                href="/panel/home"
                onClick={() => setMenu(false)}
              >
                ← Home
              </Link>
              {navigation.map((group) => (
                <section key={group.title}>
                  <h2>
                    {group.title}
                    <span>⌄</span>
                  </h2>
                  {group.items.map(([label, url, icon]) => (
                    <Link
                      key={url}
                      href={`/panel/product/${url}`}
                      onClick={() => setMenu(false)}
                      className={
                        pathname === `/panel/product/${url}` ||
                        (url === "boost" && pathname.includes("boost/"))
                          ? "selected"
                          : ""
                      }
                      aria-current={
                        pathname === `/panel/product/${url}`
                          ? "page"
                          : undefined
                      }
                    >
                      <Icon name={icon!} size={17} />
                      {label}
                      {label === "Clone Toko" && (
                        <span className="new-tag">New</span>
                      )}
                    </Link>
                  ))}
                </section>
              ))}
              <small className="sidebar-note">{onlineEnabled ? 'Produk & pengiriman: Shopee live. Tools lain: lokal.' : 'Mode demo · data lokal'}</small>
            </aside>
          </>
        )}
        <div className="workspace-content">{children}</div>
      </div>
      <button
        className="floating-chat"
        aria-label="Buka bantuan"
        onClick={() => setInfo("Bantuan")}
      >
        <Icon name="chat" size={25} />
      </button>
      <nav className="bottom-nav" aria-label="Navigasi mobile">
        <Link className={home ? "active" : ""} href="/panel/home">
          <Icon name="grid" />
          <span>Home</span>
        </Link>
        <Link className={!home ? "active" : ""} href="/panel/product/mp/shopee">
          <Icon name="box" />
          <span>Produk</span>
        </Link>
        {["Chat", "Order", "Kolkit"].map((x, i) => (
          <button key={x} onClick={() => setInfo(x)}>
            <Icon name={["chat", "order", "kolkit"][i]!} />
            <span>{x}</span>
          </button>
        ))}
      </nav>
      {info && (
        <Modal title={info} close={() => setInfo("")}>
          <p>
            Halaman ini belum diperlihatkan dalam rekaman. Fitur layanan belum
            terhubung ke akun atau marketplace asli.
          </p>
          <button className="primary" onClick={() => setInfo("")}>
            Mengerti
          </button>
        </Modal>
      )}
    </div>
  );
}
