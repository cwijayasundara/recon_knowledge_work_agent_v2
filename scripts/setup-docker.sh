#!/usr/bin/env bash
# Local Docker resources for manual testing:
#   - Postgres (pgvector/pg17) on localhost:55433: runs, decisions, recipes, mapping history, checkpoints
#   - the onb-sandbox image the recipe engineer runs in
#
#   scripts/setup-docker.sh           # start Postgres, build the sandbox image
#   scripts/setup-docker.sh --check   # also run the docker- and db-marked tests (db tests use onboarding_test)
#   scripts/setup-docker.sh --down    # stop Postgres (data is kept in the pgdata volume)
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null; then
  echo "docker is not installed" >&2
  exit 1
fi

if [[ "${1:-}" == "--down" ]]; then
  docker compose stop postgres
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  if [[ "$(uname)" == "Darwin" && -d /Applications/Docker.app ]]; then
    echo "Starting Docker Desktop…"
    open -a Docker
  fi
  for _ in $(seq 1 90); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  docker info >/dev/null 2>&1 || { echo "the Docker daemon did not start; start Docker and rerun" >&2; exit 1; }
fi

echo "Starting Postgres…"
# A stopped container can still reference a compose network that has since been recreated
# ("network ... not found"); recreating the container fixes it and keeps the pgdata volume.
if ! docker compose up -d postgres; then
  echo "Recreating the Postgres container (data in the pgdata volume is kept)…"
  docker compose up -d --force-recreate postgres
fi
for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q postgres)")" == "healthy" ]] && break
  sleep 1
done
echo "Postgres is up: postgresql://onboarding:onboarding@localhost:55433/onboarding"
# The db-marked tests use their own database so they never write into the workbench's runs.
docker compose exec -T postgres psql -U onboarding -d onboarding -tAc \
  "SELECT 1 FROM pg_database WHERE datname = 'onboarding_test'" | grep -q 1 \
  || docker compose exec -T postgres createdb -U onboarding onboarding_test
echo "Test database: postgresql://onboarding:onboarding@localhost:55433/onboarding_test"

echo "Building the sandbox image (onb-sandbox)…"
docker build -q -t onb-sandbox -f sandbox/Dockerfile . >/dev/null
echo "Sandbox image built."

if [[ "${1:-}" == "--check" ]]; then
  ONB_TEST_DATABASE_URL=postgresql://onboarding:onboarding@localhost:55433/onboarding_test \
    uv run pytest -q -m "docker or db"
fi

cat <<'MSG'

Next:
  scripts/start-backend.sh --db     # API on :8000 with Postgres and the Docker sandbox
  scripts/start-frontend.sh         # workbench on :3000
MSG
