import { resolveSessionAgentId } from "../../agents/agent-scope.js";
function buildSessionHookContext(params) {
    return {
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg }),
    };
}
export function buildSessionStartHookPayload(params) {
    return {
        event: {
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            resumedFrom: params.resumedFrom,
        },
        context: buildSessionHookContext({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            cfg: params.cfg,
        }),
    };
}
export function buildSessionEndHookPayload(params) {
    return {
        event: {
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            messageCount: params.messageCount ?? 0,
        },
        context: buildSessionHookContext({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            cfg: params.cfg,
        }),
    };
}
