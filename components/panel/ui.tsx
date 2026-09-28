"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icon";

export function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      className={`panel-dialog ${wide ? "wide" : ""}`}
      ref={ref}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="section-heading">
        <h2>{title}</h2>
        <button aria-label="Tutup" className="icon-button" onClick={close}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Search({
  value,
  onChange,
  placeholder = "Cari Nama Produk atau SKU",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="product-search">
      <Icon name="search" size={16} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button aria-label="Hapus pencarian" onClick={() => onChange("")}>
          ×
        </button>
      )}
    </label>
  );
}
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={onChange}
    >
      <span />
    </button>
  );
}
export function Pagination({
  page,
  setPage,
  total,
  size,
  setSize,
}: {
  page: number;
  setPage: (p: number) => void;
  total: number;
  size: number;
  setSize: (n: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="pagination">
      <div>
        <select
          aria-label="Jumlah per halaman"
          value={size}
          onChange={(e) => {
            setSize(Number(e.target.value));
            setPage(1);
          }}
        >
          {[10, 12, 25, 50].map((n) => (
            <option key={n} value={n}>
              {n} / Halaman
            </option>
          ))}
        </select>
        <small>{total.toLocaleString("id-ID")} data</small>
      </div>
      <div>
        <button
          aria-label="Halaman sebelumnya"
          disabled={page === 1}
          onClick={() => setPage(page - 1)}
        >
          ‹
        </button>
        {Array.from(
          { length: Math.min(5, pages) },
          (_, i) => Math.max(1, Math.min(page - 2, pages - 4)) + i,
        ).map((n) => (
          <button
            key={n}
            className={n === page ? "current-page" : ""}
            onClick={() => setPage(n)}
          >
            {n}
          </button>
        ))}
        <button
          aria-label="Halaman berikutnya"
          disabled={page === pages}
          onClick={() => setPage(page + 1)}
        >
          ›
        </button>
      </div>
    </div>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice">
      <span>ⓘ</span>
      <div>{children}</div>
    </div>
  );
}
export function ProductImage({
  name,
  image,
}: {
  name: string;
  image?: string;
}) {
  return image ? (
    <img className="product-photo" src={`/products/${image}.jpg`} alt={name} />
  ) : (
    <span className="product-placeholder" aria-label={name}>
      <Icon name="box" size={24} />
    </span>
  );
}
export const stores = ["A2HShop", "the jago snack & frozen food"];
export function StoreTabs({
  value,
  onChange,
}: {
  value: string;
  onChange: (s: string) => void;
}) {
  return (
    <>
      <div className="market-heading">
        <span className="shopee">S</span>
      </div>
      <div className="store-tabs">
        <span>Toko</span>
        {["Semua", ...stores].map((s) => (
          <button
            key={s}
            className={value === s ? "selected" : ""}
            onClick={() => onChange(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </>
  );
}
