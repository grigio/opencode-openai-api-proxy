import type { ChatMessage, ResponsesUsage, ToolDefinition } from './types.ts';
import { logger } from './logger.ts';
import { isProviderAnonymous, isReasoningContentError } from './model-gateway.ts';

function buildResponsesUsage(
    promptText: string,
    content: string,
    reasoningContent: string
): ResponsesUsage {
    const inputTokens = Math.ceil(promptText.length / 4);
    const outputTokens = Math.ceil((content.length + reasoningContent.length) / 4);
    const reasoningTokens = Math.ceil(reasoningContent.length / 4);
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        output_tokens_details: { reasoning_tokens: reasoningTokens }
    };
}

function normalizeResponsesUsage(
    usage: Record<string, unknown> | null | undefined
): ResponsesUsage {
    const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
    const inputTokens =
        (u.input_tokens as number | undefined) ?? (u.prompt_tokens as number | undefined) ?? 0;
    const outputTokens =
        (u.output_tokens as number | undefined) ?? (u.completion_tokens as number | undefined) ?? 0;
    const reasoningTokens =
        (u.output_tokens_details as { reasoning_tokens?: number } | undefined)?.reasoning_tokens ??
        (u.completion_tokens_details as { reasoning_tokens?: number } | undefined)
            ?.reasoning_tokens ??
        0;
    const result: ResponsesUsage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: (u.total_tokens as number | undefined) ?? inputTokens + outputTokens
    };
    if (reasoningTokens > 0) {
        result.output_tokens_details = { reasoning_tokens: reasoningTokens };
    }
    return result;
}

function buildFinalMessage(message: ChatMessage): Record<string, unknown> {
    let content: string | null | undefined = '';
    if (typeof message.content === 'string') content = message.content;
    else if (Array.isArray(message.content)) content = JSON.stringify(message.content);
    else content = (message.content as unknown as string) || '';
    if (message.reasoning_content) {
        content = `<think>\n${message.reasoning_content}\n</think>\n\n${content || ''}`;
    }
    const result: Record<string, unknown> = { role: 'assistant', content: content || '' };
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        result.tool_calls = message.tool_calls;
    }
    if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
        result.reasoning_content = message.reasoning_content;
    }
    return result;
}

function gatewayUnavailableError(
    providerId: string,
    modelId: string
): { error: { message: string } } {
    return {
        error: {
            message: `Tool calling is unavailable for "${providerId}/${modelId}": no OpenAI-compatible endpoint could be resolved from the OpenCode provider config.`
        }
    };
}

function hasRequestedTools(tools: ToolDefinition[] | undefined, toolChoice: unknown): boolean {
    const hasToolDefs = Array.isArray(tools) && tools.length > 0;
    if (hasToolDefs) return true;
    if (typeof toolChoice === 'object' && toolChoice !== null) {
        const choice = toolChoice as { type?: unknown; function?: unknown };
        return choice.type === 'function' || !!choice.function;
    }
    return false;
}

function toolCallingMode(): string {
    return String(process.env.OPENCODE_TOOL_CALLING || 'auto').toLowerCase();
}

function shouldUseAgentTools(): boolean {
    return toolCallingMode() === 'agent';
}

function buildAgentToolsSystem(system: string, tools: ToolDefinition[] | undefined): string {
    const declared = (Array.isArray(tools) ? tools : [])
        .map((t) => {
            const tool = t as ToolDefinition & {
                name?: unknown;
                description?: unknown;
                function?: { name?: unknown; description?: unknown };
            };
            const name =
                (tool?.function as { name?: unknown })?.name ??
                (tool as { name?: unknown })?.name ??
                tool?.type;
            const desc =
                (tool?.function as { description?: unknown })?.description ??
                (tool as { description?: unknown })?.description;
            if (typeof name !== 'string' || !name) return null;
            return typeof desc === 'string' && desc ? `${name} - ${desc}` : name;
        })
        .filter((x): x is string => !!x);
    if (declared.length === 0) return system;
    const notice =
        `The client declared the following remote tools: ${declared.join(', ')}. ` +
        'These tools exist on the client side and cannot be invoked directly, so execute the request ' +
        'yourself end-to-end using your own built-in tools (bash, write, edit, webfetch, read, glob, grep, ls) ' +
        'inside the container. Never ask the user to run commands or paste results back - perform every step ' +
        'yourself and reply with the final outcome as normal text.';
    return system ? `${system}\n\n${notice}` : notice;
}

function logToolFailureDiagnostics(
    providerId: string,
    modelId: string,
    input: unknown,
    error: unknown
): void {
    const items = Array.isArray(input) ? input : [];
    const roles = items.map((m: Record<string, unknown>) => {
        if (m?.role) return m.role;
        if (m?.type === 'function_call_output') return 'tool';
        if (m?.type === 'function_call') return 'assistant(tool)';
        return m?.type || 'unknown';
    });
    const assistantMsgs = items.filter(
        (m: Record<string, unknown>) => m?.role === 'assistant' || m?.type === 'function_call'
    );
    const withToolCalls = items.filter(
        (m: Record<string, unknown>) =>
            Array.isArray(m?.tool_calls) && (m.tool_calls as unknown[]).length > 0
    ).length;
    const withReasoning = items.filter(
        (m: Record<string, unknown>) =>
            typeof m?.reasoning_content === 'string' && m.reasoning_content
    ).length;
    const withFoldedThink = items.filter(
        (m: Record<string, unknown>) =>
            typeof m?.content === 'string' &&
            /<think|<thinking| thinking/i.test(m.content as string)
    ).length;
    logger.error(
        `[tool-calling] ${providerId}/${modelId} upstream error: roles=[${roles.join(',')}] ` +
            `assistant=${assistantMsgs.length} tool_calls_msgs=${withToolCalls} reasoning_msgs=${withReasoning} ` +
            `folded_think_msgs=${withFoldedThink} error=${String((error as { message?: string } | undefined)?.message || error).slice(0, 300)}`
    );
}

function reasoningErrorHint(error: unknown): string {
    if (isReasoningContentError(error))
        return ' The upstream rejected the request because an assistant tool-call message was missing its reasoning_content. The proxy automatically re-injects reasoning it remembered from earlier turns of the same tool loop; if this still fails the client must echo the assistant tool_calls message (with reasoning_content, or the thinking-wrapped content) back on tool continuations.';
    return '';
}

function sanitizeErrorMessage(msg: string): string {
    if (!msg || typeof msg !== 'string') return 'Unknown upstream error';
    let out = msg.slice(0, 500);
    // Redact bearer tokens and API keys
    out = out.replace(/Bearer\s+[A-Za-z0-9\-_=.]+/gi, 'Bearer [REDACTED]');
    out = out.replace(/api[_-]?key\s*[:=]\s*['"]?[^'"\s]+['"]?/gi, 'api_key=[REDACTED]');
    // Redact URLs with credentials
    out = out.replace(/https?:\/\/[^@\s]+:[^@\s]+@[^\/\s]+/g, '[REDACTED_URL]');
    return out;
}

function upstreamErrorInfo(error: unknown): {
    message: string;
    statusCode?: number;
    type?: string;
} {
    const e = error as
        | {
              message?: string;
              response?: {
                  status?: number;
                  data?: { error?: { message?: string; type?: string } };
              };
          }
        | null
        | undefined;
    if (!e) return { message: 'Unknown upstream error' };
    const responseError = e.response?.data?.error;
    if (responseError?.message) {
        return {
            message: sanitizeErrorMessage(responseError.message),
            type: responseError.type,
            statusCode: e.response?.status
        };
    }
    const raw = e.message || '';
    const statusMatch = /^Model API error \((\d+)\)(?:: )?/.exec(raw);
    if (statusMatch) {
        const statusCode = Number(statusMatch[1]);
        const tail = raw.slice(statusMatch[0].length);
        try {
            const payload = JSON.parse(tail) as {
                error?: { message?: string; type?: string };
                message?: string;
                type?: string;
            };
            const nested = payload?.error;
            const message = nested?.message || payload?.message;
            if (typeof message === 'string' && message) {
                const type = nested?.type || payload?.type;
                return {
                    message: sanitizeErrorMessage(message),
                    statusCode,
                    type: typeof type === 'string' ? type : undefined
                };
            }
        } catch {}
        return { message: sanitizeErrorMessage(raw), statusCode };
    }
    return { message: sanitizeErrorMessage(raw || 'Unknown upstream error') };
}

function buildResponsesToolMessages(
    input: unknown,
    previousResponseId: string | undefined,
    getState: (
        id: string
    ) => { messages?: ChatMessage[] | null; assistantToolMessage?: ChatMessage | null } | null,
    responsesInputToMessages: (input: unknown) => ChatMessage[]
): ChatMessage[] {
    let messages = responsesInputToMessages(input);
    const hasToolOutputs = messages.length > 0 && messages.some((m) => m.role === 'tool');
    if (hasToolOutputs && previousResponseId) {
        const prev = getState(previousResponseId);
        if (prev?.messages) {
            const merged = [...prev.messages];
            if (prev.assistantToolMessage) merged.push(prev.assistantToolMessage);
            merged.push(...messages);
            messages = merged;
        }
    }
    return messages;
}

function deriveToolsFromMessages(messages: ChatMessage[]): ToolDefinition[] | undefined {
    if (!Array.isArray(messages)) return undefined;
    const names = new Set<string>();
    for (const m of messages) {
        if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
        for (const tc of m.tool_calls) {
            const name = tc?.function?.name;
            if (typeof name === 'string' && name) names.add(name);
        }
    }
    if (names.size === 0) return undefined;
    return [...names].map((name) => ({
        type: 'function',
        function: { name, description: '', parameters: { type: 'object', properties: {} } }
    })) as ToolDefinition[];
}

const MAX_REPEATED_TOOL_LOOPS = (() => {
    const raw =
        process.env.OPENCODE_TOOL_LOOP_LIMIT ??
        process.env.TOOL_LOOP_LIMIT ??
        process.env.MAX_REPEATED_TOOL_LOOPS;
    const n = raw !== undefined ? Number.parseInt(String(raw), 10) : NaN;
    if (Number.isFinite(n) && n >= 0) return n;
    // Default 15: allows tools like write_stdin that may legitimately be called
    // several times in a row (e.g. chunked writes / retries) without tripping
    // the false-positive 422 that previously aborted at 4 identical calls.
    return 15;
})();

function isToolLoopCheckDisabled(): boolean {
    // DISABLE_TOOL_LOOP_CHECK=1/true disables; TOOL_LOOP_DETECTION=false/0/disabled also disables
    const disableRaw = process.env.DISABLE_TOOL_LOOP_CHECK ?? process.env.OPENCODE_DISABLE_TOOL_LOOP;
    if (disableRaw !== undefined) {
        const v = String(disableRaw).toLowerCase().trim();
        if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    }
    const detectionRaw = process.env.TOOL_LOOP_DETECTION ?? process.env.OPENCODE_TOOL_LOOP_DETECTION;
    if (detectionRaw !== undefined) {
        const v = String(detectionRaw).toLowerCase().trim();
        if (v === '0' || v === 'false' || v === 'no' || v === 'off' || v === 'disabled') return true;
    }
    return false;
}

function findRepeatedToolCallLoop(messages: unknown): { name: string } | null {
    if (isToolLoopCheckDisabled()) return null;
    if (!Array.isArray(messages)) return null;
    let consecutive = 0;
    let lastSignature: string | null = null;
    for (const m of messages as Array<{
        role?: string;
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    }>) {
        if (m?.role !== 'assistant') continue;
        if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) {
            consecutive = 0;
            lastSignature = null;
            continue;
        }
        const signature = m.tool_calls
            .map((tc) => {
                const name = tc?.function?.name || '';
                let args = tc?.function?.arguments || '';
                try {
                    args = JSON.stringify(JSON.parse(args));
                } catch {}
                return `${name}(${args})`;
            })
            .sort()
            .join('|');
        if (signature === lastSignature) {
            consecutive += 1;
        } else {
            consecutive = 1;
            lastSignature = signature;
        }
        if (consecutive > MAX_REPEATED_TOOL_LOOPS) {
            return { name: lastSignature!.split('(')[0]! };
        }
    }
    return null;
}

const REFUSAL_PATTERN =
    /\b(?:ready|nothing to do|no request|no task|can'?t see)\b|\bwhat would you (?:like|do|work on)\b|\bhelp\s+with\b/i;

/**
 * Whether a model output looks like a refusal to answer (no tools allowed).
 * Honors DISABLE_REFUSAL_CHECK env to allow legitimate short answers that
 * would otherwise false-positive (e.g. "ready" as a valid answer).
 */
function isRefusal(text: string): boolean {
    if (process.env.DISABLE_REFUSAL_CHECK === '1' || process.env.DISABLE_REFUSAL_CHECK === 'true')
        return false;
    return REFUSAL_PATTERN.test(text);
}
const SERVER_AGENT_TOOLS: { [k: string]: boolean } = { write: false, edit: false, bash: false };
const AGENT_TOOLS_ENABLED: { [k: string]: boolean } = {
    bash: true,
    write: true,
    edit: true,
    webfetch: true,
    read: true,
    glob: true,
    grep: true,
    ls: true,
    fetch: true
};

function shouldUseZenDirect(
    providerInfo: import('./types.ts').ProviderGatewayInfo | null | undefined,
    providerId: string
): boolean {
    // In auto mode the anonymous opencode free tier is offered via a direct
    // zen call so the *client* can execute tools locally (tool_calls are
    // returned). The gateway gates that pool on `User-Agent: opencode/...`
    // and on the "You are opencode" system prefix; requests without them get
    // 429. When the gateway rejects the direct call with 403 FreeTierError
    // ("can only be used from within OpenCode") the caller falls back to
    // the server-agent path, which is "within OpenCode" and always succeeds
    // like the official CLI – this makes anonymous requests behave like
    // opencode instead of surfacing the 403.
    if (toolCallingMode() !== 'auto') return false;
    return providerId === 'opencode' && isProviderAnonymous(providerInfo);
}

function shouldUseServerAgent(
    providerInfo: import('./types.ts').ProviderGatewayInfo | null | undefined,
    providerId: string
): boolean {
    if (toolCallingMode() === 'agent') return true;
    if (toolCallingMode() !== 'auto') return false;
    // In auto mode, anonymous opencode providers are "within OpenCode" only
    // when delegated to the local opencode server. The server creates a real
    // session/project and is allow-listed, so it never hits the 403 that
    // direct anonymous zen calls from the proxy now receive.
    if (providerId === 'opencode' && isProviderAnonymous(providerInfo)) return true;
    return false;
}

function isFreeTierError(error: unknown): boolean {
    const msg = String(
        (error as { message?: string })?.message ||
            (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data
                ?.error?.message ||
            ''
    );
    return /FreeTierError|can only be used from within OpenCode/i.test(msg);
}

export {
    buildResponsesUsage,
    normalizeResponsesUsage,
    buildFinalMessage,
    gatewayUnavailableError,
    hasRequestedTools,
    toolCallingMode,
    shouldUseAgentTools,
    shouldUseServerAgent,
    shouldUseZenDirect,
    isFreeTierError,
    buildAgentToolsSystem,
    logToolFailureDiagnostics,
    reasoningErrorHint,
    sanitizeErrorMessage,
    upstreamErrorInfo,
    buildResponsesToolMessages,
    deriveToolsFromMessages,
    findRepeatedToolCallLoop,
    MAX_REPEATED_TOOL_LOOPS,
    REFUSAL_PATTERN,
    isRefusal,
    SERVER_AGENT_TOOLS,
    AGENT_TOOLS_ENABLED
};
