import { AsyncLocalStorage } from 'node:async_hooks';

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4
};

function currentLevel(): LogLevel {
    const raw = (process.env.LOG_LEVEL || '').toLowerCase();
    if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' || raw === 'silent')
        return raw;
    return 'info';
}

function shouldLog(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[currentLevel()];
}

const requestIdStorage = new AsyncLocalStorage<string>();

function getRequestId(): string | undefined {
    return requestIdStorage.getStore();
}

function runWithRequestId<T>(id: string, fn: () => T): T {
    return requestIdStorage.run(id, fn);
}

function formatMessage(args: unknown[]): string {
    return args
        .map((a) => {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return a.message;
            try {
                return JSON.stringify(a);
            } catch {
                return String(a);
            }
        })
        .join(' ');
}

function log(level: LogLevel, ...args: unknown[]): void {
    if (!shouldLog(level)) return;
    const requestId = getRequestId();
    const timestamp = new Date().toISOString();
    const message = formatMessage(args);

    if ((process.env.LOG_FORMAT || '').toLowerCase() === 'json') {
        const entry: Record<string, unknown> = { timestamp, level, message };
        if (requestId) entry.requestId = requestId;
        // structured log output as single JSON line
        const line = JSON.stringify(entry);
        if (level === 'warn') console.warn(line);
        else if (level === 'error') console.error(line);
        else console.log(line);
        return;
    }

    const prefix = requestId ? `[${requestId}]` : '';
    const line = prefix ? `${timestamp} ${prefix} ${message}` : `${timestamp} ${message}`;
    if (level === 'warn') console.warn(line);
    else if (level === 'error') console.error(line);
    else console.log(line);
}

export const logger = {
    debug(...args: unknown[]): void {
        log('debug', ...args);
    },
    info(...args: unknown[]): void {
        log('info', ...args);
    },
    warn(...args: unknown[]): void {
        log('warn', ...args);
    },
    error(...args: unknown[]): void {
        log('error', ...args);
    }
};

export { getRequestId, runWithRequestId, requestIdStorage };
export type { LogLevel };
