import { WebSocket } from 'ws';
export const extensionConnections = new Map();
export const pendingCdpCommands = new Map();
export let cdpCommandId = 1;
export const userRelayPorts = new Map();
export const usedPorts = new Set();
export const BASE_RELAY_PORT = 18792;
export function getRelayPortForUser(userId) {
    if (userRelayPorts.has(userId))
        return userRelayPorts.get(userId);
    for (let port = BASE_RELAY_PORT; port < BASE_RELAY_PORT + 100; port++) {
        if (!usedPorts.has(port)) {
            usedPorts.add(port);
            userRelayPorts.set(userId, port);
            return port;
        }
    }
    throw new Error('No relay ports available');
}
export function freeRelayPort(userId) {
    const port = userRelayPorts.get(userId);
    if (port) {
        usedPorts.delete(port);
        userRelayPorts.delete(userId);
    }
}
export async function sendCdpCommand(userId, method, params, tabId, timeoutMs = 15000) {
    const ws = extensionConnections.get(userId);
    if (!ws || ws.readyState !== WebSocket.OPEN)
        throw new Error('Extension not connected for this user');
    const id = cdpCommandId++;
    const userPending = pendingCdpCommands.get(userId) || new Map();
    pendingCdpCommands.set(userId, userPending);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            userPending.delete(id);
            reject(new Error(`CDP timeout: ${method}`));
        }, timeoutMs);
        userPending.set(id, {
            resolve: (v) => { clearTimeout(timer); resolve(v); },
            reject: (e) => { clearTimeout(timer); reject(e); }
        });
        ws.send(JSON.stringify({ id, method: 'forwardCDPCommand', params: { method, params, tabId } }));
    });
}
export async function sendExtensionMessage(userId, method, params, timeoutMs = 10000) {
    const ws = extensionConnections.get(userId);
    if (!ws || ws.readyState !== WebSocket.OPEN)
        throw new Error('Extension not connected for this user');
    const id = cdpCommandId++;
    const userPending = pendingCdpCommands.get(userId) || new Map();
    pendingCdpCommands.set(userId, userPending);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            userPending.delete(id);
            reject(new Error(`Extension message timeout: ${method}`));
        }, timeoutMs);
        userPending.set(id, {
            resolve: (v) => { clearTimeout(timer); resolve(v); },
            reject: (e) => { clearTimeout(timer); reject(e); }
        });
        ws.send(JSON.stringify({ id, method, params }));
    });
}
export function isExtensionConnected(userId) {
    const ws = extensionConnections.get(userId);
    return !!ws && ws.readyState === WebSocket.OPEN;
}
