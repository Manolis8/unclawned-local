import { db } from '../../db.js'
import { enqueueInsight } from '../queue.js'

const MIN_TASKS = 3

export function detectHiddenPriority(userId: string): void {
  try {
    // Top task category in last 30 days
    const topCat = db.prepare(`
      SELECT task_category, COUNT(*) as c, COUNT(*) * 100.0 / SUM(COUNT(*)) OVER () as pct
      FROM channel_g_task_snapshots
      WHERE user_id = ? AND datetime(created_at) > datetime('now', '-30 days')
      GROUP BY task_category
      ORDER BY c DESC
      LIMIT 1
    `).get(userId) as any
    if (!topCat || topCat.c < MIN_TASKS) return

    // Vocabulary drift direction
    const mProfile = db.prepare(`SELECT drift_direction FROM channel_m_profiles WHERE user_id = ?`).get(userId) as any
    if (!mProfile?.drift_direction) return

    // Stated goals
    const goalsRow = db.prepare(`SELECT value FROM user_profile WHERE user_id = ? AND key = 'current_goals'`).get(userId) as any
    const goals = (goalsRow?.value || '').toLowerCase()

    const category = topCat.task_category.toLowerCase()
    const drift = mProfile.drift_direction.toLowerCase()
    const pct = Math.round(topCat.pct)

    // Both task distribution AND vocabulary point somewhere goals don't mention
    const goalWords = goals.split(/[\s,;]+/).filter((w: string) => w.length > 4)
    const catWords = category.split(/[\s_]+/).filter((w: string) => w.length > 3)
    const driftWords = drift.split(/[\s,;]+/).filter((w: string) => w.length > 3)

    const catInGoals = catWords.some(w => goalWords.some((g: string) => g.includes(w) || w.includes(g)))
    const driftInGoals = driftWords.some(w => goalWords.some((g: string) => g.includes(w) || w.includes(g)))

    // Only fire if BOTH are outside stated goals
    if (catInGoals || driftInGoals) return

    const insightText = `${pct}% of your recent work has been on "${topCat.task_category}" and your vocabulary has been drifting toward "${mProfile.drift_direction}" — but neither appears in your stated goals.`
    const questionText = `Is "${topCat.task_category}" becoming your actual priority right now?`

    const evidence = {
      channels: ['channel_g', 'channel_m', 'user_profile'],
      task_category: topCat.task_category,
      task_pct: pct,
      drift_direction: mProfile.drift_direction,
      goals_snapshot: goals.slice(0, 100),
      observations: [
        `${pct}% of tasks in last 30 days: "${topCat.task_category}"`,
        `Vocabulary drifting toward: "${mProfile.drift_direction}"`,
        `Not in stated goals: "${goals.slice(0, 80) || 'none set'}"`
      ]
    }

    enqueueInsight(
      userId,
      'hidden_priority',
      insightText,
      questionText,
      evidence,
      7.5, 0.70, 3.5,
      'compound'
    )
  } catch {}
}
