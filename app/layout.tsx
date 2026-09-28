import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./panel.css";
import { PanelProvider } from "../components/panel/store";
import Shell from "../components/panel/shell";

export const metadata: Metadata = {
  title: "Komplace — Dashboard",
  description: "Dashboard pengelolaan toko dan statistik marketplace.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>
        <PanelProvider>
          <Shell>{children}</Shell>
        </PanelProvider>
      </body>
    </html>
  );
}
