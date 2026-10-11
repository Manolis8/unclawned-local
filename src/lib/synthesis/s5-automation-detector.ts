import { db } from '../db.js'

export interface AutomationOpportunity {
  taskCategory: string
  occurrenceCount: number
  correctionRate: number
  hasUrgency: boolean
}

export function findAutomationOpportunity(userId: string): AutomationOpportunity | null {
  // Find task categories with 3+ occurrences in last 30 days (excluding noise categories)
  let taskCounts: any[] = []
  try {
    taskCounts = db.prepare(`
      SELECT task_category,
             COUNT(*) as cnt,
             SUM(has_urgency) as urgency_cnt
      FROM channel_g_task_snapshots
      WHERE user_id = ?
        AND created_at >= datetime('now', '-30 days')
        AND task_category NOT IN ('admin', 'unknown')
      GROUP BY task_category
      HAVING cnt >= 3
      ORDER BY cnt DESC
    `).all(userId) as any[]
  } catch { return null }

  for (const task of taskCounts) {
    // Check Channel B correction rate for this task type
    let correctionRate = 0
    let hasSufficientBData = false
    try {
      const bRow = db.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN is_correction = 1 THEN 1 ELSE 0 END) as corrections
        FROM channel_b_raw_signals
        WHERE user_id = ?
          AND prior_task_type = ?
          AND created_at >= datetime('now', '-30 days')
      `).get(userId, task.task_category) as any
      if (bRow && (bRow.total ?? 0) >= 3) {
        correctionRate = (bRow.corrections ?? 0) / bRow.total
        hasSufficientBData = true
      }
    } catch {}

    // If no Channel B data, assume low correction (benefit of the doubt)
    // If Channel B data shows high correction rate, skip this category
    if (hasSufficientBData && correctionRate > 0.35) continue

    return {
      taskCategory: task.task_category,
      occurrenceCount: task.cnt,
      correctionRate: Math.round(correctionRate * 100),
      hasUrgency: (task.urgency_cnt ?? 0) >= 2,
    }
  }

  return null
}
