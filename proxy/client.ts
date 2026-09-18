import { getV2Client, clientAbortSignal } from './v2-client.ts';
import type { V2Client } from './v2-client.ts';

function getClient(): V2Client {
    return getV2Client();
}

export { getClient, clientAbortSignal };
