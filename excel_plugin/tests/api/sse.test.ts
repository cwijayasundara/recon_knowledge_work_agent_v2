import { describe, expect, test } from "vitest";
import { ApiError } from "../../src/api/client";
import { parseSse, streamEvents, type SseMessage } from "../../src/api/sse";

const enc = new TextEncoder();
function stream(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(typeof ch === "string" ? enc.encode(ch) : ch); c.close(); } });
}
async function collect(s: ReadableStream<Uint8Array>): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const m of parseSse(s)) out.push(m);
  return out;
}

describe("parseSse", () => {
  test("parses id, event and data", async () => {
    expect(await collect(stream(["id: 3\nevent: gate\ndata: {\"a\":1}\n\n"]))).toEqual([{ id: "3", event: "gate", data: '{"a":1}' }]);
  });
  test("handles CRLF and a split CRLF across chunks", async () => {
    const m = await collect(stream(["id: 1\r", "\nevent: phase\r\ndata: x\r\n\r", "\n"]));
    expect(m).toEqual([{ id: "1", event: "phase", data: "x" }]);
  });
  test("handles a chunk boundary inside a field and inside a multibyte character", async () => {
    const bytes = enc.encode("event: agent_message\ndata: café\n\n");
    const cut = bytes.indexOf(0xc3) + 1;
    const m = await collect(stream([bytes.slice(0, cut), bytes.slice(cut)]));
    expect(m).toEqual([{ id: null, event: "agent_message", data: "café" }]);
  });
  test("ignores comments and joins multi-line data", async () => {
    expect(await collect(stream([": ping\n\n", "data: a\ndata: b\n\n"]))).toEqual([{ id: null, event: "message", data: "a\nb" }]);
  });
  test("does not dispatch an event cut off before the blank line", async () => {
    expect(await collect(stream(["event: gate\ndata: x\n"]))).toEqual([]);
  });
});

describe("streamEvents", () => {
  const ok = (chunks: string[]) => new Response(stream(chunks), { status: 200 });
  const instant = async () => {};

  test("reconnects with Last-Event-ID after the stream ends", async () => {
    const seen: (string | null)[] = [];
    const ctl = new AbortController();
    const got: SseMessage[] = [];
    let calls = 0;
    await streamEvents({
      open: async (last) => { seen.push(last); calls++; return ok([calls === 1 ? "id: 1\nevent: a\ndata: 1\n\n" : "id: 2\nevent: b\ndata: 2\n\n"]); },
      onMessage: (m) => { got.push(m); if (m.id === "2") ctl.abort(); },
      signal: ctl.signal, sleep: instant,
    });
    expect(seen).toEqual([null, "1"]);
    expect(got.map((m) => m.event)).toEqual(["a", "b"]);
  });

  test("retries with backoff after a network error", async () => {
    const delays: number[] = [];
    const ctl = new AbortController();
    let calls = 0;
    await streamEvents({
      open: async () => { calls++; if (calls < 3) throw new TypeError("network"); ctl.abort(); return ok([]); },
      onMessage: () => {}, signal: ctl.signal, backoffMs: [10, 20, 40], sleep: async (ms) => { delays.push(ms); },
    });
    expect(delays).toEqual([10, 20]);
  });

  test("does not retry auth or not-found errors", async () => {
    const ctl = new AbortController();
    await expect(streamEvents({ open: async () => { throw new ApiError("nope", 401, "r"); }, onMessage: () => {}, signal: ctl.signal, sleep: instant })).rejects.toBeInstanceOf(ApiError);
  });

  test("propagates onMessage errors and cancels the body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode("id: 1\nevent: a\ndata: 1\n\n")); },
      cancel() { cancelled = true; },
    });
    const boom = new Error("handler");
    await expect(streamEvents({
      open: async () => new Response(body, { status: 200 }),
      onMessage: () => { throw boom; },
      signal: new AbortController().signal, sleep: instant,
    })).rejects.toBe(boom);
    expect(cancelled).toBe(true);
  });

  test("abort during the default backoff sleep resolves promptly", async () => {
    const ctl = new AbortController();
    const p = streamEvents({
      open: async () => { throw new TypeError("network"); },
      onMessage: () => {}, signal: ctl.signal, backoffMs: [60000],
    });
    setTimeout(() => ctl.abort(), 20);
    const winner = await Promise.race([p.then(() => "done"), new Promise((r) => setTimeout(() => r("late"), 1000))]);
    expect(winner).toBe("done");
  });
});
