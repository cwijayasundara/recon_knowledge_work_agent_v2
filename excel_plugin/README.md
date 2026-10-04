# Onboarding workbench for Excel

An Office task-pane add-in (Preact, Vite, TypeScript) that drives the onboarding API from inside Excel. The analyst picks a sponsor, the add-in uploads the open workbook, streams the run, shows the brief, questions and findings, highlights the source cells in the sheet, renders an "Onboarding Review" sheet, and offers the sign-off step and the Intacct import files. Accounting rules, gates and file rendering stay in the API; this add-in only proposes actions and displays results. The plan is `docs/superpowers/` in the repo root; Phase 2 (a Copilot tab) is out of scope (spec section 11).

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
2. `cd excel_plugin && pnpm install && pnpm dev` serves the pane at `https://localhost:3100` (self-signed certificate: open the URL once and trust it, or run `npx office-addin-dev-certs install`). Dev builds use dev auth (`X-Actor: <VITE_DEV_ACTOR>`) against `http://localhost:8000`.
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

Manifest and hosting variables (used by the scripts, not the bundle): `ADDIN_HOST`, `ADDIN_ID`, `ADDIN_VERSION`, `ADDIN_CLIENT_ID`, `ADDIN_API_RESOURCE`, `API_ORIGIN`.

API compatibility: on start the add-in reads `/health` before it mounts the pane. If the response has a `version` whose major differs from `SUPPORTED_API_MAJOR` (`src/config.ts`, currently 0), the pane is not mounted and only an incompatibility message is shown, so nothing can be uploaded. A `/health` without `version` (today's API returns only `{status}`), or a failed `/health`, is tolerated and the pane mounts.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server on `https://localhost:3100` with dev auth. |
| `pnpm check` | typecheck, lint, tests, and a production build (`VITE_AUTH=entra`, placeholder API origin unless `VITE_API_BASE` is set) with the bundle check. The pre-merge gate. That build goes to a temporary directory that is deleted afterwards; it never touches `dist/`. |
| `pnpm build` | `tsc`, `vite build`, bundle check. Requires `VITE_AUTH=entra` and an https `VITE_API_BASE`; otherwise it fails with "Production builds must set VITE_AUTH=entra" or "... must set VITE_API_BASE". `pnpm check` supplies a placeholder API origin for its build. |
| `pnpm test` / `pnpm vitest run --coverage` | Offline unit and UI tests; coverage thresholds in `vitest.config.ts`. |
| `pnpm test:contract` | Contract test against the real scripted API (needs `uv` and `STRING_MATCHER_PATH`). |
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
- Before each upload ("Onboard this workbook" or "Onboard again") the add-in deletes its own "Onboarding Review" sheet, a rendering of the previous run, so the agent never maps the add-in's output. If that sheet cannot be deleted the upload is blocked with a message. Onboard is disabled while an Apply is in flight, for at most 60 s; then the pane says "Apply is taking long; you can start a new upload." Every API request except the event stream times out (30 s; downloads 120 s, the upload 300 s) with "Request timed out after N s" and its request id. If the upload fails before the new run exists, or the server copy does not match the workbook, the pane goes back to the previous run (it still exists on the server) and re-renders its sheet.
- The access token stays in memory and is never placed in a URL.

## Security decisions

- `office.js` is loaded from `https://officeapis.public.onecdn.static.microsoft/1/office.js` without a Subresource Integrity hash, on purpose. Microsoft serves that file unversioned, updates it in place and requires add-ins to load it from its CDN, so a pinned hash would break the add-in whenever Microsoft ships a change. A security hook or scanner may warn about the missing `integrity` attribute; that warning is expected. Compensating controls: the CSP allows scripts only from `'self'` and that one origin (no `unsafe-eval`), `connect-src` is limited to `'self'` plus the API origin, and there are no inline scripts or styles. `tests/buildcheck/manifest.test.ts` asserts `index.html` has exactly one external script and that it is this URL.
- Endpoint choice: Microsoft's page "Referencing the Office JavaScript API library" (checked 2026-10-03, updated 2026-09-23) shows `https://officeapis.public.onecdn.static.microsoft/1/office.js` as the reference and, under "Update legacy CDN endpoints", says the older `https://appsforoffice.microsoft.com/lib/1/hosted/office.js` should be switched to it: "The new endpoint serves the same current Office.js release, but it enables additional secure defaults." Caveats it lists, all checked for this add-in: Office.js no longer auto-loads Microsoft Ajax (this add-in does not use it, so `ajax.aspnetcdn.com` is not in the CSP); `ExecuteFunction` commands need `Office.actions.associate` (this add-in has none); restrictive CSP/Trusted Types must permit the new endpoint (it is in `script-src`; no Trusted Types policy is enforced); `*.static.microsoft` must be on network allow lists. The legacy URL is not referenced anywhere; to fall back, change `index.html` and `script-src` together.
- No dev auth code ships: production builds refuse `VITE_AUTH` other than `entra`, and the bundle check scans `dist/`.

## Review sheet

The add-in renders the server's preview grid into a protected sheet named "Onboarding Review" and marks it as its own with a worksheet-scoped defined name, `OnboardingReviewOwner` (ExcelApi 1.4). The marker is saved with the workbook, so ownership survives reloading the pane or reopening the file, and it is deleted with the sheet. If a sheet with that name exists without the marker, it belongs to the user: the add-in never clears, writes, reverts or deletes it, and the pane says "A sheet named 'Onboarding Review' already exists and wasn't created by this add-in; rename it." The add-in's own sheet is deleted before every upload (see Privacy and egress).

Acknowledge, Exclude row and Apply are available only while the run waits at the findings gate and that gate allows changes; elsewhere (including a re-entered brief gate that still shows the last findings) the pane says so. `POST /gate` answers 202 before the run checks a change, so Apply reads its verdict from the run: the `findings.change` decision carrying that row and value, once the run has settled, read only from a snapshot fetched after the job's `idle` event (a snapshot taken while the job ends can mix the old gate with the new decision). A refusal is shown with the server's message and the edit comes back for another try; if no verdict arrives within 30 s the pane says "Verdict unknown — check the findings gate" and shows the server's grid again.

## Testing

`pnpm test` runs everything offline (Office is faked). `pnpm test:contract` starts the scripted API and runs the add-in's client against it; it needs `uv` and `STRING_MATCHER_PATH`. Repo-level `uv run pytest -q` is unaffected by this package.

## Manual verification checklist

These need real Excel and are not covered by automated tests.

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

## Known platform behavior

The workbench downloads artifacts two ways. Primary: an anchor download of a bearer-fetched blob. Secondary: "Open in browser", which opens the artifact URL in the system browser via OpenBrowserWindowApi 1.1 (no token in the URL; it needs an existing browser session through Easy Auth, or a dev API without auth). Excel on the web tries the anchor first. Excel desktop (Windows/Mac) and unknown hosts try the browser window first and use the anchor if it is unsupported or throws. Task-pane downloads on desktop WebView2/WKWebView can be dropped silently (the click never throws), so the UI says only "Download started. If no file appeared, use Open in browser." and shows size and sha256 for verification. Dialogs (`displayDialogAsync`) are not used. The sign-off gate offers `Affiliates.csv` and `review.xlsx`; `manifest.json` appears only after the run locks.

## CI

`ci.example.yml` is a ready-to-paste GitHub Actions job (checkout, pnpm 10, Node 22, `pnpm install --frozen-lockfile`, `pnpm check`, coverage, `pnpm audit`, `pnpm manifest:validate` with placeholder values). It is NOT wired: `.github/workflows/ci.yml` is shared and was deliberately not edited. Wiring it is an open item for the repo owner.

## Open items

- CI is not wired; paste `ci.example.yml` into `.github/workflows/ci.yml` (see CI).
- The API's `/health` returns no `version` yet, so the API compatibility check can never fire until the backend adds one (a backend change).
- The API does not read or log `X-Request-Id` yet, so the "ref" shown in error messages cannot be correlated with server logs until the backend does.

- Bearer-token-only deployments (no Easy Auth browser session) cannot use the "Open in browser" route. It needs a backend one-time artifact link, which is not built.
- Verify the CSP and the office.js endpoint in real Excel desktop (Windows, Mac) and Excel on the web: the pane must load, `Office.onReady` must fire and nothing may be blocked in the console (frame-ancestors for the web host frames, `script-src`, `connect-src`). Not verified by automated tests.
- Microsoft labels `Office.auth.getAccessToken` "legacy Office SSO" and recommends nested app authentication (MSAL) as the successor; plan a migration (`src/auth/entra.ts` is the single place to change).
- Phase 2 (Copilot tab) is out of scope; see spec section 11.
