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
                { type: 'session.text.delta', data: { sessionID: sid, delta: 'Simulated' } },
                { type: 'session.text.delta', data: { sessionID: sid, delta: ' response' } },
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

describe('Image handling (fetch-based)', () => {
    const originalFetch = global.fetch;
    beforeEach(() => {
        process.env.OPENCODE_SERVER_PASSWORD = 'test-password';
        global.fetch = jest.fn();
    });
    afterAll(() => {
        global.fetch = originalFetch;
    });

    test('supports data: URI without fetching', async () => {
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'hi' },
                            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
                        ]
                    }
                ]
            });
        expect(res.statusCode).toEqual(200);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('fetches public image via fetch (proxy-aware) and respects size limit', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
            arrayBuffer: async () => new TextEncoder().encode('fake').buffer
        });
        const res = await request(app)
            .post('/v1/chat/completions')
            .set('Authorization', 'Bearer test-password')
            .send({
                model: 'opencode/big-pickle',
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'hi' },
                            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }
                        ]
                    }
                ]
            });
        expect(res.statusCode).toEqual(200);
        expect(global.fetch.mock.calls[0][0]).toEqual('https://example.com/a.png');
    });

    test('refuses private IP without network call', async () => {
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
                            { type: 'text', text: 'hi' },
                            { type: 'image_url', image_url: { url: 'http://10.0.0.1/secret' } }
                        ]
                    }
                ]
            });
        expect(res.statusCode).toEqual(200);
        expect(global.fetch).not.toHaveBeenCalledWith('http://10.0.0.1/secret', expect.anything());
    });
});
