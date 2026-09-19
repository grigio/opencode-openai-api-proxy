# opencode-openai-api-proxy
OpenAI `/v1/*` → opencode v2.0.5 (`reasoning_content`).

## Run
`OPENCODE_SERVER_PASSWORD=secret ./start-proxy.sh` — seeds `password`+`auth.json`, starts `opencode serve --port 4097` if needed, healthchecks, then `node proxy/index.ts:45` (Node ≥23.6, host FS). Docker: `docker compose up -d` (`entrypoint.sh:94`).
Ports `4096` proxy Bearer vs `4097` server Basic `opencode:<password>`. Session `directory` from `Current working directory:` or `X-Working-Directory`/`OPENCODE_PROJECT_DIR` (`proxy/v2-client.ts:171`).

## Env
`OPENCODE_SERVER_PASSWORD` required. `OPENCODE_TOOL_CALLING=auto|agent|direct` — `auto` zen-direct non-streaming anonymous (`403`→`agent` fallback `proxy/utils.ts:387`, streaming skips zen `proxy/routes/*:360`). `OPENCODE_API_KEY`/`ZEN_BASE_URL`, `ZEN_DIRECT_ENABLED=1`. Single-instance `previous_response_id` 30m `proxy/state.ts:11`.

## Clients
Codex (`wire_api = "responses"`): bundled catalog only has `gpt-*`; `opencode/*` without `model_catalog_json` falls back and disables `apply_patch` (`tools/spec_plan.rs:312`, `model_info_from_slug` fallback). Fix: `codex debug models --bundled > /tmp/b.json && python3 scripts/generate-codex-catalog.py /tmp/b.json ~/.codex/opencode-catalog.json` then `model_catalog_json = "~/.codex/opencode-catalog.json"` in `~/.codex/config.toml`. Prefer `opencode/muse-spark-1.3-contributor-free` for code (mimo weak on tool calls). Anonymous free tier streaming is forced to `server-agent` (`proxy/routes/*:360` `payg-blocked` skip) — writes land in the proxy host's workspace (host FS via `start-proxy.sh:94`, container FS via `docker compose` volume), so use project-relative paths not `/tmp`. For client-side `apply_patch` (local FS) set `OPENCODE_API_KEY` (or `opencode auth login`) so `zen-direct` succeeds.
Pi (`~/.pi/agent/models.json` / `settings.json`): proxy accepts bare `mimo-v2.5-free` (pi short ids default to `opencode/`). Set `{"defaultProvider":"opencode","defaultModel":"muse-spark-1.3-contributor-free"}`. Free tier also needs `OPENCODE_TOOL_CALLING=agent`; `write`/`read` respect `X-Working-Directory`/`OPENCODE_PROJECT_DIR` (`proxy/v2-client.ts:171`) — set it when Docker container can't see host path.

## Skills
`~/.pi/agent/skills/*` → `~/.config/opencode/skills/`. `read` sandboxed to session `location.directory` hangs on `~/.pi` from `/tmp` — use `bash cat` (`proxy/utils.ts:109`).

## Dev
`cd proxy && npm run typecheck && npm test` — native type stripping, mocks `V2Client`+`fetch` SSE.
