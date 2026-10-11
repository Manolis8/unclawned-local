import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { db, uuid, j, p } from '../db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Tribes dictionary (loaded once) ─────────────────────────────────────────

interface TribeDictionary {
  tribes: Record<string, { terms: string[] }>
}

let _tribesData: TribeDictionary | null = null
function getTribesData(): TribeDictionary {
  if (!_tribesData) {
    _tribesData = JSON.parse(readFileSync(join(__dirname, '../../data/vocabulary-tribes.json'), 'utf8'))
  }
  return _tribesData!
}

const ALL_TASK_TYPES = ['write', 'research', 'analyze', 'plan', 'admin', 'code', 'review', 'brief', 'unknown']
const MIN_SAMPLES_FOR_TREND = 10    // need this many per type before trend is reliable
const WEEKS_FOR_NEGATIVE_SPACE = 8  // must observe for this many weeks before suppressing
const MIN_SAMPLES_FOR_NEG_SPACE = 50

// ─── Profile types ────────────────────────────────────────────────────────────

interface VocabularyTribeProfile {
  primary_tribe: string | null
  secondary_tribe: string | null
  tribe_scores: Record<string, number>
  tribe_word_hits: Record<string, string[]>
}

interface BaselineEntry {
  avg: number
  count: number
}

interface PromptEvolutionProfile {
  baseline_by_type: Record<string, BaselineEntry>
  current_trend: 'shortening' | 'lengthening' | 'stable'
  calibration_health: 'good' | 'regressing' | 'unknown'
  baseline_established: boolean
  lengthening_sessions_in_a_row: number
}

interface NegativeSpaceProfile {
  task_types_seen: string[]
  task_types_never_seen: string[]
  profile_started_at: string | null
  weeks_since_start: number
  negative_space_confident: boolean
  never_suggest: string[]
}

interface HedgingTypeCount {
  total: number
  hedged: number
}

interface HedgingProfile {
  counts_by_type: Record<string, HedgingTypeCount>
  hedging_by_type: Record<string, number>
  overall_hedging_rate: number
  high_hedging_types: string[]
  low_hedging_types: string[]
  sample_size: number
}

interface FrustrationPattern {
  pattern: string
  occurrences: number
  first_seen: string
  last_seen: string
}

interface FrustrationFingerprintProfile {
  known_patterns: FrustrationPattern[]
  personalized: boolean
  frustration_count_last_30_days: number
  last_frustration: string | null
}

export interface ChannelAProfile {
  last_updated: string
  total_samples: number
  vocabulary_tribe: VocabularyTribeProfile
  prompt_evolution: PromptEvolutionProfile
  negative_space: NegativeSpaceProfile
  hedging_profile: HedgingProfile
  frustration_fingerprint: FrustrationFingerprintProfile
}

export interface SignalData {
  taskType: string
  messageLength: number
  hedgingDetected: boolean
  frustrationDetected: boolean
  frustrationPhrases: string[]
}

// ─── Empty profile skeleton ───────────────────────────────────────────────────

function emptyProfile(): ChannelAProfile {
  return {
    last_updated: new Date().toISOString(),
    total_samples: 0,
    vocabulary_tribe: {
      primary_tribe: null,
      secondary_tribe: null,
      tribe_scores: {},
      tribe_word_hits: {},
    },
    prompt_evolution: {
      baseline_by_type: {},
      current_trend: 'stable',
      calibration_health: 'unknown',
      baseline_established: false,
      lengthening_sessions_in_a_row: 0,
    },
    negative_space: {
      task_types_seen: [],
      task_types_never_seen: [...ALL_TASK_TYPES],
      profile_started_at: null,
      weeks_since_start: 0,
      negative_space_confident: false,
      never_suggest: [],
    },
    hedging_profile: {
      counts_by_type: {},
      hedging_by_type: {},
      overall_hedging_rate: 0,
      high_hedging_types: [],
      low_hedging_types: [],
      sample_size: 0,
    },
    frustration_fingerprint: {
      known_patterns: [],
      personalized: false,
      frustration_count_last_30_days: 0,
      last_frustration: null,
    },
  }
}

// ─── DB read / write ──────────────────────────────────────────────────────────

export function getChannelAProfile(userId: string): ChannelAProfile | null {
  const row = db.prepare(
    'SELECT vocabulary_tribe, prompt_evolution, negative_space, hedging_profile, frustration_fingerprint, total_samples FROM channel_a_profiles WHERE user_id = ?'
  ).get(userId) as any

  if (!row) return null

  try {
    return {
      last_updated: new Date().toISOString(),
      total_samples: row.total_samples ?? 0,
      vocabulary_tribe: p(row.vocabulary_tribe) ?? emptyProfile().vocabulary_tribe,
      prompt_evolution: p(row.prompt_evolution) ?? emptyProfile().prompt_evolution,
      negative_space: p(row.negative_space) ?? emptyProfile().negative_space,
      hedging_profile: p(row.hedging_profile) ?? emptyProfile().hedging_profile,
      frustration_fingerprint: p(row.frustration_fingerprint) ?? emptyProfile().frustration_fingerprint,
    }
  } catch {
    return null
  }
}

function saveProfile(userId: string, profile: ChannelAProfile): void {
  const existing = db.prepare('SELECT user_id FROM channel_a_profiles WHERE user_id = ?').get(userId)

  if (existing) {
    db.prepare(`
      UPDATE channel_a_profiles SET
        last_updated = ?,
        profile_version = profile_version + 1,
        total_samples = ?,
        vocabulary_tribe = ?,
        prompt_evolution = ?,
        negative_space = ?,
        hedging_profile = ?,
        frustration_fingerprint = ?
      WHERE user_id = ?
    `).run(
      new Date().toISOString(),
      profile.total_samples,
      j(profile.vocabulary_tribe),
      j(profile.prompt_evolution),
      j(profile.negative_space),
      j(profile.hedging_profile),
      j(profile.frustration_fingerprint),
      userId
    )
  } else {
    db.prepare(`
      INSERT INTO channel_a_profiles (user_id, last_updated, profile_version, total_samples, vocabulary_tribe, prompt_evolution, negative_space, hedging_profile, frustration_fingerprint)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      new Date().toISOString(),
      profile.total_samples,
      j(profile.vocabulary_tribe),
      j(profile.prompt_evolution),
      j(profile.negative_space),
      j(profile.hedging_profile),
      j(profile.frustration_fingerprint)
    )
  }
}

// ─── Sub-profile updaters ─────────────────────────────────────────────────────

function updateVocabularyTribe(userId: string): VocabularyTribeProfile {
  const tribesData = getTribesData()

  // Read all words this user has used (from word frequency table — always current)
  const wordRows = db.prepare(
    'SELECT word FROM channel_a_word_frequency WHERE user_id = ?'
  ).all(userId) as { word: string }[]

  const seenWords = new Set(wordRows.map(r => r.word.toLowerCase()))

  const tribeScores: Record<string, number> = {}
  const tribeWordHits: Record<string, string[]> = {}

  for (const [tribe, { terms }] of Object.entries(tribesData.tribes)) {
    const seen: string[] = []
    for (const term of terms) {
      if (seenWords.has(term.toLowerCase())) {
        seen.push(term)
      }
    }
    tribeScores[tribe] = terms.length > 0 ? seen.length / terms.length : 0
    tribeWordHits[tribe] = seen
  }

  // Sort by score descending
  const sorted = Object.entries(tribeScores).sort((a, b) => b[1] - a[1])

  // Only report tribes above the minimum confidence threshold
  const CONFIDENCE_MIN = 0.03
  const primary = sorted[0]?.[1] >= CONFIDENCE_MIN ? sorted[0][0] : null
  const secondary = sorted[1]?.[1] >= CONFIDENCE_MIN ? sorted[1][0] : null

  return { primary_tribe: primary, secondary_tribe: secondary, tribe_scores: tribeScores, tribe_word_hits: tribeWordHits }
}

function updatePromptEvolution(
  userId: string,
  current: PromptEvolutionProfile,
  taskType: string,
  messageLength: number
): PromptEvolutionProfile {
  // ── Update running baseline for this task type ──
  const baseline = current.baseline_by_type[taskType]
  let updated: Record<string, BaselineEntry>

  if (baseline) {
    const newAvg = (baseline.avg * baseline.count + messageLength) / (baseline.count + 1)
    updated = { ...current.baseline_by_type, [taskType]: { avg: Math.round(newAvg), count: baseline.count + 1 } }
  } else {
    updated = { ...current.baseline_by_type, [taskType]: { avg: messageLength, count: 1 } }
  }

  const baselineEstablished = Object.values(updated).some(b => b.count >= 5)

  // ── Compute trend from last 20 signals ──
  // Only compute if we have enough baseline data to compare against
  if (!baselineEstablished) {
    return { ...current, baseline_by_type: updated, calibration_health: 'unknown', baseline_established: false }
  }

  const recentSignals = db.prepare(
    'SELECT message_length, task_type FROM channel_a_raw_signals WHERE user_id = ? AND extraction_error IS NULL ORDER BY created_at DESC LIMIT 20'
  ).all(userId) as { message_length: number, task_type: string }[]

  if (recentSignals.length < MIN_SAMPLES_FOR_TREND) {
    return { ...current, baseline_by_type: updated, calibration_health: 'unknown', baseline_established: baselineEstablished }
  }

  const half = Math.floor(recentSignals.length / 2)
  const recent = recentSignals.slice(0, half)
  const older = recentSignals.slice(half)

  function avgDeviation(signals: typeof recentSignals): number | null {
    const withBaseline = signals.filter(s => updated[s.task_type]?.count >= 5)
    if (withBaseline.length === 0) return null
    const total = withBaseline.reduce((sum, s) => sum + (s.message_length / updated[s.task_type].avg - 1), 0)
    return total / withBaseline.length
  }

  const recentDev = avgDeviation(recent)
  const olderDev = avgDeviation(older)

  let trend: 'shortening' | 'lengthening' | 'stable' = 'stable'
  if (recentDev !== null && olderDev !== null) {
    const diff = recentDev - olderDev
    if (diff < -0.15) trend = 'shortening'
    else if (diff > 0.15) trend = 'lengthening'
  }

  const calibrationHealth: 'good' | 'regressing' | 'unknown' =
    trend === 'lengthening' ? 'regressing' : 'good'

  // Count consecutive recent messages above their baseline
  let lengtheningInARow = 0
  for (const s of recent) {
    const b = updated[s.task_type]
    if (b && b.count >= 5 && s.message_length > b.avg * 1.1) {
      lengtheningInARow++
    } else {
      break
    }
  }

  return {
    baseline_by_type: updated,
    current_trend: trend,
    calibration_health: calibrationHealth,
    baseline_established: baselineEstablished,
    lengthening_sessions_in_a_row: lengtheningInARow,
  }
}

function updateNegativeSpace(
  userId: string,
  current: NegativeSpaceProfile,
  taskType: string,
  totalSamples: number
): NegativeSpaceProfile {
  // Get or set the start date
  let profileStartedAt = current.profile_started_at
  if (!profileStartedAt) {
    const firstSignal = db.prepare(
      'SELECT created_at FROM channel_a_raw_signals WHERE user_id = ? ORDER BY created_at ASC LIMIT 1'
    ).get(userId) as { created_at: string } | undefined
    profileStartedAt = firstSignal?.created_at ?? new Date().toISOString()
  }

  // Add to seen set
  const seen = new Set(current.task_types_seen)
  seen.add(taskType)
  const seenArray = Array.from(seen)
  const neverSeen = ALL_TASK_TYPES.filter(t => !seen.has(t))

  // Weeks since start
  const weeksSinceStart = Math.floor(
    (Date.now() - new Date(profileStartedAt).getTime()) / (7 * 24 * 60 * 60 * 1000)
  )

  const confident =
    weeksSinceStart >= WEEKS_FOR_NEGATIVE_SPACE &&
    totalSamples >= MIN_SAMPLES_FOR_NEG_SPACE

  return {
    task_types_seen: seenArray,
    task_types_never_seen: neverSeen,
    profile_started_at: profileStartedAt,
    weeks_since_start: weeksSinceStart,
    negative_space_confident: confident,
    never_suggest: current.never_suggest,
  }
}

function updateHedgingProfile(
  current: HedgingProfile,
  taskType: string,
  hedgingDetected: boolean
): HedgingProfile {
  // Update counts for this task type
  const existingCount = current.counts_by_type[taskType] ?? { total: 0, hedged: 0 }
  const updatedCount: HedgingTypeCount = {
    total: existingCount.total + 1,
    hedged: existingCount.hedged + (hedgingDetected ? 1 : 0),
  }
  const updatedCounts = { ...current.counts_by_type, [taskType]: updatedCount }

  // Recompute rates
  const hedgingByType: Record<string, number> = {}
  let totalMessages = 0
  let totalHedged = 0

  for (const [type, counts] of Object.entries(updatedCounts)) {
    hedgingByType[type] = counts.total > 0 ? counts.hedged / counts.total : 0
    totalMessages += counts.total
    totalHedged += counts.hedged
  }

  const overallRate = totalMessages > 0 ? totalHedged / totalMessages : 0

  // High hedging: > 30% rate AND at least 5 samples for that type
  // Low hedging: < 10% rate AND at least 5 samples for that type
  const highHedgingTypes = Object.entries(hedgingByType)
    .filter(([t, rate]) => rate > 0.30 && (updatedCounts[t]?.total ?? 0) >= 5)
    .map(([t]) => t)

  const lowHedgingTypes = Object.entries(hedgingByType)
    .filter(([t, rate]) => rate < 0.10 && (updatedCounts[t]?.total ?? 0) >= 5)
    .map(([t]) => t)

  return {
    counts_by_type: updatedCounts,
    hedging_by_type: hedgingByType,
    overall_hedging_rate: overallRate,
    high_hedging_types: highHedgingTypes,
    low_hedging_types: lowHedgingTypes,
    sample_size: totalMessages,
  }
}

function updateFrustrationFingerprint(
  current: FrustrationFingerprintProfile,
  frustrationDetected: boolean,
  frustrationPhrases: string[]
): FrustrationFingerprintProfile {
  if (!frustrationDetected || frustrationPhrases.length === 0) {
    // Still recompute the 30-day count since time has passed
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const recentCount = current.known_patterns.filter(
      p => p.last_seen >= thirtyDaysAgo
    ).reduce((sum, p) => sum + p.occurrences, 0)

    return { ...current, frustration_count_last_30_days: recentCount }
  }

  const now = new Date().toISOString()
  const updatedPatterns = [...current.known_patterns]

  for (const phrase of frustrationPhrases) {
    const existing = updatedPatterns.find(p => p.pattern === phrase)
    if (existing) {
      existing.occurrences += 1
      existing.last_seen = now
    } else {
      updatedPatterns.push({ pattern: phrase, occurrences: 1, first_seen: now, last_seen: now })
    }
  }

  // Personalized: 2+ patterns seen 3+ times independently
  const confirmedCount = updatedPatterns.filter(p => p.occurrences >= 3).length
  const personalized = confirmedCount >= 2

  // 30-day frustration count: sum of occurrences for patterns seen in last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const recentCount = updatedPatterns
    .filter(p => p.last_seen >= thirtyDaysAgo)
    .reduce((sum, p) => sum + p.occurrences, 0)

  return {
    known_patterns: updatedPatterns,
    personalized,
    frustration_count_last_30_days: recentCount,
    last_frustration: now,
  }
}

// ─── Main export: incremental profile update ──────────────────────────────────

export function updateChannelAProfile(userId: string, signal: SignalData): void {
  try {
    const current = getChannelAProfile(userId) ?? emptyProfile()
    const newTotalSamples = current.total_samples + 1

    const vocabulary_tribe = updateVocabularyTribe(userId)

    const prompt_evolution = updatePromptEvolution(
      userId,
      current.prompt_evolution,
      signal.taskType,
      signal.messageLength
    )

    const negative_space = updateNegativeSpace(
      userId,
      current.negative_space,
      signal.taskType,
      newTotalSamples
    )

    const hedging_profile = updateHedgingProfile(
      current.hedging_profile,
      signal.taskType,
      signal.hedgingDetected
    )

    const frustration_fingerprint = updateFrustrationFingerprint(
      current.frustration_fingerprint,
      signal.frustrationDetected,
      signal.frustrationPhrases
    )

    const updated: ChannelAProfile = {
      last_updated: new Date().toISOString(),
      total_samples: newTotalSamples,
      vocabulary_tribe,
      prompt_evolution,
      negative_space,
      hedging_profile,
      frustration_fingerprint,
    }

    saveProfile(userId, updated)

  } catch (err) {
    // Profile update must never block extraction
    console.error('[channel-a] Profile update failed:', err)
  }
}

// ─── Helper for extractor: get known frustration patterns from profile ────────

export function getKnownFrustrationPatterns(userId: string): string[] {
  const profile = getChannelAProfile(userId)
  if (!profile) return []
  return profile.frustration_fingerprint.known_patterns
    .filter(p => p.occurrences >= 2)  // only use patterns seen at least twice
    .map(p => p.pattern)
}
