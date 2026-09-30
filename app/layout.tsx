import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./panel.css";
import "./commerce.css";
import { PanelProvider } from "../components/panel/store";
import Shell from "../components/panel/shell";
import OnlineProvider from "../components/panel/online-provider";

export const metadata: Metadata = {
  title: "JAGO Seller — Dashboard Shopee",
  description: "Dashboard pengelolaan toko dan statistik marketplace.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>
        <OnlineProvider><PanelProvider>
          <Shell>{children}</Shell>
        </PanelProvider></OnlineProvider>
      </body>
    </html>
  );
}
