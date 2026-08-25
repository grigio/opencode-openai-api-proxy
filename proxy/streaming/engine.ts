import crypto from 'crypto';
import type { Request, Response } from 'express';
import {
    callChatCompletionsWithImageFallback,
    newChatCompletionId,
    modelKeyOf,
    rememberToolCallReasoning
} from '../model-gateway.ts';
import { consumeUpstreamSSE, sendResponseSseEvent } from '../sse.ts';
import { clientAbortSignal } from '../client.ts';
import { logger } from '../logger.ts';
import type {
    ChatMessage,
    ChatCompletionOptions,
    ProviderGatewayInfo,
    ToolDefinition
} from '../types.ts';
import { normalizeResponsesUsage } from '../utils.ts';

export const STREAM_CONTINUATION_NUDGE =
    'Your previous response was cut off by a connection error. Continue EXACTLY where it stopped - do not repeat or summarize anything you already produced and do not mention the interruption; just continue seamlessly.';

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
            message: responseError.message,
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
                return { message, statusCode, type: typeof type === 'string' ? type : undefined };
            }
        } catch {}
        return { message: raw, statusCode };
    }
    return { message: raw || 'Unknown upstream error' };
}

function isToolArgsTruncated(
    toolCalls: Map<string, { id: string; name: string; arguments: string }>
): boolean {
    for (const call of toolCalls.values()) {
        const args = call.arguments.trim();
        if (!args) continue;
        try {
            JSON.parse(args);
        } catch {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Shared chat completions streaming with resumption
// Used by both zen-direct and direct gateway chat paths (RESTRUCTURE #1)
// ---------------------------------------------------------------------------

export interface ChatStreamEngineOptions {
    req: Request;
    res: Response;
    providerId: string;
    modelId: string;
    initialMessages: ChatMessage[];
    providerInfo?: ProviderGatewayInfo | null;
    label?: string;
    makeUpstream: (messages: ChatMessage[]) => Promise<{
        stream: ReadableStream<Uint8Array>;
        signal: AbortSignal;
        idleTick?: () => void;
        clearIdle?: () => void;
    }>;
}

export async function streamChatCompletionsWithResumption(
    opts: ChatStreamEngineOptions
): Promise<void> {
    const {
        req: _req,
        res,
        providerId,
        modelId,
        initialMessages,
        providerInfo,
        label = 'tool-calling',
        makeUpstream
    } = opts;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const id = newChatCompletionId();
    const model = `${providerId}/${modelId}`;

    const MAX_UPSTREAM_STREAM_ATTEMPTS = 3;
    const MAX_CONTINUATION_SEGMENTS = 2;

    let streamedReasoning = '';
    const toolCallsSeen = new Map<string, { id: string; name: string; arguments: string }>();
    let finishForwarded = false;
    let sawUpstreamDone = false;
    let lastAttemptClean = false;
    let lastAttemptError: Error | null = null;

    const writeChunk = (payload: unknown) => {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    let activeMessages: ChatMessage[] = initialMessages;

    for (let segment = 0; !res.destroyed && segment <= MAX_CONTINUATION_SEGMENTS; segment++) {
        let forwardedAnything = false;
        let sawToolDeltas = false;
        let streamedContent = '';
        let pendingReasoning = '';
        let reasoningFlushed = false;
        let stopHere = false;

        for (let attempt = 0; !res.destroyed && attempt < MAX_UPSTREAM_STREAM_ATTEMPTS; attempt++) {
            streamedReasoning = '';
            toolCallsSeen.clear();
            finishForwarded = false;
            sawUpstreamDone = false;
            lastAttemptError = null;
            forwardedAnything = false;
            sawToolDeltas = false;
            streamedContent = '';
            pendingReasoning = '';
            reasoningFlushed = false;

            let upstream: ReadableStream<Uint8Array> | undefined;
            let requestSignal: AbortSignal | undefined;
            let idleTick: (() => void) | null = null;
            let clearIdle: (() => void) | null = null;
            try {
                const result = await makeUpstream(activeMessages);
                upstream = result.stream;
                requestSignal = result.signal;
                idleTick = result.idleTick ?? null;
                clearIdle = result.clearIdle ?? null;
            } catch (error) {
                lastAttemptError = error as Error;
                logger.warn(
                    `[${label}] ${providerId}/${modelId} stream attempt ${attempt + 1}/${MAX_UPSTREAM_STREAM_ATTEMPTS} failed to start:`,
                    (error as Error).message
                );
                continue;
            }

            const onData = (payload: string): boolean => {
                if (payload === '[DONE]') return false;
                let chunk: {
                    choices?: Array<{
                        delta?: Record<string, unknown> & {
                            reasoning_content?: string;
                            content?: string;
                            tool_calls?: Array<{
                                index?: number;
                                id?: string;
                                function?: { name?: string; arguments?: string };
                            }>;
                        };
                        finish_reason?: string | null;
                    }>;
                    usage?: unknown;
                };
                try {
                    chunk = JSON.parse(payload);
                } catch {
                    return false;
                }
                const upstreamChoice = (chunk.choices || [])[0] || {};
                const delta =
                    (upstreamChoice.delta as Record<string, unknown> & {
                        reasoning_content?: string;
                        content?: string;
                        tool_calls?: Array<{
                            index?: number;
                            id?: string;
                            function?: { name?: string; arguments?: string };
                        }>;
                    }) || {};
                const finish = upstreamChoice.finish_reason || null;
                const outDelta: Record<string, unknown> = {};

                if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                    streamedReasoning += delta.reasoning_content;
                    pendingReasoning += delta.reasoning_content;
                }
                if (typeof delta.content === 'string' && delta.content) {
                    outDelta.content = (outDelta.content || '') + delta.content;
                    streamedContent += delta.content;
                }
                if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
                    sawToolDeltas = true;
                    outDelta.tool_calls = delta.tool_calls;
                    for (const tc of delta.tool_calls) {
                        const key =
                            typeof tc?.index === 'number'
                                ? `i${tc.index}`
                                : (tc as { id?: string })?.id || `n${toolCallsSeen.size}`;
                        const existing = toolCallsSeen.get(key) || {
                            id: '',
                            name: '',
                            arguments: ''
                        };
                        if ((tc as { id?: string })?.id) existing.id = (tc as { id: string }).id;
                        if ((tc as { function?: { name?: string } })?.function?.name)
                            existing.name = (tc as { function: { name: string } }).function.name;
                        if (
                            typeof (tc as { function?: { arguments?: string } })?.function
                                ?.arguments === 'string'
                        ) {
                            existing.arguments += (
                                tc as { function: { arguments: string } }
                            ).function.arguments;
                        }
                        toolCallsSeen.set(key, existing);
                    }
                }

                const hasRealPayload = !!outDelta.content || !!outDelta.tool_calls || !!finish;
                if (hasRealPayload && pendingReasoning && !reasoningFlushed) {
                    writeChunk({
                        id,
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [
                            {
                                index: 0,
                                delta: { reasoning_content: pendingReasoning },
                                finish_reason: null
                            }
                        ],
                        usage: null
                    });
                    reasoningFlushed = true;
                    pendingReasoning = '';
                }

                if (typeof outDelta.content === 'string' && outDelta.content)
                    forwardedAnything = true;
                if (Array.isArray(outDelta.tool_calls) && outDelta.tool_calls.length > 0)
                    forwardedAnything = true;

                if (finish === 'length' && !finishForwarded) {
                    logger.warn(
                        `[${label}] ${providerId}/${modelId} upstream finished with reason=length (output token cap hit); surfacing the truncated turn`
                    );
                }
                if (finish) {
                    finishForwarded = true;
                }

                writeChunk({
                    id,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, delta: outDelta, finish_reason: finish }],
                    usage: (chunk as { usage?: unknown }).usage || null
                });
                return !!finish;
            };

            try {
                const result = await consumeUpstreamSSE({
                    upstream: upstream!,
                    signal: requestSignal,
                    res,
                    onData,
                    idleTick: idleTick ?? undefined,
                    clearIdle: clearIdle ?? undefined
                });
                lastAttemptClean = result.clean;
                sawUpstreamDone = result.sawDone;
            } catch (error) {
                lastAttemptError = error as Error;
                lastAttemptClean = false;
                logger.warn(
                    `[${label}] ${providerId}/${modelId} stream attempt ${attempt + 1}/${MAX_UPSTREAM_STREAM_ATTEMPTS} errored mid-flight:`,
                    (error as Error).message
                );
            }

            if (sawUpstreamDone || finishForwarded || res.destroyed) {
                stopHere = true;
                break;
            }

            if (!forwardedAnything) {
                lastAttemptError = new Error(
                    'Upstream stream ended before content ([DONE], finish_reason, or any delta)'
                );
                logger.warn(
                    `[${label}] ${providerId}/${modelId} stream attempt ${attempt + 1}/${MAX_UPSTREAM_STREAM_ATTEMPTS} ended before content, retrying:`,
                    lastAttemptError.message
                );
                continue;
            }

            if (!sawToolDeltas) break;
            stopHere = true;
            break;
        }

        if (stopHere || res.destroyed) break;

        if (forwardedAnything && !sawToolDeltas && segment < MAX_CONTINUATION_SEGMENTS) {
            const continuationMessages: ChatMessage[] = [];
            if (streamedContent) {
                continuationMessages.push({ role: 'assistant', content: streamedContent });
            }
            continuationMessages.push({ role: 'user', content: STREAM_CONTINUATION_NUDGE });
            activeMessages = [...activeMessages, ...continuationMessages];
            logger.warn(
                `[${label}] ${providerId}/${modelId} upstream died mid-turn after prose; continuing generation (segment ${segment + 2}/${MAX_CONTINUATION_SEGMENTS + 1})`
            );
            continue;
        }

        if (!lastAttemptError) {
            lastAttemptError = new Error(
                'Upstream stream ended unexpectedly without a terminal finish_reason'
            );
        }
        break;
    }

    if (!res.destroyed) {
        if (!finishForwarded) {
            const toolArgsTruncated = isToolArgsTruncated(toolCallsSeen);
            const terminalReason = toolCallsSeen.size > 0 ? 'tool_calls' : 'stop';
            const wireReason = toolArgsTruncated ? 'truncated' : terminalReason;
            const terminal: Record<string, unknown> = {
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: {}, finish_reason: wireReason }],
                usage: null
            };
            if (!lastAttemptClean || toolArgsTruncated || lastAttemptError) {
                if (lastAttemptError) {
                    const info = upstreamErrorInfo(lastAttemptError);
                    terminal.error = {
                        message: info.message,
                        ...(info.type ? { type: info.type } : {}),
                        ...(info.statusCode ? { code: info.statusCode } : {})
                    };
                } else if (toolArgsTruncated) {
                    terminal.error = {
                        message:
                            'Upstream stream ended before the tool call arguments were complete'
                    };
                } else {
                    terminal.error = {
                        message:
                            'Upstream stream ended unexpectedly without a terminal finish_reason'
                    };
                }
            }
            writeChunk(terminal);
            finishForwarded = true;
        }

        if (toolCallsSeen.size > 0 && streamedReasoning && providerInfo) {
            const modelKey = modelKeyOf(providerInfo);
            for (const call of toolCallsSeen.values()) {
                if (!call.id) continue;
                rememberToolCallReasoning(call.id, streamedReasoning, {
                    modelKey,
                    functionName: call.name,
                    functionArguments: call.arguments
                });
            }
        } else if (toolCallsSeen.size > 0 && streamedReasoning) {
            // Zen-direct case without providerInfo still needs modelKey for scoping
            const modelKey = `${providerId}/${modelId}`;
            for (const call of toolCallsSeen.values()) {
                if (!call.id) continue;
                rememberToolCallReasoning(call.id, streamedReasoning, {
                    modelKey,
                    functionName: call.name,
                    functionArguments: call.arguments
                });
            }
        }

        res.write('data: [DONE]\n\n');
        res.end();
    }
}

// ---------------------------------------------------------------------------
// Responses API streaming (tool calling)
// Extracted from app.ts handleToolsResponsesStream (~500 lines)
// Shares tool-accumulation and truncation logic with chat engine but emits
// Responses-API SSE events (response.created etc)
// ---------------------------------------------------------------------------

interface ToolItemTracker {
    itemId: string;
    callId: string;
    name: string;
    arguments: string;
    index: number;
}
interface OutputItemTracker {
    itemId: string;
    text: string;
    index: number;
}

export async function streamResponsesWithResumption(opts: {
    req: Request;
    res: Response;
    providerInfo: ProviderGatewayInfo;
    providerId: string;
    modelId: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: unknown;
    parallelToolCalls?: boolean;
    sampling?: Pick<
        ChatCompletionOptions,
        'reasoningEffort' | 'temperature' | 'topP' | 'maxTokens'
    >;
    zenDirectBaseUrl?: string;
}): Promise<void> {
    const {
        req,
        res,
        providerInfo,
        providerId,
        modelId,
        messages,
        tools,
        toolChoice,
        parallelToolCalls,
        sampling = {},
        zenDirectBaseUrl
    } = opts;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const responseId = `resp_${crypto.randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const model = `${providerId}/${modelId}`;

    const send = (payload: unknown) => sendResponseSseEvent(res, payload);

    send({
        type: 'response.created',
        response: {
            id: responseId,
            object: 'response',
            created_at: createdAt,
            status: 'in_progress',
            model
        }
    });

    const MAX_UPSTREAM_STREAM_ATTEMPTS = 3;

    let toolItems = new Map<number, ToolItemTracker>();
    let reasoningItem: OutputItemTracker | null = null;
    let messageItem: OutputItemTracker | null = null;
    let streamedReasoning = '';
    let streamUsage: Record<string, unknown> = {};
    let finishReason: string | null = null;
    let upstreamFinished = false;
    let nextOutputIndex = 0;
    let messagesUsed: ChatMessage[] | null | undefined = null;
    let lastAttemptClean = false;
    let sawUpstreamDone = false;
    let lastAttemptError: Error | null = null;

    for (let attempt = 0; attempt < MAX_UPSTREAM_STREAM_ATTEMPTS && !res.destroyed; attempt++) {
        toolItems = new Map();
        reasoningItem = null;
        messageItem = null;
        streamedReasoning = '';
        streamUsage = {};
        finishReason = null;
        upstreamFinished = false;
        nextOutputIndex = 0;
        lastAttemptError = null;

        const allocateIndex = () => nextOutputIndex++;

        const ensureReasoningItem = (): OutputItemTracker => {
            if (reasoningItem) return reasoningItem;
            reasoningItem = {
                itemId: `rs_${crypto.randomUUID()}`,
                text: '',
                index: allocateIndex()
            };
            send({
                type: 'response.output_item.added',
                response_id: responseId,
                output_index: reasoningItem.index,
                item: {
                    id: reasoningItem.itemId,
                    type: 'reasoning',
                    status: 'in_progress',
                    summary: [{ type: 'summary_text', text: '' }],
                    content: [{ type: 'reasoning_text', text: '' }]
                }
            });
            return reasoningItem;
        };

        const ensureMessageItem = (): OutputItemTracker => {
            if (messageItem) return messageItem;
            messageItem = {
                itemId: `msg_${crypto.randomUUID()}`,
                text: '',
                index: allocateIndex()
            };
            send({
                type: 'response.output_item.added',
                response_id: responseId,
                output_index: messageItem.index,
                item: {
                    id: messageItem.itemId,
                    type: 'message',
                    role: 'assistant',
                    status: 'in_progress',
                    content: [{ type: 'output_text', text: '' }]
                }
            });
            return messageItem;
        };

        const ensureToolItem = (index: number, callId: string, name: string) => {
            if (toolItems.has(index)) return;
            const itemId = `fc_${crypto.randomUUID()}`;
            toolItems.set(index, { itemId, callId, name, arguments: '', index: allocateIndex() });
            send({
                type: 'response.output_item.added',
                response_id: responseId,
                output_index: toolItems.get(index)!.index,
                item: {
                    id: itemId,
                    type: 'function_call',
                    status: 'in_progress',
                    call_id: callId,
                    name,
                    arguments: ''
                }
            });
        };

        const sendReasoningDelta = (delta: string) => {
            if (!reasoningItem) return;
            send({
                type: 'response.reasoning_text.delta',
                response_id: responseId,
                item_id: reasoningItem.itemId,
                output_index: reasoningItem.index,
                delta
            });
        };

        const sendTextDelta = (delta: string) => {
            if (!messageItem) return;
            send({
                type: 'response.output_text.delta',
                response_id: responseId,
                output_index: messageItem.index,
                content_index: 0,
                delta
            });
        };

        let upstream: ReadableStream<Uint8Array> | undefined;
        let requestSignal: AbortSignal | undefined;
        let idleTick: (() => void) | null = null;
        let clearIdle: (() => void) | null = null;
        try {
            const result = (await callChatCompletionsWithImageFallback({
                ...providerInfo,
                messages,
                tools,
                toolChoice: toolChoice as string | Record<string, unknown> | null | undefined,
                parallelToolCalls,
                stream: true,
                signal: clientAbortSignal(req),
                ...sampling,
                ...(zenDirectBaseUrl
                    ? {
                          baseUrl: zenDirectBaseUrl,
                          apiKey: 'public',
                          identityHeaders: (
                              await import('../model-gateway.ts')
                          ).zenIdentityHeaders()
                      }
                    : {})
            })) as unknown as {
                stream: ReadableStream<Uint8Array>;
                signal: AbortSignal;
                idleTick?: () => void;
                clearIdle?: () => void;
                messagesUsed?: ChatMessage[];
            };
            upstream = result.stream;
            requestSignal = result.signal;
            idleTick = result.idleTick ?? null;
            clearIdle = result.clearIdle ?? null;
            messagesUsed = result.messagesUsed;
        } catch (error) {
            lastAttemptError = error as Error;
            logger.warn(
                `[tool-calling] ${providerId}/${modelId} responses stream attempt ${attempt + 1}/${MAX_UPSTREAM_STREAM_ATTEMPTS} failed to start:`,
                (error as Error).message
            );
            continue;
        }

        const onData = (payload: string): boolean => {
            if (payload === '[DONE]') return false;
            let chunk: {
                choices?: Array<{
                    delta?: {
                        tool_calls?: Array<{
                            index?: number;
                            id?: string;
                            function?: { name?: string; arguments?: string };
                        }>;
                        reasoning_content?: string;
                        content?: string;
                    };
                    finish_reason?: string | null;
                }>;
                usage?: Record<string, unknown>;
            };
            try {
                chunk = JSON.parse(payload);
            } catch {
                return false;
            }
            const delta = chunk.choices?.[0]?.delta || {};
            const finish = chunk.choices?.[0]?.finish_reason || null;

            if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                    const index = (tc as { index?: number }).index ?? 0;
                    ensureToolItem(
                        index,
                        (tc as { id?: string }).id || '',
                        (tc as { function?: { name?: string } }).function?.name || ''
                    );
                    const item = toolItems.get(index)!;
                    if ((tc as { function?: { arguments?: string } }).function?.arguments) {
                        const args = (tc as { function: { arguments: string } }).function.arguments;
                        item.arguments += args;
                        send({
                            type: 'response.function_call_arguments.delta',
                            response_id: responseId,
                            item_id: item.itemId,
                            output_index: item.index,
                            delta: args
                        });
                    }
                }
            }
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                const ri = ensureReasoningItem();
                ri.text += delta.reasoning_content;
                streamedReasoning += delta.reasoning_content;
                sendReasoningDelta(delta.reasoning_content);
            }
            if (typeof delta.content === 'string' && delta.content) {
                const mi = ensureMessageItem();
                mi.text += delta.content;
                sendTextDelta(delta.content);
            }
            if (chunk.usage && Object.keys(chunk.usage).length > 0) {
                streamUsage = chunk.usage;
            }
            if (finish === 'length') {
                logger.warn(
                    `[tool-calling] ${providerId}/${modelId} responses upstream finished with reason=length (output token cap hit); surfacing the truncated turn`
                );
            }
            if (finish) {
                finishReason = finish;
            }
            if (
                finish ||
                (typeof delta.content === 'string' && delta.content) ||
                (typeof delta.reasoning_content === 'string' && delta.reasoning_content)
            ) {
                upstreamFinished = true;
            }
            return !!finish;
        };

        try {
            const result = await consumeUpstreamSSE({
                upstream: upstream!,
                signal: requestSignal,
                res,
                onData,
                idleTick: idleTick ?? undefined,
                clearIdle: clearIdle ?? undefined
            });
            lastAttemptClean = result.clean;
            sawUpstreamDone = result.sawDone;
        } catch (e) {
            lastAttemptError = e as Error;
            lastAttemptClean = false;
        }

        if (
            toolItems.size > 0 ||
            reasoningItem ||
            messageItem ||
            sawUpstreamDone ||
            finishReason !== null ||
            res.destroyed
        ) {
            break;
        }

        lastAttemptError = new Error(
            'Upstream stream ended before content ([DONE], finish_reason, or any delta)'
        );
        logger.warn(
            `[tool-calling] ${providerId}/${modelId} responses stream attempt ${attempt + 1}/${MAX_UPSTREAM_STREAM_ATTEMPTS} ended before content, retrying:`,
            lastAttemptError.message
        );
    }

    if (!res.destroyed) {
        const finalToolItems: Map<number, ToolItemTracker> = toolItems as Map<
            number,
            ToolItemTracker
        >;
        const finalReasoningItem: OutputItemTracker | null =
            reasoningItem as OutputItemTracker | null;
        const finalMessageItem: OutputItemTracker | null = messageItem as OutputItemTracker | null;

        if (
            !upstreamFinished &&
            finalToolItems.size === 0 &&
            !finalMessageItem &&
            !finalReasoningItem
        ) {
            const failureInfo = lastAttemptError ? upstreamErrorInfo(lastAttemptError) : null;
            const errorMessage =
                failureInfo?.message || 'Upstream stream ended without a terminal response';
            const errorItemId = `msg_${crypto.randomUUID()}`;
            send({
                type: 'response.output_item.added',
                response_id: responseId,
                output_index: 0,
                item: {
                    id: errorItemId,
                    type: 'message',
                    role: 'assistant',
                    status: 'incomplete',
                    content: [{ type: 'output_text', text: `Upstream error: ${errorMessage}` }]
                }
            });
            send({
                type: 'response.output_item.done',
                response_id: responseId,
                output_index: 0,
                item: {
                    id: errorItemId,
                    type: 'message',
                    role: 'assistant',
                    status: 'incomplete',
                    content: [{ type: 'output_text', text: `Upstream error: ${errorMessage}` }]
                }
            });
            send({
                type: 'response.completed',
                response: {
                    id: responseId,
                    object: 'response',
                    created_at: createdAt,
                    status: 'incomplete',
                    model,
                    output: [
                        {
                            id: errorItemId,
                            type: 'message',
                            role: 'assistant',
                            status: 'incomplete',
                            content: [
                                { type: 'output_text', text: `Upstream error: ${errorMessage}` }
                            ]
                        }
                    ],
                    parallel_tool_calls: false,
                    usage: null,
                    error: failureInfo
                        ? {
                              message: failureInfo.message,
                              ...(failureInfo.type ? { type: failureInfo.type } : {}),
                              ...(failureInfo.statusCode ? { code: failureInfo.statusCode } : {})
                          }
                        : { message: 'Upstream stream ended without a terminal response' }
                }
            });
            res.write('data: [DONE]\n\n');
            res.end();
            return;
        }

        const toolArgsTruncated = [...finalToolItems.values()].some((item) => {
            const args = item.arguments.trim();
            if (!args) return false;
            try {
                JSON.parse(args);
                return false;
            } catch {
                return true;
            }
        });
        const truncated = !lastAttemptClean || toolArgsTruncated;
        let truncationError: Record<string, unknown> | null = null;
        if (truncated) {
            if (lastAttemptError) {
                const info = upstreamErrorInfo(lastAttemptError);
                truncationError = {
                    message: info.message,
                    ...(info.type ? { type: info.type } : {}),
                    ...(info.statusCode ? { code: info.statusCode } : {})
                };
            } else if (toolArgsTruncated) {
                truncationError = {
                    message: 'Upstream stream ended before the tool call arguments were complete'
                };
            } else {
                truncationError = {
                    message: 'Upstream stream ended unexpectedly without a terminal response'
                };
            }
        }
        const outputStatus = truncated ? 'incomplete' : 'completed';

        if (finalReasoningItem) {
            send({
                type: 'response.output_item.done',
                response_id: responseId,
                output_index: finalReasoningItem.index,
                item: {
                    id: finalReasoningItem.itemId,
                    type: 'reasoning',
                    status: outputStatus,
                    summary: [{ type: 'summary_text', text: finalReasoningItem.text }],
                    content: [{ type: 'reasoning_text', text: finalReasoningItem.text }]
                }
            });
        }

        for (const item of finalToolItems.values()) {
            send({
                type: 'response.output_item.done',
                response_id: responseId,
                output_index: item.index,
                item: {
                    id: item.itemId,
                    type: 'function_call',
                    status: outputStatus,
                    call_id: item.callId,
                    name: item.name,
                    arguments: item.arguments
                }
            });
        }

        if (finalMessageItem) {
            send({
                type: 'response.output_item.done',
                response_id: responseId,
                output_index: finalMessageItem.index,
                item: {
                    id: finalMessageItem.itemId,
                    type: 'message',
                    role: 'assistant',
                    status: outputStatus,
                    content: [{ type: 'output_text', text: finalMessageItem.text }]
                }
            });
        }

        const output: Array<{ index?: number; [k: string]: unknown }> = [];
        if (finalReasoningItem) {
            output.push({
                id: finalReasoningItem.itemId,
                type: 'reasoning',
                status: outputStatus,
                index: finalReasoningItem.index,
                summary: [{ type: 'summary_text', text: finalReasoningItem.text }],
                content: [{ type: 'reasoning_text', text: finalReasoningItem.text }]
            });
        }
        if (finalMessageItem) {
            output.push({
                id: finalMessageItem.itemId,
                type: 'message',
                role: 'assistant',
                status: outputStatus,
                index: finalMessageItem.index,
                content: [{ type: 'output_text', text: finalMessageItem.text }]
            });
        }
        for (const item of finalToolItems.values()) {
            output.push({
                id: item.itemId,
                type: 'function_call',
                status: outputStatus,
                index: item.index,
                call_id: item.callId,
                name: item.name,
                arguments: item.arguments
            });
        }
        output
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .forEach((entry) => delete entry.index);

        const completedEvent: { type: string; response: Record<string, unknown> } = {
            type: 'response.completed',
            response: {
                id: responseId,
                object: 'response',
                created_at: createdAt,
                status: outputStatus,
                model,
                output,
                parallel_tool_calls: finalToolItems.size > 1,
                usage: normalizeResponsesUsage(streamUsage),
                error: truncationError
            }
        };
        if (finalToolItems.size > 0) {
            completedEvent.response.finish_reason = 'tool_calls';
        }
        send(completedEvent);

        const assistantToolMessage: ChatMessage | null =
            finalToolItems.size > 0
                ? {
                      role: 'assistant',
                      content: finalMessageItem ? finalMessageItem.text : '',
                      tool_calls: [...finalToolItems.values()].map((item) => ({
                          id: item.callId,
                          type: 'function',
                          function: { name: item.name, arguments: item.arguments }
                      })),
                      ...(streamedReasoning ? { reasoning_content: streamedReasoning } : {})
                  }
                : null;
        const { storeResponseState } = await import('../state.ts');
        storeResponseState(responseId, {
            messages: messagesUsed,
            assistantToolMessage,
            tools,
            model
        });

        if (finalToolItems.size > 0 && streamedReasoning) {
            const modelKey = modelKeyOf(providerInfo);
            for (const item of finalToolItems.values()) {
                rememberToolCallReasoning(item.callId, streamedReasoning, {
                    modelKey,
                    functionName: item.name,
                    functionArguments: item.arguments
                });
            }
        }

        res.write('data: [DONE]\n\n');
        res.end();
    }
}
