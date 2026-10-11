import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { probeAuthenticatedOpenClawRelay, resolveRelayAcceptedTokensForPort, resolveRelayAuthTokenForPort, } from "./extension-relay-auth.js";
function isLoopbackHost(host) {
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
function isLoopbackAddress(addr) {
    if (!addr)
        return true;
    return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost' || addr.startsWith('::ffff:127.');
}
const RELAY_AUTH_HEADER = "x-openclaw-relay-token";
const DEFAULT_EXTENSION_RECONNECT_GRACE_MS = 20_000;
const DEFAULT_EXTENSION_COMMAND_RECONNECT_WAIT_MS = 3_000;
function headerValue(value) {
    if (!value) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}
function getHeader(req, name) {
    return headerValue(req.headers[name.toLowerCase()]);
}
function getRelayAuthTokenFromRequest(req, url) {
    const headerToken = getHeader(req, RELAY_AUTH_HEADER)?.trim();
    if (headerToken) {
        return headerToken;
    }
    const queryToken = url?.searchParams.get("token")?.trim();
    if (queryToken) {
        return queryToken;
    }
    return undefined;
}
function parseUrlPort(parsed) {
    const port = parsed.port?.trim() !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        return null;
    }
    return port;
}
function parseBaseUrl(raw) {
    const parsed = new URL(raw.trim().replace(/\/$/, ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`extension relay cdpUrl must be http(s), got ${parsed.protocol}`);
    }
    const host = parsed.hostname;
    const port = parseUrlPort(parsed);
    if (!port) {
        throw new Error(`extension relay cdpUrl has invalid port: ${parsed.port || "(empty)"}`);
    }
    return { host, port, baseUrl: parsed.toString().replace(/\/$/, "") };
}
function text(res, status, bodyText) {
    const body = Buffer.from(bodyText);
    res.write(`HTTP/1.1 ${status} ${status === 200 ? "OK" : "ERR"}\r\n` +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${body.length}\r\n` +
        "Connection: close\r\n" +
        "\r\n");
    res.write(body);
    res.end();
}
function rejectUpgrade(socket, status, bodyText) {
    text(socket, status, bodyText);
    try {
        socket.destroy();
    }
    catch {
        // ignore
    }
}
function envMsOrDefault(name, fallback) {
    const raw = process.env[name];
    if (!raw || raw.trim() === "") {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}
const relayRuntimeByPort = new Map();
const relayInitByPort = new Map();
function isAddrInUseError(err) {
    return (typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "EADDRINUSE");
}
function relayAuthTokenForUrl(url) {
    try {
        const parsed = new URL(url);
        if (!isLoopbackHost(parsed.hostname)) {
            return null;
        }
        const port = parseUrlPort(parsed);
        if (!port) {
            return null;
        }
        return relayRuntimeByPort.get(port)?.relayAuthToken ?? null;
    }
    catch {
        return null;
    }
}
export function getChromeExtensionRelayAuthHeaders(url) {
    const token = relayAuthTokenForUrl(url);
    if (!token) {
        return {};
    }
    return { [RELAY_AUTH_HEADER]: token };
}
export async function ensureChromeExtensionRelayServer(opts) {
    const info = parseBaseUrl(opts.cdpUrl);
    if (!isLoopbackHost(info.host)) {
        throw new Error(`extension relay requires loopback cdpUrl host (got ${info.host})`);
    }
    const existing = relayRuntimeByPort.get(info.port);
    if (existing) {
        return existing.server;
    }
    const inFlight = relayInitByPort.get(info.port);
    if (inFlight) {
        return await inFlight;
    }
    const extensionReconnectGraceMs = envMsOrDefault("OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS", DEFAULT_EXTENSION_RECONNECT_GRACE_MS);
    const extensionCommandReconnectWaitMs = envMsOrDefault("OPENCLAW_EXTENSION_RELAY_COMMAND_RECONNECT_WAIT_MS", DEFAULT_EXTENSION_COMMAND_RECONNECT_WAIT_MS);
    const initPromise = (async () => {
        const relayAuthToken = await resolveRelayAuthTokenForPort(info.port);
        const relayAuthTokens = new Set(await resolveRelayAcceptedTokensForPort(info.port));
        let extensionWs = null;
        const cdpClients = new Set();
        const connectedTargets = new Map();
        const extensionConnected = () => extensionWs?.readyState === WebSocket.OPEN;
        const hasConnectedTargets = () => connectedTargets.size > 0;
        let extensionDisconnectCleanupTimer = null;
        const extensionReconnectWaiters = new Set();
        const flushExtensionReconnectWaiters = (connected) => {
            if (extensionReconnectWaiters.size === 0) {
                return;
            }
            const waiters = Array.from(extensionReconnectWaiters);
            extensionReconnectWaiters.clear();
            for (const waiter of waiters) {
                waiter(connected);
            }
        };
        const clearExtensionDisconnectCleanupTimer = () => {
            if (!extensionDisconnectCleanupTimer) {
                return;
            }
            clearTimeout(extensionDisconnectCleanupTimer);
            extensionDisconnectCleanupTimer = null;
        };
        const closeCdpClientsAfterExtensionDisconnect = () => {
            connectedTargets.clear();
            for (const client of cdpClients) {
                try {
                    client.close(1011, "extension disconnected");
                }
                catch {
                    // ignore
                }
            }
            cdpClients.clear();
            flushExtensionReconnectWaiters(false);
        };
        const scheduleExtensionDisconnectCleanup = () => {
            clearExtensionDisconnectCleanupTimer();
            extensionDisconnectCleanupTimer = setTimeout(() => {
                extensionDisconnectCleanupTimer = null;
                if (extensionConnected()) {
                    return;
                }
                closeCdpClientsAfterExtensionDisconnect();
            }, extensionReconnectGraceMs);
        };
        const waitForExtensionReconnect = async (timeoutMs) => {
            if (extensionConnected()) {
                return true;
            }
            return await new Promise((resolve) => {
                let settled = false;
                const waiter = (connected) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timer);
                    extensionReconnectWaiters.delete(waiter);
                    resolve(connected);
                };
                const timer = setTimeout(() => {
                    waiter(false);
                }, timeoutMs);
                extensionReconnectWaiters.add(waiter);
            });
        };
        const pendingExtension = new Map();
        let nextExtensionId = 1;
        const sendToExtension = async (payload) => {
            const ws = extensionWs;
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                throw new Error("Chrome extension not connected");
            }
            ws.send(JSON.stringify(payload));
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pendingExtension.delete(payload.id);
                    reject(new Error(`extension request timeout: ${payload.params.method}`));
                }, 30_000);
                pendingExtension.set(payload.id, { resolve, reject, timer });
            });
        };
        const broadcastToCdpClients = (evt) => {
            const msg = JSON.stringify(evt);
            for (const ws of cdpClients) {
                if (ws.readyState !== WebSocket.OPEN) {
                    continue;
                }
                ws.send(msg);
            }
        };
        const sendResponseToCdp = (ws, res) => {
            if (ws.readyState !== WebSocket.OPEN) {
                return;
            }
            ws.send(JSON.stringify(res));
        };
        const dropConnectedTargetSession = (sessionId) => {
            const existing = connectedTargets.get(sessionId);
            if (!existing) {
                return undefined;
            }
            connectedTargets.delete(sessionId);
            return existing;
        };
        const dropConnectedTargetsByTargetId = (targetId) => {
            const removed = [];
            for (const [sessionId, target] of connectedTargets) {
                if (target.targetId !== targetId) {
                    continue;
                }
                connectedTargets.delete(sessionId);
                removed.push(target);
            }
            return removed;
        };
        const broadcastDetachedTarget = (target, targetId) => {
            broadcastToCdpClients({
                method: "Target.detachedFromTarget",
                params: {
                    sessionId: target.sessionId,
                    targetId: targetId ?? target.targetId,
                },
                sessionId: target.sessionId,
            });
        };
        const isMissingTargetError = (err) => {
            const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
            return (message.includes("target not found") ||
                message.includes("no target with given id") ||
                message.includes("session not found") ||
                message.includes("cannot find session"));
        };
        const pruneStaleTargetsFromCommandFailure = (cmd, err) => {
            if (!isMissingTargetError(err)) {
                return;
            }
            if (cmd.sessionId) {
                const removed = dropConnectedTargetSession(cmd.sessionId);
                if (removed) {
                    broadcastDetachedTarget(removed);
                    return;
                }
            }
            const params = (cmd.params ?? {});
            const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
            if (!targetId) {
                return;
            }
            const removedTargets = dropConnectedTargetsByTargetId(targetId);
            for (const removed of removedTargets) {
                broadcastDetachedTarget(removed, targetId);
            }
        };
        const ensureTargetEventsForClient = (ws, mode) => {
            for (const target of connectedTargets.values()) {
                if (mode === "autoAttach") {
                    ws.send(JSON.stringify({
                        method: "Target.attachedToTarget",
                        params: {
                            sessionId: target.sessionId,
                            targetInfo: { ...target.targetInfo, attached: true },
                            waitingForDebugger: false,
                        },
                    }));
                }
                else {
                    ws.send(JSON.stringify({
                        method: "Target.targetCreated",
                        params: { targetInfo: { ...target.targetInfo, attached: true } },
                    }));
                }
            }
        };
        const routeCdpCommand = async (cmd) => {
            switch (cmd.method) {
                case "Browser.getVersion":
                    return {
                        protocolVersion: "1.3",
                        product: "Chrome/OpenClaw-Extension-Relay",
                        revision: "0",
                        userAgent: "OpenClaw-Extension-Relay",
                        jsVersion: "V8",
                    };
                case "Browser.setDownloadBehavior":
                    return {};
                case "Target.setAutoAttach":
                case "Target.setDiscoverTargets":
                    return {};
                case "Target.getTargets":
                    return {
                        targetInfos: Array.from(connectedTargets.values()).map((t) => ({
                            ...t.targetInfo,
                            attached: true,
                        })),
                    };
                case "Target.getTargetInfo": {
                    const params = (cmd.params ?? {});
                    const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
                    if (targetId) {
                        for (const t of connectedTargets.values()) {
                            if (t.targetId === targetId) {
                                return { targetInfo: t.targetInfo };
                            }
                        }
                    }
                    if (cmd.sessionId && connectedTargets.has(cmd.sessionId)) {
                        const t = connectedTargets.get(cmd.sessionId);
                        if (t) {
                            return { targetInfo: t.targetInfo };
                        }
                    }
                    const first = Array.from(connectedTargets.values())[0];
                    return { targetInfo: first?.targetInfo };
                }
                case "Target.attachToTarget": {
                    const params = (cmd.params ?? {});
                    const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
                    if (!targetId) {
                        throw new Error("targetId required");
                    }
                    for (const t of connectedTargets.values()) {
                        if (t.targetId === targetId) {
                            return { sessionId: t.sessionId };
                        }
                    }
                    throw new Error("target not found");
                }
                default: {
                    const id = nextExtensionId++;
                    return await sendToExtension({
                        id,
                        method: "forwardCDPCommand",
                        params: {
                            method: cmd.method,
                            sessionId: cmd.sessionId,
                            params: cmd.params,
                        },
                    });
                }
            }
        };
        const server = createServer(async (req, res) => {
            const url = new URL(req.url ?? "/", info.baseUrl);
            const path = url.pathname;
            const origin = getHeader(req, "origin");
            const isChromeExtensionOrigin = typeof origin === "string" && origin.startsWith("chrome-extension://");
            if (isChromeExtensionOrigin && origin) {
                // Let extension pages call relay HTTP endpoints cross-origin.
                res.setHeader("Access-Control-Allow-Origin", origin);
                res.setHeader("Vary", "Origin");
            }
            // Handle CORS preflight requests from the browser extension.
            if (req.method === "OPTIONS") {
                if (origin && !isChromeExtensionOrigin) {
                    res.writeHead(403);
                    res.end("Forbidden");
                    return;
                }
                const requestedHeaders = (getHeader(req, "access-control-request-headers") ?? "")
                    .split(",")
                    .map((header) => header.trim().toLowerCase())
                    .filter((header) => header.length > 0);
                const allowedHeaders = new Set(["content-type", RELAY_AUTH_HEADER, ...requestedHeaders]);
                res.writeHead(204, {
                    "Access-Control-Allow-Origin": origin ?? "*",
                    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
                    "Access-Control-Allow-Headers": Array.from(allowedHeaders).join(", "),
                    "Access-Control-Max-Age": "86400",
                    Vary: "Origin, Access-Control-Request-Headers",
                });
                res.end();
                return;
            }
            if (path.startsWith("/json")) {
                const token = getRelayAuthTokenFromRequest(req, url);
                if (!token || !relayAuthTokens.has(token)) {
                    res.writeHead(401);
                    res.end("Unauthorized");
                    return;
                }
            }
            if (req.method === "HEAD" && path === "/") {
                res.writeHead(200);
                res.end();
                return;
            }
            if (path === "/") {
                res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("OK");
                return;
            }
            if (path === "/extension/status") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ connected: extensionConnected() }));
                return;
            }
            const hostHeader = req.headers.host?.trim() || `${info.host}:${info.port}`;
            const wsHost = `ws://${hostHeader}`;
            const cdpWsUrl = `${wsHost}/cdp`;
            if ((path === "/json/version" || path === "/json/version/") &&
                (req.method === "GET" || req.method === "PUT")) {
                const payload = {
                    Browser: "OpenClaw/extension-relay",
                    "Protocol-Version": "1.3",
                };
                // Keep reporting CDP WS while attached targets are cached, so callers can
                // reconnect through brief MV3 worker disconnects.
                if (extensionConnected() || hasConnectedTargets()) {
                    payload.webSocketDebuggerUrl = cdpWsUrl;
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(payload));
                return;
            }
            const listPaths = new Set(["/json", "/json/", "/json/list", "/json/list/"]);
            if (listPaths.has(path) && (req.method === "GET" || req.method === "PUT")) {
                const list = Array.from(connectedTargets.values()).map((t) => ({
                    id: t.targetId,
                    type: t.targetInfo.type ?? "page",
                    title: t.targetInfo.title ?? "",
                    description: t.targetInfo.title ?? "",
                    url: t.targetInfo.url ?? "",
                    webSocketDebuggerUrl: cdpWsUrl,
                    devtoolsFrontendUrl: `/devtools/inspector.html?ws=${cdpWsUrl.replace("ws://", "")}`,
                }));
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(list));
                return;
            }
            // AI Snapshot endpoint — returns structured accessibility snapshot
            if (path === '/ai-snapshot' && req.method === 'GET') {
                // Auth check — same token as relay
                const token = getRelayAuthTokenFromRequest(req, new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`));
                const acceptedTokens = await resolveRelayAcceptedTokensForPort(info.port).catch(() => []);
                const validTokens = new Set(acceptedTokens);
                if (validTokens.size > 0 && (!token || !validTokens.has(token))) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                if (!extensionConnected()) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Extension not connected' }));
                    return;
                }
                try {
                    // Enable accessibility
                    await sendToExtension({
                        id: nextExtensionId++,
                        method: 'forwardCDPCommand',
                        params: { method: 'Accessibility.enable', params: {} }
                    }).catch(() => { });
                    // Get full AX tree
                    const axResult = await sendToExtension({
                        id: nextExtensionId++,
                        method: 'forwardCDPCommand',
                        params: { method: 'Accessibility.getFullAXTree', params: {} }
                    });
                    const nodes = axResult?.nodes ?? [];
                    // Build depth map
                    const nodeMap = new Map();
                    for (const n of nodes) {
                        if (n.nodeId)
                            nodeMap.set(n.nodeId, n);
                    }
                    const depthMap = new Map();
                    function getDepth(nodeId, visited = new Set()) {
                        if (depthMap.has(nodeId))
                            return depthMap.get(nodeId);
                        if (visited.has(nodeId))
                            return 0;
                        visited.add(nodeId);
                        const node = nodeMap.get(nodeId);
                        if (!node?.parentId) {
                            depthMap.set(nodeId, 0);
                            return 0;
                        }
                        const d = getDepth(node.parentId, visited) + 1;
                        depthMap.set(nodeId, d);
                        return d;
                    }
                    for (const n of nodes) {
                        if (n.nodeId)
                            getDepth(n.nodeId);
                    }
                    // Format as indented text — same format buildRoleSnapshotFromAriaSnapshot expects
                    const SKIP_ROLES = new Set(['none', 'presentation', 'generic', 'InlineTextBox', 'StaticText']);
                    const lines = [];
                    for (const n of nodes) {
                        if (!n.nodeId)
                            continue;
                        if (n.ignored)
                            continue;
                        const role = String(n.role?.value ?? '').trim();
                        if (!role || SKIP_ROLES.has(role))
                            continue;
                        const name = String(n.name?.value ?? '').trim();
                        const depth = depthMap.get(n.nodeId) ?? 0;
                        const indent = '  '.repeat(Math.min(depth, 10));
                        let line = `${indent}- ${role}`;
                        if (name)
                            line += ` "${name}"`;
                        const isDisabled = n.disabled?.value === true;
                        if (isDisabled)
                            line += ` [disabled]`;
                        lines.push(line);
                    }
                    const snapshot = lines.join('\n') || '(empty)';
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, snapshot }));
                }
                catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: String(err) }));
                }
                return;
            }
            // Type input via CDP — bypasses Playwright relay limitations for dialog inputs
            if (path === '/type-input' && req.method === 'POST') {
                const token = getRelayAuthTokenFromRequest(req, new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`));
                const acceptedTokens = await resolveRelayAcceptedTokensForPort(info.port).catch(() => []);
                const validTokens = new Set(acceptedTokens);
                if (validTokens.size > 0 && (!token || !validTokens.has(token))) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                if (!extensionConnected()) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Extension not connected' }));
                    return;
                }
                try {
                    let body = '';
                    await new Promise(resolve => {
                        req.on('data', (chunk) => { body += chunk.toString(); });
                        req.on('end', resolve);
                    });
                    const { text, selector } = JSON.parse(body || '{}');
                    if (!text) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'text required' }));
                        return;
                    }
                    // Get tabId from connected targets
                    const target = Array.from(connectedTargets.values())[0];
                    if (!target)
                        throw new Error('No connected tab');
                    const tabIdResult = await sendToExtension({
                        id: nextExtensionId++,
                        method: 'getTabIdForTarget',
                        params: { targetId: target.targetId }
                    });
                    const tabId = tabIdResult?.tabId;
                    if (!tabId)
                        throw new Error('Could not get tabId from target');
                    // Send executeDebugger message to extension
                    // Extension uses chrome.debugger.sendCommand directly — bypasses relay
                    const cmdId = nextExtensionId++;
                    const result = await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => {
                            pendingExtension.delete(cmdId);
                            reject(new Error('executeDebugger timeout after 15s'));
                        }, 15000);
                        pendingExtension.set(cmdId, {
                            resolve: (v) => { clearTimeout(timer); resolve(v); },
                            reject: (e) => { clearTimeout(timer); reject(e); },
                            timer
                        });
                        extensionWs.send(JSON.stringify({
                            id: cmdId,
                            method: 'executeDebugger',
                            params: { tabId, selector, text }
                        }));
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, typed: text, result }));
                }
                catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: String(err) }));
                }
                return;
            }
            if (path === '/click-submit' && req.method === 'POST') {
                const token = getRelayAuthTokenFromRequest(req, new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`));
                const acceptedTokens = await resolveRelayAcceptedTokensForPort(info.port).catch(() => []);
                const validTokens = new Set(acceptedTokens);
                if (validTokens.size > 0 && (!token || !validTokens.has(token))) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                if (!extensionConnected()) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Extension not connected' }));
                    return;
                }
                try {
                    let body = '';
                    await new Promise(resolve => {
                        req.on('data', (chunk) => { body += chunk.toString(); });
                        req.on('end', resolve);
                    });
                    const { selector } = JSON.parse(body || '{}');
                    const target = Array.from(connectedTargets.values())[0];
                    if (!target)
                        throw new Error('No connected tab');
                    const tabIdResult = await sendToExtension({
                        id: nextExtensionId++,
                        method: 'getTabIdForTarget',
                        params: { targetId: target.targetId }
                    });
                    const tabId = tabIdResult?.tabId;
                    if (!tabId)
                        throw new Error('Could not get tabId');
                    const cmdId = nextExtensionId++;
                    const result = await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => {
                            pendingExtension.delete(cmdId);
                            reject(new Error('clickSubmit timeout'));
                        }, 10000);
                        pendingExtension.set(cmdId, {
                            resolve: (v) => { clearTimeout(timer); resolve(v); },
                            reject: (e) => { clearTimeout(timer); reject(e); },
                            timer
                        });
                        extensionWs.send(JSON.stringify({
                            id: cmdId,
                            method: 'clickSubmitDebugger',
                            params: { tabId, selector }
                        }));
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, result }));
                }
                catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: String(err) }));
                }
                return;
            }
            const handleTargetActionRoute = (match, cdpMethod) => {
                if (!match || (req.method !== "GET" && req.method !== "PUT")) {
                    return false;
                }
                let targetId = "";
                try {
                    targetId = decodeURIComponent(match[1] ?? "").trim();
                }
                catch {
                    res.writeHead(400);
                    res.end("invalid targetId encoding");
                    return true;
                }
                if (!targetId) {
                    res.writeHead(400);
                    res.end("targetId required");
                    return true;
                }
                void (async () => {
                    try {
                        await sendToExtension({
                            id: nextExtensionId++,
                            method: "forwardCDPCommand",
                            params: { method: cdpMethod, params: { targetId } },
                        });
                    }
                    catch {
                        // ignore
                    }
                })();
                res.writeHead(200);
                res.end("OK");
                return true;
            };
            if (handleTargetActionRoute(path.match(/^\/json\/activate\/(.+)$/), "Target.activateTarget")) {
                return;
            }
            if (handleTargetActionRoute(path.match(/^\/json\/close\/(.+)$/), "Target.closeTarget")) {
                return;
            }
            res.writeHead(404);
            res.end("not found");
        });
        const wssExtension = new WebSocketServer({ noServer: true });
        const wssCdp = new WebSocketServer({ noServer: true });
        server.on("upgrade", (req, socket, head) => {
            const url = new URL(req.url ?? "/", info.baseUrl);
            const pathname = url.pathname;
            const remote = req.socket.remoteAddress;
            if (!isLoopbackAddress(remote)) {
                rejectUpgrade(socket, 403, "Forbidden");
                return;
            }
            const origin = headerValue(req.headers.origin);
            if (origin && !origin.startsWith("chrome-extension://")) {
                rejectUpgrade(socket, 403, "Forbidden: invalid origin");
                return;
            }
            if (pathname === "/extension") {
                const token = getRelayAuthTokenFromRequest(req, url);
                if (!token || !relayAuthTokens.has(token)) {
                    rejectUpgrade(socket, 401, "Unauthorized");
                    return;
                }
                // MV3 worker reconnect races can leave a stale non-OPEN socket reference.
                if (extensionWs && extensionWs.readyState !== WebSocket.OPEN) {
                    try {
                        extensionWs.terminate();
                    }
                    catch {
                        // ignore
                    }
                    extensionWs = null;
                }
                if (extensionConnected()) {
                    rejectUpgrade(socket, 409, "Extension already connected");
                    return;
                }
                wssExtension.handleUpgrade(req, socket, head, (ws) => {
                    wssExtension.emit("connection", ws, req);
                });
                return;
            }
            if (pathname === "/cdp") {
                const token = getRelayAuthTokenFromRequest(req, url);
                if (!token || !relayAuthTokens.has(token)) {
                    rejectUpgrade(socket, 401, "Unauthorized");
                    return;
                }
                // Allow CDP clients to connect even during brief extension worker drops.
                // Individual commands already wait briefly for extension reconnect.
                wssCdp.handleUpgrade(req, socket, head, (ws) => {
                    wssCdp.emit("connection", ws, req);
                });
                return;
            }
            rejectUpgrade(socket, 404, "Not Found");
        });
        wssExtension.on("connection", (ws) => {
            extensionWs = ws;
            clearExtensionDisconnectCleanupTimer();
            flushExtensionReconnectWaiters(true);
            const ping = setInterval(() => {
                if (ws.readyState !== WebSocket.OPEN) {
                    return;
                }
                ws.send(JSON.stringify({ method: "ping" }));
            }, 10000);
            ws.on("message", (data) => {
                if (extensionWs !== ws) {
                    return;
                }
                let parsed = null;
                try {
                    parsed = JSON.parse(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '');
                }
                catch {
                    return;
                }
                if (parsed &&
                    typeof parsed === "object" &&
                    "id" in parsed &&
                    typeof parsed.id === "number") {
                    const pending = pendingExtension.get(parsed.id);
                    if (!pending) {
                        return;
                    }
                    pendingExtension.delete(parsed.id);
                    clearTimeout(pending.timer);
                    if ("error" in parsed && typeof parsed.error === "string" && parsed.error.trim()) {
                        pending.reject(new Error(parsed.error));
                    }
                    else {
                        pending.resolve(parsed.result);
                    }
                    return;
                }
                if (parsed && typeof parsed === "object" && "method" in parsed) {
                    if (parsed.method === "pong") {
                        return;
                    }
                    if (parsed.method !== "forwardCDPEvent") {
                        return;
                    }
                    const evt = parsed;
                    const method = evt.params?.method;
                    const params = evt.params?.params;
                    const sessionId = evt.params?.sessionId;
                    if (!method || typeof method !== "string") {
                        return;
                    }
                    if (method === "Target.attachedToTarget") {
                        const attached = (params ?? {});
                        const targetType = attached?.targetInfo?.type ?? "page";
                        if (targetType !== "page") {
                            return;
                        }
                        if (attached?.sessionId && attached?.targetInfo?.targetId) {
                            const newSessionId = attached.sessionId;
                            const newTargetId = attached.targetInfo.targetId;
                            const prevSameSession = connectedTargets.get(newSessionId);
                            // Find any existing entry for the same targetId under a DIFFERENT session.
                            // This happens when the extension re-attaches to a tab (new sessionId, same
                            // targetId). Without this check, Playwright receives Target.attachedToTarget
                            // for a targetId already in its _targetRegistry → "Duplicate target" crash.
                            let staleSessionId;
                            for (const [sid, t] of connectedTargets) {
                                if (t.targetId === newTargetId && sid !== newSessionId) {
                                    staleSessionId = sid;
                                    break;
                                }
                            }
                            // Pure duplicate: same session, same targetId — just refresh metadata, no broadcast
                            if (prevSameSession && prevSameSession.targetId === newTargetId) {
                                connectedTargets.set(newSessionId, { sessionId: newSessionId, targetId: newTargetId, targetInfo: attached.targetInfo });
                                return;
                            }
                            // Same session, different targetId: detach old target first.
                            // IMPORTANT: no top-level sessionId → routes to Playwright's root CRSession
                            // where CRBrowser._onDetachedFromTarget is registered. If we set sessionId
                            // to the stale session, the event goes to that CRSession's handler (which
                            // doesn't listen for detach) and _targetRegistry is never updated.
                            if (prevSameSession && prevSameSession.targetId !== newTargetId) {
                                broadcastToCdpClients({
                                    method: "Target.detachedFromTarget",
                                    params: { sessionId: newSessionId, targetId: prevSameSession.targetId },
                                });
                            }
                            // Different session, same targetId: detach the stale session so Playwright
                            // removes the targetId from its registry before we re-add it below
                            if (staleSessionId) {
                                connectedTargets.delete(staleSessionId);
                                broadcastToCdpClients({
                                    method: "Target.detachedFromTarget",
                                    params: { sessionId: staleSessionId, targetId: newTargetId },
                                });
                            }
                            connectedTargets.set(newSessionId, { sessionId: newSessionId, targetId: newTargetId, targetInfo: attached.targetInfo });
                            broadcastToCdpClients({ method, params, sessionId });
                            return;
                        }
                    }
                    if (method === "Target.detachedFromTarget") {
                        const detached = (params ?? {});
                        if (detached?.sessionId) {
                            dropConnectedTargetSession(detached.sessionId);
                        }
                        else if (detached?.targetId) {
                            dropConnectedTargetsByTargetId(detached.targetId);
                        }
                        broadcastToCdpClients({ method, params, sessionId });
                        return;
                    }
                    if (method === "Target.targetDestroyed" || method === "Target.targetCrashed") {
                        const targetEvent = (params ?? {});
                        if (targetEvent.targetId) {
                            dropConnectedTargetsByTargetId(targetEvent.targetId);
                        }
                        broadcastToCdpClients({ method, params, sessionId });
                        return;
                    }
                    // Keep cached tab metadata fresh for /json/list.
                    // After navigation, Chrome updates URL/title via Target.targetInfoChanged.
                    if (method === "Target.targetInfoChanged") {
                        const changed = (params ?? {});
                        const targetInfo = changed?.targetInfo;
                        const targetId = targetInfo?.targetId;
                        if (targetId && (targetInfo?.type ?? "page") === "page") {
                            for (const [sid, target] of connectedTargets) {
                                if (target.targetId !== targetId) {
                                    continue;
                                }
                                connectedTargets.set(sid, {
                                    ...target,
                                    targetInfo: { ...target.targetInfo, ...targetInfo },
                                });
                            }
                        }
                    }
                    broadcastToCdpClients({ method, params, sessionId });
                }
            });
            ws.on("close", () => {
                clearInterval(ping);
                if (extensionWs !== ws) {
                    return;
                }
                extensionWs = null;
                for (const [, pending] of pendingExtension) {
                    clearTimeout(pending.timer);
                    pending.reject(new Error("extension disconnected"));
                }
                pendingExtension.clear();
                scheduleExtensionDisconnectCleanup();
            });
        });
        wssCdp.on("connection", (ws) => {
            cdpClients.add(ws);
            ws.on("message", async (data) => {
                let cmd = null;
                try {
                    cmd = JSON.parse(typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '');
                }
                catch {
                    return;
                }
                if (!cmd || typeof cmd !== "object") {
                    return;
                }
                if (typeof cmd.id !== "number" || typeof cmd.method !== "string") {
                    return;
                }
                if (!extensionConnected()) {
                    const reconnected = await waitForExtensionReconnect(extensionCommandReconnectWaitMs);
                    if (!reconnected || !extensionConnected()) {
                        sendResponseToCdp(ws, {
                            id: cmd.id,
                            sessionId: cmd.sessionId,
                            error: { message: "Extension not connected" },
                        });
                        return;
                    }
                }
                try {
                    const result = await routeCdpCommand(cmd);
                    if (cmd.method === "Target.setAutoAttach" && !cmd.sessionId) {
                        ensureTargetEventsForClient(ws, "autoAttach");
                    }
                    if (cmd.method === "Target.setDiscoverTargets") {
                        const discover = (cmd.params ?? {});
                        if (discover.discover === true) {
                            ensureTargetEventsForClient(ws, "discover");
                        }
                    }
                    // NOTE: do NOT send a Target.attachedToTarget event here.
                    // The reply already carries the sessionId Playwright needs for newCDPSession.
                    // Sending the event causes CRBrowser._onAttachedToTarget to fire a second time
                    // for a targetId already in _targetRegistry → "Duplicate target" assertion crash.
                    sendResponseToCdp(ws, { id: cmd.id, sessionId: cmd.sessionId, result });
                }
                catch (err) {
                    pruneStaleTargetsFromCommandFailure(cmd, err);
                    sendResponseToCdp(ws, {
                        id: cmd.id,
                        sessionId: cmd.sessionId,
                        error: { message: err instanceof Error ? err.message : String(err) },
                    });
                }
            });
            ws.on("close", () => {
                cdpClients.delete(ws);
            });
        });
        try {
            await new Promise((resolve, reject) => {
                server.listen(info.port, info.host, () => resolve());
                server.once("error", reject);
            });
        }
        catch (err) {
            if (isAddrInUseError(err) &&
                (await probeAuthenticatedOpenClawRelay({
                    baseUrl: info.baseUrl,
                    relayAuthHeader: RELAY_AUTH_HEADER,
                    relayAuthToken,
                }))) {
                const existingRelay = {
                    host: info.host,
                    port: info.port,
                    baseUrl: info.baseUrl,
                    cdpWsUrl: `ws://${info.host}:${info.port}/cdp`,
                    extensionConnected: () => false,
                    stop: async () => {
                        relayRuntimeByPort.delete(info.port);
                    },
                };
                relayRuntimeByPort.set(info.port, { server: existingRelay, relayAuthToken });
                return existingRelay;
            }
            throw err;
        }
        const addr = server.address();
        const port = addr?.port ?? info.port;
        const host = info.host;
        const baseUrl = `${new URL(info.baseUrl).protocol}//${host}:${port}`;
        const relay = {
            host,
            port,
            baseUrl,
            cdpWsUrl: `ws://${host}:${port}/cdp`,
            extensionConnected,
            stop: async () => {
                relayRuntimeByPort.delete(port);
                clearExtensionDisconnectCleanupTimer();
                flushExtensionReconnectWaiters(false);
                for (const [, pending] of pendingExtension) {
                    clearTimeout(pending.timer);
                    pending.reject(new Error("server stopping"));
                }
                pendingExtension.clear();
                try {
                    extensionWs?.close(1001, "server stopping");
                }
                catch {
                    // ignore
                }
                for (const ws of cdpClients) {
                    try {
                        ws.close(1001, "server stopping");
                    }
                    catch {
                        // ignore
                    }
                }
                await new Promise((resolve) => {
                    server.close(() => resolve());
                });
                wssExtension.close();
                wssCdp.close();
            },
        };
        relayRuntimeByPort.set(port, { server: relay, relayAuthToken });
        return relay;
    })();
    relayInitByPort.set(info.port, initPromise);
    try {
        return await initPromise;
    }
    finally {
        relayInitByPort.delete(info.port);
    }
}
export async function stopChromeExtensionRelayServer(opts) {
    const info = parseBaseUrl(opts.cdpUrl);
    const existing = relayRuntimeByPort.get(info.port);
    if (!existing) {
        return false;
    }
    await existing.server.stop();
    return true;
}
