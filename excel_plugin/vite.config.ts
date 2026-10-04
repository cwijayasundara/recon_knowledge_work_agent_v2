import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import preact from "@preact/preset-vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { assertProdConfig } from "./buildcheck/guard";

// Dev only: certificates from `npx office-addin-dev-certs install` are trusted by Office's web view;
// Vite's self-signed one is not, so the pane would not load in desktop Excel.
function devCerts(): { key: Buffer; cert: Buffer } | null {
  const dir = path.join(os.homedir(), ".office-addin-dev-certs");
  const key = path.join(dir, "localhost.key");
  const cert = path.join(dir, "localhost.crt");
  return fs.existsSync(key) && fs.existsSync(cert) ? { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } : null;
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  assertProdConfig(mode, env);
  const certs = command === "serve" ? devCerts() : null;
  return {
    plugins: certs ? [preact()] : [preact(), basicSsl()],
    build: { target: "es2022", sourcemap: false },
    server: {
      https: certs ?? undefined,
      // Same-origin API access for the https pane (no mixed content, no CORS): VITE_API_BASE=https://localhost:3100/api
      proxy: { "/api": { target: process.env.DEV_API_TARGET ?? "http://localhost:8000", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") } },
    },
  };
});
