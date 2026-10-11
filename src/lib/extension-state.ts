import { WebSocket } from 'ws'

export const extensionConnections = new Map<string, WebSocket>()
export const pendingCdpCommands = new Map<string, Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>>()
export let cdpCommandId = 1
export const userRelayPorts = new Map<string, number>()
export const usedPorts = new Set<number>()
export const BASE_RELAY_PORT = 18792

export function getRelayPortForUser(userId: string): number {
  if (userRelayPorts.has(userId)) return userRelayPorts.get(userId)!
  for (let port = BASE_RELAY_PORT; port < BASE_RELAY_PORT + 100; port++) {
    if (!usedPorts.has(port)) {
      usedPorts.add(port)
      userRelayPorts.set(userId, port)
      return port
    }
  }
  throw new Error('No relay ports available')
}

export function freeRelayPort(userId: string) {
  const port = userRelayPorts.get(userId)
  if (port) {
    usedPorts.delete(port)
    userRelayPorts.delete(userId)
  }
}

export async function sendCdpCommand(
  userId: string,
  method: string,
  params?: object,
  tabId?: number,
  timeoutMs = 15000
): Promise<any> {
  const ws = extensionConnections.get(userId)
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Extension not connected for this user')
  const id = cdpCommandId++
  const userPending = pendingCdpCommands.get(userId) || new Map()
  pendingCdpCommands.set(userId, userPending)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      userPending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, timeoutMs)
    userPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) }
    })
    ws.send(JSON.stringify({ id, method: 'forwardCDPCommand', params: { method, params, tabId } }))
  })
}

export async function sendExtensionMessage(
  userId: string,
  method: string,
  params?: object,
  timeoutMs = 10000
): Promise<any> {
  const ws = extensionConnections.get(userId)
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Extension not connected for this user')
  const id = cdpCommandId++
  const userPending = pendingCdpCommands.get(userId) || new Map()
  pendingCdpCommands.set(userId, userPending)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      userPending.delete(id)
      reject(new Error(`Extension message timeout: ${method}`))
    }, timeoutMs)
    userPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) }
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

export function isExtensionConnected(userId: string): boolean {
  const ws = extensionConnections.get(userId)
  return !!ws && ws.readyState === WebSocket.OPEN
}
