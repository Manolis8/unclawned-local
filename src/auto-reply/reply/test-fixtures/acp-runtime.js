export function createAcpTestConfig(overrides) {
    return {
        acp: {
            enabled: true,
            stream: {
                coalesceIdleMs: 0,
                maxChunkChars: 64,
            },
        },
        ...overrides,
    };
}
export function createAcpSessionMeta(overrides) {
    return {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
        identity: {
            state: "resolved",
            acpxSessionId: "acpx-session-1",
            source: "status",
            lastUpdatedAt: Date.now(),
        },
        ...overrides,
    };
}
