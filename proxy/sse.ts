import type { Response } from 'express';
import type { OpenCodeStreamEvent, StreamState } from './types.ts';
import { logger } from './logger.ts';

interface UpstreamSSEOptions {
    upstream: ReadableStream<Uint8Array>;
    signal?: AbortSignal;
    res: Response;
    onData?: (payload: string) => string | boolean | void;
    idleTick?: () => void;
    clearIdle?: () => void;
}

interface ConsumeStreamEventsOptions {
    eventIterator: AsyncIterator<OpenCodeStreamEvent>;
    sessionId: string;
    res: Response;
    state: StreamState;
    getPromptError: () => Error | null;
    onFinish: (finish: string) => void;
    onFail: (msg: string) => void;
    onReasoningStart: () => void;
    onReasoningDelta: (delta: string) => void;
    onReasoningEnd: () => void;
    onTextDelta: (delta: string) => void;
}

function sendResponseSseEvent(res: Response, payload: unknown): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Consumes an upstream OpenAI-compatible SSE stream, splitting it into SSE
 * events and calling `onData(payload)` for each `data:` record. Stops when the
 * client disconnects, the request is aborted, or `onData` returns true.
 * Cancels the underlying reader so a client abort or early [DONE] never leaks
 * the upstream connection.
 *
 * @param {object} options
 * @param {import('stream').Readable} options.upstream Upstream SSE body
 * @param {AbortSignal} [options.signal] Combined request/timeout signal
 * @param {object} options.res Express response (res.destroyed check)
 * @param {(payload: string) => string|boolean|void} [options.onData]
 *   Called with each raw SSE payload (already trimmed). Returning truthy marks
 *   the stream as finished and stops reading.
 * @returns {Promise<{clean: boolean, sawDone: boolean}>} How the stream ended:
 *   `clean` is false when the upstream body errored or was cut short by a
 *   (timeout) abort instead of ending naturally, `sawDone` is true when an SSE
 *   `[DONE]` marker was observed. Callers use this to distinguish a normal
 *   completion from a truncated upstream so they can surface the failure
 *   (instead of synthesizing a fake successful finish).
 */
async function consumeUpstreamSSE({
    upstream,
    signal,
    res,
    onData,
    idleTick,
    clearIdle
}: UpstreamSSEOptions): Promise<{ clean: boolean; sawDone: boolean }> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    let readError = false;
    let sawDone = false;

    const cancelReader = () => {
        reader.cancel().catch(() => {});
    };
    if (signal) {
        if (signal.aborted) cancelReader();
        else signal.addEventListener('abort', cancelReader, { once: true });
    }

    try {
        while (!done && !res.destroyed && !(signal && signal.aborted)) {
            let chunk;
            try {
                ({ value: chunk, done = false } = await reader.read());
            } catch {
                readError = true;
                break;
            }
            if (done) break;
            // Any received byte proves the upstream is alive: re-arm the idle
            // timeout so a long but healthy reasoning stream is never cut short.
            if (idleTick) idleTick();
            buffer += decoder.decode(chunk, { stream: true });
            let separator;
            while ((separator = buffer.indexOf('\n\n')) !== -1) {
                const raw = buffer.slice(0, separator);
                buffer = buffer.slice(separator + 2);
                for (const line of raw.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (!payload) continue;
                    if (payload === '[DONE]') sawDone = true;
                    if (onData && onData(payload)) {
                        done = true;
                        break;
                    }
                }
                if (done) break;
            }
        }
    } finally {
        cancelReader();
        if (clearIdle) clearIdle();
    }

    const clean = !readError && !(signal && signal.aborted);
    return { clean, sawDone };
}

/**
 * Consumes the OpenCode SSE stream for a single prompt attempt, extracting text
 * deltas from both the delta event flow (message.part.delta) and the cumulative
 * message.part.updated flow used by newer servers. For the cumulative flow the
 * delta is reconstructed by diffing part.text per part id, and the user's own
 * echoed parts are suppressed so the prompt is never streamed back as output.
 *
 * The caller owns session/prompt setup, keepalive and SSE formatting; this
 * function only drives the event loop and calls back for deltas/terminal states.
 *
 * @param {object} options
 * @param {AsyncIterator} options.eventIterator SSE event iterator for this attempt
 * @param {string} options.sessionId Session id to filter events by
 * @param {object} options.res Express response (used for res.destroyed checks)
 * @param {{ ended: boolean, streamedAnything: boolean, insideReasoning: boolean }} options.state
 *   Mutable state shared with the caller, mutated as events are processed.
 * @param {() => (Error|null)} options.getPromptError
 * @param {(finish: string) => void} options.onFinish Called on terminal finish

/**
 * Consumes the OpenCode SSE stream for a single prompt attempt, extracting text
 * deltas from both the delta event flow (message.part.delta) and the cumulative
 * message.part.updated flow used by newer servers. For the cumulative flow the
 * delta is reconstructed by diffing part.text per part id, and the user's own
 * echoed parts are suppressed so the prompt is never streamed back as output.
 *
 * The caller owns session/prompt setup, keepalive and SSE formatting; this
 * function only drives the event loop and calls back for deltas/terminal states.
 *
 * @param {object} options
 * @param {AsyncIterator} options.eventIterator SSE event iterator for this attempt
 * @param {string} options.sessionId Session id to filter events by
 * @param {object} options.res Express response (used for res.destroyed checks)
 * @param {{ ended: boolean, streamedAnything: boolean, insideReasoning: boolean }} options.state
 *   Mutable state shared with the caller, mutated as events are processed.
 * @param {() => (Error|null)} options.getPromptError
 * @param {(finish: string) => void} options.onFinish Called on terminal finish
 * @param {(msg: string) => void} options.onFail Called on session.error / idle / errors
 * @param {() => void} options.onReasoningStart
 * @param {(delta: string) => void} options.onReasoningDelta
 * @param {() => void} options.onReasoningEnd
 * @param {(delta: string) => void} options.onTextDelta
 */
async function consumeStreamEvents({
    eventIterator,
    sessionId,
    res,
    state,
    getPromptError,
    onFinish,
    onFail,
    onReasoningStart,
    onReasoningDelta,
    onReasoningEnd,
    onTextDelta
}: ConsumeStreamEventsOptions): Promise<void> {
    const partTypes = new Map<string, string>();
    const partTexts = new Map<string, string>();
    const userMessageIds = new Set<string>();

    const emitDelta = (partType: string, delta: string | undefined) => {
        if (!delta) return;
        if (partType === 'reasoning') {
            if (!state.insideReasoning) {
                onReasoningStart();
                state.insideReasoning = true;
            }
            onReasoningDelta(delta);
            state.streamedAnything = true;
        } else {
            if (state.insideReasoning) {
                onReasoningEnd();
                state.insideReasoning = false;
            }
            onTextDelta(delta);
            state.streamedAnything = true;
        }
    };

    try {
        // IMPORTANT: keep a single pending next() promise — creating a new
        // one while the previous is pending discards events silently.
        let pendingNext = eventIterator.next();
        while (!res.destroyed && !state.ended) {
            const pollTimeout = new Promise((resolve) =>
                setTimeout(() => resolve({ timeout: true }), 1000)
            );
            const eventResult = (await Promise.race([
                pendingNext,
                pollTimeout
            ])) as IteratorResult<OpenCodeStreamEvent> & { timeout?: boolean };

            if (eventResult.timeout) {
                const promptError = getPromptError();
                if (promptError) {
                    logger.warn('Ending stream due to prompt error:', promptError.message);
                    onFail(promptError.message);
                }
                continue;
            }

            pendingNext = eventIterator.next();

            if (eventResult.done) break;

            const event = eventResult.value;

            // Track user message ids so their echoed parts can be suppressed.
            if (event.type === 'message.updated') {
                const info = event.properties?.info;
                if (info?.sessionID === sessionId) {
                    if (info.role === 'user' && info.id) {
                        userMessageIds.add(info.id);
                    }
                    // Any terminal finish value ends the stream; tool-calls is
                    // intermediate (the model asked for tools) — keep streaming.
                    if (info.finish && info.finish !== 'tool-calls') {
                        onFinish(info.finish);
                        break;
                    }
                }
            }

            if (event.type === 'message.part.updated') {
                const { part, delta: legacyDelta } = event.properties || {};
                if (!part || part?.sessionID !== sessionId) continue;
                if (part?.id && part?.type) partTypes.set(part.id, part.type);

                // Skip the user's own echoed parts so the prompt is not
                // streamed back as assistant output.
                if (part.role === 'user') continue;
                if (part.messageID && userMessageIds.has(part.messageID)) continue;

                const partType = part.type || partTypes.get(part.id!) || 'text';

                // Newer opencode servers only emit cumulative part.text (no
                // delta field) — reconstruct the delta by diffing per part id.
                // A snapshot shorter than the accumulated text means the server
                // rewrote/truncated it, not new content, so emit no delta.
                let delta = legacyDelta;
                if (typeof part.text === 'string') {
                    const prev = partTexts.get(part.id!) || '';
                    delta = part.text.startsWith(prev) ? part.text.slice(prev.length) : '';
                    partTexts.set(part.id!, part.text);
                }

                emitDelta(partType, delta);
                continue;
            }

            // Streaming deltas come as message.part.delta in opencode >= 1.18.
            // Keep partTexts in sync here too: opencode also emits cumulative
            // message.part.updated snapshots for the same part, so the snapshot
            // diff below must know how much text was already delivered.
            if (event.type === 'message.part.delta') {
                const { sessionID, partID, field, delta } = event.properties!;
                if (sessionID !== sessionId || field !== 'text' || !delta) continue;
                emitDelta(partTypes.get(partID!) || 'text', delta);
                partTexts.set(partID!, (partTexts.get(partID!) || '') + delta);
                continue;
            }

            // Session errored (e.g. model not found, provider failure)
            if (event.type === 'session.error') {
                const props = event.properties;
                if (props?.sessionID === sessionId) {
                    const msg =
                        props?.error?.data?.message || props?.error?.message || 'Session error';
                    onFail(msg);
                }
            }

            // Session went idle: terminal signal for our session
            if (event.type === 'session.idle') {
                if (event.properties?.sessionID === sessionId) {
                    if (state.streamedAnything) {
                        onFinish('stop');
                        break;
                    } else {
                        onFail('Session went idle without producing content');
                    }
                }
            }
        }
    } catch (streamError) {
        logger.error('Streaming error:', streamError);
        onFail((streamError as Error).message);
    } finally {
        // Close the SSE subscription so no iterator stays open after the attempt.
        if (eventIterator?.return) {
            await eventIterator.return();
        }
    }
}

export { sendResponseSseEvent, consumeUpstreamSSE, consumeStreamEvents };
export type { UpstreamSSEOptions, ConsumeStreamEventsOptions };
