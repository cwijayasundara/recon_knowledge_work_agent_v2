import type { Flow, GridRow, Impact, Snapshot, TypedChange } from "./types";

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TOKEN = process.env.NEXT_PUBLIC_API_TOKEN ?? "";

export function actor(): string {
  if (typeof window === "undefined") return "analyst";
  return window.localStorage.getItem("onb.actor") || "analyst";
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "X-Actor": actor(), ...extra };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers(), ...(init.headers as Record<string, string>) } });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {}
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return (await res.json()) as T;
}

export const api = {
  flow: (entity: string) => call<Flow>(`/flows/${entity}`),
  sponsors: () => call<{ id: string; name: string }[]>("/sponsors"),
  runs: (sponsor?: string) => call<{ id: string; sponsor_id: string; status: string; upload_name: string; created_at: string }[]>(`/runs${sponsor ? `?sponsor_id=${sponsor}` : ""}`),
  run: (id: string) => call<Snapshot>(`/runs/${id}`),
  grid: (id: string) => call<{ total: number; rows: GridRow[]; item_id_limit: number }>(`/runs/${id}/grid?view=preview&limit=500`),
  source: (id: string) => call<{ sheet: string; header_row: number; total: number; rows: { row: number; cells: string[] }[] }>(`/runs/${id}/grid?view=source&limit=40`),
  start: (sponsor: string, file: File) => {
    const form = new FormData();
    form.append("sponsor_id", sponsor);
    form.append("entity", "affiliate");
    form.append("file", file);
    return call<{ run_id: string }>("/runs", { method: "POST", body: form });
  },
  gate: (id: string, body: Record<string, unknown>) =>
    call<{ accepted: boolean }>(`/runs/${id}/gate`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  dryRun: (id: string, changes: TypedChange[]) =>
    call<Impact>(`/runs/${id}/dry-run`, { method: "POST", body: JSON.stringify({ changes }), headers: { "Content-Type": "application/json" } }),
  artifactUrl: (id: string, name: string) => `${API}/runs/${id}/artifacts/${name}${TOKEN ? `?access_token=${TOKEN}` : ""}`,
  eventsUrl: (id: string) => `${API}/runs/${id}/events?actor=${encodeURIComponent(actor())}${TOKEN ? `&access_token=${TOKEN}` : ""}`,
};
