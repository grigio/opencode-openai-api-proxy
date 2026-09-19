#!/usr/bin/env bash
set -euo pipefail

# start-proxy.sh — run the OpenCode + proxy stack without Docker/podman.
# Fixes pi/opencode `read`/`write` resolving to `/home/node/project` inside
# the container: when the server runs on the host its project `location.directory`
# is the host cwd, so `agent` tools (`proxy/streaming/agent.ts`) operate on
# local files. `client` tool-calling (zen-direct/direct) is unaffected.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$SCRIPT_DIR/proxy"
PROXY_PORT="${PROXY_PORT:-4096}"
PROXY_HOST="${PROXY_HOST:-0.0.0.0}"
SERVER_PORT="${OPENCODE_SERVER_PORT:-${TARGET_PORT:-4097}}"
OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-}"
OPENCODE_API_KEY="${OPENCODE_API_KEY:-}"
ZEN_CLIENT_VERSION="${ZEN_CLIENT_VERSION:-2.0.5}"

if [[ -z "$OPENCODE_SERVER_PASSWORD" ]]; then
  echo "OPENCODE_SERVER_PASSWORD is not set. Refusing to start without authentication." >&2
  exit 1
fi

# --- seed password ---
mkdir -p "$HOME/.local/state/opencode"
printf '%s' "$OPENCODE_SERVER_PASSWORD" > "$HOME/.local/state/opencode/password"
chmod 600 "$HOME/.local/state/opencode/password"

# --- seed OPENCODE_API_KEY ---
node -e '
  const fs = require("fs"), path = require("path"), os = require("os");
  const MARKER = "bootstrap:opencode-openai-api-proxy";
  const dataHome = process.env.XDG_DATA_HOME || path.join(process.env.HOME || os.homedir(), ".local", "share");
  const p = path.join(dataHome, "opencode", "auth.json");
  let auth = {};
  try { auth = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  const entry = auth.opencode;
  const ours = !!entry && typeof entry === "object" && entry.metadata?.bootstrap === MARKER;
  if (entry && !ours) process.exit(0);
  if (!process.env.OPENCODE_API_KEY) {
    if (!fs.existsSync(p)) process.exit(0);
    delete auth.opencode;
    fs.writeFileSync(p, JSON.stringify(auth, null, 2), { mode: 0o600 });
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  auth.opencode = { type: "api", key: process.env.OPENCODE_API_KEY, metadata: { bootstrap: MARKER } };
  fs.writeFileSync(p, JSON.stringify(auth, null, 2), { mode: 0o600 });
'

# --- find opencode binary ---
OPENCODE_BIN=""
if command -v opencode >/dev/null 2>&1; then OPENCODE_BIN="opencode"
elif command -v lildax >/dev/null 2>&1; then OPENCODE_BIN="lildax"
elif command -v opencode2 >/dev/null 2>&1; then OPENCODE_BIN="opencode2"
else
  echo "No opencode binary found." >&2
  exit 1
fi

health_ok() {
  local port="$1"
  local b64
  b64="$(printf '%s:%s' "${OPENCODE_SERVER_USERNAME:-opencode}" "$OPENCODE_SERVER_PASSWORD" | base64 | tr -d '\n')"
  curl -s -f --max-time 2 -H "Authorization: Basic $b64" "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1 || curl -s -f --max-time 2 -H "Authorization: Basic $b64" "http://127.0.0.1:${port}/global/health" >/dev/null 2>&1
}

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if health_ok "$SERVER_PORT"; then
  echo "OpenCode server already healthy on 127.0.0.1:$SERVER_PORT"
else
  echo "Starting OpenCode server ($OPENCODE_BIN serve --hostname 0.0.0.0 --port $SERVER_PORT)..."
  "$OPENCODE_BIN" serve --hostname 0.0.0.0 --port "$SERVER_PORT" &
  SERVER_PID=$!
  MAX_RETRIES=30; COUNT=0
  while ! health_ok "$SERVER_PORT"; do
    if [[ $COUNT -ge $MAX_RETRIES ]]; then echo "Timeout" >&2; exit 1; fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then echo "died" >&2; exit 1; fi
    sleep 1; COUNT=$((COUNT+1))
  done
  echo "OpenCode Server is up!"
fi

export ZEN_CLIENT_VERSION
export OPENCODE_SERVER_PORT="$SERVER_PORT"
export PROXY_PORT
export PROXY_HOST

if [[ ! -d "$PROXY_DIR/node_modules" ]]; then
  (cd "$PROXY_DIR" && npm ci --omit=dev 2>&1 | tail -20)
fi

echo "Starting OpenAI Proxy on $PROXY_HOST:$PROXY_PORT -> 127.0.0.1:$SERVER_PORT ..."
exec node "$PROXY_DIR/index.ts"
