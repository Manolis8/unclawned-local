import { browserCloseTab } from "./client.js";
const trackedTabsBySession = new Map();
function normalizeSessionKey(raw) {
    return raw.trim().toLowerCase();
}
function normalizeTargetId(raw) {
    return raw.trim();
}
function normalizeProfile(raw) {
    if (!raw) {
        return undefined;
    }
    const trimmed = raw.trim();
    return trimmed ? trimmed.toLowerCase() : undefined;
}
function normalizeBaseUrl(raw) {
    if (!raw) {
        return undefined;
    }
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
}
function toTrackedTabId(params) {
    return `${params.targetId}\u0000${params.baseUrl ?? ""}\u0000${params.profile ?? ""}`;
}
function isIgnorableCloseError(err) {
    const message = String(err).toLowerCase();
    return (message.includes("tab not found") ||
        message.includes("target closed") ||
        message.includes("target not found") ||
        message.includes("no such target"));
}
export function trackSessionBrowserTab(params) {
    const sessionKeyRaw = params.sessionKey?.trim();
    const targetIdRaw = params.targetId?.trim();
    if (!sessionKeyRaw || !targetIdRaw) {
        return;
    }
    const sessionKey = normalizeSessionKey(sessionKeyRaw);
    const targetId = normalizeTargetId(targetIdRaw);
    const baseUrl = normalizeBaseUrl(params.baseUrl);
    const profile = normalizeProfile(params.profile);
    const tracked = {
        sessionKey,
        targetId,
        baseUrl,
        profile,
        trackedAt: Date.now(),
    };
    const trackedId = toTrackedTabId(tracked);
    let trackedForSession = trackedTabsBySession.get(sessionKey);
    if (!trackedForSession) {
        trackedForSession = new Map();
        trackedTabsBySession.set(sessionKey, trackedForSession);
    }
    trackedForSession.set(trackedId, tracked);
}
export function untrackSessionBrowserTab(params) {
    const sessionKeyRaw = params.sessionKey?.trim();
    const targetIdRaw = params.targetId?.trim();
    if (!sessionKeyRaw || !targetIdRaw) {
        return;
    }
    const sessionKey = normalizeSessionKey(sessionKeyRaw);
    const trackedForSession = trackedTabsBySession.get(sessionKey);
    if (!trackedForSession) {
        return;
    }
    const trackedId = toTrackedTabId({
        targetId: normalizeTargetId(targetIdRaw),
        baseUrl: normalizeBaseUrl(params.baseUrl),
        profile: normalizeProfile(params.profile),
    });
    trackedForSession.delete(trackedId);
    if (trackedForSession.size === 0) {
        trackedTabsBySession.delete(sessionKey);
    }
}
function takeTrackedTabsForSessionKeys(sessionKeys) {
    const uniqueSessionKeys = new Set();
    for (const key of sessionKeys) {
        if (!key?.trim()) {
            continue;
        }
        uniqueSessionKeys.add(normalizeSessionKey(key));
    }
    if (uniqueSessionKeys.size === 0) {
        return [];
    }
    const seenTrackedIds = new Set();
    const tabs = [];
    for (const sessionKey of uniqueSessionKeys) {
        const trackedForSession = trackedTabsBySession.get(sessionKey);
        if (!trackedForSession || trackedForSession.size === 0) {
            continue;
        }
        trackedTabsBySession.delete(sessionKey);
        for (const tracked of trackedForSession.values()) {
            const trackedId = toTrackedTabId(tracked);
            if (seenTrackedIds.has(trackedId)) {
                continue;
            }
            seenTrackedIds.add(trackedId);
            tabs.push(tracked);
        }
    }
    return tabs;
}
export async function closeTrackedBrowserTabsForSessions(params) {
    const tabs = takeTrackedTabsForSessionKeys(params.sessionKeys);
    if (tabs.length === 0) {
        return 0;
    }
    const closeTab = params.closeTab ??
        (async (tab) => {
            await browserCloseTab(tab.baseUrl, tab.targetId, {
                profile: tab.profile,
            });
        });
    let closed = 0;
    for (const tab of tabs) {
        try {
            await closeTab({
                targetId: tab.targetId,
                baseUrl: tab.baseUrl,
                profile: tab.profile,
            });
            closed += 1;
        }
        catch (err) {
            if (!isIgnorableCloseError(err)) {
                params.onWarn?.(`failed to close tracked browser tab ${tab.targetId}: ${String(err)}`);
            }
        }
    }
    return closed;
}
export function __resetTrackedSessionBrowserTabsForTests() {
    trackedTabsBySession.clear();
}
export function __countTrackedSessionBrowserTabsForTests(sessionKey) {
    if (typeof sessionKey === "string" && sessionKey.trim()) {
        return trackedTabsBySession.get(normalizeSessionKey(sessionKey))?.size ?? 0;
    }
    let count = 0;
    for (const tracked of trackedTabsBySession.values()) {
        count += tracked.size;
    }
    return count;
}
