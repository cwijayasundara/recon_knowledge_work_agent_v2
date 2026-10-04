import type { Auth } from "../auth/auth";
import type { GateBody, Impact, PreviewGrid, Snapshot, SourceGrid, TypedChange } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly requestId: string) {
    super(message);
  }
}

/** Default bound for a JSON request (token, response and body); a hung request must not hold the pane. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Artifact downloads read a whole file. */
export const DOWNLOAD_TIMEOUT_MS = 120_000;
/** The workbook upload sends a whole file. */
export const UPLOAD_TIMEOUT_MS = 300_000;

export interface ClientOptions {
  baseUrl: string;
  auth: Auth;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
  uploadTimeoutMs?: number;
}

interface Deadline { signal: AbortSignal; dispose: () => void }

// Feature-detected per call: older Office webviews (e.g. Safari before 17.4) lack AbortSignal.any.
function deadline(ms: number): Deadline {
  if (typeof AbortSignal.timeout === "function") return { signal: AbortSignal.timeout(ms), dispose: () => {} };
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  return { signal: c.signal, dispose: () => clearTimeout(timer) };
}

/** Aborts when any of `signals` aborts, with that signal's reason. */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const c = new AbortController();
  const first = signals.find((s) => s.aborted);
  if (first) { c.abort(first.reason); return c.signal; }
  const onAbort = (e: Event) => {
    signals.forEach((s) => s.removeEventListener("abort", onAbort));
    c.abort((e.target as AbortSignal).reason);
  };
  signals.forEach((s) => s.addEventListener("abort", onAbort));
  return c.signal;
}

/** Settles like `p`, or rejects with the signal's reason once it aborts (auth.headers() takes no signal). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

export function createClient({ baseUrl, auth, fetchImpl, requestTimeoutMs = REQUEST_TIMEOUT_MS, downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS, uploadTimeoutMs = UPLOAD_TIMEOUT_MS }: ClientOptions) {
  const doFetch = fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  /**
   * One request, bounded by `timeoutMs` from the token through the body read (`read`); null means only the caller's
   * signal ends it (the event stream). A caller's abort propagates unchanged; the deadline becomes an ApiError.
   */
  async function call<T>(path: string, init: RequestInit, extra: Record<string, string>, timeoutMs: number | null, read: (res: Response) => Promise<T>): Promise<T> {
    const requestId = crypto.randomUUID();
    const caller = init.signal ?? null;
    const limit = timeoutMs === null ? null : deadline(timeoutMs);
    const signal = limit ? (caller ? anySignal([caller, limit.signal]) : limit.signal) : caller;
    try {
      const authHeaders = await (signal ? untilAborted(auth.headers(), signal) : auth.headers());
      const headers = { ...authHeaders, "X-Request-Id": requestId, ...extra };
      const res = await doFetch(`${baseUrl}${path}`, { ...init, headers, ...(signal ? { signal } : {}) });
      if (!res.ok) {
        let detail: unknown = res.statusText || `HTTP ${res.status}`;
        try { detail = ((await res.json()) as { detail?: unknown }).detail ?? detail; } catch { /* non-JSON body */ }
        throw new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail), res.status, requestId);
      }
      return await read(res);
    } catch (e) {
      if (limit?.signal.aborted && !caller?.aborted) throw new ApiError(`Request timed out after ${(timeoutMs ?? 0) / 1000} s`, 0, requestId);
      throw e;
    } finally {
      limit?.dispose();
    }
  }
  const json = <T>(path: string, init: RequestInit = {}, extra: Record<string, string> = {}, timeoutMs = requestTimeoutMs): Promise<T> =>
    call(path, init, extra, timeoutMs, async (res) => (await res.json()) as T);
  const post = <T>(path: string, body: unknown) =>
    json<T>(path, { method: "POST", body: JSON.stringify(body) }, { "Content-Type": "application/json" });

  return {
    health: () => json<{ status: string; version?: string }>("/health"),
    sponsors: () => json<{ id: string; name: string }[]>("/sponsors"),
    startRun(sponsorId: string, file: Blob, name: string) {
      const form = new FormData();
      form.append("sponsor_id", sponsorId);
      form.append("entity", "affiliate");
      form.append("file", file, name);
      return json<{ run_id: string }>("/runs", { method: "POST", body: form }, {}, uploadTimeoutMs); // no Content-Type: the browser sets the boundary
    },
    run: (id: string) => json<Snapshot>(`/runs/${id}`),
    grid: (id: string) => json<PreviewGrid>(`/runs/${id}/grid?view=preview&limit=500`),
    source: (id: string) => json<SourceGrid>(`/runs/${id}/grid?view=source&limit=500`),
    gate: (id: string, body: GateBody) => post<{ accepted: boolean }>(`/runs/${id}/gate`, body),
    dryRun: (id: string, changes: TypedChange[]) => post<Impact>(`/runs/${id}/dry-run`, { changes }),
    artifact: (id: string, name: string) =>
      call(`/runs/${id}/artifacts/${encodeURIComponent(name)}`, {}, {}, downloadTimeoutMs, (res) => res.blob()),
    // The stream stays open for the whole run: only the caller's signal ends it, never a deadline.
    openEvents: (id: string, lastEventId: string | null, signal: AbortSignal) =>
      call(`/runs/${id}/events`, { signal }, { Accept: "text/event-stream", ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) }, null, async (res) => res),
  };
}
export type Client = ReturnType<typeof createClient>;
