# Affiliate eval

Run `pytest -q -m live tests/live/test_affiliate_eval.py` with `OPENAI_API_KEY`; it writes fixture-level
results and the before/after summary to the repository root. When an analyst answer, instruction, change,
or sign-off rejection matters, `finalize` captures a case in the object store. Review it, then promote the
case with its synthetic upload using `scripts/promote_regression.py --i-confirm-synthetic`; committed cases
replay in `tests/regression/test_cases.py` without a model. See
`docs/fast-path-regression-plan.md` for the capture and replay contract.

For a correction from a real run, first regenerate a synthetic twin and repeat the corrections on that
twin in a fresh workbench run. Review the new case's instruction text, actors, bindings, and change
payloads as well as the upload; all committed content must be synthetic. Promote the synthetic run's
case (not the original client case): the script rejects any twin whose SHA differs from the captured
upload, preserving the independently verified CSV outcome. For example:

```sh
uv run python scripts/promote_regression.py \
  --case regression/synthetic-sponsor/run-id.json \
  --name reviewed-correction --twin /path/to/synthetic.csv --i-confirm-synthetic
uv run pytest -q tests/regression
```

The two seeded cases cover a sheet-selection answer and ID overrides with warning acknowledgements.
CI replays each case and checks locked status, bindings, and CSV SHA; unused or mislabeled decisions
also fail with the divergent decision and an outcome diff. The replay model is scripted for these
affiliate fixtures; new supervisor-dependent scenarios also need an appropriate offline model script.

Live eval requires Docker's `onb-sandbox` image and a configured model key. It requires all nine
fixtures to pass, zero agent calls on the six fast-path fixtures, and ≥40% fewer calls than the
96-call baseline. `eval_summary.md` retains prior tables; `eval_results.jsonl` holds the latest run.
Matcher-internal LLM calls are excluded from the agent counter.
