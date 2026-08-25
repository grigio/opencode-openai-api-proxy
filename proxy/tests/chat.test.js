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
                            models: { 'big-pickle': { id: 'big-pickle', api: { id: 'big-pickle', url: 'https://opencode.ai/zen/v1' } } }
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
        event: {
            subscribe: jest.fn(async () => {
                const sid = 'test-session-id';
                return {
                    stream: (async function* () {
                        yield { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: sid }, delta: 'Hi' } };
                        yield { type: 'message.updated', properties: { info: { sessionID: sid, finish: 'stop' } } };
                    })()
                };
            })
        }
    };
    return { createOpencodeClient: jest.fn(() => client) };
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
            .send({ model: 'opencode/big-pickle', messages: [{ role: 'user', content: 'hi' }], stream: true });
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
                choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] } }],
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
