import { ApiError } from "./client";

export interface SseMessage { id: string | null; event: string; data: string }

const EOL = /\r\n|\n|\r(?!$)/; // a lone trailing "\r" may be the first half of "\r\n": wait for more bytes

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let id: string | null = null;
  let event = "message";
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (let m = EOL.exec(buf); m; m = EOL.exec(buf)) {
        const line = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        if (line === "") {
          if (data.length) yield { id, event, data: data.join("\n") };
          event = "message";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const val = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "id") id = val;
        else if (field === "event") event = val;
        else if (field === "data") data.push(val);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface StreamOptions {
  open: (lastEventId: string | null, signal: AbortSignal) => Promise<Response>;
  onMessage: (m: SseMessage) => void;
  onStatus?: (s: "connected" | "reconnecting") => void;
  signal: AbortSignal;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const FATAL = new Set([401, 403, 404]);

export async function streamEvents({ open, onMessage, onStatus, signal, backoffMs = [500, 1000, 2000, 5000], sleep }: StreamOptions): Promise<void> {
  const wait = sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  }));
  let last: string | null = null;
  let attempt = 0;
  let handlerFailed = false;
  while (!signal.aborted) {
    try {
      const res = await open(last, signal);
      if (!res.body) throw new TypeError("no response body");
      onStatus?.("connected");
      for await (const m of parseSse(res.body)) {
        attempt = 0;
        if (m.id) last = m.id;
        try { onMessage(m); } catch (err) { handlerFailed = true; throw err; }
        if (signal.aborted) return;
      }
    } catch (e) {
      if (handlerFailed) throw e;
      if (signal.aborted) return;
      if (e instanceof ApiError && FATAL.has(e.status)) throw e;
    }
    if (signal.aborted) return;
    onStatus?.("reconnecting");
    await wait(backoffMs[Math.min(attempt++, backoffMs.length - 1)] ?? 5000);
  }
}
