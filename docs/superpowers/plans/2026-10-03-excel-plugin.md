# Excel Plugin (`/excel_plugin`) Implementation Plan, Phase 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready Office task-pane add-in in `/excel_plugin` that drives the Affiliate onboarding flow (upload, brief and questions, review, sign-off, download) against the existing workbench API.

**Architecture:** A Preact task pane. One snapshot-driven run store: SSE events are only triggers, and `GET /runs/{id}` is the truth (the same model as `web/lib/useRun.ts`). `api/` and `state/` know nothing about Office. `office/` knows nothing about the API. Gates are pane buttons that post to `/gate`; no cell edit ever approves anything.

**Tech Stack:** TypeScript 5.9, Vite, Preact, Vitest + `@testing-library/preact` + jsdom, ESLint, pnpm, Office.js (types only: `@types/office-js`).

**Spec:** `docs/superpowers/specs/2026-10-03-excel-plugin-design.md` (read it and `docs/excel-addin-sketch.md` first). Phase 2 (Copilot tab) is NOT in this plan; it needs its own spec and plan and an explicit decision on the raw-rows exception.

## Global Constraints

- The add-in makes **no model calls** and holds no model key. Never add Anthropic/Claude packages (CLAUDE.md).
- No real client, fund administrator or person's name anywhere; use "sponsor", `sponsor-a`.
- Never use `tenant_id="*"`; the pane only ever shows one sponsor's run.
- Tokens go in headers only. No `access_token` query param (the API accepts it, we do not use it).
- The source workbook is never modified by the add-in (selection changes only).
- Review-sheet cells never approve, acknowledge or exclude; only pane buttons post gates.
- Dev actor auth must be absent from production builds (build fails if present).
- Server rejections are shown verbatim, never retried silently.
- Code style: strict TS, no `any` outside test fakes, small files with one responsibility, comments explain constraints.
- Do not commit unless the executor was told to; the commit steps below are for when the user has asked for commits (CLAUDE.md: do not commit unless asked). If not asked, skip every "Commit" step.

## Review Focus

- `source_row` in `/grid` is a 1-based index over the server's parsed sheet grid (`enumerate(sheet.grid, start=1)`); it may not equal the Excel row for `titled.xlsx` (title rows) or sheets not starting at A1. Highlight/jump must be verified on `titled.xlsx` and offset if needed (Task 8 test, Task 12 contract test).
- SSE chunk boundaries inside a UTF-8 character, inside `\r\n`, or between `event:` and `data:` lines must not drop or duplicate messages (Task 3).
- A `409` from `/gate` ("run is already working") when the user double-clicks must show a message and leave the pane consistent (Task 4).
- Workbook not yet saved (`Office.context.document.url` empty) or larger than the size cap: clear message, no upload (Task 5).
- The user edits a non-ITEM_ID Review cell, pastes over a range, or deletes the Review sheet mid-edit: revert, no API call, pane recovers by re-render (Task 9).
- API restarts mid-run (SSE history lost, `Last-Event-ID` ahead of server): the store must rebuild from the snapshot (Task 4).

---

## File Structure

```
excel_plugin/
  package.json  pnpm-workspace? (none)  tsconfig.json  vite.config.ts  vitest.config.ts  eslint.config.js
  index.html
  manifest.template.xml          # production manifest template, filled by scripts/build-manifest.mjs
  manifest.dev.xml               # sideload against https://localhost:3100
  scripts/build-manifest.mjs  scripts/check-bundle.mjs
  staticwebapp.config.json       # CSP + headers for Azure Static Web Apps
  CHANGELOG.md  README.md
  src/
    main.tsx  app.tsx
    config.ts                    # env -> typed config
    api/types.ts  api/client.ts  api/sse.ts
    auth/auth.ts  auth/dev.ts  auth/entra.ts
    state/store.ts  state/gates.ts
    office/workbook.ts  office/highlight.ts  office/review.ts  office/office-types.ts
    ui/Pane.tsx SponsorPicker.tsx Progress.tsx BriefCard.tsx QuestionCard.tsx
       FindingsList.tsx ReviewPanel.tsx SignOff.tsx ErrorBanner.tsx styles.css
  build/guard.ts
  tests/  (mirrors src) + contract/contract.test.ts + contract/globalSetup.ts + support/fakes.ts
```

---

### Task 1: Scaffold, tooling, dev manifest

**Files:** Create `excel_plugin/package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, `index.html`, `src/main.tsx`, `src/app.tsx`, `src/config.ts`, `manifest.dev.xml`, `tests/smoke.test.tsx`, `.gitignore`.

**Interfaces:**
- Produces: `config: { apiBase: string; auth: "dev" | "entra"; devActor: string; maxUploadBytes: number }` from `src/config.ts`; scripts `dev`, `build`, `typecheck`, `lint`, `test`, `check` (= typecheck && lint && test && build).

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "onboarding-excel-plugin",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite --port 3100 --https",
    "build": "tsc --noEmit && vite build && node scripts/check-bundle.mjs",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src tests build",
    "test": "vitest run",
    "check": "pnpm typecheck && pnpm lint && pnpm test && pnpm build",
    "manifest": "node scripts/build-manifest.mjs"
  },
  "dependencies": { "preact": "^10.24.0" },
  "devDependencies": {
    "@preact/preset-vite": "^2.9.0",
    "@testing-library/preact": "^3.2.4",
    "@types/office-js": "^1.0.500",
    "@types/node": "^22.10.0",
    "@vitest/coverage-v8": "^3.0.0",
    "@vitejs/plugin-basic-ssl": "^1.2.0",
    "eslint": "^9.0.0",
    "typescript-eslint": "^8.0.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.9.3",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx", "jsxImportSource": "preact", "strict": true, "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true, "skipLibCheck": true, "types": ["office-js", "vite/client"], "noEmit": true
  },
  "include": ["src", "tests", "build", "vite.config.ts", "vitest.config.ts"]
}
```
`vite.config.ts`:
```ts
import { defineConfig, loadEnv } from "vite";
import preact from "@preact/preset-vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig(({ mode }) => {
  loadEnv(mode, process.cwd(), "VITE_");
  return { plugins: [preact(), basicSsl()], build: { target: "es2022", sourcemap: false } };
});
```
`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/contract/**"],
    coverage: { provider: "v8", include: ["src/api/**", "src/state/**", "src/office/**"], thresholds: { lines: 85, functions: 85, branches: 75 } },
  },
});
```
`eslint.config.js`:
```js
import tseslint from "typescript-eslint";
export default tseslint.config(...tseslint.configs.recommended, {
  rules: { "@typescript-eslint/no-explicit-any": "error", "no-restricted-syntax": ["error", { selector: "MemberExpression[property.name='innerHTML']", message: "Use text nodes; workbook text is untrusted." }] },
  files: ["src/**/*.{ts,tsx}"],
}, { ignores: ["dist", "node_modules"] });
```

- [ ] **Step 3: Write `src/config.ts`, `index.html`, `src/main.tsx`, `src/app.tsx`, `.gitignore`**

`src/config.ts`:
```ts
export interface Config {
  apiBase: string;
  auth: "dev" | "entra";
  devActor: string;
  maxUploadBytes: number;
}

const env = import.meta.env;

export const config: Config = {
  apiBase: (env.VITE_API_BASE as string | undefined) ?? "http://localhost:8000",
  auth: env.VITE_AUTH === "entra" ? "entra" : "dev",
  devActor: (env.VITE_DEV_ACTOR as string | undefined) ?? "analyst",
  maxUploadBytes: Number(env.VITE_MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024),
};
```
`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Onboarding workbench</title>
    <script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>
  </head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```
`src/main.tsx`:
```tsx
import { render } from "preact";
import { App } from "./app";
import "./ui/styles.css";

Office.onReady(() => render(<App />, document.getElementById("root")!));
```
`src/app.tsx`: `export function App() { return <main><h1>Onboarding workbench</h1></main>; }`
`.gitignore`: `node_modules`, `dist`, `coverage`, `manifest.prod.xml`.
Create empty `src/ui/styles.css`.

- [ ] **Step 4: Write the failing smoke test `tests/smoke.test.tsx`**

```tsx
import { render, screen } from "@testing-library/preact";
import { expect, test } from "vitest";
import { App } from "../src/app";

test("app renders the heading", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "Onboarding workbench" })).toBeTruthy();
});
```

- [ ] **Step 5: Install and run**

Run: `cd excel_plugin && pnpm install && pnpm test`
Expected: 1 passed. Then `pnpm typecheck && pnpm lint`: no errors.

- [ ] **Step 6: Write `manifest.dev.xml`** (Office add-in manifest v1.1, task pane, `Workbook` host, `SourceLocation` `https://localhost:3100/index.html`, `Permissions` `ReadWriteDocument`, a fresh GUID for `Id`, `DisplayName` "Onboarding workbench", ribbon button "Open pane" in the Home tab via `VersionOverrides`). Validate: `npx office-addin-manifest validate manifest.dev.xml` → "The manifest is valid."

- [ ] **Step 7: Commit (only if asked)**: `git add excel_plugin && git commit -m "feat(excel_plugin): scaffold task-pane add-in"`

---

### Task 2: API types, client, auth

**Files:** Create `src/api/types.ts`, `src/api/client.ts`, `src/auth/auth.ts`, `src/auth/dev.ts`, `src/auth/entra.ts`, `build/guard.ts`; tests `tests/api/client.test.ts`, `tests/auth/auth.test.ts`, `tests/build/guard.test.ts`; modify `vite.config.ts`.

**Interfaces:**
- Produces:
  - `src/api/types.ts`: copy the needed interfaces from `web/lib/types.ts` (`TypedChange`, `Binding`, `Question`, `Brief`, `Finding`, `Report`, `Impact`, `Pending`, `Artifact`, `Snapshot`, `GridRow`; read the file for exact fields and keep them identical) plus `export interface GateBody { action: "approve"|"answer"|"change"|"instruct"|"reject"; question_id?: string; option?: string; changes?: TypedChange[]; text?: string; reason?: string }` and `export interface SourceGrid { sheet: string; header_row: number | null; total: number; rows: { row: number; cells: string[] }[] }`, `export interface PreviewGrid { total: number; rows: GridRow[]; item_id_limit: number }`. Header comment: "Mirrors web/lib/types.ts; keep in sync".
  - `Auth`: `{ label: string; headers(): Promise<Record<string,string>> }`.
  - `ApiError extends Error { status: number; requestId: string }`.
  - `createClient(opts: { baseUrl: string; auth: Auth; fetchImpl?: typeof fetch }): Client` with methods `health(): Promise<{status:string; version?:string}>`, `sponsors(): Promise<{id:string;name:string}[]>`, `startRun(sponsorId: string, file: Blob, name: string): Promise<{run_id:string}>`, `run(id): Promise<Snapshot>`, `grid(id): Promise<PreviewGrid>` (preview, limit 500), `source(id): Promise<SourceGrid>` (limit 500), `gate(id, body: GateBody): Promise<{accepted:boolean}>`, `dryRun(id, changes: TypedChange[]): Promise<Impact>`, `artifact(id, name): Promise<Blob>`, `openEvents(id, lastEventId: string|null, signal: AbortSignal): Promise<Response>`.
  - `assertProdAuth(mode: string, auth: string): void` in `build/guard.ts`.

- [ ] **Step 1: Write failing client tests** `tests/api/client.test.ts`:

```ts
import { describe, expect, test, vi } from "vitest";
import { ApiError, createClient } from "../../src/api/client";

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
});
```

- [ ] **Step 2: Run to fail**: `pnpm vitest run tests/api/client.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/auth/auth.ts` and `src/api/client.ts`**

`src/auth/auth.ts`:
```ts
export interface Auth {
  label: string;
  headers(): Promise<Record<string, string>>;
}
```
`src/api/client.ts` (key parts; implement all listed methods the same way):
```ts
import type { Auth } from "../auth/auth";
import type { GateBody, Impact, PreviewGrid, Snapshot, SourceGrid, TypedChange } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly requestId: string) {
    super(message);
  }
}

export interface ClientOptions { baseUrl: string; auth: Auth; fetchImpl?: typeof fetch }

export function createClient({ baseUrl, auth, fetchImpl }: ClientOptions) {
  const doFetch = fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function raw(path: string, init: RequestInit = {}, extra: Record<string, string> = {}): Promise<{ res: Response; requestId: string }> {
    const requestId = crypto.randomUUID();
    const headers = { ...(await auth.headers()), "X-Request-Id": requestId, ...extra };
    const res = await doFetch(`${baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      let detail: unknown = res.statusText;
      try { detail = ((await res.json()) as { detail?: unknown }).detail ?? detail; } catch { /* non-JSON body */ }
      throw new ApiError(typeof detail === "string" ? detail : JSON.stringify(detail), res.status, requestId);
    }
    return { res, requestId };
  }
  const json = async <T>(path: string, init?: RequestInit, extra?: Record<string, string>): Promise<T> =>
    (await (await raw(path, init, extra)).res.json()) as T;
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
      return json<{ run_id: string }>("/runs", { method: "POST", body: form }); // no Content-Type: the browser sets the boundary
    },
    run: (id: string) => json<Snapshot>(`/runs/${id}`),
    grid: (id: string) => json<PreviewGrid>(`/runs/${id}/grid?view=preview&limit=500`),
    source: (id: string) => json<SourceGrid>(`/runs/${id}/grid?view=source&limit=500`),
    gate: (id: string, body: GateBody) => post<{ accepted: boolean }>(`/runs/${id}/gate`, body),
    dryRun: (id: string, changes: TypedChange[]) => post<Impact>(`/runs/${id}/dry-run`, { changes }),
    artifact: async (id: string, name: string) => (await (await raw(`/runs/${id}/artifacts/${encodeURIComponent(name)}`)).res.blob()),
    openEvents: async (id: string, lastEventId: string | null, signal: AbortSignal) =>
      (await raw(`/runs/${id}/events`, { signal }, { Accept: "text/event-stream", ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) })).res,
  };
}
export type Client = ReturnType<typeof createClient>;
```

- [ ] **Step 4: Run to pass**: `pnpm vitest run tests/api/client.test.ts` → 4 passed.

- [ ] **Step 5: Write failing auth + guard tests**

`tests/auth/auth.test.ts`:
```ts
import { expect, test, vi } from "vitest";
import { devAuth } from "../../src/auth/dev";
import { entraAuth } from "../../src/auth/entra";

test("dev auth sends X-Actor only", async () => {
  expect(await devAuth("ana").headers()).toEqual({ "X-Actor": "ana" });
});

test("entra auth sends a bearer token from Office SSO", async () => {
  const getAccessToken = vi.fn(async () => "tok");
  expect(await entraAuth({ getAccessToken }).headers()).toEqual({ Authorization: "Bearer tok" });
});

test("entra auth surfaces SSO failure as an actionable error", async () => {
  const getAccessToken = vi.fn(async () => { throw { code: 13001 }; });
  await expect(entraAuth({ getAccessToken }).headers()).rejects.toThrow(/sign in/i);
});
```
`tests/build/guard.test.ts`:
```ts
import { expect, test } from "vitest";
import { assertProdAuth } from "../../build/guard";

test("production build refuses dev auth", () => {
  expect(() => assertProdAuth("production", "dev")).toThrow(/dev auth/i);
  expect(() => assertProdAuth("production", "entra")).not.toThrow();
  expect(() => assertProdAuth("development", "dev")).not.toThrow();
});
```

- [ ] **Step 6: Implement** `src/auth/dev.ts` (`export const devAuth = (actor: string): Auth => ({ label: \`dev:${actor}\`, headers: async () => ({ "X-Actor": actor }) })`), `src/auth/entra.ts`:
```ts
import type { Auth } from "./auth";

export interface SsoSource { getAccessToken(): Promise<string> }

/** The API sits behind Easy Auth, which validates the bearer token and sets x-ms-client-principal-name. */
export function entraAuth(sso: SsoSource): Auth {
  return {
    label: "entra",
    async headers() {
      try {
        return { Authorization: `Bearer ${await sso.getAccessToken()}` };
      } catch {
        throw new Error("Please sign in to Microsoft 365 in Excel, then reopen the pane.");
      }
    },
  };
}
```
`build/guard.ts`:
```ts
export function assertProdAuth(mode: string, auth: string): void {
  if (mode === "production" && auth !== "entra") throw new Error("Production builds must set VITE_AUTH=entra; dev auth is not allowed.");
}
```
Modify `vite.config.ts`: `const env = loadEnv(mode, process.cwd(), "VITE_"); assertProdAuth(mode, env.VITE_AUTH ?? "dev");` (import from `./build/guard`). Add `src/auth/index.ts`:
```ts
import { config } from "../config";
import type { Auth } from "./auth";
import { entraAuth } from "./entra";

export async function createAuth(): Promise<Auth> {
  if (config.auth === "entra") return entraAuth({ getAccessToken: () => Office.auth.getAccessToken({ allowSignInPrompt: true }) });
  if (import.meta.env.PROD) throw new Error("dev auth in a production bundle");
  return (await import("./dev")).devAuth(config.devActor);
}
```
(The dynamic import lets the bundler drop `dev.ts` from production builds.)

- [ ] **Step 7: Run all**: `pnpm test && pnpm typecheck && pnpm lint` → pass. Commit (only if asked).

---

### Task 3: SSE fetch-stream parser with reconnect

**Files:** Create `src/api/sse.ts`, `tests/api/sse.test.ts`.

**Interfaces:**
- Consumes: `Client.openEvents`, `ApiError`.
- Produces: `parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage>`; `SseMessage = { id: string | null; event: string; data: string }`; `streamEvents(opts: { open: (lastEventId: string|null, signal: AbortSignal) => Promise<Response>; onMessage: (m: SseMessage) => void; onStatus?: (s: "connected"|"reconnecting") => void; signal: AbortSignal; backoffMs?: number[]; sleep?: (ms: number) => Promise<void> }): Promise<void>`. Resolves when aborted; rejects with `ApiError` for 401/403/404 (no retry).

- [ ] **Step 1: Failing tests** `tests/api/sse.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run to fail**: `pnpm vitest run tests/api/sse.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/api/sse.ts`**

```ts
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

export async function streamEvents({ open, onMessage, onStatus, signal, backoffMs = [500, 1000, 2000, 5000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: StreamOptions): Promise<void> {
  let last: string | null = null;
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const res = await open(last, signal);
      if (!res.body) throw new TypeError("no response body");
      onStatus?.("connected");
      for await (const m of parseSse(res.body)) {
        attempt = 0;
        if (m.id) last = m.id;
        onMessage(m);
        if (signal.aborted) return;
      }
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ApiError && FATAL.has(e.status)) throw e;
    }
    if (signal.aborted) return;
    onStatus?.("reconnecting");
    await sleep(backoffMs[Math.min(attempt++, backoffMs.length - 1)] ?? 5000);
  }
}
```
Note: the first reconnect test expects no sleep delay assertions; the second expects delays `[10, 20]` and the third call aborts, so `sleep` is called exactly twice.

- [ ] **Step 4: Run to pass**: all `sse.test.ts` pass. If the multibyte test fails, confirm `decoder.decode(value, { stream: true })` is used. Commit (only if asked).

---

### Task 4: Run store and gate logic

**Files:** Create `src/state/store.ts`, `src/state/gates.ts`, `tests/state/store.test.ts`, `tests/state/gates.test.ts`, `tests/support/fakes.ts`.

**Interfaces:**
- Consumes: `Client`, `streamEvents`, `Snapshot`, `GateBody`, `ApiError`.
- Produces:
  - `gates.ts`: `canApprove(snap: Snapshot | null, busy: boolean): boolean`; `blockedReasons(snap): string[]`; `pendingGate(snap): Pending["gate"] | null`.
  - `store.ts`: `createRunStore(client: Client, opts?: { debounceMs?: number; streamer?: typeof streamEvents }): RunStore` where
    `RunState = { runId: string|null; snap: Snapshot|null; grid: GridRow[]; activity: string[]; error: string|null; busy: boolean; connection: "idle"|"connected"|"reconnecting" }` and
    `RunStore = { get(): RunState; subscribe(fn: () => void): () => void; start(runId: string): void; stop(): void; refresh(): Promise<void>; respond(body: GateBody): Promise<void> }`.
  - `tests/support/fakes.ts`: `fakeSnapshot(over?: Partial<Snapshot>): Snapshot` returning a minimal valid snapshot (`pending: null, working: false, result: null` etc.).

- [ ] **Step 1: Failing gate tests** `tests/state/gates.test.ts`:

```ts
import { expect, test } from "vitest";
import { blockedReasons, canApprove, pendingGate } from "../../src/state/gates";
import { fakeSnapshot } from "../support/fakes";

const pending = (over = {}) => ({ gate: "signoff" as const, message: null, blocked_reasons: [], allowed_actions: ["approve", "change"], ...over });

test("approve is allowed only when the gate lists it, nothing blocks and the run is idle", () => {
  expect(canApprove(fakeSnapshot({ pending: pending() }), false)).toBe(true);
  expect(canApprove(fakeSnapshot({ pending: pending({ allowed_actions: ["change"] }) }), false)).toBe(false);
  expect(canApprove(fakeSnapshot({ pending: pending({ blocked_reasons: ["2 errors"] }) }), false)).toBe(false);
  expect(canApprove(fakeSnapshot({ pending: pending() }), true)).toBe(false);
  expect(canApprove(fakeSnapshot({ pending: null }), false)).toBe(false);
  expect(canApprove(null, false)).toBe(false);
});
test("blockedReasons and pendingGate read the pending gate", () => {
  const s = fakeSnapshot({ pending: pending({ blocked_reasons: ["a"] }) });
  expect(blockedReasons(s)).toEqual(["a"]);
  expect(pendingGate(s)).toBe("signoff");
  expect(pendingGate(null)).toBeNull();
});
```

- [ ] **Step 2: Implement `gates.ts`; run to pass.**

```ts
import type { Pending, Snapshot } from "../api/types";

export const pendingGate = (s: Snapshot | null): Pending["gate"] | null => s?.pending?.gate ?? null;
export const blockedReasons = (s: Snapshot | null): string[] => s?.pending?.blocked_reasons ?? [];
export const canApprove = (s: Snapshot | null, busy: boolean): boolean =>
  !busy && !!s?.pending && s.pending.allowed_actions.includes("approve") && s.pending.blocked_reasons.length === 0;
```
Write `tests/support/fakes.ts` with `fakeSnapshot` (fill every required `Snapshot` field from `web/lib/types.ts` with neutral values).

- [ ] **Step 3: Failing store tests** `tests/state/store.test.ts` (use fake timers; fake `Client` with `vi.fn()`s; fake `streamer` that captures `onMessage`/`onStatus`):

```ts
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../../src/api/client";
import { createRunStore } from "../../src/state/store";
import { fakeSnapshot } from "../support/fakes";

function setup(snapOver = {}) {
  const client = {
    run: vi.fn(async () => fakeSnapshot(snapOver)),
    grid: vi.fn(async () => ({ total: 0, rows: [], item_id_limit: 40 })),
    gate: vi.fn(async () => ({ accepted: true })),
  };
  let push: (kind: string, data?: unknown, id?: string) => void = () => {};
  let status: (s: "connected" | "reconnecting") => void = () => {};
  const streamer = vi.fn(async (o: { onMessage: (m: { id: string | null; event: string; data: string }) => void; onStatus?: typeof status; signal: AbortSignal }) => {
    push = (event, data = {}, id = "1") => o.onMessage({ id, event, data: JSON.stringify(data) });
    status = o.onStatus!;
    await new Promise<void>((r) => o.signal.addEventListener("abort", () => r()));
  });
  const store = createRunStore(client as never, { debounceMs: 10, streamer: streamer as never });
  return { client, store, push: (...a: Parameters<typeof push>) => push(...a), status: (s: "connected" | "reconnecting") => status(s) };
}
beforeEach(() => vi.useFakeTimers());

test("start loads the snapshot", async () => {
  const { store, client } = setup();
  store.start("r1");
  await vi.advanceTimersByTimeAsync(0);
  expect(client.run).toHaveBeenCalledWith("r1");
  expect(store.get().snap?.run_id).toBeDefined();
});

test("gate and idle events trigger one debounced refresh; others do not", async () => {
  const { store, client, push } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.run.mockClear();
  push("gate"); push("gate"); push("idle");
  await vi.advanceTimersByTimeAsync(50);
  expect(client.run).toHaveBeenCalledTimes(1);
  client.run.mockClear();
  push("agent_message", { mode: "x" }); push("tool");
  await vi.advanceTimersByTimeAsync(50);
  expect(client.run).not.toHaveBeenCalled();
});

test("respond marks busy, posts the gate and refreshes; a 409 shows the server message and clears busy", async () => {
  const { store, client } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.gate.mockRejectedValueOnce(new ApiError("the run is already working", 409, "rid"));
  await store.respond({ action: "approve" });
  expect(store.get().error).toContain("the run is already working");
  expect(store.get().busy).toBe(false);
});

test("a reconnect refreshes from the snapshot (server history may have been lost)", async () => {
  const { store, client, status } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  client.run.mockClear();
  status("reconnecting"); status("connected");
  await vi.advanceTimersByTimeAsync(50);
  expect(store.get().connection).toBe("connected");
  expect(client.run).toHaveBeenCalledTimes(1);
});

test("stop aborts the stream and drops further updates", async () => {
  const { store, client, push } = setup();
  store.start("r1"); await vi.advanceTimersByTimeAsync(0);
  store.stop(); client.run.mockClear();
  push("gate"); await vi.advanceTimersByTimeAsync(50);
  expect(client.run).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Run to fail, then implement `store.ts`.**

Behaviour to implement exactly:
- `REFRESH_ON = new Set(["gate","idle","brief","report","findings","decision","artifact","error","change_impact","phase","question"])`.
- `start(runId)`: reset state, create an `AbortController`, `void refresh()`, call `streamer({ open: (last, signal) => client.openEvents(runId, last, signal), onMessage, onStatus, signal })`; `.catch` sets `error` (stream fatal errors, e.g. 404) unless aborted.
- `onMessage`: ignore if stopped; parse JSON defensively (bad JSON ignored); append compact activity lines for `agent_message` (mode), `decision` (`actor: kind`), `error` (`Error: message`), cap 20; `idle` sets `busy=false`; schedule a debounced refresh if the kind is in `REFRESH_ON`.
- `onStatus("connected")` after a previous `"reconnecting"` schedules a refresh; always sets `connection`.
- `refresh()`: `client.run(runId)`; set `snap`, `busy = snap.working`, `error = snap.job_error`; if `snap.result` fetch `client.grid(runId)` into `grid`, else `grid = []`. A thrown error sets `error = message` (ApiError message verbatim, with ` (ref ${requestId})` appended).
- `respond(body)`: set `busy=true, error=null`; `await client.gate(runId, body)`; on `ApiError` set `error` (verbatim + ref) and `busy=false`; always schedule a refresh.
- `subscribe` notifies on every state change; `get()` returns the current immutable object.

- [ ] **Step 5: Run all state tests → pass.** Commit (only if asked).

---

### Task 5: Workbook read and upload

**Files:** Create `src/office/office-types.ts`, `src/office/workbook.ts`, `tests/office/workbook.test.ts`.

**Interfaces:**
- Produces: `readWorkbook(host: DocumentHost, opts: { maxBytes: number; sliceSize?: number }): Promise<WorkbookFile>` where `WorkbookFile = { blob: Blob; name: string; sha256: string; bytes: number }`; `class WorkbookError extends Error { code: "unsaved" | "too_large" | "read_failed" }`; `DocumentHost = { url: string; getFileAsync(type: "compressed", opts: { sliceSize: number }, cb: (r: AsyncResult<FileLike>) => void): void }` with `FileLike = { size: number; sliceCount: number; getSliceAsync(i: number, cb: (r: AsyncResult<{ data: number[] }>) => void): void; closeAsync(): void }`. Real wiring: `hostFromOffice(): DocumentHost` adapting `Office.context.document` (`Office.FileType.Compressed`).

- [ ] **Step 1: Failing tests** covering: reassembles slices in order into the exact bytes; sha256 equals `crypto.subtle.digest` of the same bytes (compute the expected value in the test); empty `url` → `WorkbookError("unsaved")` with message "Save the workbook first so it has a file name"; `size > maxBytes` → `too_large` *before* any slice is read (assert `getSliceAsync` not called) with message naming the limit in MB; a failing slice → `read_failed` and `closeAsync` still called; file name is the last path segment of `url` (decoded), e.g. `https://x/y/Sponsor%20A.xlsx` → `Sponsor A.xlsx`.

Fake host helper in the test file:
```ts
const fakeHost = (bytes: Uint8Array, url = "https://x/y/a.xlsx", slice = 4) => ({
  url,
  getFileAsync: (_t: "compressed", _o: { sliceSize: number }, cb: (r: any) => void) => {
    const slices = Array.from({ length: Math.ceil(bytes.length / slice) }, (_, i) => Array.from(bytes.slice(i * slice, (i + 1) * slice)));
    cb({ status: "succeeded", value: { size: bytes.length, sliceCount: slices.length, getSliceAsync: vi.fn((i: number, c: (r: any) => void) => c({ status: "succeeded", value: { data: slices[i] } })), closeAsync: vi.fn() } });
  },
});
```

- [ ] **Step 2: Implement.** Promisify the callbacks (`status === "succeeded"` else reject with `r.error.message`). Default `sliceSize` = 4 MB (4_194_304; the Office.js maximum). Read slices sequentially, concatenate into one `Uint8Array`, `blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })`, sha256 hex via `crypto.subtle.digest("SHA-256", bytes)`. Always `closeAsync()` in `finally`.

- [ ] **Step 3: Run to pass.** Commit (only if asked).

---

### Task 6: Pane shell, sponsor picker, progress (sketch steps 1-2)

**Files:** Create `src/ui/Pane.tsx`, `SponsorPicker.tsx`, `Progress.tsx`, `ErrorBanner.tsx`, `styles.css`; modify `src/app.tsx`; tests `tests/ui/pane.test.tsx`.

**Interfaces:**
- Consumes: `createClient`, `createAuth`, `createRunStore`, `readWorkbook`, `hostFromOffice`, `config`.
- Produces: `<Pane client store readFile />` with props `{ client: Client; store: RunStore; readFile: () => Promise<WorkbookFile> }` (injected for tests); `<SponsorPicker sponsors value onChange />`; `<Progress state: RunState />`; `<ErrorBanner message requestId? />`. Test ids: `sponsor-select`, `onboard-button`, `consent-note`, `progress`, `error-banner`.

- [ ] **Step 1: Failing tests** `tests/ui/pane.test.tsx`: (a) shows sponsors from `client.sponsors()` and the onboard button is disabled until one is chosen; (b) the consent note names the chosen sponsor and the API host ("The whole workbook will be sent to <host> and filed under <sponsor>"); (c) clicking onboard calls `readFile`, then `client.startRun(sponsor, blob, name)`, then `store.start(run_id)`; (d) after upload, `snap.upload.sha256 !== file.sha256` shows "Upload verification failed" and stops; (e) a `WorkbookError("unsaved")` message is shown in the error banner and no `startRun` call happens; (f) an `ApiError` 422 from `startRun` shows the server message verbatim.
- [ ] **Step 2: Implement.** `Pane` holds `sponsors`, `sponsorId`, `uploading`, `localError`. On success it calls `store.start(run_id)`; the sha check compares `file.sha256` with `store.get().snap?.upload.sha256` after the first refresh (await `store.refresh()` once; if the server snapshot lacks a sha, skip the check). `Progress` renders `state.connection`, `snap.phase`, `snap.status`, the last activity lines and a spinner while `busy`. All text via JSX (no `innerHTML`).
- [ ] **Step 3: Wire `app.tsx`:** create auth (`await createAuth()`), `createClient({ baseUrl: config.apiBase, auth })`, `createRunStore(client)`, call `client.health()` once and show an incompatibility banner only if `version` is present and its major differs from `SUPPORTED_API_MAJOR = 0` (a constant in `config.ts`); a missing `version` is tolerated.
- [ ] **Step 4: Run tests, then manual: `pnpm dev`, sideload `manifest.dev.xml` in Excel, start `uv run python -m tests.e2e.serve_scripted --port 8000` (add `https://localhost:3100` to `cors_origins` through `ONB_CORS_ORIGINS`, check `src/onboarding_agent/config.py` for the exact env name), pick `sponsor-a`, onboard `tests/fixtures/affiliate/clean.csv`-equivalent workbook (`renamed.xlsx`), confirm progress moves.** Expected: the pane shows phase changes and reaches the brief gate. Commit (only if asked).

---

### Task 7: Brief and question cards, gate answers (sketch step 3, UI half)

**Files:** Create `src/ui/BriefCard.tsx`, `src/ui/QuestionCard.tsx`, `tests/ui/cards.test.tsx`; modify `Pane.tsx`.

**Interfaces:**
- Consumes: `Brief`, `Question`, `RunStore.respond`, `canApprove`.
- Produces: `<BriefCard brief busy canApprove onApprove onColumn />`; `<QuestionCard question busy onAnswer(option) />`. Test ids `brief-card`, `question-card`, `approve-brief`.

- [ ] **Step 1: Failing tests:** brief card shows summary, bindings (field → column, confidence) and expected findings; each question renders its options as buttons and clicking posts `{ action: "answer", question_id, option }` via `onAnswer`; Approve is disabled when `canApprove` is false or `busy`; no gate action is posted on render (assert `respond` not called without a click).
- [ ] **Step 2: Implement** the two components and mount them in `Pane` when `pendingGate(snap) === "brief"`: questions come from `snap.brief.questions`. Approve posts `{ action: "approve" }`. Show `blockedReasons(snap)` under the button when present.
- [ ] **Step 3: Run to pass.** Commit (only if asked).

---

### Task 8: Range highlighting in the user's workbook (sketch step 3, Excel half)

**Files:** Create `src/office/highlight.ts`, `tests/office/highlight.test.ts`; modify `BriefCard.tsx`, `QuestionCard.tsx`, `Pane.tsx`.

**Interfaces:**
- Produces: `type ExcelRun = <T>(cb: (ctx: Excel.RequestContext) => Promise<T>) => Promise<T>`; `selectSheet(run, name)`, `selectHeaderRow(run, sheet, headerRow)`, `selectColumn(run, sheet, headerRow, headerText)`, `selectSourceCell(run, sheet, sourceRow, column?)`, `export const sourceRowOffset: (sheet: string) => number`.
- Consumes: Task 6 wiring (`Excel.run`).

- [ ] **Step 1: Failing tests** with a fake `ExcelRun` whose `ctx.workbook.worksheets.getItem(name)` returns an object recording `activate()`, `getRange(addr)`, `getUsedRange()`; assert: `selectSheet` activates the named sheet; `selectHeaderRow(…, 3)` selects `A3:<lastCol>3` using the used range's width; `selectColumn` finds the header cell whose trimmed text equals `headerText` in the header row and selects the full used column (`C1:C<lastRow>`); a missing header text selects nothing and returns `false`; a missing sheet returns `false` and does not throw. Test `selectSourceCell(run, "Sheet1", 7)` selects row 7 + `sourceRowOffset("Sheet1")` (default 0).
- [ ] **Step 2: Implement.** Use `worksheet.activate()` then `range.select()`; wrap everything in try/catch converting `ItemNotFound` to `false`. Column letters via a small `columnLetter(n)` helper (tested: 1→A, 26→Z, 27→AA).
- [ ] **Step 3: Wire:** when a question or brief renders, call `selectSheet(snap.layout.sheet)` and `selectHeaderRow(sheet, snap.layout.header_row)` once per change of `(sheet, header_row)`; hovering/focusing a binding calls `selectColumn`. If the user clicks a different column in Excel, the pane's "Use selected column" button reads `ctx.workbook.getSelectedRange()`, resolves the header text in the header row, and posts a `change` gate with `set_column_binding {field, column: headerText}` (never auto-sent from a selection event).
- [ ] **Step 4: Source-row offset check.** In the contract test (Task 12) and manually with `titled.xlsx`, compare `GET /grid?view=source` row N with the Excel sheet's row N. If they differ, set `sourceRowOffset` from the first non-empty row of the used range (`getUsedRange().rowIndex`) and add a test. Record the result in the README.
- [ ] **Step 5: Run to pass.** Commit (only if asked).

---

### Task 9: Review sheet render and ITEM_ID edit loop (sketch step 4)

**Files:** Create `src/office/review.ts`, `src/ui/ReviewPanel.tsx`, `tests/office/review.test.ts`, `tests/ui/review-panel.test.tsx`.

**Interfaces:**
- Consumes: `PreviewGrid`, `GridRow`, `Client.dryRun`, `Impact`, `RunStore.respond`, `ExcelRun`.
- Produces:
  - `REVIEW_SHEET = "Onboarding Review"` (renamed during review; owned via the `OnboardingReviewOwner` sheet name, see spec §4); `REVIEW_COLUMNS = ["Row","ITEM_ID","NAME","ITEM_TYPE","DESCRIPTION","DONOTIMPORT","ID method","Flags","Source sheet","Source row"]`.
  - `renderReview(run: ExcelRun, rows: GridRow[]): Promise<void>`: create/clear the sheet, write header + rows as text values (set number format `@` on all cells so no value is interpreted as a formula or number), freeze the header row, protect the sheet leaving only the ITEM_ID column unlocked (`worksheet.protection.protect({ allowFormatColumns: true, allowSort: false })` after unlocking `B2:B<n>`).
  - `watchReview(run, onEdit: (e: { row: number; value: string }) => void): Promise<() => Promise<void>>`: registers `worksheet.onChanged`; for each change inside `B2:B<n>` call `onEdit({ row: <Row cell value>, value })` and **revert** the cell to the last rendered value; changes outside the ITEM_ID column are reverted with no `onEdit`; changes after the sheet was deleted are ignored without throwing. Returns an unregister function.
  - `<ReviewPanel client runId store rows />`: shows impact and violations for the pending edit with `Apply` (posts `{ action: "change", changes: [{ kind: "override_item_id", row, value }] }`) and `Discard`.

- [ ] **Step 1: Failing review tests** (fake `ExcelRun` that records writes): rendered values are strings (a source value `=SUM(A1)` is written with number format `@` and the value `=SUM(A1)` kept as literal text, assert the format call precedes the values call); rows written equal grid rows in `REVIEW_COLUMNS` order, flags joined with `, `; only the ITEM_ID column is unlocked; `watchReview`: an edit in ITEM_ID calls `onEdit` once and writes the old value back; an edit in NAME writes the old value back and never calls `onEdit`; a paste over several cells reverts each and calls `onEdit` only for ITEM_ID cells; `onChanged` after the sheet is deleted does not throw.
- [ ] **Step 2: Failing panel tests:** an edit triggers `client.dryRun(runId, [{ kind: "override_item_id", row, value }])` and renders `violations` verbatim and `rows_changed`; Apply is disabled while `violations.length > 0`; Apply posts exactly one `change` gate then calls `store.refresh` and the panel clears; Discard posts nothing; a `dryRun` `ApiError` 409 shows the message and leaves the sheet unchanged; two rapid edits: the later dry-run result wins (earlier response arriving late is ignored).
- [ ] **Step 3: Implement** both. After a successful Apply the pane re-renders the sheet from `store.get().grid` (server is the source), calling `renderReview` again; the same re-render runs on every `grid` change, so a deleted Review sheet is recreated on the next refresh.
- [ ] **Step 4: Run to pass.** Manual: edit an ITEM_ID cell in Excel on a `findings` gate run; the cell snaps back, the pane shows impact. Commit (only if asked).

---

### Task 10: Findings, acknowledge, exclude (sketch step 4, buttons)

**Files:** Create `src/ui/FindingsList.tsx`, `tests/ui/findings.test.tsx`; modify `Pane.tsx`.

**Interfaces:**
- Consumes: `Finding[]` (`snap.result.findings`), `store.respond`, `selectSourceCell`.
- Produces: `<FindingsList findings busy onAck(f) onExclude(f, reason) onJump(f) />`. Test ids `findings-list`, `ack-<code>-<row>`, `exclude-<row>`.

- [ ] **Step 1: Failing tests:** errors are listed before warnings and show `message`, row and source row; "Acknowledge" appears only when `requires_ack && !acknowledged` and posts `{ action: "change", changes: [{ kind: "acknowledge_finding", code, row }] }`; "Exclude row" asks for a reason (non-empty required) and posts `exclude_row {row, reason}`; clicking the source-row link calls `onJump` with `{ sheet: snap.layout.sheet, sourceRow }` and also selects the matching Review-sheet row; buttons are disabled while `busy`; an already-acknowledged finding shows "Acknowledged" and no button.
- [ ] **Step 2: Implement; run to pass.** Commit (only if asked).

---

### Task 11: Sign-off and download (sketch step 5)

**Files:** Create `src/ui/SignOff.tsx`, `src/office/download.ts`, `tests/ui/signoff.test.tsx`, `tests/office/download.test.ts`; modify `Pane.tsx`.

**Interfaces:**
- Produces: `<SignOff snap busy onApprove artifacts onDownload />` (test ids `signoff-approve`, `download-<name>`); `downloadArtifact(client, runId, name, deps: { saveBlob(blob, name): Promise<void>; openDialog(url): Promise<void> }): Promise<"saved" | "dialog">`.

- [ ] **Step 1: Failing tests:** Sign-off is disabled when `canApprove` is false and shows `blocked_reasons` verbatim; enabled button posts exactly `{ action: "approve" }`; the artifact list comes from `snap.pending?.artifacts` and `snap.artifacts` (read `Snapshot` for the exact field; only `Affiliates.csv` and `manifest.json` appear after the `artifact` event); `downloadArtifact` first tries `saveBlob` (anchor download); if it throws or the host reports downloads unsupported it falls back to `openDialog` with a blob URL via `Office.context.ui.displayDialogAsync`, returning `"dialog"`; the filename is `Path(name).name`-safe (no path separators).
- [ ] **Step 2: Implement; run to pass.**
- [ ] **Step 3: Manual spike (record the outcome in README "Known platform behavior"):** download on Excel desktop Windows, Mac and Excel web. If anchor download fails in desktop, keep the dialog fallback as default for that host (`Office.context.platform`). Commit (only if asked).

---

### Task 12: Contract test against the scripted API

**Files:** Create `tests/contract/globalSetup.ts`, `tests/contract/contract.test.ts`, `vitest.contract.config.ts`; modify `package.json` (`"test:contract": "vitest run -c vitest.contract.config.ts"`).

**Interfaces:**
- Consumes: the real `createClient`, `createRunStore`, `streamEvents` against `uv run python -m tests.e2e.serve_scripted --port 8765` (run from the repo root; Node `fetch`, so no CORS involved).

- [ ] **Step 1: `globalSetup.ts`:** spawn `uv run python -m tests.e2e.serve_scripted --port 8765` with `cwd` = repo root (`path.resolve(__dirname, "../../..")`), wait until `GET /health` returns 200 (poll up to 30 s), kill the process on teardown.
- [ ] **Step 2: Write the contract test** reading `web/e2e/workbench.spec.ts` for the exact answer sequence per fixture, and `tests/fixtures/affiliate/*.xlsx` for files. Cases: (1) `renamed.xlsx` with `sponsor-a`: start → store reaches `pending.gate === "brief"` → respond approve → reaches `findings` gate → approve → `signoff` → approve → `artifact` list contains `Affiliates.csv`, and the downloaded blob text starts with the `ITEM_ID,NAME,ITEM_TYPE,DESCRIPTION,DONOTIMPORT` header; (2) `titled.xlsx` with `sponsor-b`: `GET /grid?view=source` rows plus the workbook read with the `xlsx`-free approach: assert `source.header_row` and `source.rows[header_row-1].cells` match the title/offset noted in Task 8 Step 4 (this pins the source-row offset); (3) a gate posted while the run is working returns `ApiError` 409 and the store keeps consistent state; (4) kill the SSE stream mid-run (abort the response) and confirm the store reconnects and the final state still arrives.
- [ ] **Step 3: Run:** `pnpm test:contract` → all pass. If an expected event never arrives within 30 s, print `store.get().activity` and the last snapshot in the failure message. Commit (only if asked).

---

### Task 13: Production hardening, hosting config, docs

**Files:** Create `manifest.template.xml`, `scripts/build-manifest.mjs`, `scripts/check-bundle.mjs`, `staticwebapp.config.json`, `CHANGELOG.md`, `README.md`; modify `package.json`, repo `CLAUDE.md` (Commands block: add `cd excel_plugin && pnpm check`, `pnpm test:contract`, `pnpm dev`).

**Interfaces:**
- Produces: `pnpm manifest` writes `manifest.prod.xml` from env `ADDIN_HOST` (https origin), `ADDIN_ID` (GUID), `ADDIN_VERSION` (semver; defaults to `package.json` version); fails if any is missing or the host is not `https://`.

- [ ] **Step 1: Failing tests** `tests/build/manifest.test.ts`: export `buildManifest(template: string, env: Record<string,string>): string` from `scripts/build-manifest.mjs` (ESM, importable) — fills `{{HOST}}`, `{{ID}}`, `{{VERSION}}`; throws on non-https host, a non-GUID id, or a version not matching `^\d+\.\d+\.\d+\.\d+$` (Office needs four parts; map `0.1.0` → `0.1.0.0`); the output contains no `localhost`.
- [ ] **Step 2: Implement manifest build and bundle check.** `check-bundle.mjs` fails the build if `dist/` contains the string `X-Actor`, `devAuth` or `localhost:`, or if any JS asset exceeds 250 KB gzipped (size budget), or any `.map` file exists.
- [ ] **Step 3: `staticwebapp.config.json`:**
```json
{
  "globalHeaders": {
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://appsforoffice.microsoft.com; style-src 'self'; img-src 'self' data:; connect-src 'self' https://API_HOST_PLACEHOLDER; frame-ancestors https://*.officeapps.live.com https://*.office.com https://*.office365.com; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store"
  },
  "navigationFallback": { "rewrite": "/index.html" }
}
```
`API_HOST_PLACEHOLDER` is replaced by `scripts/build-manifest.mjs --swa` from env `API_ORIGIN`; the script fails if the placeholder survives. (Test it in `manifest.test.ts`.)
- [ ] **Step 3b: Office.js script and SRI (deliberate).** `index.html` loads `https://appsforoffice.microsoft.com/lib/1/hosted/office.js` without a Subresource Integrity hash. Microsoft serves that file unversioned and updates it in place (and requires add-ins to load it from that CDN), so a pinned hash would break the add-in whenever Microsoft ships a change. Compensating controls: the CSP above allows scripts only from `'self'` and that one origin, and the README records this decision. Add a test in `tests/build/manifest.test.ts` asserting `index.html` has exactly one external script and it is that URL.
- [ ] **Step 4: Compat check, accessibility pass, logging rule.** Add a test that no `console.*` call receives snapshot or grid data (ESLint `no-console` set to `error` except `console.warn` in `src/main.tsx`); a keyboard test that every card button is reachable with Tab and has an accessible name; the production CSS must not rely on colour alone for error vs warning (icon + text).
- [ ] **Step 5: README** sections: what it is; prerequisites; dev setup (backend scripted, `ONB_CORS_ORIGINS` includes `https://localhost:3100`, `pnpm dev`, sideload steps for Windows/Mac/web); config table (`VITE_API_BASE`, `VITE_AUTH`, `VITE_DEV_ACTOR`, `VITE_MAX_UPLOAD_BYTES`); production deploy (Entra app registration with `access_as_user` scope and the Office client IDs pre-authorized, API behind Easy Auth with `trust_easy_auth` on, CORS allow-list, SWA deploy, `pnpm manifest`, centralized deployment in the M365 admin center); privacy and egress statement (whole workbook goes to the API, nothing to third parties, no analytics); manual checklist (download spike, 5 MB web payload limit, `titled.xlsx` highlight offset, SSE on corporate proxy, unsaved workbook); known platform behavior. `CHANGELOG.md` starts at 0.1.0.
- [ ] **Step 6: Final verification:** `cd excel_plugin && pnpm check && pnpm test:contract && pnpm vitest run --coverage` (thresholds in `vitest.config.ts` pass), `ADDIN_HOST=https://example.invalid ADDIN_ID=<guid> pnpm manifest && npx office-addin-manifest validate manifest.prod.xml`, and `VITE_AUTH=entra pnpm build` succeeds while `pnpm build` with default env fails with the guard message. Repo-level: `uv run pytest -q` still passes (no backend change). Commit (only if asked).

---

## Self-Review

**Spec coverage:** §3 layout → File Structure and Tasks 1-13. §4 flow steps 1-6 → Tasks 6 (1-2), 7-8 (3), 9-10 (4/5), 11 (6). §5 invariants → Global Constraints and Tasks 7, 9, 10, 11 tests (no-post-on-render, revert non-ITEM_ID, buttons only). §6 errors → Tasks 3 (reconnect), 5 (size/unsaved), 6 (422 verbatim), 11 (download fallback), egress notice Task 6(b). §7 config → Task 13 README + Task 6 manual. §8 testing → each task plus Task 12; mandatory negative tests in Tasks 7, 9, 11. §10 production readiness → Tasks 2 (auth guard, bearer), 13 (manifest, CSP, bundle/size, a11y, versioning/compat, docs), CI gates via `pnpm check`. §11 Phase 2 → intentionally excluded, needs its own spec/plan.

**Spec deviation to confirm:** the spec says sign-off enables from the "latest `gate` event"; the plan uses `snapshot.pending` (refreshed on every `gate` event), which carries the same `allowed_actions`/`blocked_reasons` and survives reconnects. The spec's API-version check (§10) assumes `/health` returns a version; today it returns only `{status}`, so the plan tolerates a missing version and does not change the backend.

**Placeholders:** the only deliberate substitution token is `API_HOST_PLACEHOLDER` in the SWA config, which a build step fills and a test asserts cannot survive.

**Type consistency:** `Client`, `RunStore`/`RunState`, `GateBody`, `ExcelRun`, `WorkbookFile`, `canApprove(snap, busy)` are defined once (Tasks 2, 4, 5, 8) and used with the same signatures later.
