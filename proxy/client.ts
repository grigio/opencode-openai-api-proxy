import { createOpencodeClient } from '@opencode-ai/sdk';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { Request } from 'express';

function getClient(): OpencodeClient {
    const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
    const baseUrl = `http://127.0.0.1:${parseInt(process.env.TARGET_PORT || process.env.OPENCODE_SERVER_PORT || '4097', 10)}`;
    const headers: Record<string, string> = {};
    if (serverPassword) {
        headers['Authorization'] =
            'Basic ' + Buffer.from(`opencode:${serverPassword}`).toString('base64');
    }
    return createOpencodeClient({ baseUrl, headers });
}

function clientAbortSignal(req: Request): AbortSignal {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.on('close', () => {
        if (!req.complete) abort();
    });
    return controller.signal;
}

export { getClient, clientAbortSignal };
