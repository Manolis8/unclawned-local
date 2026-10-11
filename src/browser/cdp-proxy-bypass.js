// Stub — no proxy bypass needed
export function withNoProxyForCdpUrl(cdpUrl, fn) {
    return fn();
}
export function withNoProxyForLocalhost(fn) {
    return fn();
}
export function getDirectAgentForCdp(cdpUrl) { return null; }
export function hasProxyEnv() { return false; }
export function hasProxyEnvConfigured() { return false; }
