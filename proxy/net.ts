// ---------------------------------------------------------------------------
// Outbound connection bootstrap: curl-style user proxy support.
//
// Node's built-in fetch (undici) ignores the standard proxy environment
// variables (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY) that curl and
// every other well-behaved HTTP client honor. On hosts where internet egress
// requires the user's proxy (corporate networks, VPNs, region-locked setups),
// the gateway's upstream model-API calls would fail at the network level and
// clients (Codex in particular) see "Provider finish_reason: network_error"
// even though the same request works from opencode itself - the official CLI
// runs on Bun, whose fetch honors those variables natively.
//
// configureOutboundProxy() installs undici's EnvHttpProxyAgent as the global
// dispatcher when any outbound proxy variable is set, giving fetch exactly
// curl's behavior. Two details matter:
//
//  1. Loopback is ALWAYS excluded from proxying (localhost, 127.0.0.1, ::1):
//     the proxy talks to the local OpenCode server on http://127.0.0.1:<port>
//     and that traffic must never leave the machine through a user proxy,
//     even when NO_PROXY is unset. The merged exclusion list is written back
//     to the environment so axios (image downloads) applies the same rule.
//  2. Nothing changes when no proxy variable is configured: no dispatcher is
//     installed and direct connections behave exactly as before.
// ---------------------------------------------------------------------------

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { logger } from './logger.ts';

/** Resolved proxy environment, null = unset/empty. */
interface ProxyEnv {
    httpProxy: string | null;
    httpsProxy: string | null;
    allProxy: string | null;
    noProxy: string | null;
}

/** Hosts that must always bypass an outbound proxy (internal server traffic). */
const LOOPBACK_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '[::1]', '::1'];

/**
 * Reads the standard proxy environment variables with both spellings.
 *
 * Precedence follows the common Go/undici convention: the uppercase variant
 * wins when both are set (curl only ever honors lowercase `http_proxy`, which
 * is still accepted here as a fallback). Empty/whitespace values count as
 * unset so compose files can pass `${HTTPS_PROXY:-}` placeholders
 * unconditionally.
 *
 * @param {NodeJS.ProcessEnv} env Environment (defaults to process.env)
 * @returns {ProxyEnv} Resolved values, null when unset
 */
function resolveProxyEnv(env: NodeJS.ProcessEnv): ProxyEnv {
    const pick = (...names: Array<string | undefined>): string | null => {
        for (const name of names) {
            const value = name?.trim();
            if (value) return value;
        }
        return null;
    };
    return {
        httpsProxy: pick(env.HTTPS_PROXY, env.https_proxy),
        httpProxy: pick(env.HTTP_PROXY, env.http_proxy),
        allProxy: pick(env.ALL_PROXY, env.all_proxy),
        noProxy: pick(env.NO_PROXY, env.no_proxy)
    };
}

/**
 * Strips userinfo (credentials) from a proxy URL before it is logged, so
 * `http://user:pass@proxy:8080` never leaks secrets into container logs.
 *
 * @param {string} url Proxy URL as given in the environment
 * @returns {string} URL without credentials (or the input when unparseable)
 */
function redactProxyUrl(url: string): string {
    try {
        const parsed = new URL(url);
        if (!parsed.username && !parsed.password) return url;
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return '<unparseable-proxy-url>';
    }
}

/**
 * Merges the mandatory loopback exclusions into a NO_PROXY value.
 *
 * User entries are preserved verbatim; missing loopback hosts are appended;
 * duplicates are collapsed case-insensitively; `*` ("never proxy anything")
 * short-circuits unchanged because it already covers loopback.
 *
 * @param {string|null} noProxy Existing NO_PROXY value
 * @returns {string} NO_PROXY guaranteed to exclude loopback
 */
function withLoopbackNoProxy(noProxy: string | null): string {
    if (noProxy && noProxy.trim() === '*') return '*';
    const entries = (noProxy || '')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
    const seen = new Set(entries.map((e) => e.toLowerCase()));
    for (const entry of LOOPBACK_NO_PROXY_ENTRIES) {
        if (!seen.has(entry.toLowerCase())) {
            entries.push(entry);
            seen.add(entry.toLowerCase());
        }
    }
    return entries.join(',');
}

let outboundProxyConfigured = false;

/**
 * Installs curl-style outbound proxy handling on the built-in fetch when the
 * environment configures one; a no-op otherwise. Safe to call once at boot
 * before any request is served (see index.ts).
 *
 * @param {NodeJS.ProcessEnv} [env] Environment (defaults to process.env)
 * @returns {boolean} True when an outbound proxy was configured
 */
function configureOutboundProxy(env: NodeJS.ProcessEnv = process.env): boolean {
    if (outboundProxyConfigured) return true;
    const proxy = resolveProxyEnv(env);
    const active = !!(proxy.httpProxy || proxy.httpsProxy || proxy.allProxy);
    if (!active) return false;

    // Merge loopback into NO_PROXY and write it back under BOTH spellings so
    // every consumer sees the same exclusions: EnvHttpProxyAgent reads these
    // variables itself, and fetch (image + gateway) reads them via the global
    // dispatcher.
    const mergedNoProxy = withLoopbackNoProxy(proxy.noProxy);
    env.NO_PROXY = mergedNoProxy;
    env.no_proxy = mergedNoProxy;

    setGlobalDispatcher(new EnvHttpProxyAgent());
    outboundProxyConfigured = true;

    const via = [proxy.httpsProxy, proxy.httpProxy, proxy.allProxy]
        .filter((u): u is string => !!u)
        .map(redactProxyUrl)
        .join(', ');
    logger.info(
        `[net] outbound connections honor the user's proxy connection (curl-style env): ${via}; loopback stays direct`
    );
    return true;
}

export { configureOutboundProxy, resolveProxyEnv, withLoopbackNoProxy, redactProxyUrl };
