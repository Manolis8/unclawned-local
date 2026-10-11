import { getChannelAProfile } from './profile-builder.js'
import { normalizeMessage } from './normalizer.js'
import { detectFrustration } from './frustration-detector.js'
import { getKnownFrustrationPatterns } from './profile-builder.js'
import { db } from '../db.js'

// ─── Sample thresholds (cold-start gates) ─────────────────────────────────────
// The profile must have enough data before each signal type is trusted.

const TRIBE_MIN       = 5    // tribe detection needs at least 5 messages
const HEDGING_MIN     = 15   // hedging profile needs at least 15 messages
const EVOLUTION_MIN   = 30   // calibration health needs at least 30 messages

// ─── Profile context block ────────────────────────────────────────────────────
//
// Returns a short, agent-readable block injected into the system prompt.
// Returns empty string when there is insufficient data — never injects noise.
//
// Keep this SHORT. Every line here costs token budget. The goal is 3-5 lines
// of signal, not a full profile dump.

export function buildChannelAContextBlock(userId: string): string {
  try {
    const profile = getChannelAProfile(userId)
    if (!profile || profile.total_samples < TRIBE_MIN) return ''

    const lines: string[] = []
    const samples = profile.total_samples

    // ── A.1 Vocabulary tribe ──────────────────────────────────────────────────
    const tribe = profile.vocabulary_tribe
    if (tribe.primary_tribe) {
      const score = tribe.tribe_scores[tribe.primary_tribe] ?? 0
      if (score >= 0.05) {
        const topWords = (tribe.tribe_word_hits[tribe.primary_tribe] ?? [])
          .slice(0, 5)
          .join(', ')
        lines.push(
          `User vocabulary tribe: ${tribe.primary_tribe}` +
          (topWords ? ` (${topWords})` : '')
        )
      }
    }

    // ── A.4 Hedging profile ───────────────────────────────────────────────────
    if (samples >= HEDGING_MIN) {
      const hedging = profile.hedging_profile

      if (hedging.high_hedging_types.length > 0) {
        lines.push(
          `User is uncertain on ${hedging.high_hedging_types.join(', ')} tasks` +
          ` — offer options or ask one clarifying question before executing`
        )
      }
      if (hedging.low_hedging_types.length > 0) {
        lines.push(
          `User is confident on ${hedging.low_hedging_types.join(', ')} tasks` +
          ` — just execute, no need to ask`
        )
      }
    }

    // ── A.2 Calibration health ────────────────────────────────────────────────
    if (samples >= EVOLUTION_MIN) {
      const evolution = profile.prompt_evolution
      if (evolution.calibration_health === 'regressing') {
        lines.push(
          `[CALIBRATION] User prompt length is trending longer than baseline` +
          ` — likely friction with recent outputs, be more direct`
        )
      } else if (evolution.lengthening_sessions_in_a_row >= 3) {
        lines.push(
          `[CALIBRATION] 3+ messages above baseline length — user may be over-explaining, check for misalignment`
        )
      }

      // ── A.3 Negative space (only when confident — 8 weeks + 50 samples) ───
      const negSpace = profile.negative_space
      if (negSpace.negative_space_confident && negSpace.task_types_never_seen.length > 0) {
        lines.push(
          `User has never requested: ${negSpace.task_types_never_seen.join(', ')}` +
          ` — do not proactively suggest these`
        )
      }
    }

    if (lines.length === 0) return ''

    return `## User Signal Intelligence\n${lines.join('\n')}`

  } catch {
    // Profile reading must never crash the agent
    return ''
  }
}

// ─── Per-message frustration context line ─────────────────────────────────────
//
// Called at message time when a frustration signal is detected in the CURRENT
// message. This is NOT from the profile (which is historical) — it's live.
// Returned string is appended to the system prompt for this response only.

export function getFrustrationContextLine(frustrationDetected: boolean): string {
  if (!frustrationDetected) return ''
  // Instructs the agent to change behavior without acknowledging the frustration
  // out loud — the behavior change IS the response, not commentary about it.
  return `[FRUSTRATION] User is correcting previous output — respond shorter, skip preamble, skip options, give the direct answer only`
}

// ─── Live per-message frustration check ────────────────────────────────────────
//
// Runs frustration detection SYNCHRONOUSLY so the result can be injected into
// the CURRENT response's system prompt. (The extraction pipeline is fire-and-
// forget and only writes to the profile — it cannot feed the current response.)
//
// Only meaningful when priorTurnCount >= 1 (must be in a back-and-forth).

export function buildLiveFrustrationLine(
  userId: string,
  message: string,
  priorTurnCount: number
): string {
  if (priorTurnCount < 1) return ''
  try {
    const norm = normalizeMessage(message)
    const knownPatterns = getKnownFrustrationPatterns(userId)
    const result = detectFrustration(norm.normalizedText, priorTurnCount, knownPatterns)
    return getFrustrationContextLine(result.detected)
  } catch {
    return ''
  }
}

// ─── Injection counter ─────────────────────────────────────────────────────────
//
// Tracks how many times a non-empty context block was injected into an agent
// response. Used by the debug report to verify the profile is actually being used.
// Stored in a lightweight SQLite table rather than adding a column to the profile
// (avoids the need for a schema migration on the profiles table).

export function recordChannelAInjection(userId: string): void {
  try {
    db.prepare(`
      INSERT INTO channel_a_injection_log (user_id, injected_at)
      VALUES (?, datetime('now'))
    `).run(userId)
  } catch {
    // Table might not exist yet on old installs — non-fatal
  }
}

export function getInjectionCount(userId: string, lastN = 10): { total: number; inLastN: number; lastInjection: string | null } {
  try {
    const total = (db.prepare('SELECT COUNT(*) as c FROM channel_a_injection_log WHERE user_id = ?').get(userId) as any)?.c ?? 0
    const inLastN = (db.prepare(
      'SELECT COUNT(*) as c FROM channel_a_injection_log WHERE user_id = ? ORDER BY injected_at DESC LIMIT ?'
    ).get(userId, lastN) as any)?.c ?? 0
    const last = (db.prepare(
      'SELECT injected_at FROM channel_a_injection_log WHERE user_id = ? ORDER BY injected_at DESC LIMIT 1'
    ).get(userId) as any)?.injected_at ?? null
    return { total, inLastN, lastInjection: last }
  } catch {
    return { total: 0, inLastN: 0, lastInjection: null }
  }
}

// ─── Debug report ─────────────────────────────────────────────────────────────
//
// Returns a human-readable debug report for the /debug channel-a endpoint.

export function buildDebugReport(userId: string): string {
  const profile = getChannelAProfile(userId)

  if (!profile) {
    return [
      '═══════════════════════════════════════',
      'CHANNEL A DEBUG REPORT',
      `User: ${userId}`,
      '═══════════════════════════════════════',
      '',
      'No profile found. No signals have been collected yet.',
      'Send at least 5 messages through the chat or task interface to start.',
      '',
    ].join('\n')
  }

  const tribe = profile.vocabulary_tribe
  const evolution = profile.prompt_evolution
  const negSpace = profile.negative_space
  const hedging = profile.hedging_profile
  const frustration = profile.frustration_fingerprint

  // Tribe bar chart
  const tribeRows = Object.entries(tribe.tribe_scores)
    .sort((a, b) => b[1] - a[1])
    .map(([t, score]) => {
      const pct = Math.round(score * 100)
      const bar = '█'.repeat(Math.round(score * 20)).padEnd(20, '░')
      return `  ${t.padEnd(20)} ${bar} ${pct}%`
    })
    .join('\n')

  // Hedging rows
  const hedgingRows = Object.entries(hedging.counts_by_type)
    .map(([type, c]: [string, any]) => {
      const rate = c.total > 0 ? Math.round((c.hedged / c.total) * 100) : 0
      const flag = rate > 30 ? ' ← HIGH' : rate < 10 && c.total >= 5 ? ' ← LOW' : ''
      return `  ${type.padEnd(12)} ${c.hedged}/${c.total} hedged (${rate}%)${flag}`
    })
    .join('\n')

  // Baseline rows
  const baselineRows = Object.entries(evolution.baseline_by_type)
    .map(([type, entry]: [string, any]) =>
      `  ${type.padEnd(12)} avg=${entry.avg} chars (n=${entry.count})`
    )
    .join('\n')

  // Frustration patterns
  const frustrationRows = frustration.known_patterns.length > 0
    ? frustration.known_patterns
        .sort((a, b) => b.occurrences - a.occurrences)
        .map(p => `  "${p.pattern}" — ${p.occurrences}x (last: ${p.last_seen.slice(0, 10)})`)
        .join('\n')
    : '  (none yet)'

  // Context block preview
  const contextBlock = buildChannelAContextBlock(userId) || '  (insufficient data — cold start)'

  // Injection counter
  const injectionStats = getInjectionCount(userId, 10)
  const injectionLine = injectionStats.total === 0
    ? '  0 total — profile built but not yet used in a response (check injection wiring!)'
    : `  ${injectionStats.total} total | last: ${injectionStats.lastInjection ?? 'unknown'}`

  const lines = [
    '═══════════════════════════════════════',
    'CHANNEL A DEBUG REPORT',
    `User: ${userId}`,
    `Generated: ${new Date().toISOString()}`,
    '═══════════════════════════════════════',
    '',
    'COLLECTION STATUS',
    '─────────────────',
    `Total signals: ${profile.total_samples}`,
    `Profile started: ${negSpace.profile_started_at ?? 'unknown'}`,
    `Weeks observed: ${negSpace.weeks_since_start}`,
    `Task types seen: ${negSpace.task_types_seen.join(', ') || 'none'}`,
    `Task types never seen: ${negSpace.task_types_never_seen.join(', ') || 'none'}`,
    `Negative space confident: ${negSpace.negative_space_confident}`,
    '',
    'A.1 — VOCABULARY TRIBE',
    '──────────────────────',
    `Primary:   ${tribe.primary_tribe ?? '(none — insufficient data)'}`,
    `Secondary: ${tribe.secondary_tribe ?? 'none'}`,
    tribeRows,
    '',
    'A.2 — PROMPT EVOLUTION',
    '──────────────────────',
    `Calibration health: ${evolution.calibration_health}`,
    `Trend: ${evolution.current_trend}`,
    `Baseline established: ${evolution.baseline_established}`,
    `Lengthening in a row: ${evolution.lengthening_sessions_in_a_row}`,
    baselineRows || '  (no baselines yet)',
    '',
    'A.4 — HEDGING PROFILE',
    '─────────────────────',
    `Overall rate: ${Math.round(hedging.overall_hedging_rate * 100)}%`,
    `High hedging types: ${hedging.high_hedging_types.join(', ') || 'none yet'}`,
    `Low hedging types:  ${hedging.low_hedging_types.join(', ') || 'none yet'}`,
    hedgingRows || '  (no data yet)',
    '',
    'A.5 — FRUSTRATION FINGERPRINT',
    '──────────────────────────────',
    `Personalized: ${frustration.personalized}`,
    `Frustrations (last 30 days): ${frustration.frustration_count_last_30_days}`,
    `Last frustration: ${frustration.last_frustration ?? 'none'}`,
    frustrationRows,
    '',
    'INJECTION STATUS',
    '─────────────────',
    injectionLine,
    '',
    'CONTEXT BLOCK (what agent sees)',
    '────────────────────────────────',
    contextBlock,
    '',
    '═══════════════════════════════════════',
  ]

  return lines.join('\n')
}
