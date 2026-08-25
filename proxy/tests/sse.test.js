import { jest } from '@jest/globals';

const { consumeUpstreamSSE, consumeStreamEvents, sendResponseSseEvent } = await import('../sse.ts');

function mockRes() {
    return {
        destroyed: false,
        write: jest.fn(),
        end: jest.fn()
    };
}

function sseStreamFromChunks(chunks) {
    const encoder = new TextEncoder();
    const data = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(data));
            controller.close();
        }
    });
}

function rawSseStream(raw) {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(raw));
            controller.close();
        }
    });
}

describe('consumeUpstreamSSE', () => {
    it('parses SSE events and calls onData for each payload', async () => {
        const stream = sseStreamFromChunks([
            { id: '1', choices: [{ delta: { content: 'hello' } }] },
            { id: '1', choices: [{ delta: { content: ' world' } }] }
        ]);
        const res = mockRes();
        const onData = jest.fn();
        const result = await consumeUpstreamSSE({ upstream: stream, res, onData });
        expect(onData).toHaveBeenCalledTimes(3);
        expect(onData.mock.calls[0][0]).toContain('hello');
        expect(onData.mock.calls[1][0]).toContain('world');
        expect(onData.mock.calls[2][0]).toBe('[DONE]');
        expect(result.sawDone).toBe(true);
        expect(result.clean).toBe(true);
    });

    it('returns sawDone true when [DONE] is seen', async () => {
        const stream = rawSseStream('data: [DONE]\n\n');
        const res = mockRes();
        const result = await consumeUpstreamSSE({ upstream: stream, res, onData: () => {} });
        expect(result.sawDone).toBe(true);
        expect(result.clean).toBe(true);
    });

    it('handles split chunks across reads', async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"a":1}\n'));
                controller.enqueue(encoder.encode('\n'));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
            }
        });
        const res = mockRes();
        const onData = jest.fn();
        const result = await consumeUpstreamSSE({ upstream: stream, res, onData });
        expect(onData).toHaveBeenCalledWith('{"a":1}');
        expect(result.sawDone).toBe(true);
    });

    it('stops when onData returns true', async () => {
        const stream = sseStreamFromChunks([
            { id: '1', choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] },
            { id: '1', choices: [{ delta: { content: 'b' } }] }
        ]);
        const res = mockRes();
        const onData = jest.fn((payload) => {
            if (payload.includes('stop')) return true;
            return false;
        });
        const result = await consumeUpstreamSSE({ upstream: stream, res, onData });
        expect(onData).toHaveBeenCalled();
        expect(result.clean).toBe(true);
    });

    it('reports clean false on read error', async () => {
        const stream = new ReadableStream({
            pull(controller) {
                controller.error(new Error('upstream error'));
            }
        });
        const res = mockRes();
        const result = await consumeUpstreamSSE({ upstream: stream, res, onData: jest.fn() });
        expect(result.clean).toBe(false);
    });

    it('calls idleTick on each chunk and clearIdle at end', async () => {
        const stream = sseStreamFromChunks([{ id: '1', choices: [{ delta: { content: 'hi' } }] }]);
        const res = mockRes();
        const idleTick = jest.fn();
        const clearIdle = jest.fn();
        await consumeUpstreamSSE({ upstream: stream, res, onData: jest.fn(), idleTick, clearIdle });
        expect(idleTick).toHaveBeenCalled();
        expect(clearIdle).toHaveBeenCalled();
    });

    it('aborts when signal is aborted', async () => {
        const controller = new AbortController();
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(c) {
                c.enqueue(encoder.encode('data: {"a":1}\n\n'));
            }
        });
        const res = mockRes();
        controller.abort();
        const result = await consumeUpstreamSSE({
            upstream: stream,
            signal: controller.signal,
            res,
            onData: jest.fn()
        });
        expect(result.clean).toBe(false);
    });
});

describe('sendResponseSseEvent', () => {
    it('writes JSON payload as SSE data line', () => {
        const res = mockRes();
        sendResponseSseEvent(res, { type: 'test', value: 123 });
        expect(res.write).toHaveBeenCalledWith('data: {"type":"test","value":123}\n\n');
    });
});

describe('consumeStreamEvents', () => {
    function makeIterator(events) {
        return (async function* () {
            for (const e of events) yield e;
        })()[Symbol.asyncIterator]();
    }

    it('streams cumulative part.text deltas and suppresses user echo', async () => {
        const sessionId = 'sess-1';
        const events = [
            {
                type: 'message.updated',
                properties: { info: { id: 'msg_user', sessionID: sessionId, role: 'user' } }
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'prt_user',
                        messageID: 'msg_user',
                        sessionID: sessionId,
                        type: 'text',
                        text: 'user prompt'
                    }
                }
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'prt_reasoning',
                        messageID: 'msg_asst',
                        sessionID: sessionId,
                        type: 'reasoning',
                        text: 'Think'
                    }
                }
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'prt_reasoning',
                        messageID: 'msg_asst',
                        sessionID: sessionId,
                        type: 'reasoning',
                        text: 'Thinking'
                    }
                }
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'prt_text',
                        messageID: 'msg_asst',
                        sessionID: sessionId,
                        type: 'text',
                        text: 'Hello'
                    }
                }
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'prt_text',
                        messageID: 'msg_asst',
                        sessionID: sessionId,
                        type: 'text',
                        text: 'Hello world'
                    }
                }
            },
            {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'msg_asst',
                        sessionID: sessionId,
                        role: 'assistant',
                        finish: 'stop'
                    }
                }
            }
        ];
        const res = mockRes();
        const state = { ended: false, streamedAnything: false, insideReasoning: false };
        const onFinish = jest.fn();
        const onFail = jest.fn();
        const onReasoningStart = jest.fn();
        const onReasoningDelta = jest.fn();
        const onReasoningEnd = jest.fn();
        const onTextDelta = jest.fn();

        await consumeStreamEvents({
            eventIterator: makeIterator(events),
            sessionId,
            res,
            state,
            getPromptError: () => null,
            onFinish,
            onFail,
            onReasoningStart,
            onReasoningDelta,
            onReasoningEnd,
            onTextDelta
        });

        expect(onReasoningStart).toHaveBeenCalled();
        expect(onReasoningDelta).toHaveBeenCalledWith('Think');
        expect(onReasoningDelta).toHaveBeenCalledWith('ing');
        expect(onReasoningEnd).not.toHaveBeenCalledTimes(0); // may be called on text delta transition
        expect(onTextDelta).toHaveBeenCalledWith('Hello');
        expect(onTextDelta).toHaveBeenCalledWith(' world');
        expect(onFinish).toHaveBeenCalledWith('stop');
        expect(onFail).not.toHaveBeenCalled();
    });

    it('handles message.part.delta events and keeps partTexts in sync', async () => {
        const sessionId = 'sess-1';
        const events = [
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'prt_t',
                        messageID: 'msg_asst',
                        sessionID: sessionId,
                        type: 'text',
                        text: ''
                    }
                }
            },
            {
                type: 'message.part.delta',
                properties: {
                    sessionID: sessionId,
                    partID: 'prt_t',
                    field: 'text',
                    delta: 'Answer'
                }
            },
            {
                type: 'message.part.delta',
                properties: { sessionID: sessionId, partID: 'prt_t', field: 'text', delta: '!' }
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'prt_t',
                        messageID: 'msg_asst',
                        sessionID: sessionId,
                        type: 'text',
                        text: 'Answer!'
                    }
                }
            },
            {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'msg_asst',
                        sessionID: sessionId,
                        role: 'assistant',
                        finish: 'stop'
                    }
                }
            }
        ];
        const res = mockRes();
        const state = { ended: false, streamedAnything: false, insideReasoning: false };
        const onTextDelta = jest.fn();
        const onFinish = jest.fn();
        await consumeStreamEvents({
            eventIterator: makeIterator(events),
            sessionId,
            res,
            state,
            getPromptError: () => null,
            onFinish,
            onFail: jest.fn(),
            onReasoningStart: jest.fn(),
            onReasoningDelta: jest.fn(),
            onReasoningEnd: jest.fn(),
            onTextDelta
        });
        expect(onTextDelta).toHaveBeenCalledWith('Answer');
        expect(onTextDelta).toHaveBeenCalledWith('!');
        // The cumulative update after deltas should not duplicate '!'
        const all = onTextDelta.mock.calls.map((c) => c[0]).join('');
        expect(all).toBe('Answer!');
        expect(onFinish).toHaveBeenCalled();
    });

    it('calls onFail on session.error', async () => {
        const sessionId = 'sess-1';
        const events = [
            {
                type: 'session.error',
                properties: { sessionID: sessionId, error: { message: 'boom' } }
            }
        ];
        const res = mockRes();
        const state = { ended: false, streamedAnything: false, insideReasoning: false };
        const onFail = jest.fn();
        await consumeStreamEvents({
            eventIterator: makeIterator(events),
            sessionId,
            res,
            state,
            getPromptError: () => null,
            onFinish: jest.fn(),
            onFail,
            onReasoningStart: jest.fn(),
            onReasoningDelta: jest.fn(),
            onReasoningEnd: jest.fn(),
            onTextDelta: jest.fn()
        });
        expect(onFail).toHaveBeenCalledWith('boom');
    });

    it('does not end on intermediate tool-calls finish', async () => {
        const sessionId = 'sess-1';
        const events = [
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'p1',
                        messageID: 'm1',
                        sessionID: sessionId,
                        type: 'text',
                        text: 'hi'
                    }
                }
            },
            {
                type: 'message.updated',
                properties: {
                    info: {
                        id: 'm1',
                        sessionID: sessionId,
                        role: 'assistant',
                        finish: 'tool-calls'
                    }
                }
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'p1',
                        messageID: 'm1',
                        sessionID: sessionId,
                        type: 'text',
                        text: 'hi there'
                    }
                }
            },
            {
                type: 'message.updated',
                properties: {
                    info: { id: 'm1', sessionID: sessionId, role: 'assistant', finish: 'stop' }
                }
            }
        ];
        const res = mockRes();
        const state = { ended: false, streamedAnything: false, insideReasoning: false };
        const onFinish = jest.fn();
        const onTextDelta = jest.fn();
        await consumeStreamEvents({
            eventIterator: makeIterator(events),
            sessionId,
            res,
            state,
            getPromptError: () => null,
            onFinish,
            onFail: jest.fn(),
            onReasoningStart: jest.fn(),
            onReasoningDelta: jest.fn(),
            onReasoningEnd: jest.fn(),
            onTextDelta
        });
        expect(onFinish).toHaveBeenCalledWith('stop');
        expect(onFinish).toHaveBeenCalledTimes(1);
        expect(onTextDelta).toHaveBeenCalledWith('hi');
        expect(onTextDelta).toHaveBeenCalledWith(' there');
    });

    it('handles session.idle as terminal when streamedAnything true', async () => {
        const sessionId = 'sess-1';
        const events = [
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        id: 'p1',
                        messageID: 'm1',
                        sessionID: sessionId,
                        type: 'text',
                        text: 'hi'
                    }
                }
            },
            { type: 'session.idle', properties: { sessionID: sessionId } }
        ];
        const res = mockRes();
        const state = { ended: false, streamedAnything: false, insideReasoning: false };
        const onFinish = jest.fn();
        const onTextDelta = jest.fn(() => {
            state.streamedAnything = true;
        });
        await consumeStreamEvents({
            eventIterator: makeIterator(events),
            sessionId,
            res,
            state,
            getPromptError: () => null,
            onFinish,
            onFail: jest.fn(),
            onReasoningStart: jest.fn(),
            onReasoningDelta: jest.fn(),
            onReasoningEnd: jest.fn(),
            onTextDelta
        });
        expect(onFinish).toHaveBeenCalledWith('stop');
    });
});
