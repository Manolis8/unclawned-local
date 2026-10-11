import readline from 'node:readline'
import { loadConfig, saveConfig, invalidateConfigCache } from './user-config.js'
import { getProvider, PROVIDERS } from './providers.js'
import { invalidateRuntime } from './model-router.js'

const LINE = '─'.repeat(57)

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise(r => rl.question(q, a => r(a.trim())))
}

function getConfiguredProviders(cfg: any): string[] {
  return PROVIDERS
    .filter(p => {
      const key = cfg[`${p.name}_api_key`]
      return typeof key === 'string' && key.trim().length > 0
    })
    .map(p => p.name)
}

/** Display label for a saved slot value, stripping the provider prefix. */
function displaySlot(raw: string, isDefault: boolean): string {
  const colon = raw.indexOf(':')
  const label = colon === -1 ? raw : `${raw.slice(colon + 1)}  [${raw.slice(0, colon)}]`
  return label + (isDefault ? '  (default)' : '  (your override)')
}

function currentSlotDisplay(activeProvider: string, tier: 'low' | 'medium' | 'high', slots?: Record<string, string>): string {
  if (slots?.[tier]) return displaySlot(slots[tier], false)
  const p = getProvider(activeProvider)
  return p ? p.defaults[tier] + '  (default)' : '—'
}

/**
 * Given a model name typed by the user, find which configured provider owns it.
 * Returns "provider:model" if cross-provider, or just "model" if it belongs to
 * the active provider (or isn't found in any catalog — user knows best).
 */
function resolveModelInput(input: string, activeProvider: string, configuredProviders: string[]): string {
  // Already has a prefix — pass through as-is
  if (input.includes(':')) return input

  for (const provName of configuredProviders) {
    const prof = getProvider(provName)
    if (!prof) continue
    if (prof.catalog.includes(input)) {
      // Belongs to active provider — store plain, no prefix needed
      return provName === activeProvider ? input : `${provName}:${input}`
    }
  }

  // Not found in any catalog — store as-is, user may know a newer model name
  return input
}

export async function runModelsCommand(): Promise<void> {
  const cfg = loadConfig()
  const configured = getConfiguredProviders(cfg)

  if (configured.length === 0) {
    console.log('\n  No provider configured yet.\n  Run  jarvis set_api  first.\n')
    return
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  try {
    const activeProvider = (cfg as any).preferred_provider?.trim().toLowerCase() || configured[0]

    // ── Step 2: Show all configured providers' model catalogs ─────────────────

    const slots = (cfg as any).model_slots as Record<string, string> | undefined

    console.log('\n' + LINE)
    console.log('  Available models (all configured providers)')
    console.log(LINE)

    for (const provName of configured) {
      const prof = getProvider(provName)
      if (!prof) continue
      const marker = provName === activeProvider ? '  ← active' : ''
      console.log(`\n  ${provName}${marker}:`)
      for (const m of prof.catalog) console.log('    ' + m)
    }
    console.log()

    // ── Step 3: Edit tier slots ───────────────────────────────────────────────

    console.log(LINE)
    console.log('  Model tier assignments')
    console.log('  (Enter to keep · type any model from any provider above)')
    console.log(LINE + '\n')

    const updates: Record<string, string> = {}

    for (const tier of ['low', 'medium', 'high'] as const) {
      const desc = tier === 'low'
        ? 'extraction, classification, summaries'
        : tier === 'medium'
        ? 'chat replies, drafting, planning'
        : 'browser agent, complex reasoning'

      const current = currentSlotDisplay(activeProvider, tier, slots)
      const raw = await ask(rl, `  [${tier.padEnd(6)}] ${desc}\n  Current: ${current}\n  New model (Enter to keep): `)

      if (raw) {
        const resolved = resolveModelInput(raw, activeProvider, configured)
        updates[tier] = resolved
        const label = resolved.includes(':')
          ? resolved.replace(':', ' → ')
          : resolved
        console.log('  Saved: ' + label + '\n')
      } else {
        console.log('  Kept:  ' + current + '\n')
      }
    }

    if (Object.keys(updates).length) {
      const merged = { ...(slots || {}), ...updates }
      saveConfig({ model_slots: merged } as any)
      invalidateConfigCache()
      invalidateRuntime()
      console.log('\n' + LINE)
      console.log('  Saved. Changes take effect on next command.')
      console.log('  Reset a slot: run  jarvis models  and leave it empty.')
      console.log(LINE + '\n')
    } else {
      console.log('\n  Nothing changed.\n')
    }
  } finally {
    rl.close()
  }
}
