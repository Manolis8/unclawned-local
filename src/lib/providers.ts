// Provider profiles — pure data, no I/O.

export interface ModelTierDefaults {
  /** Simple extraction, classification, yes/no, compaction. */
  low: string
  /** Drafting, planning, structured output, chat replies. */
  medium: string
  /** Browser agent loops, complex multi-step reasoning. */
  high: string
}

export interface ProviderProfile {
  readonly name: string
  readonly aliases: readonly string[]
  readonly envVars: readonly string[]
  readonly baseUrl: string
  readonly apiMode: 'chat_completions' | 'anthropic_messages'
  /** Ordered from cheapest to most capable. Used for the "jarvis models" list. */
  readonly catalog: readonly string[]
  /** Opinionated defaults per tier. User can override any slot in config. */
  readonly defaults: ModelTierDefaults
}

// ── Provider definitions ──────────────────────────────────────────────────────

export const PROVIDERS: readonly ProviderProfile[] = [
  {
    name: 'xai',
    aliases: ['grok', 'x-ai', 'x.ai'],
    envVars: ['XAI_API_KEY'],
    baseUrl: 'https://api.x.ai/v1',
    apiMode: 'chat_completions',
    catalog: [
      'grok-build-0.1',
      'grok-4.3',
      'grok-4.20-0309-non-reasoning',
      'grok-4.20-0309-reasoning',
      'grok-4.20-multi-agent-0309',
      'grok-4.5',
    ],
    defaults: {
      low:    'grok-build-0.1',          // $1.00/$2.00 — cheapest
      medium: 'grok-4.3',               // $1.25/$2.50 — good balance
      high:   'grok-4.5',               // $2.00/$6.00 — best reasoning
    },
  },
  {
    name: 'openai',
    aliases: ['oai'],
    envVars: ['OPENAI_API_KEY'],
    baseUrl: 'https://api.openai.com/v1',
    apiMode: 'chat_completions',
    catalog: [
      // Nano / ultra-cheap
      'gpt-5-nano',
      'gpt-5.4-nano',
      'gpt-4.1-nano',
      // Mini / cheap
      'gpt-5-mini',
      'gpt-5.4-mini',
      'gpt-4.1-mini',
      'gpt-4o-mini',
      'o1-mini',
      'o3-mini',
      'o4-mini',
      // Standard
      'gpt-5',
      'gpt-5.1',
      'gpt-5.2',
      'gpt-5.4',
      'gpt-5.6-luna',
      'gpt-4.1',
      'gpt-4o',
      'o3',
      // Pro / heavy
      'gpt-5.5',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
      'o1',
      'o3-pro',
      'gpt-5-pro',
      'gpt-5.4-pro',
      'gpt-5.2-pro',
      'gpt-5.5-pro',
      'o1-pro',
      // Legacy (still callable)
      'gpt-4-turbo-2024-04-09',
      'gpt-4o-2024-05-13',
      'gpt-3.5-turbo',
    ],
    defaults: {
      low:    'gpt-4.1-nano',   // $0.10/$0.40 — very cheap, fast
      medium: 'gpt-4.1-mini',   // $0.40/$1.60 — solid for drafting/planning
      high:   'gpt-4o',         // $2.50/$10.00 — reliable, widely tested
    },
  },
  {
    name: 'anthropic',
    aliases: ['claude'],
    envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_TOKEN'],
    baseUrl: 'https://api.anthropic.com',
    apiMode: 'anthropic_messages',
    catalog: [
      // Cheap / fast
      'claude-haiku-4-5-20251001',
      // Mid-range
      'claude-sonnet-4-5-20251001',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
      // Flagship
      'claude-opus-4-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      // Frontier
      'claude-fable-5',
      'claude-mythos-5',
    ],
    defaults: {
      low:    'claude-haiku-4-5-20251001', // cheapest
      medium: 'claude-sonnet-5',           // $2/$10 — best mid-range
      high:   'claude-opus-4-8',           // $5/$25 — flagship
    },
  },
]

export function getProvider(name: string): ProviderProfile | undefined {
  const n = name.trim().toLowerCase()
  return PROVIDERS.find(p => p.name === n || (p.aliases as readonly string[]).includes(n))
}
