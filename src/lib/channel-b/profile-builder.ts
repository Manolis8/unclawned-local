import { db, j, p } from '../db.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LevelCounts {
  L1: number; L2: number; L3: number; L4: number; L5: number
}

export interface CorrectionTaskStats {
  total_reactions: number
  corrections: number
  correction_rate: number
  level_counts: LevelCounts
  most_common_level: string | null
  trust_class: 'HIGH_TRUST' | 'OVERCORRECTED' | 'RUBBER_STAMP_DISENGAGEMENT' | 'NORMAL'
}

export interface CorrectionProfile {
  by_task_type: Record<string, CorrectionTaskStats>
  high_correction_types: string[]
  low_correction_types: string[]
}

export interface PasteTypeCounts {
  email_thread: number
  article_content: number
  data_numbers: number
  code: number
  formal_document: number
  external_writing: number
  unknown: number
}

export interface PasteProfile {
  total_pastes: number
  by_type: PasteTypeCounts
  paste_topic_focus: string | null
}

export interface LatencyTaskStats {
  count: number
  sum_seconds: number
  avg_seconds: number
  immediate_count: number
  rubber_stamp_count: number
  immediate_rate: number
  rubber_stamp_rate: number
  dominant_bucket: string | null
  bucket_counts: Record<string, number>
}

export interface LatencyProfile {
  by_task_type: Record<string, LatencyTaskStats>
  fast_task_types: string[]
  slow_task_types: string[]
  rubber_stamp_types: string[]
}

export interface ChannelBProfile {
  total_reactions: number
  profile_version: number
  last_updated: string
  correction_profile: CorrectionProfile
  paste_profile: PasteProfile
  latency_profile: LatencyProfile
}

export interface SignalForProfile {
  priorTaskType: string | null
  isContinuation: boolean
  isCorrection: boolean
  correctionLevel: number | null
  containsPaste: boolean
  pasteType: string | null
  latencySeconds: number | null
  latencyBucket: string | null
  isRubberStamp: boolean
}

// ─── Empty constructors ───────────────────────────────────────────────────────

function createEmptyCorrectionStats(): CorrectionTaskStats {
  return {
    total_reactions: 0,
    corrections: 0,
    correction_rate: 0,
    level_counts: { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 },
    most_common_level: null,
    trust_class: 'NORMAL',
  }
}

function createEmptyLatencyStats(): LatencyTaskStats {
  return {
    count: 0,
    sum_seconds: 0,
    avg_seconds: 0,
    immediate_count: 0,
    rubber_stamp_count: 0,
    immediate_rate: 0,
    rubber_stamp_rate: 0,
    dominant_bucket: null,
    bucket_counts: {},
  }
}

function createEmptyProfile(): ChannelBProfile {
  return {
    total_reactions: 0,
    profile_version: 1,
    last_updated: new Date().toISOString(),
    correction_profile: {
      by_task_type: {},
      high_correction_types: [],
      low_correction_types: [],
    },
    paste_profile: {
      total_pastes: 0,
      by_type: {
        email_thread: 0, article_content: 0, data_numbers: 0,
        code: 0, formal_document: 0, external_writing: 0, unknown: 0,
      },
      paste_topic_focus: null,
    },
    latency_profile: {
      by_task_type: {},
      fast_task_types: [],
      slow_task_types: [],
      rubber_stamp_types: [],
    },
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

export function getChannelBProfile(userId: string): ChannelBProfile | null {
  const row = db.prepare("SELECT * FROM channel_b_profiles WHERE user_id = ?").get(userId) as any
  if (!row) return null
  return {
    total_reactions: row.total_reactions ?? 0,
    profile_version: row.profile_version ?? 1,
    last_updated: row.last_updated ?? new Date().toISOString(),
    correction_profile: p(row.correction_profile) ?? { by_task_type: {}, high_correction_types: [], low_correction_types: [] },
    paste_profile: p(row.paste_profile) ?? { total_pastes: 0, by_type: { email_thread: 0, article_content: 0, data_numbers: 0, code: 0, formal_document: 0, external_writing: 0, unknown: 0 }, paste_topic_focus: null },
    latency_profile: p(row.latency_profile) ?? { by_task_type: {}, fast_task_types: [], slow_task_types: [], rubber_stamp_types: [] },
  }
}

function saveChannelBProfile(userId: string, profile: ChannelBProfile): void {
  db.prepare(`
    INSERT OR REPLACE INTO channel_b_profiles
      (user_id, last_updated, profile_version, total_reactions, correction_profile, paste_profile, latency_profile, approval_profile)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    userId,
    profile.last_updated,
    profile.profile_version,
    profile.total_reactions,
    j(profile.correction_profile),
    j(profile.paste_profile),
    j(profile.latency_profile)
  )
}

// ─── Computation helpers ──────────────────────────────────────────────────────

function computeMostCommonLevel(counts: LevelCounts): string | null {
  const levels = ['L1', 'L2', 'L3', 'L4', 'L5'] as const
  let best: string | null = null
  let bestCount = 0
  for (const level of levels) {
    const c = counts[level] ?? 0
    if (c > bestCount) { bestCount = c; best = level }
  }
  return bestCount > 0 ? best : null
}

function computeDominantBucket(bucketCounts: Record<string, number>): string | null {
  let best: string | null = null
  let bestCount = 0
  for (const [bucket, count] of Object.entries(bucketCounts)) {
    if (count > bestCount) { bestCount = count; best = bucket }
  }
  return best
}

function computePasteTopicFocus(userId: string): string | null {
  const row = db.prepare(`
    SELECT primary_tribe, COUNT(*) as cnt
    FROM channel_b_paste_log
    WHERE user_id = ?
      AND primary_tribe IS NOT NULL
      AND datetime(created_at) >= datetime('now', '-14 days')
    GROUP BY primary_tribe
    ORDER BY cnt DESC
    LIMIT 1
  `).get(userId) as { primary_tribe: string; cnt: number } | undefined
  return row && row.cnt >= 2 ? row.primary_tribe : null
}

function recomputeHighLowTypes(cp: CorrectionProfile): void {
  const high: string[] = []
  const low: string[] = []
  for (const [taskType, stats] of Object.entries(cp.by_task_type)) {
    if (stats.total_reactions < 5) continue
    if (stats.correction_rate > 0.30) high.push(taskType)
    else if (stats.correction_rate < 0.10) low.push(taskType)
  }
  cp.high_correction_types = high
  cp.low_correction_types = low
}

function recomputeLatencyFlags(lp: LatencyProfile): void {
  const fast: string[] = []
  const slow: string[] = []
  const rubber: string[] = []
  for (const [taskType, stats] of Object.entries(lp.by_task_type)) {
    if (stats.count < 5) continue
    if (stats.dominant_bucket === 'immediate') fast.push(taskType)
    if (stats.dominant_bucket === 'slow') slow.push(taskType)
    if (stats.rubber_stamp_rate > 0.4) rubber.push(taskType)
  }
  lp.fast_task_types = fast
  lp.slow_task_types = slow
  lp.rubber_stamp_types = rubber
}

function recomputeTrustClasses(cp: CorrectionProfile, lp: LatencyProfile): void {
  for (const [taskType, stats] of Object.entries(cp.by_task_type)) {
    if (stats.total_reactions < 5) { stats.trust_class = 'NORMAL'; continue }
    const lStats = lp.by_task_type[taskType]
    const rsRate = lStats?.rubber_stamp_rate ?? 0
    if (rsRate > 0.4 && stats.correction_rate > 0.25) {
      stats.trust_class = 'RUBBER_STAMP_DISENGAGEMENT'
    } else if (stats.correction_rate > 0.30) {
      stats.trust_class = 'OVERCORRECTED'
    } else if (rsRate > 0.4 && stats.correction_rate < 0.10) {
      stats.trust_class = 'HIGH_TRUST'
    } else {
      stats.trust_class = 'NORMAL'
    }
  }
}

// ─── Main update ──────────────────────────────────────────────────────────────

export function updateChannelBProfile(userId: string, signal: SignalForProfile): void {
  const profile = getChannelBProfile(userId) ?? createEmptyProfile()

  profile.total_reactions++

  // Correction profile: runs for every event on a known task type
  if (signal.priorTaskType) {
    const cp = profile.correction_profile
    if (!cp.by_task_type[signal.priorTaskType]) {
      cp.by_task_type[signal.priorTaskType] = createEmptyCorrectionStats()
    }
    const stats = cp.by_task_type[signal.priorTaskType]
    stats.total_reactions++

    if (signal.isContinuation && signal.isCorrection && signal.correctionLevel !== null) {
      stats.corrections++
      const key = `L${signal.correctionLevel}` as keyof LevelCounts
      stats.level_counts[key]++
      stats.most_common_level = computeMostCommonLevel(stats.level_counts)
    }

    stats.correction_rate = stats.total_reactions > 0 ? stats.corrections / stats.total_reactions : 0
    recomputeHighLowTypes(cp)
  }

  // Paste profile: runs when paste was detected
  if (signal.containsPaste && signal.pasteType) {
    profile.paste_profile.total_pastes++
    const pt = signal.pasteType as keyof PasteTypeCounts
    if (pt in profile.paste_profile.by_type) profile.paste_profile.by_type[pt]++
    profile.paste_profile.paste_topic_focus = computePasteTopicFocus(userId)
  }

  // Latency profile: runs for valid latency events only
  if (signal.priorTaskType && signal.latencySeconds !== null &&
      signal.latencyBucket && signal.latencyBucket !== 'session_break' && signal.latencyBucket !== 'invalid') {
    const lp = profile.latency_profile
    if (!lp.by_task_type[signal.priorTaskType]) {
      lp.by_task_type[signal.priorTaskType] = createEmptyLatencyStats()
    }
    const ls = lp.by_task_type[signal.priorTaskType]
    ls.count++
    ls.sum_seconds += signal.latencySeconds
    ls.avg_seconds = Math.round(ls.sum_seconds / ls.count)
    if (signal.latencyBucket === 'immediate') ls.immediate_count++
    if (signal.isRubberStamp) ls.rubber_stamp_count++
    ls.immediate_rate = ls.count > 0 ? ls.immediate_count / ls.count : 0
    ls.rubber_stamp_rate = ls.count > 0 ? ls.rubber_stamp_count / ls.count : 0
    ls.bucket_counts[signal.latencyBucket] = (ls.bucket_counts[signal.latencyBucket] ?? 0) + 1
    ls.dominant_bucket = computeDominantBucket(ls.bucket_counts)
    recomputeLatencyFlags(lp)
  }

  recomputeTrustClasses(profile.correction_profile, profile.latency_profile)
  profile.last_updated = new Date().toISOString()
  saveChannelBProfile(userId, profile)
}

// ─── Level upgrade (for multi-turn merge) ────────────────────────────────────
//
// When a merged correction has a higher level than the first correction, the
// profile was already updated with the first (lower) level. Undo that and apply
// the correct higher level so most_common_level stays accurate.

export function upgradeCorrectionLevel(userId: string, taskType: string, oldLevel: number, newLevel: number): void {
  if (oldLevel === newLevel) return

  const profile = getChannelBProfile(userId)
  if (!profile) return

  const stats = profile.correction_profile.by_task_type[taskType]
  if (!stats) return

  const oldKey = `L${oldLevel}` as keyof LevelCounts
  const newKey = `L${newLevel}` as keyof LevelCounts
  stats.level_counts[oldKey] = Math.max(0, (stats.level_counts[oldKey] ?? 0) - 1)
  stats.level_counts[newKey] = (stats.level_counts[newKey] ?? 0) + 1
  stats.most_common_level = computeMostCommonLevel(stats.level_counts)

  recomputeHighLowTypes(profile.correction_profile)
  recomputeTrustClasses(profile.correction_profile, profile.latency_profile)
  profile.last_updated = new Date().toISOString()
  saveChannelBProfile(userId, profile)
}
