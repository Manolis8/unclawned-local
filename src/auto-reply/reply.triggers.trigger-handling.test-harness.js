import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
const piEmbeddedMocks = vi.hoisted(() => ({
    abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
    compactEmbeddedPiSession: vi.fn(),
    runEmbeddedPiAgent: vi.fn(),
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
    isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));
export function getAbortEmbeddedPiRunMock() {
    return piEmbeddedMocks.abortEmbeddedPiRun;
}
export function getCompactEmbeddedPiSessionMock() {
    return piEmbeddedMocks.compactEmbeddedPiSession;
}
export function getRunEmbeddedPiAgentMock() {
    return piEmbeddedMocks.runEmbeddedPiAgent;
}
export function getQueueEmbeddedPiMessageMock() {
    return piEmbeddedMocks.queueEmbeddedPiMessage;
}
vi.mock("../agents/pi-embedded.js", () => ({
    abortEmbeddedPiRun: (...args) => piEmbeddedMocks.abortEmbeddedPiRun(...args),
    compactEmbeddedPiSession: (...args) => piEmbeddedMocks.compactEmbeddedPiSession(...args),
    runEmbeddedPiAgent: (...args) => piEmbeddedMocks.runEmbeddedPiAgent(...args),
    queueEmbeddedPiMessage: (...args) => piEmbeddedMocks.queueEmbeddedPiMessage(...args),
    resolveEmbeddedSessionLane: (key) => `session:${key.trim() || "main"}`,
    isEmbeddedPiRunActive: (...args) => piEmbeddedMocks.isEmbeddedPiRunActive(...args),
    isEmbeddedPiRunStreaming: (...args) => piEmbeddedMocks.isEmbeddedPiRunStreaming(...args),
}));
const providerUsageMocks = vi.hoisted(() => ({
    loadProviderUsageSummary: vi.fn().mockResolvedValue({
        updatedAt: 0,
        providers: [],
    }),
    formatUsageSummaryLine: vi.fn().mockReturnValue("📊 Usage: Claude 80% left"),
    formatUsageWindowSummary: vi.fn().mockReturnValue("Claude 80% left"),
    resolveUsageProviderId: vi.fn((provider) => provider.split("/")[0]),
}));
export function getProviderUsageMocks() {
    return providerUsageMocks;
}
vi.mock("../infra/provider-usage.js", () => providerUsageMocks);
const modelCatalogMocks = vi.hoisted(() => ({
    loadModelCatalog: vi.fn().mockResolvedValue([
        {
            provider: "anthropic",
            id: "claude-opus-4-5",
            name: "Claude Opus 4.5",
            contextWindow: 200000,
        },
        {
            provider: "openrouter",
            id: "anthropic/claude-opus-4-5",
            name: "Claude Opus 4.5 (OpenRouter)",
            contextWindow: 200000,
        },
        { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 mini" },
        { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
        { provider: "openai-codex", id: "gpt-5.2", name: "GPT-5.2 (Codex)" },
        { provider: "minimax", id: "MiniMax-M2.5", name: "MiniMax M2.5" },
    ]),
    resetModelCatalogCacheForTest: vi.fn(),
}));
export function getModelCatalogMocks() {
    return modelCatalogMocks;
}
vi.mock("../agents/model-catalog.js", () => modelCatalogMocks);
const webSessionMocks = vi.hoisted(() => ({
    webAuthExists: vi.fn().mockResolvedValue(true),
    getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
    readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));
export function getWebSessionMocks() {
    return webSessionMocks;
}
vi.mock("../web/session.js", () => webSessionMocks);
export const MAIN_SESSION_KEY = "agent:main:main";
let suiteTempHomeRoot = "";
let suiteTempHomeId = 0;
function snapshotTempHomeEnv() {
    return {
        home: process.env.HOME,
        userProfile: process.env.USERPROFILE,
        homeDrive: process.env.HOMEDRIVE,
        homePath: process.env.HOMEPATH,
        openclawHome: process.env.OPENCLAW_HOME,
        stateDir: process.env.OPENCLAW_STATE_DIR,
    };
}
function restoreTempHomeEnv(snapshot) {
    const restoreKey = (key, value) => {
        if (value === undefined) {
            delete process.env[key];
            return;
        }
        process.env[key] = value;
    };
    restoreKey("HOME", snapshot.home);
    restoreKey("USERPROFILE", snapshot.userProfile);
    restoreKey("HOMEDRIVE", snapshot.homeDrive);
    restoreKey("HOMEPATH", snapshot.homePath);
    restoreKey("OPENCLAW_HOME", snapshot.openclawHome);
    restoreKey("OPENCLAW_STATE_DIR", snapshot.stateDir);
}
function setTempHomeEnv(home) {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_STATE_DIR = join(home, ".openclaw");
    if (process.platform !== "win32") {
        return;
    }
    const match = home.match(/^([A-Za-z]:)(.*)$/);
    if (!match) {
        return;
    }
    process.env.HOMEDRIVE = match[1];
    process.env.HOMEPATH = match[2] || "\\";
}
beforeAll(async () => {
    suiteTempHomeRoot = await fs.mkdtemp(join(os.tmpdir(), "openclaw-triggers-suite-"));
});
afterAll(async () => {
    if (!suiteTempHomeRoot) {
        return;
    }
    await fs.rm(suiteTempHomeRoot, { recursive: true, force: true }).catch(() => undefined);
    suiteTempHomeRoot = "";
    suiteTempHomeId = 0;
});
export async function withTempHome(fn) {
    const home = join(suiteTempHomeRoot, `case-${++suiteTempHomeId}`);
    const snapshot = snapshotTempHomeEnv();
    await fs.mkdir(join(home, ".openclaw", "agents", "main", "sessions"), { recursive: true });
    setTempHomeEnv(home);
    try {
        // Avoid cross-test leakage if a test doesn't touch these mocks.
        piEmbeddedMocks.runEmbeddedPiAgent.mockClear();
        piEmbeddedMocks.abortEmbeddedPiRun.mockClear();
        piEmbeddedMocks.compactEmbeddedPiSession.mockClear();
        return await fn(home);
    }
    finally {
        restoreTempHomeEnv(snapshot);
    }
}
export function makeCfg(home) {
    return {
        agents: {
            defaults: {
                model: { primary: "anthropic/claude-opus-4-5" },
                workspace: join(home, "openclaw"),
                // Test harness: avoid 1s coalescer idle sleeps that dominate trigger suites.
                blockStreamingCoalesce: { idleMs: 1 },
                // Trigger tests assert routing/authorization behavior, not delivery pacing.
                humanDelay: { mode: "off" },
            },
        },
        channels: {
            whatsapp: {
                allowFrom: ["*"],
            },
        },
        messages: {
            queue: {
                debounceMs: 0,
            },
        },
        session: { store: join(home, "sessions.json") },
    };
}
export async function loadGetReplyFromConfig() {
    return (await import("./reply.js")).getReplyFromConfig;
}
export function installTriggerHandlingReplyHarness(setGetReplyFromConfig) {
    beforeAll(async () => {
        setGetReplyFromConfig(await loadGetReplyFromConfig());
    });
    installTriggerHandlingE2eTestHooks();
}
export function requireSessionStorePath(cfg) {
    const storePath = cfg.session?.store;
    if (!storePath) {
        throw new Error("expected session store path");
    }
    return storePath;
}
export async function readSessionStore(cfg) {
    const storeRaw = await fs.readFile(requireSessionStorePath(cfg), "utf-8");
    return JSON.parse(storeRaw);
}
export function makeWhatsAppElevatedCfg(home, opts) {
    const cfg = makeCfg(home);
    cfg.channels ??= {};
    cfg.channels.whatsapp = {
        ...cfg.channels.whatsapp,
        allowFrom: ["+1000"],
    };
    if (opts?.requireMentionInGroups !== undefined) {
        cfg.channels.whatsapp.groups = { "*": { requireMention: opts.requireMentionInGroups } };
    }
    cfg.tools = {
        ...cfg.tools,
        elevated: {
            allowFrom: { whatsapp: ["+1000"] },
            ...(opts?.elevatedEnabled === false ? { enabled: false } : {}),
        },
    };
    return cfg;
}
export async function runDirectElevatedToggleAndLoadStore(params) {
    const res = await params.getReplyFromConfig({
        Body: params.body ?? "/elevated on",
        From: "+1000",
        To: "+2000",
        Provider: "whatsapp",
        SenderE164: "+1000",
        CommandAuthorized: true,
    }, {}, params.cfg);
    const text = Array.isArray(res) ? res[0]?.text : res?.text;
    const storePath = params.cfg.session?.store;
    if (!storePath) {
        throw new Error("session.store is required in test config");
    }
    const store = await readSessionStore(params.cfg);
    return { text, store };
}
export async function expectInlineCommandHandledAndStripped(params) {
    const runEmbeddedPiAgentMock = mockRunEmbeddedPiAgentOk();
    runEmbeddedPiAgentMock.mockClear();
    const { blockReplies, handlers } = createBlockReplyCollector();
    const res = await params.getReplyFromConfig({
        Body: params.body,
        From: "+1002",
        To: "+2000",
        CommandAuthorized: true,
        ...params.requestOverrides,
    }, handlers, makeCfg(params.home));
    const text = Array.isArray(res) ? res[0]?.text : res?.text;
    expect(blockReplies.length).toBe(1);
    expect(blockReplies[0]?.text).toContain(params.blockReplyContains);
    expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
    const prompt = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt ?? "";
    expect(prompt).not.toContain(params.stripToken);
    expect(text).toBe("ok");
}
export async function runGreetingPromptForBareNewOrReset(params) {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    runEmbeddedPiAgentMock.mockClear();
    runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "hello" }],
        meta: {
            durationMs: 1,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
    });
    const res = await params.getReplyFromConfig({
        Body: params.body,
        From: "+1003",
        To: "+2000",
        CommandAuthorized: true,
    }, {}, makeCfg(params.home));
    const text = Array.isArray(res) ? res[0]?.text : res?.text;
    expect(text).toBe("hello");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    const prompt = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt ?? "";
    expect(prompt).toContain("A new session was started via /new or /reset");
    expect(prompt).toContain("Execute your Session Startup sequence now");
}
export function installTriggerHandlingE2eTestHooks() {
    afterEach(() => {
        vi.restoreAllMocks();
    });
}
export function mockRunEmbeddedPiAgentOk(text = "ok") {
    const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
    runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text }],
        meta: {
            durationMs: 1,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
    });
    return runEmbeddedPiAgentMock;
}
export function createBlockReplyCollector() {
    const blockReplies = [];
    return {
        blockReplies,
        handlers: {
            onBlockReply: async (payload) => {
                blockReplies.push(payload);
            },
        },
    };
}
