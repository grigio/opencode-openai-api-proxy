#!/bin/bash

# Define default UID and GID if not provided
PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Adjust the GID of the node group if necessary
if [ "$(id -g node)" -ne "$PGID" ]; then
    groupmod -o -g "$PGID" node
fi

# Adjust the UID of the node user if necessary
if [ "$(id -u node)" -ne "$PUID" ]; then
    usermod -o -u "$PUID" node
fi

# Ensure config and data folders belong to the node user.
# This fixes the EACCES error you are seeing.
# Only run chown when ownership does not already match: named volumes are
# created with the image owner, and bind mounts (./project) should not have
# their ownership rewritten on every boot.
fix_ownership() {
    local path="$1"
    if [ -e "$path" ] && [ "$(stat -c '%u' "$path")" != "$PUID" ]; then
        chown -R "node:node" "$path"
    fi
}

fix_ownership /home/node/.local/share/opencode
fix_ownership /home/node/.config/opencode
fix_ownership /home/node/project

# OPENCODE_API_KEY bootstrap: declarative management of the zen "opencode"
# auth entry so both the server and the proxy use the key and it survives
# restarts (opencode_data volume). Seeded entries carry a marker:
#   - env set   -> entry written/updated on every boot (rotation: update .env,
#                  docker compose up -d)
#   - env unset -> our marked entry is removed (back to anonymous free tier)
# Entries written by `opencode auth login` (or any entry without our marker)
# are never touched. Note: there is no usable "anonymous" zen key - keyless
# requests are exactly the rate-limited free tier.
seed_auth_key() {
    node -e '
        const fs = require("fs");
        const path = require("path");
        const p = "/home/node/.local/share/opencode/auth.json";
        const MARKER = "bootstrap:opencode-openai-api-proxy";
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
    chown "$PUID:$PGID" /home/node/.local/share/opencode /home/node/.local/share/opencode/auth.json 2>/dev/null
    if [ -n "$OPENCODE_API_KEY" ]; then
        echo "Seeded OPENCODE_API_KEY into /home/node/.local/share/opencode/auth.json"
    fi
}
seed_auth_key

# Check if we are running the default server command
if [[ "$1" == "opencode" && "$2" == "serve" ]]; then
    echo "Initializing OpenCode Super Mode (Server + Proxy)"
    
    # Start the OpenCode server in the background
    # We ensure it listens on 4097 (Internal)
    # The CMD in Dockerfile already sets --port 4097, so "$@" carries that.
    echo "Starting OpenCode Server on internal port 4097..."
    gosu node "$@" &
    SERVER_PID=$!
    
    # Wait for the server to be responsive (respect OPENCODE_SERVER_PORT/TARGET_PORT, default 4097)
    local_port=${OPENCODE_SERVER_PORT:-${TARGET_PORT:-4097}}
    echo "Waiting for OpenCode Server to become available on ${local_port}..."
    MAX_RETRIES=30
    COUNT=0
    while ! curl -s --max-time 2 http://127.0.0.1:${local_port}/global/health > /dev/null; do
        if [ $COUNT -ge $MAX_RETRIES ]; then
            echo "Timeout waiting for OpenCode Server."
            kill $SERVER_PID
            exit 1
        fi
        
        # Check if process is still running
        if ! kill -0 $SERVER_PID 2>/dev/null; then
            echo "OpenCode Server process died unexpectedly."
            exit 1
        fi
        
        sleep 1
        COUNT=$((COUNT+1))
    done
    echo "OpenCode Server is up!"

    # Start the Proxy
    echo "Starting OpenAI Proxy on port 4096..."
    # Run the proxy natively with Node's built-in TypeScript type stripping.
    # Requires Node >= 23.6 (type stripping on by default); the node:lts-slim
    # base image satisfies this.
    exec gosu node node /usr/src/proxy/index.ts
else
    # Execute the command passed to the container using gosu to drop root privileges
    exec gosu node "$@"
fi
