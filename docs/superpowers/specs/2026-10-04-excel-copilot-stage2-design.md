# Excel Copilot, stage 2: live-sheet tools (design)

Status: implemented (server S1-S5, add-in A1-A6, docs D1); see "Implementation notes and deviations" at the end for what changed during the build. Real-Excel behaviour is unverified (README manual checklist). Extends `docs/superpowers/specs/2026-10-03-excel-plugin-design.md` §11 (stage 1, the gate chat, is implemented). Approved scope decisions: approach B (pane-driven step loop); capped and logged raw-cell reads allowed; copilot works without an active run; writes are proposals applied by an explicit click.

## 1. Goal

A "Copilot" tab in the add-in that lets an analyst ask questions about, and get help with, the **open workbook**: navigate sheets, read cells and formulas, find things, and propose edits, and, when an onboarding run is active, read its state and propose the same typed changes as stage 1. It must feel like an Excel-aware assistant while preserving the project's rules: agents propose, code decides, humans approve; runtime models are OpenAI only; no keys in the pane.

Success criteria:
- Asked "where are the duplicate affiliate names?", the copilot lists sheets, reads capped ranges, and answers with cell addresses it actually read.
- Asked to clean a column, it returns a **write proposal** shown as a diff; nothing in the workbook changes until the analyst clicks Apply.
- It can read the active run's findings and propose typed changes, but there is no tool, endpoint or path by which it approves, acknowledges or passes a gate.
- Caps, logging and the feature flag are enforced on the server and cannot be loosened by the pane or by prompt text.

Non-goals: autonomous edits, running or approving gates, cross-workbook access, charts/pivots/macros, persistence of transcripts across restarts, multi-user shared sessions.

## 2. Decision: where the model loop runs

**Pane-driven step loop.** The pane calls a server endpoint that runs **one** OpenAI model step with a fixed tool registry and returns either tool calls or a final answer. The pane executes tool calls in Excel through Office.js and posts the results back, repeating until a final answer or a step cap. Rejected: a server-held loop that waits for the pane (waiting state, timeouts, reconnect complexity) and context-only prompting (cannot navigate). The pane never holds a model key; every cap, log line and rule lives on the server.

Deviation from CLAUDE.md to record: the copilot is **not** a Deep Agent on the LangGraph spine. Tool execution happens in the client and no phase or gate is involved, so it is a direct chat-model tool loop built through the shared assembly (`chat_model`, new `copilot` role). The spine, gates, mapping history and artifacts stay untouched.

## 3. Server design (`src/onboarding_agent/copilot/`)

- `models.py`: add role `"copilot"` with settings `copilot_model` (default `gpt-5.6-terra`) and `copilot_effort`; same OpenAI/Azure factory.
- `config.py` settings (all `ONB_`-prefixed): `copilot_enabled` (**default false**), `copilot_max_cells_per_call=2000`, `copilot_max_cells_per_session=20000`, `copilot_max_steps_per_turn=8`, `copilot_max_write_cells=2000`, `copilot_cell_char_limit=500`, `copilot_session_ttl_s=3600`, `copilot_max_sessions_per_actor=5`, `copilot_session_max_lifetime_s=43200` (hard lifetime), `copilot_max_concurrent_steps=8` (global limit on model steps running at once); `copilot_effort` defaults to `medium`.
- Session store (in memory, TTL, bound to the actor): transcript, read-cell counter, step counter. Lost on restart; the pane gets 404 and starts a new session. No contents are persisted.
- Endpoints (same `Actor` auth dependency as the rest of the API; registered by `register_copilot` in `copilot/routes.py`, called from `create_app`). Bodies must be `application/json` (415 otherwise), at most 2 MiB (413), and are validated by hand so a bad body is a 422, never a 500. Other codes: 404 for an unknown or another actor's session (and an unknown `run_id` on start), 409 conflict (step running, or results for already-answered calls), 429 too many sessions, 503 with `Retry-After: 5` when the global step limit is reached:
  - `POST /copilot/sessions` → `{session_id, limits, tools}`; 403 if disabled. Optional `run_id`: binds read-only workflow tools to that run (must exist; the actor needs no extra rights beyond today's `/runs/{id}` access).
  - `POST /copilot/sessions/{id}/step` with either `{user_message}` or `{tool_results:[{call_id, ok, content}]}` (each result carries `ok`; a client error is `ok:false`) → `{status:"tool_calls", tool_calls:[{id,name,args}]}` or `{status:"final", text, proposed_changes, proposed_writes}`.
  - `DELETE /copilot/sessions/{id}`.
- Tool registry (server owns names, JSON schemas and validation; the pane implements the client tools):
  - Client tools (executed in Excel): `list_sheets`, `describe_sheet {sheet}` (used range, header guess, merged ranges, counts of formulas/constants/blanks), `read_range {sheet, range}` (values **and** formulas, capped), `find {text, sheet?}` (capped results with addresses), `get_selection`. Hidden and very-hidden sheets are excluded from `list_sheets`, `describe_sheet` and `find`, and `read_range` of one is refused.
  - Server tools (run-bound, read-only): `run_state`, `run_findings {severity?}`, `check_changes {changes}` (dry-run through `onboarding_sdk`, returns impact and violations).
  - Proposal tools (no side effects; their arguments are returned to the pane in the final answer): `propose_changes {changes}` (typed changes, validated with the SDK before returning) using the copilot change schema, which has no `acknowledge_finding` variant (`CopilotChange`: the stage-1 typed changes minus `acknowledge_finding`), `propose_write {sheet, range, values|formulas}`.
  - **Not present, by construction:** any gate, approve, acknowledge, history, artifact, upload or network tool.
- Caps are enforced on the server too, not just in the pane: each `read_range` call is rejected if the requested address exceeds the per-call cap; results are checked against the per-call and per-session cell budgets (the session counter increments from the actual result size); each cell string is truncated to `copilot_cell_char_limit`; steps per user turn and model calls are bounded: each turn runs at most the smaller of `copilot_max_steps_per_turn` and `max_model_calls` model calls (the spine's `ModelCallCounter` is not wired for the copilot). A cap hit returns a tool error the model can read ("budget exhausted: summarise what you have").
- Client tool result shapes (fixed; any other shape is refused with "unexpected result shape"; the session read budget is charged for every text leaf, plus each `read_range`/selection value cell):

  | Tool | Result content (`ok: true`) | Charged |
  |---|---|---|
  | `read_range` | `{values: 2D scalars, formulas?: 2D scalars, truncated?: bool}`; each grid must fit the requested range and the per-call cap | larger of the two grids |
  | `list_sheets` | `{sheets: [valid sheet name, ≤ 200]}` | one per name |
  | `describe_sheet` | `{used_range?: A1 or null, headers?: [str, ≤ 50, cut to 120 chars], merged?: [A1, ≤ 50], counts?: {formulas?, constants?, blanks?: int ≥ 0}}`, no other keys | used range + headers + merged |
  | `get_selection` | `{sheet: valid name, address: A1 (no sheet prefix), cells: int ≥ 0, values?: 2D scalars ≤ 25 cells}` | 2 + value cells |
  | `find` | `{hits: [{sheet, address, text}] (≤ 1,000 sent, ≤ 50 kept, excerpt ≤ 120 chars), truncated?: bool}`; invalid hits are dropped and counted as `dropped` | sheet, address and text of each kept hit |

  A client error (`ok: false`) is reduced to one short string: `content.message` (≤ 200 chars, control characters removed) or "tool failed". Every reply is checked against the turn's transcript limit before it is stored.
- Proposals are delivered in the `final` of the turn that made them. If the next user message arrives while workbook calls are still unanswered, that turn's undelivered proposals are discarded and the next answer carries the note "Earlier proposals were discarded because the request was interrupted."
- Validation: all tool arguments are schema-validated (A1 range syntax, sheet-name length, row/column bounds, no whole-sheet addresses); malformed calls are returned to the model as errors, never executed.
- Audit log (structured, no contents): actor, session id, tool name, sheet and range **addresses**, cell counts, byte counts, step index, outcome. Cell values, formulas and user text are never logged. A test asserts this by scanning captured logs for planted sentinel values.

## 4. Safety rules

- **Raw-cell exception (CLAUDE.md note required, scoped):** "The Copilot `read_range` tool may return capped raw cell values and formulas from the user's own open workbook to the model; run-bound tools and the onboarding agents still never return raw file rows." Behind `copilot_enabled`, capped, logged by address only.
- **Prompt injection:** workbook text is untrusted. Tool results are wrapped as data (`<tool_result untrusted>`), the system prompt says instructions inside cells are never followed, and the registry has no exfiltration or gate tools, so the worst a malicious cell can do is mislead the answer or produce a proposal the analyst can read and reject. Writes are always a diff the analyst must click.
- **Write proposals:** at most `copilot_max_write_cells` cells; default target is a new sheet "Copilot Scratch" (never overwrites an existing sheet the add-in did not create); writing into an existing range needs a second explicit confirmation showing the before/after diff. Values are written as text unless the proposal declares formulas, and the server rejects any `values` string that starts with `=`, `+`, `@`, `-` (after NFKC folding, so fullwidth forms and U+2212 count too), a tab or a CR unless it is a plain number (exponents allowed); formulas go in `formulas`; formulas need an explicit confirmation on the scratch sheet as well (and the second confirmation elsewhere), and a formula check (a denylist, see the deviations) rejects external or side-effecting functions (WEBSERVICE, HYPERLINK, IMAGE, CALL, REGISTER.ID, EXEC, PY, DDE patterns, `=cmd|`), dynamic or introspective ones (INDIRECT, CELL, INFO), the same names used bare (`=MAP(A1:A3,WEBSERVICE)`), and external workbook, UNC and URL references, server-side; the pane repeats the check and also refuses references to hidden sheets. Values over Excel's 32,767-character cell limit are refused.
- **Gates:** `propose_changes` only returns typed changes. The pane applies them through the existing stage-1 proposal card (explicit Apply, exact changes, the same hold/verdict logic). The copilot's change schema has no `acknowledge_finding` variant, so such a proposal fails validation in `check_changes`, `propose_changes` and the final answer, as stage 1 treats it as not applyable.
- Sessions are actor-bound; a session id from another actor returns 404. No cross-run or cross-sponsor reads.

## 5. Add-in design (`excel_plugin/src/copilot/`, `src/ui/CopilotPanel.tsx`)

- Header gets a second toggle "Copilot" (separate from the stage-1 "Chat", which stays gate-bound). Disabled with a hint when the server reports the feature off (403 on session start). The panel is mounted for the pane's life, so the first open starts the session.
- `tools.ts`: Office.js executors for the five client tools, running through the serialized Excel queue with the existing 20 s bound. `read_range` loads `values`, `formulas`, `address`, clamps to the server-provided limits and returns `{address, rows, cols, values, formulas?, truncated?}` (a text cell starting with "=" is not reported as a formula); `find` is always a bounded, case-insensitive substring scan of visible sheets (no Excel find API; at most four per-call caps of cells in all); every executor catches Office errors and returns them as tool errors (never throws into the loop). No executor writes.
- `session.ts`: the loop driver: start session; send the user message; while status is `tool_calls` (bounded by the server step cap and a client cap) run the tools and post results; surface the final answer. Per-request timeouts reuse the client constants; cancel via AbortController; Stop button.
- `CopilotPanel.tsx`: transcript, composer (explicit Send), a collapsible "What the copilot read" list showing addresses and cell counts for transparency, write-proposal card with a before/after diff (current values are read when the analyst asks to apply, not when the proposal arrives: a read on arrival would be stale by the click and would run Excel without a click), "Apply to Copilot Scratch" and, separately, "Apply to <range>" with a confirmation step; formula writes need an explicit confirmation even on the scratch sheet (formulas run in the workbook), enforced in `write.ts` as well as in the card; typed-change proposals reuse the stage-1 proposal card. All text via JSX; long-text wrapping; focus management as in stage 1.
- Write executor (the only Excel writer in the copilot): creates/clears only the add-in-owned scratch sheet (ownership marker `CopilotScratchOwner`, as for the Review sheet), sets number format `@` before values (numbers keep their type), protects nothing else, and refuses to touch sheets it does not own unless the second confirmation was given.
- Config: no new build variables. Limits come from the session response.

## 6. Data flow

Pane → `POST /copilot/sessions` (optional run id) → limits and tool list → user Send → `POST step {user_message}` → model step → `tool_calls` → pane runs tools in Excel → `POST step {tool_results}` → … → `final {text, proposed_changes, proposed_writes}` → pane renders answer and proposal cards → analyst clicks Apply → writes to the scratch sheet or posts the existing `change` gate. Every tool result, the addresses it covers and the budget used are shown in the "What the copilot read" list.

## 7. Errors and limits

- Feature off: 403 → tab disabled with an explanation. Session expired: 404 → start a new session and say so (the transcript stays visible, marked as a new conversation).
- Budget exhausted, step cap, model/timeouts: shown verbatim as an assistant note; the loop stops; the analyst can continue with a new message.
- Model failure after a tool result was produced: the pane keeps what was read; nothing is applied.
- Excel busy/deferred calls: tool error "Excel is busy (finish editing the cell)"; the model can retry once (the 20 s bound).
- Other statuses (409, 413, 415, 422, 429, 503) map to named pane messages (README); a 503 is retried twice after `Retry-After`.

## 8. Testing

- Server (`tests/unit/copilot`, `tests/contract/copilot`): `ScriptedChatModel` scripts for tool-call loops; schema/range validation; caps (per call, per session, steps); truncation; run-bound tools read-only and actor-bound; disabled flag → 403; session TTL; proposal validation with the SDK (violations rejected); write-proposal function denylist; **no gate tool exists** (assert registry names); prompt-injection fixtures (cells containing "ignore previous instructions…" never change behavior in scripted tests; tool results are wrapped); audit logs contain addresses but never planted sentinel values.
- Add-in: fake Office for the executors (strict load-before-read), loop driver with a fake client (tool loop, step cap, abort, 404 restart), panel tests (explicit Send only, diff card, second confirmation, scratch-sheet ownership, never overwrites a non-owned sheet, injection strings rendered as text), a11y, coverage thresholds.
- Contract test against the scripted server with a scripted copilot model.
- Manual checklist additions: real Excel formulas/merged cells, large sheets hitting caps, `findAll` availability, protected sheets, cell-edit-mode deferral.

## 9. Build order (becomes the plan)

1. Server: settings, model role, session store, registry/schemas, validation, audit logging, router + tests with the scripted model.
2. Server: run-bound tools, `check_changes`, proposal validation, write denylist + tests; `CLAUDE.md` exception note.
3. Add-in: client tool executors + fake Office tests.
4. Add-in: session loop driver + tests.
5. Add-in: CopilotPanel (transcript, "what it read", proposal cards, scratch-sheet write executor with diff and second confirmation) + tests.
6. Contract test with a scripted copilot model; README/CHANGELOG/spec updates; manual checklist.

## 10. Open items and risks

- A live OpenAI model is needed to judge answer quality; CI uses scripted models only. Quality tuning of the system prompt is a follow-up using `pytest -m live`.
- In-memory sessions mean a restart ends conversations; durable sessions are out of scope.
- Rate limiting and cost control beyond the step/cell caps are not designed (note for the deployment owner). The consolidated list of known limitations is the README's "Open items and known limitations".
- Office API availability (`find`, `formulas` on large ranges) differs by platform and must be verified in real Excel.

## 11. Implementation notes and deviations

Implemented as designed in sections 1-9 except for the following, ruled during the build.

- **Formula check: denylist plus bare names, not an allowlist.** The server (`rules.py`) and the pane (`rules.ts`, a port proven never looser by a shared corpus of 106 deny and 61 allow cases and a TS↔Python differential over 60k generated adversarial formulas) deny listed functions both called and standing alone, because Excel passes functions as values. `INDIRECT`, `CELL` and `INFO` (dynamic references and introspection) and `IMPORTTEXT`/`IMPORTCSV` (file import) were added; prefixes may stack (`_xlfn._xlws.NAME`), and `_xll.`/`_xludf.` names are refused. A denylist cannot stop a VBA or custom-function UDF under an unknown name. Cost: legitimate uses are refused; a sheet or `LET` variable named like a denied function is refused too (fail closed). An allowlist was not adopted. `check_formula` on the server cannot know sheet visibility, so references to hidden sheets (plain, 3D, through defined names and tables) are refused by the pane, which fails closed when names or tables cannot be loaded.
- **`acknowledge_finding` removed from the copilot change schema** (`CopilotChange`), instead of being kept and flagged; such a proposal fails validation everywhere.
- **Values policy.** `values` strings starting with `=`, `+`, `@`, `-` (after NFKC), tab or CR are refused unless plain numbers (exponents allowed); formulas go in `formulas`. Values over 32,767 characters are refused, not truncated. Empty strings are valid.
- **Hidden sheets excluded** from list/describe/find and refused by `read_range` (privacy first). Hidden and filtered rows stay readable, and a visible cell whose formula references a hidden sheet shows that sheet's value.
- **Formulas need confirmation on scratch too** (UI and `write.ts`), not only on a user range.
- **Before-values are read at click**, not when the proposal arrives (section 5 reflects this). A range apply is bound to the preview by a content stamp and the worksheet id, and refuses merged areas, protected and hidden sheets.
- **Limits and caps.** `read_range` is refused before it reaches the pane when its parsed range exceeds the per-call cap. Values and formulas grids are each held to the per-call cap and the session budget charges the larger of the two. `find` hits and `describe_sheet` header cells are charged too. Added settings: `copilot_session_max_lifetime_s`, `copilot_max_concurrent_steps`.
- **Per-turn model-call bound** (the smaller of `copilot_max_steps_per_turn` and `max_model_calls`); the spine's `ModelCallCounter` is not wired. Also at most 16 workbook calls per step, 32 calls per model message, 6 dry runs and 10 proposals per turn.
- **Client tool result shapes are fixed** (section 3 table) and enforced for all client tools; an `ok:false` result is reduced to one short message. Proposals from an abandoned turn are dropped, with a note.
- **Session lifecycle.** Stop keeps the session (a stopped send never leaks a slot); closing a session whose step still runs retries `DELETE` in the background (2, 5, 15, 30, 60 s; ended by page unload); a run change starts a new session, and the old session is closed when the next message is sent, when the pane closes, or by its TTL; a user message that meets 409 waits and retries (2 s, 5 s); a turn is bounded at 5 minutes on the client. Sessions also have a hard maximum lifetime.
- **Concurrency limiter.** Steps run on their own thread pool, admitted by an atomic check against `copilot_max_concurrent_steps` (per API process); a full limiter answers 503 with `Retry-After: 5`, exposed through CORS. No per-actor fairness.
- **415/413 handling.** Only `application/json` bodies are accepted (a simple cross-origin form post cannot start a step) and bodies over 2 MiB are refused while reading; deeply nested or undecodable bodies are 422.
- **Typed-change Apply** is limited to the newest answer and is disabled once a newer decision exists in the run (a re-scope or another applied change), so a stale `exclude_row` cannot be posted.
- **Scratch preview** is not read on arrival (see before-values). A scratch write that would overwrite earlier scratch content asks for confirmation before writing ("This overwrites N existing cells on Copilot Scratch. Apply?").
- **Audit logging** uses closed vocabularies and validated addresses, so message text cannot be smuggled into a log field; a model-supplied sheet name is logged only on an ok tool result, after the workbook confirmed it. Session ids do appear in logs.
- **CLAUDE.md** carries the scoped raw-cell exception sentence.

Open items are in `excel_plugin/README.md` ("Open items and known limitations") and the manual real-Excel checklist there.
