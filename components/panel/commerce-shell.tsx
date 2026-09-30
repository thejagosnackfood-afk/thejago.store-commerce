'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Icon } from './icon';
import { useOnlineAccount } from './online-provider';
const groups = [
  { title: 'RUANG KERJA', items: [['Ringkasan', '/panel/home', 'grid']] },
  { title: 'OPERASIONAL SHOPEE', items: [['Produk online', '/panel/product/mp/shopee', 'box'], ['Pesanan', '/panel/product/orders', 'order'], ['Pengiriman & resi', '/panel/product/shipping', 'bag'], ['Jasa kirim', '/panel/product/logistics', 'shop']] },
  { title: 'INVENTORI', items: [['Master produk', '/panel/product/master', 'box'], ['Pantauan stok', '/panel/inventory', 'chart']] },
  { title: 'PENGATURAN', items: [['Integrasi toko', '/panel/settings', 'link']] },
];
export default function CommerceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname().replace(/\/$/, '') || '/'; const account = useOnlineAccount(); const [menu, setMenu] = useState(false);
  const current = groups.flatMap(g => g.items).find(([, path]) => path === pathname)?.[0] || 'Ringkasan';
  return <div className="commerce-app">
    <aside className={`commerce-sidebar ${menu ? 'open' : ''}`}>
      <Link href="/panel/home" className="commerce-brand" onClick={() => setMenu(false)}><span className="commerce-logo">J</span><span>JAGO<span className="commerce-brand-light"> Seller</span><small>WORKSPACE</small></span></Link>
      <div className="commerce-store"><span className="shopee-mark">S</span><div><strong>Toko Shopee</strong><small>ID 59604858</small></div><span className="commerce-dot" /></div>
      <nav aria-label="Navigasi dashboard">{groups.map(g => <section key={g.title}><h2>{g.title}</h2>{g.items.map(([label, href, icon]) => <Link key={href} href={href!} onClick={() => setMenu(false)} className={(pathname === href || (pathname === '/' && href === '/panel/home')) ? 'active' : ''} aria-current={pathname === href ? 'page' : undefined}><Icon name={icon!} size={19}/><span>{label}</span><span className="commerce-nav-arrow">›</span></Link>)}</section>)}</nav>
      <div className="commerce-sidebar-foot"><Icon name="shop" size={18}/><div><strong>Satu toko. Satu tempat.</strong><small>Produk, pesanan, dan pengiriman</small></div></div>
    </aside>
    {menu && <button className="commerce-scrim" aria-label="Tutup navigasi" onClick={() => setMenu(false)}/>}
    <div className="commerce-workspace"><header className="commerce-header"><div className="commerce-breadcrumb"><button className="commerce-menu" onClick={() => setMenu(!menu)} aria-label="Buka navigasi" aria-expanded={menu}><Icon name="grid"/></button><span>Workspace</span><span>/</span><strong>{current}</strong></div><div className="commerce-header-right"><span className="commerce-channel">Shopee Indonesia</span><span className="commerce-avatar">J</span><div className="commerce-user"><strong>Pemilik toko</strong><small>{account.user?.email}</small></div><button onClick={account.logout} className="commerce-logout">Keluar</button></div></header>
      <main className="commerce-main" id="main-content">{children}</main><footer className="commerce-footer">JAGO Seller <span>Operasional toko Shopee · waktu tampilan mengikuti perangkat Anda</span></footer>
    </div>
  </div>;
}
