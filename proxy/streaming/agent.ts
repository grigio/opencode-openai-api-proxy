import crypto from 'crypto';
import type { Response } from 'express';
import type { OpencodeClient, SessionPromptData } from '@opencode-ai/sdk';
import { consumeStreamEvents, sendResponseSseEvent } from '../sse.ts';
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from '../model-gateway.ts';
import { isRefusal, SERVER_AGENT_TOOLS } from '../utils.ts';
import type { PromptPart } from '../prompts.ts';
import { storeResponseState } from '../state.ts';
import { buildResponsesUsage } from '../utils.ts';
import { logger } from '../logger.ts';

interface RunAgentPromptOptions {
    client: OpencodeClient;
    sessionId?: string;
    providerId: string;
    modelId: string;
    prompt: string;
    system: string;
    parts: PromptPart[];
    label: string;
    maxAttempts?: number;
    timeoutMs?: number;
    toolsMap?: { [k: string]: boolean } | null;
}

interface AgentPromptResultData {
    info?: unknown;
    parts?: Array<{ type?: string; text?: string }>;
    message?: unknown;
    [k: string]: unknown;
}

interface OutputItemTracker {
    itemId: string;
    text: string;
    index: number;
}

/**
 * Runs a non-streaming server-agent prompt with retries for agent-style models
 * that occasionally error, time out, or refuse when no tools are allowed.
 */
async function runAgentPromptWithRetry({
    client,
    sessionId,
    providerId,
    modelId,
    prompt,
    system,
    parts,
    label,
    maxAttempts = 3,
    timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
    toolsMap = SERVER_AGENT_TOOLS
}: RunAgentPromptOptions): Promise<{
    data: AgentPromptResultData | null;
    lastUsedError: Error | null;
}> {
    let data: AgentPromptResultData | null = null;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let attemptSessionId = sessionId;
        if (!attemptSessionId) {
            const created = await client.session.create();
            attemptSessionId = created.data?.id;
            if (!attemptSessionId) throw new Error('Failed to create session');
        }

        const attemptPromise = client.session.prompt({
            path: { id: attemptSessionId },
            body: {
                model: { providerID: providerId, modelID: modelId },
                prompt: prompt.trim(),
                system: system.trim(),
                parts,
                ...(toolsMap === null ? {} : { tools: toolsMap })
            } as SessionPromptData['body'] & { prompt: string }
        });
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(
                () =>
                    reject(
                        new Error(
                            `Attempt ${attempt} timed out after ${Math.round(timeoutMs / 1000)}s`
                        )
                    ),
                timeoutMs
            );
        });

        let responseRes: Awaited<ReturnType<typeof client.session.prompt>> | undefined;
        try {
            responseRes = (await Promise.race([attemptPromise, timeoutPromise])) as Awaited<
                ReturnType<typeof client.session.prompt>
            >;
        } catch (e) {
            lastError = e as Error;
            logger.warn(`${label} attempt ${attempt}/${maxAttempts} failed:`, (e as Error).message);
            if (attempt >= maxAttempts) break;
            continue;
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
        }

        if (responseRes?.response?.status >= 400) {
            lastError = new Error(
                (responseRes as unknown as { error?: { message?: string } } | null)?.error
                    ?.message ||
                    (
                        responseRes?.response?.body as unknown as {
                            error?: { message?: string };
                        } | null
                    )?.error?.message ||
                    `OpenCode server returned HTTP ${responseRes.response.status}`
            );
            logger.warn(`${label} attempt ${attempt}/${maxAttempts} error:`, lastError.message);
            if (attempt >= maxAttempts) break;
            continue;
        }

        const attemptParts = responseRes.data?.parts || [];
        const attemptText = attemptParts
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('');
        if (attemptText.trim() && isRefusal(attemptText.slice(0, 150))) {
            lastError = new Error(
                'Model refused to answer (no tools allowed in this proxy branch)'
            );
            logger.warn(
                `${label} attempt ${attempt}/${maxAttempts} refused: "${attemptText.slice(0, 60)}"`
            );
            if (attempt >= maxAttempts) {
                data = responseRes.data as unknown as AgentPromptResultData;
            }
            continue;
        }

        data = responseRes.data as unknown as AgentPromptResultData;
        return { data, lastUsedError: null };
    }

    return { data, lastUsedError: lastError };
}

// ---------------------------------------------------------------------------
// Shared driver around consumeStreamEvents (RESTRUCTURE #1 - agent streams)
// ---------------------------------------------------------------------------

interface AgentStreamDriverOptions {
    res: Response;
    client: OpencodeClient;
    sessionId: string;
    onFinish: (finish: string) => void;
    onFail: (msg: string) => void;
    onReasoningStart: () => void;
    onReasoningDelta: (delta: string) => void;
    onReasoningEnd: () => void;
    onTextDelta: (delta: string) => void;
    getPromptError: () => Error | null;
}

async function runAgentStreamDriver(opts: AgentStreamDriverOptions): Promise<void> {
    const {
        res,
        client,
        sessionId,
        onFinish,
        onFail,
        onReasoningStart,
        onReasoningDelta,
        onReasoningEnd,
        onTextDelta,
        getPromptError
    } = opts;
    const eventStreamResult = await client.event.subscribe();
    const eventStream = eventStreamResult.stream;
    const eventIterator = eventStream[Symbol.asyncIterator]();
    const state = { ended: false, streamedAnything: false, insideReasoning: false };
    const keepaliveInterval = setInterval(() => {
        if (!res.destroyed) res.write(': keepalive\n\n');
    }, 15000);

    const finalize = (finish: string) => {
        if (state.ended) return;
        state.ended = true;
        clearInterval(keepaliveInterval);
        if (!res.destroyed) onFinish(finish);
    };
    const fail = (msg: string) => {
        if (state.ended) return;
        state.ended = true;
        clearInterval(keepaliveInterval);
        if (res.destroyed) return;
        if (state.streamedAnything) {
            onFail(msg);
        }
    };

    await consumeStreamEvents({
        eventIterator,
        sessionId,
        res,
        state,
        getPromptError,
        onFinish: (f) => finalize(f === 'stop' ? 'stop' : f),
        onFail: (m) => {
            if (state.streamedAnything) onFail(m);
            else fail(m);
        },
        onReasoningStart,
        onReasoningDelta: (d) => {
            state.streamedAnything = true;
            onReasoningDelta(d);
        },
        onReasoningEnd,
        onTextDelta: (d) => {
            state.streamedAnything = true;
            onTextDelta(d);
        }
    });

    clearInterval(keepaliveInterval);
    // Return state to caller via closure if needed; for agent chat we handle externally
}

// ---------------------------------------------------------------------------
// Chat completion agent streaming
// ---------------------------------------------------------------------------

interface AgentChatStreamOptions {
    res: Response;
    client: OpencodeClient;
    providerId: string;
    modelId: string;
    fullPromptText: string;
    systemPrompt: string;
    allParts: PromptPart[];
    toolsMap: { [k: string]: boolean };
    ignoredTools: boolean;
}

async function streamAgentChatCompletion({
    res,
    client,
    providerId,
    modelId,
    fullPromptText,
    systemPrompt,
    allParts,
    toolsMap,
    ignoredTools
}: AgentChatStreamOptions): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const id = `chatcmpl-${crypto.randomUUID()}`;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let attemptErrorMsg: string | null = null;

    for (let attempt = 1; attempt <= 3 && !res.destroyed; attempt++) {
        const attemptSession = await client.session.create();
        const sessionId = attemptSession.data?.id;
        if (!sessionId) throw new Error('Failed to create session');

        let promptError: Error | null = null;
        attemptErrorMsg = null;
        const state = { ended: false, streamedAnything: false, insideReasoning: false };

        client.session
            .prompt({
                path: { id: sessionId },
                body: {
                    model: { providerID: providerId, modelID: modelId },
                    prompt: fullPromptText.trim(),
                    system: systemPrompt.trim(),
                    parts: allParts,
                    tools: toolsMap
                } as unknown as SessionPromptData['body']
            })
            .then((r) => {
                if (r?.response?.status >= 400) {
                    promptError = new Error('OpenCode server returned HTTP ' + r.response.status);
                    logger.warn('Prompt error: HTTP', r.response.status);
                }
            })
            .catch((err) => {
                promptError = err;
                logger.warn('Prompt error:', err.message);
            });

        const eventStreamResult = await client.event.subscribe();
        const eventStream = eventStreamResult.stream;
        const eventIterator = eventStream[Symbol.asyncIterator]();

        const keepaliveInterval = setInterval(() => {
            if (!res.destroyed) res.write(': keepalive\n\n');
        }, 15000);

        const writeChatDelta = (content: string) => {
            res.write(
                `data: ${JSON.stringify({
                    id,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: `${providerId}/${modelId}`,
                    choices: [{ index: 0, delta: { content }, finish_reason: null }]
                })}\n\n`
            );
        };

        const closeReasoningTag = () => {
            if (!state.insideReasoning) return;
            writeChatDelta('\n</think>\n\n');
            state.insideReasoning = false;
        };

        const writeErrorChunk = (msg: string) => {
            if (res.destroyed) return;
            closeReasoningTag();
            res.write(
                `data: ${JSON.stringify({
                    id,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: `${providerId}/${modelId}`,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    error: { message: msg }
                })}\n\n`
            );
            res.write('data: [DONE]\n\n');
            res.end();
        };

        const finalize = (finishReason: string) => {
            if (state.ended) return;
            state.ended = true;
            clearInterval(keepaliveInterval);
            if (res.destroyed) return;
            closeReasoningTag();
            const promptTokens = Math.ceil(fullPromptText.length / 4);
            const usage = {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens + reasoningTokens,
                total_tokens: promptTokens + completionTokens + reasoningTokens,
                completion_tokens_details: { reasoning_tokens: reasoningTokens }
            };
            const finalChunk: Record<string, unknown> = {
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: `${providerId}/${modelId}`,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                usage
            };
            if (ignoredTools) {
                finalChunk.metadata = {
                    tools_support:
                        'tools/function calling is not enabled in this branch yet and was ignored'
                };
            }
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        };

        const failAttempt = (msg: string) => {
            if (state.ended) return;
            state.ended = true;
            clearInterval(keepaliveInterval);
            if (res.destroyed) return;
            if (state.streamedAnything) {
                writeErrorChunk(msg);
            } else {
                attemptErrorMsg = msg;
            }
        };

        await consumeStreamEvents({
            eventIterator,
            sessionId,
            res,
            state,
            getPromptError: () => promptError,
            onFinish: (finish) => finalize(finish === 'stop' ? 'stop' : finish),
            onFail: (msg) => failAttempt(msg),
            onReasoningStart: () => {
                writeChatDelta('<think>\n');
            },
            onReasoningDelta: (delta) => {
                reasoningTokens += Math.ceil(delta.length / 4);
                writeChatDelta(delta);
            },
            onReasoningEnd: () => closeReasoningTag(),
            onTextDelta: (delta) => {
                completionTokens += Math.ceil(delta.length / 4);
                writeChatDelta(delta);
            }
        });

        clearInterval(keepaliveInterval);

        if (!state.ended) {
            failAttempt((promptError as Error | null)?.message || 'Stream ended unexpectedly');
        }

        if (state.ended && state.streamedAnything) break;

        if (attempt < 3) {
            logger.warn(
                `Stream attempt ${attempt}/3 failed before content, retrying:`,
                attemptErrorMsg || 'unknown'
            );
            continue;
        }

        logger.warn('All stream attempts failed:', attemptErrorMsg || 'unknown');
        if (!res.destroyed) writeErrorChunk(attemptErrorMsg || 'All stream attempts failed');
        break;
    }
}

interface AgentChatCompletionOptions {
    client: OpencodeClient;
    providerId: string;
    modelId: string;
    fullPromptText: string;
    systemPrompt: string;
    allParts: PromptPart[];
    toolsMap: { [k: string]: boolean };
    ignoredTools: boolean;
}

async function runAgentChatCompletion({
    client,
    providerId,
    modelId,
    fullPromptText,
    systemPrompt,
    allParts,
    toolsMap,
    ignoredTools
}: AgentChatCompletionOptions): Promise<Record<string, unknown>> {
    const { data: responseData, lastUsedError: chatLastError } = await runAgentPromptWithRetry({
        client,
        providerId,
        modelId,
        prompt: fullPromptText,
        system: systemPrompt,
        parts: allParts,
        label: 'Chat',
        toolsMap
    });

    if (!responseData) throw chatLastError || new Error('All chat attempts failed');

    let content = '';
    let reasoningContent = '';
    const parts = responseData?.parts || [];
    content = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
    reasoningContent = parts
        .filter((p) => p.type === 'reasoning')
        .map((p) => p.text)
        .join('\n');

    if (!content && responseData) {
        const data = responseData;
        if (typeof data === 'string') content = data;
        else content = (data?.message || JSON.stringify(data)) as unknown as string;
    }

    const promptTokens = fullPromptText.length / 4;
    const completionTokens = content.length / 4;
    const reasoningTokens = reasoningContent.length / 4;
    const totalTokens = promptTokens + completionTokens + reasoningTokens;

    const usage = {
        prompt_tokens: Math.ceil(promptTokens),
        completion_tokens: Math.ceil(completionTokens + reasoningTokens),
        total_tokens: Math.ceil(totalTokens),
        completion_tokens_details: { reasoning_tokens: Math.ceil(reasoningTokens) }
    };

    let finalContent = content;
    if (reasoningContent) finalContent = `<think>\n${reasoningContent}\n</think>\n\n${content}`;

    const result: Record<string, unknown> = {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: `${providerId}/${modelId}`,
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: finalContent },
                finish_reason: 'stop'
            }
        ],
        usage
    };
    if (ignoredTools) {
        result.metadata = {
            tools_support:
                'tools/function calling is not enabled in this branch yet and was ignored'
        };
    }
    return result;
}

// ---------------------------------------------------------------------------
// Responses API agent streaming
// ---------------------------------------------------------------------------

interface AgentResponsesStreamOptions {
    res: Response;
    client: OpencodeClient;
    sessionId: string;
    providerId: string;
    modelId: string;
    fullPromptText: string;
    systemPrompt: string;
    allParts: PromptPart[];
    toolsMap: { [k: string]: boolean };
    ignoredTools: boolean;
    responseId: string;
    createdAt: number;
}

async function streamAgentResponses({
    res,
    client,
    sessionId,
    providerId,
    modelId,
    fullPromptText,
    systemPrompt,
    allParts,
    toolsMap,
    ignoredTools,
    responseId,
    createdAt
}: AgentResponsesStreamOptions): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let completionText = '';
    let reasoningText = '';
    let reasoningItem: OutputItemTracker | null = null;
    let messageItem: OutputItemTracker | null = null;
    let nextOutputIndex = 0;

    sendResponseSseEvent(res, {
        type: 'response.created',
        response: {
            id: responseId,
            object: 'response',
            created_at: createdAt,
            status: 'in_progress',
            model: `${providerId}/${modelId}`
        }
    });

    const allocateIndex = () => nextOutputIndex++;

    const ensureReasoningItem = (): OutputItemTracker => {
        if (reasoningItem) return reasoningItem;
        reasoningItem = { itemId: `rs_${crypto.randomUUID()}`, text: '', index: allocateIndex() };
        sendResponseSseEvent(res, {
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
        messageItem = { itemId: `msg_${crypto.randomUUID()}`, text: '', index: allocateIndex() };
        sendResponseSseEvent(res, {
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

    const sendReasoningDelta = (delta: string) => {
        if (!reasoningItem) return;
        sendResponseSseEvent(res, {
            type: 'response.reasoning_text.delta',
            response_id: responseId,
            item_id: reasoningItem.itemId,
            output_index: reasoningItem.index,
            delta
        });
    };

    const sendTextDelta = (delta: string) => {
        if (!messageItem) return;
        sendResponseSseEvent(res, {
            type: 'response.output_text.delta',
            response_id: responseId,
            output_index: messageItem.index,
            content_index: 0,
            delta
        });
    };

    let attemptErrorMsg: string | null = null;

    for (let attempt = 1; attempt <= 3 && !res.destroyed; attempt++) {
        let promptError: Error | null = null;
        attemptErrorMsg = null;
        const state = { ended: false, streamedAnything: false, insideReasoning: false };

        client.session
            .prompt({
                path: { id: sessionId },
                body: {
                    model: { providerID: providerId, modelID: modelId },
                    prompt: fullPromptText,
                    system: systemPrompt,
                    parts: allParts,
                    tools: toolsMap
                } as unknown as SessionPromptData['body']
            })
            .then((r) => {
                if (r?.response?.status >= 400) {
                    promptError = new Error('OpenCode server returned HTTP ' + r.response.status);
                    logger.warn('Prompt error: HTTP', r.response.status);
                }
            })
            .catch((err) => {
                promptError = err;
                logger.warn('Prompt error:', err.message);
            });

        const eventStreamResult = await client.event.subscribe();
        const eventStream = eventStreamResult.stream;
        const eventIterator = eventStream[Symbol.asyncIterator]();

        const keepaliveInterval = setInterval(() => {
            if (!res.destroyed) res.write(': keepalive\n\n');
        }, 15000);

        const writeErrorEvent = (msg: string) => {
            if (res.destroyed) return;
            sendResponseSseEvent(res, {
                type: 'error',
                error: { message: msg || 'stream ended without completion' }
            });
            res.write('data: [DONE]\n\n');
            res.end();
        };

        const finalize = (status: string) => {
            if (state.ended) return;
            state.ended = true;
            clearInterval(keepaliveInterval);
            if (res.destroyed) return;
            const outputStatus = status === 'completed' ? 'completed' : 'incomplete';
            const usage = buildResponsesUsage(fullPromptText, completionText, reasoningText);
            if (reasoningItem) {
                sendResponseSseEvent(res, {
                    type: 'response.output_item.done',
                    response_id: responseId,
                    output_index: reasoningItem.index,
                    item: {
                        id: reasoningItem.itemId,
                        type: 'reasoning',
                        status: outputStatus,
                        summary: [{ type: 'summary_text', text: reasoningItem.text }],
                        content: [{ type: 'reasoning_text', text: reasoningItem.text }]
                    }
                });
            }
            if (messageItem) {
                sendResponseSseEvent(res, {
                    type: 'response.output_item.done',
                    response_id: responseId,
                    output_index: messageItem.index,
                    item: {
                        id: messageItem.itemId,
                        type: 'message',
                        role: 'assistant',
                        status: outputStatus,
                        content: [{ type: 'output_text', text: messageItem.text }]
                    }
                });
            }
            const output: Array<{ index?: number; [k: string]: unknown }> = [];
            if (reasoningItem) {
                output.push({
                    id: reasoningItem.itemId,
                    type: 'reasoning',
                    status: outputStatus,
                    index: reasoningItem.index,
                    summary: [{ type: 'summary_text', text: reasoningItem.text }],
                    content: [{ type: 'reasoning_text', text: reasoningItem.text }]
                });
            }
            if (messageItem) {
                output.push({
                    id: messageItem.itemId,
                    type: 'message',
                    role: 'assistant',
                    status: outputStatus,
                    index: messageItem.index,
                    content: [{ type: 'output_text', text: messageItem.text }]
                });
            }
            output
                .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
                .forEach((entry) => delete entry.index);
            const finalResponseEvent: { type: string; response: Record<string, unknown> } = {
                type: status === 'completed' ? 'response.completed' : 'response.incomplete',
                response: {
                    id: responseId,
                    object: 'response',
                    created_at: createdAt,
                    status,
                    model: `${providerId}/${modelId}`,
                    output,
                    usage,
                    error: null
                }
            };
            if (ignoredTools) {
                finalResponseEvent.response.metadata = {
                    tools_support:
                        'tools/function calling for /v1/responses is not enabled in this branch yet and was ignored'
                };
            }
            sendResponseSseEvent(res, finalResponseEvent);
            storeResponseState(responseId, { sessionId, model: `${providerId}/${modelId}` });
            res.write('data: [DONE]\n\n');
            res.end();
        };

        const failAttempt = (msg: string) => {
            if (state.ended) return;
            state.ended = true;
            clearInterval(keepaliveInterval);
            if (res.destroyed) return;
            if (state.streamedAnything) {
                writeErrorEvent(msg);
            } else {
                attemptErrorMsg = msg;
            }
        };

        await consumeStreamEvents({
            eventIterator,
            sessionId,
            res,
            state,
            getPromptError: () => promptError,
            onFinish: (finish) => finalize(finish === 'stop' ? 'completed' : 'incomplete'),
            onFail: (msg) => failAttempt(msg),
            onReasoningStart: () => {
                ensureReasoningItem();
            },
            onReasoningDelta: (delta) => {
                const ri = ensureReasoningItem();
                ri.text += delta;
                reasoningText += delta;
                sendReasoningDelta(delta);
            },
            onReasoningEnd: () => {},
            onTextDelta: (delta) => {
                const mi = ensureMessageItem();
                mi.text += delta;
                completionText += delta;
                sendTextDelta(delta);
            }
        });

        clearInterval(keepaliveInterval);

        if (!state.ended)
            failAttempt((promptError as Error | null)?.message || 'Stream ended unexpectedly');

        if (state.ended && state.streamedAnything) break;

        if (attempt < 3) {
            logger.warn(
                `Responses stream attempt ${attempt}/3 failed before content, retrying:`,
                attemptErrorMsg || 'unknown'
            );
            continue;
        }

        logger.warn('All responses stream attempts failed:', attemptErrorMsg || 'unknown');
        if (!res.destroyed) writeErrorEvent(attemptErrorMsg || 'All stream attempts failed');
        break;
    }
}

interface AgentResponsesCompletionOptions {
    client: OpencodeClient;
    sessionId: string;
    providerId: string;
    modelId: string;
    fullPromptText: string;
    systemPrompt: string;
    allParts: PromptPart[];
    toolsMap: { [k: string]: boolean };
    ignoredTools: boolean;
    responseId: string;
    createdAt: number;
    outputMessageId: string;
}

async function runAgentResponses({
    client,
    sessionId,
    providerId,
    modelId,
    fullPromptText,
    systemPrompt,
    allParts,
    toolsMap,
    ignoredTools,
    responseId,
    createdAt,
    outputMessageId
}: AgentResponsesCompletionOptions): Promise<Record<string, unknown>> {
    const { data: responseData, lastUsedError: lastError } = await runAgentPromptWithRetry({
        client,
        sessionId,
        providerId,
        modelId,
        prompt: fullPromptText,
        system: systemPrompt,
        parts: allParts,
        label: 'Responses',
        toolsMap
    });

    if (!responseData) throw lastError || new Error('All responses attempts failed');

    const parts = responseData.parts || [];
    const content = parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
    const reasoningContent = parts
        .filter((p) => p.type === 'reasoning')
        .map((p) => p.text)
        .join('\n');
    const usage = buildResponsesUsage(fullPromptText, content, reasoningContent);
    storeResponseState(responseId, { sessionId, model: `${providerId}/${modelId}` });
    const output = [];
    if (reasoningContent) {
        output.push({
            id: `rs_${crypto.randomUUID()}`,
            type: 'reasoning',
            status: 'completed',
            summary: [{ type: 'summary_text', text: reasoningContent }],
            content: [{ type: 'reasoning_text', text: reasoningContent }]
        });
    }
    output.push({
        id: outputMessageId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: content }]
    });
    const result: Record<string, unknown> = {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'completed',
        model: `${providerId}/${modelId}`,
        output,
        output_text: content,
        parallel_tool_calls: false,
        usage,
        error: null
    };
    if (ignoredTools) {
        result.metadata = {
            tools_support:
                'tools/function calling for /v1/responses is not enabled in this branch yet and was ignored'
        };
    }
    return result;
}

export {
    runAgentPromptWithRetry,
    runAgentStreamDriver,
    streamAgentChatCompletion,
    runAgentChatCompletion,
    streamAgentResponses,
    runAgentResponses
};
export type { RunAgentPromptOptions, AgentPromptResultData };
