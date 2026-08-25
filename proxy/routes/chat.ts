import type { Request, Response } from 'express';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { Config } from '@opencode-ai/sdk';
import {
    getProviderInfo,
    callChatCompletionsWithImageFallback,
    newChatCompletionId,
    modelKeyOf,
    rememberToolCallReasoning,
    zenIdentityHeaders,
    ensureZenSystemPrompt,
    normalizeSamplingParams,
    zenBaseUrl
} from '../model-gateway.ts';
import { getClient, clientAbortSignal } from '../client.ts';
import { parseModel, buildPromptPartsAndSystem } from '../prompts.ts';
import type {
    ChatMessage,
    ChatCompletionChoice,
    ProviderGatewayInfo,
    ChatCompletionBody
} from '../types.ts';
import { streamChatCompletionsWithResumption } from '../streaming/engine.ts';
import { streamAgentChatCompletion, runAgentChatCompletion } from '../streaming/agent.ts';
import {
    hasRequestedTools,
    shouldUseZenDirect,
    shouldUseAgentTools,
    buildAgentToolsSystem,
    gatewayUnavailableError,
    upstreamErrorInfo,
    sanitizeErrorMessage,
    logToolFailureDiagnostics,
    reasoningErrorHint,
    buildFinalMessage,
    findRepeatedToolCallLoop,
    SERVER_AGENT_TOOLS,
    AGENT_TOOLS_ENABLED,
    MAX_REPEATED_TOOL_LOOPS
} from '../utils.ts';
import { logger } from '../logger.ts';

async function handleToolsChatCompletions(
    req: Request,
    res: Response,
    client: OpencodeClient,
    providerId: string,
    modelId: string,
    body: ChatCompletionBody
): Promise<Response | void> {
    const {
        messages,
        tools,
        tool_choice: toolChoice,
        parallel_tool_calls: parallelToolCalls
    } = body as {
        messages: ChatMessage[];
        tools?: import('../types.ts').ToolDefinition[];
        tool_choice?: unknown;
        parallel_tool_calls?: boolean;
    };
    const sampling = normalizeSamplingParams(body as Record<string, unknown>);

    const toolLoop = findRepeatedToolCallLoop(messages);
    if (toolLoop) {
        logger.warn(
            `[tool-loop] detected repeated tool call "${toolLoop.name}" in /v1/chat/completions; aborting (threshold ${MAX_REPEATED_TOOL_LOOPS + 1}; set OPENCODE_TOOL_LOOP_LIMIT or DISABLE_TOOL_LOOP_CHECK=1 to tune/disable)`
        );
        return res.status(422).json({
            error: {
                message: `Tool call loop detected: the model requested the same tool call ("${toolLoop.name}") ${MAX_REPEATED_TOOL_LOOPS + 1} times in a row. Aborting to prevent an infinite loop. Set OPENCODE_TOOL_LOOP_LIMIT to raise the threshold or DISABLE_TOOL_LOOP_CHECK=1 to disable.`,
                type: 'invalid_request_error'
            }
        });
    }

    const providerInfo = await getProviderInfo(client, providerId, modelId);
    if (!providerInfo) return res.status(400).json(gatewayUnavailableError(providerId, modelId));

    if (body.stream) {
        return handleToolsChatCompletionsStream(req, res, providerInfo, providerId, modelId, body);
    }

    const { data } = await callChatCompletionsWithImageFallback({
        ...providerInfo,
        messages: messages as ChatMessage[],
        tools,
        toolChoice: toolChoice as string | Record<string, unknown> | null | undefined,
        parallelToolCalls,
        stream: false,
        signal: clientAbortSignal(req),
        ...sampling
    });

    const choice: ChatCompletionChoice = data!.choices?.[0] || {};
    const modelMessage: ChatMessage = choice.message || ({} as ChatMessage);

    if (Array.isArray(modelMessage.tool_calls) && modelMessage.tool_calls.length > 0) {
        const modelKey = modelKeyOf(providerInfo);
        for (const tc of modelMessage.tool_calls) {
            rememberToolCallReasoning(tc?.id as string, modelMessage.reasoning_content as string, {
                modelKey,
                functionName: tc?.function?.name,
                functionArguments: tc?.function?.arguments
            });
        }
    }

    const result = {
        id: newChatCompletionId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: `${providerId}/${modelId}`,
        choices: [
            {
                index: 0,
                message: buildFinalMessage(choice.message || ({} as ChatMessage)),
                finish_reason: choice.finish_reason || 'stop'
            }
        ],
        usage: data!.usage || {}
    };
    return res.json(result);
}

async function handleZenDirectChat(
    req: Request,
    res: Response,
    providerId: string,
    modelId: string,
    body: ChatCompletionBody,
    supportsImages?: boolean
): Promise<Response | void> {
    const {
        tools,
        tool_choice: toolChoice,
        parallel_tool_calls: parallelToolCalls
    } = (body || {}) as {
        tools?: import('../types.ts').ToolDefinition[];
        tool_choice?: unknown;
        parallel_tool_calls?: boolean;
    };
    const messages: ChatMessage[] = ensureZenSystemPrompt(
        (body as { messages?: ChatMessage[] })?.messages || []
    );
    const identityHeaders = zenIdentityHeaders();
    const sampling = normalizeSamplingParams(body as Record<string, unknown>);

    if ((req.body as { stream?: boolean })?.stream) {
        return handleZenDirectChatStream(req, res, providerId, modelId, body, supportsImages);
    }

    const { data } = await callChatCompletionsWithImageFallback({
        baseUrl: zenBaseUrl(),
        apiKey: 'public',
        modelId,
        messages,
        tools,
        toolChoice: toolChoice as string | Record<string, unknown> | null | undefined,
        parallelToolCalls,
        stream: false,
        signal: clientAbortSignal(req),
        identityHeaders,
        supportsImages,
        ...sampling
    });

    const choice: ChatCompletionChoice = data!.choices?.[0] || {};
    const modelMessage: ChatMessage = choice.message || ({} as ChatMessage);
    const result = {
        id: newChatCompletionId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: `${providerId}/${modelId}`,
        choices: [
            {
                index: 0,
                message: buildFinalMessage(modelMessage),
                finish_reason: choice.finish_reason || 'stop'
            }
        ],
        usage: data!.usage || {}
    };
    return res.json(result);
}

async function handleZenDirectChatStream(
    req: Request,
    res: Response,
    providerId: string,
    modelId: string,
    body: ChatCompletionBody,
    supportsImages?: boolean
): Promise<void> {
    const {
        tools,
        tool_choice: toolChoice,
        parallel_tool_calls: parallelToolCalls
    } = (body || {}) as {
        tools?: import('../types.ts').ToolDefinition[];
        tool_choice?: unknown;
        parallel_tool_calls?: boolean;
    };
    const messages: ChatMessage[] = ensureZenSystemPrompt(
        (body as { messages?: ChatMessage[] })?.messages || []
    );
    const sampling = normalizeSamplingParams(body as Record<string, unknown>);

    return streamChatCompletionsWithResumption({
        req,
        res,
        providerId,
        modelId,
        initialMessages: messages,
        label: 'zen-direct',
        makeUpstream: (activeMessages) =>
            callChatCompletionsWithImageFallback({
                baseUrl: zenBaseUrl(),
                apiKey: 'public',
                modelId,
                messages: activeMessages,
                tools,
                toolChoice: toolChoice as string | Record<string, unknown> | null | undefined,
                parallelToolCalls,
                stream: true,
                signal: clientAbortSignal(req),
                identityHeaders: zenIdentityHeaders(),
                supportsImages,
                ...sampling
            }) as Promise<{
                stream: ReadableStream<Uint8Array>;
                signal: AbortSignal;
                idleTick?: () => void;
                clearIdle?: () => void;
            }>
    });
}

async function handleToolsChatCompletionsStream(
    req: Request,
    res: Response,
    providerInfo: ProviderGatewayInfo,
    providerId: string,
    modelId: string,
    body: ChatCompletionBody
): Promise<void> {
    const {
        messages,
        tools,
        tool_choice: toolChoice,
        parallel_tool_calls: parallelToolCalls
    } = body as {
        messages: ChatMessage[];
        tools?: import('../types.ts').ToolDefinition[];
        tool_choice?: unknown;
        parallel_tool_calls?: boolean;
    };
    const sampling = normalizeSamplingParams(body as Record<string, unknown>);

    return streamChatCompletionsWithResumption({
        req,
        res,
        providerId,
        modelId,
        initialMessages: messages as ChatMessage[],
        providerInfo,
        label: 'tool-calling',
        makeUpstream: (activeMessages) =>
            callChatCompletionsWithImageFallback({
                ...providerInfo,
                messages: activeMessages,
                tools,
                toolChoice: toolChoice as string | Record<string, unknown> | null | undefined,
                parallelToolCalls,
                stream: true,
                signal: clientAbortSignal(req),
                ...sampling
            }) as Promise<{
                stream: ReadableStream<Uint8Array>;
                signal: AbortSignal;
                idleTick?: () => void;
                clearIdle?: () => void;
            }>
    });
}

async function chatCompletionsHandler(req: Request, res: Response): Promise<Response | void> {
    try {
        const {
            messages,
            model,
            stream,
            tools,
            tool_choice: toolChoice
        } = (req.body || {}) as ChatCompletionBody & {
            messages?: unknown;
            model?: unknown;
            stream?: boolean;
        };

        let ignoredTools = false;
        if (toolChoice && toolChoice !== 'none' && toolChoice !== 'auto') ignoredTools = true;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: { message: 'messages array is required' } });
        }

        const parsed = parseModel(model);
        if (!parsed) {
            return res.status(400).json({
                error: {
                    message: 'model must be a non-empty "providerId/modelId" string',
                    type: 'invalid_request_error'
                }
            });
        }
        const { providerId, modelId } = parsed;
        const client = getClient();

        logger.info(`Using model: ${providerId}/${modelId}${stream ? ' (streaming)' : ''}`);

        const hasToolMessages =
            Array.isArray(messages) && (messages as ChatMessage[]).some((m) => m.role === 'tool');
        const toolNames = (
            Array.isArray(tools)
                ? (
                      tools as Array<{ function?: { name?: string }; name?: string; type?: string }>
                  ).map((t) => t.function?.name || t.name || t.type)
                : []
        ).join(', ');
        logger.info(
            `[tool-calling] chat/completions tools=[${toolNames}] tool_choice=${JSON.stringify(toolChoice ?? null)} -> path=${hasRequestedTools(tools as import('../types.ts').ToolDefinition[] | undefined, toolChoice) ? 'DIRECT MODEL' : 'SERVER AGENT'}`
        );
        if (
            hasRequestedTools(
                tools as import('../types.ts').ToolDefinition[] | undefined,
                toolChoice
            ) ||
            hasToolMessages
        ) {
            const providerInfo = await getProviderInfo(client, providerId, modelId);
            if (!providerInfo)
                return res.status(400).json(gatewayUnavailableError(providerId, modelId));

            if (shouldUseZenDirect(providerInfo, providerId)) {
                logger.info(
                    `[zen-direct] ${providerId}/${modelId} chat anonymous free tier -> direct zen ${zenBaseUrl()} (rotated CLI identity)`
                );
                try {
                    return await handleZenDirectChat(
                        req,
                        res,
                        providerId,
                        modelId,
                        req.body as ChatCompletionBody,
                        providerInfo.supportsImages
                    );
                } catch (caught) {
                    const zenError = caught as import('../types.ts').UpstreamErrorLike;
                    logger.error(
                        '[zen-direct] tool call failed, not falling back to in-container tools:',
                        zenError.message
                    );
                    const errorMessage = upstreamErrorInfo(zenError);
                    return res
                        .status(
                            errorMessage.statusCode &&
                                errorMessage.statusCode >= 400 &&
                                errorMessage.statusCode < 600
                                ? errorMessage.statusCode
                                : 502
                        )
                        .json({
                            error: {
                                message: `Tool calling failed for "${providerId}/${modelId}": anonymous free-tier zen call failed. ${errorMessage.message}`,
                                ...(errorMessage.type ? { type: errorMessage.type } : {}),
                                details:
                                    'Zen rate limits are transient - retry the request, or set OPENCODE_API_KEY / OPENCODE_TOOL_CALLING=agent to route via the server.'
                            }
                        });
                }
            }
            if (shouldUseAgentTools()) {
                logger.info(
                    `[tool-calling] ${providerId}/${modelId} OPENCODE_TOOL_CALLING=agent -> SERVER AGENT (built-in container tools)`
                );
                try {
                    const agentBuild = await buildPromptPartsAndSystem(messages as ChatMessage[]);
                    const agentSystem = buildAgentToolsSystem(
                        agentBuild.systemPrompt,
                        tools as import('../types.ts').ToolDefinition[] | undefined
                    );
                    try {
                        await client.config.update({
                            body: {
                                activeModel: { providerID: providerId, modelID: modelId }
                            } as unknown as Config
                        });
                    } catch (caughtConf) {
                        logger.warn(
                            'Failed to set active model:',
                            (caughtConf as { message?: string }).message
                        );
                    }
                    if (stream) {
                        await streamAgentChatCompletion({
                            res,
                            client,
                            providerId,
                            modelId,
                            fullPromptText: agentBuild.fullPromptText,
                            systemPrompt: agentSystem,
                            allParts: agentBuild.allParts,
                            toolsMap: AGENT_TOOLS_ENABLED,
                            ignoredTools
                        });
                        return;
                    }
                    return res.json(
                        await runAgentChatCompletion({
                            client,
                            providerId,
                            modelId,
                            fullPromptText: agentBuild.fullPromptText,
                            systemPrompt: agentSystem,
                            allParts: agentBuild.allParts,
                            toolsMap: AGENT_TOOLS_ENABLED,
                            ignoredTools
                        })
                    );
                } catch (caught) {
                    const toolError = caught as import('../types.ts').UpstreamErrorLike;
                    logger.error(
                        'Tool calling proxy error (agent path):',
                        toolError.message,
                        '| cause:',
                        (toolError.cause as { message?: string } | undefined)?.message ??
                            toolError.cause,
                        '| stack:',
                        toolError.stack?.split('\n').slice(0, 4).join(' | ')
                    );
                    logToolFailureDiagnostics(providerId, modelId, messages, toolError);
                    const toolErrorMessage = sanitizeErrorMessage(
                        toolError.response?.data?.error?.message ||
                            toolError.message ||
                            'Unknown error'
                    );
                    return res.status(502).json({
                        error: {
                            message: `Tool calling failed for "${providerId}/${modelId}"`,
                            details: toolErrorMessage
                        }
                    });
                }
            }

            try {
                return await handleToolsChatCompletions(
                    req,
                    res,
                    client,
                    providerId,
                    modelId,
                    req.body as ChatCompletionBody
                );
            } catch (caught) {
                const toolError = caught as import('../types.ts').UpstreamErrorLike;
                logger.error(
                    'Tool calling proxy error:',
                    toolError.message,
                    '| cause:',
                    (toolError.cause as { message?: string } | undefined)?.message ??
                        toolError.cause,
                    '| stack:',
                    toolError.stack?.split('\n').slice(0, 4).join(' | ')
                );
                logToolFailureDiagnostics(
                    providerId,
                    modelId,
                    (req.body as { messages?: unknown })?.messages,
                    toolError
                );
                const toolErrorMessage = sanitizeErrorMessage(
                    toolError.response?.data?.error?.message ||
                        toolError.message ||
                        'Unknown error'
                );
                return res.status(502).json({
                    error: {
                        message: `Tool calling failed for "${providerId}/${modelId}"`,
                        details: toolErrorMessage + reasoningErrorHint(toolError)
                    }
                });
            }
        }

        const { allParts, fullPromptText, systemPrompt } = await buildPromptPartsAndSystem(
            messages as ChatMessage[]
        );

        try {
            await client.config.update({
                body: {
                    activeModel: { providerID: providerId, modelID: modelId }
                } as unknown as Config
            });
        } catch (caughtConf) {
            logger.warn(
                'Failed to set active model:',
                (caughtConf as { message?: string }).message
            );
        }

        const textProviderInfo = await getProviderInfo(client, providerId, modelId);
        if (shouldUseZenDirect(textProviderInfo, providerId)) {
            logger.info(
                `[zen-direct] ${providerId}/${modelId} chat anonymous free tier -> direct zen ${zenBaseUrl()} (rotated CLI identity)`
            );
            try {
                return await handleZenDirectChat(
                    req,
                    res,
                    providerId,
                    modelId,
                    req.body as ChatCompletionBody,
                    textProviderInfo?.supportsImages
                );
            } catch (caught) {
                logger.error(
                    '[zen-direct] chat call failed, falling back to server-agent text path:',
                    (caught as { message?: string }).message
                );
            }
        }

        if (stream) {
            await streamAgentChatCompletion({
                res,
                client,
                providerId,
                modelId,
                fullPromptText,
                systemPrompt,
                allParts,
                toolsMap: SERVER_AGENT_TOOLS,
                ignoredTools
            });
            return;
        }

        return res.json(
            await runAgentChatCompletion({
                client,
                providerId,
                modelId,
                fullPromptText,
                systemPrompt,
                allParts,
                toolsMap: SERVER_AGENT_TOOLS,
                ignoredTools
            })
        );
    } catch (caught) {
        const error = caught as import('../types.ts').UpstreamErrorLike;
        logger.error('Proxy Processing Error:', error);
        const errorMessage = sanitizeErrorMessage(
            error.response?.data?.error?.message || error.message || 'Unknown error'
        );
        res.status(500).json({ error: { message: 'Internal Proxy Error', details: errorMessage } });
    }
}

export {
    chatCompletionsHandler,
    handleToolsChatCompletions,
    handleZenDirectChat,
    handleZenDirectChatStream,
    handleToolsChatCompletionsStream
};
