import { db } from '../../db.js'
import { enqueueInsight } from '../queue.js'

const MIN_TASKS = 5
const MIN_PRIORITY_AVOID = 2
const DISTRACTION_PCT = 40  // top category taking 40%+ of time is significant

export function detectTimeTrap(userId: string): void {
  try {
    // Channel G: find dominant task category over last 60 days
    const topTask = db.prepare(`
      SELECT task_category,
             COUNT(*) as c,
             ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 0) as pct
      FROM channel_g_task_snapshots
      WHERE user_id = ? AND datetime(created_at) > datetime('now', '-60 days')
      GROUP BY task_category ORDER BY c DESC LIMIT 1
    `).get(userId) as any

    if (!topTask || topTask.c < MIN_TASKS) return
    const pct = Math.round(topTask.pct)
    if (pct < DISTRACTION_PCT) return

    // Channel L: priority avoidance — distinguishes this from hidden_priority
    // (time_trap = you KNOW this isn't your priority but you keep avoiding the real one)
    const lProfile = db.prepare(`
      SELECT priority_avoidance_count FROM channel_l_profiles WHERE user_id = ?
    `).get(userId) as any
    if (!lProfile || (lProfile.priority_avoidance_count ?? 0) < MIN_PRIORITY_AVOID) return

    // user_profile: stated goals
    const goalsRow = db.prepare(`
      SELECT value FROM user_profile WHERE user_id = ? AND key = 'current_goals'
    `).get(userId) as any
    const goals = (goalsRow?.value || '').toLowerCase()
    if (!goals) return

    // The trap only fires when the dominant category is NOT the stated goal
    const goalWords = goals.split(/[\s,;]+/).filter((w: string) => w.length > 3)
    const catWords = topTask.task_category.toLowerCase().split(/[\s_]+/).filter((w: string) => w.length > 3)
    const catInGoals = catWords.some((w: string) => goalWords.some((g: string) => g.includes(w) || w.includes(g)))
    if (catInGoals) return

    const priorityAvoid = lProfile.priority_avoidance_count

    const insightText = `${pct}% of your work over the last 60 days has gone to "${topTask.task_category}" — which isn't in your stated goals — and your avoidance signals suggest this gap is consistent, not situational.`
    const questionText = `Is something making it hard to get back to your stated priorities right now?`

    const evidence = {
      channels: ['channel_g', 'channel_l', 'user_profile'],
      top_category: topTask.task_category,
      top_category_pct: pct,
      task_count: topTask.c,
      priority_avoidance_count: priorityAvoid,
      stated_goals: goals.slice(0, 80),
      observations: [
        `${pct}% of tasks (last 60 days): "${topTask.task_category}" (${topTask.c} tasks)`,
        `Priority avoidance signals: ${priorityAvoid}`,
        `Stated goals: "${goals.slice(0, 70)}"`,
      ]
    }

    enqueueInsight(
      userId, 'time_trap', insightText, questionText, evidence,
      7.5, 0.70, 4.0, 'compound'
    )
  } catch {}
}
