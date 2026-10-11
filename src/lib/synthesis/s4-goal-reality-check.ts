import { db } from '../db.js'
import { FocusArea, FOCUS_LABELS } from './s1-focus-convergence.js'

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
  admin: 'business',
}

export interface GoalRealityResult {
  statedFocus: FocusArea
  actualFocus: FocusArea
  actualPercentage: number
  statedLabel: string
  actualLabel: string
}

export function checkGoalReality(userId: string): GoalRealityResult | null {
  // Stated focus: try Channel A tribe first, then Channel M drift
  let statedFocus: FocusArea | null = null

  try {
    const row = db.prepare(`SELECT vocabulary_tribe FROM channel_a_profiles WHERE user_id = ?`).get(userId) as any
    if (row?.vocabulary_tribe) {
      const tribe = JSON.parse(row.vocabulary_tribe)
      statedFocus = TRIBE_TO_FOCUS[tribe.primary_tribe] ?? null
    }
  } catch {}

  if (!statedFocus) {
    try {
      const row = db.prepare(`SELECT drift_direction FROM channel_m_profiles WHERE user_id = ?`).get(userId) as any
      if (row?.drift_direction) statedFocus = row.drift_direction as FocusArea
    } catch {}
  }

  if (!statedFocus) return null

  // Actual behavior: task distribution from Channel G last 30 days
  let rows: any[] = []
  try {
    rows = db.prepare(`
      SELECT task_category, COUNT(*) as cnt
      FROM channel_g_task_snapshots
      WHERE user_id = ? AND created_at >= datetime('now', '-30 days')
      GROUP BY task_category
      ORDER BY cnt DESC
    `).all(userId) as any[]
  } catch { return null }

  const total = rows.reduce((sum, r) => sum + r.cnt, 0)
  if (total < 10) return null  // need enough data before calling drift

  // Aggregate task counts into focus areas
  const focusCounts = new Map<FocusArea, number>()
  for (const r of rows) {
    const focus = TASK_TO_FOCUS[r.task_category]
    if (focus) focusCounts.set(focus, (focusCounts.get(focus) ?? 0) + r.cnt)
  }

  // Find actual dominant focus area
  let actualFocus: FocusArea | null = null
  let actualCount = 0
  for (const [area, cnt] of focusCounts) {
    if (cnt > actualCount) { actualFocus = area; actualCount = cnt }
  }

  if (!actualFocus) return null

  const actualPercentage = Math.round((actualCount / total) * 100)

  // Only surface if there's a real divergence and the actual focus dominates
  if (actualFocus === statedFocus) return null
  if (actualPercentage < 50) return null

  return {
    statedFocus,
    actualFocus,
    actualPercentage,
    statedLabel: FOCUS_LABELS[statedFocus],
    actualLabel: FOCUS_LABELS[actualFocus],
  }
}
