import type { ResponseState } from './types.ts';

const RESPONSE_STATE_TTL_MS = 30 * 60 * 1000;
const RESPONSE_STATE_MAX = 1000;
const responseState = new Map<string, ResponseState>();

setInterval(() => {
    const now = Date.now();
    for (const [id, state] of responseState.entries()) {
        if (state.expiresAt <= now) {
            responseState.delete(id);
        }
    }
}, 60 * 1000).unref();

function storeResponseState(responseId: string, state: Omit<ResponseState, 'expiresAt'>): void {
    if (responseState.has(responseId)) responseState.delete(responseId);
    else if (responseState.size >= RESPONSE_STATE_MAX) {
        const oldest = responseState.keys().next().value as string | undefined;
        if (oldest !== undefined) responseState.delete(oldest);
    }
    responseState.set(responseId, {
        ...state,
        expiresAt: Date.now() + RESPONSE_STATE_TTL_MS
    });
}

function getResponseState(responseId: string): ResponseState | null {
    const state = responseState.get(responseId);
    if (!state) return null;
    if (state.expiresAt <= Date.now()) {
        responseState.delete(responseId);
        return null;
    }
    return state;
}

function clearResponseState(): void {
    responseState.clear();
}

export {
    responseState,
    storeResponseState,
    getResponseState,
    clearResponseState,
    RESPONSE_STATE_TTL_MS,
    RESPONSE_STATE_MAX
};
