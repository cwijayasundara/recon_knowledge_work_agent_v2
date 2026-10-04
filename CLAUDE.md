# CLAUDE.md: working in this repository

This repository builds an **agentic onboarding workbench** that turns a sponsor's raw Investran exports into Sage Intacct import files. The first slice is the **Affiliate** static entity. Read `docs/mvp-affiliate-plan.md` before doing anything. It is the build plan, broken into ordered tasks with acceptance checks.

## Read first

1. `docs/mvp-affiliate-plan.md`: what to build, in which order, and how to prove each step.
2. `docs/reference/affiliate-flow.md`: the business process and rules for Affiliate (the source of truth).
3. `docs/ui-spec.md` and `docs/ui-mockup.html`: the workbench UI.
4. The external repo `../../advance_research/string_matcher_v1` (path configurable via `STRING_MATCHER_PATH`). Its `attribute_mapper` package is our column-matching engine, and its `docs/sample_data/affiliate/*` files are the golden fixtures.

## Non-negotiable rules

- **Runtime models are OpenAI only.** Use `gpt-5.6-terra` locally and `gpt-5.6-sol` or `gpt-6-astra` on Azure OpenAI. Never add Anthropic or Claude models, `langchain-anthropic`, or the Claude Agent SDK as runtime dependencies. (You, the coding agent, are Claude; the product is not.)
- **Agent harness:** LangChain **Deep Agents** (`deepagents` 0.7.x) on open-source LangGraph. No LangSmith, LangGraph Agent Server, or Managed Deep Agents at runtime.
- **Accounting rules are code, never prompts.** ID derivation, dedup, truncation, finding codes, the publish gate and rendering live in `packages/onboarding_sdk`. Agents propose; code decides; humans approve.
- **Gates are code.** The LangGraph spine owns phases and approvals. An agent can never pass a gate, acknowledge a warning, write mapping history or produce a final file.
- **Mapping history is per sponsor.** Always call `attribute_mapper` with `tenant_id=<sponsor_id>`. Never write or read `tenant_id="*"`. Write history only after analyst confirmation.
- **The sandbox is isolated.** The coding agent's `execute` runs only in the sandbox container: no secrets, no network, upload mounted read-only.
- **Don't copy large chunks of `string_matcher_v1`.** Depend on `attribute_mapper` as a package. The Affiliate rules are ported deliberately (task S3) and proven equal by a differential test.
- **Copilot raw-cell exception:** the Copilot `read_range` tool may return capped raw cell values and formulas from the user's own open workbook to the model (flag `ONB_COPILOT_ENABLED`, caps in `copilot_*`, addresses logged but never contents); run-bound tools and the onboarding agents still never return raw file rows.
- **Keep the client generic.** Never write a real client, fund administrator or person's name into code, fixtures, prompts or docs. Use "sponsor", "fund administrator", `sponsor-a`.

## Commands

```bash
uv sync --all-extras --dev          # install
uv run ruff check . && uv run ruff format --check .
uv run mypy src packages
uv run pytest -q                    # offline: unit, golden, differential, contract (scripted model)
uv run pytest -q -m live            # needs OPENAI_API_KEY (.env is read): live eval on gpt-5.6-luna (ONB_EVAL_MODEL overrides)
docker compose up -d postgres       # local Postgres (checkpoints + history)
docker build -t onb-sandbox -f sandbox/Dockerfile .  # sandbox image (repo root context)
scripts/setup-docker.sh [--check]   # start Postgres, build the sandbox image (--check: run docker/db tests)
scripts/start-backend.sh [--db] [--model M] [--scripted]  # API on :8000 with the real agent (key from .env)
scripts/start-frontend.sh           # workbench on :3000 against the API
uv run onboard run affiliate <file> --sponsor sponsor-a   # CLI run
uv run onboard serve                # API on :8000
cd web && pnpm dev                  # workbench UI on :3000
cd web && pnpm e2e                  # Playwright e2e: starts a scripted API (no live model) and the UI
uv run python -m tests.e2e.serve_scripted --port 8000   # offline demo API driven by the fixture agent
scripts/vendor_matcher.sh           # build the attribute_mapper wheel for container images
uv run python scripts/generate_fixtures.py              # regenerate tests/fixtures/affiliate (deterministic)
cd excel_plugin && pnpm check        # Excel add-in: typecheck, lint, tests, production build + bundle check
cd excel_plugin && pnpm test:contract  # add-in client against the scripted API (needs uv, STRING_MATCHER_PATH)
cd excel_plugin && pnpm dev          # add-in dev server on https://localhost:3100 (sideload manifest.dev.xml)
```

If imports of `attribute_mapper`, `onboarding_sdk` or `onboarding_agent` fail outside pytest on macOS, the venv's
editable `.pth` files were flagged hidden (Python 3.12 skips them). pytest (`pythonpath`) and mypy (`mypy_path`) are
unaffected; for other commands set `PYTHONPATH=src:packages/onboarding_sdk:../../advance_research/string_matcher_v1/src`.

## Conventions

- Python 3.12, `uv`, type hints everywhere, `pydantic` v2 models at boundaries, frozen dataclasses inside.
- One shared assembly (`src/onboarding_agent/assembly.py`) builds models, tools, middleware and agents for the CLI, API and tests. Don't fork it per surface.
- Tools return compact JSON summaries plus artifact ids. Never return raw file rows to a model.
- Every new behaviour gets a test. Graph behaviour is tested with the scripted model (`tests/support/scripted_model.py`), never with a live model in CI.
- Small diffs, direct code, no speculative abstractions. Comments explain constraints, not history.
- Don't commit, push, deploy or call live models unless asked.
