// Unclawed MCP server — exposes real Chrome browser tools to Hermes (or any MCP-capable agent)
// Transport: stdio. stdout is reserved exclusively for MCP protocol messages.
// ALL diagnostic output must go to stderr.

import * as http from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'

// Redirect every console.log from imported modules to stderr before any other code runs.
// Any stray console.log would silently corrupt the MCP stdio protocol.
const _origLog = console.log
console.log = (...args: any[]) => process.stderr.write('[log] ' + args.map(String).join(' ') + '\n')

import { startExtensionWsServer } from './lib/extension-ws-server.js'
import { extensionConnections, sendExtensionMessage } from './lib/extension-state.js'
import {
  getBrowser,
  perceivePage,
  formatPercept,
  snapshotPage,
  navigateTo,
  clickRef,
  typeInRefSmart,
  dismissCookieSilent,
  resetAllBrowserConnections,
} from './lib/agent-extension.js'
import { scrollIntoViewViaPlaywright } from './browser/pw-tools-core.interactions.js'

const log = (...args: any[]) => process.stderr.write('[mcp] ' + args.map(String).join(' ') + '\n')
const EXTENSION_WS_PORT = Number.parseInt(process.env.HERMES_LIVE_CHROME_PORT ?? '3011', 10)
if (!Number.isInteger(EXTENSION_WS_PORT) || EXTENSION_WS_PORT < 1 || EXTENSION_WS_PORT > 65535) {
  log(`ERROR: Invalid HERMES_LIVE_CHROME_PORT=${process.env.HERMES_LIVE_CHROME_PORT}`)
  process.exit(1)
}

// ── Extension WebSocket server ─────────────────────────────────────────────
// This HTTP server exists only to host the WebSocket upgrade for the Chrome extension.
const httpServer = http.createServer((_req, res) => {
  res.writeHead(200)
  res.end('Unclawed MCP bridge')
})

// ── Extension readiness signal ─────────────────────────────────────────────
// Use the onExtensionConnected callback (fires after the relay WebSocket opens)
// as readiness signal, not extensionConnections (set before relay setup).
let _readyResolvers: Array<(uid: string) => void> = []
let _readyUserId: string | null = null

function _onExtensionReady(userId: string) {
  _readyUserId = userId
  const resolvers = _readyResolvers.splice(0)
  for (const r of resolvers) r(userId)
}

function _onExtensionGone() {
  _readyUserId = null
}

startExtensionWsServer(httpServer, async (userId) => {
  log(`Chrome extension and relay bridge ready (userId=${userId})`)
  log(`Relay bridge ready — tools can now use the browser (userId=${userId})`)
  _onExtensionReady(userId)
})

setInterval(() => {
  if (_readyUserId !== null) {
    const ws = extensionConnections.get(_readyUserId) as any
    if (!ws || ws.readyState !== 1) {
      log(`Extension disconnected (userId=${_readyUserId})`)
      _onExtensionGone()
    }
  }
}, 2000)

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    log(`ERROR: Port ${EXTENSION_WS_PORT} is already in use. Set HERMES_LIVE_CHROME_PORT to a free port or stop the process using it.`)
    process.exit(1)
  } else {
    log('HTTP server error:', err.message)
  }
})
httpServer.listen(EXTENSION_WS_PORT, '127.0.0.1', () => {
  log(`Extension WebSocket ready on ws://127.0.0.1:${EXTENSION_WS_PORT}/extension`)
})

// ── Helpers ────────────────────────────────────────────────────────────────
async function waitForConnected(timeoutMs = 30000): Promise<string | null> {
  if (_readyUserId !== null) return _readyUserId
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      const idx = _readyResolvers.indexOf(resolve)
      if (idx !== -1) _readyResolvers.splice(idx, 1)
      resolve(null)
    }, timeoutMs)
    _readyResolvers.push((uid) => { clearTimeout(timer); resolve(uid) })
  })
}

async function requireConnected(): Promise<string> {
  log('Waiting for Chrome extension to connect (up to 30s)...')
  const uid = await waitForConnected(30000)
  if (!uid) {
    throw new McpError(
      ErrorCode.InternalError,
      'Chrome extension did not connect within 30 seconds.\n\n' +
      'Fix: In Chrome, click the puzzle-piece icon in the toolbar → find "Unclawed" → click it to open the popup. ' +
      'If the popup says "Disconnected", click the Reconnect button. ' +
      'Once it shows "Connected", retry the command.\n\n' +
      `Expected bridge URL: ws://127.0.0.1:${EXTENSION_WS_PORT}/extension`
    )
  }
  return uid
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

let detachIdleTimer: ReturnType<typeof setTimeout> | null = null

function scheduleBrowserDetach(userId: string): void {
  if (detachIdleTimer) clearTimeout(detachIdleTimer)
  detachIdleTimer = setTimeout(async () => {
    if (activeCalls > 0) return
    try {
      log(`Browser idle — detaching Chrome debugging (userId=${userId})`)
      await sendExtensionMessage(userId, 'detachAllTabs', {}, 10000).catch(() => {})
      resetAllBrowserConnections()
    } finally {
      detachIdleTimer = null
    }
  }, 10000)
  detachIdleTimer.unref?.()
}

async function getBrowserWithRetry(userId: string, maxAttempts = 3): ReturnType<typeof getBrowser> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await getBrowser(userId)
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('No controllable web page')) throw err
      if (attempt < maxAttempts) {
        log(`No pages yet, retrying in 2s (attempt ${attempt}/${maxAttempts})...`)
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }
  throw lastErr
}

// ── MCP server ─────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'live-chrome', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'browser_navigate',
      description: "Open a URL in the user's real Chrome browser. Use when you need to interact with the page (click buttons, fill forms, handle dynamic content). After navigating, perceive_page runs automatically and returns what's on the page.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Full URL including https://' },
        },
        required: ['url'],
      },
    },
    {
      name: 'perceive_page',
      description: 'Read the current browser page. Returns the page type (google_serp, article, login, cookie_banner, unknown), visible text content, and interactive elements. Call this after navigating or clicking to understand what is on screen.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'browser_snapshot',
      description: 'Get interactive element refs (e1, e2, e3...) for clicking and typing. Use on interactive pages like social media, web apps, and forms. Returns refs needed by browser_click and browser_type.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'browser_click',
      description: 'Click an element by its ref from browser_snapshot. Ref format: e1, e2, etc. Always get fresh refs from browser_snapshot before clicking.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object' as const,
        properties: {
          ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. e3)' },
        },
        required: ['ref'],
      },
    },
    {
      name: 'browser_type',
      description: 'Type text into an input element by its ref from browser_snapshot. Use browser_snapshot first to get the ref.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object' as const,
        properties: {
          ref: { type: 'string', description: 'Element ref from browser_snapshot' },
          text: { type: 'string', description: 'Text to type into the field' },
        },
        required: ['ref', 'text'],
      },
    },
    {
      name: 'browser_scroll_to_ref',
      description: 'Scroll an element into view by its ref. Use when browser_click fails with "outside viewport". Then call browser_snapshot for fresh refs.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: {
          ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        },
        required: ['ref'],
      },
    },
    {
      name: 'browser_dismiss_cookie',
      description: 'Dismiss cookie/consent banners. Call when perceive_page returns page type "cookie_banner". Prefers Reject/Refuse over Accept.',
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'browser_go_back',
      description: 'Navigate back in browser history. Returns perceive_page result for the previous page.',
      annotations: { readOnlyHint: false },
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const a = (args ?? {}) as Record<string, any>
  let userIdForCleanup: string | null = null

  activeCalls++
  log(`Tool call: ${name}`, JSON.stringify(a), `[active=${activeCalls}]`)

  try {
    const userId = await requireConnected()
    userIdForCleanup = userId
    let text = ''
    const TOOL_TIMEOUT = 25000

    switch (name) {
      case 'browser_navigate': {
        const url = a.url as string
        await withTimeout(navigateTo(url, userId), TOOL_TIMEOUT, 'browser_navigate')
        const percept = await withTimeout(perceivePage(userId), TOOL_TIMEOUT, 'perceive_page after navigate')
        text = formatPercept(percept)
        break
      }

      case 'perceive_page': {
        const percept = await withTimeout(perceivePage(userId), TOOL_TIMEOUT, 'perceive_page')
        text = formatPercept(percept)
        break
      }

      case 'browser_snapshot': {
        text = await withTimeout(snapshotPage(userId, '', true), TOOL_TIMEOUT, 'browser_snapshot')
        break
      }

      case 'browser_click': {
        const ref = a.ref as string
        await withTimeout(clickRef(userId, ref), TOOL_TIMEOUT, 'browser_click')
        text = `Clicked ${ref}. Call perceive_page or browser_snapshot to see the updated state.`
        break
      }

      case 'browser_type': {
        const ref = a.ref as string
        const inputText = a.text as string
        await withTimeout(typeInRefSmart(userId, ref, inputText), TOOL_TIMEOUT, 'browser_type')
        text = `Typed "${inputText.slice(0, 40)}${inputText.length > 40 ? '…' : ''}" into ${ref}.`
        break
      }

      case 'browser_scroll_to_ref': {
        const ref = a.ref as string
        const { page, cdpUrl, targetId } = await withTimeout(getBrowserWithRetry(userId), TOOL_TIMEOUT, 'getBrowser')
        await withTimeout(scrollIntoViewViaPlaywright({
          cdpUrl,
          targetId: targetId || undefined,
          page,
          ref,
          timeoutMs: 8000,
        }), TOOL_TIMEOUT, 'browser_scroll_to_ref')
        await new Promise(r => setTimeout(r, 400))
        text = `Scrolled ${ref} into view. Call browser_snapshot for fresh refs, then click.`
        break
      }

      case 'browser_dismiss_cookie': {
        text = await withTimeout(dismissCookieSilent(userId), TOOL_TIMEOUT, 'browser_dismiss_cookie')
        break
      }

      case 'browser_go_back': {
        const { page } = await withTimeout(getBrowserWithRetry(userId), TOOL_TIMEOUT, 'getBrowser')
        await page.goBack({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => {})
        await new Promise(r => setTimeout(r, 800))
        const percept = await withTimeout(perceivePage(userId), TOOL_TIMEOUT, 'perceive_page after back')
        text = formatPercept(percept)
        break
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
    }

    log(`Tool result: ${name} → ${text.slice(0, 120)}`)
    return { content: [{ type: 'text' as const, text }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? (err.stack ?? '') : ''
    log(`Tool error [${name}]: ${msg}`)
    if (stack && stack !== msg) log(`  Stack: ${stack.split('\n').slice(1, 4).join(' | ')}`)
    return {
      content: [{ type: 'text' as const, text: `Error: ${msg}` }],
      isError: true,
    }
  } finally {
    activeCalls--
    log(`Tool call complete: ${name} [active=${activeCalls}]`)
    if (userIdForCleanup && activeCalls === 0) scheduleBrowserDetach(userIdForCleanup)
    if (pendingShutdownReason !== null && activeCalls === 0) {
      log(`All calls complete — proceeding with shutdown`)
      doActualShutdown()
    }
  }
})

// ── Active call tracking + shutdown ───────────────────────────────────────
let activeCalls = 0
let shuttingDown = false
let pendingShutdownReason: string | null = null

function doActualShutdown() {
  log(`Exiting (active calls: ${activeCalls})`)
  if (detachIdleTimer) {
    clearTimeout(detachIdleTimer)
    detachIdleTimer = null
  }
  if (_readyUserId) {
    try { sendExtensionMessage(_readyUserId, 'detachAllTabs', {}, 1000).catch(() => {}) } catch {}
  }
  resetAllBrowserConnections()
  for (const [, ws] of extensionConnections) {
    try { ;(ws as any).close(1001, 'MCP client disconnected') } catch {}
  }
  httpServer.close()
  setTimeout(() => process.exit(0), 200).unref()
}

function shutdown(reason: string) {
  if (shuttingDown) return
  shuttingDown = true
  log(`Shutdown requested: ${reason} (active calls: ${activeCalls})`)
  if (activeCalls === 0) {
    doActualShutdown()
  } else {
    pendingShutdownReason = reason
    log(`Deferring shutdown — waiting for ${activeCalls} in-flight tool call(s) to complete`)
  }
}

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Only shut down on signal, not on stdin EOF.
  // Hermes closes stdin after sending a request while still waiting for the
  // response — listening for 'end' would kill the server before the result
  // is returned. SIGTERM/SIGINT are the reliable shutdown signals.
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  // Fallback: if stdin closes AND no calls are in flight, treat it as shutdown.
  process.stdin.on('end', () => {
    if (activeCalls === 0) {
      shutdown('MCP stdin closed (idle)')
    } else {
      log(`stdin closed during ${activeCalls} active call(s) — will shut down when they complete`)
      pendingShutdownReason = 'MCP stdin closed'
      shuttingDown = true
    }
  })

  log('MCP server ready — waiting for tool calls')
}

main().catch((err) => {
  log('Fatal startup error:', err)
  process.exit(1)
})
