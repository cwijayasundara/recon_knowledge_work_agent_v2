import { describe, expect, test, vi } from "vitest";
import { entraAuth } from "../../src/auth/entra";
import { anySignal, ApiError, COPILOT_STEP_TIMEOUT_MS, copilotErrorKind, AUTH_TIMEOUT_MESSAGE, AUTH_TIMEOUT_MS, AuthTimeout, createClient, DOWNLOAD_TIMEOUT_MS, REQUEST_TIMEOUT_MS, RequestTimeout, UPLOAD_TIMEOUT_MS } from "../../src/api/client";

const auth = { label: "test", headers: async () => ({ "X-Actor": "analyst" }) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("client", () => {
  test("sends auth headers and a request id", async () => {
    const f = vi.fn(async () => json([{ id: "sponsor-a", name: "Sponsor A" }]));
    const c = createClient({ baseUrl: "http://api", auth, fetchImpl: f as unknown as typeof fetch });
    expect(await c.sponsors()).toEqual([{ id: "sponsor-a", name: "Sponsor A" }]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api/sponsors");
    const h = init.headers as Record<string, string>;
    expect(h["X-Actor"]).toBe("analyst");
    expect(h["X-Request-Id"]).toMatch(/^[0-9a-f-]{8,}$/);
    expect(url).not.toContain("access_token");
  });

  test("throws ApiError with the server detail verbatim and the request id", async () => {
    const f = vi.fn(async () => json({ detail: "the run is already working" }, 409));
    const c = createClient({ baseUrl: "http://api", auth, fetchImpl: f as unknown as typeof fetch });
    const err = await c.gate("r1", { action: "approve" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.message).toBe("the run is already working");
    expect(err.requestId).toBeTruthy();
  });

  test("startRun posts multipart with sponsor_id, entity and file", async () => {
    const f = vi.fn(async () => json({ run_id: "run-1" }, 202));
    const c = createClient({ baseUrl: "http://api", auth, fetchImpl: f as unknown as typeof fetch });
    await c.startRun("sponsor-a", new Blob(["x"]), "a.xlsx");
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const body = init.body as FormData;
    expect(body.get("sponsor_id")).toBe("sponsor-a");
    expect(body.get("entity")).toBe("affiliate");
    expect((body.get("file") as File).name).toBe("a.xlsx");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  test("422 detail arrays are stringified", async () => {
    const f = vi.fn(async () => json({ detail: [{ msg: "bad" }] }, 422));
    const c = createClient({ baseUrl: "http://api", auth, fetchImpl: f as unknown as typeof fetch });
    await expect(c.dryRun("r1", [])).rejects.toThrow('[{"msg":"bad"}]');
  });

  test("a hung request ends after the timeout as an ApiError naming the bound and the request id", async () => {
    const f = vi.fn((_url: string, init: RequestInit) => hangUntilAborted(init.signal));
    const c = createClient({ baseUrl: "http://api", auth, fetchImpl: f as unknown as typeof fetch, requestTimeoutMs: 20 });
    const err = await c.gate("r1", { action: "approve" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const api = err as ApiError;
    expect(api.message).toBe("Request timed out after 0.02 s");
    expect(api.status).toBe(0);
    expect(api).toBeInstanceOf(RequestTimeout);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(api.requestId).toBe((init.headers as Record<string, string>)["X-Request-Id"]);
  });

  test("the default bounds are 30 s for requests, longer for downloads and the upload", async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(DOWNLOAD_TIMEOUT_MS).toBe(120_000);
    expect(UPLOAD_TIMEOUT_MS).toBe(300_000);
    const f = vi.fn((_url: string, init: RequestInit) => hangUntilAborted(init.signal));
    const c = createClient({ baseUrl: "http://api", auth, fetchImpl: f as unknown as typeof fetch, requestTimeoutMs: 20, downloadTimeoutMs: 40, uploadTimeoutMs: 60 });
    await expect(c.artifact("r1", "a.csv")).rejects.toThrow("Request timed out after 0.04 s");
    await expect(c.startRun("sponsor-a", new Blob(["x"]), "a.xlsx")).rejects.toThrow("Request timed out after 0.06 s");
  });

  test("a body that never finishes is bounded; a token that never comes ends at the auth bound, not the request bound", async () => {
    const hungBody = vi.fn(async (_url: string, init: RequestInit) =>
      ({ ok: true, status: 200, json: () => hangUntilAborted(init.signal) }) as unknown as Response);
    const c1 = createClient({ baseUrl: "http://api", auth, fetchImpl: hungBody as unknown as typeof fetch, requestTimeoutMs: 20 });
    await expect(c1.run("r1")).rejects.toThrow("Request timed out after 0.02 s");
    const f = vi.fn(async () => json({}));
    const hungAuth = { label: "test", headers: () => new Promise<Record<string, string>>(() => {}) };
    const c2 = createClient({ baseUrl: "http://api", auth: hungAuth, fetchImpl: f as unknown as typeof fetch, requestTimeoutMs: 20, authTimeoutMs: 40 });
    const err = await c2.sponsors().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthTimeout);
    expect(err).not.toBeInstanceOf(ApiError); // nothing was sent, so it is never an ambiguous request timeout
    expect((err as Error).message).toBe(AUTH_TIMEOUT_MESSAGE);
    expect(AUTH_TIMEOUT_MESSAGE).toBe("Sign-in did not complete. Reopen the pane or retry.");
    expect(AUTH_TIMEOUT_MS).toBe(180_000);
    expect(f).not.toHaveBeenCalled();
  });

  test("a non-JSON error body falls back to the status text, or the HTTP status when there is none", async () => {
    const f = vi.fn(async () => new Response("<html>", { status: 502, statusText: "" }));
    const c = createClient({ baseUrl: "http://api", auth, fetchImpl: f as unknown as typeof fetch });
    await expect(c.run("r1")).rejects.toThrow("HTTP 502");
  });

  test("the event stream is never cut by a deadline, and the caller's abort propagates unchanged", async () => {
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((r) => setTimeout(r, 60)); // longer than the request bound
      if (init.signal?.aborted) throw init.signal.reason;
      return new Response("", { status: 200 });
    });
    const c = createClient({ baseUrl: "http://api", auth, fetchImpl: f as unknown as typeof fetch, requestTimeoutMs: 20 });
    const caller = new AbortController();
    const res = await c.openEvents("r1", "7", caller.signal);
    expect(res.status).toBe(200);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(caller.signal);
    expect((init.headers as Record<string, string>)["Last-Event-ID"]).toBe("7");
    const g = vi.fn((_url: string, i: RequestInit) => hangUntilAborted(i.signal));
    const c2 = createClient({ baseUrl: "http://api", auth, fetchImpl: g as unknown as typeof fetch, requestTimeoutMs: 20 });
    const stopped = new AbortController();
    const p = c2.openEvents("r1", null, stopped.signal).catch((e: unknown) => e);
    stopped.abort();
    const err = await p;
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as DOMException).name).toBe("AbortError");
  });
});

const fakeRun = { run_id: "r1" };

/** Settles only by rejecting with the signal's reason, like fetch does when its signal aborts. */
function hangUntilAborted<T>(signal: AbortSignal | null | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("auth and request deadlines (fake timers)", () => {
  // AbortSignal.timeout may run on a timer the fakes do not drive: force the setTimeout-based deadline.
  function fakeClock() {
    vi.useFakeTimers();
    const original = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true, writable: true });
    return () => {
      Object.defineProperty(AbortSignal, "timeout", { value: original, configurable: true, writable: true });
      vi.useRealTimers();
    };
  }

  test("a slow sign-in does not use up the request bound; the request bound starts once the token is in", async () => {
    const restore = fakeClock();
    try {
      const slowAuth = { label: "sso", headers: () => new Promise<Record<string, string>>((r) => setTimeout(() => r({ Authorization: "Bearer t" }), 25_000)) };
      const f = vi.fn((_url: string, init: RequestInit) => hangUntilAborted(init.signal));
      const c = createClient({ baseUrl: "http://api", auth: slowAuth, fetchImpl: f as unknown as typeof fetch, requestTimeoutMs: 30_000 });
      let settled: unknown = "pending";
      void c.sponsors().then((v) => { settled = v; }, (e: unknown) => { settled = e; });
      await vi.advanceTimersByTimeAsync(30_000); // 25 s of sign-in + 5 s of request: within both bounds
      expect(settled).toBe("pending");
      expect(f).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(24_999);
      expect(settled).toBe("pending");
      await vi.advanceTimersByTimeAsync(1); // 30 s after the fetch started
      expect(settled).toBeInstanceOf(RequestTimeout);
      expect((settled as Error).message).toBe("Request timed out after 30 s");
    } finally { restore(); }
  });

  test("a sign-in that takes minutes succeeds; one past AUTH_TIMEOUT_MS fails with the sign-in message", async () => {
    const restore = fakeClock();
    try {
      const f = vi.fn(async () => json([{ id: "sponsor-a", name: "Sponsor A" }]));
      const after = (ms: number) => ({ label: "sso", headers: () => new Promise<Record<string, string>>((r) => setTimeout(() => r({ Authorization: "Bearer t" }), ms)) });
      const ok = createClient({ baseUrl: "http://api", auth: after(170_000), fetchImpl: f as unknown as typeof fetch });
      const p = ok.sponsors();
      await vi.advanceTimersByTimeAsync(170_000);
      expect(await p).toEqual([{ id: "sponsor-a", name: "Sponsor A" }]);
      const late = createClient({ baseUrl: "http://api", auth: after(10 * 60_000), fetchImpl: f as unknown as typeof fetch });
      const q = late.sponsors().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS);
      const err = await q;
      expect(err).toBeInstanceOf(AuthTimeout);
      expect((err as Error).message).toBe("Sign-in did not complete. Reopen the pane or retry.");
      expect(f).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });

  test("a sign-in timeout resets the shared token request, so a retry asks Office again", async () => {
    const restore = fakeClock();
    try {
      const getAccessToken = vi.fn()
        .mockImplementationOnce(() => new Promise<string>(() => {})) // Office never answers
        .mockImplementationOnce(async () => "t2");
      const sso = entraAuth({ getAccessToken });
      const f = vi.fn(async () => json([]));
      const c = createClient({ baseUrl: "http://api", auth: sso, fetchImpl: f as unknown as typeof fetch });
      const first = c.sponsors().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS);
      expect(await first).toBeInstanceOf(AuthTimeout);
      expect(await c.sponsors()).toEqual([]); // the Retry: a fresh Office request, not the dead one
      expect(getAccessToken).toHaveBeenCalledTimes(2);
      const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t2");
    } finally { restore(); }
  });
});

describe("anySignal", () => {
  const cases: [string, boolean][] = [["native AbortSignal.any", true], ["fallback", false]];
  test.each(cases)("%s: aborts with the first reason; already-aborted inputs abort at once", (_name, native) => {
    const original = AbortSignal.any;
    const fallbackAny = (signals: AbortSignal[]): AbortSignal => {
      const c = new AbortController();
      signals.forEach((s) => s.addEventListener("abort", () => c.abort(s.reason), { once: true }));
      return c.signal;
    };
    Object.defineProperty(AbortSignal, "any", { value: native ? fallbackAny : undefined, configurable: true, writable: true });
    try {
      const a = new AbortController();
      const b = new AbortController();
      const { signal: both } = anySignal([a.signal, b.signal]);
      expect(both.aborted).toBe(false);
      b.abort("b-reason");
      expect(both.aborted).toBe(true);
      expect(both.reason).toBe("b-reason");
      a.abort("late");
      expect(both.reason).toBe("b-reason");
      const done = new AbortController();
      done.abort("early");
      if (!native) expect(anySignal([new AbortController().signal, done.signal]).signal.reason).toBe("early");
    } finally {
      Object.defineProperty(AbortSignal, "any", { value: original, configurable: true, writable: true });
    }
  });

  function withoutAny<T>(fn: () => Promise<T>): Promise<T> {
    const original = AbortSignal.any;
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true, writable: true });
    return fn().finally(() => Object.defineProperty(AbortSignal, "any", { value: original, configurable: true, writable: true }));
  }
  /** A caller signal that counts its live abort listeners. */
  function countedSignal() {
    const c = new AbortController();
    const live = new Set<EventListenerOrEventListenerObject>();
    const add = c.signal.addEventListener.bind(c.signal);
    const remove = c.signal.removeEventListener.bind(c.signal);
    c.signal.addEventListener = ((type: string, l: EventListenerOrEventListenerObject, o?: AddEventListenerOptions | boolean) => { if (type === "abort") live.add(l); add(type, l, o); }) as typeof c.signal.addEventListener;
    c.signal.removeEventListener = ((type: string, l: EventListenerOrEventListenerObject, o?: EventListenerOptions | boolean) => { if (type === "abort") live.delete(l); remove(type, l, o); }) as typeof c.signal.removeEventListener;
    return { controller: c, live: () => live.size };
  }

  test("fallback dispose removes its listeners from every input", () => withoutAny(async () => {
    const caller = countedSignal();
    const other = new AbortController();
    const combined = anySignal([caller.controller.signal, other.signal]);
    expect(caller.live()).toBe(1);
    combined.dispose();
    expect(caller.live()).toBe(0);
    caller.controller.abort("after dispose");
    expect(combined.signal.aborted).toBe(false);
    const again = anySignal([caller.controller.signal]);
    expect(again.signal.reason).toBe("after dispose"); // already aborted: no listener is added at all
    const c2 = countedSignal();
    const o2 = new AbortController();
    anySignal([c2.controller.signal, o2.signal]);
    o2.abort("other");
    expect(c2.live()).toBe(0); // the combined signal aborting also removes them
  }));

  test.each([["native AbortSignal.any", true], ["fallback", false]] as const)("%s: through client.run, a caller abort propagates, a deadline times out, and no listener stays on the caller", (_name, native) => {
    const run = async () => {
      const f = vi.fn((_url: string, init: RequestInit) => hangUntilAborted(init.signal));
      const c = createClient({ baseUrl: "http://api", auth, fetchImpl: f as unknown as typeof fetch, requestTimeoutMs: 30 });
      const cancelled = countedSignal();
      const p = c.run("r1", cancelled.controller.signal).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 5));
      cancelled.controller.abort(new DOMException("stopped", "AbortError"));
      const aborted = await p;
      expect(aborted).not.toBeInstanceOf(ApiError);
      expect((aborted as DOMException).name).toBe("AbortError");
      const kept = countedSignal();
      const timedOut = await c.run("r1", kept.controller.signal).catch((e: unknown) => e);
      expect(timedOut).toBeInstanceOf(RequestTimeout);
      expect((timedOut as Error).message).toBe("Request timed out after 0.03 s");
      if (!native) expect(kept.live()).toBe(0); // the caller signal outlives the request: its listeners are gone
      const ok = createClient({ baseUrl: "http://api", auth, fetchImpl: (async () => json(fakeRun)) as unknown as typeof fetch, requestTimeoutMs: 30 });
      const third = countedSignal();
      expect(await ok.run("r1", third.controller.signal)).toEqual(fakeRun);
      if (!native) expect(third.live()).toBe(0);
    };
    return native ? run() : withoutAny(run);
  });

  test("without AbortSignal.timeout, a timer-based deadline still ends the request", async () => {
    const original = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true, writable: true });
    try {
      const f = vi.fn((_url: string, init: RequestInit) => hangUntilAborted(init.signal));
      const c = createClient({ baseUrl: "http://api", auth, fetchImpl: f as unknown as typeof fetch, requestTimeoutMs: 20 });
      await expect(c.health()).rejects.toThrow("Request timed out after 0.02 s");
      const ok = createClient({ baseUrl: "http://api", auth, fetchImpl: (async () => json({ status: "ok" })) as unknown as typeof fetch, requestTimeoutMs: 20 });
      expect(await ok.health()).toEqual({ status: "ok" });
    } finally {
      Object.defineProperty(AbortSignal, "timeout", { value: original, configurable: true, writable: true });
    }
  });
});

describe("copilot client", () => {
  const mk = (f: unknown, extra: Record<string, number> = {}) => createClient({ baseUrl: "http://api", auth, fetchImpl: f as typeof fetch, ...extra });
  const started = { session_id: "s/1", limits: { max_cells_per_call: 1, max_cells_per_session: 2, max_steps_per_turn: 3, max_write_cells: 4, cell_char_limit: 5 }, tools: ["find"], run_bound: false };
  const call0 = (f: ReturnType<typeof vi.fn>) => f.mock.calls[0] as unknown as [string, RequestInit];

  test("copilotStart posts JSON {} or {run_id} with auth and request id", async () => {
    const f = vi.fn(async () => json(started));
    expect(await mk(f).copilotStart()).toEqual(started);
    const [url, init] = call0(f);
    expect(url).toBe("http://api/copilot/sessions");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    const h = init.headers as Record<string, string>;
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["X-Actor"]).toBe("analyst");
    expect(h["X-Request-Id"]).toBeTruthy();
    await mk(f).copilotStart("run-ab12");
    expect((f.mock.calls[1] as unknown as [string, RequestInit])[1].body).toBe('{"run_id":"run-ab12"}');
  });

  test("copilotStep posts the body to the encoded session path", async () => {
    const out = { status: "final", tool_calls: [], text: "ok", proposed_changes: [], proposed_writes: [], notes: [] };
    const f = vi.fn(async () => json(out));
    expect(await mk(f).copilotStep("s/1", { tool_results: [{ call_id: "c1", ok: true, content: { sheets: [] } }] })).toEqual(out);
    const [url, init] = call0(f);
    expect(url).toBe("http://api/copilot/sessions/s%2F1/step");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ tool_results: [{ call_id: "c1", ok: true, content: { sheets: [] } }] });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    await mk(f).copilotStep("s1", { user_message: "hi" });
    expect(JSON.parse((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ user_message: "hi" });
  });

  test("copilotClose sends DELETE; resolves on 204 and on 404, rejects otherwise", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(mk(f).copilotClose("s/1")).resolves.toBeUndefined();
    const [url, init] = call0(f);
    expect(url).toBe("http://api/copilot/sessions/s%2F1");
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>)["X-Request-Id"]).toBeTruthy();
    await expect(mk(vi.fn(async () => json({ detail: "not found" }, 404))).copilotClose("s")).resolves.toBeUndefined();
    await expect(mk(vi.fn(async () => json({ detail: "busy" }, 409))).copilotClose("s")).rejects.toMatchObject({ status: 409 });
  });

  test("403 on start is an ApiError with status 403", async () => {
    const err = await mk(vi.fn(async () => json({ detail: "copilot is disabled" }, 403))).copilotStart().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe("copilot is disabled");
  });

  test("copilotErrorKind maps every status", async () => {
    const kinds: [number, string][] = [[403, "disabled"], [404, "session_lost"], [503, "busy"], [429, "too_many"], [409, "conflict"], [413, "too_large"], [415, "bad_request"], [422, "bad_request"], [500, "other"]];
    for (const [status, kind] of kinds) {
      const e = await mk(vi.fn(async () => json({ detail: "x" }, status))).copilotStep("s", { user_message: "m" }).catch((x) => x);
      expect(copilotErrorKind(e)).toBe(kind);
    }
    expect(copilotErrorKind(new RequestTimeout(120, "r"))).toBe("timeout");
    expect(copilotErrorKind(new ApiError("x", 0, "r"))).toBe("other");
    expect(copilotErrorKind(new Error("x"))).toBe("other");
    expect(copilotErrorKind(undefined)).toBe("other");
  });

  test("503 exposes Retry-After seconds; absent or garbage is tolerated", async () => {
    const busy = (h: Record<string, string>) => mk(vi.fn(async () => new Response(JSON.stringify({ detail: "copilot is busy" }), { status: 503, headers: h }))).copilotStep("s", { user_message: "m" }).catch((e) => e);
    expect((await busy({ "Retry-After": "5" })).retryAfterSeconds).toBe(5);
    expect((await busy({})).retryAfterSeconds).toBeUndefined();
    expect((await busy({ "Retry-After": "soon" })).retryAfterSeconds).toBeUndefined();
    expect((await busy({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" })).retryAfterSeconds).toBeUndefined();
    const other = await mk(vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "5" } }))).copilotStart().catch((e) => e);
    expect(other.retryAfterSeconds).toBeUndefined();
  });

  test("a step uses the longer bound, start and close the normal one", async () => {
    expect(COPILOT_STEP_TIMEOUT_MS).toBe(120_000);
    const f = vi.fn((_u: string, init: RequestInit) => hangUntilAborted<Response>(init.signal));
    const c = mk(f, { requestTimeoutMs: 20, copilotStepTimeoutMs: 80 });
    const t0 = Date.now();
    const start = await c.copilotStart().catch((e) => e);
    const close = await c.copilotClose("s").catch((e) => e);
    const mid = Date.now();
    const step = await c.copilotStep("s", { user_message: "m" }).catch((e) => e);
    const t1 = Date.now();
    expect(start).toBeInstanceOf(RequestTimeout);
    expect(close).toBeInstanceOf(RequestTimeout);
    expect(step).toBeInstanceOf(RequestTimeout);
    expect(step.message).toBe("Request timed out after 0.08 s");
    expect(start.message).toBe("Request timed out after 0.02 s");
    expect(mid - t0).toBeLessThan(75);
    expect(t1 - mid).toBeGreaterThanOrEqual(70);
  });
});
