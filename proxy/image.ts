import axios from 'axios';
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
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: IMAGE_FETCH_TIMEOUT_MS,
            maxContentLength: MAX_IMAGE_SIZE_BYTES,
            maxBodyLength: MAX_IMAGE_SIZE_BYTES
        });
        const contentType = response.headers['content-type'] || 'image/jpeg';
        const base64 = Buffer.from(response.data, 'binary').toString('base64');
        return `data:${contentType};base64,${base64}`;
    } catch (error) {
        logger.error(`Failed to fetch image from ${url}:`, (error as { message?: string }).message);
        throw new Error(`Failed to fetch image: ${url}`);
    }
}

export { getImageDataUri, MAX_IMAGE_SIZE_BYTES, IMAGE_FETCH_TIMEOUT_MS };
