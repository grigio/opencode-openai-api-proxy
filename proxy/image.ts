import { resolveSafeImageUrl } from './ssrf.ts';
import { logger } from './logger.ts';

const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 10 * 1000;
/**
 * Downloads an image and returns it as a data URI.
 * If the input is already a data URI, it returns it directly.
 *
 * Only http(s) URLs to public hosts are fetched; private/loopback targets are
 * rejected to prevent SSRF. Fetches have a timeout and a size cap.
 *
 * Uses native fetch (undici) so outbound proxy settings (HTTPS_PROXY etc.)
 * are honored via the global dispatcher — unlike the previous axios path which
 * bypassed the EnvHttpProxyAgent.
 *
 * @param {string} url The image URL or data URI
 * @returns {Promise<string>} The image as a data URI
 */
async function getImageDataUri(url: string): Promise<string> {
    if (url.startsWith('data:')) {
        return url;
    }
    const safe = resolveSafeImageUrl(url);
    if (!safe) {
        throw new Error(`Refusing to fetch image from unsafe URL: ${url}`);
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
        let response: Response;
        try {
            response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
        } finally {
            clearTimeout(timeout);
        }
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            let target: string | null = null;
            try {
                target = location ? new URL(location, url).toString() : null;
            } catch {}
            if (target) {
                const safeTarget = resolveSafeImageUrl(target);
                if (!safeTarget) throw new Error(`Refusing redirect to unsafe URL: ${location}`);
            }
            throw new Error(
                `Refusing redirect to ${location || 'unknown'} (HTTP ${response.status})`
            );
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const contentLength = response.headers.get('content-length');
        if (contentLength && Number(contentLength) > MAX_IMAGE_SIZE_BYTES) {
            throw new Error(`Image exceeds size limit (${contentLength} bytes)`);
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_IMAGE_SIZE_BYTES) {
            throw new Error(`Image exceeds size limit (${buffer.byteLength} bytes)`);
        }
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const base64 = Buffer.from(buffer).toString('base64');
        return `data:${contentType};base64,${base64}`;
    } catch (error) {
        logger.error(`Failed to fetch image from ${url}:`, (error as { message?: string }).message);
        throw new Error(`Failed to fetch image: ${url}`);
    }
}

export { getImageDataUri, MAX_IMAGE_SIZE_BYTES, IMAGE_FETCH_TIMEOUT_MS };
