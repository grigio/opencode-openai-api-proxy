process.env.OPENCODE_TOOL_CALLING = 'direct';
import request from 'supertest';
import { jest } from '@jest/globals';

// Define mock before importing the app
jest.unstable_mockModule('@opencode-ai/sdk', () => {
    const client = {
        config: {
            providers: jest.fn(async () => ({
                data: {
                    providers: [
                        {
                            id: 'opencode',
                            options: { apiKey: 'public' },
                            models: {
                                'big-pickle': {
                                    id: 'big-pickle',
                                    api: {
                                        id: 'big-pickle',
                                        url: 'https://opencode.ai/zen/v1',
                                        npm: '@ai-sdk/openai-compatible'
                                    }
                                }
                            }
                        }
                    ]
                }
            })),
            update: jest.fn(async () => ({}))
        },
        session: {
            create: jest.fn(async () => ({
                data: { id: 'test-session-id' }
            })),
            prompt: jest.fn(async (args) => {
                const promptText = args.body.prompt || '';
                const parts = [{ type: 'text', text: 'Simulated response' }];

                if (promptText.includes('reasoning')) {
                    parts.unshift({ type: 'reasoning', text: 'Thinking process...' });
                }

                return {
                    data: { parts }
                };
            })
        },
        event: {
            subscribe: jest.fn(async () => {
                const sessionId = 'test-session-id';
                const mockEvents = [
                    {
                        type: 'message.part.updated',
                        properties: {
                            part: { type: 'reasoning', sessionID: sessionId },
                            delta: 'Thinking...'
                        }
                    },
                    {
                        type: 'message.part.updated',
                        properties: {
                            part: { type: 'text', sessionID: sessionId },
                            delta: 'Simulated'
                        }
                    },
                    {
                        type: 'message.part.updated',
                        properties: {
                            part: { type: 'text', sessionID: sessionId },
                            delta: ' response'
                        }
                    },
                    {
                        type: 'message.updated',
                        properties: { info: { sessionID: sessionId, finish: 'stop' } }
                    }
                ];

                return {
                    stream: (async function* () {
                        for (const event of mockEvents) {
                            yield event;
                        }
                    })()
                };
            })
        }
    };
    return { createOpencodeClient: jest.fn(() => client) };
});

const { default: app } = await import('../app.ts');
const { createOpencodeClient } = await import('@opencode-ai/sdk');
const { clearProviderCache, restoreFoldedReasoning, normalizeToolDefinitions, readAuthStoreKey } =
    await import('../model-gateway.ts');
const { MAX_REPEATED_TOOL_LOOPS } = await import('../utils.ts');

// Builds a ReadableStream with OpenAI SSE chat completion chunks for mocking
// the direct model-gateway HTTP call.
function sseStream(chunks) {
    const encoder = new TextEncoder();
    const data = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(data));
            controller.close();
        }
    });
}

function nonStreamingFetchResponse(data) {
    return { ok: true, status: 200, json: async () => data };
}

// Builds a ReadableStream that delivers the given SSE chunks and then fails
// on the next read (simulates an upstream connection reset mid-stream, before
// any [DONE]). Chunks are enqueued lazily from pull() so every chunk is
// delivered to the reader before the error surfaces.
function errorSseStream(chunks) {
    const encoder = new TextEncoder();
    const parts = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
    let index = 0;
    return new ReadableStream({
        pull(controller) {
            if (index < parts.length) {
                controller.enqueue(encoder.encode(parts[index++]));
            } else {
                controller.error(new Error('upstream connection reset'));
            }
        }
    });
}

// Builds a ReadableStream that delivers the given SSE chunks and then closes
// cleanly (EOF) WITHOUT a [DONE] marker and without a terminal finish_reason
// chunk - the normal behaviour of upstreams that omit the marker.
function eofStream(chunks) {
    const encoder = new TextEncoder();
    const data = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(data));
            controller.close();
        }
    });
}

describe('Proxy OpenAI API', () => {
    const originalEnv = process.env;
    const originalFetch = global.fetch;

    beforeEach(() => {
        process.env = { ...originalEnv, OPENCODE_SERVER_PASSWORD: 'test-password' };
        global.fetch = jest.fn();
        clearProviderCache();
    });

    afterAll(() => {
        process.env = originalEnv;
        global.fetch = originalFetch;
    });

    test('GET /health should return status ok without auth', async () => {
        const res = await request(app).get('/health');
        expect(res.statusCode).toEqual(200);
        expect(res.body).toEqual({ status: 'ok', proxy: true });
    });

    test('should fail without authentication on v1 endpoints', async () => {
        const res = await request(app).get('/v1/models');
        expect(res.statusCode).toEqual(401);
    });

    test('should refuse serving when OPENCODE_SERVER_PASSWORD is not set', async () => {
        delete process.env.OPENCODE_SERVER_PASSWORD;
        const res = await request(app).get('/v1/models').set('Authorization', 'Bearer whatever');
        expect(res.statusCode).toEqual(503);
        process.env.OPENCODE_SERVER_PASSWORD = 'test-password';
    });

    test('GET /v1/models should return OpenAI-compatible model list', async () => {
        const res = await request(app)
            .get('/v1/models')
            .set('Authorization', 'Bearer test-password');

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('list');
        expect(res.body.data[0].id).toEqual('opencode/big-pickle');
    });

    test('POST /v1/chat/completions should return chat completion', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Hello' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('chat.completion');
        expect(res.body.choices[0].message.content).toEqual('Simulated response');
    });

    test('POST /v1/chat/completions should reject a malformed model with 400', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'not-a-valid-model',
                messages: [{ role: 'user', content: 'Hello' }]
            });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error.message).toContain('providerId/modelId');
    });

    test('POST /v1/chat/completions should reject a missing model with 400', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                messages: [{ role: 'user', content: 'Hello' }]
            });

        expect(res.statusCode).toEqual(400);
    });

    test('POST /v1/chat/completions should route tool_choice alone through the tool path', async () => {
        // No tools array, but an explicit tool_choice object -> must hit the
        // model gateway (tool path) rather than the server-agent path.
        let fetchCalled = false;
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-x',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                {
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: 'get_weather', arguments: '{}' }
                                }
                            ]
                        }
                    }
                ],
                usage: {}
            })
        );

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'What is the weather?' }],
                tool_choice: { type: 'function', function: { name: 'get_weather' } }
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('tool_calls');
        expect(global.fetch.mock.calls.length).toEqual(1);
        expect(global.fetch.mock.calls[0][0]).toContain('/chat/completions');
    });

    test('POST /v1/chat/completions should support streaming with <think> tags', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('data: {"id"');
        expect(res.text).toContain('data: [DONE]');
        expect(res.text).toContain('Simulated');
    });

    test('POST /v1/chat/completions should support streaming with inline reasoning', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Test with reasoning' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('<think>');
        expect(res.text).toContain('</think>');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions should support multimodal content (images)', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
            arrayBuffer: async () => new TextEncoder().encode('fake-image-data').buffer
        } as unknown as Response);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'What is in this image?' },
                            {
                                type: 'image_url',
                                image_url: { url: 'https://example.com/image.png' }
                            }
                        ]
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toEqual('Simulated response');
    });

    test('POST /v1/chat/completions should refuse SSRF image targets (private IP)', async () => {
        global.fetch.mockClear();

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Analyze' },
                            {
                                type: 'image_url',
                                image_url: { url: 'http://169.254.169.254/latest/meta-data/' }
                            }
                        ]
                    }
                ]
            });

        // The image is skipped server-side; fetch must never be called with the
        // internal target, and the request still completes.
        expect(res.statusCode).toEqual(200);
        const urls = global.fetch.mock.calls.map(([u]) => String(u));
        expect(urls).not.toContain('http://169.254.169.254/latest/meta-data/');
    });

    test('POST /v1/chat/completions should refuse SSRF images to localhost', async () => {
        global.fetch.mockClear();

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Analyze' },
                            {
                                type: 'image_url',
                                image_url: { url: 'http://127.0.0.1:4097/global/health' }
                            }
                        ]
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        const urls = global.fetch.mock.calls.map(([u]) => String(u));
        expect(urls).not.toContain('http://127.0.0.1:4097/global/health');
    });

    test('POST /v1/chat/completions should not generate empty think tags when reasoning has no content (issue #1)', async () => {
        const client = createOpencodeClient();
        const sessionId = 'test-session-id';

        client.event.subscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'reasoning', sessionID: sessionId },
                        delta: 'The user is asking'
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'reasoning', sessionID: sessionId },
                        delta: ' a simple math question'
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'reasoning', sessionID: sessionId },
                        delta: '. The answer is 2.'
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: { part: { type: 'text', sessionID: sessionId }, delta: '1+1' }
                };
                yield {
                    type: 'message.part.updated',
                    properties: { part: { type: 'text', sessionID: sessionId }, delta: ' = 2' }
                };
                yield {
                    type: 'message.part.updated',
                    properties: { part: { type: 'reasoning', sessionID: sessionId }, delta: null }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: { type: 'reasoning', sessionID: sessionId },
                        delta: undefined
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: { info: { sessionID: sessionId, finish: 'stop' } }
                };
            })()
        }));

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: '1+1=?' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);

        const thinkOpenCount = (res.text.match(/<think>/g) || []).length;
        const thinkCloseCount = (res.text.match(/<\/think>/g) || []).length;
        expect(thinkOpenCount).toEqual(1);
        expect(thinkCloseCount).toEqual(1);
    });

    test('POST /v1/chat/completions should stream cumulative part.text and skip user echo', async () => {
        const client = createOpencodeClient();
        const sessionId = 'test-session-id';

        client.event.subscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.updated',
                    properties: { info: { id: 'msg_user', sessionID: sessionId, role: 'user' } }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_user',
                            messageID: 'msg_user',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Stream a short answer'
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_reasoning',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'reasoning',
                            text: 'Think'
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_reasoning',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'reasoning',
                            text: 'Thinking...'
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_text',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: ''
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_text',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Banana'
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_text',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Banana!'
                        }
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'msg_assistant',
                            sessionID: sessionId,
                            role: 'assistant',
                            finish: 'stop'
                        }
                    }
                };
            })()
        }));

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Stream a short answer' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('<think>');
        expect(res.text).toContain('</think>');
        expect(res.text).toContain('"content":"Banana"');
        expect(res.text).toContain('"content":"!"');
        expect(res.text).not.toContain('Stream a short answer');
        expect(res.text).toContain('"finish_reason":"stop"');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions should return reasoning tokens when available (non-streaming)', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Test with reasoning' }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toContain(
            '<think>\nThinking process...\n</think>\n\nSimulated response'
        );
        expect(res.body.usage.completion_tokens_details.reasoning_tokens).toBeGreaterThan(0);
        expect(res.body.choices[0].message.reasoning_content).toBeUndefined();
    });

    test('POST /v1/responses should return response format in non-streaming', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Hello'
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.status).toEqual('completed');
        expect(res.body.output[0].type).toEqual('message');
        expect(res.body.output[0].content[0].type).toEqual('output_text');
    });

    test('POST /v1/responses should support streaming in responses format', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Hello',
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('"type":"response.created"');
        expect(res.text).toContain('"type":"response.output_text.delta"');
        expect(res.text).toContain('"type":"response.completed"');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses should stream cumulative part.text and skip user echo', async () => {
        const client = createOpencodeClient();
        const sessionId = 'test-session-id';

        client.event.subscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.updated',
                    properties: { info: { id: 'msg_user', sessionID: sessionId, role: 'user' } }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_user',
                            messageID: 'msg_user',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Stream a short answer'
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_reasoning',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'reasoning',
                            text: 'Think'
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_reasoning',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'reasoning',
                            text: 'Thinking...'
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_text',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: ''
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_text',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Banana'
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_text',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Banana!'
                        }
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'msg_assistant',
                            sessionID: sessionId,
                            role: 'assistant',
                            finish: 'stop'
                        }
                    }
                };
            })()
        }));

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Stream a short answer',
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('"type":"response.created"');
        expect(res.text).toContain('Banana!');
        expect(res.text).not.toContain('Stream a short answer');
        expect(res.text).toContain('"type":"response.completed"');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses should support previous_response_id', async () => {
        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'First message'
            });

        expect(first.statusCode).toEqual(200);
        expect(first.body.id).toBeDefined();

        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                previous_response_id: first.body.id,
                input: 'Follow-up'
            });

        expect(second.statusCode).toEqual(200);
        expect(second.body.object).toEqual('response');
    });

    test('POST /v1/responses should reject invalid previous_response_id', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                previous_response_id: 'resp_invalid',
                input: 'test'
            });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error.message).toContain('previous_response_id');
    });

    test('POST /v1/responses should return function_call output when tools are used', async () => {
        global.fetch.mockResolvedValue(
            nonStreamingFetchResponse({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: 'Let me check the weather',
                            tool_calls: [
                                {
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                                }
                            ]
                        }
                    }
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
            })
        );

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'What is the weather in Rome?',
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.output[0].type).toEqual('function_call');
        expect(res.body.output[0].name).toEqual('get_weather');
        expect(res.body.output[0].arguments).toEqual('{"city":"Rome"}');
        expect(res.body.finish_reason).toEqual('tool_calls');

        // The model gateway must have been called with the tools attached.
        const callArgs = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(callArgs.tools[0].function.name).toEqual('get_weather');
        expect(callArgs.stream).toEqual(false);
    });

    test('POST /v1/responses should continue tool loop with function_call_output', async () => {
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: '',
                            tool_calls: [
                                {
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                                }
                            ]
                        }
                    }
                ],
                usage: {}
            })
        );
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'It is sunny in Rome.' }
                    }
                ],
                usage: {}
            })
        );

        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'What is the weather in Rome?',
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(first.statusCode).toEqual(200);
        expect(first.body.output[0].type).toEqual('function_call');
        const callId = first.body.output[0].call_id;

        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                previous_response_id: first.body.id,
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                input: [{ type: 'function_call_output', call_id: callId, output: '{"temp":25}' }]
            });

        expect(second.statusCode).toEqual(200);
        expect(second.body.output[0].type).toEqual('message');
        expect(second.body.output[0].content[0].text).toContain('sunny');

        // The continuation request must replay the assistant tool_calls and the
        // tool result back to the model.
        const continuationBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        const roles = continuationBody.messages.map((m) => m.role);
        expect(roles).toEqual(['user', 'assistant', 'tool']);
        expect(continuationBody.messages[1].tool_calls[0].id).toEqual(callId);
    });

    test('POST /v1/responses should continue tool loop when function_call_output is sent without tools (previous_response_id)', async () => {
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: '',
                            tool_calls: [
                                {
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                                }
                            ]
                        }
                    }
                ],
                usage: {}
            })
        );
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'It is sunny in Rome.' }
                    }
                ],
                usage: {}
            })
        );

        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'What is the weather in Rome?',
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(first.statusCode).toEqual(200);
        const callId = first.body.output[0].call_id;

        // Codex omits `tools` on the continuation - the proxy must reuse the
        // tools stored with the previous response instead of rejecting.
        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                previous_response_id: first.body.id,
                input: [{ type: 'function_call_output', call_id: callId, output: '{"temp":25}' }]
            });

        expect(second.statusCode).toEqual(200);
        expect(second.body.output[0].type).toEqual('message');
        expect(second.body.output[0].content[0].text).toContain('sunny');

        const continuationBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        const roles = continuationBody.messages.map((m) => m.role);
        expect(roles).toEqual(['user', 'assistant', 'tool']);
        expect(continuationBody.messages[1].tool_calls[0].id).toEqual(callId);
        // tools replayed from the stored previous response
        expect(continuationBody.tools[0].function.name).toEqual('get_weather');
    });

    test('POST /v1/responses should reject function_call_output without tools and without previous_response_id', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: [{ type: 'function_call_output', call_id: 'call_1', output: 'x' }]
            });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error.message).toContain('previous_response_id');
    });

    test('POST /v1/chat/completions should abort when the exact same tool call repeats', async () => {
        const assistant = () => ({
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: `call_${Math.random()}`,
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                }
            ]
        });

        // Build a loop that exceeds MAX_REPEATED_TOOL_LOOPS (threshold+1 identical calls)
        const messages = [{ role: 'user', content: 'weather?' }];
        for (let i = 0; i < MAX_REPEATED_TOOL_LOOPS + 1; i++) {
            messages.push(assistant());
            if (i < MAX_REPEATED_TOOL_LOOPS) messages.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x' });
        }

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages,
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(422);
        expect(res.body.error.message).toContain('loop');
    });

    test('POST /v1/chat/completions should tolerate a few identical tool calls', async () => {
        global.fetch.mockResolvedValue(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Done.' }
                    }
                ],
                usage: {}
            })
        );

        const assistant = () => ({
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: `call_${Math.random()}`,
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                }
            ]
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'weather?' },
                    assistant(),
                    { role: 'tool', tool_call_id: 'c1', content: 'x' },
                    assistant(),
                    { role: 'tool', tool_call_id: 'c2', content: 'x' },
                    assistant(),
                    { role: 'tool', tool_call_id: 'c3', content: 'x' }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(200);
    });

    test('POST /v1/responses should abort after repeated identical tool calls across continuations', async () => {
        const toolCallResponse = () =>
            nonStreamingFetchResponse({
                id: 'chatcmpl-x',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: '',
                            tool_calls: [
                                {
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                                }
                            ]
                        }
                    }
                ],
                usage: {}
            });
        for (let i = 0; i < MAX_REPEATED_TOOL_LOOPS + 1; i++) {
            global.fetch.mockResolvedValueOnce(toolCallResponse());
        }

        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'weather?',
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });
        expect(first.statusCode).toEqual(200);
        let id = first.body.id;
        let callId = first.body.output[0].call_id;

        // The model keeps repeating the identical tool call: MAX_REPEATED_TOOL_LOOPS continuations
        // are allowed, the next identical call trips the guard.
        for (let i = 0; i < MAX_REPEATED_TOOL_LOOPS; i++) {
            const next = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    previous_response_id: id,
                    input: [
                        { type: 'function_call_output', call_id: callId, output: '{"temp":25}' }
                    ]
                });
            expect(next.statusCode).toEqual(200);
            expect(next.body.output[0].type).toEqual('function_call');
            id = next.body.id;
            callId = next.body.output[0].call_id;
        }

        // The next identical tool call (same name and arguments) trips the guard.
        const fourth = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                previous_response_id: id,
                input: [{ type: 'function_call_output', call_id: callId, output: '{"temp":25}' }]
            });
        expect(fourth.statusCode).toEqual(422);
        expect(fourth.body.error.message).toContain('loop');
    });

    test('POST /v1/chat/completions should route tool-role messages without tools through the tool path', async () => {
        global.fetch.mockResolvedValue(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Done.' }
                    }
                ],
                usage: {}
            })
        );

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'What is the weather?' },
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '{}' }
                            }
                        ]
                    },
                    { role: 'tool', tool_call_id: 'call_1', content: 'sunny' }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toEqual('Done.');
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        const roles = body.messages.map((m) => m.role);
        expect(roles).toEqual(['user', 'assistant', 'tool']);
    });

    test('POST /v1/responses should stream function_call events when tools are used', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: sseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: { role: 'assistant', content: null, reasoning_content: '' },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'call_1',
                                        type: 'function',
                                        function: { name: 'get_weather', arguments: '' }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [{ index: 0, function: { arguments: '{"city"' } }]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [{ index: 0, function: { arguments: ':"Rome"}' } }]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
                }
            ])
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'What is the weather in Rome?',
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('"type":"response.output_item.added"');
        expect(res.text).toContain('"type":"function_call"');
        expect(res.text).toContain('response.function_call_arguments.delta');
        expect(res.text).toContain('"type":"response.completed"');
        expect(res.text).toContain('"finish_reason":"tool_calls"');
        expect(res.text).toContain('data: [DONE]');
        // The streamed response must record continuation state so the tool loop
        // can be resumed via previous_response_id.
        expect(res.text).toContain('"call_id":"call_1"');
        expect(global.fetch.mock.calls.length).toEqual(1);
    });

    test('POST /v1/responses should continue tool loop after streaming (previous_response_id)', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            body: sseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: { role: 'assistant', content: null },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'call_9',
                                        type: 'function',
                                        function: {
                                            name: 'get_weather',
                                            arguments: '{"city":"Rome"}'
                                        }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
                }
            ])
        });
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Sunny and warm.' }
                    }
                ],
                usage: {}
            })
        );

        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'What is the weather in Rome?',
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });
        expect(first.statusCode).toEqual(200);
        expect(first.text).toContain('"finish_reason":"tool_calls"');
        const idMatch = first.text.match(/"id":"(resp_[^"]+)"/);
        expect(idMatch).toBeTruthy();

        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                previous_response_id: idMatch[1],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                input: [{ type: 'function_call_output', call_id: 'call_9', output: '{"temp":25}' }]
            });

        expect(second.statusCode).toEqual(200);
        expect(second.body.output[0].content[0].text).toContain('Sunny');
        // Continuation must replay the assistant tool_calls + tool result.
        const contBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        const roles = contBody.messages.map((m) => m.role);
        expect(roles).toEqual(['user', 'assistant', 'tool']);
    });

    test('POST /v1/responses should pass reasoning_content back on streamed tool continuation', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            body: sseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                role: 'assistant',
                                content: null,
                                reasoning_content: 'Need to fetch the weather'
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'call_9',
                                        type: 'function',
                                        function: {
                                            name: 'get_weather',
                                            arguments: '{"city":"Rome"}'
                                        }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
                }
            ])
        });
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Sunny and warm.' }
                    }
                ],
                usage: {}
            })
        );

        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'What is the weather in Rome?',
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });
        expect(first.statusCode).toEqual(200);
        const idMatch = first.text.match(/"id":"(resp_[^"]+)"/);
        expect(idMatch).toBeTruthy();

        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                previous_response_id: idMatch[1],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                input: [{ type: 'function_call_output', call_id: 'call_9', output: '{"temp":25}' }]
            });

        expect(second.statusCode).toEqual(200);
        const contBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        const assistantMsg = contBody.messages.find((m) => m.role === 'assistant');
        // The streamed reasoning must be replayed in a dedicated field so the
        // DeepSeek thinking contract is satisfied on the continuation.
        expect(assistantMsg.reasoning_content).toEqual('Need to fetch the weather');
        expect(assistantMsg.content).not.toContain('<think>');
        expect(assistantMsg.content).not.toContain(' thinking');
    });

    test('POST /v1/chat/completions streaming should expose reasoning_content in deltas', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: sseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: { reasoning_content: 'Thinking about weather' },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'call_1',
                                        type: 'function',
                                        function: { name: 'get_weather', arguments: '{}' }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
                }
            ])
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        // Reasoning-aware clients receive a dedicated field they can echo back
        // verbatim on a tool-call continuation.
        expect(res.text).toContain('"reasoning_content":"Thinking about weather"');
        // Reasoning must NOT leak into `content`: generic clients render that
        // verbatim, so the model's deliberation would show up in the answer.
        const contentDeltas = res.text
            .split('\n')
            .filter((l) => l.startsWith('data: ') && l.includes('delta'))
            .map((l) => JSON.parse(l.slice(6)))
            .map((c) => c.choices[0].delta)
            .filter((d) => typeof d.content === 'string' && d.content);
        expect(contentDeltas).toEqual([]);
        expect(res.text).not.toContain('thinking\\n');
    });

    test('POST /v1/responses should use correct output_index for parallel streamed tool calls', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: sseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: { role: 'assistant', content: null },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'c1',
                                        function: { name: 'get_a', arguments: '{}' }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 1,
                                        id: 'c2',
                                        function: { name: 'get_b', arguments: '{}' }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
                }
            ])
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Call both',
                tools: [
                    { type: 'function', function: { name: 'get_a' } },
                    { type: 'function', function: { name: 'get_b' } }
                ],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        // Each function_call output_item.done must carry its own output_index
        // (0 and 1), not a hardcoded 0.
        expect(res.text).toContain('"call_id":"c1"');
        expect(res.text).toContain('"call_id":"c2"');
        const done0 = res.text.match(/"call_id":"c1"[^}]*/);
        const done1 = res.text.match(/"call_id":"c2"[^}]*/);
        expect(done0).toBeTruthy();
        expect(done1).toBeTruthy();
        // completed event declares parallel_tool_calls
        expect(res.text).toContain('"parallel_tool_calls":true');
    });

    test('POST /v1/responses streaming should normalize chat-shaped upstream usage into responses usage', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: sseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'c1',
                                        function: { name: 'get_a', arguments: '{}' }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                    usage: {
                        prompt_tokens: 42,
                        completion_tokens: 7,
                        total_tokens: 49,
                        completion_tokens_details: { reasoning_tokens: 3 }
                    }
                }
            ])
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Call a tool',
                tools: [{ type: 'function', function: { name: 'get_a' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        const completedLine = res.text
            .split('\n')
            .find((line) => line.includes('"type":"response.completed"'));
        expect(completedLine).toBeTruthy();
        const completed = JSON.parse(completedLine.replace(/^data: /, ''));
        const usage = completed.response.usage;
        expect(usage.input_tokens).toEqual(42);
        expect(usage.output_tokens).toEqual(7);
        expect(usage.total_tokens).toEqual(49);
        expect(usage.output_tokens_details.reasoning_tokens).toEqual(3);
        expect(usage.prompt_tokens).toBeUndefined();
    });

    test('POST /v1/chat/completions should return tool_calls when tools are used', async () => {
        global.fetch.mockResolvedValue(
            nonStreamingFetchResponse({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: 'Checking the weather...',
                            reasoning_content: 'User wants the weather',
                            tool_calls: [
                                {
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                                }
                            ]
                        }
                    }
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
            })
        );

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather in Rome?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('tool_calls');
        expect(res.body.choices[0].message.tool_calls[0].function.name).toEqual('get_weather');
        expect(res.body.choices[0].message.tool_calls[0].function.arguments).toEqual(
            '{"city":"Rome"}'
        );
        // reasoning_content is folded into content with <think> tags
        expect(res.body.choices[0].message.content).toContain('<think>');

        const callArgs = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(callArgs.messages[0].content).toEqual('Weather in Rome?');
        expect(callArgs.tools[0].function.name).toEqual('get_weather');
    });

    test('normalizeToolDefinitions maps flat Responses tools onto nested chat shape', () => {
        const flat = {
            type: 'function',
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
            strict: true
        };
        const out = normalizeToolDefinitions([flat]);
        expect(out[0].type).toEqual('function');
        expect(out[0].name).toBeUndefined();
        expect(out[0].function.name).toEqual('get_weather');
        expect(out[0].function.description).toEqual('Get weather');
        expect(out[0].function.parameters.properties.city.type).toEqual('string');
        expect(out[0].function.strict).toEqual(true);
    });

    test('normalizeToolDefinitions keeps nested chat-shape tools untouched', () => {
        const nested = { type: 'function', function: { name: 'get_weather' } };
        expect(normalizeToolDefinitions([nested])).toEqual([nested]);
    });

    test('normalizeToolDefinitions wraps tools that omit type (Codex multi-agent schemas)', () => {
        const tool = { name: 'multi_agent_v1', description: 'spawn agents', tools: [] };
        const out = normalizeToolDefinitions([tool]);
        expect(out[0].type).toEqual('function');
        expect(out[0].function.name).toEqual('multi_agent_v1');
        expect(out[0].function.parameters.type).toEqual('object');
        expect(out[0].name).toBeUndefined();
    });

    test('normalizeToolDefinitions drops unrepresentable tools (no name, no function)', () => {
        expect(normalizeToolDefinitions([{ type: 'web_search_preview' }])).toBeUndefined();
        expect(
            normalizeToolDefinitions([
                { type: 'function', function: { name: 'a' } },
                { type: 'web_search_preview' }
            ])
        ).toHaveLength(1);
    });

    test('normalizeToolDefinitions returns undefined for empty or invalid input', () => {
        expect(normalizeToolDefinitions([])).toBeUndefined();
        expect(normalizeToolDefinitions(undefined)).toBeUndefined();
        expect(normalizeToolDefinitions(null)).toBeUndefined();
    });

    test('readAuthStoreKey returns the key opencode stored in auth.json', async () => {
        const originalHome = process.env.HOME;
        const tempHome = await import('fs').then((fs) => fs.promises.mkdtemp('/tmp/auth-store-'));
        try {
            await import('fs').then((fs) =>
                fs.promises.mkdir(`${tempHome}/.local/share/opencode`, { recursive: true })
            );
            await import('fs').then((fs) =>
                fs.promises.writeFile(
                    `${tempHome}/.local/share/opencode/auth.json`,
                    JSON.stringify({ opencode: { key: 'oc-real-token-123' } })
                )
            );
            process.env.HOME = tempHome;
            expect(readAuthStoreKey('opencode')).toEqual('oc-real-token-123');
        } finally {
            process.env.HOME = originalHome;
        }
    });

    test('readAuthStoreKey returns null for missing, redacted or string entries', async () => {
        const originalHome = process.env.HOME;
        const tempHome = await import('fs').then((fs) => fs.promises.mkdtemp('/tmp/auth-store-'));
        try {
            await import('fs').then((fs) =>
                fs.promises.mkdir(`${tempHome}/.local/share/opencode`, { recursive: true })
            );
            await import('fs').then((fs) =>
                fs.promises.writeFile(
                    `${tempHome}/.local/share/opencode/auth.json`,
                    JSON.stringify({
                        opencode: { key: 'public' },
                        openrouter: 'plain-string',
                        other: {},
                        noAccess: { type: 'oauth', refresh: 'r' }
                    })
                )
            );
            process.env.HOME = tempHome;
            expect(readAuthStoreKey('opencode')).toBeNull();
            expect(readAuthStoreKey('openrouter')).toEqual('plain-string');
            expect(readAuthStoreKey('other')).toBeNull();
            expect(readAuthStoreKey('noAccess')).toBeNull();
            expect(readAuthStoreKey('missing')).toBeNull();
        } finally {
            process.env.HOME = originalHome;
        }
    });

    test('readAuthStoreKey handles api/oauth/wellknown discriminated entries', async () => {
        const originalHome = process.env.HOME;
        const tempHome = await import('fs').then((fs) => fs.promises.mkdtemp('/tmp/auth-store-'));
        try {
            await import('fs').then((fs) =>
                fs.promises.mkdir(`${tempHome}/.local/share/opencode`, { recursive: true })
            );
            await import('fs').then((fs) =>
                fs.promises.writeFile(
                    `${tempHome}/.local/share/opencode/auth.json`,
                    JSON.stringify({
                        opencode: {
                            type: 'oauth',
                            access: 'oc-oauth-access-999',
                            refresh: 'oc-refresh',
                            expires: 4102444800
                        },
                        openrouter: { type: 'api', key: 'sk-or-123' },
                        github: { type: 'wellknown', key: 'wk-token-456' }
                    })
                )
            );
            process.env.HOME = tempHome;
            expect(readAuthStoreKey('opencode')).toEqual('oc-oauth-access-999');
            expect(readAuthStoreKey('openrouter')).toEqual('sk-or-123');
            expect(readAuthStoreKey('github')).toEqual('wk-token-456');
        } finally {
            process.env.HOME = originalHome;
        }
    });

    test('readAuthStoreKey honors XDG_DATA_HOME like opencode', async () => {
        const originalHome = process.env.HOME;
        const originalXdg = process.env.XDG_DATA_HOME;
        const tempHome = await import('fs').then((fs) => fs.promises.mkdtemp('/tmp/auth-store-'));
        try {
            const xdgHome = `${tempHome}/xdg`;
            await import('fs').then((fs) =>
                fs.promises.mkdir(`${xdgHome}/opencode`, { recursive: true })
            );
            await import('fs').then((fs) =>
                fs.promises.writeFile(
                    `${xdgHome}/opencode/auth.json`,
                    JSON.stringify({ opencode: { type: 'oauth', access: 'xdg-access-1' } })
                )
            );
            process.env.HOME = tempHome;
            process.env.XDG_DATA_HOME = xdgHome;
            expect(readAuthStoreKey('opencode')).toEqual('xdg-access-1');
        } finally {
            process.env.HOME = originalHome;
            process.env.XDG_DATA_HOME = originalXdg;
        }
    });

    test('POST /v1/chat/completions should use the auth.json key when /config/providers redacts it', async () => {
        const originalHome = process.env.HOME;
        const tempHome = await import('fs').then((fs) => fs.promises.mkdtemp('/tmp/auth-store-'));
        try {
            await import('fs').then((fs) =>
                fs.promises.mkdir(`${tempHome}/.local/share/opencode`, { recursive: true })
            );
            await import('fs').then((fs) =>
                fs.promises.writeFile(
                    `${tempHome}/.local/share/opencode/auth.json`,
                    JSON.stringify({ opencode: { key: 'oc-real-token-123' } })
                )
            );
            process.env.HOME = tempHome;
            clearProviderCache();

            global.fetch.mockResolvedValue(
                nonStreamingFetchResponse({
                    id: 'chatcmpl-x',
                    object: 'chat.completion',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            finish_reason: 'stop',
                            message: { role: 'assistant', content: 'Done.' }
                        }
                    ],
                    usage: {}
                })
            );

            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    messages: [{ role: 'user', content: 'weather?' }],
                    tools: [{ type: 'function', function: { name: 'get_weather' } }]
                });

            expect(res.statusCode).toEqual(200);
            // The redacted "public" placeholder must never reach the upstream:
            // the real token from the auth store is used instead.
            const headers = global.fetch.mock.calls[0][1].headers;
            expect(headers['Authorization']).toEqual('Bearer oc-real-token-123');
        } finally {
            process.env.HOME = originalHome;
        }
    });

    test('POST /v1/chat/completions should use the oauth access token when the server exposes no apiKey', async () => {
        const originalHome = process.env.HOME;
        const tempHome = await import('fs').then((fs) => fs.promises.mkdtemp('/tmp/auth-store-'));
        try {
            await import('fs').then((fs) =>
                fs.promises.mkdir(`${tempHome}/.local/share/opencode`, { recursive: true })
            );
            await import('fs').then((fs) =>
                fs.promises.writeFile(
                    `${tempHome}/.local/share/opencode/auth.json`,
                    JSON.stringify({
                        opencode: {
                            type: 'oauth',
                            access: 'oc-oauth-access-999',
                            refresh: 'oc-refresh'
                        }
                    })
                )
            );
            process.env.HOME = tempHome;
            clearProviderCache();
            const client = createOpencodeClient();
            // An oauth-backed provider is reported with no apiKey at all:
            client.config.providers.mockResolvedValueOnce({
                data: {
                    providers: [
                        {
                            id: 'opencode',
                            options: {},
                            models: {
                                'big-pickle': {
                                    id: 'big-pickle',
                                    api: { id: 'big-pickle', url: 'https://opencode.ai/zen/v1' },
                                    attachment: false
                                }
                            }
                        }
                    ]
                }
            });

            global.fetch.mockResolvedValue(
                nonStreamingFetchResponse({
                    id: 'chatcmpl-oauth',
                    object: 'chat.completion',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            finish_reason: 'stop',
                            message: { role: 'assistant', content: 'Done.' }
                        }
                    ],
                    usage: {}
                })
            );

            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    messages: [{ role: 'user', content: 'weather?' }],
                    tools: [{ type: 'function', function: { name: 'get_weather' } }]
                });

            expect(res.statusCode).toEqual(200);
            const headers = global.fetch.mock.calls[0][1].headers;
            expect(headers['Authorization']).toEqual('Bearer oc-oauth-access-999');
        } finally {
            process.env.HOME = originalHome;
        }
    });

    test('POST /v1/chat/completions should use OPENCODE_API_KEY when no auth store entry exists', async () => {
        const originalHome = process.env.HOME;
        const originalKey = process.env.OPENCODE_API_KEY;
        const tempHome = await import('fs').then((fs) => fs.promises.mkdtemp('/tmp/auth-store-'));
        try {
            process.env.HOME = tempHome;
            process.env.OPENCODE_API_KEY = 'sk-zen-env-42';
            clearProviderCache();
            // No auth.json at all: the server reports the "public" placeholder
            // for the zen provider, the key comes from the container env.
            global.fetch.mockResolvedValue(
                nonStreamingFetchResponse({
                    id: 'chatcmpl-env',
                    object: 'chat.completion',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            finish_reason: 'stop',
                            message: { role: 'assistant', content: 'Done.' }
                        }
                    ],
                    usage: {}
                })
            );
            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    messages: [{ role: 'user', content: 'weather?' }],
                    tools: [{ type: 'function', function: { name: 'get_weather' } }]
                });

            expect(res.statusCode).toEqual(200);
            const headers = global.fetch.mock.calls[0][1].headers;
            expect(headers['Authorization']).toEqual('Bearer sk-zen-env-42');
        } finally {
            process.env.HOME = originalHome;
            process.env.OPENCODE_API_KEY = originalKey;
        }
    });

    test('POST /v1/responses should forward flat Responses-API tools to the upstream in nested chat shape', async () => {
        global.fetch.mockResolvedValue(
            nonStreamingFetchResponse({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                {
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                                }
                            ]
                        }
                    }
                ],
                usage: {}
            })
        );

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Weather in Rome?',
                tools: [
                    {
                        type: 'function',
                        name: 'get_weather',
                        description: 'Get the weather',
                        parameters: { type: 'object', properties: { city: { type: 'string' } } }
                    }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output[0].type).toEqual('function_call');
        expect(res.body.output[0].name).toEqual('get_weather');

        const callArgs = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(callArgs.tools[0].type).toEqual('function');
        expect(callArgs.tools[0].function.name).toEqual('get_weather');
        expect(callArgs.tools[0].function.description).toEqual('Get the weather');
        expect(callArgs.tools[0].name).toBeUndefined();
    });

    test('POST /v1/responses with anonymous opencode + tools hits zen directly so the client executes tools locally (default routing)', async () => {
        // The default provider mock exposes no usable key (options.apiKey =
        // 'public'), i.e. the anonymous free tier. The default routing (auto)
        // must relay the client's tools straight to zen (functions returned to
        // the client for local execution) without any env opt-in, instead of
        // the server agent running its own write/bash/edit built-ins inside the
        // container. OPENCODE_TOOL_CALLING=direct is set at module level, so
        // restore 'auto' for this test.
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'auto';
        const client = createOpencodeClient();
        // The SDK mock is module-level and shared across tests; clear the
        // server-agent call history before asserting this request skipped it.
        client.session.prompt.mockClear();
        client.session.create.mockClear();
        client.config.update.mockClear();
        try {
            global.fetch.mockResolvedValue(
                nonStreamingFetchResponse({
                    id: 'chatcmpl-zen',
                    object: 'chat.completion',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            finish_reason: 'tool_calls',
                            message: {
                                role: 'assistant',
                                content: null,
                                tool_calls: [
                                    {
                                        id: 'call_1',
                                        type: 'function',
                                        function: {
                                            name: 'create_file',
                                            arguments: '{"path":"cat.txt"}'
                                        }
                                    }
                                ]
                            }
                        }
                    ],
                    usage: {}
                })
            );

            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    input: 'create the file ./cat.txt with inside xx56',
                    tools: [{ type: 'function', function: { name: 'create_file' } }]
                });

            expect(res.statusCode).toEqual(200);
            // The tool call is relayed back for the CLIENT to execute locally.
            expect(res.body.output[0].type).toEqual('function_call');
            expect(res.body.output[0].name).toEqual('create_file');
            expect(res.body.finish_reason).toEqual('tool_calls');

            // The upstream hit is the raw zen endpoint (CLI identity headers),
            // NOT the opencode server agent via session.prompt.
            expect(global.fetch.mock.calls.length).toEqual(1);
            expect(global.fetch.mock.calls[0][0]).toContain(
                'https://opencode.ai/zen/v1/chat/completions'
            );
            const reqHeaders = global.fetch.mock.calls[0][1].headers;
            expect(reqHeaders['x-opencode-client']).toEqual('cli');
            expect(reqHeaders['x-opencode-session']).toBeTruthy();

            // Zen's anonymous pool requires the "You are opencode" system head.
            const body = JSON.parse(global.fetch.mock.calls[0][1].body);
            const system = body.messages.find((m) => m.role === 'system');
            expect(system.content).toContain('You are opencode');

            // The server agent must NOT have been invoked (it would execute the
            // tool inside the container on the proxy side).
            expect(client.session.prompt).not.toHaveBeenCalled();
            expect(client.session.create).not.toHaveBeenCalled();
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('POST /v1/responses with anonymous opencode + tools streams function_call events straight from zen (default routing)', async () => {
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'auto';
        const client = createOpencodeClient();
        client.session.prompt.mockClear();
        client.session.create.mockClear();
        client.config.update.mockClear();
        try {
            global.fetch.mockResolvedValue({
                ok: true,
                status: 200,
                body: sseStream([
                    {
                        id: 'x',
                        object: 'chat.completion.chunk',
                        created: 0,
                        model: 'big-pickle',
                        choices: [
                            {
                                index: 0,
                                delta: { role: 'assistant', content: null },
                                finish_reason: null
                            }
                        ]
                    },
                    {
                        id: 'x',
                        object: 'chat.completion.chunk',
                        created: 0,
                        model: 'big-pickle',
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: 'call_1',
                                            type: 'function',
                                            function: { name: 'create_file', arguments: '' }
                                        }
                                    ]
                                },
                                finish_reason: null
                            }
                        ]
                    },
                    {
                        id: 'x',
                        object: 'chat.completion.chunk',
                        created: 0,
                        model: 'big-pickle',
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    tool_calls: [
                                        { index: 0, function: { arguments: '{"path":"cat.txt"}' } }
                                    ]
                                },
                                finish_reason: null
                            }
                        ]
                    },
                    {
                        id: 'x',
                        object: 'chat.completion.chunk',
                        created: 0,
                        model: 'big-pickle',
                        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
                    }
                ])
            });

            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    input: 'create the file ./cat.txt with inside xx56',
                    tools: [{ type: 'function', function: { name: 'create_file' } }],
                    stream: true
                });

            expect(res.statusCode).toEqual(200);
            expect(res.text).toContain('"type":"response.output_item.added"');
            expect(res.text).toContain('"type":"function_call"');
            expect(res.text).toContain('response.function_call_arguments.delta');
            expect(res.text).toContain('"type":"response.completed"');
            expect(res.text).toContain('"finish_reason":"tool_calls"');
            expect(res.text).toContain('"call_id":"call_1"');
            expect(res.text).toContain('data: [DONE]');

            // Streamed from zen directly with the official CLI identity.
            expect(global.fetch.mock.calls.length).toEqual(1);
            expect(global.fetch.mock.calls[0][0]).toContain(
                'https://opencode.ai/zen/v1/chat/completions'
            );
            const reqHeaders = global.fetch.mock.calls[0][1].headers;
            expect(reqHeaders['x-opencode-client']).toEqual('cli');

            expect(client.session.prompt).not.toHaveBeenCalled();
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('POST /v1/responses with anonymous opencode + tools fails loudly when zen is unreachable (no in-container tool fallback)', async () => {
        // When the direct zen call fails (rate limit / network), the proxy must
        // NOT silently fall back to the server agent running in-container tools
        // (which would write files on the proxy side) - it surfaces the error.
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'auto';
        const client = createOpencodeClient();
        client.session.prompt.mockClear();
        client.session.create.mockClear();
        client.config.update.mockClear();
        try {
            global.fetch.mockRejectedValueOnce(new Error('FreeUsageLimitError'));

            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    input: 'create the file ./cat.txt with inside xx56',
                    tools: [{ type: 'function', function: { name: 'create_file' } }]
                });

            // The request fails loudly instead of executing in-container tools.
            expect(res.statusCode).not.toEqual(200);
            expect(res.body.error).toBeTruthy();
            expect(client.session.prompt).not.toHaveBeenCalled();
            expect(client.session.create).not.toHaveBeenCalled();
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('routes brand-new zen models missing from the server catalog through the default zen endpoint', async () => {
        // The opencode provider catalog is a cached models.dev snapshot, so
        // stealth free releases (e.g. "x-preview-f-free") can be requested
        // before the local server knows them. The proxy must still resolve
        // the stable zen endpoint instead of failing with 400.
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'auto';
        const client = createOpencodeClient();
        client.config.providers.mockResolvedValueOnce({
            data: {
                providers: [
                    {
                        id: 'opencode',
                        options: { apiKey: 'public' },
                        models: {
                            'big-pickle': {
                                id: 'big-pickle',
                                api: { id: 'big-pickle', url: 'https://opencode.ai/zen/v1' }
                            }
                        }
                    }
                ]
            }
        });
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-new',
                object: 'chat.completion',
                created: 0,
                model: 'x-preview-f-free',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Hi!' }
                    }
                ],
                usage: {}
            })
        );

        try {
            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/x-preview-f-free',
                    messages: [{ role: 'user', content: 'Hello' }]
                });

            expect(res.statusCode).toEqual(200);
            expect(res.body.model).toEqual('opencode/x-preview-f-free');
            expect(global.fetch.mock.calls[0][0]).toContain(
                'https://opencode.ai/zen/v1/chat/completions'
            );
            const upstreamBody = JSON.parse(global.fetch.mock.calls[0][1].body);
            expect(upstreamBody.model).toEqual('x-preview-f-free');
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('relays sampling and reasoning_effort controls to the model API (chat completions)', async () => {
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'auto';
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-ef',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'ok' }
                    }
                ],
                usage: {}
            })
        );

        try {
            await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    messages: [{ role: 'user', content: 'Hello' }],
                    reasoning_effort: 'low',
                    temperature: 0.3,
                    top_p: 0.9,
                    max_tokens: 256
                });

            const upstreamBody = JSON.parse(global.fetch.mock.calls[0][1].body);
            expect(upstreamBody.reasoning_effort).toEqual('low');
            expect(upstreamBody.temperature).toEqual(0.3);
            expect(upstreamBody.top_p).toEqual(0.9);
            expect(upstreamBody.max_tokens).toEqual(256);
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('maps Responses reasoning.effort and max_output_tokens onto the chat wire format', async () => {
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'auto';
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-rs',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'ok' }
                    }
                ],
                usage: {}
            })
        );

        try {
            await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    input: 'Hello',
                    reasoning: { effort: 'high' },
                    max_output_tokens: 512,
                    temperature: 0.7
                });

            const upstreamBody = JSON.parse(global.fetch.mock.calls[0][1].body);
            expect(upstreamBody.reasoning_effort).toEqual('high');
            expect(upstreamBody.max_tokens).toEqual(512);
            expect(upstreamBody.temperature).toEqual(0.7);
            expect(upstreamBody.reasoning).toBeUndefined();
            expect(upstreamBody.max_output_tokens).toBeUndefined();
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('strips images up front when the catalog reports capabilities.attachment = false', async () => {
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'auto';
        const client = createOpencodeClient();
        client.config.providers.mockResolvedValueOnce({
            data: {
                providers: [
                    {
                        id: 'opencode',
                        options: {},
                        models: {
                            'big-pickle': {
                                id: 'big-pickle',
                                api: { id: 'big-pickle', url: 'https://opencode.ai/zen/v1' },
                                capabilities: { attachment: false }
                            }
                        }
                    }
                ]
            }
        });
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-img',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'ok' }
                    }
                ],
                usage: {}
            })
        );

        try {
            await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: 'What is in this image?' },
                                {
                                    type: 'image_url',
                                    image_url: { url: 'data:image/png;base64,ZmFrZQ==' }
                                }
                            ]
                        }
                    ]
                });

            // Exactly one upstream call: the image was stripped BEFORE the first
            // attempt (no rejected-image retry needed).
            expect(global.fetch.mock.calls.length).toEqual(1);
            const upstreamBody = JSON.parse(global.fetch.mock.calls[0][1].body);
            const userMessage = upstreamBody.messages.find((m) => m.role === 'user');
            const parts = userMessage.content;
            expect(parts.some((p) => p.type === 'image_url')).toEqual(false);
            expect(
                parts.some((p) => p.type === 'text' && p.text.includes('does not support images'))
            ).toEqual(true);
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('retries transient upstream 503s on non-streaming requests before answering', async () => {
        // Zen's anonymous pool intermittently returns empty-body 503s; the
        // official CLI survives them because its AI SDK retries silently.
        // The proxy must do the same instead of failing the first attempt.
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'auto';
        const serviceUnavailable = { ok: false, status: 503, text: async () => '' };
        global.fetch
            .mockResolvedValueOnce(serviceUnavailable)
            .mockResolvedValueOnce(serviceUnavailable)
            .mockResolvedValueOnce(
                nonStreamingFetchResponse({
                    id: 'chatcmpl-retry',
                    object: 'chat.completion',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            finish_reason: 'stop',
                            message: { role: 'assistant', content: 'finally' }
                        }
                    ],
                    usage: {}
                })
            );

        try {
            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    messages: [{ role: 'user', content: 'Hello' }]
                });

            expect(res.statusCode).toEqual(200);
            expect(res.body.choices[0].message.content).toEqual('finally');
            expect(global.fetch.mock.calls.length).toEqual(3);
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('fails loudly with the real status when every attempt gets a transient 503 (tool path)', async () => {
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'auto';
        global.fetch.mockResolvedValue({ ok: false, status: 503, text: async () => '' });

        try {
            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    messages: [{ role: 'user', content: 'Hello' }],
                    tools: [{ type: 'function', function: { name: 'get_weather' } }]
                });

            // 1 initial attempt + UPSTREAM_MAX_RETRIES (default 2).
            expect(global.fetch.mock.calls.length).toEqual(3);
            expect(res.statusCode).toEqual(503);
            expect(res.body.error.message).toContain('Model API error (503)');
            expect(res.body.error.message).not.toContain('503): ');
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('retries a zen stream that fails to start and emits exactly one completion', async () => {
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'auto';
        global.fetch
            .mockResolvedValueOnce({ ok: false, status: 503, text: async () => '' })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                body: sseStream([
                    {
                        id: 'x',
                        object: 'chat.completion.chunk',
                        created: 0,
                        model: 'big-pickle',
                        choices: [{ index: 0, delta: { content: 'hi there' }, finish_reason: null }]
                    },
                    {
                        id: 'x',
                        object: 'chat.completion.chunk',
                        created: 0,
                        model: 'big-pickle',
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                    }
                ])
            });

        try {
            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    stream: true,
                    messages: [{ role: 'user', content: 'Hello' }]
                });

            expect(res.statusCode).toEqual(200);
            expect(global.fetch.mock.calls.length).toEqual(2);
            const events = res.text
                .split('\n')
                .filter((l) => l.startsWith('data: '))
                .map((l) => l.slice(6));
            expect(events[events.length - 1]).toEqual('[DONE]');
            // One content delta + one finish chunk, then [DONE]: the failed
            // first attempt must contribute nothing.
            const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
            expect(
                chunks.filter((c) => c.choices?.[0]?.delta?.content === 'hi there').length
            ).toEqual(1);
            expect(chunks.some((c) => !!c.choices?.[0]?.finish_reason)).toEqual(true);
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('zen-direct continues a stream that ends mid-turn and splices the continuation into one completion', async () => {
        // Free-tier upstreams often drop the connection after streaming some
        // prose, with no [DONE] and no finish_reason. The proxy must continue
        // the generation transparently: segment 1's text plus segment 2's text
        // (and finish) arrive under ONE completion id.
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'auto';
        let continuationBody = null;
        global.fetch
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                body: eofStream([
                    {
                        id: 'x',
                        object: 'chat.completion.chunk',
                        created: 0,
                        model: 'big-pickle',
                        choices: [
                            { index: 0, delta: { content: 'partial answer' }, finish_reason: null }
                        ]
                    }
                ])
            })
            .mockImplementationOnce((_url, init) => {
                continuationBody = JSON.parse(init.body);
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    body: sseStream([
                        {
                            id: 'x',
                            object: 'chat.completion.chunk',
                            created: 0,
                            model: 'big-pickle',
                            choices: [
                                { index: 0, delta: { content: ' continued' }, finish_reason: null }
                            ]
                        },
                        {
                            id: 'x',
                            object: 'chat.completion.chunk',
                            created: 0,
                            model: 'big-pickle',
                            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                        }
                    ])
                });
            });

        try {
            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    stream: true,
                    messages: [{ role: 'user', content: 'Hello' }]
                });

            expect(res.statusCode).toEqual(200);
            expect(global.fetch.mock.calls.length).toEqual(2);
            // The continuation turn carries segment 1's partial answer plus a
            // user nudge telling the model to resume seamlessly.
            expect(continuationBody.messages[continuationBody.messages.length - 2]).toEqual({
                role: 'assistant',
                content: 'partial answer'
            });
            expect(continuationBody.messages[continuationBody.messages.length - 1].role).toEqual(
                'user'
            );
            expect(
                continuationBody.messages[continuationBody.messages.length - 1].content
            ).toContain('cut off');
            const events = res.text
                .split('\n')
                .filter((l) => l.startsWith('data: '))
                .map((l) => l.slice(6));
            expect(events[events.length - 1]).toEqual('[DONE]');
            const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
            expect(
                chunks.filter((c) => c.choices?.[0]?.delta?.content === 'partial answer').length
            ).toEqual(1);
            expect(
                chunks.filter((c) => c.choices?.[0]?.delta?.content === ' continued').length
            ).toEqual(1);
            expect(chunks.some((c) => !!c.error)).toEqual(false);
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('POST /v1/responses with OPENCODE_TOOL_CALLING=agent runs through the server agent (explicit opt-in)', async () => {
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'agent';
        const client = createOpencodeClient();
        client.session.prompt.mockClear();
        client.session.create.mockClear();
        client.config.update.mockClear();
        try {
            const res = await request(app)
                .post('/v1/responses')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    input: 'create the file ./cat.txt with inside xx56',
                    tools: [{ type: 'function', function: { name: 'create_file' } }]
                });

            expect(res.statusCode).toEqual(200);
            expect(res.body.object).toEqual('response');
            // The explicit agent mode executed the request with the server
            // agent's own built-in tools (container-side).
            expect(client.session.prompt).toHaveBeenCalled();
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('POST /v1/chat/completions should stream tool_calls deltas', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: sseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: { role: 'assistant', content: null, reasoning_content: '' },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'call_1',
                                        type: 'function',
                                        function: { name: 'get_weather', arguments: '' }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [{ index: 0, function: { arguments: '{"city"' } }]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [{ index: 0, function: { arguments: ':"Rome"}' } }]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
                }
            ])
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather in Rome?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('"tool_calls"');
        expect(res.text).toContain('get_weather');
        expect(res.text).toContain('city');
        expect(res.text).toContain('"finish_reason":"tool_calls"');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions should strip images for text-only models (attachment: false)', async () => {
        const client = createOpencodeClient();
        client.config.providers.mockResolvedValueOnce({
            data: {
                providers: [
                    {
                        id: 'opencode',
                        options: { apiKey: 'public' },
                        models: {
                            'big-pickle': {
                                id: 'big-pickle',
                                api: { id: 'big-pickle', url: 'https://opencode.ai/zen/v1' },
                                attachment: false
                            }
                        }
                    }
                ]
            }
        });
        global.fetch.mockResolvedValue(
            nonStreamingFetchResponse({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'I cannot see images.' }
                    }
                ],
                usage: {}
            })
        );

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'What is in this image?' },
                            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
                        ]
                    }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(global.fetch.mock.calls.length).toEqual(1);
        const callArgs = JSON.parse(global.fetch.mock.calls[0][1].body);
        const content = callArgs.messages[0].content;
        expect(content.some((p) => p.type === 'image_url')).toEqual(false);
        expect(content.some((p) => p.type === 'text' && p.text.includes('Image attached'))).toEqual(
            true
        );
    });

    test('POST /v1/chat/completions should retry without images when upstream rejects image_url', async () => {
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            text: async () =>
                '{"error":{"message":"Error from provider (Console): Upstream request failed: [invalid_request_error] Failed to deserialize the JSON body into the target type: messages[0]: unknown variant `image_url`, expected `text`"}}'
        });
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'I cannot see images.' }
                    }
                ],
                usage: {}
            })
        );

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'What is in this image?' },
                            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
                        ]
                    }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(global.fetch.mock.calls.length).toEqual(2);
        const firstBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(firstBody.messages[0].content.some((p) => p.type === 'image_url')).toEqual(true);
        const secondBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        const content = secondBody.messages[0].content;
        expect(content.some((p) => p.type === 'image_url')).toEqual(false);
        expect(content.some((p) => p.type === 'text' && p.text.includes('Image attached'))).toEqual(
            true
        );
    });

    test('POST /v1/chat/completions should stream reasoning-only turns with clean content and proper termination', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: sseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: { reasoning_content: 'Thinking step one' },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                }
            ])
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Think about this' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        // Reasoning-only turns stream the deliberation via the dedicated
        // `reasoning_content` field; `content` must stay clean (no folded
        // thinking markers) and the stream must still terminate properly.
        expect(res.text).toContain('"reasoning_content":"Thinking step one"');
        expect(res.text).not.toContain('thinking\\n');
        expect(res.text).not.toContain('response\\n');
        const terminal = res.text
            .split('\n')
            .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
            .map((l) => JSON.parse(l.slice(6)))
            .find((c) => c.choices[0].finish_reason);
        expect(terminal.choices[0].finish_reason).toEqual('stop');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions should relay tool results back to the model', async () => {
        global.fetch.mockResolvedValue(
            nonStreamingFetchResponse({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'It is 25°C in Rome.' }
                    }
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
            })
        );

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'Weather in Rome?' },
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                            }
                        ]
                    },
                    { role: 'tool', tool_call_id: 'call_1', content: '{"temp":25}' }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].message.content).toEqual('It is 25°C in Rome.');

        const callArgs = JSON.parse(global.fetch.mock.calls[0][1].body);
        const roles = callArgs.messages.map((m) => m.role);
        expect(roles).toEqual(['user', 'assistant', 'tool']);
    });

    test('POST /v1/chat/completions should return 400 when no OpenAI-compatible endpoint is resolvable', async () => {
        const client = createOpencodeClient();
        client.config.providers.mockResolvedValueOnce({
            data: { providers: [{ id: 'acme', models: { 'some-model': {} } }] }
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'acme/some-model',
                messages: [{ role: 'user', content: 'Hello' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(400);
        expect(res.body.error.message).toContain('Tool calling is unavailable');
    });

    test('POST /v1/responses should not reject if tools is empty or tool_choice is none', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Test',
                tools: [],
                tool_choice: 'none'
            });

        expect(res.statusCode).toEqual(200);
    });

    test('POST /v1/chat/completions should not end stream on intermediate tool-calls finish', async () => {
        const client = createOpencodeClient();
        const sessionId = 'test-session-id';

        client.event.subscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_text',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Let me '
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_text',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Let me check the weather'
                        }
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'msg_assistant',
                            sessionID: sessionId,
                            role: 'assistant',
                            finish: 'tool-calls'
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_text',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Let me check the weather.'
                        }
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'msg_assistant',
                            sessionID: sessionId,
                            role: 'assistant',
                            finish: 'stop'
                        }
                    }
                };
            })()
        }));

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'What is the weather?' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('"content":"Let me "');
        expect(res.text).toContain('"content":"check the weather"');
        expect(res.text).toContain('"content":"."');
        expect(res.text).toContain('"finish_reason":"stop"');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses should not end stream on intermediate tool-calls finish', async () => {
        const client = createOpencodeClient();
        const sessionId = 'test-session-id';

        client.event.subscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_text',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Calling'
                        }
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'msg_assistant',
                            sessionID: sessionId,
                            role: 'assistant',
                            finish: 'tool-calls'
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_text',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Calling tool'
                        }
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'msg_assistant',
                            sessionID: sessionId,
                            role: 'assistant',
                            finish: 'stop'
                        }
                    }
                };
            })()
        }));

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Use the weather tool',
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        const deltas = res.text
            .split('\n\n')
            .filter((chunk) => chunk.includes('response.output_text.delta'))
            .join('');
        expect(deltas).toContain('"delta":"Calling"');
        expect(deltas).toContain('"delta":" tool"');
        expect(res.text).toContain('"type":"response.completed"');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions should not duplicate content when deltas and cumulative snapshots are both emitted', async () => {
        const client = createOpencodeClient();
        const sessionId = 'test-session-id';

        client.event.subscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_r',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'reasoning',
                            text: ''
                        }
                    }
                };
                yield {
                    type: 'message.part.delta',
                    properties: {
                        sessionID: sessionId,
                        partID: 'prt_r',
                        field: 'text',
                        delta: 'Think'
                    }
                };
                yield {
                    type: 'message.part.delta',
                    properties: {
                        sessionID: sessionId,
                        partID: 'prt_r',
                        field: 'text',
                        delta: 'ing'
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_r',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'reasoning',
                            text: 'Thinking'
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_t',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: ''
                        }
                    }
                };
                yield {
                    type: 'message.part.delta',
                    properties: {
                        sessionID: sessionId,
                        partID: 'prt_t',
                        field: 'text',
                        delta: 'Answer'
                    }
                };
                yield {
                    type: 'message.part.delta',
                    properties: { sessionID: sessionId, partID: 'prt_t', field: 'text', delta: '!' }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_t',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Answer!'
                        }
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'msg_assistant',
                            sessionID: sessionId,
                            role: 'assistant',
                            finish: 'stop'
                        }
                    }
                };
            })()
        }));

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Hello' }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect((res.text.match(/Think/g) || []).length).toEqual(1);
        expect((res.text.match(/Answer/g) || []).length).toEqual(1);
        expect(res.text).toContain('<think>');
        expect(res.text).toContain('</think>');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses should not duplicate content when deltas and cumulative snapshots are both emitted', async () => {
        const client = createOpencodeClient();
        const sessionId = 'test-session-id';

        client.event.subscribe.mockImplementationOnce(async () => ({
            stream: (async function* () {
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_r',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'reasoning',
                            text: ''
                        }
                    }
                };
                yield {
                    type: 'message.part.delta',
                    properties: {
                        sessionID: sessionId,
                        partID: 'prt_r',
                        field: 'text',
                        delta: 'Think'
                    }
                };
                yield {
                    type: 'message.part.delta',
                    properties: {
                        sessionID: sessionId,
                        partID: 'prt_r',
                        field: 'text',
                        delta: 'ing'
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_r',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'reasoning',
                            text: 'Thinking'
                        }
                    }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_t',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: ''
                        }
                    }
                };
                yield {
                    type: 'message.part.delta',
                    properties: {
                        sessionID: sessionId,
                        partID: 'prt_t',
                        field: 'text',
                        delta: 'Answer'
                    }
                };
                yield {
                    type: 'message.part.delta',
                    properties: { sessionID: sessionId, partID: 'prt_t', field: 'text', delta: '!' }
                };
                yield {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            id: 'prt_t',
                            messageID: 'msg_assistant',
                            sessionID: sessionId,
                            type: 'text',
                            text: 'Answer!'
                        }
                    }
                };
                yield {
                    type: 'message.updated',
                    properties: {
                        info: {
                            id: 'msg_assistant',
                            sessionID: sessionId,
                            role: 'assistant',
                            finish: 'stop'
                        }
                    }
                };
            })()
        }));

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Hello',
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        const deltaEvents = res.text
            .split('\n\n')
            .filter((line) => line.includes('response.output_text.delta'))
            .join('');
        expect(res.text).toContain('"type":"response.completed"');
        expect(res.text).toContain('data: [DONE]');
    });

    test('restoreFoldedReasoning splits folded  thinking/ response content back into reasoning_content', () => {
        const folded = {
            role: 'assistant',
            content: ' thinking\nUser wants the weather\n response\n\nChecking the weather...',
            tool_calls: [
                {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{}' }
                }
            ]
        };
        const restored = restoreFoldedReasoning([folded])[0];
        expect(restored.content).toEqual('Checking the weather...');
        expect(restored.reasoning_content).toEqual('User wants the weather');
    });

    test('restoreFoldedReasoning splits <think> HTML block back into reasoning_content (streaming tool shape)', () => {
        const folded = {
            role: 'assistant',
            content: '<think>\nUser wants the weather\n</think>\n\nChecking the weather...',
            tool_calls: [
                {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{}' }
                }
            ]
        };
        const restored = restoreFoldedReasoning([folded])[0];
        expect(restored.content).toEqual('Checking the weather...');
        expect(restored.reasoning_content).toEqual('User wants the weather');
    });

    test('restoreFoldedReasoning recovers reasoning-only tool-call turns (no response section)', () => {
        // The streaming tool path closes an unterminated <think> block but
        // writes no final content when the model only made a tool call.
        const folded = {
            role: 'assistant',
            content: '<think>\nLet me find the API\n</think>\n\n',
            tool_calls: [
                {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{}' }
                }
            ]
        };
        const restored = restoreFoldedReasoning([folded])[0];
        expect(restored.content).toEqual('');
        expect(restored.reasoning_content).toEqual('Let me find the API');
    });

    test('restoreFoldedReasoning prefers explicit reasoning_content and strips the folded copy', () => {
        const folded = {
            role: 'assistant',
            content: '<think>\nUser wants the weather\n</think>\n\nChecking...',
            reasoning_content: 'User wants the weather (explicit)',
            tool_calls: [
                {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{}' }
                }
            ]
        };
        const restored = restoreFoldedReasoning([folded])[0];
        expect(restored.content).toEqual('Checking...');
        expect(restored.reasoning_content).toEqual('User wants the weather (explicit)');
    });

    test('restoreFoldedReasoning leaves tool-call messages without think blocks untouched', () => {
        const plain = {
            role: 'assistant',
            content: 'Let me check the weather.',
            tool_calls: [
                {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{}' }
                }
            ]
        };
        const restored = restoreFoldedReasoning([plain])[0];
        expect(restored).toEqual(plain);
        expect(restored.reasoning_content).toBeUndefined();
    });

    test('restoreFoldedReasoning leaves ordinary assistant text untouched', () => {
        const normal = { role: 'assistant', content: 'Just a plain answer' };
        const restored = restoreFoldedReasoning([normal])[0];
        expect(restored).toEqual(normal);
    });

    test('POST /v1/chat/completions relay passes reasoning_content back to the model on tool continuation', async () => {
        global.fetch.mockResolvedValue(
            nonStreamingFetchResponse({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'It is 25°C in Rome.' }
                    }
                ],
                usage: {}
            })
        );

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'Weather in Rome?' },
                    {
                        role: 'assistant',
                        content: ' thinking\nUser wants the weather\n response\n\n',
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                            }
                        ]
                    },
                    { role: 'tool', tool_call_id: 'call_1', content: '{"temp":25}' }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(200);

        const callArgs = JSON.parse(global.fetch.mock.calls[0][1].body);
        const assistantMsg = callArgs.messages.find((m) => m.role === 'assistant');
        // Reasoning is echoed back as a dedicated field so the DeepSeek-style
        // thinking contract ("reasoning_content must be passed back") is met.
        expect(assistantMsg.reasoning_content).toEqual('User wants the weather');
        expect(assistantMsg.content).not.toContain(' thinking');
    });

    test('POST /v1/chat/completions relay recovers reasoning from <think> folded content (streaming tool shape)', async () => {
        // A client that only keeps the streamed <think>-wrapped content (and no
        // explicit reasoning_content) echoes it back verbatim on the tool
        // continuation. This is the exact shape the streaming tool path emits.
        global.fetch.mockResolvedValue(
            nonStreamingFetchResponse({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'It is 25°C in Rome.' }
                    }
                ],
                usage: {}
            })
        );

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'Weather in Rome?' },
                    {
                        role: 'assistant',
                        content: '<think>\nUser wants the weather\n</think>\n\n',
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                            }
                        ]
                    },
                    { role: 'tool', tool_call_id: 'call_1', content: '{"temp":25}' }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(200);

        const callArgs = JSON.parse(global.fetch.mock.calls[0][1].body);
        const assistantMsg = callArgs.messages.find((m) => m.role === 'assistant');
        expect(assistantMsg.reasoning_content).toEqual('User wants the weather');
        expect(assistantMsg.content).not.toContain('<think>');
    });

    test('POST /v1/chat/completions strips images for deepseek-family models even without explicit attachment config', async () => {
        const client = createOpencodeClient();
        client.config.providers.mockResolvedValueOnce({
            data: {
                providers: [
                    {
                        id: 'opencodebackend',
                        options: { apiKey: 'public' },
                        models: {
                            'deepseek-v4-flash-free': {
                                id: 'deepseek-v4-flash-free',
                                api: {
                                    id: 'deepseek-v4-flash-free',
                                    url: 'https://backend.example/v1'
                                }
                            }
                        }
                    }
                ]
            }
        });
        global.fetch.mockResolvedValue(
            nonStreamingFetchResponse({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: 0,
                model: 'deepseek-v4-flash-free',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'I cannot see images.' }
                    }
                ],
                usage: {}
            })
        );

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencodebackend/deepseek-v4-flash-free',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'What is in this image?' },
                            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
                        ]
                    }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(global.fetch.mock.calls.length).toEqual(1);
        const callArgs = JSON.parse(global.fetch.mock.calls[0][1].body);
        const content = callArgs.messages[0].content;
        expect(content.some((p) => p.type === 'image_url')).toEqual(false);
        expect(content.some((p) => p.type === 'text' && p.text.includes('Image attached'))).toEqual(
            true
        );
    });

    test('POST /v1/chat/completions retries with forced reasoning extraction when upstream rejects folded reasoning', async () => {
        // A client echoes a think block the normal restore does not recognise
        // (mixed-case <Think> tags). The first upstream call rejects with the
        // DeepSeek reasoning_content error; the proxy must retry once after
        // force-extracting reasoning_content from the tool-call message.
        global.fetch.mockResolvedValueOnce({
            ok: false,
            status: 400,
            text: async () =>
                '{"error":{"message":"The reasoning_content in the thinking mode must be passed back to the API."}}'
        });
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'It is 25°C in Rome.' }
                    }
                ],
                usage: {}
            })
        );

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'Weather in Rome?' },
                    {
                        role: 'assistant',
                        content: '<Think>\nUser wants the weather\n</Think>',
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                            }
                        ]
                    },
                    { role: 'tool', tool_call_id: 'call_1', content: '{"temp":25}' }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(global.fetch.mock.calls.length).toEqual(2);
        const retryBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        const assistantMsg = retryBody.messages.find((m) => m.role === 'assistant');
        expect(assistantMsg.reasoning_content).toEqual('User wants the weather');
        expect(assistantMsg.content).not.toContain('Think');
    });

    test('POST /v1/chat/completions surfaces a reasoning hint in the 502 when upstream rejects reasoning_content', async () => {
        global.fetch.mockResolvedValue({
            ok: false,
            status: 400,
            text: async () =>
                '{"error":{"message":"The reasoning_content in the thinking mode must be passed back to the API."}}'
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'Weather in Rome?' },
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                            }
                        ]
                    },
                    { role: 'tool', tool_call_id: 'call_1', content: '{"temp":25}' }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(502);
        // No folded reasoning to recover (content is empty), so no retry.
        expect(global.fetch.mock.calls.length).toEqual(1);
        expect(res.body.error.details).toContain('reasoning_content');
        expect(res.body.error.details).toContain('must echo the assistant tool_calls message');
    });

    test('POST /v1/responses should replay assistant tool_calls when a continuation mixes tool output with a new user message', async () => {
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: '',
                            tool_calls: [
                                {
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                                }
                            ]
                        }
                    }
                ],
                usage: {}
            })
        );
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Done.' }
                    }
                ],
                usage: {}
            })
        );

        const first = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'What is the weather in Rome?',
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });
        expect(first.statusCode).toEqual(200);
        expect(first.body.output[0].type).toEqual('function_call');

        const second = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                previous_response_id: first.body.id,
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                input: [
                    { type: 'function_call_output', call_id: 'call_1', output: '{"temp":25}' },
                    {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: 'Now summarize' }]
                    }
                ]
            });

        expect(second.statusCode).toEqual(200);
        const contBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        const roles = contBody.messages.map((m) => m.role);
        // The stored assistant tool_calls message must be replayed even though
        // the continuation also carries a fresh user message.
        expect(roles).toEqual(['user', 'assistant', 'tool', 'user']);
        expect(contBody.messages[1].tool_calls[0].id).toEqual('call_1');
    });

    test('POST /v1/responses should merge function_call + assistant message items into one tool_calls message (Codex continuation shape)', async () => {
        // Codex serializes an assistant turn that made a tool call as a
        // `function_call` item followed by a separate `message` item carrying
        // the turn text, then the `function_call_output` item(s). If the proxy
        // converts those into two assistant messages, the upstream (DeepSeek
        // thinking mode) rejects the continuation with "An assistant message
        // with 'tool_calls' must be followed by tool messages". The proxy must
        // merge them so the tool_calls message is immediately followed by the
        // tool result.
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Sunny in Rome.' }
                    }
                ],
                usage: {}
            })
        );

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                tools: [
                    {
                        type: 'function',
                        name: 'get_weather',
                        description: 'Get weather',
                        parameters: { type: 'object', properties: { city: { type: 'string' } } }
                    }
                ],
                input: [
                    {
                        type: 'message',
                        role: 'developer',
                        content: [{ type: 'input_text', text: 'You are Codex.' }]
                    },
                    {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: 'What is the weather in Rome?' }]
                    },
                    {
                        type: 'function_call',
                        call_id: 'call_1',
                        name: 'get_weather',
                        arguments: '{"city":"Rome"}'
                    },
                    {
                        type: 'message',
                        role: 'assistant',
                        content: [
                            {
                                type: 'output_text',
                                text: '<think>\nNeed the weather for Rome.\n</think>\n\nLet me check the weather.'
                            }
                        ]
                    },
                    { type: 'function_call_output', call_id: 'call_1', output: '{"temp":25}' }
                ]
            });

        expect(res.statusCode).toEqual(200);

        const upstreamBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        const roles = upstreamBody.messages.map((m) => m.role);
        // One merged assistant tool-call message directly followed by the tool
        // result: no stray second assistant message between them.
        expect(roles).toEqual(['user', 'user', 'assistant', 'tool']);

        const assistantMsg = upstreamBody.messages[2];
        expect(assistantMsg.tool_calls).toHaveLength(1);
        expect(assistantMsg.tool_calls[0].id).toEqual('call_1');
        expect(assistantMsg.tool_calls[0].function.name).toEqual('get_weather');
        // The think block is restored as the dedicated reasoning_content field
        // (DeepSeek thinking contract) and stripped from content.
        expect(assistantMsg.reasoning_content).toContain('Need the weather for Rome');
        expect(assistantMsg.content).toContain('Let me check the weather');
        expect(assistantMsg.content).not.toContain('<think>');

        expect(upstreamBody.messages[3].role).toEqual('tool');
        expect(upstreamBody.messages[3].tool_call_id).toEqual('call_1');
    });

    test('POST /v1/responses should merge parallel function_calls + one assistant message into a single tool_calls message', async () => {
        // Codex can request several parallel tool calls in one turn: multiple
        // `function_call` items, one assistant `message` item, then multiple
        // `function_call_output` items. All must collapse into a single
        // assistant message with all tool_calls, immediately followed by the
        // tool results.
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Both done.' }
                    }
                ],
                usage: {}
            })
        );

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                tools: [{ type: 'function', name: 'get_weather' }],
                input: [
                    { type: 'message', role: 'user', content: 'Weather in Rome and Milan?' },
                    {
                        type: 'function_call',
                        call_id: 'call_1',
                        name: 'get_weather',
                        arguments: '{"city":"Rome"}'
                    },
                    {
                        type: 'function_call',
                        call_id: 'call_2',
                        name: 'get_weather',
                        arguments: '{"city":"Milan"}'
                    },
                    { type: 'message', role: 'assistant', content: 'I will check both cities.' },
                    { type: 'function_call_output', call_id: 'call_1', output: '{"temp":25}' },
                    { type: 'function_call_output', call_id: 'call_2', output: '{"temp":28}' }
                ]
            });

        expect(res.statusCode).toEqual(200);

        const upstreamBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        const roles = upstreamBody.messages.map((m) => m.role);
        expect(roles).toEqual(['user', 'assistant', 'tool', 'tool']);

        const assistantMsg = upstreamBody.messages[1];
        expect(assistantMsg.tool_calls).toHaveLength(2);
        expect(assistantMsg.tool_calls.map((tc) => tc.id)).toEqual(['call_1', 'call_2']);
        expect(assistantMsg.content).toEqual('I will check both cities.');
        expect(upstreamBody.messages[2].tool_call_id).toEqual('call_1');
        expect(upstreamBody.messages[3].tool_call_id).toEqual('call_2');
    });

    test('POST /v1/chat/completions streaming with tools should synthesize finish_reason when the upstream omits it', async () => {
        // Some upstreams close the SSE with [DONE] (or abort) without a
        // terminal finish_reason chunk; strict clients then fail with
        // "Stream ended without finish_reason". The proxy must emit a terminal
        // chunk carrying finish_reason stop before [DONE].
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: sseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }]
                }
            ])
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Hi' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        // The streamed content delta must have finish_reason null, but the
        // proxy-added terminal chunk must carry finish_reason stop.
        expect(res.text).toContain('"delta":{"content":"Hello"}');
        expect(res.text.match(/"finish_reason":"stop"/g) || []).toHaveLength(1);
        // No synthetic delta-only tail chunk without finish_reason.
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions should re-inject remembered reasoning on a tool continuation that dropped it', async () => {
        // Round 1: the upstream produces a tool_calls turn WITH reasoning; the
        // proxy relays it and remembers the reasoning keyed by the call id.
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: '',
                            reasoning_content: 'Need the city and units',
                            tool_calls: [
                                {
                                    id: 'tool_memo_1',
                                    type: 'function',
                                    function: { name: 'get_weather', arguments: '{}' }
                                }
                            ]
                        }
                    }
                ],
                usage: {}
            })
        );
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Done.' }
                    }
                ],
                usage: {}
            })
        );

        const first = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });
        expect(first.statusCode).toEqual(200);
        expect(first.body.choices[0].message.tool_calls[0].id).toEqual('tool_memo_1');

        // Round 2: the client echoes the assistant tool_calls message but drops
        // reasoning_content entirely (content ''). The proxy must re-inject the
        // remembered reasoning before calling the upstream, otherwise DeepSeek
        // thinking mode rejects the continuation with a 400.
        const second = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'Weather?' },
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [
                            {
                                id: 'tool_memo_1',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '{}' }
                            }
                        ]
                    },
                    { role: 'tool', tool_call_id: 'tool_memo_1', content: '{"temp":25}' }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(second.statusCode).toEqual(200);
        const continuationBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        const assistantMsg = continuationBody.messages.find((m) => m.role === 'assistant');
        expect(assistantMsg.reasoning_content).toEqual('Need the city and units');
    });

    test('POST /v1/chat/completions should remember streamed reasoning and re-inject it on the next tool turn', async () => {
        // Round 1 streams reasoning_content + tool_calls; the proxy must
        // remember the reasoning for the call id and use it for the
        // continuation in round 2.
        global.fetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            body: sseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: { reasoning_content: 'Looking up the weather' },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'tool_memo_s',
                                        type: 'function',
                                        function: { name: 'get_weather', arguments: '{}' }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
                }
            ])
        });
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'It is sunny.' }
                    }
                ],
                usage: {}
            })
        );

        const first = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });
        expect(first.statusCode).toEqual(200);
        expect(first.text).toContain('"finish_reason":"tool_calls"');

        const second = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'Weather?' },
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [
                            {
                                id: 'tool_memo_s',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '{}' }
                            }
                        ]
                    },
                    { role: 'tool', tool_call_id: 'tool_memo_s', content: '{"temp":25}' }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });
        expect(second.statusCode).toEqual(200);
        const continuationBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        const assistantMsg = continuationBody.messages.find((m) => m.role === 'assistant');
        expect(assistantMsg.reasoning_content).toEqual('Looking up the weather');
        expect(assistantMsg.content).not.toContain(' thinking');
    });

    test('POST /v1/chat/completions should synthesize finish_reason tool_calls when tool deltas were streamed without a terminal finish', async () => {
        // The upstream closes with [DONE] after streaming reasoning + tool
        // calls but never emits a finish_reason chunk. The synthesized
        // terminal chunk must carry tool_calls (not stop) so the client does
        // not mistake the turn for a completed text answer, and the reasoning
        // must still be remembered for the continuation.
        global.fetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            body: sseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: { reasoning_content: 'Checking the sky' },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'tool_memo_fr',
                                        type: 'function',
                                        function: { name: 'get_weather', arguments: '{}' }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                }
            ])
        });
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Sunny.' }
                    }
                ],
                usage: {}
            })
        );

        const first = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });
        expect(first.statusCode).toEqual(200);
        // The synthesized terminal chunk uses tool_calls, not stop.
        expect(first.text).toContain('"finish_reason":"tool_calls"');
        expect(first.text).not.toContain('"finish_reason":"stop"');
        expect(first.text).not.toContain('"error"');

        const second = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'Weather?' },
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [
                            {
                                id: 'tool_memo_fr',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '{}' }
                            }
                        ]
                    },
                    { role: 'tool', tool_call_id: 'tool_memo_fr', content: '{"temp":25}' }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });
        expect(second.statusCode).toEqual(200);
        const continuationBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        const assistantMsg = continuationBody.messages.find((m) => m.role === 'assistant');
        expect(assistantMsg.reasoning_content).toEqual('Checking the sky');
    });

    test('POST /v1/chat/completions should not re-inject remembered reasoning when the echoed tool call has a different signature', async () => {
        // A provider may reuse a call id across conversations (e.g. sequential
        // call_1 ids). The memory must not leak reasoning into a continuation
        // whose tool call does not match the remembered endpoint/tool.
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: '',
                            reasoning_content: 'Secret A',
                            tool_calls: [
                                {
                                    id: 'collide_1',
                                    type: 'function',
                                    function: { name: 'get_weather', arguments: '{}' }
                                }
                            ]
                        }
                    }
                ],
                usage: {}
            })
        );
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Done.' }
                    }
                ],
                usage: {}
            })
        );

        const first = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });
        expect(first.statusCode).toEqual(200);

        // Same call id, but a different function name: the remembered reasoning
        // must NOT be attached to the assistant message sent upstream.
        const second = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'Weather?' },
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [
                            {
                                id: 'collide_1',
                                type: 'function',
                                function: { name: 'get_humidity', arguments: '{}' }
                            }
                        ]
                    },
                    { role: 'tool', tool_call_id: 'collide_1', content: '{"hum":55}' }
                ],
                tools: [{ type: 'function', function: { name: 'get_humidity' } }]
            });

        expect(second.statusCode).toEqual(200);
        const continuationBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        const assistantMsg = continuationBody.messages.find((m) => m.role === 'assistant');
        expect(assistantMsg.reasoning_content).toBeUndefined();
    });

    test('POST /v1/chat/completions should re-inject remembered reasoning when arguments differ only in key order', async () => {
        // Clients may re-serialize function arguments with a different key
        // order; the memory match must be tolerant of that.
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: '',
                            reasoning_content: 'Need city and units',
                            tool_calls: [
                                {
                                    id: 'memo_k',
                                    type: 'function',
                                    function: {
                                        name: 'get_weather',
                                        arguments: '{"city":"Rome","units":"c"}'
                                    }
                                }
                            ]
                        }
                    }
                ],
                usage: {}
            })
        );
        global.fetch.mockResolvedValueOnce(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Warm.' }
                    }
                ],
                usage: {}
            })
        );

        const first = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });
        expect(first.statusCode).toEqual(200);

        const second = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    { role: 'user', content: 'Weather?' },
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [
                            {
                                id: 'memo_k',
                                type: 'function',
                                function: {
                                    name: 'get_weather',
                                    arguments: '{"units":"c","city":"Rome"}'
                                }
                            }
                        ]
                    },
                    { role: 'tool', tool_call_id: 'memo_k', content: '{"temp":25}' }
                ],
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(second.statusCode).toEqual(200);
        const continuationBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        const assistantMsg = continuationBody.messages.find((m) => m.role === 'assistant');
        expect(assistantMsg.reasoning_content).toEqual('Need city and units');
    });

    test('POST /v1/chat/completions should flag a truncated upstream stream with an error instead of a happy stop', async () => {
        // The upstream body errors mid-stream after tool deltas (no finish, no
        // [DONE]). The proxy must still send a well-formed terminal chunk with
        // a finish_reason, but it must also flag the chunk with an error so
        // the client can retry instead of believing the turn completed.
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: errorSseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: { reasoning_content: 'Thinking about weather' },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'tool_memo_er',
                                        type: 'function',
                                        function: { name: 'get_weather', arguments: '{}' }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                }
            ])
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('"finish_reason":"tool_calls"');
        expect(res.text).toContain(
            '"error":{"message":"Upstream stream ended unexpectedly without a terminal finish_reason"}'
        );
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses should mark the response incomplete when the upstream stream is truncated', async () => {
        // The upstream body errors mid-stream after a content delta: the
        // streamed response must end with an incomplete status and an error,
        // not a fake completed response.
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: errorSseStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [{ index: 0, delta: { content: 'Partial' }, finish_reason: null }]
                }
            ])
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Hello',
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('"status":"incomplete"');
        expect(res.text).toContain(
            '"error":{"message":"Upstream stream ended unexpectedly without a terminal response"}'
        );
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions must not flag a clean EOF without [DONE] as an error', async () => {
        // Some upstreams simply close the connection (EOF) after the last chunk
        // instead of sending [DONE] or a terminal finish_reason chunk. That is
        // a normal completion, so the proxy must synthesize the terminal
        // finish_reason WITHOUT the truncation error flag.
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: eofStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: { reasoning_content: 'Thinking about weather' },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'call_1',
                                        type: 'function',
                                        function: { name: 'get_weather', arguments: '{}' }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                }
            ])
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        // Synthesized terminal reason must be present...
        expect(res.text).toContain('"finish_reason":"tool_calls"');
        // ...but NOT flagged as a truncation error.
        expect(res.text).not.toContain(
            'Upstream stream ended unexpectedly without a terminal finish_reason'
        );
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions must flag tool-call arguments cut off mid-JSON even on a clean EOF', async () => {
        // Free-tier upstreams often drop the connection BETWEEN chunks without
        // a read error: consumeUpstreamSSE reports a "clean" EOF, but the
        // accumulated tool-call arguments do not parse. The proxy must still
        // flag the turn as truncated instead of letting the client execute a
        // half-written tool call.
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: eofStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: { reasoning_content: 'Thinking about weather' },
                            finish_reason: null
                        }
                    ]
                },
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'call_trunc',
                                        type: 'function',
                                        function: { name: 'get_weather', arguments: '{"city":"Rom' }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                }
            ])
        });

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        // Synthesized terminal reason must be present, flagged as truncated so
        // clients do not execute the half-written tool call...
        expect(res.text).toContain('"finish_reason":"truncated"');
        expect(res.text).toContain(
            '"error":{"message":"Upstream stream ended before the tool call arguments were complete"}'
        );
        // Nothing usable was completed before the drop, so no second attempt
        // may be started (it would duplicate the already-streamed deltas).
        expect(global.fetch.mock.calls.length).toEqual(1);
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions retries reasoning-only attempts invisibly (thinking stays buffered)', async () => {
        // Reasoning deltas are buffered until real output arrives. An attempt
        // that dies while only thinking has been produced forwards nothing, so
        // it can be retried cleanly - no duplicate deliberation ever reaches
        // the client.
        global.fetch.mockImplementation(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                body: eofStream([
                    {
                        id: 'x',
                        object: 'chat.completion.chunk',
                        created: 0,
                        model: 'big-pickle',
                        choices: [
                            {
                                index: 0,
                                delta: { reasoning_content: 'Thinking about weather' },
                                finish_reason: null
                            }
                        ]
                    }
                ])
            })
        );

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        // All three attempts ran...
        expect(global.fetch.mock.calls.length).toEqual(3);
        // ...but none of their thinking reached the wire.
        expect(res.text.includes('Thinking about weather')).toEqual(false);
        const events = res.text
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6));
        expect(events[events.length - 1]).toEqual('[DONE]');
        const terminal = JSON.parse(events[events.length - 2]);
        expect(terminal.choices[0].finish_reason).toEqual('stop');
        expect(terminal.error.message).toContain('Upstream stream ended before content');
    });

    test('zen-direct must flag tool-call arguments cut off mid-JSON even on a clean EOF', async () => {
        const originalMode = process.env.OPENCODE_TOOL_CALLING;
        process.env.OPENCODE_TOOL_CALLING = 'auto';
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: eofStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: 'call_zen_t',
                                        type: 'function',
                                        function: {
                                            name: 'write',
                                            arguments: '{"path":"/tmp/x","content":"hel'
                                        }
                                    }
                                ]
                            },
                            finish_reason: null
                        }
                    ]
                }
            ])
        });

        try {
            const res = await request(app)
                .post('/v1/chat/completions')
                .set('Authorization', 'Bearer test-password')
                .send({
                    model: 'opencode/big-pickle',
                    messages: [{ role: 'user', content: 'Write the file' }],
                    tools: [{ type: 'function', function: { name: 'write' } }],
                    stream: true
                });

            expect(res.statusCode).toEqual(200);
            expect(res.text).toContain('"finish_reason":"truncated"');
            expect(res.text).toContain(
                '"error":{"message":"Upstream stream ended before the tool call arguments were complete"}'
            );
            expect(global.fetch.mock.calls.length).toEqual(1);
            expect(res.text).toContain('data: [DONE]');
        } finally {
            process.env.OPENCODE_TOOL_CALLING = originalMode || 'direct';
        }
    });

    test('POST /v1/responses must not mark a clean EOF without [DONE] as incomplete', async () => {
        // Same contract for the Responses API: a clean EOF after content is a
        // normal completion, not a truncation.
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: eofStream([
                {
                    id: 'x',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'big-pickle',
                    choices: [
                        {
                            index: 0,
                            delta: { content: 'All done', reasoning_content: 'Thinking' },
                            finish_reason: null
                        }
                    ]
                }
            ])
        });

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Hello',
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(res.text).toContain('"status":"completed"');
        expect(res.text).not.toContain('"status":"incomplete"');
        expect(res.text).not.toContain(
            'Upstream stream ended unexpectedly without a terminal response'
        );
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/chat/completions should surface the real upstream error when all stream attempts fail to start', async () => {
        // The upstream rejects every attempt with a 429 rate limit before any
        // bytes are streamed. The client must receive the actual cause (with
        // type/code) instead of the generic "stream ended unexpectedly" flag.
        const rateLimitError = new Error(
            'Model API error (429): {"type":"error","error":{"type":"FreeUsageLimitError","message":"Error from provider (Console): Rate limit exceeded. Please try again later."}}'
        );
        global.fetch.mockRejectedValue(rateLimitError);

        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'Weather?' }],
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(global.fetch.mock.calls).toHaveLength(3);
        expect(res.text).toContain(
            '"error":{"message":"Error from provider (Console): Rate limit exceeded. Please try again later.","type":"FreeUsageLimitError","code":429}'
        );
        expect(res.text).not.toContain(
            'Upstream stream ended unexpectedly without a terminal finish_reason'
        );
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses should surface the real upstream error when all stream attempts fail to start', async () => {
        // Same contract for the Responses API: the incomplete response must
        // carry the real upstream cause (429 rate limit) so the client can
        // tell the user what went wrong.
        const rateLimitError = new Error(
            'Model API error (429): {"type":"error","error":{"type":"FreeUsageLimitError","message":"Error from provider (Console): Rate limit exceeded. Please try again later."}}'
        );
        global.fetch.mockRejectedValue(rateLimitError);

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Hello',
                tools: [{ type: 'function', function: { name: 'get_weather' } }],
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        expect(global.fetch.mock.calls).toHaveLength(3);
        expect(res.text).toContain('"status":"incomplete"');
        expect(res.text).toContain(
            '"error":{"message":"Error from provider (Console): Rate limit exceeded. Please try again later.","type":"FreeUsageLimitError","code":429}'
        );
        expect(res.text).not.toContain('Upstream stream ended without a terminal response');
        expect(res.text).toContain('data: [DONE]');
    });

    test('POST /v1/responses should accept stateless function_call + function_call_output replay without tools or previous_response_id', async () => {
        global.fetch.mockResolvedValue(
            nonStreamingFetchResponse({
                id: 'chatcmpl-2',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'Rome is sunny.' }
                    }
                ],
                usage: {}
            })
        );

        // A stateless client replays the whole tool loop in a single request:
        // assistant function_call item, the turn text message, then the tool
        // result. No tools array and no previous_response_id - the history is
        // fully reconstructible from the input itself, so the proxy must not
        // reject it with the orphaned-output error.
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: [
                    { type: 'message', role: 'user', content: 'What is the weather in Rome?' },
                    {
                        type: 'function_call',
                        call_id: 'call_1',
                        name: 'get_weather',
                        arguments: '{"city":"Rome"}'
                    },
                    {
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'Let me check.' }]
                    },
                    { type: 'function_call_output', call_id: 'call_1', output: '{"temp":25}' }
                ]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.output[0].type).toEqual('message');
        expect(res.body.output[0].content[0].text).toContain('sunny');

        const upstreamBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        const roles = upstreamBody.messages.map((m) => m.role);
        expect(roles).toEqual(['user', 'assistant', 'tool']);
        expect(upstreamBody.messages[1].tool_calls[0].id).toEqual('call_1');
        expect(upstreamBody.messages[1].tool_calls[0].function.name).toEqual('get_weather');
        expect(upstreamBody.messages[2].tool_call_id).toEqual('call_1');
        // Minimal tool definitions are derived from the function_call names so
        // strict upstreams accept the tool-role messages without a tools array.
        expect(upstreamBody.tools).toHaveLength(1);
        expect(upstreamBody.tools[0].function.name).toEqual('get_weather');
    });

    test('POST /v1/responses should surface reasoning as its own output item instead of folding it into message text', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Answer with reasoning'
            });

        expect(res.statusCode).toEqual(200);
        const types = res.body.output.map((o) => o.type);
        expect(types).toEqual(['reasoning', 'message']);
        expect(res.body.output[0].content[0].text).toContain('Thinking process');
        expect(res.body.output[1].content[0].text).toEqual('Simulated response');
        expect(res.body.output_text).toEqual('Simulated response');
        // No proxy  thinking/ response folded marker leaks into the client-visible text.
        expect(JSON.stringify(res.body)).not.toContain(' thinking');
        expect(JSON.stringify(res.body)).not.toContain('\\n response\\n');
    });

    test('POST /v1/responses streaming should stream reasoning as a dedicated item, not folded into output_text', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Hello',
                stream: true
            });

        expect(res.statusCode).toEqual(200);
        // Reasoning travels through its own item events...
        expect(res.text).toContain('"type":"response.reasoning_text.delta"');
        expect(res.text).toContain('"type":"reasoning"');
        // ...and never leaks  thinking/ response markup into the answer text.
        const textDeltas = res.text
            .split('\n\n')
            .filter((e) => e.includes('response.output_text.delta'))
            .join('');
        expect(textDeltas).not.toContain('thinking');
        expect(textDeltas).toContain('"delta":"Simulated');

        // The completed event carries the reasoning item before the message.
        const completedLine = res.text
            .split('\n')
            .find((line) => line.includes('"type":"response.completed"'));
        expect(completedLine).toBeTruthy();
        const completed = JSON.parse(completedLine.replace(/^data: /, ''));
        const types = completed.response.output.map((o) => o.type);
        expect(types).toEqual(['reasoning', 'message']);
        expect(completed.response.output[1].content[0].text).toEqual('Simulated response');
    });

    test('POST /v1/responses should emit a reasoning output item before function_call on reasoning tool turns', async () => {
        global.fetch.mockResolvedValue(
            nonStreamingFetchResponse({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            content: 'Let me check the weather',
                            reasoning_content: 'Need the weather for Rome',
                            tool_calls: [
                                {
                                    id: 'call_1',
                                    type: 'function',
                                    function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
                                }
                            ]
                        }
                    }
                ],
                usage: {}
            })
        );

        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                input: 'Weather in Rome?',
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });

        expect(res.statusCode).toEqual(200);
        expect(res.body.finish_reason).toEqual('tool_calls');
        const types = res.body.output.map((o) => o.type);
        expect(types).toEqual(['reasoning', 'function_call']);
        expect(res.body.output[0].content[0].text).toContain('Need the weather for Rome');
        expect(res.body.output[1].call_id).toEqual('call_1');
        // Raw  thinking/ response folded marker never leaks into the serialized response.
        expect(JSON.stringify(res.body)).not.toContain(' thinking');
        expect(JSON.stringify(res.body)).not.toContain('\\n response\\n');
    });
});
