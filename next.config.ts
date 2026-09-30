import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.FIREBASE_DASHBOARD_EXPORT === "true"
    ? { output: "export" as const, trailingSlash: true, images: { unoptimized: true } }
    : {}),
  async rewrites() {
    return process.env.NODE_ENV === "development" ? [
      { source: "/shopee", destination: "http://127.0.0.1:3087/shopee" },
      { source: "/shopee/:path*", destination: "http://127.0.0.1:3087/shopee/:path*" },
    ] : [];
  },
};

export default nextConfig;
