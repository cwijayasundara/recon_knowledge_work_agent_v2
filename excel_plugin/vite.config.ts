import { defineConfig, loadEnv } from "vite";
import preact from "@preact/preset-vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { assertProdConfig } from "./buildcheck/guard";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  assertProdConfig(mode, env);
  return { plugins: [preact(), basicSsl()], build: { target: "es2022", sourcemap: false } };
});
