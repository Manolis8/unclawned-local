// Stubs for OpenClaw infra dependencies not needed in this project
// From ../infra/ws.js
export function rawDataToString(data) {
    if (typeof data === 'string')
        return data;
    if (Buffer.isBuffer(data))
        return data.toString('utf8');
    if (data instanceof ArrayBuffer)
        return Buffer.from(data).toString('utf8');
    return String(data);
}
export function isPrivateNetworkAllowedByPolicy(policy) {
    return true; // allow all in this context
}
export async function resolvePinnedHostnameWithPolicy(hostname, opts) {
    // no restrictions
}
export function withBrowserNavigationPolicy(ssrfPolicy) {
    return ssrfPolicy ? { ssrfPolicy } : {};
}
export function assertBrowserNavigationAllowed(opts) {
    return Promise.resolve(); // allow all navigation
}
export function assertBrowserNavigationResultAllowed(opts) {
    return Promise.resolve();
}
export class SsrFBlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SsrFBlockedError';
    }
}
export class InvalidBrowserNavigationUrlError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidBrowserNavigationUrlError';
    }
}
// From ../gateway/net.js
export function isLoopbackHost(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
// From ../infra/errors.js
export function formatErrorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
// From ../config/config.js — stub
export const CONFIG_DIR = '/tmp';
export function getConfig() { return {}; }
export function resolveConfig() { return {}; }
// From ../config/paths.js — stub
export function resolveOpenClawDataDir() { return '/tmp/openclaw'; }
export function getBrowserExecutablePath() { return null; }
// From ../config/port-defaults.js — stub
export const DEFAULT_PORTS = { extension: 9223 };
// From ../cli/command-format.js — stub
export function formatCommandOutput(data) { return String(data); }
// From ../media/store.js — stub
export function createMediaStore() { return {}; }
// From ../media/image-ops.js — stub
export function resizeImage() { return Promise.resolve(Buffer.alloc(0)); }
// From ../infra/fs-safe.js — stub
export function ensureDirectory() { return Promise.resolve(); }
export function writeFileAtomic() { return Promise.resolve(); }
// From ../infra/path-guards.js — stub
export function isPathWithin() { return true; }
// From ../infra/tmp-openclaw-dir.js — stub
export function createTmpDir() { return Promise.resolve('/tmp'); }
// From ../infra/secure-random.js — stub
export function randomBytes() { return Buffer.alloc(16); }
// From ../process/exec.js — stub
export function execCommand() { return Promise.resolve({ stdout: '', stderr: '' }); }
// From ../security/secret-equal.js — stub
export function secureCompare(a, b) { return a === b; }
// From ../../utils.js — stub
export function getUtils() { return {}; }
// From ../../utils/boolean.js — stub
export function isTruthy() { return true; }
// From ../test-utils/fetch-mock.js — stub (for tests)
export function createFetchMock() { return {}; }
