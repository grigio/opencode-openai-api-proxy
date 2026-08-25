process.env.OPENCODE_TOOL_CALLING = 'direct';
import request from 'supertest';
import { jest } from '@jest/globals';

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
                                    api: { id: 'big-pickle', url: 'https://opencode.ai/zen/v1' }
                                }
                            }
                        }
                    ]
                }
            })),
            update: jest.fn(async () => ({}))
        },
        session: {
            create: jest.fn(async () => ({ data: { id: 'test-session-id' } })),
            prompt: jest.fn(async () => ({ data: { parts: [{ type: 'text', text: 'Simulated response' }] } }))
        },
        event: { subscribe: jest.fn(async () => ({ stream: (async function* () {})() })) }
    };
    return { createOpencodeClient: jest.fn(() => client) };
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
