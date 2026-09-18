import crypto from 'crypto';
import type { Request, Response } from 'express';
import type { V2Client } from '../v2-client.ts';
import {
    getProviderInfo,
    callChatCompletionsWithImageFallback,
    modelKeyOf,
    rememberToolCallReasoning,
    zenIdentityHeaders,
    ensureZenSystemPrompt,
    normalizeSamplingParams,
    zenBaseUrl
} from '../model-gateway.ts';
import { getClient, clientAbortSignal } from '../client.ts';
import {
    parseModel,
    buildPromptPartsAndSystem,
    responsesInputToMessages,
    normalizeResponsesInputToMessages
} from '../prompts.ts';
import type { ChatMessage, ChatCompletionChoice, ResponsesBody } from '../types.ts';
import { streamResponsesWithResumption } from '../streaming/engine.ts';
import { streamAgentResponses, runAgentResponses } from '../streaming/agent.ts';
import { getResponseState, storeResponseState } from '../state.ts';
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
    normalizeResponsesUsage,
    deriveToolsFromMessages,
    findRepeatedToolCallLoop,
    buildResponsesToolMessages,
    MAX_REPEATED_TOOL_LOOPS,
    SERVER_AGENT_TOOLS,
    AGENT_TOOLS_ENABLED
} from '../utils.ts';
import { logger } from '../logger.ts';

function agentResponsesMessages(input: unknown, instructions: unknown): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (typeof instructions === 'string' && instructions) {
        messages.push({ role: 'system', content: instructions });
    }
    messages.push(...responsesInputToMessages(input));
    return messages;
}

async function handleToolsResponses(
    req: Request,
    res: Response,
    client: V2Client,
    providerId: string,
    modelId: string,
    body: ResponsesBody,
    zenDirectBaseUrl?: string
): Promise<Response | void> {
    const {
        input,
        tools,
        tool_choice: toolChoice,
        parallel_tool_calls: parallelToolCalls,
        previous_response_id: previousResponseId
    } = body as {
        input: unknown;
        tools?: import('../types.ts').ToolDefinition[];
        tool_choice?: unknown;
        parallel_tool_calls?: boolean;
        previous_response_id?: string;
    };
    const sampling = normalizeSamplingParams(body as Record<string, unknown>);

    const previousState = previousResponseId ? getResponseState(previousResponseId) : null;
    const resolvedTools =
        Array.isArray(tools) && tools.length > 0 ? tools : previousState?.tools || undefined;

    const messages = zenDirectBaseUrl
        ? ensureZenSystemPrompt(
              buildResponsesToolMessages(
                  input,
                  previousResponseId,
                  getResponseState,
                  responsesInputToMessages
              )
          )
        : buildResponsesToolMessages(
              input,
              previousResponseId,
              getResponseState,
              responsesInputToMessages
          );

    const effectiveTools = resolvedTools || deriveToolsFromMessages(messages);
    if (messages.length === 0) {
        return res
            .status(400)
            .json({ error: { message: 'input is required', type: 'invalid_request_error' } });
    }

    const toolLoop = findRepeatedToolCallLoop(messages);
    if (toolLoop) {
        logger.warn(
            `[tool-loop] detected repeated tool call "${toolLoop.name}" in /v1/responses continuation; aborting (threshold ${MAX_REPEATED_TOOL_LOOPS + 1}; set OPENCODE_TOOL_LOOP_LIMIT or DISABLE_TOOL_LOOP_CHECK=1 to tune/disable)`
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
        return handleToolsResponsesStream(
            req,
            res,
            providerInfo,
            providerId,
            modelId,
            messages,
            effectiveTools,
            toolChoice,
            parallelToolCalls,
            sampling,
            zenDirectBaseUrl
        );
    }

    const { data, messagesUsed } = await callChatCompletionsWithImageFallback({
        ...providerInfo,
        messages,
        tools: effectiveTools,
        toolChoice: toolChoice as string | Record<string, unknown> | null | undefined,
        parallelToolCalls,
        stream: false,
        signal: clientAbortSignal(req),
        ...sampling,
        ...(zenDirectBaseUrl
            ? { baseUrl: zenDirectBaseUrl, apiKey: 'public', identityHeaders: zenIdentityHeaders() }
            : {})
    });

    const choice: ChatCompletionChoice = data!.choices?.[0] || {};
    const modelMessage: ChatMessage = choice.message || ({} as ChatMessage);
    const toolCalls = Array.isArray(modelMessage.tool_calls) ? modelMessage.tool_calls : [];

    if (toolCalls.length > 0) {
        const modelKey = modelKeyOf(providerInfo);
        for (const tc of toolCalls) {
            rememberToolCallReasoning(tc?.id as string, modelMessage.reasoning_content as string, {
                modelKey,
                functionName: tc?.function?.name,
                functionArguments: tc?.function?.arguments
            });
        }
    }

    const responseId = `resp_${crypto.randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const output = [];
    if (modelMessage.reasoning_content) {
        output.push({
            id: `rs_${crypto.randomUUID()}`,
            type: 'reasoning',
            status: 'completed',
            summary: [{ type: 'summary_text', text: modelMessage.reasoning_content }],
            content: [{ type: 'reasoning_text', text: modelMessage.reasoning_content }]
        });
    }
    if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
            output.push({
                id: `fc_${crypto.randomUUID()}`,
                type: 'function_call',
                status: 'completed',
                call_id: tc.id,
                name: tc.function?.name,
                arguments: tc.function?.arguments
            });
        }
    } else {
        output.push({
            id: `msg_${crypto.randomUUID()}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: modelMessage.content || '' }]
        });
    }

    storeResponseState(responseId, {
        messages: messagesUsed,
        assistantToolMessage:
            toolCalls.length > 0
                ? {
                      role: 'assistant',
                      content: modelMessage.content || '',
                      tool_calls: toolCalls,
                      ...(typeof modelMessage.reasoning_content === 'string' &&
                      modelMessage.reasoning_content
                          ? { reasoning_content: modelMessage.reasoning_content }
                          : {})
                  }
                : null,
        tools: effectiveTools,
        model: `${providerId}/${modelId}`
    });

    const result: Record<string, unknown> = {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'completed',
        model: `${providerId}/${modelId}`,
        output,
        parallel_tool_calls: toolCalls.length > 1,
        usage: normalizeResponsesUsage(data!.usage),
        error: null
    };
    if (toolCalls.length > 0) result.finish_reason = 'tool_calls';
    return res.json(result);
}

async function handleToolsResponsesStream(
    req: Request,
    res: Response,
    providerInfo: import('../types.ts').ProviderGatewayInfo,
    providerId: string,
    modelId: string,
    messages: ChatMessage[],
    tools: import('../types.ts').ToolDefinition[] | undefined,
    toolChoice: unknown,
    parallelToolCalls: boolean | undefined,
    sampling: Pick<
        import('../types.ts').ChatCompletionOptions,
        'reasoningEffort' | 'temperature' | 'topP' | 'maxTokens'
    > = {},
    zenDirectBaseUrl?: string
): Promise<void> {
    return streamResponsesWithResumption({
        req,
        res,
        providerInfo,
        providerId,
        modelId,
        messages,
        tools,
        toolChoice,
        parallelToolCalls,
        sampling,
        zenDirectBaseUrl
    });
}

async function responsesHandler(req: Request, res: Response): Promise<Response | void> {
    try {
        const {
            input,
            instructions,
            model,
            stream,
            previous_response_id: previousResponseId,
            tools,
            tool_choice: toolChoice
        } = (req.body || {}) as ResponsesBody;

        const hasTools = hasRequestedTools(
            tools as import('../types.ts').ToolDefinition[] | undefined,
            toolChoice
        );
        const hasToolOutputs =
            Array.isArray(input) &&
            (input as unknown[]).some(
                (item) => (item as { type?: string })?.type === 'function_call_output'
            );

        let ignoredTools = false;
        if (toolChoice && toolChoice !== 'none' && toolChoice !== 'auto') ignoredTools = true;

        if (hasToolOutputs && !hasTools && !previousResponseId) {
            const hasAssistantToolCalls =
                Array.isArray(input) &&
                (input as unknown[]).some(
                    (item) => (item as { type?: string })?.type === 'function_call'
                );
            if (!hasAssistantToolCalls) {
                return res.status(400).json({
                    error: {
                        message:
                            'function_call_output requires tools, a previous_response_id, or the corresponding function_call items to be provided in the request',
                        type: 'invalid_request_error'
                    }
                });
            }
        }

        let previousState: ReturnType<typeof getResponseState> = null;
        if (previousResponseId) {
            previousState = getResponseState(previousResponseId);
            if (!previousState) {
                return res.status(400).json({
                    error: {
                        message: 'Invalid or expired previous_response_id',
                        type: 'invalid_request_error'
                    }
                });
            }
        }

        const selectedModel = (model as string) || previousState?.model || 'opencode/big-pickle';
        const parsed = parseModel(selectedModel);
        if (!parsed)
            return res.status(400).json({
                error: {
                    message: 'model must be a non-empty "providerId/modelId" string',
                    type: 'invalid_request_error'
                }
            });
        const { providerId, modelId } = parsed;
        const client = getClient();

        const toolNames = (
            Array.isArray(tools)
                ? (
                      tools as Array<{ function?: { name?: string }; name?: string; type?: string }>
                  ).map((t) => t.function?.name || t.name || t.type)
                : []
        ).join(', ');
        logger.info(
            `[tool-calling] responses tools=[${toolNames}] tool_choice=${JSON.stringify(toolChoice ?? null)} -> path=${hasTools ? 'DIRECT MODEL' : 'SERVER AGENT'}`
        );
        if (hasTools || hasToolOutputs) {
            const providerInfo = await getProviderInfo(client, providerId, modelId);
            if (!providerInfo)
                return res.status(400).json(gatewayUnavailableError(providerId, modelId));

            if (shouldUseZenDirect(providerInfo, providerId)) {
                logger.info(
                    `[zen-direct] ${providerId}/${modelId} responses anonymous free tier -> direct zen ${zenBaseUrl()} (rotated CLI identity)`
                );
                try {
                    return await handleToolsResponses(
                        req,
                        res,
                        client,
                        providerId,
                        modelId,
                        req.body as ResponsesBody,
                        zenBaseUrl()
                    );
                } catch (caught) {
                    const zenError = caught as import('../types.ts').UpstreamErrorLike;
                    logger.error(
                        '[zen-direct] responses tool call failed, not falling back to in-container tools:',
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
                    const messages = agentResponsesMessages(input, instructions);
                    if (messages.length === 0)
                        return res.status(400).json({
                            error: {
                                message: 'input is required',
                                type: 'invalid_request_error'
                            }
                        });
                    const toolLoop = findRepeatedToolCallLoop(messages);
                    if (toolLoop) {
                        logger.warn(
                            `[tool-loop] detected repeated tool call "${toolLoop.name}" in /v1/responses continuation (agent path); aborting (threshold ${MAX_REPEATED_TOOL_LOOPS + 1}; set OPENCODE_TOOL_LOOP_LIMIT or DISABLE_TOOL_LOOP_CHECK=1 to tune/disable)`
                        );
                        return res.status(422).json({
                            error: {
                                message: `Tool call loop detected: the model requested the same tool call ("${toolLoop.name}") ${MAX_REPEATED_TOOL_LOOPS + 1} times in a row. Aborting to prevent an infinite loop. Set OPENCODE_TOOL_LOOP_LIMIT to raise the threshold or DISABLE_TOOL_LOOP_CHECK=1 to disable.`,
                                type: 'invalid_request_error'
                            }
                        });
                    }
                    const { allParts, fullPromptText, systemPrompt } =
                        await buildPromptPartsAndSystem(messages);
                    const agentTools =
                        Array.isArray(tools) && tools.length > 0
                            ? (tools as import('../types.ts').ToolDefinition[])
                            : deriveToolsFromMessages(messages);
                    const systemWithTools = buildAgentToolsSystem(systemPrompt, agentTools);
                    try {
                        await client.switchModel('', providerId, modelId);
                    } catch (caughtConf) {
                        logger.warn(
                            'Failed to set active model:',
                            (caughtConf as { message?: string }).message
                        );
                    }
                    let agentSessionId = previousState?.sessionId;
                    if (!agentSessionId) {
                        const sessionRes = await client.createSession();
                        agentSessionId = sessionRes.data?.id;
                        if (!agentSessionId) throw new Error('Failed to create session');
                    }
                    const createdAt = Math.floor(Date.now() / 1000);
                    const responseId = `resp_${crypto.randomUUID()}`;
                    const outputMessageId = `msg_${crypto.randomUUID()}`;
                    if (stream) {
                        await streamAgentResponses({
                            res,
                            client,
                            sessionId: agentSessionId,
                            providerId,
                            modelId,
                            fullPromptText,
                            systemPrompt: systemWithTools,
                            allParts,
                            toolsMap: AGENT_TOOLS_ENABLED,
                            ignoredTools,
                            responseId,
                            createdAt
                        });
                        return;
                    }
                    return res.json(
                        await runAgentResponses({
                            client,
                            sessionId: agentSessionId,
                            providerId,
                            modelId,
                            fullPromptText,
                            systemPrompt: systemWithTools,
                            allParts,
                            toolsMap: AGENT_TOOLS_ENABLED,
                            ignoredTools,
                            responseId,
                            createdAt,
                            outputMessageId
                        })
                    );
                } catch (caught) {
                    const toolError = caught as import('../types.ts').UpstreamErrorLike;
                    logger.error(
                        'Responses tool calling proxy error (agent path):',
                        toolError.message
                    );
                    logToolFailureDiagnostics(providerId, modelId, input, toolError);
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
                return await handleToolsResponses(
                    req,
                    res,
                    client,
                    providerId,
                    modelId,
                    req.body as ResponsesBody
                );
            } catch (caught) {
                const toolError = caught as import('../types.ts').UpstreamErrorLike;
                logger.error('Responses tool calling proxy error:', toolError.message);
                logToolFailureDiagnostics(
                    providerId,
                    modelId,
                    (req.body as ResponsesBody)?.input,
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

        try {
            await client.switchModel('', providerId, modelId);
        } catch (caughtConf) {
            logger.warn(
                'Failed to set active model:',
                (caughtConf as { message?: string }).message
            );
        }

        const textProviderInfo = await getProviderInfo(client, providerId, modelId);
        if (shouldUseZenDirect(textProviderInfo, providerId)) {
            logger.info(
                `[zen-direct] ${providerId}/${modelId} responses anonymous free tier -> direct zen ${zenBaseUrl()} (rotated CLI identity)`
            );
            try {
                return await handleToolsResponses(
                    req,
                    res,
                    client,
                    providerId,
                    modelId,
                    req.body as ResponsesBody,
                    zenBaseUrl()
                );
            } catch (caught) {
                logger.error(
                    '[zen-direct] responses call failed, falling back to server-agent text path:',
                    (caught as { message?: string }).message
                );
            }
        }

        let sessionId = previousState?.sessionId;
        if (!sessionId) {
            const sessionRes = await client.createSession();
            sessionId = sessionRes.data?.id;
            if (!sessionId) throw new Error('Failed to create session');
        }

        const messages = normalizeResponsesInputToMessages({ input, instructions });
        if (messages.length === 0) {
            return res.status(400).json({
                error: {
                    message:
                        'input is required when no usable previous_response_id context is provided',
                    type: 'invalid_request_error'
                }
            });
        }

        const { allParts, fullPromptText, systemPrompt } =
            await buildPromptPartsAndSystem(messages);
        const createdAt = Math.floor(Date.now() / 1000);
        const responseId = `resp_${crypto.randomUUID()}`;
        const outputMessageId = `msg_${crypto.randomUUID()}`;

        if (stream) {
            await streamAgentResponses({
                res,
                client,
                sessionId,
                providerId,
                modelId,
                fullPromptText,
                systemPrompt,
                allParts,
                toolsMap: SERVER_AGENT_TOOLS,
                ignoredTools,
                responseId,
                createdAt
            });
            return;
        }

        return res.json(
            await runAgentResponses({
                client,
                sessionId,
                providerId,
                modelId,
                fullPromptText,
                systemPrompt,
                allParts,
                toolsMap: SERVER_AGENT_TOOLS,
                ignoredTools,
                responseId,
                createdAt,
                outputMessageId
            })
        );
    } catch (caught) {
        const error = caught as import('../types.ts').UpstreamErrorLike;
        logger.error('Responses API Proxy Error:', error);
        const errorMessage = sanitizeErrorMessage(
            error.response?.data?.error?.message || error.message || 'Unknown error'
        );
        return res
            .status(500)
            .json({ error: { message: 'Internal Proxy Error', details: errorMessage } });
    }
}

export { responsesHandler, handleToolsResponses, handleToolsResponsesStream };
