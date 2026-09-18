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
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
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
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
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
                ...(init?.headers as Record<string, string> ?? {}),
            },
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`V2 API error ${resp.status} on ${path}: ${text.slice(0, 300)}`);
        }
        const data = (await resp.json()) as T;
        return { data, status: resp.status };
    }

    private async fetchSSE(path: string): Promise<ReadableStream<Uint8Array> | null> {
        const url = `${this.baseUrl}${path}`;
        const resp = await fetch(url, {
            headers: {
                ...this.headers(),
                Accept: 'text/event-stream',
            },
        });
        if (!resp.ok || !resp.body) return null;
        return resp.body;
    }

    // ----- Session methods -----

    async createSession(): Promise<{ data?: { id: string }; error?: Error }> {
        try {
            const { data } = await this.fetchJson<{ data: V2SessionInfo }>('/api/session', {
                method: 'POST',
                body: JSON.stringify({}),
            });
            return { data: data?.data ? { id: data.data.id } : undefined };
        } catch (e) {
            return { error: e as Error };
        }
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
        toolsMap?: Record<string, boolean> | null,
        model?: { providerID: string; modelID: string }
    ): Promise<{ data?: Record<string, unknown>; error?: Error }> {
        try {
            // v2 prompt only accepts "text" for the user message
            // Model, system, tools, and parts are no longer part of the prompt payload
            const payload: Record<string, unknown> = { text: promptText };
            // The model is set at session creation or via the switchModel endpoint.
            // For now, we pass it through in case the server accepts it.
            if (model) {
                payload.model = `${model.providerID}/${model.modelID}`;
            }
            if (systemPrompt) {
                payload.system = systemPrompt;
            }

            const { data } = await this.fetchJson<{ data: Record<string, unknown> }>(
                `/api/session/${sessionId}/prompt`,
                {
                    method: 'POST',
                    body: JSON.stringify(payload),
                }
            );
            return { data: data?.data };
        } catch (e) {
            return { error: e as Error };
        }
    }

    /**
     * Switch the model for a session (v2 API: POST /api/session/:id/model).
     */
    async switchModel(sessionId: string, providerID: string, modelID: string): Promise<void> {
        try {
            await this.fetchJson(`/api/session/${sessionId}/model`, {
                method: 'POST',
                body: JSON.stringify({ model: `${providerID}/${modelID}` }),
            });
        } catch {
            // Best-effort; don't crash the proxy if this fails
        }
    }

    // ----- Provider/model methods -----

    async getProvidersAndModels(): Promise<{
        providers: V2ProviderInfo[];
        models: V2ProviderModel[];
    }> {
        const [providerRes, modelRes] = await Promise.all([
            this.fetchJson<{ data: V2ProviderInfo[] }>('/api/provider'),
            this.fetchJson<{ data: V2ProviderModel[] }>('/api/model'),
        ]);
        return {
            providers: providerRes.data?.data || [],
            models: modelRes.data?.data || [],
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
            // For opencode provider, default to zen endpoint
            if (providerId === 'opencode') {
                return {
                    baseUrl: process.env.ZEN_BASE_URL || 'https://opencode.ai/zen/v1',
                    apiKey: null,
                    modelId,
                    supportsImages: undefined,
                };
            }
            return null;
        }

        // Extract base URL from model settings or provider settings
        const provider = providers.find((p) => p.id === providerId);
        const modelSettings = model.settings || {};
        const providerSettings = provider?.settings || {};

        const baseUrl = (
            modelSettings.baseURL ||
            providerSettings.baseURL ||
            ''
        ).replace(/\/+$/, '');

        if (!baseUrl && providerId !== 'opencode') return null;

        const effectiveBaseUrl =
            baseUrl || process.env.ZEN_BASE_URL || 'https://opencode.ai/zen/v1';

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
        const serverPassword = process.env.OPENCODE_BACKEND_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD;
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
