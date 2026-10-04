export function assertProdAuth(mode: string, auth: string): void {
  if (mode === "production" && auth !== "entra") throw new Error("Production builds must set VITE_AUTH=entra; dev auth is not allowed.");
}

/** Production bundles must name the API explicitly: an empty base would call the static host's own origin. */
export function assertProdConfig(mode: string, env: { VITE_AUTH?: string; VITE_API_BASE?: string }): void {
  assertProdAuth(mode, env.VITE_AUTH ?? "dev");
  if (mode === "production" && !/^https:\/\/[^/\s]+\/?$/.test(env.VITE_API_BASE ?? "")) {
    throw new Error("Production builds must set VITE_API_BASE to the API's https origin (for example https://api.example.com).");
  }
}
