export async function getChromeWebSocketUrl(...args) {
    throw new Error('Chrome executable mode not supported');
}
export async function launchOpenClawChrome(opts) {
    throw new Error('Chrome executable mode not supported');
}
export async function stopOpenClawChrome(opts) { }
export async function isChromeCdpReady(opts) { return false; }
export async function isChromeReachable(opts) { return false; }
export async function findChromeExecutableMac() { return null; }
export async function findChromeExecutableWindows() { return null; }
export async function resolveBrowserExecutableForPlatform() { return null; }
export async function ensureProfileCleanExit(opts) { }
export async function decorateOpenClawProfile(opts) { }
export function resolveOpenClawUserDataDir(opts) { return '/tmp/openclaw'; }
