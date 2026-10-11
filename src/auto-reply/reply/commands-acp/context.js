import { buildTelegramTopicConversationId, parseTelegramChatIdFromTarget, } from "../../../acp/conversation-id.js";
import { DISCORD_THREAD_BINDING_CHANNEL } from "../../../channels/thread-bindings-policy.js";
import { resolveConversationIdFromTargets } from "../../../infra/outbound/conversation-id.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { resolveTelegramConversationId } from "../telegram-context.js";
function normalizeString(value) {
    if (typeof value === "string") {
        return value.trim();
    }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
        return `${value}`.trim();
    }
    return "";
}
export function resolveAcpCommandChannel(params) {
    const raw = params.ctx.OriginatingChannel ??
        params.command.channel ??
        params.ctx.Surface ??
        params.ctx.Provider;
    return normalizeString(raw).toLowerCase();
}
export function resolveAcpCommandAccountId(params) {
    const accountId = normalizeString(params.ctx.AccountId);
    return accountId || "default";
}
export function resolveAcpCommandThreadId(params) {
    const threadId = params.ctx.MessageThreadId != null ? normalizeString(String(params.ctx.MessageThreadId)) : "";
    return threadId || undefined;
}
export function resolveAcpCommandConversationId(params) {
    const channel = resolveAcpCommandChannel(params);
    if (channel === "telegram") {
        const telegramConversationId = resolveTelegramConversationId({
            ctx: {
                MessageThreadId: params.ctx.MessageThreadId,
                OriginatingTo: params.ctx.OriginatingTo,
                To: params.ctx.To,
            },
            command: {
                to: params.command.to,
            },
        });
        if (telegramConversationId) {
            return telegramConversationId;
        }
        const threadId = resolveAcpCommandThreadId(params);
        const parentConversationId = resolveAcpCommandParentConversationId(params);
        if (threadId && parentConversationId) {
            return (buildTelegramTopicConversationId({
                chatId: parentConversationId,
                topicId: threadId,
            }) ?? threadId);
        }
    }
    return resolveConversationIdFromTargets({
        threadId: params.ctx.MessageThreadId,
        targets: [params.ctx.OriginatingTo, params.command.to, params.ctx.To],
    });
}
function parseDiscordParentChannelFromSessionKey(raw) {
    const sessionKey = normalizeString(raw);
    if (!sessionKey) {
        return undefined;
    }
    const scoped = parseAgentSessionKey(sessionKey)?.rest ?? sessionKey.toLowerCase();
    const match = scoped.match(/(?:^|:)channel:([^:]+)$/);
    if (!match?.[1]) {
        return undefined;
    }
    return match[1];
}
function parseDiscordParentChannelFromContext(raw) {
    const parentId = normalizeString(raw);
    if (!parentId) {
        return undefined;
    }
    return parentId;
}
export function resolveAcpCommandParentConversationId(params) {
    const channel = resolveAcpCommandChannel(params);
    if (channel === "telegram") {
        return (parseTelegramChatIdFromTarget(params.ctx.OriginatingTo) ??
            parseTelegramChatIdFromTarget(params.command.to) ??
            parseTelegramChatIdFromTarget(params.ctx.To));
    }
    if (channel === DISCORD_THREAD_BINDING_CHANNEL) {
        const threadId = resolveAcpCommandThreadId(params);
        if (!threadId) {
            return undefined;
        }
        const fromContext = parseDiscordParentChannelFromContext(params.ctx.ThreadParentId);
        if (fromContext && fromContext !== threadId) {
            return fromContext;
        }
        const fromParentSession = parseDiscordParentChannelFromSessionKey(params.ctx.ParentSessionKey);
        if (fromParentSession && fromParentSession !== threadId) {
            return fromParentSession;
        }
        const fromTargets = resolveConversationIdFromTargets({
            targets: [params.ctx.OriginatingTo, params.command.to, params.ctx.To],
        });
        if (fromTargets && fromTargets !== threadId) {
            return fromTargets;
        }
    }
    return undefined;
}
export function isAcpCommandDiscordChannel(params) {
    return resolveAcpCommandChannel(params) === DISCORD_THREAD_BINDING_CHANNEL;
}
export function resolveAcpCommandBindingContext(params) {
    const parentConversationId = resolveAcpCommandParentConversationId(params);
    return {
        channel: resolveAcpCommandChannel(params),
        accountId: resolveAcpCommandAccountId(params),
        threadId: resolveAcpCommandThreadId(params),
        conversationId: resolveAcpCommandConversationId(params),
        ...(parentConversationId ? { parentConversationId } : {}),
    };
}
