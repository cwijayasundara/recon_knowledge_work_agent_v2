#!/usr/bin/env bash
# Start the API for manual testing with the real agent (OpenAI key from .env).
#
#   scripts/start-backend.sh                  # in-memory stores (runs are lost on restart)
#   scripts/start-backend.sh --db             # Postgres from scripts/setup-docker.sh
#   scripts/start-backend.sh --model gpt-5.6-luna
#   scripts/start-backend.sh --scripted       # no model: the deterministic fixture agent
#   scripts/start-backend.sh --port 8001
set -euo pipefail
cd "$(dirname "$0")/.."

port=8000
use_db=0
scripted=0
model=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) use_db=1 ;;
    --scripted) scripted=1 ;;
    --model) model="$2"; shift ;;
    --port) port="$2"; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

# shellcheck source=scripts/_ports.sh
source scripts/_ports.sh
free_port "$port" "onboarding_agent\.surfaces\.api|tests\.e2e\.serve_scripted" "API"

# Imports must not depend on the venv's editable .pth files (they can be flagged hidden on macOS).
export PYTHONPATH="$PWD:$PWD/src:$PWD/packages/onboarding_sdk:$PWD/../../advance_research/string_matcher_v1/src"

if [[ $scripted -eq 1 ]]; then
  echo "API on http://localhost:$port with the fixture agent (no model calls)"
  exec uv run --no-sync python -m tests.e2e.serve_scripted --port "$port"
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
[[ -n "${OPENAI_API_KEY:-}" ]] || { echo "OPENAI_API_KEY is not set (add it to .env)" >&2; exit 1; }

export ONB_OBJECT_ROOT="${ONB_OBJECT_ROOT:-var/objects}"
export ONB_SEED_SPONSORS="${ONB_SEED_SPONSORS:-sponsor-a:Sponsor A,sponsor-b:Sponsor B}"
if [[ -n "$model" ]]; then
  export ONB_SUPERVISOR_MODEL="$model" ONB_RECIPE_ENGINEER_MODEL="$model"
fi

if [[ $use_db -eq 1 ]]; then
  export ONB_DATABASE_URL="postgresql://onboarding:onboarding@localhost:55433/onboarding"
  (echo >/dev/tcp/localhost/55433) 2>/dev/null || { echo "Postgres is not reachable on :55433; run scripts/setup-docker.sh" >&2; exit 1; }
else
  export ONB_DATABASE_URL=""
fi

if docker info >/dev/null 2>&1 && docker image inspect onb-sandbox >/dev/null 2>&1; then
  export ONB_SANDBOX_BACKEND=docker
  sandbox="Docker (onb-sandbox)"
else
  sandbox="NOT AVAILABLE: layouts that need the recipe engineer will fail (run scripts/setup-docker.sh)"
fi

cat <<MSG
API on http://localhost:$port
  models:   supervisor ${ONB_SUPERVISOR_MODEL:-gpt-5.6-terra}, recipe engineer ${ONB_RECIPE_ENGINEER_MODEL:-gpt-5.6-terra}
  storage:  $([[ $use_db -eq 1 ]] && echo "Postgres localhost:55433" || echo "in memory (lost on restart)"); files in $ONB_OBJECT_ROOT
  sandbox:  $sandbox
  sponsors: $ONB_SEED_SPONSORS
MSG
exec uv run --no-sync python -m uvicorn --factory onboarding_agent.surfaces.api:app_factory --host 127.0.0.1 --port "$port"
