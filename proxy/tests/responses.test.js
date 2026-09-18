process.env.OPENCODE_TOOL_CALLING = 'direct';
import request from 'supertest';
import { jest } from '@jest/globals';

jest.unstable_mockModule('../v2-client.ts', () => {
    const client = {
        createSession: jest.fn(async () => ({ data: { id: 'test-session-id' } })),
        prompt: jest.fn(async () => ({
            data: { parts: [{ type: 'text', text: 'Simulated response' }] }
        })),
        switchModel: jest.fn(async () => {}),
        getProviderGatewayInfo: jest.fn(async () => ({
            baseUrl: 'https://opencode.ai/zen/v1',
            apiKey: null,
            modelId: 'big-pickle',
            supportsImages: undefined
        })),
        getProvidersAndModels: jest.fn(async () => ({
            providers: [
                {
                    id: 'opencode',
                    settings: { apiKey: 'public', baseURL: 'https://opencode.ai/zen/v1' }
                }
            ],
            models: [
                {
                    id: 'big-pickle',
                    modelID: 'big-pickle',
                    providerID: 'opencode',
                    name: 'Big Pickle',
                    family: 'big-pickle',
                    package: '@opencode/ai/providers/openai',
                    settings: { apiKey: 'public', baseURL: 'https://opencode.ai/zen/v1' }
                }
            ]
        })),
        subscribeEvents: jest.fn(async () => {
            const sid = 'test-session-id';
            const events = [
                { type: 'session.text.delta', data: { sessionID: sid, delta: 'Hi' } },
                { type: 'session.step.ended', data: { sessionID: sid, finish: 'stop' } }
            ];
            const encoder = new TextEncoder();
            const sseData = events.map((e) => `data: ${JSON.stringify(e)}`).join('\n\n') + '\n\n';
            return new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(sseData));
                    controller.close();
                }
            });
        }),
        authHeader: ''
    };
    return {
        getV2Client: jest.fn(() => client),
        clientAbortSignal: jest.fn(() => new AbortController().signal)
    };
});

const { default: app } = await import('../app.ts');

function nonStreaming(data) {
    return { ok: true, status: 200, json: async () => data };
}

describe('Responses API (modular)', () => {
    const orig = global.fetch;
    beforeEach(() => {
        process.env.OPENCODE_SERVER_PASSWORD = 'test-password';
        global.fetch = jest.fn();
    });
    afterAll(() => {
        global.fetch = orig;
    });

    test('non-streaming returns response object', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({ model: 'opencode/big-pickle', input: 'Hello' });
        expect(res.statusCode).toEqual(200);
        expect(res.body.object).toEqual('response');
        expect(res.body.status).toEqual('completed');
    });

    test('streams', async () => {
        const res = await request(app)
            .post('/v1/responses')
            .set('Authorization', 'Bearer test-password')
            .send({ model: 'opencode/big-pickle', input: 'Hello', stream: true });
        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('data: [DONE]');
    });

    test('tool calling returns function_call', async () => {
        global.fetch.mockResolvedValue(
            nonStreaming({
                id: 'x',
                object: 'chat.completion',
                created: 0,
                model: 'big-pickle',
                choices: [
                    {
                        index: 0,
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            tool_calls: [
                                {
                                    id: 'c1',
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
                input: 'Weather?',
                tools: [{ type: 'function', function: { name: 'get_weather' } }]
            });
        expect(res.statusCode).toEqual(200);
        expect(res.body.output[0].type).toEqual('function_call');
    });
});
