# opencode-openai-api-proxy — Docker Image with OpenAI Compatibility

This Docker image provides a complete and optimized environment to run the [OpenCode AI](https://opencode.ai) server. It includes an integrated Translation Layer (Proxy) that makes OpenCode compatible with any tool that supports the OpenAI API.

## 🌟 Key Features

- **OpenAI Compatibility Proxy:** Use OpenCode as if it were the OpenAI service. Compatible with LibreChat, Dify, TypingMind, etc.
- **Streaming Support:** Real-time responses via Server-Sent Events (SSE).
- **Dynamic Model Mapping:** Automatic support for multiple providers in `provider/model` format.
- **Native API Exposed:** Full access to OpenCode's original features and web interface.
- **Secure by Default:** Authentication via Bearer Token for the Proxy and Basic Auth for the native API.
- **Data Persistence:** Volumes configured to keep sessions, database, and settings.
- **Permission Support (NAS):** Supports `PUID` and `PGID` variables to avoid permission issues on network volumes.

---

## 🚀 Getting Started

### 1. Via Docker Compose (Recommended)

Use the provided [`docker-compose.yml`](./docker-compose.yml) to spin up the service quickly:

1. Define your password in a `.env` file (or directly in the compose file):
   ```env
   OPENCODE_SERVER_PASSWORD=your_secret_password
   ```

2. Start the container:
   ```bash
   docker-compose up -d
   ```

### 2. Via Docker Run

```bash
docker run -d \
  --name opencode-server \
  -p 4096:4096 \
  -p 4097:4097 \
  -e OPENCODE_SERVER_PASSWORD=your_secret_password \
  -e PUID=1000 \
  -e PGID=1000 \
  -v opencode_data:/home/node/.local/share/opencode \
  -v opencode_config:/home/node/.config/opencode \
  local/opencode-openai-api-proxy:latest
```

---

## 🔌 Connectivity & Ports

| Port | Service | Description | Authentication |
| :--- | :--- | :--- | :--- |
| **4096** | **OpenAI Proxy** | OpenAI SDK/Tools compatible endpoint | `Bearer <YOUR_PASSWORD>` |
| **4097** | **OpenCode Native** | Original API and Web Interface (if available) | `Basic opencode:<YOUR_PASSWORD>` |

> **Port 4097 warning:** the native OpenCode API/web UI is authenticated with
> Basic Auth and is **not** an OpenAI-compatible endpoint. Only publish 4097
> when you actually use the OpenCode web interface; if you only need the proxy
> you can omit `-p 4097:4097` to reduce your attack surface.

> **Healthcheck:** the proxy exposes a lightweight unauthenticated `GET /health`
> endpoint (returns `ok`) used by the container's `HEALTHCHECK`. OpenCode's own
> health endpoint lives at `http://127.0.0.1:4097/global/health` (container-internal).

---

## ⚙️ Configuration

All settings are environment variables; only `OPENCODE_SERVER_PASSWORD` is required.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `OPENCODE_SERVER_PASSWORD` | — | Bearer token for the proxy and Basic Auth password for the native API. **Required.** |
| `OPENCODE_SERVER_PORT` / `TARGET_PORT` | `4097` | Internal port of the OpenCode server the proxy forwards to. |
| `PROXY_PORT` | `4096` | Port the OpenAI proxy listens on (also used in `docker-compose.yml`). |
| `PROXY_HOST` | `0.0.0.0` | Bind address for the proxy. |
| `MAX_BODY_MB` | `50` | Maximum JSON/urlencoded request body size accepted by the proxy (MB). |
| `PUID` / `PGID` | `1000` | Numeric UID/GID used for the `node` user and volume ownership (NAS setups). |
| `OPENCODE_API_KEY` | — | OpenCode Zen API key (create one at https://opencode.ai/auth). When set it is written into the auth store (`/home/node/.local/share/opencode/auth.json`) on first run, so the server and the proxy gateway (tool calling) are authenticated instead of hitting the anonymous free tier — there is no usable anonymous key, keyless requests are exactly the rate-limited free tier. **Rotation:** update the key in `.env` and `docker compose up -d`; **unset** the variable to remove our seeded entry (a real `opencode auth login` entry is never touched). |
| `OPENCODE_TOOL_CALLING` | `auto` | Tool-calling routing. `auto` (default) relays the client's tool definitions to the model API so the **client executes them in its own working directory**; the keyless anonymous `opencode/*` free tier is automatically sent **directly to zen** (`https://opencode.ai/zen/v1`, override with `ZEN_BASE_URL`) with a rotating CLI identity — no opt-in env is needed. Session/project ids rotate on every proxy boot (i.e. container restart) and a fresh request id is generated per call, mirroring the official CLI. A failed zen call on a tool request fails loudly (rate limits are transient) rather than silently running in-container tools. `agent` is the explicit opt-out that runs the server's built-in tools inside the container instead; `direct` always uses the plain direct-model gateway for every provider. |
| `ZEN_CLIENT_VERSION` | `1.18.16` | Version string used in the `User-Agent: opencode/<version> ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13` header sent on zen-direct requests (the exact wire format the official CLI sends, as captured from a real `opencode run`). Pinned to `OPENCODE_VERSION` for consistency. |
| `UPSTREAM_MAX_RETRIES` | `2` | Retries with exponential backoff for transient upstream failures (`408/429/5xx`, connection resets) on non-streaming model-API calls — mirroring the official CLI, which retries these silently instead of surfacing them. Streams are retried separately while nothing has been forwarded to the client yet. |
| `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` / `ALL_PROXY` / `all_proxy` | — | Outbound connections honor the standard curl-style proxy variables. When any of them is set, every upstream call (model APIs, zen) is routed through the user's proxy connection; when none is set, direct connections are used as before. Loopback traffic (proxy ↔ OpenCode server) always stays direct. See [Outbound Proxy Support](#outbound-proxy-support). |
| `NO_PROXY` / `no_proxy` | — | Hosts that must bypass the outbound proxy (comma-separated, `*` disables proxying entirely). `localhost`, `127.0.0.1` and `::1` are always appended automatically so internal traffic never leaves the machine. |

**Observability:** every request is logged once when it finishes
(`timestamp method url status duration`), and the proxy assigns a per-request
`X-Request-Id` header (also echoed in logs) so tool loops and stream failures
can be correlated across the console output.

> **Single instance:** the proxy keeps recent response state (e.g. for
> `previous_response_id` continuations) **in memory** with a 30-minute TTL. Do
> **not** run more than one proxy instance behind a load balancer, or a
> continuation may land on a replica that does not hold the state.

---

## 🌐 Outbound Proxy Support

On hosts where internet access requires a proxy (corporate networks, VPNs,
region-restricted setups), the proxy's upstream calls used to fail with
`network_error` in clients like Codex — Node's built-in `fetch` ignores the
standard proxy environment variables, while the official opencode CLI (Bun
runtime) honors them, which is why the same model worked in opencode but not
through this proxy.

The proxy now behaves like curl: set any of the standard variables and all
outbound connections go through your proxy connection.

```yaml
# docker-compose.yml
services:
  opencode:
    environment:
      - HTTPS_PROXY=${HTTPS_PROXY:-}
      - HTTP_PROXY=${HTTP_PROXY:-}
      # ALL_PROXY is honored too; NO_PROXY additions are optional.
      # - ALL_PROXY=${ALL_PROXY:-}
      # - NO_PROXY=${NO_PROXY:-}
```

```bash
# docker run
docker run -d \
  -e HTTPS_PROXY=http://proxy.lan:8080 \
  ...
```

Behavior details:

- **No variable set → unchanged.** Direct connections exactly as before.
- **Loopback always stays direct.** The internal connection to the OpenCode
  server (`http://127.0.0.1:4097`) never goes through the user proxy, even
  without `NO_PROXY`.
- **Credentials are safe.** `HTTPS_PROXY=http://user:pass@proxy:8080` works;
  secrets are redacted from logs.
- Only HTTP(S) CONNECT proxies are supported (no SOCKS).

---

## 🤖 OpenAI API Usage (Proxy)

The proxy translates OpenAI format calls to the internal OpenCode SDK transparently.

- **Base URL:** `http://localhost:4096/v1`
- **API Key:** Use the password defined in `OPENCODE_SERVER_PASSWORD`.
- **Models:** Use the `provider/model-id` format. Examples: `opencode/x-preview-f-free` (Free), `opencode/big-pickle` (Free), `anthropic/claude-3-5-sonnet`.

> **Brand-new zen models:** the OpenCode server resolves its provider catalog from a cached
> models.dev snapshot, so a stealth free release (e.g. `x-preview-f-free`) can be requested
> before the local server knows it. For keyless anonymous requests on the `opencode` provider
> the proxy falls back to the stable zen endpoint automatically — no restart or rebuild needed.

### Sampling & Reasoning Controls

The proxy relays standard sampling/reasoning parameters to the underlying model API instead of
silently dropping them:

| Client sends | Relayed upstream as |
| :--- | :--- |
| `reasoning_effort` (Chat) / `reasoning.effort` (Responses) | `reasoning_effort` |
| `temperature` | `temperature` |
| `top_p` | `top_p` |
| `max_tokens` / `max_completion_tokens` / `max_output_tokens` | `max_tokens` |

This matters for reasoning models like `opencode/x-preview-f-free`, which expose low/high/max
effort variants: `"reasoning_effort": "low"` produces faster, cheaper answers with minimal
thinking, while `"high"`/`"max"` trade latency for depth.

### Reasoning Content

Reasoning models stream their thinking through OpenAI's de-facto `reasoning_content` field
(deltas on `/v1/chat/completions`, a dedicated `reasoning` output item on `/v1/responses`) and
the message `content` stays **clean** — the model's deliberation never leaks into the visible
answer. Reasoning-aware clients can echo `reasoning_content` back on tool-call continuations;
generic clients simply ignore the field.

> **Token budgets:** reasoning tokens count toward `max_tokens` / `max_output_tokens` when the
> client sets them. If answers come back truncated (`finish_reason: "length"`), raise the limit
> or lower `reasoning_effort`.

### Chat Completion Example (Sync)
```bash
curl http://localhost:4096/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_PASSWORD>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "Hello, who are you?"}]
  }'
```

### Streaming Example (SSE)
Simply add `"stream": true` to the payload and the proxy will send data word by word.

### Responses API Example (Non-Streaming)
```bash
curl http://localhost:4096/v1/responses \
  -H "Authorization: Bearer <YOUR_PASSWORD>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "input": "Hello from responses api"
  }'
```

### Responses API Streaming Example (SSE)
```bash
curl -N http://localhost:4096/v1/responses \
  -H "Authorization: Bearer <YOUR_PASSWORD>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "input": "Stream a short answer",
    "stream": true
  }'
```

Note: `/v1/responses` supports text/multimodal + streaming + `previous_response_id`. Real OpenAI function/tool calling is supported in both `/v1/chat/completions` and `/v1/responses` (streaming and non-streaming): tool `tool_calls` are relayed from the underlying model API so the client can execute them locally, and tool results can be returned via `previous_response_id`. Both tool serializations are accepted: the flat Responses API shape (`{"type":"function","name":...}`) and the nested Chat Completions shape (`{"type":"function","function":{...}}`).

### OpenAI Codex CLI

The proxy is compatible with [OpenAI Codex CLI](https://github.com/openai/codex) (>= 0.146.0, which only supports the Responses wire API). Point Codex at the proxy with the model in `providerId/modelId` form:

```toml
# ~/.codex/config.toml
model = "opencode/hy3-free"  # stable for tool calling; x-preview-f-free is rate-limited on the anonymous free tier
model_provider = "mia"

[model_providers.mia]
name = "mia"
base_url = "http://localhost:4096/v1"
wire_api = "responses"
experimental_bearer_token = "<YOUR_PASSWORD>"
# alternative: set MIA_API_KEY="..." and use env_key = "MIA_API_KEY"
```

Codex's built-in tools (`shell`, `apply_patch`, `web_search`, ...) are relayed to the underlying model API, so the agent loop runs with the client executing tools locally.

> **Stable models for Codex/Pi:** `opencode/hy3-free` and `opencode/nemotron-3.5-lightning-free` handle tool calling reliably on the anonymous free tier. `opencode/x-preview-f-free` and `opencode/muse-spark-1.2-contributor-free` are currently intermittently unavailable for tool calls via the free tier (`Endpoint is unavailable` / `Internal server error`); use them with `OPENCODE_API_KEY` or switch models if you see no replies.

### Pi Coding Agent

[Pi](https://github.com/badlogic/pi-mono) uses `~/.pi/agent/models.json` (`api: "openai-completions"`). Use a provider id that matches the model prefix (`opencode`) so the default model resolves correctly:

```json
{
  "providers": {
    "opencode": {
      "baseUrl": "http://localhost:4096/v1",
      "apiKey": "YOUR_PASSWORD",
      "api": "openai-completions",
      "models": [
        { "id": "opencode/hy3-free", "reasoning": true },
        { "id": "opencode/nemotron-3.5-lightning-free", "reasoning": true }
      ]
    }
  }
}
```

---

## 🧪 Automated Tests

We ensure proxy stability through two test layers located in the `tests/` folder:

1. **Unit Tests:** Validates routing and mapping logic using SDK mocks.
   ```bash
   ./tests/test-unit.sh
   ```
2. **Integration Tests:** Builds the actual Docker image and runs requests against a live OpenCode server.
   ```bash
   ./tests/test-integration.sh
   ```

---

## 🛠️ Development & Build

The image is built on top of `node:lts-slim` to ensure it is lightweight and compatible. The proxy itself runs on Node's native TypeScript type-stripping, so **no build step** is needed.

### Requirements (local development)
- **Node.js >= 23.6** (native type stripping; `.nvmrc` pins a working version).
- `npm install` inside `proxy/` (or `npm ci` for a reproducible install).

### Local Build
```bash
docker build -t local/opencode-openai-api-proxy .
```

### Run the proxy natively (without Docker)
You still need a running OpenCode server on `localhost:4097` (or point the
proxy elsewhere with `TARGET_PORT`), plus a `.config/opencode/auth.json` for the
SDK client:

```bash
cd proxy
npm install
OPENCODE_SERVER_PASSWORD=secret npm start
```

### Checks
```bash
cd proxy
npm run typecheck   # TypeScript (tsc --noEmit)
npm test            # Unit tests (Jest, SDK mocks)
```

### Internal Orchestration
The container uses [`entrypoint.sh`](./entrypoint.sh) to start the OpenCode server in the background, wait for the health check, and then bring up the Express Proxy in the foreground. The Docker image runs `npm ci --omit=dev` (no dev dependencies at runtime) and pins a specific `opencode-ai` release for reproducible builds.
