import { createHmac } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ensureChromeExtensionRelayServer } from '../browser/extension-relay.js';
import { extensionConnections, pendingCdpCommands, getRelayPortForUser, freeRelayPort, } from './extension-state.js';
import { db } from './db.js';
function deriveRelayToken(gatewayToken, port) {
    return createHmac('sha256', gatewayToken)
        .update(`openclaw-extension-relay-v1:${port}`)
        .digest('hex');
}
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const wsConnectionsPerIp = new Map();
const WS_MAX_CONNECTIONS = 10;
const WS_WINDOW_MS = 60 * 1000;
function checkWsRateLimit(ip) {
    const now = Date.now();
    const record = wsConnectionsPerIp.get(ip);
    if (!record || now - record.windowStart > WS_WINDOW_MS) {
        wsConnectionsPerIp.set(ip, { count: 1, windowStart: now });
        return true;
    }
    if (record.count >= WS_MAX_CONNECTIONS)
        return false;
    record.count++;
    return true;
}
export function startExtensionWsServer(server, onExtensionConnected) {
    const wss = new WebSocketServer({ noServer: true });
    const relayBridges = new Map();
    server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url || '', 'http://localhost');
        if (url.pathname === '/extension') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        }
        else {
            socket.destroy();
        }
    });
    wss.on('connection', async (ws, req) => {
        const clientIp = req.socket.remoteAddress || 'unknown';
        if (!checkWsRateLimit(clientIp)) {
            console.log(`WS rate limit exceeded for IP: ${clientIp}`);
            ws.close(1008, 'Rate limit exceeded');
            return;
        }
        const isLoopback = LOOPBACK_ADDRS.has(clientIp);
        const url = new URL(req.url || '', 'http://localhost');
        const token = url.searchParams.get('token');
        let userId;
        if (!token) {
            // No-token path: only allow from loopback — prevents LAN connections
            if (!isLoopback) {
                ws.close(1008, 'Token required');
                return;
            }
            userId = 'local';
            try {
                db.prepare("INSERT OR IGNORE INTO api_keys (user_id, key) VALUES ('local', 'local')").run();
            }
            catch { }
            // local mode — no log needed, cli.ts announces it
        }
        else {
            const row = db.prepare('SELECT user_id FROM api_keys WHERE key = ?').get(token);
            if (row) {
                userId = row.user_id;
                // announced by cli.ts
            }
            else {
                // Unknown token — auto-register only from loopback (first-time setup)
                if (!isLoopback) {
                    ws.close(1008, 'Invalid token');
                    return;
                }
                userId = 'local';
                try {
                    db.prepare("INSERT OR IGNORE INTO api_keys (user_id, key) VALUES (?, ?)").run(userId, token);
                }
                catch { }
                // auto-registered silently
            }
        }
        const existing = extensionConnections.get(userId);
        if (existing?.readyState === WebSocket.OPEN) {
            existing.close(1000, 'Replaced by new connection');
        }
        extensionConnections.set(userId, ws);
        pendingCdpCommands.set(userId, new Map());
        const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';
        const relayPort = getRelayPortForUser(userId);
        const relayToken = deriveRelayToken(gatewayToken, relayPort);
        try {
            const relay = await ensureChromeExtensionRelayServer({ cdpUrl: `http://127.0.0.1:${relayPort}` });
            // relay ready
        }
        catch (err) {
            console.error(`Failed to start extension relay:`, err);
            ws.send(JSON.stringify({ method: 'error', params: { message: 'Relay failed to start — browser tasks will not work.' } }));
            // Keep connection open; non-browser tasks still work
        }
        const existingBridge = relayBridges.get(userId);
        if (existingBridge) {
            existingBridge.close();
            relayBridges.delete(userId);
            await new Promise(r => setTimeout(r, 500));
        }
        const relayExtUrl = `ws://127.0.0.1:${relayPort}/extension?token=${encodeURIComponent(relayToken)}`;
        const relayWs = new WebSocket(relayExtUrl);
        relayBridges.set(userId, relayWs);
        relayWs.on('open', () => { });
        relayWs.on('error', (err) => console.error(`[relay] error for ${userId}:`, err.message));
        relayWs.on('close', () => {
            relayBridges.delete(userId);
        });
        relayWs.on('message', (data) => {
            const text = data instanceof Buffer ? data.toString() : String(data);
            if (ws.readyState === WebSocket.OPEN)
                ws.send(text);
        });
        if (onExtensionConnected)
            onExtensionConnected(userId);
        ws.send(JSON.stringify({ method: 'connected', params: { userId } }));
        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ method: 'ping' }));
        }, 25000);
        ws.on('message', (data) => {
            const text = data instanceof Buffer ? data.toString() : String(data);
            try {
                const msg = JSON.parse(text);
                if (msg.method === 'pong')
                    return;
                if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
                    const userPending = pendingCdpCommands.get(userId);
                    const pending = userPending?.get(msg.id);
                    if (pending) {
                        userPending.delete(msg.id);
                        if (msg.error)
                            pending.reject(new Error(String(msg.error)));
                        else
                            pending.resolve(msg.result);
                        return;
                    }
                }
                if (relayWs.readyState === WebSocket.OPEN)
                    relayWs.send(text);
            }
            catch (err) {
                console.error('Extension message error:', err);
            }
        });
        ws.on('close', () => {
            clearInterval(pingInterval);
            if (extensionConnections.get(userId) === ws) {
                extensionConnections.delete(userId);
                pendingCdpCommands.delete(userId);
            }
            const bridge = relayBridges.get(userId);
            if (bridge) {
                bridge.close();
                relayBridges.delete(userId);
            }
            freeRelayPort(userId);
            console.log(`Extension disconnected: ${userId} (total: ${extensionConnections.size})`);
        });
        ws.on('error', (err) => console.error(`WS error for ${userId}:`, err));
    });
}
