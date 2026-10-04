# Onboarding workbench

An agentic workbench that turns a sponsor's raw Investran exports into Sage Intacct import files. The first slice is
the **Affiliate** static entity.

Agents propose, code decides, humans approve: accounting rules, finding codes and the publish gate live in
`packages/onboarding_sdk`, and the LangGraph spine owns the approval gates (brief → findings → sign-off).

## Prerequisites

- Python 3.12 and [`uv`](https://docs.astral.sh/uv/)
- Node.js 22+ and `pnpm` (workbench UI)
- Docker (Postgres and the sandbox image; optional for a quick in-memory run)
- The `string_matcher_v1` repo checked out as a sibling at `../../advance_research/string_matcher_v1`. Its
  `attribute_mapper` package is the column-matching engine. To use a different location, edit
  `[tool.uv.sources]` in `pyproject.toml` and set `ONB_STRING_MATCHER_PATH`.
- An OpenAI API key for real agent runs (not needed for the scripted/offline mode)

## Setup

```bash
uv sync --all-extras --dev
cp .env.example .env        # then set OPENAI_API_KEY (and anything else you need)
cd web && pnpm install && cd ..
```

Key settings in `.env` (all prefixed `ONB_`, see `src/onboarding_agent/config.py`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | | Required for real model runs |
| `ONB_SUPERVISOR_MODEL`, `ONB_RECIPE_ENGINEER_MODEL` | `gpt-5.6-terra` | Agent models |
| `ONB_DATABASE_URL` | empty (in memory) | Postgres for runs, checkpoints and mapping history |
| `ONB_OBJECT_ROOT` | `var/objects` | Where uploads and generated files are stored |
| `ONB_SANDBOX_BACKEND` / `ONB_SANDBOX_IMAGE` | `docker` / `onb-sandbox` | Isolated sandbox for the recipe engineer |
| `ONB_API_TOKEN` | empty | Optional bearer token for the API (the frontend script picks it up) |
| `ONB_COPILOT_ENABLED` | `false` | Enables the Excel Copilot routes (`/copilot/*`); caps are the other `ONB_COPILOT_*` settings |
| `ONB_COPILOT_MAX_CONCURRENT_STEPS` | `8` | Copilot steps running at once per API process; more get 503 |

## Run the platform locally

### 1. Offline demo (no API key, no Docker)

Runs the API with a deterministic fixture agent instead of a live model:

```bash
scripts/start-backend.sh --scripted     # API on http://localhost:8000
scripts/start-frontend.sh               # workbench on http://localhost:3000
```

### 2. Real agent, in-memory storage

```bash
scripts/start-backend.sh                # reads OPENAI_API_KEY from .env; runs are lost on restart
scripts/start-frontend.sh
```

Without the `onb-sandbox` image, layouts that need the recipe engineer will fail; build it with step 3.

### 3. Real agent with Postgres and the Docker sandbox (recommended)

```bash
scripts/setup-docker.sh                 # starts Postgres on :55433, builds the onb-sandbox image
scripts/start-backend.sh --db           # API on :8000 backed by Postgres
scripts/start-frontend.sh               # workbench on :3000
```

Open http://localhost:3000, pick a sponsor (`sponsor-a` and `sponsor-b` are seeded by default) and upload an
Investran Affiliate export. The Intacct Affiliates template is built in, so there is nothing to load on the Intacct
side. See [Sample Affiliate files](#sample-affiliate-files) for what to upload.

Useful options:

```bash
scripts/start-backend.sh --model gpt-5.6-luna   # override the agent model
scripts/start-backend.sh --port 8001
API_URL=http://localhost:8001 PORT=3001 scripts/start-frontend.sh
scripts/setup-docker.sh --down                  # stop Postgres (data is kept in the volume)
```

### 4. Full stack in Docker Compose

```bash
scripts/vendor_matcher.sh               # build the attribute_mapper wheel the API image needs
docker compose build sandbox            # the per-run sandbox image
docker compose up -d --build            # postgres, api (:8000) and web (:3000)
```

The API container mounts the Docker socket to start sandbox containers; this is for local development only.

## Sample Affiliate files

Synthetic Investran exports for trying the agent are in `tests/fixtures/affiliate/`; the expected outcome of each is in
`tests/fixtures/affiliate/expected/<name>.json`. A suggested order, from simplest to hardest:

| File | What it exercises | What to expect |
| --- | --- | --- |
| `clean.csv` | The happy path: 8 affiliates with IDs and names | Columns map with no questions, no findings, 8 rows in `Affiliates.csv` |
| `extra_columns.csv` | Six distractor columns (type, parent, status, country…) and one blank ID | Only ID and name are mapped; row 3 gets a derived ID (`AFF_WARN_ITEM_ID_DERIVED`) |
| `ids_missing.csv` | No ID column at all | Every `ITEM_ID` is derived from the name; one warning per row to acknowledge |
| `titled.xlsx` | Title rows above the header (header on row 4), a trailing "Total" row and a Notes sheet | Header and sheet found automatically; the total row is dropped |
| `renamed.xlsx` | Non-standard headers (`Affi Name`) plus distractors (`Zip Code`, `Created By`, `Notes`) | One question to confirm the column mapping |
| `two_sheets.xlsx` | Two candidate sheets, `Affiliates` and `Affiliates (old)` | One question asking which sheet is current (answer `Affiliates`) |
| `edge.csv` | Every Affiliate rule at once: blank row, ID over 30 characters, duplicate ID, derived IDs, truncation collision, stripped characters (`O'Hare &`), name over 100 characters | Four errors that block sign-off until fixed in the grid, plus warnings to acknowledge (see below) |
| `empty.csv` | Header only, no data rows | `AFF_WARN_ZERO_RECORDS`; an empty output once acknowledged |
| `returning_sponsor.xlsx` | Same layout as `renamed.xlsx` with new values | Upload after `renamed.xlsx` for the **same** sponsor: the confirmed mapping is replayed from history, with no questions and zero model calls |

To clear the errors in `edge.csv`, exclude row 1 (blank row), and override `ITEM_ID` on row 2 (e.g. `AFF_9999`), row 4
(`AFF_9011`) and row 6 (`CASCADE_EMP_COINV_BETA`).

Mapping history is per sponsor and is written only after you confirm a mapping. To see the `renamed.xlsx` question
again, use the other sponsor (or restart an in-memory backend). The same files work from the CLI, e.g.
`uv run onboard run affiliate tests/fixtures/affiliate/edge.csv --sponsor sponsor-a`.

## Command line

Run an onboarding in the terminal instead of the UI:

```bash
uv run onboard run affiliate tests/fixtures/affiliate/clean.csv --sponsor sponsor-a
uv run onboard history sponsor-a        # the sponsor's confirmed column bindings
uv run onboard serve                    # API only, on :8000
```

At each gate the CLI prints the brief, findings or artifacts and waits for a command:

| Command | Effect |
| --- | --- |
| `a` / `approve` | Approve the open gate |
| `answer <question_id> <option>` | Answer a question in the brief |
| `i <text>` / `instruct <text>` | Give the agent an instruction |
| `apply` | Apply the agent's current proposal |
| `ack-warnings` | Acknowledge every warning that needs it |
| `change <json>` | Apply explicit changes |
| `r [reason]` / `reject [reason]` | Reject the run |

`--yes` approves every gate automatically (you are the approver).

## Tests and checks

```bash
uv run ruff check . && uv run ruff format --check .
uv run mypy src packages
uv run pytest -q                        # offline: unit, golden, differential, contract (scripted model)
scripts/setup-docker.sh --check         # docker- and db-marked tests
uv run pytest -q -m live                # live eval; needs OPENAI_API_KEY
cd web && pnpm typecheck && pnpm e2e    # Playwright e2e against a scripted API
```

Regenerate the Affiliate fixtures with `uv run python scripts/generate_fixtures.py`.

## Troubleshooting

- **`ModuleNotFoundError` for `attribute_mapper`, `onboarding_sdk` or `onboarding_agent` outside pytest (macOS).**
  The venv's editable `.pth` files were flagged hidden and Python 3.12 skips them. The start scripts already set
  `PYTHONPATH`; for other commands set
  `PYTHONPATH=src:packages/onboarding_sdk:../../advance_research/string_matcher_v1/src`.
- **"Port 8000 is in use".** The start scripts stop an earlier copy of themselves but not other processes. Stop the
  other process or use `--port` / `PORT=`.
- **"Postgres is not reachable on :55433".** Run `scripts/setup-docker.sh` before `start-backend.sh --db`.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/onboarding_agent/` | Agents, LangGraph spine, tools, middleware, API and CLI surfaces |
| `packages/onboarding_sdk/` | Deterministic accounting rules, findings, publish gate and rendering |
| `web/` | Next.js workbench UI |
| `sandbox/` | Sandbox image for the recipe engineer's code execution |
| `tests/` | Unit, golden, differential, contract, e2e and live tests; fixtures |
| `infra/` | Azure deployment (Bicep); see `infra/README.md` |
| `docs/` | Build plan, Affiliate business rules, UI spec |
