import type { NextConfig } from "next";

// On Azure the browser talks only to the web origin (behind Entra sign-in); /api/* is
// proxied to the API's internal address, which carries the signed-in principal header.
const apiInternal = process.env.API_INTERNAL_URL;

const config: NextConfig = {
  output: "standalone",
  // The e2e run builds into its own directory so it can start while `pnpm dev` is running.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  async rewrites() {
    return apiInternal ? [{ source: "/api/:path*", destination: `${apiInternal}/:path*` }] : [];
  },
};

export default config;
