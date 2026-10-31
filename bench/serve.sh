#!/usr/bin/env bash
# Serves one agent's app in production mode, with its scenario's API, so you can look
# around in a browser. Everything runs in the scenario's base image (built on first use),
# so the agent's code never runs on the host. Ctrl-C stops it.
#
#   bench/serve.sh runs/<id>/<framework>-<n> [port]
#
# The app is at http://localhost:<port> (default 3000) and the API at <port> + 6000, so two
# apps can run side by side: `bench/serve.sh runs/x/astro-1` and `bench/serve.sh runs/x/next-1 3001`.
# LATENCY_MS sets the API's added latency (default 30, as in dex-tracker's tests and measurements).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ITER="$(cd "${1:?usage: bench/serve.sh runs/<id>/<framework>-<n> [port]}" && pwd)"
PORT="${2:-3000}"
API_PORT=$((PORT + 6000))
LATENCY_MS="${LATENCY_MS:-30}"

SCENARIO="$(node -p "require('$ITER/../config.json').scenario ?? 'pokedex'")"
TEMPLATE="$ROOT/scenarios/$SCENARIO/template"
IMAGE="$SCENARIO-base"
TARBALL="$ITER/agent/repo.tar.gz"
[ -f "$TARBALL" ] || { echo "No $TARBALL" >&2; exit 1; }

# The same base image bench/run.mjs builds and runs the tests in.
if ! podman image exists "$IMAGE"; then
  CTX="$(mktemp -d)"
  "$ROOT/bench/container/export-template.sh" "$TEMPLATE" "$CTX/work"
  podman build -t "$IMAGE" -f "$ROOT/bench/container/Containerfile.base" \
    --build-arg "NODE_VERSION=$(cat "$TEMPLATE/.nvmrc")" "$CTX"
  rm -rf "$CTX"
fi

REPO="$(mktemp -d)"
trap 'rm -rf "$REPO"' EXIT
tar -xzf "$TARBALL" -C "$REPO"

echo "Serving $(basename "$ITER") ($SCENARIO) at http://localhost:$PORT (API at http://localhost:$API_PORT) once it's built"
# Ports are the same inside and outside the container, so API URLs work from the app's
# server and from the browser alike.
podman run --rm -it --init -p "$PORT:$PORT" -p "$API_PORT:$API_PORT" \
  -v "$REPO/app:/src:ro,Z" \
  -e "PORT=$PORT" -e "HOST=0.0.0.0" -e "API_PORT=$API_PORT" -e "LATENCY_MS=$LATENCY_MS" \
  "$IMAGE" bash -c '
    set -e
    cp -r /src app
    PORT=$API_PORT PUBLIC_URL=http://localhost:$API_PORT node api/server.mjs &
    export API_BASE_URL=http://localhost:$API_PORT
    cd app
    npm install --no-audit --no-fund --include=dev
    NODE_ENV=production npm run build
    NODE_ENV=production exec npm start'
