import readline from 'node:readline'
import OpenAI from 'openai'
import { loadConfig, saveConfig, injectConfigIntoEnv, invalidateConfigCache, CONFIG_PATH } from './lib/user-config.js'
import { getProvider } from './lib/providers.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

const W = 57
const LINE  = '─'.repeat(W)
const DLINE = '═'.repeat(W)

function box(lines: string[]) {
  console.log('\n' + DLINE)
  for (const l of lines) console.log('  ' + l)
  console.log(DLINE + '\n')
}

function section(label: string) {
  console.log('\n' + LINE)
  console.log('  ' + label)
  console.log(LINE + '\n')
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, a => resolve(a.trim())))
}

function maskKey(k: string): string {
  if (k.length <= 8) return '****'
  return k.slice(0, 6) + '...' + k.slice(-4)
}

// Strip spaces, quotes, newlines — handles bad paste from password managers, docs, etc.
function sanitizeKey(raw: string): string {
  return raw
    .trim()
    .replace(/["""'''`]/g, '')   // remove surrounding quotes
    .replace(/\s+/g, '')          // remove any whitespace (spaces, tabs, newlines)
    .replace(/[^\x21-\x7E]/g, '') // keep only printable ASCII (no invisible chars)
}

// ── Key validation ────────────────────────────────────────────────────────────

async function validateOpenAIKey(key: string): Promise<string | null> {
  try {
    const client = new OpenAI({ apiKey: key })
    await client.models.list()
    return null
  } catch (e: any) {
    const msg: string = e?.message ?? String(e)
    if (msg.includes('401') || msg.includes('Incorrect API key') || msg.includes('invalid_api_key')) {
      return 'Invalid key — double-check it and try again.'
    }
    if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
      return 'Cannot reach api.openai.com — check your internet connection.'
    }
    return null
  }
}

async function validateXaiKey(key: string): Promise<string | null> {
  try {
    const client = new OpenAI({ apiKey: key, baseURL: 'https://api.x.ai/v1' })
    await client.models.list()
    return null
  } catch (e: any) {
    const msg: string = e?.message ?? String(e)
    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('invalid')) {
      return 'Invalid key — double-check it and try again.'
    }
    if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
      return 'Cannot reach api.x.ai — check your internet connection.'
    }
    return null
  }
}

async function validateAnthropicKey(key: string): Promise<string | null> {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: key })
    // Minimal call — haiku is cheapest; 1 token just to confirm auth works
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    })
    return null
  } catch (e: any) {
    const msg: string = e?.message ?? String(e)
    if (msg.includes('401') || msg.includes('authentication_error') || msg.includes('invalid x-api-key')) {
      return 'Invalid key — double-check it and try again.'
    }
    if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
      return 'Cannot reach api.anthropic.com — check your internet connection.'
    }
    return null
  }
}

// ── Single key prompt ─────────────────────────────────────────────────────────

async function promptForKey(
  rl: readline.Interface,
  opts: {
    prompt: string
    prefix: string
    prefixHint: string
    validate: (key: string) => Promise<string | null>
    laterCmd: string
  }
): Promise<string | null> {
  while (true) {
    const raw = await ask(rl, opts.prompt)
    if (!raw) {
      console.log(`  Skipped — add later with: jarvis set_api`)
      return null
    }
    const key = sanitizeKey(raw)
    if (!key) {
      console.log('  Nothing entered — try again or press Enter to skip.')
      continue
    }
    if (!key.startsWith(opts.prefix)) {
      console.log(`  ${opts.prefixHint} — try again, or press Enter to skip.`)
      continue
    }
    console.log('  Checking key...')
    const err = await opts.validate(key)
    if (err) {
      console.log('  ' + err + '  (press Enter to skip)')
      continue
    }
    console.log('  Key OK — ' + maskKey(key))
    return key
  }
}

// ── Step 1: API keys ──────────────────────────────────────────────────────────

interface CollectedKeys {
  openai?: string
  xai?: string
  anthropic?: string
}

async function stepApiKeys(rl: readline.Interface): Promise<CollectedKeys> {
  section('Step 1 of 4: API Keys')
  console.log('  OpenClaw needs at least one AI provider.')
  console.log('  You can add more later with: jarvis set_api\n')
  console.log('  Which provider do you have?')
  console.log('  [1] OpenAI       (sk-...)')
  console.log('  [2] xAI / Grok   (xai-...)')
  console.log('  [3] Anthropic    (sk-ant-...)')
  console.log('  [4] Multiple providers')
  console.log('  [5] Skip for now\n')

  const choice = await ask(rl, '  Enter number: ')
  const collected: CollectedKeys = {}

  if (choice === '5' || !choice) {
    console.log('\n  No problem — run  jarvis set_api  any time to add a key.\n')
    return collected
  }

  const wantOpenAI   = choice === '1' || choice === '4'
  const wantXai      = choice === '2' || choice === '4'
  const wantAnthropic = choice === '3' || choice === '4'

  if (wantOpenAI) {
    const key = await promptForKey(rl, {
      prompt: '\n  OpenAI key (sk-...) or Enter to skip: ',
      prefix: 'sk-',
      prefixHint: 'OpenAI keys start with  sk-',
      validate: validateOpenAIKey,
      laterCmd: 'jarvis set_api',
    })
    if (key) collected.openai = key
  }

  if (wantXai) {
    const key = await promptForKey(rl, {
      prompt: '\n  xAI key (xai-...) or Enter to skip: ',
      prefix: 'xai-',
      prefixHint: 'xAI keys start with  xai-',
      validate: validateXaiKey,
      laterCmd: 'jarvis set_api',
    })
    if (key) collected.xai = key
  }

  if (wantAnthropic) {
    const key = await promptForKey(rl, {
      prompt: '\n  Anthropic key (sk-ant-...) or Enter to skip: ',
      prefix: 'sk-ant-',
      prefixHint: 'Anthropic keys start with  sk-ant-',
      validate: validateAnthropicKey,
      laterCmd: 'jarvis set_api',
    })
    if (key) collected.anthropic = key
  }

  return collected
}

// ── Step 2: Model assignments ─────────────────────────────────────────────────

function detectPrimaryProvider(keys: CollectedKeys): string | null {
  if (keys.xai)       return 'xai'
  if (keys.openai)    return 'openai'
  if (keys.anthropic) return 'anthropic'
  return null
}

async function stepModels(rl: readline.Interface, keys: CollectedKeys): Promise<Record<string, string>> {
  const providerName = detectPrimaryProvider(keys)
  if (!providerName) return {}

  const profile = getProvider(providerName)
  if (!profile) return {}

  section('Step 2 of 4: Model Selection')
  console.log('  Automatic defaults for ' + providerName + ':\n')
  console.log('    low    → ' + profile.defaults.low    + '  (extraction, classification, summaries)')
  console.log('    medium → ' + profile.defaults.medium + '  (chat replies, drafting, planning)')
  console.log('    high   → ' + profile.defaults.high   + '  (browser agent, complex reasoning)\n')

  const customize = await ask(rl, '  Use these defaults? [Enter = yes / n = customize]: ')
  if (!customize || customize.toLowerCase() !== 'n') {
    console.log('  Defaults saved.\n')
    return {}
  }

  console.log('\n  Available models for ' + providerName + ':')
  for (const m of profile.catalog) console.log('    ' + m)
  console.log()

  const slots: Record<string, string> = {}
  for (const tier of ['low', 'medium', 'high'] as const) {
    const raw = await ask(rl, `  [${tier.padEnd(6)}] default: ${profile.defaults[tier]}\n  New model (Enter to keep): `)
    if (raw.trim()) {
      slots[tier] = raw.trim()
      console.log('  Saved: ' + raw.trim() + '\n')
    } else {
      console.log('  Kept:  ' + profile.defaults[tier] + '\n')
    }
  }
  return slots
}

// ── Step 3: Chrome extension ──────────────────────────────────────────────────

async function stepExtension(rl: readline.Interface): Promise<void> {
  section('Step 3 of 4: Chrome Extension')
  console.log('  OpenClaw connects to Chrome via an extension.')
  console.log('  It\'s free and already in the Chrome Web Store.\n')
  console.log('  1. Open Chrome and install the extension:')
  console.log('     https://unclawned.com/extension\n')
  console.log('  2. Click "Add to Chrome"')
  console.log('  3. Pin it: click the puzzle icon in Chrome toolbar, then pin OpenClaw\n')
  await ask(rl, '  Done? Press Enter to continue...')
}

// ── Step 4: Done ─────────────────────────────────────────────────────────────

function stepDone(keys: CollectedKeys) {
  section('Step 4 of 4: All Set')

  const providerList: string[] = []
  if (keys.openai)    providerList.push('OpenAI    (' + maskKey(keys.openai) + ')')
  if (keys.xai)       providerList.push('xAI       (' + maskKey(keys.xai) + ')')
  if (keys.anthropic) providerList.push('Anthropic (' + maskKey(keys.anthropic) + ')')

  if (providerList.length) {
    console.log('  Providers configured:')
    for (const p of providerList) console.log('    - ' + p)
    console.log()
  } else {
    console.log('  No API keys saved yet.')
    console.log('  Run  jarvis set_api  to add one whenever you\'re ready.\n')
  }

  console.log('  Config saved to: ' + CONFIG_PATH)

  box([
    'Setup complete.',
    '',
    '  Start the agent:   jarvis',
    '  Add/change a key:  jarvis set_api',
    '  View config:       jarvis config list',
    '  Change AI models:  jarvis models',
    '    → pick which model handles each task tier',
    '    → mix models from different providers',
  ])
}

// ── Save helper ───────────────────────────────────────────────────────────────

function persistKeys(keys: CollectedKeys): void {
  const patch: Record<string, any> = {}
  if (keys.openai)    { patch.openai_api_key    = keys.openai;    process.env.OPENAI_API_KEY    = keys.openai }
  if (keys.xai)       { patch.xai_api_key       = keys.xai;       process.env.XAI_API_KEY       = keys.xai }
  if (keys.anthropic) { patch.anthropic_api_key = keys.anthropic; process.env.ANTHROPIC_API_KEY = keys.anthropic }
  if (Object.keys(patch).length) {
    saveConfig(patch as any)
    invalidateConfigCache()
  }
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export async function runSetupWizard(): Promise<void> {
  box([
    'Welcome to OpenClaw',
    '',
    '  OpenClaw controls your browser with AI.',
    '  Give it a task in plain English — it clicks,',
    '  types, and reads pages for you.',
    '',
    '  Let\'s get you set up. Takes about 2 minutes.',
  ])

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    const keys = await stepApiKeys(rl)
    const modelSlots = await stepModels(rl, keys)
    await stepExtension(rl)

    persistKeys(keys)
    const patch: Record<string, any> = { setup_complete: true }
    if (Object.keys(modelSlots).length) patch.model_slots = modelSlots
    saveConfig(patch as any)
    invalidateConfigCache()

    stepDone(keys)
  } finally {
    rl.close()
  }
}

// ── jarvis set_api — re-run just the API key step ────────────────────────────

export async function runSetupApiKeys(): Promise<void> {
  section('Add / Update API Keys')
  console.log('  You can add keys for one or more providers.')
  console.log('  Existing keys are kept unless you replace them.\n')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const keys = await stepApiKeys(rl)
    const anySet = keys.openai || keys.xai || keys.anthropic
    if (anySet) {
      persistKeys(keys)
      console.log('\n  Keys saved.\n')
      const providerList: string[] = []
      if (keys.openai)    providerList.push('OpenAI    (' + maskKey(keys.openai) + ')')
      if (keys.xai)       providerList.push('xAI       (' + maskKey(keys.xai) + ')')
      if (keys.anthropic) providerList.push('Anthropic (' + maskKey(keys.anthropic) + ')')
      for (const p of providerList) console.log('    - ' + p)
      console.log('\n  Run  jarvis  to start the agent.\n')
    } else {
      console.log('\n  No keys entered — nothing changed.\n')
      console.log('  Run  jarvis set_api  again when you have a key ready.\n')
    }
  } finally {
    rl.close()
  }
}

// ── Called from cli.ts — skips wizard if setup already done ──────────────────

export async function runSetupIfNeeded(): Promise<void> {
  injectConfigIntoEnv()
  const cfg = loadConfig()

  if (cfg.setup_complete) return
  if (process.env.OPENAI_API_KEY || process.env.XAI_API_KEY || process.env.ANTHROPIC_API_KEY) {
    saveConfig({ setup_complete: true } as any)
    invalidateConfigCache()
    return
  }

  await runSetupWizard()
}
