# Affiliate live eval — before/after the code fast path

Model: gpt-5.6-luna (EVAL_MODEL; identical in both runs, from empty sponsor history each fixture).

## Before (scope-only: every upload worked by the supervisor agent)

| fixture | pass | questions | corrections | model calls | wall s |
|---|---|---|---|---|---|
| clean.csv | ✓ | 0 | 0 | 7 | 20.7 |
| edge.csv | ✓ | 0 | 0 | 21 | 87.6 |
| empty.csv | ✓ | 0 | 0 | 12 | 41.0 |
| extra_columns.csv | ✓ | 0 | 0 | 16 | 46.9 |
| titled.xlsx | ✓ | 0 | 0 | 7 | 17.9 |
| renamed.xlsx | ✓ | 0 | 0 | 6 | 18.2 |
| ids_missing.csv | ✓ | 0 | 0 | 16 | 46.2 |
| two_sheets.xlsx | ✓ | 1 | 0 | 11 | 32.6 |
| returning_sponsor.xlsx | ✓ | 0 | 0 | 0 | 0.1 |
| **total** | **9/9** | 1 | 0 | **96** | **311.2** |

## After (code fast path: unambiguous uploads draft in code and go straight to the brief gate)

| fixture | pass | questions | corrections | model calls | wall s |
|---|---|---|---|---|---|
| clean.csv | ✓ | 0 | 0 | 0 | 0.1 |
| edge.csv | ✓ | 0 | 0 | 0 | 0.1 |
| empty.csv | ✓ | 0 | 0 | 0 | 0.1 |
| extra_columns.csv | ✓ | 0 | 0 | 0 | 0.1 |
| titled.xlsx | ✓ | 0 | 0 | 0 | 0.1 |
| renamed.xlsx | ✓ | 0 | 0 | 6 | 79.7 |
| ids_missing.csv | ✓ | 0 | 0 | 0 | 0.0 |
| two_sheets.xlsx | ✓ | 1 | 0 | 12 | 37.2 |
| returning_sponsor.xlsx | ✓ | 0 | 0 | 0 | 0.0 |
| **total** | **9/9** | 1 | 0 | **18** | **117.4** |

## Before/after

Total model calls dropped from 96 to 18 (−81.3%, gate: ≥ 40%); total wall time from 311.2 s to 117.4 s
(−62.3%) — 9/9 fixtures pass in both runs. The six fast-path fixtures (clean, edge, empty, extra_columns,
titled, ids_missing) now draft entirely in code: 79 agent model calls → 0, and 260.3 s of wall time →
under 1 s combined. The fixtures that must still scope behave unchanged: `renamed.xlsx` scopes with the
same 6 calls, `two_sheets.xlsx` scopes with 1 question (11 → 12 calls, live-model variance), and
`returning_sponsor.xlsx` still replays from confirmed history with 0 calls.

Caveat: the matcher's internal LLM call is not counted in `ctx.model_calls`.

Note: live-model latency varies between runs — `renamed.xlsx` cost the same 6 calls as before but more
wall time (18.2 s → 79.7 s) in this run; per-fixture wall-time comparisons are only meaningful on the
fast-path fixtures, where no model is invoked.

## Evaluation 2026-10-07T10:39:14.615611+00:00

Model: gpt-5.6-luna

| fixture | pass | questions | corrections | model calls | wall s |
|---|---|---|---|---|---|
| clean.csv | ✓ | 0 | 0 | 0 | 0.2 |
| edge.csv | ✓ | 0 | 0 | 0 | 0.1 |
| empty.csv | ✓ | 0 | 0 | 0 | 0.2 |
| extra_columns.csv | ✓ | 0 | 0 | 0 | 0.2 |
| titled.xlsx | ✓ | 0 | 0 | 0 | 0.2 |
| renamed.xlsx | ✓ | 0 | 0 | 7 | 23.8 |
| ids_missing.csv | ✓ | 0 | 0 | 0 | 0.1 |
| two_sheets.xlsx | ✓ | 1 | 0 | 11 | 35.1 |
| returning_sponsor.xlsx | ✓ | 0 | 0 | 0 | 0.0 |

Passed: 9/9. Agent model calls: 96 → 18 (81.2% reduction).
Matcher-internal LLM calls are not counted in ctx.model_calls.
