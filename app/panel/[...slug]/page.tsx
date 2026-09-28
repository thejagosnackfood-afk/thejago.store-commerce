import { Suspense } from "react";
import { notFound } from "next/navigation";
import Home from "../../../components/panel/home";
import Products from "../../../components/panel/products";
import {
  StockSettings,
  StockHistory,
} from "../../../components/panel/stock-pages";
import {
  Scrape,
  CloneStore,
  Boost,
} from "../../../components/panel/tools-pages";
import Frames from "../../../components/panel/frames";

const routes = [
  "home",
  "product/mp/shopee",
  "product/master",
  "product/stock",
  "product/master/stock/setting",
  "product/stock/log",
  "product/scrape",
  "product/clone",
  "product/boost",
  "product/boost/a2hshop/setting",
  "product/boost/jago/setting",
  "product/frame/shopee",
  "product/frame/shopee/add",
];
export function generateStaticParams() {
  return routes.map((path) => ({ slug: path.split("/") }));
}
export default async function PanelPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const path = slug.join("/");
  if (path === "home") return <Home />;
  if (path === "product/mp/shopee") return <Products mode="products" />;
  if (path === "product/master") return <Products mode="master" />;
  if (path === "product/stock") return <Products mode="stock" />;
  if (path === "product/master/stock/setting") return <StockSettings />;
  if (path === "product/stock/log") return <StockHistory />;
  if (path === "product/scrape") return <Scrape />;
  if (path === "product/clone") return <CloneStore />;
  if (path === "product/boost") return <Boost />;
  if (/^product\/boost\/(a2hshop|jago)\/setting$/.test(path))
    return <Boost detail storeId={slug[2]} />;
  if (path === "product/frame/shopee" || path === "product/frame/shopee/add")
    return (
      <Suspense fallback={<p>Memuat frame…</p>}>
        <Frames editor={path.endsWith("/add")} />
      </Suspense>
    );
  notFound();
}
