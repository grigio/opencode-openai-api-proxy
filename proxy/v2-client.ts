/**
 * Raw HTTP client for OpenCode server v2.0+ API.
 *
 * The OpenCode v2 server uses /api/* prefixed routes that are incompatible
 * with the @opencode-ai/sdk v1 (which uses /session, /config, /event, etc.).
 * This module provides a thin wrapper that speaks the v2 wire format while
 * exposing just enough interface for the proxy to work.
 */

import type { Request } from 'express';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface V2SessionInfo {
    id: string;
    projectID: string;
    cost: number;
    tokens: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
    };
    time: { created: number; updated: number };
    location: { directory: string };
}

export interface V2ProviderModel {
    id: string;
    modelID: string;
    providerID: string;
    family: string;
    name: string;
    package: string;
    settings: {
        apiKey?: string;
        baseURL?: string;
        provider?: string;
        [k: string]: unknown;
    };
    capabilities?: {
        tools?: boolean;
        input?: string[];
        output?: string[];
        [k: string]: unknown;
    };
    variants?: Array<{ id: string; settings?: Record<string, unknown> }>;
    [k: string]: unknown;
}

export interface V2ProviderInfo {
    id: string;
    integrationID: string;
    name: string;
    activation: string;
    package: string;
    settings: {
        apiKey?: string;
        baseURL?: string;
        provider?: string;
        [k: string]: unknown;
    };
}

export interface ProviderGatewayInfo {
    baseUrl: string;
    apiKey: string | null;
    modelId: string;
    supportsImages?: boolean;
}

export interface PromptMessage {
    id: string;
    sessionID: string;
    type: 'user' | 'assistant' | 'idle' | string;
    time: { created: number };
    text?: string;
    agent?: string;
    model?: { id: string; providerID: string };
    content?: Array<{ type: string; text?: string; state?: unknown }>;
    finish?: string;
    tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
    };
    cost?: number;
    [k: string]: unknown;
}

// V2 SSE event shape
export interface V2Event {
    id: string;
    type: string;
    created?: number;
    data?: Record<string, unknown>;
    location?: { directory: string };
    metadata?: Record<string, unknown>;
    durable?: { aggregateID: string; seq: number; version: number };
}

// ---------------------------------------------------------------------------
// Adapter class
// ---------------------------------------------------------------------------

export class V2Client {
    private baseUrl: string;
    private authHeader: string;

    constructor(baseUrl: string, serverPassword?: string) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        if (serverPassword) {
            this.authHeader =
                'Basic ' + Buffer.from(`opencode:${serverPassword}`).toString('base64');
        } else {
            this.authHeader = '';
        }
    }

    private headers(): Record<string, string> {
        const h: Record<string, string> = {};
        if (this.authHeader) h['Authorization'] = this.authHeader;
        return h;
    }

    private async fetchJson<T = unknown>(
        path: string,
        init?: RequestInit
    ): Promise<{ data: T; status: number }> {
        const url = `${this.baseUrl}${path}`;
        const resp = await fetch(url, {
            ...init,
            headers: {
                ...this.headers(),
                'Content-Type': 'application/json',
                ...((init?.headers as Record<string, string>) ?? {})
            }
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`V2 API error ${resp.status} on ${path}: ${text.slice(0, 300)}`);
        }
        if (resp.status === 204) {
            return { data: undefined as T, status: resp.status };
        }
        const text = await resp.text();
        if (!text) {
            return { data: undefined as T, status: resp.status };
        }
        const data = JSON.parse(text) as T;
        return { data, status: resp.status };
    }

    private async fetchSSE(path: string): Promise<ReadableStream<Uint8Array> | null> {
        const url = `${this.baseUrl}${path}`;
        const resp = await fetch(url, {
            headers: {
                ...this.headers(),
                Accept: 'text/event-stream'
            }
        });
        if (!resp.ok || !resp.body) return null;
        return resp.body;
    }

    // ----- Session methods -----

    async createSession(
        opts?: string | { directory?: string | null } | null
    ): Promise<{ data?: { id: string; projectID?: string }; error?: Error }> {
        let directory: string | undefined;
        if (typeof opts === 'string') directory = opts;
        else if (opts && typeof opts === 'object' && typeof opts.directory === 'string')
            directory = opts.directory;
        // Env override mirrors AGENTS.md workaround: pi --session cwd not forwarded,
        // so bare `ls` lists proxy/ not the client's dir (use absolute paths or set
        // OPENCODE_PROJECT_DIR). Also honor explicit directory from caller.
        if (!directory) {
            directory =
                process.env.OPENCODE_PROJECT_DIR?.trim() ||
                process.env.OPENCODE_CWD?.trim() ||
                undefined;
        }
        // Validate: must be absolute path when set
        if (directory && !directory.startsWith('/')) directory = undefined;
        try {
            const body: Record<string, unknown> = {};
            if (directory) body.location = { directory };
            const { data } = await this.fetchJson<{ data: V2SessionInfo }>('/api/session', {
                method: 'POST',
                body: JSON.stringify(body)
            });
            if (!data?.data) return { data: undefined };
            // Keep full session info so callers can use projectID for affinity headers
            return { data: { id: data.data.id, projectID: data.data.projectID } as V2SessionInfo };
        } catch (e) {
            return { error: e as Error };
        }
    }

    /**
     * Extract a working directory from prompt/system text. Pi and similar
     * agents embed "Current working directory: /path" in the system prompt;
     * using it for session.location.directory makes agent tools (write/bash/
     * read) operate on the client's files instead of the proxy repo root
     * (AGENTS.md limitation). Also checks OPENCODE_PROJECT_DIR env.
     */
    static inferDirectoryFromPrompt(promptText?: string, systemText?: string): string | undefined {
        const envDir =
            process.env.OPENCODE_PROJECT_DIR?.trim() || process.env.OPENCODE_CWD?.trim();
        if (envDir && envDir.startsWith('/')) return envDir;
        const combined = `${systemText || ''}\n${promptText || ''}`;
        // If the prompt references pi skills at ~/.pi (outside the session's cwd like /tmp/tmp.xxx),
        // the opencode `read` tool hangs when sandboxed to that cwd (see proxy/utils.ts buildAgentToolsSystem).
        // Prefer the skill's parent so `read` can succeed, but `bash cat` is the reliable fallback.
        // We still return the inferred cwd for normal file ops; skill handling is via the system hint above.
        // Matches "Current working directory: /tmp" or "cwd: /tmp/foo" variants
        const m =
            combined.match(/Current working directory:\s*([^\s\n'"]+)/i) ||
            combined.match(/\bcwd\s*[:=]\s*([^\s\n'"]+)/i) ||
            combined.match(/working dir(?:ectory)?\s*[:=]\s*([^\s\n'"]+)/i);
        if (m && m[1] && m[1].startsWith('/')) {
            // Strip trailing punctuation that may follow the path in prompt text
            return m[1].replace(/[.,;:'"]+$/, '');
        }
        return undefined;
    }

    /**
     * Send a prompt to a session. The v2 API prompt endpoint is async —
     * it returns immediately with the admitted user message and the agent
     * loop runs in the background. The caller should subscribe to the
     * global event stream to receive delta/completion events.
     */
    async prompt(
        sessionId: string,
        promptText: string,
        systemPrompt?: string,
        parts?: unknown[],
        _toolsMap?: Record<string, boolean> | null,
        _model?: { providerID: string; modelID: string }
    ): Promise<{ data?: Record<string, unknown>; error?: Error }> {
        try {
            // v2 API expects { prompt: { text, files, agents } } – see openapi.json
            // for POST /api/session/{sessionID}/prompt. Older code sent { text }
            // top-level which now fails with 400 Missing key at ["prompt"].
            const prompt: Record<string, unknown> = { text: promptText };
            // Preserve parts/files/agents if the caller supplied them (converted
            // from PromptPart[] by the streaming layer). The v2 PromptInput
            // shape is { text, files?, agents? } – unknown keys are ignored.
            if (Array.isArray(parts) && parts.length > 0) {
                // Heuristic: split parts into files vs agents vs text – the
                // proxy's PromptPart is already normalized, so pass through
                // as files when type is image-like, otherwise ignore.
                const files: unknown[] = [];
                const agents: unknown[] = [];
                for (const p of parts as Array<{
                    type?: string;
                    text?: string;
                    uri?: string;
                    name?: string;
                }>) {
                    if (!p || typeof p !== 'object') continue;
                    if (p.type === 'image_url' || p.type === 'image' || p.uri) files.push(p);
                    else if (p.type === 'agent' || p.name) agents.push(p);
                }
                if (files.length > 0) prompt.files = files;
                if (agents.length > 0) prompt.agents = agents;
            }
            // System prompt is not a top-level field in v2 PromptInput; when
            // provided, prepend it to the user text so the model still sees it.
            // This mirrors the official CLI's behavior of merging system into
            // the prompt when no dedicated system slot exists.
            if (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.trim()) {
                prompt.text = `${systemPrompt.trim()}\n\n${promptText}`;
            }
            const payload: Record<string, unknown> = { prompt };
            // Model is set via POST /api/session/:id/model, not in prompt body.
            // We keep the switchModel() call separate (caller does it before prompt).

            try {
                const { data } = await this.fetchJson<{ data: Record<string, unknown> }>(
                    `/api/session/${sessionId}/prompt`,
                    {
                        method: 'POST',
                        body: JSON.stringify(payload)
                    }
                );
                return { data: data?.data };
            } catch (err) {
                const msg = String((err as Error)?.message || "");
                // Host standalone v2.0.5 expects bare {text,...} while stable 1.18.31
                // expects {prompt:{text,...}}. Container used the latter, host the
                // former (Missing key at ["text"] vs ["prompt"]). Fall back to the
                // other shape so both servers work without container.
                const isTextMissing = msg.includes('text') && msg.includes('Missing key');
                // debug: console.warn('v2 prompt fallback check', msg.slice(0,120), {isTextMissing, isPromptMissing: msg.includes('prompt')});
                const isPromptMissing = msg.includes('prompt') && msg.includes('Missing key');
                if (isTextMissing || isPromptMissing) {
                    const fallbackPayload: Record<string, unknown> = isTextMissing ? { ...prompt } : { prompt };
                    try {
                        const { data } = await this.fetchJson<{ data: Record<string, unknown> }>(
                            `/api/session/${sessionId}/prompt`,
                            {
                                method: 'POST',
                                body: JSON.stringify(fallbackPayload)
                            }
                        );
                        return { data: data?.data };
                    } catch (e2) {
                        return { error: e2 as Error };
                    }
                }
                return { error: err as Error };
            }
        } catch (e) {
            return { error: e as Error };
        }
    }

    /**
     * Switch the model for a session (v2 API: POST /api/session/:id/model).
     * The v2 API expects Model.Ref { providerID, id } not a string.
     * See openapi.json for /api/session/{sessionID}/model.
     */
    async switchModel(sessionId: string, providerID: string, modelID: string): Promise<void> {
        if (!sessionId) return;
        await this.fetchJson(`/api/session/${sessionId}/model`, {
            method: 'POST',
            body: JSON.stringify({ model: { providerID, id: modelID } })
        });
    }

    // ----- Provider/model methods -----

    async getProvidersAndModels(): Promise<{
        providers: V2ProviderInfo[];
        models: V2ProviderModel[];
    }> {
        const [providerRes, modelRes] = await Promise.all([
            this.fetchJson<{ data: V2ProviderInfo[] }>('/api/provider'),
            this.fetchJson<{ data: V2ProviderModel[] }>('/api/model')
        ]);
        return {
            providers: providerRes.data?.data || [],
            models: modelRes.data?.data || []
        };
    }

    /**
     * Resolve provider gateway info for a provider/model pair.
     * This replaces the old `client.config.providers()` + model lookup pattern.
     */
    async getProviderGatewayInfo(
        providerId: string,
        modelId: string
    ): Promise<ProviderGatewayInfo | null> {
        const { providers, models } = await this.getProvidersAndModels();

        // Find the model
        const model = models.find(
            (m) => m.providerID === providerId && (m.id === modelId || m.modelID === modelId)
        );
        if (!model) {
            // For opencode provider, default to zenmux endpoint (the free-tier gateway)
            // v2.0.5 uses https://zenmux.ai/api/v1 via ZenmuxPlugin; older proxy used
            // https://opencode.ai/zen/v1 which is no longer the canonical base.
            if (providerId === 'opencode') {
                return {
                    baseUrl: process.env.ZEN_BASE_URL || 'https://zenmux.ai/api/v1',
                    apiKey: null,
                    modelId,
                    supportsImages: undefined
                };
            }
            return null;
        }

        // Extract base URL from model settings or provider settings
        const provider = providers.find((p) => p.id === providerId);
        const modelSettings = model.settings || {};
        const providerSettings = provider?.settings || {};

        const baseUrl = (modelSettings.baseURL || providerSettings.baseURL || '').replace(
            /\/+$/,
            ''
        );

        if (!baseUrl && providerId !== 'opencode') return null;

        const effectiveBaseUrl = baseUrl || process.env.ZEN_BASE_URL || 'https://zenmux.ai/api/v1';

        // API key resolution: model settings > provider settings > auth store
        let apiKey = modelSettings.apiKey || providerSettings.apiKey || null;
        if (apiKey === 'public') apiKey = null; // "public" means anonymous

        const supportsImages = model.capabilities?.input?.includes('image') || undefined;

        return { baseUrl: effectiveBaseUrl, apiKey, modelId: model.id, supportsImages };
    }

    // ----- Event methods -----

    /**
     * Subscribe to the global SSE event stream.
     * Returns a ReadableStream or null on failure.
     */
    async subscribeEvents(): Promise<ReadableStream<Uint8Array> | null> {
        return this.fetchSSE('/api/event');
    }
}

// ---------------------------------------------------------------------------
// Factory (mirrors the old getClient() pattern)
// ---------------------------------------------------------------------------

let _client: V2Client | null = null;

export function getV2Client(): V2Client {
    if (!_client) {
        // OPENCODE_BACKEND_PASSWORD: password the proxy uses to authenticate with the OpenCode server.
        // Falls back to OPENCODE_SERVER_PASSWORD for backward compat.
        const serverPassword =
            process.env.OPENCODE_BACKEND_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD;
        const port = parseInt(
            process.env.TARGET_PORT || process.env.OPENCODE_SERVER_PORT || '4097',
            10
        );
        _client = new V2Client(`http://127.0.0.1:${port}`, serverPassword);
    }
    return _client;
}

export function resetV2Client(): void {
    _client = null;
}

export function clientAbortSignal(req: Request): AbortSignal {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.on('close', () => {
        if (!req.complete) abort();
    });
    return controller.signal;
}
