import { describe, expect, test, vi } from "vitest";
import { anySignal, ApiError, createClient, DOWNLOAD_TIMEOUT_MS, REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from "../../src/api/client";

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

  test("a body that never finishes and a token that never comes are bounded too", async () => {
    const hungBody = vi.fn(async (_url: string, init: RequestInit) =>
      ({ ok: true, status: 200, json: () => hangUntilAborted(init.signal) }) as unknown as Response);
    const c1 = createClient({ baseUrl: "http://api", auth, fetchImpl: hungBody as unknown as typeof fetch, requestTimeoutMs: 20 });
    await expect(c1.run("r1")).rejects.toThrow("Request timed out after 0.02 s");
    const f = vi.fn(async () => json({}));
    const hungAuth = { label: "test", headers: () => new Promise<Record<string, string>>(() => {}) };
    const c2 = createClient({ baseUrl: "http://api", auth: hungAuth, fetchImpl: f as unknown as typeof fetch, requestTimeoutMs: 20 });
    await expect(c2.sponsors()).rejects.toThrow("Request timed out after 0.02 s");
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

/** Settles only by rejecting with the signal's reason, like fetch does when its signal aborts. */
function hangUntilAborted<T>(signal: AbortSignal | null | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

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
      const both = anySignal([a.signal, b.signal]);
      expect(both.aborted).toBe(false);
      b.abort("b-reason");
      expect(both.aborted).toBe(true);
      expect(both.reason).toBe("b-reason");
      a.abort("late");
      expect(both.reason).toBe("b-reason");
      const done = new AbortController();
      done.abort("early");
      if (!native) expect(anySignal([new AbortController().signal, done.signal]).reason).toBe("early");
    } finally {
      Object.defineProperty(AbortSignal, "any", { value: original, configurable: true, writable: true });
    }
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
