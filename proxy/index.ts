import { configureOutboundProxy } from './net.ts';
import app from './app.ts';

// Outbound connections must honor the user's proxy connection (HTTPS_PROXY /
// HTTP_PROXY / ALL_PROXY, like curl) before any upstream call can happen.
configureOutboundProxy();

/**
 * Parses a TCP port from an env var, failing fast with a clear message when
 * the value is not a valid port instead of crashing with an opaque error.
 *
 * @param {string | undefined} raw Raw env value
 * @param {number} fallback Port used when the var is unset/empty
 * @param {string} name Env var name (for error messages)
 * @returns {number} Validated port
 */
function parsePort(raw: string | undefined, fallback: number, name: string): number {
    const value = raw && raw.trim() !== '' ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        console.error(`Invalid ${name} "${raw}": expected an integer between 1 and 65535.`);
        process.exit(1);
    }
    return value;
}

const PORT = parsePort(process.env.PROXY_PORT, 4096, 'PROXY_PORT');
const HOST = process.env.PROXY_HOST?.trim() || '0.0.0.0';
const TARGET_PORT = parsePort(
    process.env.TARGET_PORT || process.env.OPENCODE_SERVER_PORT,
    4097,
    'TARGET_PORT/OPENCODE_SERVER_PORT'
);

const server = app.listen(PORT, HOST, () => {
    console.log(`OpenCode OpenAI Proxy listening on ${HOST}:${PORT}`);
    console.log(`Forwarding to OpenCode Server on port ${TARGET_PORT}`);
});

// Graceful shutdown: stop accepting new connections and let in-flight
// requests/streams finish before exiting. SIGTERM is what Docker sends on
// `docker stop`; SIGINT covers Ctrl+C in foreground runs.
let shuttingDown = false;
function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);

    const forceExit = setTimeout(() => {
        console.error('Forced shutdown after 10s timeout.');
        process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
