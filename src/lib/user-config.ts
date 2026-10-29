import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes, randomUUID } from 'crypto'
import { updateKey } from './credential-pool.js'

export interface ModelSlots {
  low?: string
  medium?: string
  high?: string
}

export interface UserConfig {
  version: number
  user_id: string
  anthropic_api_key?: string
  xai_api_key?: string
  openai_api_key?: string
  model_tier: 'cheap' | 'standard' | 'heavy'
  model_slots?: ModelSlots
  preferred_provider?: string
  browser_installed: boolean
  setup_complete: boolean
}

const CONFIG_DIR = join(homedir(), '.unclawned')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

// JSON key → process.env variable name
const API_KEY_ENV_MAP: Record<string, string> = {
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  xai_api_key:       'XAI_API_KEY',
  openai_api_key:    'OPENAI_API_KEY',
}

// JSON key → credential pool provider name
const API_KEY_PROVIDER_MAP: Record<string, string> = {
  anthropic_api_key: 'anthropic',
  xai_api_key:       'xai',
  openai_api_key:    'openai',
}

let _cache: UserConfig | null = null

function readFileConfig(): Partial<UserConfig> {
  if (!existsSync(CONFIG_PATH)) return {}
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}

// Load config with priority: process.env (from shell or .env) > config.json
export function loadConfig(): UserConfig {
  if (_cache) return _cache

  const file = readFileConfig()

  const config: UserConfig = {
    version: 1,
    user_id: 'local',
    model_tier: 'standard',
    browser_installed: false,
    setup_complete: false,
    ...file,
  }

  // Env vars always win (may come from dotenv .env or real shell env)
  if (process.env.ANTHROPIC_API_KEY) config.anthropic_api_key = process.env.ANTHROPIC_API_KEY
  if (process.env.XAI_API_KEY)       config.xai_api_key       = process.env.XAI_API_KEY
  if (process.env.OPENAI_API_KEY)    config.openai_api_key    = process.env.OPENAI_API_KEY

  _cache = config
  return config
}

export function invalidateConfigCache(): void { _cache = null }

// Write a partial update back to config.json (never writes env-var-only values)
export function saveConfig(patch: Partial<UserConfig>): void {
  mkdirSync(CONFIG_DIR, { recursive: true })

  const current = readFileConfig()
  if (!current.user_id) current.user_id = randomUUID()

  const updated: UserConfig = {
    version: 1,
    user_id: current.user_id,
    model_tier: 'standard',
    browser_installed: false,
    setup_complete: false,
    ...current,
    ...patch,
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), { encoding: 'utf8' })
  // Restrict to owner read/write on Unix. No-op on Windows but harmless.
  try { chmodSync(CONFIG_PATH, 0o600) } catch {}

  _cache = null
}

// Returns the API key for a provider, respecting priority order.
export function getApiKey(provider: 'anthropic' | 'xai' | 'openai'): string | null {
  const envMap: Record<string, string | undefined> = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    xai:       process.env.XAI_API_KEY,
    openai:    process.env.OPENAI_API_KEY,
  }
  if (envMap[provider]) return envMap[provider]!

  const file = readFileConfig()
  const val = file[`${provider}_api_key` as keyof UserConfig]
  return typeof val === 'string' ? val : null
}

// Called at process startup (in cli-preload.ts) — injects API keys from config.json
// into process.env for code that reads process.env directly, only for vars not already set.
export function injectConfigIntoEnv(): void {
  const file = readFileConfig()
  for (const [cfgKey, envKey] of Object.entries(API_KEY_ENV_MAP)) {
    const val = file[cfgKey as keyof UserConfig]
    if (typeof val === 'string' && !process.env[envKey]) {
      process.env[envKey] = val
    }
  }
  // The local browser relay refuses to start without a signing token. It only
  // signs traffic inside this process, so a fresh random one per run is enough.
  if (!process.env.OPENCLAW_GATEWAY_TOKEN?.trim()) {
    process.env.OPENCLAW_GATEWAY_TOKEN = randomBytes(32).toString('hex')
  }
}

// ── CLI helpers ──────────────────────────────────────────────────────────────

const SETTABLE_KEYS = new Set([
  'anthropic_api_key', 'xai_api_key', 'openai_api_key', 'model_tier',
])

const MASKED_KEYS = new Set(['anthropic_api_key', 'xai_api_key', 'openai_api_key'])

function maskKey(val: string): string {
  if (val.length <= 8) return '****'
  return val.slice(0, 6) + '...' + val.slice(-4)
}

export function handleConfigCommand(args: string): void {
  const parts = args.trim().split(/\s+/)
  const sub = parts[0]?.toLowerCase()
  const LINE = '─'.repeat(55)

  if (!sub || sub === 'list') {
    const config = loadConfig()
    console.log(`\n${LINE}`)
    console.log('  CONFIG  (~/.unclawned/config.json)')
    console.log(LINE)
    const rows: [string, string][] = [
      ['anthropic_api_key', config.anthropic_api_key ? maskKey(config.anthropic_api_key) : '(not set)'],
      ['xai_api_key',       config.xai_api_key       ? maskKey(config.xai_api_key)       : '(not set)'],
      ['openai_api_key',    config.openai_api_key     ? maskKey(config.openai_api_key)    : '(not set)'],
      ['model_tier',        config.model_tier],
      ['browser_installed', String(config.browser_installed)],
      ['setup_complete',    String(config.setup_complete)],
      ['user_id',           config.user_id],
    ]
    for (const [k, v] of rows) console.log(`  ${k.padEnd(22)} ${v}`)
    console.log(`\n  /config set <key> <value>  — update a setting`)
    console.log(`  /config get <key>          — read a single value`)
    console.log(`  Settable: ${[...SETTABLE_KEYS].join(', ')}`)
    console.log(LINE + '\n')
    return
  }

  if (sub === 'get') {
    const key = parts[1]
    if (!key) { console.log('\n  Usage: /config get <key>\n'); return }
    const config = loadConfig()
    const val = config[key as keyof UserConfig]
    if (val === undefined) { console.log(`\n  Unknown key: ${key}\n`); return }
    const out = MASKED_KEYS.has(key) && typeof val === 'string' ? maskKey(val) : String(val)
    console.log(`\n  ${key}: ${out}\n`)
    return
  }

  if (sub === 'set') {
    const key = parts[1]
    const value = parts.slice(2).join(' ')
    if (!key || !value) { console.log('\n  Usage: /config set <key> <value>\n'); return }
    if (!SETTABLE_KEYS.has(key)) {
      console.log(`\n  Cannot set "${key}". Settable keys: ${[...SETTABLE_KEYS].join(', ')}\n`)
      return
    }
    saveConfig({ [key]: value } as Partial<UserConfig>)
    // Inject into env and credential pool immediately so the running process picks it up
    if (key in API_KEY_ENV_MAP) {
      process.env[API_KEY_ENV_MAP[key]] = value
      updateKey(API_KEY_PROVIDER_MAP[key], value)
    }
    const display = MASKED_KEYS.has(key) ? maskKey(value) : value
    console.log(`\n  ✓ ${key} = ${display}\n`)
    return
  }

  console.log('\n  Usage: /config [list | get <key> | set <key> <value>]\n')
}
