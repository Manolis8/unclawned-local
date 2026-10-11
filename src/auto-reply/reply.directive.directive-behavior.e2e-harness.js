import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { loadSessionStore } from "../config/sessions.js";
export { loadModelCatalog } from "../agents/model-catalog.js";
export { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
export const MAIN_SESSION_KEY = "agent:main:main";
export const DEFAULT_TEST_MODEL_CATALOG = [
    { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
    { id: "claude-sonnet-4-1", name: "Sonnet 4.1", provider: "anthropic" },
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
];
export function replyText(res) {
    if (Array.isArray(res)) {
        return typeof res[0]?.text === "string" ? res[0]?.text : undefined;
    }
    return typeof res?.text === "string" ? res.text : undefined;
}
export function replyTexts(res) {
    const payloads = Array.isArray(res) ? res : [res];
    return payloads
        .map((entry) => (typeof entry?.text === "string" ? entry.text : undefined))
        .filter((value) => Boolean(value));
}
export function makeEmbeddedTextResult(text = "done") {
    return {
        payloads: [{ text }],
        meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
    };
}
export function mockEmbeddedTextResult(text = "done") {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue(makeEmbeddedTextResult(text));
}
export async function withTempHome(fn) {
    return withTempHomeBase(async (home) => {
        return await fn(home);
    }, {
        env: {
            OPENCLAW_AGENT_DIR: (home) => path.join(home, ".openclaw", "agent"),
            PI_CODING_AGENT_DIR: (home) => path.join(home, ".openclaw", "agent"),
        },
        prefix: "openclaw-reply-",
    });
}
export function sessionStorePath(home) {
    return path.join(home, "sessions.json");
}
export function makeWhatsAppDirectiveConfig(home, defaults, extra = {}) {
    return {
        agents: {
            defaults: {
                workspace: path.join(home, "openclaw"),
                ...defaults,
            },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: sessionStorePath(home) },
        ...extra,
    };
}
export const AUTHORIZED_WHATSAPP_COMMAND = {
    From: "+1222",
    To: "+1222",
    Provider: "whatsapp",
    SenderE164: "+1222",
    CommandAuthorized: true,
};
export function makeElevatedDirectiveConfig(home) {
    return makeWhatsAppDirectiveConfig(home, {
        model: "anthropic/claude-opus-4-5",
        elevatedDefault: "on",
    }, {
        tools: {
            elevated: {
                allowFrom: { whatsapp: ["+1222"] },
            },
        },
        channels: { whatsapp: { allowFrom: ["+1222"] } },
        session: { store: sessionStorePath(home) },
    });
}
export function assertModelSelection(storePath, selection = {}) {
    const store = loadSessionStore(storePath);
    const entry = store[MAIN_SESSION_KEY];
    expect(entry).toBeDefined();
    expect(entry?.modelOverride).toBe(selection.model);
    expect(entry?.providerOverride).toBe(selection.provider);
}
export function assertElevatedOffStatusReply(text) {
    expect(text).toContain("Elevated mode disabled.");
    const optionsLine = text?.split("\n").find((line) => line.trim().startsWith("⚙️"));
    expect(optionsLine).toBeTruthy();
    expect(optionsLine).not.toContain("elevated");
}
export function installDirectiveBehaviorE2EHooks() {
    beforeEach(() => {
        vi.mocked(runEmbeddedPiAgent).mockReset();
        vi.mocked(loadModelCatalog).mockResolvedValue(DEFAULT_TEST_MODEL_CATALOG);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
}
export function makeRestrictedElevatedDisabledConfig(home) {
    return {
        agents: {
            defaults: {
                model: "anthropic/claude-opus-4-5",
                workspace: path.join(home, "openclaw"),
            },
            list: [
                {
                    id: "restricted",
                    tools: {
                        elevated: { enabled: false },
                    },
                },
            ],
        },
        tools: {
            elevated: {
                allowFrom: { whatsapp: ["+1222"] },
            },
        },
        channels: { whatsapp: { allowFrom: ["+1222"] } },
        session: { store: path.join(home, "sessions.json") },
    };
}
