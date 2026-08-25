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

function formatArgs(args: unknown[]): unknown[] {
    return args;
}

export const logger = {
    debug(...args: unknown[]): void {
        if (shouldLog('debug')) console.log(...formatArgs(args));
    },
    info(...args: unknown[]): void {
        if (shouldLog('info')) console.log(...formatArgs(args));
    },
    warn(...args: unknown[]): void {
        if (shouldLog('warn')) console.warn(...formatArgs(args));
    },
    error(...args: unknown[]): void {
        if (shouldLog('error')) console.error(...formatArgs(args));
    }
};

export type { LogLevel };
