// Credential pool — stateful, in-process. Mirrors Hermes credential_pool.py.
// Keys are seeded from process.env (populated by injectConfigIntoEnv() on
// startup). Rotation happens in-memory; no disk writes needed at this layer.

export type CredStatus = 'ok' | 'exhausted' | 'dead'

interface PoolEntry {
  provider: string
  apiKey: string
  status: CredStatus
  exhaustedUntil?: number
}

const _pool = new Map<string, PoolEntry>()

// Cooldowns match Hermes: 401 → 5 min, 429 → 1 hour, other → 5 min
const TTL_401_MS  =  5 * 60 * 1000
const TTL_429_MS  = 60 * 60 * 1000
const TTL_DEFAULT_MS = 5 * 60 * 1000

// ── Seeding ──────────────────────────────────────────────────────────────────

/**
 * Seed a provider's entry from env vars (first non-empty value wins).
 * No-op if the provider is already seeded.
 */
export function seedFromEnv(provider: string, envVars: readonly string[]): void {
  if (_pool.has(provider)) return
  for (const name of envVars) {
    const val = (process.env[name] ?? '').trim()
    if (val) {
      _pool.set(provider, { provider, apiKey: val, status: 'ok' })
      return
    }
  }
}

/** Override / refresh a provider's key (e.g. after user runs /config set). */
export function updateKey(provider: string, apiKey: string): void {
  _pool.set(provider, { provider, apiKey, status: 'ok' })
}

// ── Selection ─────────────────────────────────────────────────────────────────

/**
 * Return the API key for a provider if it's currently usable (OK or
 * past its cooldown window). Returns null if missing, dead, or still cooling.
 */
export function getKey(provider: string): string | null {
  const entry = _pool.get(provider)
  if (!entry) return null
  if (entry.status === 'dead') return null
  if (entry.status === 'exhausted') {
    if ((entry.exhaustedUntil ?? 0) > Date.now()) return null
    // Cooldown expired — promote back to ok
    entry.status = 'ok'
    entry.exhaustedUntil = undefined
  }
  return entry.apiKey
}

// ── Error handling ────────────────────────────────────────────────────────────

/**
 * Called from the agent loop when a provider returns an HTTP error.
 * Marks the key exhausted with the appropriate cooldown.
 */
export function markExhausted(provider: string, httpStatus: number): void {
  const entry = _pool.get(provider)
  if (!entry) return
  let ttl: number
  if (httpStatus === 429)      ttl = TTL_429_MS
  else if (httpStatus === 401) ttl = TTL_401_MS
  else                         ttl = TTL_DEFAULT_MS
  entry.status = 'exhausted'
  entry.exhaustedUntil = Date.now() + ttl
}

/**
 * Mark a provider permanently dead (revoked token, invalid key, etc.).
 * Dead providers are excluded from rotation until updateKey() re-seeds them.
 */
export function markDead(provider: string): void {
  const entry = _pool.get(provider)
  if (entry) entry.status = 'dead'
}

// ── Introspection ─────────────────────────────────────────────────────────────

export interface PoolStatusEntry {
  status: CredStatus
  cooldownMs?: number
  hasKey: boolean
}

export function poolStatus(): Record<string, PoolStatusEntry> {
  const out: Record<string, PoolStatusEntry> = {}
  for (const [name, entry] of _pool) {
    const remaining = entry.exhaustedUntil
      ? Math.max(0, entry.exhaustedUntil - Date.now())
      : undefined
    out[name] = {
      status: entry.status,
      hasKey: Boolean(entry.apiKey),
      ...(remaining ? { cooldownMs: remaining } : {}),
    }
  }
  return out
}

/** Clear the pool — used in tests / after config reset. */
export function clearPool(): void {
  _pool.clear()
}
