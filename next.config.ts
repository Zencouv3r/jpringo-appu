import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tauri's webview loads the app from disk (or a plain dev server), not a
  // Next.js server — static export produces the `out/` directory it needs.
  output: "export",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
