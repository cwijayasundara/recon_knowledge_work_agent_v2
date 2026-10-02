---
name: onboarding-method
description: How to scope an upload, judge column bindings with evidence, ask at most two questions, and write the onboarding brief.
---

# Onboarding method

You scope one upload for one sponsor. Code decides every accounting rule; you
decide what the file *is* and explain it. The analyst approves.

## Scope, in order

1. `profile_upload` — sheets, header candidates, columns, samples, fingerprint.
2. `recall_recipe` — if this sponsor has an approved recipe for this fingerprint,
   say so in the brief (`recipe.kind = "recalled"`) and reuse its layout.
3. Pick the sheet and header row. One sheet that looks like a list: take it.
   Several plausible sheets: ask (that is one question).
4. `resolve_columns(sheet, header_row)`.
   - `matched` fields: keep them.
   - `needs_review` fields: judge them with the `evidence` block. `id_like`
     values (`AFF_\d+`, unique, no spaces) suit `affiliate_id`; `name_like`
     values (legal names: LLC, L.P., S.a r.l.) suit `affiliate_name`.
     Choose a column only when the evidence is clear; otherwise ask.
   - No plausible ID column: bind `affiliate_id` to None. IDs will be derived
     from the name, which raises warnings the analyst acknowledges.
5. Recipe:
   - one table under one header row (title rows above and a trailing total
     row are fine) → `write_standard_recipe`;
   - anything else (several tables, data split across sheets, pivoted
     layouts) → `propose_bindings`, then delegate to `recipe-engineer` with
     the `task` tool, then `register_authored_recipe`.
6. `submit_brief`.

## Never guess a binding

Never bind a column that is not in the header. Never pick between two
plausible columns without evidence; ask instead.

## Questions (at most two)

Each question states the evidence and offers concrete options, e.g.
"Two sheets look like affiliate lists: 'Affiliates' (8 rows) and
'Affiliates (old)' (5 rows). Which is current?" with options
`["Affiliates", "Affiliates (old)"]`. Set `target` to what the answer
changes: `sheet`, `header_row`, `affiliate_id`, `affiliate_name`.
Ask nothing you can settle from evidence.

## The brief

- `source`: file, sheet, header row. Counts are filled in by code.
- `bindings`: one entry per field with a one-line `evidence` string.
- `id_strategy`: `source_id` when every row has an ID column value,
  `derive_from_name` when there is no ID column, `mixed` otherwise.
- `expected_findings`: the finding codes you expect (see the affiliate skill).
- `confidence`: your confidence the brief is right, 0–1.
- `summary`: two sentences a finance analyst can read.
