/**
 * Shared domain types for the OpenAI-compatible proxy.
 *
 * Everything here is erasable TypeScript (type aliases / interfaces only), so
 * Node.js runs these files natively via type stripping with zero build output.
 * The proxy translates between three wire formats — OpenAI Chat Completions,
 * the OpenAI Responses API, and the OpenCode SDK event stream — and these
 * types describe those shapes. Upstreams are remote and loosely typed, so the
 * boundaries deliberately stay permissive (optional fields, `unknown` values)
 * and the runtime guards from the original implementation are preserved.
 */

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

/** A single content part inside a multi-part chat message. */
export type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'input_text'; text: string }
    | { type: 'output_text'; text: string }
    | { type: 'image_url'; image_url: string | { url: string } }
    | { type: 'input_image'; image_url?: string | { url: string }; url?: string }
    | { type: 'image'; url?: string }
    | Record<string, unknown>;

export type ChatContent = string | ContentPart[];

/** A function call inside an assistant message's `tool_calls`. */
export interface ChatToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

/**
 * An OpenAI chat message, including the extra `reasoning_content` field the
 * proxy injects/re-constructs for reasoning-mode backends (DeepSeek etc.).
 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: ChatContent | null;
    tool_calls?: ChatToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;
    name?: string;
}

/** Flat Responses-API tool definition (Codex serialization). */
export interface FlatToolDefinition {
    type: string;
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
}

/** Nested Chat-Completions tool definition. */
export interface NestedToolDefinition {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        strict?: boolean;
    };
}

export type ToolDefinition = FlatToolDefinition | NestedToolDefinition;

/** Parsed `providerId/modelId` pair. */
export interface ModelRef {
    providerId: string;
    modelId: string;
}

/** Result of resolving a model's OpenAI-compatible endpoint. */
export interface ProviderGatewayInfo {
    baseUrl: string;
    apiKey: string | null;
    modelId: string;
    /** true/false/undefined (unknown) — whether the model accepts image inputs. */
    supportsImages?: boolean;
}

/** Lenient provider-config shape (the runtime tolerates array-or-object). */
export interface ProviderLike {
    id?: string;
    key?: string;
    options?: Record<string, unknown>;
    models?: Record<string, ProviderModelLike>;
}

export interface ProviderModelLike {
    id?: string;
    name?: string;
    label?: string;
    release_date?: string;
    attachment?: boolean;
    api?: { id?: string; url?: string; npm?: string };
    options?: Record<string, unknown>;
    /** Newer opencode servers nest capability flags here. */
    capabilities?:
        { attachment?: boolean; reasoning?: boolean; toolcall?: boolean } | Record<string, unknown>;
}

/** Options accepted by the direct model-API gateway. */
export interface ChatCompletionOptions {
    baseUrl: string;
    apiKey: string | null;
    modelId: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: string | Record<string, unknown> | null;
    parallelToolCalls?: boolean;
    stream?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Extra headers to send on the upstream request. */
    identityHeaders?: Record<string, string>;
    /** Sampling/reasoning controls relayed from the client request. */
    reasoningEffort?: string;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
}

/** Result of a direct model-API call (streaming or not). */
export interface ChatCompletionResult {
    data?: ChatCompletionData;
    stream?: ReadableStream<Uint8Array>;
    signal?: AbortSignal;
    idleTick?: () => void;
    clearIdle?: () => void;
}

export interface ChatCompletionData {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices?: ChatCompletionChoice[];
    usage?: Record<string, unknown> | null;
}

export interface ChatCompletionChoice {
    index?: number;
    message?: ChatMessage;
    delta?: Record<string, unknown>;
    finish_reason?: string | null;
}

/** Tool-call delta inside a streaming chunk. */
export interface ToolCallDelta {
    index?: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
}

/** Result of the image/reasoning-fallback wrapper (adds `messagesUsed`). */
export interface GatewayResult extends ChatCompletionResult {
    messagesUsed?: ChatMessage[];
}

/**
 * Shape of errors thrown by upstream model-API calls (fetch), as consumed in
 * the route handlers' catch blocks. Kept structural so app.ts and
 * model-gateway.ts stay decoupled from the HTTP client's concrete error class
 * while still surfacing the message/cause fields.
 */
export interface UpstreamErrorLike {
    message?: string;
    cause?: { message?: string } | unknown;
    stack?: string;
    response?: { data?: { error?: { message?: string } } };
}

/** Metadata used to scope remembered reasoning to the exact tool call. */
export interface ReasoningMeta {
    modelKey?: string;
    functionName?: string;
    functionArguments?: string;
}

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

/** An input item accepted by the Responses API (`input` array). */
export type ResponsesInputItem =
    | string
    | { role: string; content?: unknown }
    | {
          type: 'message';
          role?: string;
          content?: string | Array<{ type: string; text?: string }>;
      }
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; image_url?: string; url?: string }
    | {
          type: 'function_call';
          call_id?: string;
          id?: string;
          name: string;
          arguments: string | Record<string, unknown>;
      }
    | {
          type: 'function_call_output';
          call_id?: string;
          id?: string;
          output: string | Record<string, unknown> | null;
      }
    | Record<string, unknown>;

/** A `reasoning`/`message`/`function_call` output item. */
export interface ResponsesOutputItem {
    id: string;
    type: 'reasoning' | 'message' | 'function_call';
    status?: string;
    index?: number;
    role?: string;
    summary?: Array<{ type: string; text: string }>;
    content?: Array<{ type: string; text: string }>;
    call_id?: string;
    name?: string;
    arguments?: string;
    text?: string;
}

/** Conversation/continuation state stored per `resp_*` id. */
export interface ResponseState {
    sessionId?: string;
    model?: string;
    messages?: ChatMessage[] | null;
    assistantToolMessage?: ChatMessage | null;
    tools?: ToolDefinition[];
    expiresAt: number;
}

/** Normalized Responses-API usage object. */
export interface ResponsesUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    output_tokens_details?: { reasoning_tokens: number };
}

// ---------------------------------------------------------------------------
// OpenCode SDK event stream
// ---------------------------------------------------------------------------

/**
 * A single event from the OpenCode SSE stream. Deliberately lenient: the
 * proxy consumes a wire protocol that is a superset of the current SDK type
 * definitions (e.g. `message.part.delta` is emitted by newer servers but not
 * yet declared in the SDK union), so the exact fields the consumer relies on
 * are declared explicitly and everything else stays unknown.
 */
export interface OpenCodeStreamEvent {
    type: string;
    properties?: Record<string, unknown> & {
        sessionID?: string;
        messageID?: string;
        partID?: string;
        field?: string;
        delta?: string;
        info?: {
            id?: string;
            sessionID?: string;
            role?: string;
            finish?: string;
        };
        part?: {
            id?: string;
            sessionID?: string;
            messageID?: string;
            role?: string;
            type?: string;
            text?: string;
        };
        error?: { data?: { message?: string }; message?: string };
    };
}

/** Mutable stream state shared between the consumer and its caller. */
export interface StreamState {
    ended: boolean;
    streamedAnything: boolean;
    insideReasoning: boolean;
}

// ---------------------------------------------------------------------------
// Typed request bodies (replaces `any` per RESTRUCTURE #4)
// ---------------------------------------------------------------------------

export interface ChatCompletionBody {
    model?: unknown;
    messages?: ChatMessage[];
    stream?: boolean;
    tools?: ToolDefinition[];
    tool_choice?: unknown;
    parallel_tool_calls?: boolean;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    max_output_tokens?: number;
    reasoning_effort?: string;
    reasoning?: { effort?: unknown };
    instructions?: unknown;
    input?: unknown;
    [k: string]: unknown;
}

export interface ResponsesBody {
    model?: unknown;
    input?: unknown;
    instructions?: unknown;
    stream?: boolean;
    tools?: ToolDefinition[];
    tool_choice?: unknown;
    parallel_tool_calls?: boolean;
    previous_response_id?: string;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    max_output_tokens?: number;
    reasoning_effort?: string;
    reasoning?: { effort?: unknown };
    [k: string]: unknown;
}
