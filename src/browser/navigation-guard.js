import { SsrFBlockedError, InvalidBrowserNavigationUrlError } from './stubs.js';
export { SsrFBlockedError, InvalidBrowserNavigationUrlError };
const NETWORK_NAVIGATION_PROTOCOLS = new Set(['http:', 'https:']);
const SAFE_NON_NETWORK_URLS = new Set(['about:blank']);
export function withBrowserNavigationPolicy(ssrfPolicy) {
    return ssrfPolicy ? { ssrfPolicy } : {};
}
export async function assertBrowserNavigationAllowed(opts) {
    const rawUrl = String(opts.url ?? '').trim();
    if (!rawUrl)
        throw new InvalidBrowserNavigationUrlError('url is required');
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${rawUrl}`);
    }
    if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
        if (SAFE_NON_NETWORK_URLS.has(parsed.href))
            return;
        throw new InvalidBrowserNavigationUrlError(`Navigation blocked: unsupported protocol "${parsed.protocol}"`);
    }
    // No SSRF restrictions in this context
}
export async function assertBrowserNavigationResultAllowed(opts) {
    const rawUrl = String(opts.url ?? '').trim();
    if (!rawUrl)
        return;
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        return;
    }
    if (NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) || SAFE_NON_NETWORK_URLS.has(parsed.href)) {
        await assertBrowserNavigationAllowed(opts);
    }
}
