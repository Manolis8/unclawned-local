// Model router — the single function that resolves which provider+key+model
// to use for a request. Mirrors Hermes's resolve_runtime_provider().
//
// Design rules (copied from Hermes):
// - Provider profiles are pure data (providers.ts) — no I/O
// - Credential state (ok/exhausted/dead) lives in credential-pool.ts
// - This module is the ONLY place that constructs OpenAI clients
// - Shared by the setup wizard AND the agent loop (no duplication)

import OpenAI from 'openai'
import { PROVIDERS, getProvider, type ProviderProfile, type ModelTierDefaults } from './providers.js'
import { seedFromEnv, getKey, markExhausted, markDead } from './credential-pool.js'
import { loadConfig } from './user-config.js'

// ── Types ────────────────────────────────────────────────────────────────────

export type ModelTier = 'low' | 'medium' | 'high'

export interface ResolvedRuntime {
  provider: string
  apiMode: 'chat_completions' | 'anthropic_messages'
  client: OpenAI
  /** High-tier model — browser agent, complex tool loops. */
  model: string
  /** Low-tier model — classification, compaction, quick calls. */
  fastModel: string
  /** Mid-tier model — drafting, planning, chat replies. */
  mediumModel: string
  fastClient: OpenAI
  /** Resolve a specific tier, respecting user overrides from config. */
  modelFor: (tier: ModelTier) => string
}

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Resolve the raw slot value for a tier.
 * May be "model-name" (same provider) or "provider:model-name" (cross-provider).
 * Checks config.model_slots first, then provider defaults.
 */
function resolveSlot(profile: ProviderProfile, tier: keyof ModelTierDefaults, cfg: any): string {
  const slots = (cfg as any).model_slots as Record<string, string> | undefined
  if (slots?.[tier] && typeof slots[tier] === 'string' && slots[tier].trim()) {
    return slots[tier].trim()
  }
  return profile.defaults[tier]
}

/**
 * Parse a slot value into provider + model.
 * "openai:gpt-4o"           → { provider: "openai", model: "gpt-4o" }
 * "gpt-4o"                  → { provider: null, model: "gpt-4o" }
 */
function parseSlot(raw: string): { provider: string | null; model: string } {
  const colon = raw.indexOf(':')
  if (colon === -1) return { provider: null, model: raw }
  return { provider: raw.slice(0, colon), model: raw.slice(colon + 1) }
}

// Priority when no preference is set.
// xAI first because that's what the current codebase actively uses for the
// main agent loop. OpenAI second so fast calls (gpt-4o-mini) still work.
const DEFAULT_PRIORITY = ['xai', 'openai', 'anthropic'] as const

// 60-second in-memory cache so we don't re-resolve on every LLM call.
let _cachedRuntime: ResolvedRuntime | null = null
let _cacheExpiry = 0

function seedAll(): void {
  for (const p of PROVIDERS) seedFromEnv(p.name, p.envVars)
}

function buildClient(baseUrl: string, apiKey: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl })
}

/**
 * Resolve which provider + credentials + model to use.
 *
 * Priority chain (first usable wins):
 *   1. `config.preferred_provider` (user's explicit choice via /config set)
 *   2. DEFAULT_PRIORITY list — xai → openai → anthropic
 *
 * Throws if no provider has a usable key.
 */
export function resolveRuntime(): ResolvedRuntime {
  if (_cachedRuntime && Date.now() < _cacheExpiry) return _cachedRuntime
  // Ensure env vars are loaded from config.json (idempotent)
  seedAll()

  const cfg = loadConfig()
  const preferred = (cfg as any).preferred_provider as string | undefined
  const priority = preferred && preferred.trim()
    ? [preferred.trim().toLowerCase(), ...DEFAULT_PRIORITY.filter(p => p !== preferred.trim().toLowerCase())]
    : [...DEFAULT_PRIORITY]

  for (const name of priority) {
    const profile = getProvider(name)
    if (!profile) continue
    const apiKey = getKey(name)
    if (!apiKey) continue

    const mainClient = buildClient(profile.baseUrl, apiKey)

    // ── High-tier client (rt.client) ─────────────────────────────────────────
    // If the user pinned the high slot to a different provider, use that client.
    const highSlotRaw = resolveSlot(profile, 'high', cfg)
    const highSlot = parseSlot(highSlotRaw)
    let client = mainClient
    if (highSlot.provider && highSlot.provider !== name) {
      const altProfile = getProvider(highSlot.provider)
      const altKey = getKey(highSlot.provider)
      if (altProfile && altKey) client = buildClient(altProfile.baseUrl, altKey)
    }

    // ── Low/medium-tier client (rt.fastClient) ───────────────────────────────
    // Priority: explicit slot provider > OpenAI (if available) > main provider.
    const lowSlotRaw = resolveSlot(profile, 'low', cfg)
    const lowSlot = parseSlot(lowSlotRaw)
    let fastClient = mainClient
    let fastModel = lowSlot.model
    if (lowSlot.provider && lowSlot.provider !== name) {
      const altProfile = getProvider(lowSlot.provider)
      const altKey = getKey(lowSlot.provider)
      if (altProfile && altKey) {
        fastClient = buildClient(altProfile.baseUrl, altKey)
      }
    }
    // No implicit switch to OpenAI for cheap calls: call sites pair fastClient with
    // modelFor('low'|'medium'), which returns the main provider's model names.

    // modelFor strips provider prefix so call sites always get a bare model name.
    const modelFor = (tier: ModelTier): string => parseSlot(resolveSlot(profile, tier, cfg)).model

    const runtime: ResolvedRuntime = {
      provider: name,
      apiMode: profile.apiMode,
      client,
      model: highSlot.model,
      mediumModel: parseSlot(resolveSlot(profile, 'medium', cfg)).model,
      fastModel,
      fastClient,
      modelFor,
    }
    _cachedRuntime = runtime
    _cacheExpiry = Date.now() + 60_000
    return runtime
  }

  throw new Error(
    'No AI provider configured.\n' +
    'Run: jarvis config set openai_api_key sk-...\n' +
    '  or: jarvis config set xai_api_key xai-...\n' +
    'Supported providers: openai, xai, anthropic'
  )
}

// ── Error feedback ────────────────────────────────────────────────────────────

/**
 * Call from the agent loop's catch block when a provider returns an HTTP error.
 * Updates the pool so the next resolveRuntime() call can rotate to a fallback.
 */
export function handleProviderError(provider: string, httpStatus: number): void {
  if (httpStatus === 401 || httpStatus === 403) {
    markExhausted(provider, 401)
  } else if (httpStatus === 429 || httpStatus === 402) {
    markExhausted(provider, 429)
  }
}

/**
 * Permanently mark a provider as dead (revoked/invalid key).
 * Next resolveRuntime() will skip it and try the fallback.
 */
export function killProvider(provider: string): void {
  markDead(provider)
}

/**
 * Flush the resolved-runtime cache.
 * Call after any API key is updated (e.g. /config set xai_api_key ...) so
 * the next resolveRuntime() picks up the new credential from the pool.
 */
export function invalidateRuntime(): void {
  _cachedRuntime = null
  _cacheExpiry = 0
}
