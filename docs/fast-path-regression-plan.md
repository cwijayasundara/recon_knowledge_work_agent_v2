# Implementation plan: code fast path (K1) and correction regressions (K2)

Audience: the engineer (and Claude Code) implementing roadmap items K1 and K2. Work top to bottom; each
task has an **acceptance check** that must pass before moving on. Companion: `docs/knowledge-work-roadmap.md`
(motivation and sources), `docs/mvp-affiliate-plan.md` (style and constraints, still binding).

## 0. Decisions already made

| Topic | Decision |
|---|---|
| Gate behaviour | Unchanged. The brief gate interrupts on the fast path; the analyst still approves. `answer`/`instruct`/`change` at the gate fall back to `scope` as today |
| History writes | Unchanged. Only `_approve_brief` confirms bindings (`resolver.confirm`) |
| Fast-path trigger | Conservative and configurable: exactly one list-like sheet; name resolves `matched` with score ≥ `ONB_FASTPATH_MIN_SCORE`; ID resolves `matched` or `unmapped` (→ derived); standard recipe passes `recipes.check` |
| Fallback | Any unmet condition → `scope` with the supervisor, reusing the spine's resolution where possible |
| Routes | No new `Route` values. Fast-path routes come from the resolver; `affiliate_id=None` keeps route `None` |
| Regression cases | Captured at `finalize` into the object store. Only **synthetic twins** of uploads are ever committed to `tests/`; cases carry codes/counts, never cell values |
| Replay | Offline only: scripted model + scripted analyst. No live model in CI |
| Eval honesty | The matcher's internal LLM call is not counted in `ctx.model_calls`; note this in the eval summary rather than changing the counter |

## 1. Definition of done

- `clean.csv`, `extra_columns.csv`, `titled.xlsx`, `edge.csv`, `ids_missing.csv`, `empty.csv` complete
  with **0 agent model calls** and byte-identical outputs versus today's expectations.
- `two_sheets.xlsx` and `renamed.xlsx` still take the supervisor path (`renamed.xlsx`'s fuzzy scores are
  below the default threshold; pin per-fixture in tests).
- Live eval rerun shows ≥ 40 % fewer total model calls with all 9 fixtures still passing;
  `returning_sponsor.xlsx` still replays with 0.
- A correction-bearing run writes a regression case to the object store; a promoted case runs offline in
  CI and fails if the agent's recorded decision regresses.

## 2. Phase F — the fast path

### F1. Resolve the candidate sheet in the spine (code)
- `graph/nodes.py::resolve`: on the non-replay path, pick the **candidate sheet** = the single sheet with
  `looks_like_list ≥ ONB_FASTPATH_MIN_LIST` (config; none or several → no candidate). Call
  `ctx.resolver.resolve(sponsor_id, headers, run_id=ctx.run_id)` for its profiled header row and store the
  `ResolutionSet` in `ctx.resolution` plus a summary in state.
- The supervisor's `resolve_columns` tool keeps its behaviour (it may re-resolve the same sheet; identical
  inputs give identical results).
- **Acceptance:** unit tests — a one-sheet CSV resolves in `resolve`; `two_sheets.xlsx` yields no candidate;
  an unfamiliar-header file still resolves (fuzzy/LLM routes come from the resolver, unchanged).

### F2. `graph/fastpath.py::draft(ctx) -> BriefDraft | None`
- Extract the standard-recipe body of the `write_standard_recipe` tool into a shared helper
  (`set_layout` → `recipes.standard` → `recipes.check` → `ctx.candidate_recipe`); the tool calls it too.
  No behavioural change to the tool.
- `draft` runs the trigger conditions of §0 against the candidate sheet's profile and resolution, calls the
  helper, and builds the brief in code:
  - `bindings` from the resolution, `route`/`score` per field, `evidence` from the resolver's evidence
    (samples, pattern, fill) — one line per field;
  - `id_strategy` `source_id` / `derive_from_name` / `mixed` from ID-column coverage;
  - `recipe.kind = "standard"`, `expected_findings = []` (the field defaults), `questions = []`,
    `confidence` = min(resolution scores), `summary` = "Proposed by code from the profile and column
    resolution. Approve, or instruct to change it."
  - Returns `None` on any unmet condition (check fails, several list-like sheets, `needs_review` fields,
    score below threshold).
- The brief must satisfy `gates.brief_blockers` by construction (same bindings and layout as the recipe).
- **Acceptance:** unit tests pin the draft/None table for all nine fixtures plus a synthetic
  two-list-sheet case; a drafted brief passes `brief_blockers` against its own recipe.

### F3. Wire the routing
- `graph/nodes.py::resolve` sets `fastpath: bool` (and the brief via `ctx.brief`) when `draft` returns one;
  `graph/build.py` routes `resolve → gate_brief` directly in that case, skipping `scope`.
- `gate_brief` needs no changes: it reads `ctx.brief` / `ctx.candidate_recipe` and handles
  `answer`/`instruct`/`change → scope` already. `model_calls` stays 0 because no agent is built.
- **Acceptance (contract, scripted model):** the scripted model asserts **it is never called** for the six
  fast-path fixtures; `two_sheets.xlsx` and `renamed.xlsx` still reach `scope`; a gate `instruct` on a
  fast-path run invokes the supervisor with the analyst input (existing behaviour, new test).
- **Acceptance (output parity):** the six fixtures produce byte-identical `Affiliates.csv` and the same
  finding sets as `tests/fixtures/affiliate/expected/*.json`.

### F4. Settings
- `ONB_FASTPATH` (default `true`), `ONB_FASTPATH_MIN_LIST` (default `0.5`),
  `ONB_FASTPATH_MIN_SCORE` (default `0.95`), prefix `ONB_`, validated in `config.py`.
- **Acceptance:** settings tests for parsing and ranges; `ONB_FASTPATH=false` restores today's path
  (contract test).

### F5. Live eval, before/after
- Re-run `pytest -q -m live tests/live/test_affiliate_eval.py`; append the after-table to
  `eval_summary.md` next to the current numbers, plus the matcher-LLM note from §0.
- **Acceptance:** all 9 fixtures pass; total model calls drop ≥ 40 %; per-fixture wall time improves on
  the six fast-path fixtures; `returning_sponsor.xlsx` unchanged (0 calls).

## 3. Phase R — corrections become regression evals

### R1. `regression/capture.py::derive_case(...) -> dict | None`
- Input: run id, sponsor/entity, fingerprint, upload key + sha, decision log, final snapshot
  (bindings, recipe origin, output sha, finding codes).
- A case exists when the log contains any of: `brief.answer`, `brief.instruct`, `brief.change`,
  `findings.change`, `findings.instruct`, `signoff.reject`.
- Case schema (versioned):
  `{version, run_id, sponsor_id, entity, fingerprint, fixture, upload: {sha256}, outcome: {status,
  bindings, csv_sha256, finding_codes}, steps: [{seq, kind, payload, actor}]}`.
  `payload` holds typed changes, question answers and instruction text only — never cell values.
- **Acceptance:** unit tests — each kind triggers capture; a clean approve-only run captures nothing;
  schema validation round-trips.

### R2. Capture at `finalize`
- Behind `ONB_REGRESSION_CAPTURE` (default `true`). On capture, store the case at
  `regression/<sponsor>/<run_id>.json` in the object store. The decision log, gates and manifest are
  untouched; capture only reads.
- **Acceptance:** contract test — an `edge.csv` run with an ID override locks **and** leaves a case whose
  `outcome.csv_sha256` matches the run's artifact sha; `ONB_REGRESSION_CAPTURE=false` writes nothing.

### R3. `scripts/promote_regression.py`
- Copies a case from the object store into `tests/regression/cases/<name>.json` and a **synthetic twin**
  of the upload into `tests/fixtures/regression/`. Refuses to write unless `--i-confirm-synthetic` is
  passed; prints a review summary (case steps, fingerprint, outcome) first.
- The twin must hash to the case's `upload.sha256` (the case pins committed bytes; production uploads are
  never committed — regenerate with `scripts/generate_fixtures.py` patterns instead).
- **Acceptance:** script tests in `tests/unit` with a tmp object store: refusal without the flag, round-trip
  with it, mismatched twin sha rejected.

### R4. Offline replay runner
- `tests/regression/test_cases.py` + a steps-driven scripted analyst in `tests/support/`: for each
  committed case, run the workbench (in-memory stores, scripted model), upload the twin, replay the
  recorded steps at the gates, and assert: status `locked`, bindings equal, CSV sha equal.
- Generalize the gate-driving loop from `tests/live/test_affiliate_eval.py::_analyst` into
  `tests/support/` so the live eval and the replay runner share one implementation.
- **Acceptance:** the runner is green offline (`uv run pytest -q tests/regression`); a deliberately broken
  step replay fails with a diff of the diverging decision.

### R5. Seed the corpus
- Promote one case from the current scripted runs end-to-end (the `two_sheets.xlsx` answer step, and one
  `edge.csv` change step) via R3's script, committing case + twins.
- **Acceptance:** `uv run pytest -q` runs the two cases offline in CI; the eval README documents how a
  correction becomes a case (one paragraph, `docs/` cross-link from the roadmap).

## 4. Order of work

```
F1 F2 F3 F4   ┃   R1 R2        # spine fast path ┃ capture (independent)
F5            ┃   R3 R4 R5     # eval after      ┃ promotion + replay
```

F5 needs F1–F4; R3–R5 need R1–R2. The two phases share no files and can proceed in parallel.

## 5. Guardrails for the implementer

- The brief gate still interrupts on the fast path. If a task tempts you to auto-approve a code-drafted
  brief, stop: the gate is the product.
- History is still written only in `_approve_brief`. The fast path resolves and drafts; it never confirms.
- No new `Route` values, no resolver changes, no gate predicate changes.
- Cases and twins never contain real names or client data; the promotion script's flag exists so a human
  means it.
- Replay tests run on the scripted model. If a test needs a live model, it belongs under `tests/live`.
- Keep diffs small: extract the standard-recipe helper rather than duplicating it; don't restructure
  `nodes.py` beyond the `resolve` routing.

## 6. Open items to settle during the build (non-blocking)

- Thresholds `ONB_FASTPATH_MIN_LIST` / `ONB_FASTPATH_MIN_SCORE`: start at 0.5 / 0.95, tune against the
  nine fixtures so `renamed.xlsx` stays on the supervisor path unless its scores justify the fast path.
- Whether `renamed.xlsx` should eventually fast-path on high fuzzy scores (test decides; eval measures).
- Case schema version bump policy when the second entity lands (the `entity` field is already in the case).
- Whether `ctx.model_calls` should also count the matcher's internal LLM calls (currently not counted;
  record the decision in `eval_summary.md` when settled).
