#!/usr/bin/env bash
# Start the workbench UI on :3000 against the API started by scripts/start-backend.sh.
#
#   scripts/start-frontend.sh                       # API at http://localhost:8000
#   API_URL=http://localhost:8001 scripts/start-frontend.sh
#   PORT=3001 scripts/start-frontend.sh
set -euo pipefail
cd "$(dirname "$0")/../web"
port="${PORT:-3000}"
# shellcheck source=scripts/_ports.sh
source ../scripts/_ports.sh
free_port "$port" "next-server|next dev" "workbench"

[[ -d node_modules ]] || pnpm install

export NEXT_PUBLIC_API_URL="${API_URL:-http://localhost:8000}"
if [[ -f ../.env ]]; then
  token=$(grep -E '^ONB_API_TOKEN=' ../.env | cut -d= -f2- | tr -d '"' || true)
  [[ -n "$token" ]] && export NEXT_PUBLIC_API_TOKEN="$token"
fi
export NEXT_TELEMETRY_DISABLED=1

curl -sf "$NEXT_PUBLIC_API_URL/health" >/dev/null || echo "warning: no API at $NEXT_PUBLIC_API_URL yet (start scripts/start-backend.sh)"
echo "Workbench on http://localhost:$port (API $NEXT_PUBLIC_API_URL)"
exec npx next dev -p "$port"
