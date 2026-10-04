import type { Auth } from "../auth/auth";
import type { CopilotStart, StepBody, StepOut } from "../copilot/types";
import type { GateBody, Impact, PreviewGrid, Snapshot, SourceGrid, TypedChange } from "./types";

export class ApiError extends Error {
  /** Seconds from a 503's Retry-After header, when present and numeric. */
  retryAfterSeconds?: number;
  constructor(message: string, readonly status: number, readonly requestId: string) {
    super(message);
  }
}

/**
 * The request was sent but no answer came within its bound (status 0). The server may still have received it: a
 * timed-out POST is ambiguous, unlike any other ApiError.
 */
export class RequestTimeout extends ApiError {
  constructor(seconds: number, requestId: string) {
    super(`Request timed out after ${seconds} s`, 0, requestId);
    this.name = "RequestTimeout";
  }
}

export const AUTH_TIMEOUT_MESSAGE = "Sign-in did not complete. Reopen the pane or retry.";
/** The access token did not arrive within AUTH_TIMEOUT_MS: nothing was sent. */
export class AuthTimeout extends Error {
  constructor() {
    super(AUTH_TIMEOUT_MESSAGE);
    this.name = "AuthTimeout";
  }
}

/** Default bound for a JSON request (response and body); a hung request must not hold the pane. */
export const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Bound for obtaining the access token, counted before (and apart from) the request bound: Office SSO may show
 * sign-in, consent or MFA, which can take minutes.
 */
export const AUTH_TIMEOUT_MS = 180_000;
/** Artifact downloads read a whole file. */
export const DOWNLOAD_TIMEOUT_MS = 120_000;
/** The workbook upload sends a whole file. */
export const UPLOAD_TIMEOUT_MS = 300_000;
/** A copilot step waits for a model call, which can take far longer than a plain request. */
export const COPILOT_STEP_TIMEOUT_MS = 120_000;

export type CopilotErrorKind = "disabled" | "session_lost" | "busy" | "too_many" | "conflict" | "too_large" | "bad_request" | "timeout" | "other";

/** How the copilot panel should treat a failed copilot call. */
export function copilotErrorKind(e: unknown): CopilotErrorKind {
  if (!(e instanceof ApiError)) return "other";
  switch (e.status) {
    case 0: return e instanceof RequestTimeout ? "timeout" : "other";
    case 403: return "disabled";
    case 404: return "session_lost";
    case 503: return "busy";
    case 429: return "too_many";
    case 409: return "conflict";
    case 413: return "too_large";
    case 415: case 422: return "bad_request";
    default: return "other";
  }
}

export interface ClientOptions {
  baseUrl: string;
  auth: Auth;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  authTimeoutMs?: number;
  downloadTimeoutMs?: number;
  uploadTimeoutMs?: number;
  copilotStepTimeoutMs?: number;
}

interface Deadline { signal: AbortSignal; dispose: () => void }

// Feature-detected per call: older Office webviews (e.g. Safari before 17.4) lack AbortSignal.any.
function deadline(ms: number): Deadline {
  if (typeof AbortSignal.timeout === "function") return { signal: AbortSignal.timeout(ms), dispose: () => {} };
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  return { signal: c.signal, dispose: () => clearTimeout(timer) };
}

export interface Combined { signal: AbortSignal; dispose: () => void }

/**
 * A signal that aborts when any of `signals` aborts, with that signal's reason. `dispose` (call it once the work has
 * settled) removes the fallback's listeners from the inputs, so a long-lived caller signal does not keep them.
 */
export function anySignal(signals: AbortSignal[]): Combined {
  if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any(signals), dispose: () => {} };
  const c = new AbortController();
  const first = signals.find((s) => s.aborted);
  if (first) { c.abort(first.reason); return { signal: c.signal, dispose: () => {} }; }
  const dispose = () => signals.forEach((s) => s.removeEventListener("abort", onAbort));
  function onAbort(e: Event) {
    dispose();
    c.abort((e.target as AbortSignal).reason);
  }
  signals.forEach((s) => s.addEventListener("abort", onAbort));
  return { signal: c.signal, dispose };
}

/** `limit` combined with an optional caller signal. */
function withCaller(caller: AbortSignal | null, limit: Deadline): Combined {
  if (!caller) return { signal: limit.signal, dispose: limit.dispose };
  const both = anySignal([caller, limit.signal]);
  return { signal: both.signal, dispose: () => { both.dispose(); limit.dispose(); } };
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

export function createClient({ baseUrl, auth, fetchImpl, requestTimeoutMs = REQUEST_TIMEOUT_MS, authTimeoutMs = AUTH_TIMEOUT_MS, downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS, uploadTimeoutMs = UPLOAD_TIMEOUT_MS, copilotStepTimeoutMs = COPILOT_STEP_TIMEOUT_MS }: ClientOptions) {
  const doFetch = fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  /** The auth headers, bounded by authTimeoutMs on their own: a sign-in prompt must not use up the request's bound. */
  async function authHeaders(caller: AbortSignal | null): Promise<Record<string, string>> {
    const limit = deadline(authTimeoutMs);
    const { signal, dispose } = withCaller(caller, limit);
    try {
      return await untilAborted(auth.headers(), signal);
    } catch (e) {
      if (limit.signal.aborted && !caller?.aborted) {
        auth.reset?.(); // the abandoned token request must not be shared with the next attempt
        throw new AuthTimeout();
      }
      throw e;
    } finally {
      dispose();
    }
  }

  /**
   * One request: the token first (see authHeaders), then a deadline of `timeoutMs` from the fetch through the body read
   * (`read`); null means only the caller's signal ends it (the event stream). A caller's abort propagates unchanged; the
   * deadline becomes a RequestTimeout.
   */
  async function call<T>(path: string, init: RequestInit, extra: Record<string, string>, timeoutMs: number | null, read: (res: Response) => Promise<T>): Promise<T> {
    const requestId = crypto.randomUUID();
    const caller = init.signal ?? null;
    const fromAuth = await authHeaders(caller);
    const limit = timeoutMs === null ? null : deadline(timeoutMs);
    const combined = limit ? withCaller(caller, limit) : null;
    const signal = combined ? combined.signal : caller;
    try {
      const headers = { ...fromAuth, "X-Request-Id": requestId, ...extra };
      const res = await doFetch(`${baseUrl}${path}`, { ...init, headers, ...(signal ? { signal } : {}) });
      if (!res.ok) {
        let detail: unknown = res.statusText || `HTTP ${res.status}`;
        try { detail = ((await res.json()) as { detail?: unknown }).detail ?? detail; } catch { /* non-JSON body */ }
        const err = new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail), res.status, requestId);
        const wait = res.status === 503 ? res.headers.get("Retry-After") : null;
        if (wait !== null && /^\d+$/.test(wait.trim())) err.retryAfterSeconds = Number(wait.trim());
        throw err;
      }
      return await read(res);
    } catch (e) {
      if (limit?.signal.aborted && !caller?.aborted) throw new RequestTimeout((timeoutMs ?? 0) / 1000, requestId);
      throw e;
    } finally {
      combined?.dispose();
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
    // `signal` is for callers that cancel a read (tests drive the combined caller-plus-deadline path through it).
    run: (id: string, signal?: AbortSignal) => json<Snapshot>(`/runs/${id}`, signal ? { signal } : {}),
    grid: (id: string) => json<PreviewGrid>(`/runs/${id}/grid?view=preview&limit=500`),
    source: (id: string) => json<SourceGrid>(`/runs/${id}/grid?view=source&limit=500`),
    gate: (id: string, body: GateBody) => post<{ accepted: boolean }>(`/runs/${id}/gate`, body),
    dryRun: (id: string, changes: TypedChange[]) => post<Impact>(`/runs/${id}/dry-run`, { changes }),
    copilotStart: (runId?: string) => post<CopilotStart>("/copilot/sessions", runId ? { run_id: runId } : {}),
    copilotStep: (sessionId: string, body: StepBody) =>
      json<StepOut>(`/copilot/sessions/${encodeURIComponent(sessionId)}/step`, { method: "POST", body: JSON.stringify(body) }, { "Content-Type": "application/json" }, copilotStepTimeoutMs),
    /** An unknown or expired session (404) is already closed. */
    async copilotClose(sessionId: string): Promise<void> {
      try {
        await call(`/copilot/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }, {}, requestTimeoutMs, async () => undefined);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
    },
    artifact: (id: string, name: string) =>
      call(`/runs/${id}/artifacts/${encodeURIComponent(name)}`, {}, {}, downloadTimeoutMs, (res) => res.blob()),
    // The stream stays open for the whole run: only the caller's signal ends it, never a deadline.
    openEvents: (id: string, lastEventId: string | null, signal: AbortSignal) =>
      call(`/runs/${id}/events`, { signal }, { Accept: "text/event-stream", ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) }, null, async (res) => res),
  };
}
export type Client = ReturnType<typeof createClient>;
