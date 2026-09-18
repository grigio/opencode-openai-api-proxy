# opencode-openai-api-proxy

Proxy that makes **opencode v2.0.5-identical** requests to the backend and exposes an OpenAI-compatible API (`/v1/chat/completions`, `/v1/responses`, `/v1/models`).

## Architecture

- **Ports:** `4096` OpenAI proxy (Bearer `OPENCODE_SERVER_PASSWORD`), `4097` opencode server (Basic `opencode:<password>`). `entrypoint.sh` boots the server, health-checks `/api/health`, then runs the proxy via Node native type stripping (Node ≥23.6).
- **V2 client `proxy/v2-client.ts`:** Speaks `/api/session` (create), `/api/session/:id/model` (`{model:{providerID,id}}`), `/api/session/:id/prompt` (`{text, files:[{uri,name}], agents, skills}`), `/api/provider` & `/api/model` (both return `{location,data}`), and `GET /api/event` SSE. Handles `204`/`""` bodies and `{prompt:{}}`↔`{text}` fallback.
- **Gateway `proxy/model-gateway.ts`:** Resolves `provider/model` → `{baseUrl, apiKey, supportsImages}`. Anonymous `opencode/*` uses `ZEN_BASE_URL` (`https://zenmux.ai/api/v1` via `ZenmuxPlugin`) plus real affinity headers; authenticated (`OPENCODE_API_KEY`/`auth.json`) uses provider `apiKey`. Retries `408/429/5xx` and network resets (non-streaming only, `UPSTREAM_MAX_RETRIES`).
- **Routing `proxy/routes/*` + `proxy/streaming/*`:** `auto` (default) → zen-direct for anonymous `opencode/*` (client executes tools, system head injected, real `ses_…`/`projectID` + `User-Agent: opencode/<channel>/2.0.5/opencode` + `HTTP-Referer`/`X-Title` for zenmux; `403 FreeTierError` → server-agent fallback), `direct` → always provider gateway, `agent` (`OPENCODE_TOOL_CALLING=agent`) → server-agent (tools run in-container). Both `flat` and `nested` tool definitions are normalized.
- **State:** `proxy/state.ts` stores `previous_response_id` continuations in-memory (30 min TTL, LRU 1000) — single instance only.
- **Images `proxy/prompts.ts`+`proxy/image.ts`:** `image_url`→`data:` URI via SSRF-safe fetch (`resolveSafeImageUrl`, `redirect:manual`, 20 MB/10 s), then `POST /prompt` as `files:[{uri:data:…}]`. Stripped/retried for text-only models (DeepSeek family).

## Key env

`OPENCODE_SERVER_PASSWORD` (required), `OPENCODE_API_KEY`/`ZEN_BASE_URL`/`ZEN_CLIENT_VERSION=2.0.5`/`OPENCODE_TOOL_CALLING=auto|agent|direct`/`TOOL_LOOP_LIMIT`/`UPSTREAM_MAX_RETRIES`/`UPSTREAM_TIMEOUT_MS`/`MAX_BODY_MB`/`HTTPS_PROXY` etc. See `README.md` table.

## Development

- `cd proxy && npm install && npm run typecheck && npm test` (Jest + `@swc/jest`, `tsc --noEmit` must pass). No build step — `node index.ts` via type stripping.
- `docker build -t local/opencode-openai-api-proxy .` respects `.dockerignore`; `COPY proxy/ /usr/src/proxy/` keeps cache.
- Tests mock `V2Client` (e.g. `getProvidersAndModels`, `prompt`, `createSession`, `subscribeEvents`) and `global.fetch` for the direct gateway SSE (`data: …\n\n` + `data: [DONE]`).
