export interface Config {
  apiBase: string;
  auth: "dev" | "entra";
  devActor: string;
  maxUploadBytes: number;
}

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function parseMaxBytes(raw: unknown): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UPLOAD_BYTES;
}

const env = import.meta.env;

export const config: Config = {
  // The localhost default exists only in dev builds; production builds must set VITE_API_BASE (empty otherwise, so no localhost URL ships).
  apiBase: (env.VITE_API_BASE as string | undefined) ?? (env.DEV ? "http://localhost:8000" : ""),
  auth: env.VITE_AUTH === "entra" ? "entra" : "dev",
  devActor: (env.VITE_DEV_ACTOR as string | undefined) ?? "analyst",
  maxUploadBytes: parseMaxBytes(env.VITE_MAX_UPLOAD_BYTES),
};

export const SUPPORTED_API_MAJOR = 0;
