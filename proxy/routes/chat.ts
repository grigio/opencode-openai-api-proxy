import type { Request, Response } from 'express';
import type { V2Client } from '../v2-client.ts';
import {
    getProviderInfo,
    callChatCompletionsWithImageFallback,
    newChatCompletionId,
    modelKeyOf,
    rememberToolCallReasoning,
    getZenIdentityHeaders,
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
    shouldUseServerAgent,
    isFreeTierError,
    buildAgentToolsSystem,
    gatewayUnavailableError,
    upstreamErrorInfo,
    sanitizeErrorMessage,
    logToolFailureDiagnostics,
    reasoningErrorHint,
    buildFinalMessage,
    findRepeatedToolCallLoop,
    getMaxRepeatedToolLoops,
    SERVER_AGENT_TOOLS,
    AGENT_TOOLS_ENABLED
} from '../utils.ts';
import { logger } from '../logger.ts';

async function handleToolsChatCompletions(
    req: Request,
    res: Response,
    client: V2Client,
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
        const threshold = getMaxRepeatedToolLoops() + 1;
        logger.warn(
            `[tool-loop] detected repeated tool call "${toolLoop.name}" in /v1/chat/completions; aborting (threshold ${threshold}; set OPENCODE_TOOL_LOOP_LIMIT or DISABLE_TOOL_LOOP_CHECK=1 to tune/disable)`
        );
        return res.status(422).json({
            error: {
                message: `Tool call loop detected: the model requested the same tool call ("${toolLoop.name}") ${threshold} times in a row. Aborting to prevent an infinite loop. Set OPENCODE_TOOL_LOOP_LIMIT to raise the threshold or DISABLE_TOOL_LOOP_CHECK=1 to disable.`,
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
    const identityHeaders = await getZenIdentityHeaders();
    const sampling = normalizeSamplingParams(body as Record<string, unknown>);

    if ((req.body as { stream?: boolean })?.stream) {
        return handleZenDirectChatStream(req, res, providerId, modelId, body, supportsImages);
    }

    const { data } = await callChatCompletionsWithImageFallback({
        baseUrl: zenBaseUrl(),
        apiKey: null,
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
    const identityHeaders = await getZenIdentityHeaders();

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
                apiKey: null,
                modelId,
                messages: activeMessages,
                tools,
                toolChoice: toolChoice as string | Record<string, unknown> | null | undefined,
                parallelToolCalls,
                stream: true,
                signal: clientAbortSignal(req),
                identityHeaders,
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
                    if (isFreeTierError(zenError)) {
                        logger.warn(
                            `[zen-direct] ${providerId}/${modelId} rejected with FreeTierError (403), falling back to server-agent (anonymous like opencode):`,
                            zenError.message
                        );
                        // Fall through to server-agent for 403 – the gateway
                        // considers this not "within OpenCode", but the local
                        // server is, so delegate there like the official CLI.
                    } else {
                        const info = upstreamErrorInfo(zenError);
                        return res
                            .status(
                                info.statusCode && info.statusCode >= 400 && info.statusCode < 600
                                    ? info.statusCode
                                    : 502
                            )
                            .json({
                                error: {
                                    message: `Tool calling failed for "${providerId}/${modelId}": anonymous free-tier zen call failed. ${info.message}`,
                                    ...(info.type ? { type: info.type } : {}),
                                    details:
                                        'Zen rate limits are transient - retry the request, or set OPENCODE_API_KEY / OPENCODE_TOOL_CALLING=agent to route via the server.'
                                }
                            });
                    }
                }
            }
            if (shouldUseAgentTools() || shouldUseServerAgent(providerInfo, providerId)) {
                const via = shouldUseAgentTools()
                    ? 'OPENCODE_TOOL_CALLING=agent -> SERVER AGENT (built-in container tools)'
                    : 'anonymous auto -> SERVER AGENT (like opencode, within OpenCode)';
                logger.info(`[tool-calling] ${providerId}/${modelId} ${via}`);
                try {
                    const agentBuild = await buildPromptPartsAndSystem(messages as ChatMessage[]);
                    const agentSystem = buildAgentToolsSystem(
                        agentBuild.systemPrompt,
                        tools as import('../types.ts').ToolDefinition[] | undefined
                    );
                    try {
                        await client.switchModel('', providerId, modelId);
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
                // Anonymous free-tier 403 must not be surfaced as 502 – retry
                // via the server-agent which is "within OpenCode" and succeeds
                // like the official CLI, instead of exposing the upstream 403.
                if (
                    isFreeTierError(toolError) &&
                    providerId === 'opencode' &&
                    toolError.message?.includes('403')
                ) {
                    logger.warn(
                        `[tool-calling] ${providerId}/${modelId} direct gateway FreeTierError 403, retrying via server-agent (anonymous like opencode):`,
                        toolError.message
                    );
                    // Retry once via server-agent
                    try {
                        const agentBuild = await buildPromptPartsAndSystem(
                            messages as ChatMessage[]
                        );
                        const agentSystem = buildAgentToolsSystem(
                            agentBuild.systemPrompt,
                            tools as import('../types.ts').ToolDefinition[] | undefined
                        );
                        try {
                            await client.switchModel('', providerId, modelId);
                        } catch {}
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
                    } catch (retryErr) {
                        logger.error(
                            'Server-agent retry after FreeTierError also failed:',
                            (retryErr as Error).message
                        );
                    }
                }
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
                    toolError.response?.data?.error?.message || toolError.message || 'Unknown error'
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
            await client.switchModel('', providerId, modelId);
        } catch (caughtConf) {
            logger.warn(
                'Failed to set active model:',
                (caughtConf as { message?: string }).message
            );
        }

        const textProviderInfo = await getProviderInfo(client, providerId, modelId);
        // For streaming, always use server-agent (event stream) — zen-direct
        // streams can't fall back to server-agent once the response starts.
        if (!stream && shouldUseZenDirect(textProviderInfo, providerId)) {
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
