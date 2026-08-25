import { jest } from '@jest/globals';

const { configureOutboundProxy, resolveProxyEnv, withLoopbackNoProxy, redactProxyUrl } = await import('../net.ts');

describe('resolveProxyEnv', () => {
    it('returns all null when no proxy variables are set', () => {
        expect(resolveProxyEnv({})).toEqual({
            httpProxy: null,
            httpsProxy: null,
            allProxy: null,
            noProxy: null
        });
    });

    it('reads uppercase variables', () => {
        const resolved = resolveProxyEnv({
            HTTPS_PROXY: 'http://proxy:8080',
            HTTP_PROXY: 'http://proxy:8080',
            ALL_PROXY: 'http://all:1080',
            NO_PROXY: 'internal.example'
        });
        expect(resolved.httpsProxy).toBe('http://proxy:8080');
        expect(resolved.httpProxy).toBe('http://proxy:8080');
        expect(resolved.allProxy).toBe('http://all:1080');
        expect(resolved.noProxy).toBe('internal.example');
    });

    it('prefers uppercase over lowercase (Go/undici convention)', () => {
        const resolved = resolveProxyEnv({
            HTTPS_PROXY: 'http://upper:1',
            https_proxy: 'http://lower:2',
            http_proxy: 'http://lower-http:3',
            HTTP_PROXY: 'http://upper-http:4'
        });
        expect(resolved.httpsProxy).toBe('http://upper:1');
        expect(resolved.httpProxy).toBe('http://upper-http:4');
    });

    it('falls back to the other spelling when only one is set', () => {
        expect(resolveProxyEnv({ https_proxy: 'http://only-lower:1' }).httpsProxy).toBe('http://only-lower:1');
        expect(resolveProxyEnv({ ALL_PROXY: 'http://only-upper:1' }).allProxy).toBe('http://only-upper:1');
    });

    it('treats empty/whitespace values as unset (compose ${VAR:-} placeholders)', () => {
        const resolved = resolveProxyEnv({ HTTPS_PROXY: '   ', HTTP_PROXY: '' });
        expect(resolved.httpsProxy).toBeNull();
        expect(resolved.httpProxy).toBeNull();
    });
});

describe('withLoopbackNoProxy', () => {
    it('returns the loopback defaults for an empty value', () => {
        expect(withLoopbackNoProxy(null)).toBe('localhost,127.0.0.1,[::1],::1');
        expect(withLoopbackNoProxy('')).toBe('localhost,127.0.0.1,[::1],::1');
    });

    it('preserves user entries and appends missing loopback hosts', () => {
        expect(withLoopbackNoProxy('internal.example,.corp.local')).toBe(
            'internal.example,.corp.local,localhost,127.0.0.1,[::1],::1'
        );
    });

    it('does not duplicate entries already present (case-insensitive)', () => {
        expect(withLoopbackNoProxy('LOCALHOST, 127.0.0.1')).toBe('LOCALHOST,127.0.0.1,[::1],::1');
    });

    it('short-circuits on * (never proxy anything)', () => {
        expect(withLoopbackNoProxy('*')).toBe('*');
    });
});

describe('redactProxyUrl', () => {
    it('strips userinfo credentials', () => {
        expect(redactProxyUrl('http://user:secret@proxy:8080')).toBe('http://proxy:8080/');
    });

    it('leaves credential-free URLs untouched', () => {
        expect(redactProxyUrl('http://proxy:8080')).toBe('http://proxy:8080');
    });

    it('masks unparseable values instead of echoing them', () => {
        expect(redactProxyUrl('not a url')).toBe('<unparseable-proxy-url>');
    });
});

describe('configureOutboundProxy', () => {
    it('is a no-op without proxy variables', () => {
        const env = { NO_PROXY: 'internal.example' } as NodeJS.ProcessEnv;
        expect(configureOutboundProxy(env)).toBe(false);
        expect(env.NO_PROXY).toBe('internal.example');
        expect(env.no_proxy).toBeUndefined();
    });

    it('installs curl-style handling and force-merges loopback exclusions', () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const env = {
                HTTPS_PROXY: 'http://user:secret@proxy:8080',
                NO_PROXY: 'internal.example'
            } as unknown as NodeJS.ProcessEnv;
            expect(configureOutboundProxy(env)).toBe(true);
            expect(env.NO_PROXY).toBe('internal.example,localhost,127.0.0.1,[::1],::1');
            expect(env.no_proxy).toBe(env.NO_PROXY);
            // Credentials from the proxy URL must never reach the log output.
            const logged = logSpy.mock.calls.flat().join(' ');
            expect(logged).not.toContain('secret');
        } finally {
            logSpy.mockRestore();
        }
    });
});
