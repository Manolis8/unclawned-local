import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { loadConfig } from './user-config.js'

const LOCK_FILE = join(homedir(), '.unclawned', 'cli.lock')
const W = 55

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function getRunningPid(): number | null {
  if (!existsSync(LOCK_FILE)) return null
  const raw = readFileSync(LOCK_FILE, 'utf8').trim()
  const pid = parseInt(raw, 10)
  if (isNaN(pid) || !pidAlive(pid)) return null
  return pid
}

function nodeVersionOk(): boolean {
  const [major, minor] = process.version.slice(1).split('.').map(Number)
  return major > 22 || (major === 22 && (minor ?? 0) >= 7)
}

function maskKey(k: string): string {
  if (k.length <= 8) return '****'
  return k.slice(0, 6) + '...' + k.slice(-4)
}

function uptimeStr(ms: number): string {
  if (ms < 60_000)  return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3600_000)}h`
}

interface ServerStatus {
  pid: number
  uptime_ms: number
  extension_connected: boolean
  user_id: string | null
}

async function probeServer(port: number): Promise<ServerStatus | null> {
  try {
    const res = await fetch(`http://localhost:${port}/status`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return null
    return await res.json() as ServerStatus
  } catch {
    return null
  }
}

export async function showStatus(port = 3001): Promise<void> {
  const LINE = '─'.repeat(W)
  const pid  = getRunningPid()
  const srv  = pid ? await probeServer(port) : null

  const nodeOk   = nodeVersionOk()
  const srvUp    = srv !== null
  const extOk    = srv?.extension_connected ?? false
  const userId   = srv?.user_id ?? null

  const cfg     = loadConfig()
  const keyRows = [
    { name: 'openai_api_key',    val: cfg.openai_api_key },
    { name: 'xai_api_key',       val: cfg.xai_api_key },
    { name: 'anthropic_api_key', val: cfg.anthropic_api_key },
  ]
  const hasAnyKey = keyRows.some(k => k.val)

  const dbPath    = join(homedir(), '.unclawned', 'openclaw.db')
  const cfgPath   = join(homedir(), '.unclawned', 'config.json')

  console.log('\n' + LINE)
  console.log('  OpenClaw Status')
  console.log(LINE + '\n')

  // ── Runtime ──────────────────────────────────────────────────────────
  const nodeNote = nodeOk ? '' : '  [UPGRADE REQUIRED]'
  console.log(`  Node.js        ${process.version}  (>= 22.7.0 required)${nodeNote}`)

  if (srvUp && srv) {
    console.log(`  Server         running on :${port}  PID ${srv.pid}  up ${uptimeStr(srv.uptime_ms)}`)
  } else if (pid) {
    console.log(`  Server         PID ${pid} alive but :${port} not responding`)
  } else {
    console.log(`  Server         not running  —  start with: jarvis`)
  }

  if (extOk && userId) {
    console.log(`  Extension      connected  (${userId.slice(0, 8)}...)`)
  } else if (srvUp) {
    console.log(`  Extension      not connected  —  open Chrome and click the OpenClaw icon`)
  } else {
    console.log(`  Extension      unknown  (server not running)`)
  }

  console.log()

  // ── API Keys ─────────────────────────────────────────────────────────
  console.log('  API Keys')
  for (const k of keyRows) {
    const v = k.val ? maskKey(k.val) : '(not set)'
    const hint = k.val ? '' : '   /config set ' + k.name + ' ...'
    console.log(`    ${k.name.padEnd(24)} ${v}${hint}`)
  }

  if (!hasAnyKey) {
    console.log('\n  No API keys configured.')
    console.log('  Run: jarvis config set openai_api_key sk-...')
  }

  console.log()

  // ── Paths ─────────────────────────────────────────────────────────────
  console.log(`  Config   ${cfgPath}`)
  console.log(`  DB       ${dbPath}${existsSync(dbPath) ? '' : '  (not found)'}`)

  // ── Summary ───────────────────────────────────────────────────────────
  const allGood = nodeOk && srvUp && extOk && hasAnyKey
  const line2 = allGood
    ? '  All systems go.'
    : (srvUp ? '  Server running.' : '  Server not running — run: jarvis')

  console.log('\n' + LINE)
  console.log(line2)
  console.log(LINE + '\n')
}
