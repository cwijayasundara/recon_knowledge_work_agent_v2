# Onboarding workbench for Excel

An Office task-pane add-in (Preact, Vite, TypeScript) that drives the onboarding API from inside Excel. The analyst picks a sponsor, the add-in uploads the open workbook, streams the run, shows the brief, questions and findings, highlights the source cells in the sheet, renders an "Onboarding Review" sheet, and offers the sign-off step and the Intacct import files. Accounting rules, gates and file rendering stay in the API; this add-in only proposes actions and displays results. The plan and specs are in `docs/superpowers/` in the repo root. The run chat ("Ask the agent", stage 1) is described under Chat below. The live-sheet **Copilot** (stage 2) is described under Copilot (stage 2); it is off unless the server turns it on (`ONB_COPILOT_ENABLED=true`).

## Prerequisites

- Node 22+ and pnpm 10.
- Excel (Microsoft 365) on Windows, Mac or the web, with ExcelApi 1.9 (Review sheet change tracking) and, for desktop downloads, OpenBrowserWindowApi 1.1.
- For the dev backend and the contract test: `uv` and the `string_matcher_v1` checkout (`STRING_MATCHER_PATH`, default `../../advance_research/string_matcher_v1`).

## Dev setup

1. Start the backend with the scripted agent (no live model) from the repo root. Allow the add-in origin for CORS (the env var is `ONB_CORS_ORIGINS`, a comma-separated list):

   ```bash
   ONB_CORS_ORIGINS=http://localhost:3000,https://localhost:3100 \
     uv run python -m tests.e2e.serve_scripted --port 8000
   ```

   If imports fail outside pytest on macOS (hidden editable `.pth` files), add
   `PYTHONPATH=src:packages/onboarding_sdk:../../advance_research/string_matcher_v1/src`.
2. `cd excel_plugin && pnpm install && pnpm dev` serves the pane at `https://localhost:3100`. Dev builds use dev auth (`X-Actor: <VITE_DEV_ACTOR>`) against `http://localhost:8000`. `vite.config.ts` adds, in dev only:
   - **Certificates:** if `~/.office-addin-dev-certs/localhost.key` and `localhost.crt` exist (run `npx office-addin-dev-certs install` once), the dev server uses them, and desktop Excel's web view trusts them. Otherwise it falls back to Vite's self-signed certificate (open the URL once and trust it; desktop Excel may refuse it).
   - **`/api` proxy:** `https://localhost:3100/api/...` is forwarded to `DEV_API_TARGET` (default `http://localhost:8000`) with the `/api` prefix removed. Set `VITE_API_BASE=https://localhost:3100/api` to call the API same-origin over https, with no mixed content and no CORS.
3. Sideload `manifest.dev.xml`:
   - Windows: put the manifest in a folder, share it, add the share path under File > Options > Trust Center > Trusted Add-in Catalogs (tick "Show in Menu"), restart Excel, then Insert > My Add-ins > Shared Folder.
   - Mac: copy `manifest.dev.xml` to `~/Library/Containers/com.microsoft.Excel/Data/Documents/wef/`, restart Excel, then Insert > My Add-ins > Developer Add-ins.
   - Excel on the web: Insert > Add-ins > More Add-ins > Manage My Add-ins > Upload My Add-in, choose `manifest.dev.xml`.
   The Home tab then shows "Open pane".

## Configuration

Build-time variables (Vite `VITE_*`, set in the environment or `.env`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_API_BASE` | `http://localhost:8000` in dev | API origin. Production builds fail unless it is an `https://` origin (no path); the pane also shows a configuration error at runtime if it is empty or not http(s). It feeds the consent note; the same origin goes into the CSP via `API_ORIGIN`. |
| `VITE_AUTH` | `dev` | `dev` sends `X-Actor`; `entra` obtains an Office SSO bearer token. A production build refuses anything but `entra`. |
| `VITE_DEV_ACTOR` | `analyst` | Actor name sent by dev auth. Ignored with `entra`. |
| `VITE_MAX_UPLOAD_BYTES` | `26214400` (25 MB) | Client-side workbook size cap. Excel on the web additionally limits a payload to about 5 MB. |

Timeouts are named constants in the code (each can be overridden where noted, which the tests use), not build variables:

| Constant | Value | Where | Meaning |
| --- | --- | --- | --- |
| `AUTH_TIMEOUT_MS` | 180 s | `src/api/client.ts` (`authTimeoutMs`) | Obtaining the access token, counted on its own before the request bound: Office SSO may show sign-in, consent or MFA. Fails with "Sign-in did not complete. Reopen the pane or retry." |
| `REQUEST_TIMEOUT_MS` | 30 s | `src/api/client.ts` (`requestTimeoutMs`) | Each JSON request, from the fetch through the body read. Fails with "Request timed out after N s" and the request id. |
| `DOWNLOAD_TIMEOUT_MS` | 120 s | `src/api/client.ts` (`downloadTimeoutMs`) | An artifact download. |
| `UPLOAD_TIMEOUT_MS` | 300 s | `src/api/client.ts` (`uploadTimeoutMs`) | The workbook upload (`POST /runs`). |
| `COPILOT_STEP_TIMEOUT_MS` | 120 s | `src/api/client.ts` (`copilotStepTimeoutMs`) | One copilot step (`POST /copilot/sessions/{id}/step`), which waits for a model call. Session start and close use `REQUEST_TIMEOUT_MS`. |
| `DEFAULT_TURN_TIMEOUT_MS` | 5 min | `src/copilot/session.ts` (`turnTimeoutMs`) | One copilot turn (a user message through its final answer, including every tool round and Excel call). Then the turn is stopped with "The copilot took too long on this message and was stopped." |
| `CLOSE_RETRY_WAITS_S` | 2, 5, 15, 30, 60 s | `src/copilot/session.ts` | Retire retry backoff: closing a copilot session (`DELETE`) while its step still runs gets 409, so the pane retries in the background on this schedule (a page unload ends the retries; the server's TTL is the backstop). |
| `BUSY_RETRIES` / `MAX_BUSY_WAIT_S` | 2 retries, wait clamped to 1-60 s | `src/copilot/session.ts` | A step refused as busy (503 with `Retry-After`) is retried at most twice after the server's `Retry-After`; a 503 without that header is not retried. |
| `STEP_RUNNING_WAITS_S` | 2, 5 s | `src/copilot/session.ts` | A user message that gets 409 because the session's previous step still runs is retried after these waits, then reports "The copilot is still finishing the previous request." |
| `HEALTH_TIMEOUT_MS` | 4 s | `src/app.tsx` | The advisory `/health` check before the pane mounts. |
| `GATE_SETTLE_TIMEOUT_MS` | 30 s | `src/state/store.ts` (`settleTimeoutMs`) | After an accepted gate post, the stream silence (no event for the run) after which the hold is re-checked: with the stream connected the job is still running and the hold continues ("Still working…"); with the stream down or reconnecting the gate actions come back with "Status may be out of date — refresh." Every event restarts it. |
| `SETTLE_HARD_CAP_MS` | 10 min | `src/state/store.ts` (`settleHardCapMs`) | Longest a gate post holds the gate actions, even with the stream connected; then they come back with the stale note. |
| `VERDICT_TIMEOUT_MS` | 30 s | `src/state/verdict.ts` (`verdictTimeoutMs` prop) | How long an accepted Apply waits for its verdict before "Verdict unknown". |
| `APPLY_HOLD_MAX_MS` | 60 s | `src/state/verdict.ts` (`applyHoldMaxMs` prop) | Longest an Apply keeps Onboard disabled. |
| `EXCEL_OP_TIMEOUT_MS` | 20 s | `src/office/highlight.ts` (`excelOpTimeoutMs` prop) | Longest Onboard waits for the Review sheet removal, and Apply for its re-render, before "Excel is busy (finish editing the cell), then try again." |

Manifest and hosting variables (used by the scripts, not the bundle): `ADDIN_HOST`, `ADDIN_ID`, `ADDIN_VERSION`, `ADDIN_CLIENT_ID`, `ADDIN_API_RESOURCE`, `API_ORIGIN`.

API compatibility: on start the add-in reads `/health` before it mounts the pane. If the response has a `version` whose major differs from `SUPPORTED_API_MAJOR` (`src/config.ts`, currently 0), the pane is not mounted and only an incompatibility message is shown, so nothing can be uploaded. A `/health` without `version` (today's API returns only `{status}`), or a failed `/health`, is tolerated and the pane mounts.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server on `https://localhost:3100` with dev auth. |
| `pnpm check` | typecheck, lint, tests, and a production build (`VITE_AUTH=entra`, placeholder API origin unless `VITE_API_BASE` is set) with the bundle check. The pre-merge gate. That build goes to a temporary directory that is deleted afterwards; it never touches `dist/`. |
| `pnpm build` | `tsc`, `vite build`, bundle check. Requires `VITE_AUTH=entra` and an https `VITE_API_BASE`; otherwise it fails with "Production builds must set VITE_AUTH=entra" or "... must set VITE_API_BASE". `pnpm check` supplies a placeholder API origin for its build. |
| `pnpm test` / `pnpm vitest run --coverage` | Offline unit and UI tests; coverage thresholds in `vitest.config.ts`. |
| `pnpm test:contract` | Contract test against the real scripted API, with two servers: copilot on and copilot off (see Testing). Needs `uv` and `STRING_MATCHER_PATH`. The full output is also written to `.contract-last.log`, and a failing run is copied to `.contract-fail-<timestamp>.log` (both git-ignored), so a one-off failure is kept with its diagnostics (idle counters, last decisions, gate message, activity and the SSE event log). `pnpm test:contract:raw` runs vitest directly. |
| `pnpm audit` | `pnpm audit --prod --audit-level high`: fails on high or critical advisories in runtime dependencies (needs network). |
| `pnpm manifest:validate` | Builds the production manifest from placeholder values (or the `ADDIN_*` variables when set) into a temporary file and runs `office-addin-manifest validate` on it (the validator may call Microsoft's online service). Does not write `manifest.prod.xml`. |
| `pnpm manifest` | Writes `manifest.prod.xml` from `manifest.template.xml` (needs `ADDIN_HOST`, `ADDIN_ID`, `ADDIN_CLIENT_ID`, `ADDIN_API_RESOURCE`). |
| `pnpm manifest:swa` | Reads `staticwebapp.config.template.json` and writes the deployable `dist/staticwebapp.config.json` (git-ignored) with the API origin filled in. |
| `pnpm icons` | Regenerates the placeholder icons in `public/assets/` (deterministic). Replace them with brand art before a public rollout. |

The bundle check (`scripts/check-bundle.mjs [dir]`, default `dist/`) fails the build if the output contains `X-Actor`, `devAuth` or `localhost:`, any `.map` file, or a script over 250 KB gzipped.

## Production deploy

1. Entra app registration (see Microsoft's guide, [Register an Office Add-in that uses legacy Office SSO](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/register-sso-add-in-aad-v2)):
   - Use a custom domain your tenant owns for the add-in host. The default `*.azurestaticapps.net` domain cannot be used in an Application ID URI; add a custom domain to the Static Web App.
   - Expose an API: Application ID URI `api://<addin-host>/<client-id>` (same host as in the manifest URLs) and a scope named `access_as_user`.
   - Pre-authorize the single Microsoft Office client ID `ea5a67f6-b6f3-4338-b240-c655ddc3cc8e` for `access_as_user` (per the guide above it covers all Office endpoints). Add Teams client IDs only if you run the add-in inside Teams.
   - In the app manifest set `requestedAccessTokenVersion` to `2` (in the `api` object).
   - Grant `profile` and `openid` (the manifest lists these two; `access_as_user` is the exposed scope, not a manifest entry).
2. API: deploy behind Container Apps Easy Auth (Entra) with `ONB_TRUST_EASY_AUTH=true`, so the API requires and records the signed-in name. Configure Easy Auth's allowed token audiences to include the add-in's Application ID URI `api://<addin-host>/<client-id>` (otherwise tokens obtained by the add-in are rejected). Set `ONB_CORS_ORIGINS` to the exact add-in origin (`https://<addin-host>`). `ONB_API_TOKEN` is a different, shared-secret mode and is not used with Entra.
3. Build and host: run the real build into `dist/` with the real API origin, `VITE_AUTH=entra VITE_API_BASE=https://<api-host> pnpm build` (not `pnpm check`, which builds a throwaway bundle elsewhere), then `API_ORIGIN=https://<api-host> pnpm manifest:swa`, then deploy `dist/` (which now contains the generated `staticwebapp.config.json` with the CSP and security headers) to Azure Static Web Apps. The repo file `staticwebapp.config.template.json` holds the placeholder `API_HOST_PLACEHOLDER` and is never deployed; the script fails if the placeholder survives.
4. Manifest: `ADDIN_HOST=https://<addin-host> ADDIN_ID=<new GUID> ADDIN_CLIENT_ID=<app client id> ADDIN_API_RESOURCE=api://<addin-host>/<client-id> pnpm manifest` writes `manifest.prod.xml` (it fails if the resource does not start with `api://<addin-host>/<client-id>`), then `npx office-addin-manifest validate manifest.prod.xml`. `ADDIN_VERSION` must be four-part and at least `1.0.0.0` (the validator rejects 0.x). When absent it is derived from `package.json`: `0.<minor>.<patch>` becomes `1.<minor>.<patch>.0`, so package versions `0.1.0` and `1.1.0` both derive `1.1.0.0`. Set `ADDIN_VERSION` explicitly for releases and bump it for every re-upload.
5. Distribute through centralized deployment: Microsoft 365 admin center > Settings > Integrated apps > Upload custom apps > Office Add-in, upload `manifest.prod.xml`, assign users or groups.

## Privacy and egress

- The whole workbook, not only the selected sheet, is sent to the configured API (`VITE_API_BASE`). The pane states the host and sponsor before the first upload.
- Nothing is sent to any third party. The only external load is `office.js` from Microsoft's CDN; there is no analytics, telemetry or tracking.
- Workbook content and run snapshots are never logged: ESLint's `no-console` rule is an error everywhere in `src`; the one exception is that `src/main.tsx` may call `console.warn` (it currently has no console calls). `tests/buildcheck/logging.test.ts` enforces both.
- Before each upload ("Onboard this workbook" or "Onboard again") the add-in deletes its own "Onboarding Review" sheet, a rendering of the previous run, so the agent never maps the add-in's output. If that sheet cannot be deleted the upload is blocked with a message; if Excel does not run the deletion within 20 s (it defers API calls while a cell is being edited) the pane says "Excel is busy (finish editing the cell), then try again." and a deletion that only starts later is skipped. Onboard is disabled while an Apply is in flight, for at most 60 s; then the pane says "Apply is taking long; you can start a new upload." Every API request except the event stream times out (30 s; downloads 120 s, the upload 300 s) with "Request timed out after N s" and its request id; the bound starts after the access token is obtained, which has its own 180 s bound (see the timeouts table). If the upload fails before the new run exists, or the server copy does not match the workbook, the pane goes back to the previous run (it still exists on the server) and re-renders its sheet.
- The access token stays in memory and is never placed in a URL.
- The Copilot (off unless the server enables it) sends the cells it reads, up to the server's caps, to the server's AI model; see Copilot (stage 2) > Privacy.

## Security decisions

- `office.js` is loaded from `https://officeapis.public.onecdn.static.microsoft/1/office.js` without a Subresource Integrity hash, on purpose. Microsoft serves that file unversioned, updates it in place and requires add-ins to load it from its CDN, so a pinned hash would break the add-in whenever Microsoft ships a change. A security hook or scanner may warn about the missing `integrity` attribute; that warning is expected. Compensating controls: the CSP allows scripts only from `'self'` and that one origin (no `unsafe-eval`), `connect-src` is limited to `'self'` plus the API origin, and there are no inline scripts or styles. `tests/buildcheck/manifest.test.ts` asserts `index.html` has exactly one external script and that it is this URL.
- Endpoint choice: Microsoft's page "Referencing the Office JavaScript API library" (checked 2026-10-03, updated 2026-09-23) shows `https://officeapis.public.onecdn.static.microsoft/1/office.js` as the reference and, under "Update legacy CDN endpoints", says the older `https://appsforoffice.microsoft.com/lib/1/hosted/office.js` should be switched to it: "The new endpoint serves the same current Office.js release, but it enables additional secure defaults." Caveats it lists, all checked for this add-in: Office.js no longer auto-loads Microsoft Ajax (this add-in does not use it, so `ajax.aspnetcdn.com` is not in the CSP); `ExecuteFunction` commands need `Office.actions.associate` (this add-in has none); restrictive CSP/Trusted Types must permit the new endpoint (it is in `script-src`; no Trusted Types policy is enforced); `*.static.microsoft` must be on network allow lists. The legacy URL is not referenced anywhere; to fall back, change `index.html` and `script-src` together.
- No dev auth code ships: production builds refuse `VITE_AUTH` other than `entra`, and the bundle check scans `dist/`.

## Review sheet

The add-in renders the server's preview grid into a protected sheet named "Onboarding Review" and marks it as its own with a worksheet-scoped defined name, `OnboardingReviewOwner` (ExcelApi 1.4). The marker is saved with the workbook, so ownership survives reloading the pane or reopening the file, and it is deleted with the sheet. If a sheet with that name exists without the marker, it belongs to the user: the add-in never clears, writes, reverts or deletes it, and the pane says "A sheet named 'Onboarding Review' already exists and wasn't created by this add-in; rename it." The add-in's own sheet is deleted before every upload (see Privacy and egress).

Acknowledge, Exclude row and Apply are available only while the run waits at the findings gate and that gate allows changes; elsewhere (including a re-entered brief gate that still shows the last findings) the pane says so. `POST /gate` answers 202 before the run checks a change, so Apply reads its verdict from the run: the `findings.change` decision carrying that row and value, once the run has settled, read only from a snapshot fetched after an `idle` event that arrived after that Apply's own `decision` event (a snapshot taken while the job ends can mix the old gate with the new decision, and an earlier `idle` may be the previous job's). A refusal is shown with the server's message and the edit comes back for another try; if no verdict arrives within 30 s the pane says "Verdict unknown — check the findings gate" and shows the server's grid again.

## Brief card

The agent maps the sheet before the analyst sees it, so the brief card leads with the decision: the one-line summary, then **Approve brief** (the card's only primary button; it stays disabled, with the server's blocked reasons listed under it, until the server allows approval). Open questions follow under "Needs your input", since they block approval. The mapping is shown as plain lines (`Affiliate ID ← column "Affiliate ID" · 92%`; the confidence appears only when the agent reported one), followed by the sheet, header row, rows read and emitted, and any dropped rows with their reasons.

Overrides sit in a collapsed **Change mapping** disclosure. Per field it offers a column select, **Show in sheet** (selects that column in the workbook), **Use selected column** (reads the workbook selection at click time and refuses a multi-column selection, a blank header or a duplicated header) and **Apply change**. Picking a column or using the selection only stages it; nothing is posted until **Apply change**, which is enabled only when the staged column differs from the server's binding and posts one `set_column_binding`. While any change is staged, **Approve brief** is disabled, the "Change mapping" disclosure opens, and the card says "You have an unapplied mapping change. Apply it or discard it before approving." under the button, next to a **Discard change** button. Discard clears every staged pick and posts nothing. Approve comes back once nothing is staged, either after the server reports the applied binding or after a discard. The server's own approval rules and the busy hold still apply. A new binding from the server discards any staged choice. The agent's activity lines are in a collapsed **Activity** disclosure under the phase and status line.

## Gate actions

Approve, Answer, Apply change (column overrides), Acknowledge, Exclude row, Apply, the chat's Send (`instruct`) and a chat proposal's Apply are posted only from clicks (Ctrl/Cmd+Enter in the chat composer counts as Send). After a post the gate actions stay disabled until the pane has a snapshot read after the post's own `decision` event and the `idle` that followed it, so a card for a gate the run has already passed cannot be clicked and approve the next gate. A click while a post is held is refused without a request. A long job (a live model can take minutes) keeps the hold for as long as the event stream is connected; after 30 s without any event the pane says "Still working…". Only when the stream is down or reconnecting at that point, or after 10 minutes in any case, do the actions come back, with "Status may be out of date — refresh." and a Refresh button.

A gate post that times out may still have reached the server. The pane says "The request timed out and may have been received. Checking the run…", keeps the actions disabled and reads the run: if the post's decision is recorded, the gate moved on or a job is running, it carries on as accepted; otherwise it says "Not received — you can retry". If the run cannot be read either, it asks for a refresh before any retry.

## Chat (Ask the agent)

The **Chat** button in the pane header (shown while a run is open) expands or collapses the "Ask the agent" panel. Opening it moves focus to the composer; closing it returns focus to the button. Collapsing only hides the panel, so a pending reply and the conversation are kept. The conversation lives in memory for the current run and is cleared when another run starts (including "Onboard again", or a failed upload that restores the previous run). Nothing is stored and there are no new endpoints: an instruction is an `instruct` gate post, the same API the web workbench's composer uses.

- **Sending.** Type an instruction and click **Send** (Ctrl/Cmd+Enter does the same; Enter alone is a newline). Text is trimmed, empty text cannot be sent, and at most 2000 characters are sent (a counter shows the length). Send works only at a gate that takes instructions; otherwise the composer is disabled with "Chat is available at the brief and findings gates." It is also disabled while any gate action is held and while a reply is pending, so two gate posts never overlap. The composer is cleared only once the post is accepted; a refused post stays in the conversation marked "Not sent", with its text still in the composer and the error in the banner.
- **Replies.** `POST /gate` answers 202 before the agent runs, so the reply is read from the run with the same rule as Apply: from a snapshot fetched after an `idle` that followed this instruction's own `<gate>.instruct` decision ("Working…" shows meanwhile). At the findings gate the reply is the agent's restatement (or the server's message verbatim when the agent failed) and a **Change proposal** card: each typed change described, the impact (rows changed, flags removed, flags added) and any violations verbatim. At the brief gate an instruction re-scopes: the reply is "Updated the brief: …" with the new summary, the server's gate message, or "The agent re-read the file; the brief is unchanged." If no reply arrives within 30 s and the run is no longer held, the panel says "No reply yet — the agent may still be working; check the gate." (Send is then open again) and replaces that note if the reply comes later.
- **Applying.** A proposal changes nothing by itself. Its **Apply** button posts `change` with exactly the proposal's changes, and is enabled only for the latest reply, while the run still offers that same proposal (`snap.proposal`) at the findings gate with `change` allowed and nothing held, and only once. The card then shows "Applied.", "Not applied: <server message>" or "Verdict unknown — check the findings gate." A proposal with a sheet, header-row, column-binding or recipe-revision change says "Applying this re-scopes the run: you'll return to the brief gate." and, once sent, reports "Sent. The run is re-scoping — check the brief." instead of "Applied.".
- **What it cannot do.** The chat cannot approve or acknowledge: it has no approve control, and a proposal containing any acknowledgement is not applyable from the chat ("This proposal acknowledges warnings. Acknowledge warnings yourself in the Findings list."; its changes are still listed). Only an explicit Apply click posts a change. The agent sees the uploaded copy of the workbook (the server's), not the open sheet or later edits to it. The add-in makes no model calls and holds no keys.
- **Live agent.** Real conversation needs the backend running with a live model (`scripts/start-backend.sh`). The scripted backend (`serve_scripted`) answers deterministically: "exclude row N" proposes `exclude_row`, "non-inventory" proposes `set_item_type` Non-Inventory, anything else is declined ("'…' does not map to any Affiliate change."); at the brief gate it re-scopes to the same brief.

## Copilot (stage 2)

The **Copilot** is an Excel-aware assistant for the open workbook. It sits behind a second header button, **Copilot** (separate from the stage-1 **Chat**, which stays bound to the run's gates). It works with or without an onboarding run. Design: `docs/superpowers/specs/2026-10-04-excel-copilot-stage2-design.md`.

### What it can do

- **Read the workbook** through five Office.js tools that run in the pane: `list_sheets`, `describe_sheet` (used range, header guess, merged ranges, counts), `read_range` (values and formulas, capped), `find` (capped hits with addresses) and `get_selection`.
- **Read the active run** (when one is open) through read-only server tools: `run_state`, `run_findings` and `check_changes` (a dry run of typed changes through the SDK).
- **Propose**, never apply: typed changes (the same changes as the stage-1 chat, minus `acknowledge_finding`) and write proposals (`propose_write`: values or formulas for a range).
- **Nothing is applied without an explicit click.** Write proposals show a before/after diff. The default target is a new sheet, "Copilot Scratch". Writing into an existing range needs a second confirmation. Formulas need a confirmation even on the scratch sheet (they run in your workbook). Typed changes go through the stage-1 proposal card (explicit Apply, the same hold and verdict logic).

### What it cannot do

- It never approves, acknowledges or passes a gate, and has no tool for it. Its change schema has no `acknowledge_finding` variant. There is no history, artifact, upload, network or shell tool.
- Its tools never read hidden or very-hidden sheets directly: they are left out of `list_sheets`, `describe_sheet` and `find`, and `read_range` of one is refused ("sheet is hidden; unhide it first"). A visible cell whose formula references a hidden sheet shows that sheet's value, and the Copilot can read it. **Hidden rows and filtered-out rows on a visible sheet ARE readable.**
- It cannot reach another workbook, charts, pivots or macros, and it does not keep a transcript across a server restart.

### Enabling it

The Copilot is off by default. Turn it on in the server (the pane has no setting and holds no key):

```bash
ONB_COPILOT_ENABLED=true scripts/start-backend.sh     # live model; OPENAI_API_KEY in .env
```

With the flag off, every `/copilot/...` route answers 403 and the pane shows "The copilot is turned off on this server." with a **Check again** button. The model role is `copilot`: `gpt-5.6-terra` locally (OpenAI), or the Azure OpenAI deployment; only OpenAI or Azure OpenAI models are used. Settings (all read with the `ONB_` prefix, from `src/onboarding_agent/config.py`; the caps are enforced by the server and sent to the pane as `limits`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `ONB_COPILOT_ENABLED` | `false` | Turns the Copilot routes on. |
| `ONB_COPILOT_MODEL` | `gpt-5.6-terra` | Model for the `copilot` role. |
| `ONB_COPILOT_EFFORT` | `medium` | Reasoning effort (`minimal`, `low`, `medium`, `high`). |
| `ONB_COPILOT_MAX_CELLS_PER_CALL` | `2000` | Cells one `read_range` may request or return (values and formulas grids are each held to it). |
| `ONB_COPILOT_MAX_CELLS_PER_SESSION` | `20000` | Read budget for a whole session (charged from actual result sizes). |
| `ONB_COPILOT_MAX_STEPS_PER_TURN` | `8` | Model calls per user message. The bound is the smaller of this and `ONB_MAX_MODEL_CALLS` (default 40). |
| `ONB_COPILOT_MAX_WRITE_CELLS` | `2000` | Cells one write proposal may contain. |
| `ONB_COPILOT_CELL_CHAR_LIMIT` | `500` | Characters of one cell kept in a result (longer text is truncated). |
| `ONB_COPILOT_SESSION_TTL_S` | `3600` | A session is dropped after this many idle seconds. |
| `ONB_COPILOT_MAX_SESSIONS_PER_ACTOR` | `5` | Open sessions per actor (429 beyond that). |
| `ONB_COPILOT_SESSION_MAX_LIFETIME_S` | `43200` | Hard lifetime of a session, however active. |
| `ONB_COPILOT_MAX_CONCURRENT_STEPS` | `8` | Model steps running at once per API process (503 with `Retry-After: 5` beyond that). |

`ONB_CORS_ORIGINS` must include the add-in origin (see Production deploy); the server exposes `Retry-After` to the pane.

### API

Same `Actor` authentication as the rest of the API. Request bodies must be `application/json`, at most 2 MiB.

| Route | Purpose |
| --- | --- |
| `POST /copilot/sessions` | Start a session (optional `run_id` binds the run-bound tools). Returns `session_id`, `limits`, `tools`, `run_bound`. |
| `POST /copilot/sessions/{id}/step` | One model step. Body: `{user_message}` or `{tool_results: [{call_id, ok, content}]}`. Returns `tool_calls` for the pane to run in Excel, or a `final` answer with `text`, `proposed_changes`, `proposed_writes` and `notes`. |
| `DELETE /copilot/sessions/{id}` | Close the session (204). |

Status codes: 403 the Copilot is disabled; 404 session not found or lost (also for another actor's session, and for an unknown `run_id` on start), after which the pane starts a new session; 409 conflict (a step is still running, or results for already-answered calls); 413 body too large; 415 not `application/json`; 422 invalid body (never a 500, and the error never echoes the input); 429 too many sessions for this actor; 503 busy (the per-process step limit) with `Retry-After`.

### Privacy

- The cells the Copilot reads (up to the caps above) are sent to the server's AI model. The pane says so before anything is typed: "The copilot sends the cells it reads (up to the server's caps) to the server's AI model. The copilot's tools never read hidden sheets directly; a visible cell whose formula references a hidden sheet shows that sheet's value."
- The server logs addresses, cell counts, byte counts and outcomes, never cell values, formulas or message text (a test scans captured logs for planted sentinels). The pane makes no console calls.
- Run state and findings returned to the model are compact and contain no raw file rows.
- The tools never read hidden and very-hidden sheets directly, but a visible cell whose formula references one shows its value, and that value can be read. Hidden rows and filtered rows on a visible sheet are read too, so neither is private from the Copilot.

### Safety design

- **Caps on the server.** Per-call and per-session cell budgets, per-cell character limit, steps per turn, at most 16 workbook calls per step and 6 dry runs per turn are enforced by the server; the pane cannot loosen them and prompt text cannot either. Tool results must have the exact fixed shapes (anything else is refused) and are checked for size before they are stored.
- **Untrusted data.** Tool results are wrapped as data (`<tool_result untrusted>`, with `<`, `>` and `&` escaped), the system prompt (`instructions/copilot.md`) says instructions in cells are never followed, and there is no tool that could exfiltrate or pass a gate. The pane renders every model text as plain text.
- **Formulas.** A denylist applied on the server and again in the pane: external or side-effecting functions (for example `WEBSERVICE`, `HYPERLINK`, `IMAGE`, `CALL`, `REGISTER`, `EXEC`, `PY`), dynamic or introspective ones (`INDIRECT`, `CELL`, `INFO`), file import (`IMPORTTEXT`, `IMPORTCSV`), the same names used **bare** (Excel passes functions as values, as in `=MAP(A1:A3,WEBSERVICE)`) and behind any number of `_xlfn.`/`_xlws.` prefixes, add-in and user-defined functions (`_xll.`, `_xludf.`), external workbook references, DDE pipes, UNC paths and URLs. A denylist cannot stop a VBA or custom-function UDF under a name it does not know; the pane never runs macros, and every formula is shown to the analyst before Apply. In Excel the pane also refuses references to hidden sheets, including through defined names, table references and 3D references. It fails closed.
- **Values policy.** A text value that starts with `=`, `+`, `@`, `-` (after Unicode folding, so fullwidth forms and U+2212 count), a tab or a carriage return is refused unless it is a plain number; formulas go in `formulas`. Values are written with number format `@` (text) so Excel does not interpret them; numbers keep their type. Values over Excel's 32,767-character cell limit are refused.
- **Ownership.** The scratch sheet is marked with a worksheet-scoped name, `CopilotScratchOwner`, like the Review sheet's. The add-in clears and writes only a sheet carrying it, and never a sheet named "Copilot Scratch" or "Onboarding Review" that it did not create. A write into the user's own range also refuses merged areas, protected sheets and hidden sheets, and checks the range is unchanged since the preview ("stale" refusal).
- **Fairness and cost.** At most five sessions per actor and `ONB_COPILOT_MAX_CONCURRENT_STEPS` model steps at once per API process, on their own thread pool so they cannot starve the other routes.

### Using the pane

1. Click **Copilot** in the header. The first open starts a session (it takes one of the actor's session slots) and shows the privacy notice. If the server has it off, the panel says so.
2. Type a question in the composer (up to 8000 characters) and click **Send** (Ctrl/Cmd+Enter does the same; Enter is a newline). **Stop** ends the turn at once; the conversation and session stay.
3. Each answer lists, under **What the copilot read**, the addresses and cell counts it read.
4. A **Write proposal** card shows the sheet, range and a **Before → after** diff. **Apply to Copilot Scratch** writes to the scratch sheet; it asks first when the write would overwrite earlier scratch content ("This overwrites N existing cells on Copilot Scratch. Apply?") or contains formulas ("Formulas run in your workbook. Apply?"). **Apply to range…** previews the live cells, then needs a second confirmation. Before-values are read when you ask to apply, not when the proposal arrives.
5. A **Change proposal** card applies typed changes to the active run through the stage-1 gate path. Only the newest answer's changes can be applied, and only while the run's state has not moved on.
6. If the active run changes, a new conversation starts (the transcript stays, with a separator); the old session is closed when the next message is sent, when the pane closes, or by its TTL.

## Testing

`pnpm test` runs everything offline (Office is faked). `pnpm test:contract` starts the scripted API and runs the add-in's client against it; it needs `uv` and `STRING_MATCHER_PATH`. Repo-level `uv run pytest -q` is unaffected by this package.

The contract test (`tests/contract/globalSetup.ts`) starts two scripted servers on free ports (preferred 8765 and 8766), each in its own detached process group that is killed on teardown, exit, SIGINT or SIGTERM. It never uses :8000 or :3100.

- **Copilot on** (`serve_scripted --copilot`, with `ONB_COPILOT_MAX_CONCURRENT_STEPS=1`): `CONTRACT_API_URL` and `COPILOT_ON_URL`. Cases 1-7 (the run flow) and the copilot cases use it.
- **Copilot off** (no flag): `COPILOT_OFF_URL`, for the 403 case.

The developer's own `ONB_COPILOT_*` variables are removed from both servers' environments.

The copilot cases (8a-8j) drive the real `createClient`, `createCopilotSession` and `runClientTool`, plus `previewWrite`/`applyWrite`, against strict fake Office layers. They cover:

- the tool loop, with a read log of addresses and counts only;
- a hidden sheet that never reaches a request body;
- a server-side refusal of an over-cap read before it reaches the pane;
- write proposals: scratch and range writes, confirmation for formulas, and a client-side refusal of a denied formula;
- typed changes applied through the stage-1 gate path;
- 403 → `disabled`;
- actor isolation (a 404 that is the same as for an unknown session);
- injection text returned verbatim;
- close mid-turn, with 8 create/close cycles and no leaked session;
- 503 → `busy` with `Retry-After: 5`;
- no copilot request to any `/runs/...` route.

On failure, a case prints its actor, session id, error kinds and the request log.

### Trying the Copilot against the scripted server

From the repo root, add the PYTHONPATH workaround from CLAUDE.md if imports fail on macOS:

```bash
ONB_CORS_ORIGINS=http://localhost:3000,https://localhost:3100 \
  uv run python -m tests.e2e.serve_scripted --port 8000 --copilot
```

The scripted copilot is deterministic and has no model. It reacts to keywords in your message (case-insensitive; the first match wins, in this order):

| Message contains | What happens |
| --- | --- |
| `overcap` | Asks for `read_range` `Affiliates!A1:B1001` (2002 cells, over the 2000-cell per-call cap). The server refuses it before the pane sees it, and the answer quotes the refusal. |
| `propose formulas` | Proposes formulas for `Affiliates!J1:J2` (`=COUNTA(A2:A9)`, `=SUM(C2:C9)`). Applying them needs the confirmation step. |
| `propose changes [R1 [R2]]` | Proposes `exclude_row` R1 and `set_item_type` Non-Inventory on R2 (defaults 2 and R1+1). Needs a run (the pane binds the current one); without one the answer says "no active run". |
| `propose write` | Proposes values for `Affiliates!G1:H2`. |
| `inject` | Answers with text that contains `</tool_result>`. The pane must show it as plain text. |
| `slow` | Answers "OK (slow)" after 2 s. |
| `sheets` | Runs `list_sheets`, then `describe_sheet` on the first sheet, then `read_range` A1:B3 there, then answers with the addresses it read. |
| anything else | "OK". |

A failed tool ends the turn with an answer naming the tool and its error.

Real answers need a live model: `ONB_COPILOT_ENABLED=true scripts/start-backend.sh`, with `OPENAI_API_KEY` in `.env`. Start it yourself; the tests and tools never start it.

## Manual verification checklist

These need real Excel and are not covered by automated tests. Platforms: W = Windows desktop, M = Mac desktop, Web = Excel on the web; where nothing is said, check all three.

Stage 1 (the run flow):

- [ ] Sideload on Windows, Mac and Excel on the web; the Home tab button opens the pane.
- [ ] Highlight offset: with `tests/fixtures/affiliate/titled.xlsx` (title row, blank row, header on row 4), the header row, column and source-row jumps select the right cells.
- [ ] Review sheet ownership: the add-in creates "Onboarding Review" with the `OnboardingReviewOwner` name; a user sheet of that name is refused with the rename message and left untouched; "Onboard again" deletes the add-in's sheet first and the uploaded file (check the server copy) does not contain it, i.e. `getFileAsync` reflects the in-memory deletion and not only the last saved file.
- [ ] Review sheet: the sheet is protected except `ITEM_ID`; pasting over locked cells and multi-cell paste behave as designed; edits fire `worksheets.onChanged` (ExcelApi 1.9) and the dry-run preview appears.
- [ ] Downloads on desktop: "Open in browser" opens the artifact URL via `openBrowserWindow` (OpenBrowserWindowApi 1.1) in an authenticated browser; the anchor download produces `Affiliates.csv` and `review.xlsx` (and `manifest.json` after lock) with correct names.
- [ ] Downloads on Excel on the web: the anchor download works.
- [ ] SSE (the run event stream) behind a corporate proxy; the pane reconnects and recovers state.
- [ ] Unsaved workbook: the pane explains that the workbook must be saved first.
- [ ] Excel on the web: a workbook near or over 5 MB is rejected with a clear message rather than failing silently.
- [ ] Large workbook: a file above `VITE_MAX_UPLOAD_BYTES` is refused before upload.
- [ ] Sign-in: the 180 s bound with a real MFA prompt; the shared token request (Office error 13008 on a concurrent `getAccessToken`).
- [ ] Excel busy: the "Excel is busy (finish editing the cell)" path while a cell is in edit mode (Onboard and Apply).
- [ ] CSP and the office.js endpoint (W, M, Web): the pane loads, `Office.onReady` fires and nothing is blocked in the console (`frame-ancestors`, `script-src`, `connect-src`).

Copilot (stage 2), against a server with `ONB_COPILOT_ENABLED=true` unless stated:

- [ ] The pane loads, the **Copilot** button toggles the panel, focus moves to the composer on open and back to the button on close, and the Chat panel still works.
- [ ] Flag off (a server without the flag): the panel shows "The copilot is turned off on this server." with **Check again**, and the composer is disabled.
- [ ] Reading tools on a real workbook: `list_sheets`, `describe_sheet`, `read_range`, `find` and `get_selection` return what the sheet shows; the "What the copilot read" list shows the addresses and counts.
- [ ] Hidden and very-hidden sheets are absent from `list_sheets` and `find`, and `read_range` of one is refused. Hidden rows and filtered rows are read (confirm, so the privacy statement is true).
- [ ] Merged cells: `describe_sheet` lists merged areas on ExcelApi 1.13 or later; on older hosts the list is empty and a range write warns "merged cells can't be detected on this Excel version". Check that `getMergedAreasOrNullObject` returns a null object (not an error) for a range with no merges.
- [ ] Text cells that start with "=" (typed with a leading apostrophe or in a text-formatted cell) are reported as text, not formulas (`describe_sheet` formula count, `read_range` formulas grid).
- [ ] Dates arrive as serial numbers and error cells as `#N/A`-style text; the model is not confused by them.
- [ ] Large sheets: a request over `ONB_COPILOT_MAX_CELLS_PER_CALL` is refused by the server; a `read_range` result is truncated at the caps; a 2,000-cell load and a 4-sheet `find` finish in reasonable time; `getUsedRangeOrNullObject(true)` behaves on formatting-only cells.
- [ ] `get_selection` with a multi-area selection gives a clear error (Excel throws for it); a single-cell and a large selection give address and counts only (up to 25 values).
- [ ] Scratch write: "Copilot Scratch" is created, carries the `CopilotScratchOwner` name (Formulas > Name Manager, worksheet scope), is activated and the range selected; values are written after format `@`; numbers stay numbers (right-aligned, summable); text that looks like a number is shown as text where the proposal says so.
- [ ] Formulas on scratch: the card asks "Formulas run in your workbook. Apply?" first; after confirming, the formulas calculate; a denied function (for example `=WEBSERVICE(...)`, `=INDIRECT(...)`, `=MAP(A1:A3,WEBSERVICE)`) and a reference to a hidden sheet, through `=Secret!A1`, a defined name, a table reference and a 3D reference, are each refused with no write.
- [ ] Writing into an existing range: the preview shows the live before-values and the overwrite count; the second confirmation is required; editing the range between preview and Apply gives the "range changed since the preview" refusal; a merged area, a protected sheet and a hidden target are each refused; the "Excel can't undo this change" warning is true (Ctrl+Z does not restore the cells after an add-in write).
- [ ] Number formats: after an Apply, cells that were changed to `@` or General stay that way (they are not restored); the warning "N cells will get a new number format" appears beforehand. Tables, spilled arrays and data validation in the target get only the generic warning; check what actually happens.
- [ ] A copied scratch sheet: copy "Copilot Scratch" (Move or Copy) and rename the copy "Copilot Scratch" after deleting the original; see whether the add-in writes to it (the marker is copied with the sheet). Same for a copied "Onboarding Review".
- [ ] A user sheet named "Copilot Scratch" (no marker) is refused with the rename message and left untouched.
- [ ] Request size: a 500-row / ~200,000-character write chunk and a 255 KB `read_range` result (and several in one step) are accepted on Excel on the web, whose request limit is about 5 MB; confirm the 2 MiB step body cap is never hit.
- [ ] Excel busy: while a cell is in edit mode a Copilot tool or a write waits at most 20 s, then reports "Excel is busy (finish editing the cell), then try again."; a deferred batch that runs after the bound is reported honestly (not as success).
- [ ] Defined names and tables: `NamedItem.formula` (ExcelApi 1.7) and table loads work for the hidden-sheet reference checks; on a host where they do not, formulas that use names or `[` references are refused with the "can't be checked" message. Locale-dependent name formulas (`;` separators) are refused if they cannot be parsed.
- [ ] Pane: long unbroken text and long sheet names wrap inside the narrow pane; the diff table scrolls horizontally (not the pane); keyboard focus stays in the composer after Send; the transcript scrolls to the newest answer; a screen reader announces new answers.
- [ ] Stop and close: Stop ends a running turn promptly and Send works again at once; closing the pane or changing the run frees the server session (check `/copilot` audit lines or retry creating sessions beyond 5).
- [ ] Closing the workbook window or reloading the pane (pagehide) ends in-flight requests; in a pane restored from the back-forward cache the session may stay until its TTL.

## Known platform behavior

The workbench downloads artifacts two ways. Primary: an anchor download of a bearer-fetched blob. Secondary: "Open in browser", which opens the artifact URL in the system browser via OpenBrowserWindowApi 1.1 (no token in the URL; it needs an existing browser session through Easy Auth, or a dev API without auth). Excel on the web tries the anchor first. Excel desktop (Windows/Mac) and unknown hosts try the browser window first and use the anchor if it is unsupported or throws. Task-pane downloads on desktop WebView2/WKWebView can be dropped silently (the click never throws), so the UI says only "Download started. If no file appeared, use Open in browser." and shows size and sha256 for verification. Dialogs (`displayDialogAsync`) are not used. The sign-off gate offers `Affiliates.csv` and `review.xlsx`; `manifest.json` appears only after the run locks.

Sign-in: with Entra, the first request can wait for Office's sign-in, consent or MFA prompt for up to 180 s; the request's own 30 s bound starts only after that. Concurrent requests share one token request (Office rejects a second `getAccessToken` while one is pending). If the sponsor list cannot be loaded (sign-in did not complete, the API is down), the pane shows the error under the sponsor picker with a Retry button. A sign-in that timed out is forgotten, so Retry asks Office for a token again instead of waiting on the abandoned request; if Office still has its own sign-in in progress it answers 13008 and the pane says "Sign-in is already in progress in Excel; wait for the prompt or retry." Gate actions and uploads retry the same way; if Office's sign-in itself stays stuck, reopening the pane is the remaining fallback.

Cell-edit mode: Excel runs no add-in batch while the user is editing a cell. Onboard waits at most 20 s for the Review sheet removal; the pane then asks the user to finish editing and try again. An accepted Apply whose re-render waits longer says "The change was sent; the Review sheet will refresh when Excel is free." and the sheet refreshes once Excel runs the batch.

## CI

`ci.example.yml` is a ready-to-paste GitHub Actions job (checkout, pnpm 10, Node 22, `pnpm install --frozen-lockfile`, `pnpm check`, coverage, `pnpm audit`, `pnpm manifest:validate` with placeholder values). It is NOT wired: `.github/workflows/ci.yml` is shared and was deliberately not edited. Wiring it is an open item for the repo owner.

## Open items and known limitations

Stage 1 and shared:

- CI is not wired; paste `ci.example.yml` into `.github/workflows/ci.yml` (see CI).
- The API's `/health` returns no `version` yet, so the API compatibility check can never fire until the backend adds one (a backend change).
- The API does not read or log `X-Request-Id` yet, so the "ref" shown in error messages cannot be correlated with server logs until the backend does.
- The stale-`idle` window is narrowed, not closed: the server drops its busy flag before it publishes `idle`, so in rare timing an `idle` from the previous job can arrive after a post's own `decision` event; a snapshot read then may still mix the gate before and after the job. Closing it needs a backend change (a job id or sequence on `idle`, or `idle` published before the busy flag drops, or a consistent snapshot read).
- `POST /gate` takes no expected gate, so a post that reaches the server late (after a client timeout) is applied to whatever gate the run is at then. An expected-gate field would let the server refuse it (a backend change).
- Bearer-token-only deployments (no Easy Auth browser session) cannot use the "Open in browser" route. It needs a backend one-time artifact link, which is not built.
- Microsoft labels `Office.auth.getAccessToken` "legacy Office SSO" and recommends nested app authentication (MSAL) as the successor; plan a migration (`src/auth/entra.ts` is the single place to change).
- Real-Excel checks (sign-in bound, Excel busy, CSP, office.js endpoint) are in the Manual verification checklist; none is covered by automated tests.

Copilot (stage 2):

- **Authorization.** Run authorization is not enforced per actor or sponsor across the API; the Copilot inherits it (it checks run existence like `GET /runs/{id}`, and returns only compact run state and findings). This is an API-wide decision.
- **Session ids in logs.** Session ids appear in URL paths (uvicorn access logs) and in the audit log. Where the actor is self-asserted (dev auth) knowing an id of the same actor name is enough to take over a session; with Entra the actor is the signed-in user.
- **Fairness.** The `ONB_COPILOT_MAX_CONCURRENT_STEPS` slots are per API process and shared by all actors; one busy actor can take them all (others get 503 and retry).
- **Cancel.** A native task cancel can free its token while the worker thread still runs the model call; only a forced shutdown stops it.
- **Session slot at open.** The first open of the panel starts a server session and takes one of the actor's five slots even if nothing is sent (it is freed when the pane closes, when the next message is sent after a run change, or by TTL). A lazy start on first Send is the recommended change. At the cap, a run change while the old session's step is still running returns "too many" until that step ends.
- **Only the newest answer's typed changes can be applied,** and only while the run state has not moved on (a newer decision disables Apply).
- **Row numbers.** Proposal row numbers come from the live workbook, but gate changes target the uploaded copy; edits made after the upload (inserted or deleted rows) shift them.
- **Stale idle** (see above) and **`POST /gate` has no expected-gate field** also apply to typed changes applied from the Copilot.
- **Ownership markers.** A copied sheet carries its worksheet-scoped marker (`CopilotScratchOwner`, and the Review sheet's `OnboardingReviewOwner`), so a copy renamed to the reserved name counts as the add-in's own. Recording the sheet id alongside the marker would close it.
- **Formats.** Number formats changed to `@` or General by a write are not restored (Excel has no undo for API writes; the preview warns).
- **Tables, spills, data validation.** A write into them gets only a generic warning; they are not detected. Conditional formats are not considered.
- **Names and hidden sheets.** A defined name that points at a hidden sheet, a table on a hidden sheet and 3D references over one are refused (fail closed), but a name whose formula cannot be parsed (for example a locale with `;` separators) is refused too, and on a host that cannot load names or tables, formulas using names or `[` references are refused.
- **Function-named identifiers.** A sheet named like a denied function (`=Info!A1`) must be quoted or renamed, and a `LET` variable named like one (`call`, `image`, `run`, `info`...) is rejected.
- **Transcript.** A session restart (server restart, lost session, run change) starts a new server conversation; the pane keeps the visible transcript with a separator, but the model does not see it.
- **Scratch preview timing (deliberate deviation).** Before-values are read from Excel when you click Apply, not when the proposal arrives (a read on arrival would be stale by the click and would run Excel without a click).
- **Model-call counter.** The spine's `max_model_calls`/`ModelCallCounter` is not wired for the Copilot; a per-turn bound (the smaller of `ONB_COPILOT_MAX_STEPS_PER_TURN` and `ONB_MAX_MODEL_CALLS`) is used instead.
- **Sessions are in memory** and end at a server restart (the pane gets 404 and starts a new session).
- **Answer quality needs a live model.** CI uses scripted models only; tuning the prompt is a manual follow-up with `pytest -m live` when asked.
- **Excel Online request-size limits** for 500-row / ~200,000-character write chunks and 255 KB read results are unverified.
- **bfcache.** `pagehide` also fires when a page enters the back-forward cache, so a restored pane may keep its session until the TTL.
- **A hung Excel batch** (a stuck `ctx.sync()`) blocks later Excel work, including Copilot reads and writes, until Excel runs it; the 20 s bound only reports it.
- **Cost control** beyond the step, cell and session caps (rates, budgets per actor) is not designed; it is for the deployment owner.
