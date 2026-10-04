# Excel plugin (`/excel_plugin`): design

Status: draft for review. Source sketch: `docs/excel-addin-sketch.md`. Scope: full flow (sketch steps 1-5), dev-actor auth first, Entra SSO behind one `auth` module.

## 1. Goal

An Office task-pane add-in, in its own package `/excel_plugin`, that drives the Affiliate onboarding flow from inside Excel against the existing workbench API. The analyst stays in Excel: the add-in uploads the whole workbook, shows the agent's brief and questions, highlights proposed sheets, headers and columns in the analyst's own sheet, renders the generated Affiliate preview, and signs off. The server remains the only source of truth. Agents propose, code decides, humans approve (CLAUDE.md rules unchanged).

Success criteria:
- A messy sponsor workbook goes from open-in-Excel to a downloaded Affiliates CSV without leaving Excel, with every approval passing through the existing gate API.
- No cell edit can approve, acknowledge or bypass anything.
- No backend code change is required for the core flow (config only). Any gap found is reported, not silently patched.

Non-goals: new intake logic (the server reads the real file), other entities, offline use, Mac/web parity testing beyond a manual checklist, Entra SSO in this build (interface only).

## 2. Findings that shape the design

### 2.1 Backend check (verified in code)

`GET /runs/{id}/events` supports `Last-Event-ID` resume, but history is in memory, per process, capped at 5000 events. Events actually emitted today: `phase`, `brief`, `question`, `gate`, `findings`, `report`, `artifact`, `decision`, `error`, `agent_message`, plus an undocumented `idle`. `docs/ui-spec.md` §8 also lists `step`, `tool` and `change_impact`; no emitter was found for them. Design consequences:
- Progress is driven by `phase`, `question`, `brief`, `gate`, `findings`, `report`, `artifact`, `error`, `idle`. `step`, `tool` and `change_impact` are optional and handled if they appear.
- On stream loss the pane resumes with `Last-Event-ID`; if the server restarts (history gone) it rebuilds from `GET /runs/{id}`.
- `POST /runs` is multipart (`sponsor_id`, `entity`, `file`) and returns `{run_id}`. `/grid` takes `view=source|preview|ids`. `/dry-run` and `/gate` take typed changes. Artifacts download via `/runs/{id}/artifacts/{name}`.

### 2.2 Industry research (searched 2026-10; mostly search summaries, vendor claims not independently verified)

| Pattern | Evidence | Our position |
|---|---|---|
| Code-generated transforms, then deterministic computation, not LLM cell edits or arithmetic | FinSheet-Bench (arXiv 2603.07316: best model 82.4% overall, 19.6% on complex aggregation, 48.6% on the largest file; authors recommend schema discovery, row extraction, deterministic compute); OneSchema and Osmos generate and run code | Agrees: recipe engineer + sandbox, rules in `onboarding_sdk` |
| LLM reads layout poorly without inspection | Agent failure analysis (snippet, unconfirmed source): about 75% of failures are insufficient inspection or wrong target; Table Meets LLM: merged cells and hierarchical headers are hard | Keep the model's job to layout/header/table inference and recipe proposals, with inspection tools and compact summaries |
| Compressed sheet views for large sheets | SpreadsheetLLM / SheetCompressor (about 25x token reduction, 78.9% F1 table detection) | Server-side concern; note for the recipe engineer, not for the add-in |
| Human approval before write, AI changes surfaced for review | Flatfile, Osmos (vendor claims) | Agrees, and stronger: gates are code |
| Per-customer mapping memory | Flatfile, OneSchema | Agrees: per-sponsor history, `tenant_id=<sponsor_id>` |
| Cell-level citations and lineage | Rogo, Hebbia (vendor claims) | Agrees: `source_sheet`/`source_row` jump-to-source |
| Model-free replay of a saved recipe | No public source found | Differentiator, not a norm; prove with golden/differential tests |
| On-demand range reads vs whole upload | Claude for Excel reads ranges on demand; only Word uploads everything (Pluto Security teardown, third-party) | Diverges on purpose: layout inference needs formulas, merged cells and formatting that range reads lose |
| Egress and audit | Add-in egress can bypass M365 audit/Purview; system-prompt "restrictions" are not enforced controls (Pluto) | We must build our own consent, audit and retention story; gates are code, not prompt |
| File fidelity | openpyxl round-trips can drop conditional formatting, named ranges, macros (issue reports) | Source file is immutable; outputs are new files, never written back |

Unverified: Copilot Agent Mode internals, Ramp, CSVBox, Fivetran, Osmos blog text. Treat prompt injection through untrusted cell text as our own inference (not sourced): the sandbox has no network or secrets and tools return compact summaries, which the repo already enforces.

Office.js constraints (Microsoft docs): `getFileAsync` returns the file in slices of up to 4 MB (64 KB on iPad); Excel web limits request/response payloads to 5 MB; ranges over 5M cells can silently return null. So upload must be sliced, reassembled client-side into a `Blob`, and sent with a sha256 check. Whole-file upload is fine for sponsor files at Affiliate scale; larger files need a size guard with a clear message.

## 3. Architecture

Stack: TypeScript, Vite, Preact, Vitest, pnpm; HTTPS dev server for sideloading. No Anthropic/Claude dependencies (runtime-model rule applies to the product; the add-in has no model calls at all).

```
excel_plugin/
  manifest.xml             task-pane add-in (dev sideload; SourceLocation = https dev origin)
  package.json  vite.config.ts  tsconfig.json  README.md
  src/
    api/    client.ts   fetch wrapper: base URL, auth headers, typed errors
            sse.ts      fetch-stream SSE parser; reconnect with Last-Event-ID
            types.ts    mirrors GateResponse, typed changes, grid, SSE events
    auth/   auth.ts     interface getIdentity(): dev actor now, Office SSO later
    office/ workbook.ts getFileAsync -> sliced read -> Blob + sha256
            highlight.ts select sheet / range / column in the user's workbook
            review.ts    render preview grid to the protected, add-in-owned "Onboarding Review" sheet; onChanged hook
    state/  store.ts    single store; mutated only by server events and responses
    ui/     Pane, SponsorPicker, Progress, BriefCard, QuestionCard,
            ReviewPanel, FindingsList, SignOff
  tests/    vitest: unit + fake Office.js + contract test vs scripted API
```

Boundaries: `api/` and `state/` know nothing about Office; `office/` knows nothing about the API. `ui/` composes both through the store. Each can be tested alone.

## 4. Flow

1. **Sign in, sponsors.** `auth.getIdentity()` supplies the actor (dev header today; Entra SSO token later; `x-ms-client-principal-name` when `trust_easy_auth` is on). `GET /sponsors` fills the picker; if it fails, the picker shows the error with a Retry button that fetches the list again.
2. **Upload.** "Onboard this workbook" reads the file via `getFileAsync(Compressed)`, assembles slices, `POST /runs` (sponsor, entity=affiliate, file), then opens the SSE stream. Progress from `phase`, `agent_message`, `error`, `idle`.
3. **Brief and questions.** `brief` renders a card. Each `question` becomes a card; the pane highlights the proposed sheet/header row/columns in the analyst's workbook (using `GET /runs/{id}/grid?view=source` and `header_row`). The answer posts `gate {action:"answer", question_id, option}`; if the analyst disagrees with a column they click another, which posts `set_column_binding`. Approve posts `gate {action:"approve"}`.
4. **Review.** After build, `GET /grid?view=preview` is written to a protected sheet named "Onboarding Review" (ITEM_ID, NAME, ITEM_TYPE, flags, source_row) that the add-in owns (see "Review sheet ownership" below). `findings` show in the pane with an Acknowledge button each (`acknowledge_finding`) and an Exclude row action (`exclude_row`). A click on a Review row jumps to the source cell via `source_sheet`/`source_row`. Acknowledge, Exclude row and Apply (step 5) are offered only while the run waits at the findings gate and that gate lists `change`: a re-entered brief gate also lists `change`, may still carry the last result, and would route these to scoping and drop them.
5. **Edit loop (ITEM_ID).** `worksheet.onChanged` on an ITEM_ID cell: revert optimistically, `POST /dry-run` with `override_item_id {row, value}`, show impact and violations in the pane. Apply sends `gate {action:"change", changes}` and the sheet is re-rendered from the server. Other cells are protected. `POST /gate` answers 202 before the run checks the change, so the add-in reads the verdict from the run: the `findings.change` decision recorded after the post whose payload carries this exact `override_item_id` (row and value), once the run has settled at a gate. `GET /runs/{id}` reads the run's gate before its busy flag and decisions, so a snapshot taken as the job ends can mix the old gate with the new decision: the verdict is read only from a snapshot fetched by a refresh that started after an `idle` event that arrived after this Apply's own `decision` event (`working` false and the decision present); an `idle` that arrives earlier (the previous job's, or a replay) does not count. The override in effect (`options.id_overrides`) or a settled gate without a message is "applied"; a gate message is "refused" and shown verbatim, with the edit restored behind a fresh dry run. Another action's decision is never taken as the verdict. If a later decision makes the message ambiguous, or no verdict arrives within 30 s (`VERDICT_TIMEOUT_MS`), the pane says "Verdict unknown — check the findings gate" and re-renders the sheet from the server grid.
6. **Sign-off.** The Sign-off button is enabled only when the latest `gate` event lists `approve` in `allowed_actions` and has no `blocked_reasons`. After `artifact` arrives, download `Affiliates.csv`.

**Review sheet ownership.** The add-in marks the sheet it creates with a hidden worksheet-scoped name, `OnboardingReviewOwner`, saved with the workbook. A sheet named "Onboarding Review" without that marker belongs to the user: the add-in never clears, writes, reverts or deletes it and asks the user to rename it. Before every upload ("Onboard this workbook" or "Onboard again") the add-in stops the current run view and deletes its own sheet, and only then reads the workbook, so the agent never maps the add-in's rendering; no Apply may be in flight (Onboard is disabled meanwhile, for at most 60 s (`APPLY_HOLD_MAX_MS`), after which the pane says "Apply is taking long; you can start a new upload." and enables it; an Apply whose run is no longer the active one renders nothing). If the upload fails before the new run exists (the sheet cannot be deleted, the workbook is unsaved, too large or unreadable, or `POST /runs` fails), or the server copy's sha256 does not match the workbook, the previous run is restored (it still exists on the server) and its sheet is re-rendered from its grid; the rejected new run is never monitored.

Typed changes used: `set_sheet`, `set_header_row`, `set_column_binding`, `set_item_type`, `override_item_id`, `exclude_row`, `acknowledge_finding`, `request_recipe_revision`.

## 5. Invariants (code-enforced in the add-in)

- Gates live in pane buttons posting to the API. No gate action is ever derived from a cell value.
- The "Onboarding Review" sheet is a rendering. It is protected and can be re-rendered or deleted at no cost. Only the add-in-owned sheet (ownership marker) is ever written or deleted, and it is deleted before every upload and never re-created while one is being read.
- Run state is changed only by server events and API responses. The UI never infers approval.
- Server rejections (4xx from `/gate`, `/dry-run`) are shown verbatim and never retried silently.
- The source workbook is never modified by the add-in. Highlights only change selection, not content.
- Tokens are sent in headers; the fetch-based SSE parser avoids `access_token` in URLs.

## 6. Error handling

- SSE drop: reconnect with backoff and `Last-Event-ID`; on a fresh server, rebuild from `GET /runs/{id}`.
- Upload failure or `422 UploadRejected`: show the server message and restore the previous run's view (the add-in deletes its own review sheet before reading the workbook, so a failed upload would otherwise orphan the old run in the pane).
- Hung requests: every request except the event stream is bounded (30 s, `REQUEST_TIMEOUT_MS`; artifact downloads 120 s, the upload 300 s) and fails with "Request timed out after N s" and the request id. The bound starts once the access token is in: obtaining the token (Office SSO may show sign-in, consent or MFA) has its own bound of 180 s (`AUTH_TIMEOUT_MS`) and fails with "Sign-in did not complete. Reopen the pane or retry." Concurrent requests share one token request; a token request the client gave up on is forgotten, so a retry asks Office again (Office's 13008, sign-in already in progress, is shown as "Sign-in is already in progress in Excel; wait for the prompt or retry.").
- Timed-out gate post: a `POST /gate` that times out may still have been received. The pane says "The request timed out and may have been received. Checking the run…", keeps the gate actions disabled and reads the run. The post took effect if its decision is recorded (same gate and action, the posted fields in the payload; for Apply the exact override), the gate moved on, or a job is running; it then continues as accepted. Otherwise the pane says "Not received — you can retry". If the run cannot be read either, the pane says so and asks for a refresh before retrying; it never claims "not received" then.
- Stale gate cards: after an accepted gate post the gate actions stay disabled until a snapshot fetched by a refresh that started after an `idle` event that followed the post's own `decision` event (or a job `error`) has landed, so a card for a gate already passed (old gate, `working: false`) cannot approve the next gate; a post while one is held is refused without a request. A job `error` event alone does not settle a post (the job's following `idle` does). The hold is re-checked after 30 s without any event for the run (`GATE_SETTLE_TIMEOUT_MS`; every event restarts it): with the stream connected the job is still running and the hold continues with "Still working…"; only with the stream down or reconnecting, or after 10 minutes in any case (`SETTLE_HARD_CAP_MS`), do the actions come back with "Status may be out of date — refresh." and a Refresh button.
- Excel busy: Excel defers API calls while a cell is being edited. Onboard waits at most 20 s (`EXCEL_OP_TIMEOUT_MS`) for the Review sheet removal; then it restores the previous run's view and says "Excel is busy (finish editing the cell), then try again." A removal that only starts after that is skipped, so it cannot delete the sheet the restored run renders. Apply bounds its re-render the same way; the change was already sent, so the pane says "The change was sent; the Review sheet will refresh when Excel is free." rather than asking for a retry.
- Oversized file: client guard with a clear message before upload.
- Download: try opening the artifact URL in the browser first; fall back to `displayDialogAsync`. This is the sketch's flagged risk and is the first thing the manual checklist verifies on Excel desktop.
- Egress notice: the upload step states that the whole workbook is sent to the workbench API and names the sponsor it will be filed under.

## 7. Configuration (no backend code change)

- `cors_origins` must include the add-in origin.
- `trust_easy_auth` on only behind Entra/Easy Auth. Dev uses the actor header.
- HTTPS host and manifest: dev cert via Vite; production host (Azure Static Web Apps) is out of scope for this build and documented in the README.

## 8. Testing

- Vitest unit tests: API client, SSE parser (chunk boundaries, reconnect, resume), store reducer (event ordering, gate-enabled logic), Review-sheet diff/revert, upload slicing and hash.
- Fake Office.js for `workbook.ts`, `highlight.ts`, `review.ts`.
- Contract test against `uv run python -m tests.e2e.serve_scripted --port 8000` (scripted agent, no live model): upload fixture, drive questions, approve, sign off, download.
- Manual sideload checklist (README): Excel desktop Windows/Mac, Excel web; includes the download spike and the 5 MB web payload limit.
- Mandatory negative tests: editing any Review cell other than ITEM_ID is reverted with no API call; sign-off is disabled when `gate` blocks; a rejected gate response never advances the pane.

## 9. Build order (becomes the implementation plan)

1. Scaffold, manifest, auth module, sponsor list (steps 1).
2. File read, upload, SSE progress (step 2). Validates the riskiest parts first.
3. Question cards, highlights, gate answers (step 3).
4. Review sheet, `onChanged` to `dry-run` loop, findings and exclude (step 4).
5. Sign-off gate and download (step 5).
6. README, sideload checklist, scripted-API contract test.

## 10. Production readiness (phase 1 requirement)

The add-in is an alternative surface to the web workbench for the same API, so it carries the same production bar. "Production" here means the add-in package; hosting and tenant setup stay with the deployment owner.

- **Auth:** `auth` module has a dev-actor implementation and an Entra SSO implementation (`Office.auth.getAccessToken`, exchanged server-side or via Easy Auth). The dev actor is compiled out of production builds and the build fails if it is present.
- **Transport:** HTTPS only; strict CORS allow-list of the add-in origin; no tokens in URLs.
- **Manifest:** production manifest generated from env (host, app id, version), validated in CI with `office-addin-manifest validate`; minimal `Permissions` (ReadWriteDocument only if needed).
- **Security headers and CSP** on the hosting config (Static Web App `staticwebapp.config.json`): no inline script, connect-src limited to the API origin.
- **Privacy:** upload consent text naming sponsor and API host; no analytics; no workbook content in logs or error reports. Errors carry request ids only.
- **Observability:** each API call sends a client correlation id; failures show it in the pane for support.
- **Reliability:** upload retry with hash check, SSE reconnect with backoff, idempotent gate posts (client generates an idempotency key only if the API supports it, otherwise disables the button while in flight).
- **Quality gates in CI:** `tsc --noEmit`, ESLint, Vitest with a coverage floor on `api/`, `state/` and `office/`, manifest validation, production build size budget, `pnpm audit` for high severity.
- **Accessibility:** keyboard operable cards and buttons, labelled controls, high-contrast safe colours (Office theme aware).
- **Versioning and rollout:** semver in the manifest, a CHANGELOG, and a compatibility check at start-up (`GET /health` returns an API version; the pane refuses to run against an incompatible one).
- **Docs:** README covers dev sideload, production deploy, admin centralized deployment, config table, and the manual checklist.

## 11. Phase 2: Copilot tab (after the five onboarding steps)

A "Copilot" tab in the same pane for ad-hoc questions about the open workbook, as in Claude's Excel add-in (read on demand, edit with approval). It is a separate mode, with its own endpoint and tool set, and never shares state with an onboarding run.

- **Model path:** the pane never holds a model key. It calls a new API endpoint; the server runs an OpenAI-model Deep Agent (assembled in `assembly.py`, no fork per surface). Tool calls are executed in the pane through Office.js and results returned to the server (client-side tools).
- **Tools:** read-only `list_sheets`, `read_range` (size-capped, returned as compact CSV), `find`, and `describe_sheet` (structure summary, not rows). Writes are proposals (`propose_write {range, values}`) that render as a diff in the pane and apply only on an Apply click, and only to a scratch sheet or an explicit user-chosen range.
- **Rule exception (needs your explicit decision):** CLAUDE.md says tools never return raw file rows to a model. `read_range` does, within a cap. Proposed policy: cap at N cells per call and M per session, redact nothing automatically, log range addresses (not contents), disabled by config. Until you approve this exception, phase 2 does not start.
- **Isolation:** copilot tools cannot call gate, mapping-history or artifact endpoints. Enforced server-side by a separate tool registry, not by prompt.
- **Needs backend work** (unlike phase 1): new endpoint(s), tool registry, tests with the scripted model. It gets its own spec and plan before building.

## 12. Open items

- Confirm whether `step`, `tool`, `change_impact` should be emitted by the backend (separate backend task if wanted; the add-in works without them).
- Production hosting, Entra app registration and data-retention policy for uploaded workbooks are decisions for the owner of the deployment.
