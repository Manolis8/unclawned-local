import { db } from '../db.js'

export type FocusArea = 'technical' | 'business' | 'financial' | 'relational' | 'emotional'

const TRIBE_TO_FOCUS: Record<string, FocusArea> = {
  dev: 'technical',
  vc: 'financial',
  founder: 'business',
  operator: 'business',
  growth: 'business',
  media: 'relational',
}

const TASK_TO_FOCUS: Record<string, FocusArea> = {
  code: 'technical',
  plan: 'business',
  analyze: 'business',
  review: 'business',
  research: 'business',
  write: 'relational',
  brief: 'business',
}

const ACHIEVEMENT_TO_FOCUS: Record<string, FocusArea> = {
  raised: 'financial',
  hired: 'relational',
  closed: 'business',
  shipped: 'technical',
}

export const FOCUS_LABELS: Record<FocusArea, string> = {
  technical: 'technical / implementation work',
  business: 'business strategy and operations',
  financial: 'fundraising and financial matters',
  relational: 'relationship and communication work',
  emotional: 'personal and team dynamics',
}

export interface FocusConvergenceResult {
  area: FocusArea
  confirmedBy: string[]
  label: string
}

export function checkFocusConvergence(userId: string): FocusConvergenceResult | null {
  const votes = new Map<FocusArea, string[]>()

  function vote(area: FocusArea, source: string) {
    const existing = votes.get(area) ?? []
    votes.set(area, [...existing, source])
  }

  // Channel A: vocabulary tribe → focus area
  try {
    const row = db.prepare(`SELECT vocabulary_tribe FROM channel_a_profiles WHERE user_id = ?`).get(userId) as any
    if (row?.vocabulary_tribe) {
      const tribe = JSON.parse(row.vocabulary_tribe)
      const focus = TRIBE_TO_FOCUS[tribe.primary_tribe]
      if (focus) vote(focus, 'A')
    }
  } catch {}

  // Channel M: vocabulary drift direction → focus area (direct 1:1)
  try {
    const row = db.prepare(`SELECT drift_direction FROM channel_m_profiles WHERE user_id = ?`).get(userId) as any
    if (row?.drift_direction) vote(row.drift_direction as FocusArea, 'M')
  } catch {}

  // Channel G: dominant task category in last 30 days
  try {
    const row = db.prepare(`
      SELECT task_category, COUNT(*) as cnt
      FROM channel_g_task_snapshots
      WHERE user_id = ? AND created_at >= datetime('now', '-30 days')
      GROUP BY task_category
      ORDER BY cnt DESC
      LIMIT 1
    `).get(userId) as any
    if (row?.task_category) {
      const focus = TASK_TO_FOCUS[row.task_category]
      if (focus) vote(focus, 'G')
    }
  } catch {}

  // Channel O: dominant achievement type → focus area
  try {
    const row = db.prepare(`SELECT dominant_achievement_type FROM channel_o_profiles WHERE user_id = ?`).get(userId) as any
    if (row?.dominant_achievement_type) {
      const focus = ACHIEVEMENT_TO_FOCUS[row.dominant_achievement_type]
      if (focus) vote(focus, 'O')
    }
  } catch {}

  // Channel F: 3+ new contacts in last 14 days → relational signal
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM channel_f_relationship_profiles
      WHERE user_id = ? AND first_seen >= datetime('now', '-14 days')
    `).get(userId) as any
    if ((row?.cnt ?? 0) >= 3) vote('relational', 'F')
  } catch {}

  // Find the area with most votes
  let bestArea: FocusArea | null = null
  let bestSources: string[] = []
  for (const [area, sources] of votes) {
    if (sources.length > bestSources.length) {
      bestArea = area
      bestSources = sources
    }
  }

  if (!bestArea || bestSources.length < 3) return null

  return {
    area: bestArea,
    confirmedBy: bestSources,
    label: FOCUS_LABELS[bestArea],
  }
}
