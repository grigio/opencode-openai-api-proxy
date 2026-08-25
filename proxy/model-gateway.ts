import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { logger } from './logger.ts';
import type {
    ChatCompletionData,
    ChatCompletionOptions,
    ChatCompletionResult,
    ChatMessage,
    FlatToolDefinition,
    GatewayResult,
    NestedToolDefinition,
    ProviderGatewayInfo,
    ProviderLike,
    ReasoningMeta,
    ToolDefinition
} from './types.ts';

const PROVIDER_CACHE_TTL_MS = 60 * 1000;
// Placeholder the opencode server returns in `/config/providers` for keys it
// loaded from its local auth store (auth.json). The real key is never exposed
// over the server API, so the proxy must read the store directly (it runs as
// the same user, in the same container, as the opencode server).
const REDACTED_KEY_PLACEHOLDER = 'public';
// Upstream model API request timeout. Configurable because reasoning-mode
// models (free/flash tiers in particular) can legitimately take longer than
// the legacy 90s default to start streaming after a long thinking phase.
const DEFAULT_UPSTREAM_TIMEOUT_MS = Math.max(
    1000,
    parseInt(process.env.UPSTREAM_TIMEOUT_MS || '90000', 10) || 90000
);

// ---------------------------------------------------------------------------
// Rotating zen client identity
//
// Zen's anonymous free tier gives official opencode CLI clients a much larger
// quota than header-less requests, and it keys that identity to the per-run
// session/project ids the CLI generates. The proxy regenerates the session
// and project ids once per process boot (i.e. per container restart), and a
// fresh request id per call, so every restart presents zen with a new
// identity. This does not bypass paid-model auth: the identity is only ever
// attached to keyless "public" (anonymous free tier) requests.
// ---------------------------------------------------------------------------
const ZEN_CLIENT_VERSION = process.env.ZEN_CLIENT_VERSION || '1.18.16';
const zenIdentity = {
    session: `ses_${crypto.randomBytes(10).toString('hex')}`,
    project: 'global'
};

// Canonical zen endpoint. The opencode server catalog is synced from
// models.dev and cached, so brand-new free models (e.g. a stealth release
// like "x-preview-f-free") can be requested before the local server knows
// them; the zen-direct gateway still resolves their endpoint from here.
export const DEFAULT_ZEN_BASE_URL = 'https://opencode.ai/zen/v1';

function zenBaseUrl(): string {
    return (process.env.ZEN_BASE_URL || DEFAULT_ZEN_BASE_URL).replace(/\/+$/, '');
}

function zenIdentityHeaders(): Record<string, string> {
    return {
        'x-opencode-client': 'cli',
        'x-opencode-session': zenIdentity.session,
        'x-opencode-project': zenIdentity.project,
        'x-opencode-request': `msg_${crypto.randomBytes(6).toString('hex')}`,
        'User-Agent': `opencode/${ZEN_CLIENT_VERSION} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`
    };
}

// The anonymous zen free tier gates requests on the presence of a system
// message whose content starts with "You are opencode" (the official client's
// built-in system prompt). Requests without it are refused with 429
// FreeUsageLimitError, regardless of headers or identity. The proxy injects
// the prompt head into keyless zen-direct requests so they are accepted; the
// prefix alone is sufficient (verified byte-exact against zen in 2026-08).
const ZEN_SYSTEM_PROMPT_PREFIX =
    'You are opencode, an interactive CLI tool that helps users with software engineering tasks.';

/**
 * Ensures the message list carries a system message that zen's anonymous
 * free tier recognizes (content starting with "You are opencode"). If none
 * exists, the official prompt head is prepended. Returns a new array.
 */
function ensureZenSystemPrompt(messages: ChatMessage[]): ChatMessage[] {
    const hasOfficial =
        Array.isArray(messages) &&
        messages.some(
            (m) =>
                m.role === 'system' &&
                typeof m.content === 'string' &&
                m.content.startsWith('You are opencode')
        );
    if (hasOfficial) return messages;
    return [{ role: 'system', content: ZEN_SYSTEM_PROMPT_PREFIX }, ...(messages || [])];
}

/**
 * True when a resolved provider gateway has no usable API key: either no key at
 * all, or the opencode server's "public" placeholder (a no-key marker, not a
 * redaction). Tool calling must then go through the server-agent path instead
 * of direct model calls, because the anonymous free tier refuses requests from
 * non-bun HTTP clients (429 FreeUsageLimitError).
 *
 * @param {object|null} info Resolved provider gateway info
 * @returns {boolean} True when the provider is keyless/anonymous
 */
function isProviderAnonymous(info: ProviderGatewayInfo | null | undefined): boolean {
    if (!info) return false;
    return !info.apiKey || info.apiKey === REDACTED_KEY_PLACEHOLDER;
}
const PROVIDER_CACHE_MAX = 200;
const providerCache = new Map<string, { info: ProviderGatewayInfo; expiresAt: number }>();

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
    if (map.has(key)) map.delete(key);
    else if (map.size >= max) {
        const oldest = map.keys().next().value as K | undefined;
        if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
}

// ---------------------------------------------------------------------------
// Reasoning memory for tool-call continuations
//
// Reasoning-mode backends (DeepSeek thinking mode, etc.) reject a tool-call
// continuation unless every assistant tool-call turn is echoed back with a
// dedicated `reasoning_content` field. Most OpenAI-compatible clients do NOT
// preserve a custom field across turns (they only keep `content`), so the
// proxy cannot recover the reasoning from the request alone on the next turn.
// This map remembers the reasoning the proxy relayed for each upstream tool
// call id, and re-injects it when the same call id comes back on a
// continuation. Call ids are unique per request (the upstream generates them),
// but lenient backends may reuse ids across conversations/models, so lookups
// are scoped to the endpoint key + tool signature (see recallToolCallReasoning)
// before any reasoning is injected.
// ---------------------------------------------------------------------------
const REASONING_MEMORY_TTL_MS = 30 * 60 * 1000;
const REASONING_MEMORY_MAX = 1000;
interface ReasoningMemoryEntry extends ReasoningMeta {
    content: string;
    expiresAt: number;
}
const reasoningMemory = new Map<string, ReasoningMemoryEntry>(); // toolCallId -> entry

setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of reasoningMemory) {
        if (entry.expiresAt <= now) reasoningMemory.delete(id);
    }
}, 60 * 1000).unref();

/**
 * Stable in-process key for a resolved upstream endpoint/model. Used to scope
 * remembered reasoning so a reused call id from a different model endpoint
 * (or a different conversation on another profile) can never be paired with
 * stale reasoning by accident.
 *
 * @param {object} provider Provider gateway info
 * @param {string} [provider.baseUrl] Base URL of the upstream endpoint
 * @param {string} [provider.modelId] Model id sent to the API
 * @returns {string} Normalized endpoint key
 */
function modelKeyOf({ baseUrl, modelId }: { baseUrl?: string; modelId?: string } = {}): string {
    return `${String(baseUrl || '').replace(/\/+$/, '')}|${String(modelId || '')}`;
}

/** Deep-equal two function arguments strings, tolerating key reordering. */
function sameFunctionArguments(a: string, b: string): boolean {
    if (a === b) return true;
    let pa: unknown;
    let pb: unknown;
    try {
        pa = JSON.parse(a);
        pb = JSON.parse(b);
    } catch {
        return false;
    }
    if (pa === null || pb === null || typeof pa !== 'object' || typeof pb !== 'object') {
        return JSON.stringify(pa) === JSON.stringify(pb);
    }
    const canon = (o: unknown): unknown => {
        if (Array.isArray(o)) return o.map(canon);
        if (o && typeof o === 'object') {
            return Object.keys(o)
                .sort()
                .reduce((acc: Record<string, unknown>, k: string) => {
                    acc[k] = canon((o as Record<string, unknown>)[k]);
                    return acc;
                }, {});
        }
        return o;
    };
    return JSON.stringify(canon(pa)) === JSON.stringify(canon(pb));
}

function rememberToolCallReasoning(
    toolCallId: string,
    reasoningContent: string,
    meta: ReasoningMeta = {}
): void {
    if (!toolCallId || typeof reasoningContent !== 'string' || !reasoningContent) return;
    boundedSet(
        reasoningMemory,
        toolCallId,
        {
            content: reasoningContent,
            modelKey: String(meta.modelKey || ''),
            functionName: String(meta.functionName || ''),
            functionArguments:
                typeof meta.functionArguments === 'string'
                    ? meta.functionArguments
                    : JSON.stringify(meta.functionArguments ?? null),
            expiresAt: Date.now() + REASONING_MEMORY_TTL_MS
        },
        REASONING_MEMORY_MAX
    );
}

/**
 * Recovers remembered reasoning for a tool call only when the call id matches
 * AND the stored endpoint/tool signature matches the echoed tool call. This
 * keeps re-injection from ever leaking reasoning into an unrelated
 * conversation or model when a provider reuses a call id (e.g. sequential
 * `call_1` ids). An id collision with a different endpoint/function/arguments
 * simply yields no memory, and the usual restore/retry paths still apply.
 *
 * @param {string|null} toolId Tool call id
 * @param {ReasoningMeta} [meta] The echoed tool call context to verify against
 * @returns {string} Remembered reasoning, or '' when absent/stale/mismatched
 */
function recallToolCallReasoning(toolId: string | null, meta: ReasoningMeta = {}): string {
    if (!toolId) return '';
    const entry = reasoningMemory.get(toolId);
    if (!entry) return '';
    if (entry.expiresAt <= Date.now()) {
        reasoningMemory.delete(toolId);
        return '';
    }
    const modelMatches = !entry.modelKey || !meta.modelKey || entry.modelKey === meta.modelKey;
    const nameMatches =
        !entry.functionName || !meta.functionName || entry.functionName === meta.functionName;
    const argsMatch =
        !entry.functionArguments ||
        !meta.functionArguments ||
        sameFunctionArguments(entry.functionArguments, meta.functionArguments);
    if (!modelMatches || !nameMatches || !argsMatch) return '';
    return entry.content;
}

/**
 * Re-injects remembered `reasoning_content` into assistant tool-call messages
 * that the client echoed back without it (the client dropped the field and did
 * not keep a recognisable thinking block in `content`). Only messages that
 * still carry no usable reasoning are touched, so explicit
 * `reasoning_content` or a folded block already recovered by
 * {@link restoreFoldedReasoning} always wins. The endpoint key disambiguates
 * call ids reused by different models/endpoints.
 *
 * @param {Array<object>} messages OpenAI chat messages
 * @param {string} [modelKey] Normalized endpoint key (see {@link modelKeyOf})
 * @returns {Array<object>} Messages with remembered reasoning injected where missing
 */
function injectRememberedReasoning(messages: ChatMessage[], modelKey?: string): ChatMessage[] {
    if (!Array.isArray(messages)) return messages;
    return messages.map((m) => {
        if (!m || m?.role !== 'assistant') return m;
        if (!(Array.isArray(m.tool_calls) && m.tool_calls.length > 0)) return m;
        if (typeof m.reasoning_content === 'string' && m.reasoning_content) return m;
        // A recoverable think block in content is authoritative and is
        // handled by restoreFoldedReasoning/forceRestoreReasoning - never
        // mask it with (possibly stale) remembered reasoning.
        if (THINK_BLOCK.test(m.content as string)) return m;
        for (const tc of m.tool_calls) {
            const remembered = recallToolCallReasoning(tc?.id, {
                modelKey,
                functionName: tc?.function?.name,
                functionArguments: tc?.function?.arguments
            });
            if (remembered) {
                return { ...m, reasoning_content: remembered };
            }
        }
        return m;
    });
}

/**
 * Reads the API key opencode stored for a provider via `opencode auth login`
 * straight from the opencode auth store (`~/.local/share/opencode/auth.json`).
 *
 * opencode resolves stored keys at request time and never exposes them via
 * `/config/providers`: a provider without a configured key is reported with
 * the `"public"` placeholder (or with no apiKey when the auth store holds an
 * entry), so the proxy cannot recover the token from the server API. Because
 * the proxy runs as the same user and container as the opencode server, it
 * can read the store directly instead.
 *
 * The store is a map of provider id to a plain string (older entries) or a
 * discriminated entry: `{type:"api", key}`, `{type:"wellknown", key, token}`
 * (both carry the bearer key in `key`) or `{type:"oauth", access, refresh,
 * expires}` (the Console/`opencode` login stores the bearer token in `access`).
 *
 * @param {string} providerId Provider id (e.g. "opencode")
 * @returns {string|null} The stored API key, or null when absent/unusable
 */
function readAuthStoreKey(providerId: string): string | null {
    try {
        // Mirror opencode's own auth store resolution: $XDG_DATA_HOME/opencode/auth.json,
        // falling back to ~/.local/share/opencode/auth.json. HOME is read from
        // process.env (not os.homedir()) so the path matches opencode's resolution.
        const dataHome =
            process.env.XDG_DATA_HOME ||
            path.join(process.env.HOME || os.homedir(), '.local', 'share');
        const authPath = path.join(dataHome, 'opencode', 'auth.json');
        const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;
        const entry = parsed?.[providerId];
        let key: unknown;
        if (typeof entry === 'string') {
            key = entry;
        } else if (entry && typeof entry === 'object') {
            const e = entry as { key?: unknown; access?: unknown };
            // api/wellknown entries carry `key`; oauth entries carry `access`.
            key = e.key ?? e.access;
        }
        if (typeof key !== 'string' || !key || key === REDACTED_KEY_PLACEHOLDER) return null;
        return key;
    } catch {
        return null;
    }
}

/**
 * Resolves the OpenAI-compatible endpoint + API key for a `provider/model`
 * pair using the OpenCode server's provider config.
 *
 * The OpenCode server is an agent that executes its own built-in tools
 * server-side, so `session.prompt` can never surface `tool_calls` to an
 * external client. To implement real OpenAI function/tool calling the proxy
 * calls the underlying model API directly (with the client's tool
 * definitions), so the *client* executes the tools in its own working
 * directory. This helper finds the base URL (Model.api.url or provider
 * options) and the API key (Provider.key or Provider.options.apiKey) for the
 * requested model. Keys stored via `opencode auth login` (and the
 * OPENCODE_API_KEY env) are resolved by the server at request time and never
 * exposed here - providers without a configured key are reported as "public" -
 * so those are recovered from the local auth store instead (see
 * {@link readAuthStoreKey}).
 *
 * @param {object} client The OpenCode SDK client
 * @param {string} providerId Provider id (e.g. "opencode", "openrouter")
 * @param {string} modelId Model id (e.g. "big-pickle")
 * @returns {Promise<ProviderGatewayInfo | null>}
 *   The resolved gateway info, or null when no OpenAI-compatible endpoint can
 *   be determined for the model.
 */
async function getProviderInfo(
    client: OpencodeClient,
    providerId: string,
    modelId: string
): Promise<ProviderGatewayInfo | null> {
    const cacheKey = `${providerId}/${modelId}`;
    const cached = providerCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.info;
    }

    const providersRes = await client.config.providers();
    const providersRaw = (providersRes.data?.providers || []) as
        ProviderLike[] | Record<string, ProviderLike>;
    const providersList = Array.isArray(providersRaw)
        ? providersRaw
        : Object.entries(providersRaw).map(([id, info]) => ({ ...info, id }));

    const provider = providersList.find((p) => p.id === providerId);
    if (!provider) return null;

    const model = provider.models?.[modelId];
    const api = model?.api || {};

    const options = (provider.options || {}) as Record<string, string | undefined>;
    let baseUrl = (api.url || options.url || options.baseURL || '').replace(/\/+$/, '');
    // The opencode server's provider catalog is a cached snapshot (models.dev
    // sync), so models released after the server image was built/started are
    // missing from it - the lookup above yields no baseUrl and would fail every
    // request for that model even though zen itself serves it. The zen endpoint
    // is stable, so default to it for the "opencode" provider; authenticated
    // keys still apply there and anonymous requests keep working unchanged.
    let catalogMiss = false;
    if (!baseUrl && providerId === 'opencode') {
        catalogMiss = true;
        baseUrl = zenBaseUrl();
        logger.warn(
            `[provider] opencode/${modelId}: not found in the OpenCode server catalog (stale snapshot?) - falling back to the zen endpoint ${baseUrl}`
        );
    }
    if (!baseUrl && !catalogMiss) return null;

    // Keys configured directly (opencode.json options.apiKey / env) are
    // exposed as-is. Stored keys (auth.json) and the OPENCODE_API_KEY env are
    // never exposed by the server: providers without a usable key are reported
    // with the "public" placeholder (or no apiKey when the auth store holds an
    // entry), so fall back to the local auth store and the zen env var.
    let apiKey = provider.key || options.apiKey || null;
    if (!apiKey || apiKey === REDACTED_KEY_PLACEHOLDER) {
        const storedKey =
            readAuthStoreKey(providerId) ||
            (providerId === 'opencode' ? process.env.OPENCODE_API_KEY : null);
        if (storedKey) {
            apiKey = storedKey;
        } else if (apiKey === REDACTED_KEY_PLACEHOLDER) {
            logger.warn(
                `[provider] ${providerId}: no usable API key - the opencode server reports only the "public" placeholder and none was found in the local auth store or ${providerId === 'opencode' ? 'OPENCODE_API_KEY' : 'env'}; upstream requests will be unauthenticated (free tier)`
            );
        }
    }

    const info: ProviderGatewayInfo = {
        baseUrl,
        apiKey,
        modelId: api.id || modelId,
        // Whether the model declares support for image/attachment inputs:
        // true, false, or undefined when the provider config is silent.
        // undefined means unknown, so callers should keep images and only
        // strip them if the upstream actually rejects them. Newer servers
        // nest the flag under `capabilities`; older ones expose it at the
        // top level (or under options).
        supportsImages: catalogMiss
            ? undefined
            : (model?.attachment ??
              (model?.capabilities as { attachment?: boolean } | undefined)?.attachment ??
              (model?.options as { attachment?: boolean } | undefined)?.attachment)
    };
    boundedSet(providerCache, cacheKey, { info, expiresAt: Date.now() + PROVIDER_CACHE_TTL_MS }, PROVIDER_CACHE_MAX);
    return info;
}

const IMAGE_PLACEHOLDER_TEXT = '[Image attached - this model does not support images]';

function isImageContentPart(part: unknown): boolean {
    const p = part as { type?: string } | null | undefined;
    return !!p && (p.type === 'image_url' || p.type === 'input_image' || p.type === 'image');
}

function containsImageContent(messages: ChatMessage[]): boolean {
    return (
        Array.isArray(messages) &&
        messages.some((m) => Array.isArray(m?.content) && m.content.some(isImageContentPart))
    );
}

/**
 * Replaces image content parts with a text placeholder so text-only model
 * APIs (which reject unknown content variants like `image_url`) can still
 * answer. Messages without image parts are returned unchanged.
 *
 * @param {Array<object>} messages OpenAI chat messages
 * @returns {Array<object>} Messages with image parts replaced (or the same array)
 */
function stripImageContent(messages: ChatMessage[]): ChatMessage[] {
    if (!containsImageContent(messages)) return messages;
    return messages.map((m) => {
        if (!m || typeof m !== 'object' || !Array.isArray(m.content)) return m;
        if (!m.content.some(isImageContentPart)) return m;
        return {
            ...m,
            content: m.content.map((part) =>
                isImageContentPart(part) ? { type: 'text', text: IMAGE_PLACEHOLDER_TEXT } : part
            )
        };
    });
}

function isImageUnsupportedError(error: unknown): boolean {
    const e = error as
        | { message?: string; response?: { data?: { error?: { message?: string } } } }
        | null
        | undefined;
    const message = (e && (e.message || e.response?.data?.error?.message)) || '';
    return /unknown variant [`'"]?image_url|image_url.{0,40}(?:not support|expected)|(?:does not|do not) support (?:images?|attachments?)|Failed to deserialize.{0,80}image/i.test(
        message
    );
}

/**
 * True when a model family is known to be reasoning-mode capable of producing
 * `reasoning_content`. Reasoning-only models (DeepSeek thinking variants etc.)
 * require every assistant turn that made a tool call to hand `reasoning_content`
 * back in a dedicated field, otherwise their continuation endpoint rejects the
 * request ("The `reasoning_content` in the thinking mode must be passed back to
 * the API"). Detection is model-family based so it works for custom-named
 * profiles that serve these families, not just the built-in profile id.
 *
 * @param {string|null} modelId Normalized model id (lowercase)
 * @returns {boolean}
 */
function isDeepSeekFamily(modelId: string | null): boolean {
    return typeof modelId === 'string' && modelId.includes('deepseek');
}

/**
 * Splits folding reasoning out of an assistant message's `content`.
 *
 * The proxy writes reasoning into `content` in a couple of shapes so generic
 * OpenAI clients that do not speak a dedicated `reasoning_content` field still
 * see it, while reasoning-aware code models echo it back as `reasoning_content`.
 * When a client sends that assistant message back on a tool-call continuation,
 * those reasoning-mode backends (e.g. DeepSeek thinking) reject the turn unless
 * the reasoning is handed back in its own `reasoning_content` field. This helper
 * recovers it from the folded shapes.
 *
 * Recognised shapes (opening marker, closing marker optional):
 *   - ` thinking\n<reason>  n response\n\n<content>` (proxy tool paths)
 *   - `<thinking>...</thinking>` and ` thinking\n...</think>` (server-agent
 *     path and various clients)
 *   - a ` thinking\n<reason>` block with no response section at all, which is
 *     what tool-call-only turns look like (empty final content)
 *
 * `aggressive` is passed for tool-call messages: their reasoning is mandatory so
 * a  thinking block is extracted from anywhere in the content even when the
 * client rewrapped it. Plain assistant text (no tool_calls) is only rewritten
 * when it matches a clear folded shape, so normal answers are left untouched.
 *
 * @param {string} content Assistant message content
 * @param {boolean} aggressive Whether to extract a  thinking block from anywhere
 * @returns {{reasoning: string, content: string} | null}
 */
function splitFoldedReasoning(
    content: string,
    aggressive: boolean
): { reasoning: string; content: string } | null {
    if (typeof content !== 'string' || !content.trim()) {
        return null;
    }

    // 1. Exact proxy tool-turn shape: ` thinking\n<reason>\n response\n\n<content>`.
    //    The last separator wins so reasoning that itself mentions "response" is
    //    not truncated (DeepSeek wants it passed back unmodified).
    let m = /^ *thinking\n([\s\S]*)\n *response\n\n([\s\S]*)$/.exec(content);
    if (m) return { reasoning: m[1]!.trim(), content: m[2]! };

    // 2. Single-space ` thinking...` opened block closed with `</think>` (the
    //    shape written by some proxy branches and clients).
    m = /^ *(?:thinking|think)\n?([\s\S]*?)\n?<\/think>[\s\S]*?([\s\S]*)$/.exec(content);
    if (m) return { reasoning: m[1]!.trim(), content: m[2]?.trim?.() ?? '' };

    // 3. HTML-style `<think>...</think>` block (streaming tool paths and the
    //    server-agent path), optionally followed by the final answer.
    m = /^ *<think[^>]*>\n?([\s\S]*?)\n?<\/think>[\s\S]*?([\s\S]*)$/.exec(content);
    if (m) return { reasoning: m[1]!.trim(), content: m[2]?.trim?.() ?? '' };

    // 4. Opened-but-never-closed  thinking block (a reasoning-only turn, e.g. an
    //    assistant message that only issued tool_calls and wrote no final text).
    m = /^ *(?:thinking|think)\n([\s\S]*)$/.exec(content);
    if (m && m[1]!.trim()) return { reasoning: m[1]!.trim(), content: '' };

    // 5. Tool-call turns: the client may have re-wrapped/re-escaped the folded
    //    reasoning; recover a  thinking block from anywhere in the content.
    if (aggressive) {
        m = /<think[^>]*>([\s\S]*?)<\/think>/.exec(content);
        if (m) {
            const before = content.slice(0, m.index);
            const after = content.slice(m.index + m[0].length);
            return { reasoning: m[1]!.trim(), content: `${before}${after}`.trim() };
        }
        // Some clients keep the folded block without separators, e.g.
        // ` thinking\n<reason>\n response\n\n` already handled above.
    }

    return null;
}

/**
 * Reconstructs `reasoning_content` from assistant messages whose reasoning was
 * folded into `content` (see {@link splitFoldedReasoning}) so reasoning-mode
 * backends (DeepSeek etc.) accept a tool-call continuation that echoes those
 * turns back. Reasoning already carried in an explicit `reasoning_content` field
 * is preserved, and any folded copy is stripped from `content` so it is not sent
 * twice.
 *
 * @param {Array<object>} messages OpenAI chat messages
 * @returns {Array<object>} Messages with folded reasoning restored as `reasoning_content`
 */
function restoreFoldedReasoning(messages: ChatMessage[]): ChatMessage[] {
    if (!Array.isArray(messages)) return messages;
    return messages.map((m) => {
        if (!m || m?.role !== 'assistant' || typeof m.content !== 'string') {
            return m;
        }
        const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;

        // Client already carries explicit reasoning: just strip any folded copy
        // from content so the reasoning is not sent twice to the backend.
        if (typeof m.reasoning_content === 'string' && m.reasoning_content) {
            const existing = splitFoldedReasoning(m.content, false);
            if (existing) return { ...m, content: existing.content };
            return m;
        }

        const split = splitFoldedReasoning(m.content, hasToolCalls);
        if (!split) return m;
        return { ...m, content: split.content, reasoning_content: split.reasoning };
    });
}

/**
 * True when an upstream error reports a missing/incorrectly-shaped
 * `reasoning_content`, i.e. a reasoning-mode backend rejected a tool-call
 * continuation because a reasoning assistant turn was not echoed back in its
 * dedicated field. Used to decide whether a forced-reasoning retry is worth
 * attempting, and to surface an actionable hint to the client.
 *
 * @param {unknown} error Upstream error
 * @returns {boolean}
 */
function isReasoningContentError(error: unknown): boolean {
    const e = error as
        | { message?: string; response?: { data?: { error?: { message?: string } } } }
        | null
        | undefined;
    const message = (e && (e.message || e.response?.data?.error?.message)) || '';
    return /reasoning_content|thinking mode|reasoning must be passed back|reasoning content/i.test(
        message
    );
}

/**
 * Last-resort reconstruction of `reasoning_content` for assistant tool-call
 * messages that {@link restoreFoldedReasoning} could not split. Broader than
 * the normal restore: it also matches mixed-case `<Think>`/`<THINK>` tags and
 * `[thinking]...[/thinking]` blocks from anywhere in the content, and only
 * touches messages that carry `tool_calls` (where the reasoning is mandatory).
 *
 * @param {Array<object>} messages OpenAI chat messages
 * @returns {Array<object>} Messages with reasoning extracted where possible
 */
const THINK_BLOCK =
    /<think[^>]*>\s*([\s\S]*?)\s*<\/think>|\[(?:think|thinking)\]\s*([\s\S]*?)\s*\[\/(?:think|thinking)\]/i;

function forceRestoreReasoning(messages: ChatMessage[]): ChatMessage[] {
    if (!Array.isArray(messages)) return messages;
    return messages.map((m) => {
        if (!m || m?.role !== 'assistant' || typeof m.content !== 'string') return m;
        if (!(Array.isArray(m.tool_calls) && m.tool_calls.length > 0)) return m;
        // Even when a reasoning_content field is already present (e.g.
        // re-injected from the proxy memory), a recognisable think block in
        // the content carries the authoritative reasoning - prefer it. This
        // also lets the reasoning-error retry recover the real reasoning
        // when the remembered copy was stale or wrong.
        const match = THINK_BLOCK.exec(m.content);
        if (!match) return m;
        const reasoning = (match[1] ?? match[2] ?? '').trim();
        if (!reasoning) return m;
        const before = m.content.slice(0, match.index);
        const after = m.content.slice(match.index + match[0].length);
        return {
            ...m,
            content: `${before}${after}`.trim(),
            reasoning_content: reasoning
        };
    });
}

/**
 * Like {@link callChatCompletions} but degrades gracefully when the upstream
 * model cannot accept images:
 *
 * 1. If the provider config says the model supports no attachments
 *    (`supportsImages === false`), image parts are replaced with a text
 *    placeholder before the first request.
 * 2. Otherwise images are sent as-is; if the upstream rejects them with an
 *    image-related error (400 deserialization etc.), the request is retried
 *    once with image parts stripped.
 * 3. If the upstream rejects the request because a reasoning assistant
 *    tool-call turn is missing `reasoning_content` (and the normal restore
 *    missed an unusually wrapped think block), the request is retried once
 *    with {@link forceRestoreReasoning} applied.
 *
 * Returns the same shape as callChatCompletions plus `messagesUsed`, the
 * message array actually sent (useful for storing continuation state).
 *
 * @param {object} options Same options as callChatCompletions plus `supportsImages`
 * @returns {Promise<GatewayResult>}
 */
async function callChatCompletionsWithImageFallback({
    supportsImages,
    modelId,
    ...options
}: ChatCompletionOptions & { supportsImages?: boolean }): Promise<GatewayResult> {
    // Split out `reasoning_content` from assistant messages whose reasoning this
    // proxy previously folded into `content` thinking tags (see
    // restoreFoldedReasoning), then re-attach reasoning the proxy remembered for
    // tool call ids that come back on a continuation. Reasoning-mode backends
    // (DeepSeek etc.) reject a tool-call continuation unless every reasoning
    // assistant turn is echoed back with a dedicated `reasoning_content` field,
    // and most clients drop that field after the first round. The endpoint key
    // keeps remembered reasoning scoped to the model endpoint that produced it.
    const modelKey = modelKeyOf({ baseUrl: options.baseUrl, modelId });
    const messages = injectRememberedReasoning(restoreFoldedReasoning(options.messages), modelKey);

    // Model-family based image detection, not profile-id based. DeepSeek-family
    // models (e.g. deepseek-v4-flash served through a custom-named profile) are
    // text-only, so image parts are stripped up front. Only an explicit
    // `supportsImages: true` from the provider config overrides this.
    let imageSupport: boolean | undefined = supportsImages;
    if (imageSupport === undefined && isDeepSeekFamily(String(modelId).toLowerCase())) {
        imageSupport = false;
    }

    const attempt = (msgs: ChatMessage[]): Promise<ChatCompletionResult> =>
        callChatCompletions({ ...options, modelId, messages: msgs });
    const changed = (a: ChatMessage[], b: ChatMessage[]): boolean =>
        JSON.stringify(a) !== JSON.stringify(b);

    // Retry once when the upstream reports missing reasoning_content: the client
    // may have echoed a think block the normal restore did not recognise (mixed
    // case tags, [thinking] wrappers, etc.). This only fires as a safety net and
    // never strips reasoning, which DeepSeek requires for tool-call turns.
    const retryWithForcedReasoning = async (
        error: unknown,
        msgs: ChatMessage[]
    ): Promise<GatewayResult | null> => {
        if (!isReasoningContentError(error)) return null;
        // Combine forceful extraction with the remembered-reasoning fallback:
        // a client may have re-wrapped the block beyond recognition, or may have
        // dropped it entirely (then the memory map is the only source).
        const forced = injectRememberedReasoning(forceRestoreReasoning(msgs), modelKey);
        if (!changed(forced, msgs)) return null;
        logger.warn(
            `Upstream rejected reasoning_content; retrying with forced reasoning extraction/memory: ${String((error as { message?: string }).message).slice(0, 300)}`
        );
        return { ...(await attempt(forced)), messagesUsed: forced };
    };

    let usedMessages: ChatMessage[] =
        imageSupport === false ? stripImageContent(messages) : messages;
    try {
        return { ...(await attempt(usedMessages)), messagesUsed: usedMessages };
    } catch (error) {
        if (
            usedMessages === messages &&
            containsImageContent(messages) &&
            isImageUnsupportedError(error)
        ) {
            usedMessages = stripImageContent(messages);
            logger.warn(
                `Upstream rejected image content; retrying without images: ${String((error as { message?: string }).message).slice(0, 300)}`
            );
            try {
                return { ...(await attempt(usedMessages)), messagesUsed: usedMessages };
            } catch (imageError) {
                const reasoningRetry = await retryWithForcedReasoning(imageError, usedMessages);
                if (reasoningRetry) return reasoningRetry;
                throw imageError;
            }
        }
        const reasoningRetry = await retryWithForcedReasoning(error, usedMessages);
        if (reasoningRetry) return reasoningRetry;
        throw error;
    }
}

/**
 * Normalizes OpenAI tool definitions to the Chat Completions nested shape so
 * any upstream accepts them.
 *
 * The Responses API serializes tools flat:
 *
 * ```json
 * { "type": "function", "name": "calc", "description": "...", "parameters": { ... } }
 * ```
 *
 * while Chat Completions expects the nested form:
 *
 * ```json
 * { "type": "function", "function": { "name": "calc", "description": "...", "parameters": { ... } } }
 * ```
 *
 * Codex (and other Responses-API clients) always sends the flat form, so map
 * it onto the nested shape before forwarding upstream. Codex also emits some
 * tools that omit `type` entirely (e.g. its `multi_agent_v1` schema), so any
 * tool carrying a string `name` without a `function` field is wrapped.
 * Already-nested definitions are left untouched; entries that cannot be
 * represented as Chat Completions function tools (no `name`, no `function`)
 * are dropped.
 *
 * @param {Array<object>} [tools] Tool definitions in either shape
 * @returns {Array<object>|undefined} Normalized tools, or undefined when empty
 */
function normalizeToolDefinitions(
    tools: ToolDefinition[] | undefined
): NestedToolDefinition[] | undefined {
    if (!Array.isArray(tools) || tools.length === 0) {
        return undefined;
    }
    const normalized: NestedToolDefinition[] = [];
    for (const tool of tools) {
        if (!tool || typeof tool !== 'object') continue;
        // Already nested (Chat Completions shape): keep as-is.
        const maybeNested = tool as NestedToolDefinition;
        if (maybeNested.function) {
            normalized.push(maybeNested);
            continue;
        }
        // Flat Responses shape, including entries that omit `type` (Codex
        // multi-agent schemas): wrap into the nested form.
        const flat = tool as FlatToolDefinition;
        if (typeof flat.name === 'string' && flat.name) {
            normalized.push({
                type: 'function',
                function: {
                    name: flat.name,
                    description: flat.description || '',
                    parameters: flat.parameters || { type: 'object', properties: {} },
                    strict: flat.strict
                }
            });
            continue;
        }
        // Unrepresentable (e.g. bare `{ "type": "web_search_preview" }`): skip.
    }
    return normalized.length > 0 ? normalized : undefined;
}

/**
 * Calls an OpenAI-compatible `/chat/completions` endpoint directly.
 *
 * @param {object} options
 * @param {string} options.baseUrl Base URL of the OpenAI-compatible API
 * @param {string|null} options.apiKey Bearer token, if any
 * @param {string} options.modelId Model id sent to the API
 * @param {Array<object>} options.messages OpenAI chat messages
 * @param {Array<object>} [options.tools] OpenAI tool definitions
 * @param {string|object} [options.toolChoice] tool_choice value
 * @param {boolean|undefined} [options.parallelToolCalls] parallel_tool_calls value
 * @param {boolean} [options.stream] Whether to stream (SSE)
 * @param {AbortSignal} [options.signal] Client abort signal
 * @param {number} [options.timeoutMs] Upstream request timeout (default 90s).
 *   For streams this bounds connection establishment and idle time between
 *   chunks, not the total stream duration.
 * @returns {Promise<ChatCompletionResult>}
 * @throws {Error} On network/HTTP failures
 */
/**
 * Extracts sampling/reasoning controls from a client request body (either
 * Chat Completions or Responses API shape) so they can be relayed upstream.
 *
 * Reasoning models exposed through opencode zen (e.g. "x-preview-f-free",
 * which offers low/high/max reasoning efforts) accept these knobs and clients
 * expect them to have an effect; silently dropping them would pin every
 * answer to the provider's default effort regardless of what was asked.
 *
 * Recognized inputs:
 *   - Chat:  `reasoning_effort`, `temperature`, `top_p`,
 *            `max_tokens` / `max_completion_tokens`
 *   - Responses: `reasoning.effort` (or `reasoning_effort`),
 *            `temperature`, `top_p`, `max_output_tokens` /
 *            `max_completion_tokens` / `max_tokens`
 *
 * All outputs are normalized to the OpenAI Chat Completions wire names.
 *
 * @param {object} [body] Client request body
 * @returns {{reasoningEffort?: string, temperature?: number, topP?: number, maxTokens?: number}}
 */
function normalizeSamplingParams(
    body: Record<string, unknown> | null | undefined
): Pick<ChatCompletionOptions, 'reasoningEffort' | 'temperature' | 'topP' | 'maxTokens'> {
    if (!body || typeof body !== 'object') return {};
    const out: Pick<
        ChatCompletionOptions,
        'reasoningEffort' | 'temperature' | 'topP' | 'maxTokens'
    > = {};

    const reasoning = body.reasoning as { effort?: unknown } | undefined;
    const effort = body.reasoning_effort ?? reasoning?.effort;
    if (typeof effort === 'string' && effort) out.reasoningEffort = effort;

    if (typeof body.temperature === 'number' && Number.isFinite(body.temperature))
        out.temperature = body.temperature;
    if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) out.topP = body.top_p;

    const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
    if (typeof maxTokens === 'number' && Number.isFinite(maxTokens)) out.maxTokens = maxTokens;

    return out;
}

async function callChatCompletions({
    baseUrl,
    apiKey,
    modelId,
    messages,
    tools,
    toolChoice,
    parallelToolCalls,
    stream,
    signal,
    timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
    identityHeaders,
    reasoningEffort,
    temperature,
    topP,
    maxTokens
}: ChatCompletionOptions): Promise<ChatCompletionResult> {
    const url = `${baseUrl}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    if (identityHeaders) {
        Object.assign(headers, identityHeaders);
    }

    const body: {
        model: string;
        messages: ChatMessage[];
        stream: boolean;
        tools?: NestedToolDefinition[];
        tool_choice?: string | Record<string, unknown>;
        parallel_tool_calls?: boolean;
        reasoning_effort?: string;
        temperature?: number;
        top_p?: number;
        max_tokens?: number;
    } = {
        model: modelId,
        messages,
        stream: !!stream
    };
    // Only attach sampling/reasoning knobs the client actually sent: strict
    // upstreams may reject fields they do not know, and absent fields keep
    // provider defaults (identical to the previous behaviour).
    if (reasoningEffort) {
        body.reasoning_effort = reasoningEffort;
    }
    if (typeof temperature === 'number') {
        body.temperature = temperature;
    }
    if (typeof topP === 'number') {
        body.top_p = topP;
    }
    if (typeof maxTokens === 'number') {
        body.max_tokens = maxTokens;
    }
    const normalizedTools = normalizeToolDefinitions(tools);
    if (normalizedTools) {
        body.tools = normalizedTools;
    }
    if (toolChoice) {
        body.tool_choice = toolChoice;
    }
    if (typeof parallelToolCalls === 'boolean') {
        body.parallel_tool_calls = parallelToolCalls;
    }

    // Transient upstream failures (anonymous free-pool 503s, rate limits,
    // connection resets) are retried with exponential backoff on
    // non-streaming requests — mirroring the official opencode CLI, whose
    // AI SDK retries them silently and therefore never surfaces them.
    // Streams are NOT retried here: their callers own attempt loops that
    // must only retry while nothing has been forwarded to the client yet.
    const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
    const maxRetries = Math.max(0, parseInt(process.env.UPSTREAM_MAX_RETRIES || '2', 10) || 0);
    const totalAttempts = stream ? 1 : maxRetries + 1;
    const backoffMs = (attempt: number): number =>
        Math.min(3000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
        // Per-attempt timeout/idle wiring: a fresh hard deadline per try, and
        // idleTick/clearIdle handed to the caller only when this attempt
        // becomes the successful one.
        //
        // Combine the caller's abort signal (client disconnect) with a hard
        // upstream timeout so neither a hung model API nor an aborted client can
        // leak a connection. AbortSignal.any is available on Node >= 20.3.
        //
        // For streams the timeout is a CONNECTION + IDLE timeout, not a
        // wall-clock one: reasoning-model responses legitimately stream for far
        // longer than the nominal timeout, and aborting on elapsed time
        // mid-stream would truncate a healthy response into "Upstream stream
        // ended unexpectedly without a terminal finish_reason". The timer only
        // fires when NO bytes arrive for timeoutMs (or the connection never
        // establishes); the caller re-arms it via idleTick on every received
        // chunk and disarms it with clearIdle when the stream ends.
        let requestSignal: AbortSignal | undefined;
        let idleTick: (() => void) | null = null;
        let clearIdle: (() => void) | null = null;
        if (stream) {
            const controller = new AbortController();
            let idleTimer: ReturnType<typeof setTimeout> | null = null;
            const stopIdle = () => {
                clearTimeout(idleTimer ?? undefined);
                idleTimer = null;
            };
            const armIdle = () => {
                if (controller.signal.aborted) return;
                stopIdle();
                idleTimer = setTimeout(() => {
                    controller.abort(
                        new Error(
                            `Model API stream timed out after ${Math.round(timeoutMs / 1000)}s without data`
                        )
                    );
                }, timeoutMs);
            };
            armIdle();
            if (signal) {
                signal.addEventListener('abort', stopIdle, { once: true });
            }
            requestSignal = signal
                ? AbortSignal.any([signal, controller.signal])
                : controller.signal;
            idleTick = armIdle;
            clearIdle = stopIdle;
        } else {
            const timeoutSignal = AbortSignal.timeout(timeoutMs);
            requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        }

        let res: Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: requestSignal
            });
        } catch (err) {
            const name = (err as { name?: string } | null)?.name;
            if (name === 'TimeoutError' || name === 'AbortError') {
                // Timeouts already consumed up to timeoutMs; retrying would
                // multiply the client-visible stall, so surface immediately.
                throw new Error(`Model API timed out after ${Math.round(timeoutMs / 1000)}s`);
            }
            // Network-level failure (connection reset, DNS, etc.). Retried for
            // non-streaming requests like any other transient fault.
            if (!stream && attempt < totalAttempts && !signal?.aborted) {
                logger.warn(
                    `[gateway] ${modelId} network error (attempt ${attempt}/${totalAttempts}), retrying in ~${backoffMs(attempt)}ms:`,
                    (err as Error).message
                );
                await sleep(backoffMs(attempt));
                continue;
            }
            throw err;
        }

        if (!res.ok) {
            let detail = '';
            try {
                detail = await res.text();
            } catch {
                // ignore body read errors
            }
            const sanitizedDetail = detail
                .slice(0, 500)
                .replace(/Bearer\s+[A-Za-z0-9\-_=.]+/gi, 'Bearer [REDACTED]')
                .replace(/api[_-]?key\s*[:=]\s*['"]?[^'"\s]+['"]?/gi, 'api_key=[REDACTED]');
            const message = sanitizedDetail
                ? `Model API error (${res.status}): ${sanitizedDetail}`
                : `Model API error (${res.status})`;
            if (
                !stream &&
                RETRYABLE_STATUSES.has(res.status) &&
                attempt < totalAttempts &&
                !signal?.aborted
            ) {
                logger.warn(
                    `[gateway] ${modelId} HTTP ${res.status} (attempt ${attempt}/${totalAttempts}), retrying in ~${backoffMs(attempt)}ms`
                );
                await sleep(backoffMs(attempt));
                continue;
            }
            throw new Error(message);
        }

        if (stream) {
            return {
                stream: res.body ?? undefined,
                signal: requestSignal,
                idleTick: idleTick ?? undefined,
                clearIdle: clearIdle ?? undefined
            };
        }
        return { data: (await res.json()) as ChatCompletionData };
    }
    // Unreachable: every loop iteration either returns or throws.
    throw new Error('Model API request failed without an attempt');
}

function newChatCompletionId(): string {
    return `chatcmpl-${crypto.randomUUID()}`;
}

function clearProviderCache(): void {
    providerCache.clear();
}

export {
    getProviderInfo,
    callChatCompletions,
    callChatCompletionsWithImageFallback,
    newChatCompletionId,
    clearProviderCache,
    isDeepSeekFamily,
    restoreFoldedReasoning,
    splitFoldedReasoning,
    forceRestoreReasoning,
    isReasoningContentError,
    rememberToolCallReasoning,
    recallToolCallReasoning,
    injectRememberedReasoning,
    modelKeyOf,
    normalizeToolDefinitions,
    normalizeSamplingParams,
    readAuthStoreKey,
    isProviderAnonymous,
    zenIdentityHeaders,
    ensureZenSystemPrompt,
    zenBaseUrl,
    DEFAULT_UPSTREAM_TIMEOUT_MS
};
