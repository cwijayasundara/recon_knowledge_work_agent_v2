# Sourced by the start scripts. free_port PORT PATTERN LABEL:
# if PORT is held by an earlier copy of this server (its command matches PATTERN),
# stop it; if something else holds it, say what and exit.
free_port() {
  local port=$1 pattern=$2 label=$3 pids pid cmd
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  [[ -z "$pids" ]] && return 0
  for pid in $pids; do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    if [[ "$cmd" =~ $pattern ]]; then
      echo "Stopping the previous $label on :$port (pid $pid)"
      kill "$pid"
    else
      echo "Port $port is in use by pid $pid: $cmd" >&2
      echo "Stop it, or pick another port (--port for the backend, PORT=... for the frontend)." >&2
      exit 1
    fi
  done
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  echo "Port $port is still in use after stopping the previous $label" >&2
  exit 1
}
