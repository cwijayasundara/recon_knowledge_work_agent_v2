# Roadmap: knowledge-work automation on this workbench

Thesis: the knowledge worker here is a coding agent with skills, tools, and a workspace. This document
states where the codebase already embodies that thesis, where it falls short, and the ordered work to
close the gap. Sources that shaped it:

- _How we built LangChain's Paid Media Agent_ (LangChain blog): model judges / code computes; system
  prompt as a map; one runtime with capability profiles; analysis → action with permissions and
  verification; optimize for completion, not vibes.
- _Building secure agents for knowledge work_ (Anthropic × Every): skills as distilled expert taste; a
  compounding loop that captures corrections and folds them back; one shared agent that improves because
  everyone invests in it; infra primitives (sandbox, memory, sessions) bought, not built.

Companion: `docs/fast-path-regression-plan.md` is the detailed implementation plan for K1 + K2.

## Where we already match the references

| Pattern (source) | Implementation | Proof |
|---|---|---|
| Model judges, code computes (LC) | `onboarding_sdk` rules/findings/gates; `recipes.standard()` with no model; gate predicates in `graph/gates.py` | Golden + differential tests |
| Prompt is a map, knowledge in files (LC) | 3-line `instructions/*.md` → `workspace/skills/{onboarding-method,affiliate,recipe-authoring}` | Eval: 0–1 questions per fixture |
| Skills portable / company knowledge separate (LC) | `onboarding-method` is generic; sponsor knowledge in per-tenant history + `AGENTS.md` notes | `returning_sponsor.xlsx` replays with 0 model calls |
| One runtime, capability profiles (LC) | Supervisor modes with `ToolSurfacePolicy` (`agents/supervisor.py`) | Contract tests per mode |
| Analysis → action with approval + verification (LC) | Typed changes → dry-run → human gate → code applies; `manifest.json` | Contract tests; locked runs immutable |
| Equip the hire (LC/Every) | Network-off sandbox, skills, ontology, evidence | Sandbox test suite |
| Work trial over SAT scores (Every) | Fixture suite + scripted analyst, `eval_results.jsonl` | 9/9 pass |

## K1 · Code fast path for unambiguous first-time files  — P0

A first-time `clean.csv` costs ~7 model calls / ~21 s because the supervisor always runs in scope mode,
even though profile, resolution, `recipes.standard()` and the brief gate are all code. Draft the brief in
code when the upload is unambiguous; keep the supervisor summonable at the gate. Same move LangChain made
when a reporting run went 18 min → 85 s.

- Files: `graph/nodes.py` (resolve routing), new `graph/fastpath.py`, `config.py`.
- Trigger: no recall; exactly one list-like sheet; name resolves `matched` (score ≥ threshold);
  ID resolves `matched` or `unmapped` (→ derive); standard recipe passes its check.
- The brief gate still interrupts. `answer`/`instruct`/`change` fall back to `scope` unchanged.
- Accept: `clean.csv`, `extra_columns.csv`, `titled.xlsx`, `edge.csv`, `ids_missing.csv`, `empty.csv`
  finish with **0 agent model calls**, byte-identical outputs; `two_sheets.xlsx` and `renamed.xlsx`
  still scope; live-eval total model calls drop ≥ 40 %.

## K2 · Corrections become regression evals  — P0

`run_decisions` records every analyst answer, instruction and change — the raw material for Every's
"distil the expert's taste" loop, currently written and never read. At `finalize`, runs whose log shows an
analyst correction emit a *case* (steps + outcome hashes) to the object store. A promotion script copies
reviewed, **synthetic** cases into `tests/regression/cases/`; an offline replay runner turns each into a
CI test.

- Files: new `regression/capture.py`, `scripts/promote_regression.py`, `tests/regression/`.
- Rule: only synthetic twins of real uploads are ever committed (no client data in the repo);
  cases carry codes/counts, never cell values.
- Accept: a correction-bearing eval run produces a case; the promoted case fails CI if the agent
  regresses on the same decision.

## K3 · Real identity and roles on the gates  — P0

`actor` is a dev bearer token; anyone with it can pass sign-off. Both references make per-user permission
checks a requirement before real data flows. Entra ID on the API (already scoped in Phase 9 of the MVP
plan), two roles — *analyst* (fix, ack) and *approver* (sign-off) — recorded in `run_decisions` and the
manifest.

- Accept: sign-off requires the approver role; manifest and decision ledger carry Entra identities.

## K4 · The curation run: skills and ontology improve from usage  — P1

Extend K2 from tests to knowledge: an offline job mines completed runs across sponsors (correction
patterns, `needs_review` → confirmed bindings, route distributions) and emits *proposals* — ontology
alias additions, edits to `workspace/skills/`, new fixtures. Proposals land behind a human review gate;
nothing writes automatically. Tenant isolation holds because only code sees raw decisions and proposals
carry aggregates.

- Accept: an alias learned from sponsor-a's corrections matches sponsor-b's unfamiliar header; a test
  asserts no cross-sponsor payload in any proposal.

## K5 · Sponsor wiki, analyst-editable  — P1

The per-sponsor knowledge layer is 500-char `AGENTS.md` hints. Make it a structured profile (layout
habits, engagement quirks, signer) the analyst edits in the workbench and the supervisor reads through
its existing `/notes/` route. Human-curated; the note tool stays the only model write.

## K6 · Ambient intake  — P1

The agent only works when an analyst uploads. Add a watched drop folder / mailbox that starts runs
automatically, and drift alerts: a returning sponsor's fingerprint changes → "replay won't trigger,
layout changed" notification instead of a silent full-scope run. (The paid-media agent's Monday-cron
lesson: a proactive surface, same runtime.)

## K7 · Entity pack contract + a second entity  — P2

"Platform" is a claim until entity #2 exists. Define the pack — ontology + `flows/<entity>.flow.yaml` +
skill + `onboarding_sdk.entities.<entity>` + fixtures + expected outputs — and port one more entity
(customers or balances) through it. The coding agent does the port; golden + differential tests prove it.

## K8 · Fold the Copilot into the spine  — P2

`copilot/engine.py` is a second runtime (documented deviation). LangChain paid for that split and undid
it: one graph, capability profiles per entry point. Keep the copilot's caps/audit/client-tool design;
rebuild it as a fourth supervisor mode through the one assembly. Schedule with K7, when duplication
would start to bite.

## K9 · Cost and quality dashboard  — P2

Track `eval_results.jsonl` over time (questions, corrections, model calls, wall time per fixture per
model) so K1/K4 wins are visible and model swaps are judged on completion rate — not vibes.

## Non-goals

- **No critic/verifier agent.** `gates.brief_blockers()` already verifies brief-vs-recipe consistency in
  code; a second model would be weaker and costlier.
- **No cross-sponsor history.** The `tenant_id != "*"` guard is untouched; K4 aggregates, never shares rows.
- **No managed-agent hosting swap** (Deep Agents 0.7.x stays); revisit only if sandbox/session primitives
  become the bottleneck.

## Order

P0 (K1, K2 → K3) → P1 (K4, K5 → K6) → P2 (K7, K8 → K9). K1+K2 are detailed in
`docs/fast-path-regression-plan.md`.
