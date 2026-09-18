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
const { clearProviderCache } = await import('../model-gateway.ts');

function nonStreaming(data) {
    return { ok: true, status: 200, json: async () => data };
}

describe('Chat completions (modular)', () => {
    const origFetch = global.fetch;
    beforeEach(() => {
        process.env.OPENCODE_SERVER_PASSWORD = 'test-password';
        global.fetch = jest.fn();
        clearProviderCache();
    });
    afterAll(() => {
        global.fetch = origFetch;
    });

    test('rejects malformed model', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({ model: 'bad', messages: [{ role: 'user', content: 'hi' }] });
        expect(res.statusCode).toEqual(400);
    });

    test('streams', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [{ role: 'user', content: 'hi' }],
                stream: true
            });
        expect(res.statusCode).toEqual(200);
        expect(res.header['content-type']).toContain('text/event-stream');
        expect(res.text).toContain('data: [DONE]');
    });

    test('routes tool_choice via direct gateway', async () => {
        global.fetch.mockResolvedValueOnce(
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
                messages: [{ role: 'user', content: 'weather?' }],
                tool_choice: { type: 'function', function: { name: 'get_weather' } }
            });
        expect(res.statusCode).toEqual(200);
        expect(res.body.choices[0].finish_reason).toEqual('tool_calls');
    });
});
