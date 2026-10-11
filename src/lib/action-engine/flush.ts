import { db } from '../db.js'
import { scoreAction } from './scorer.js'
import { classifySessionWindow } from './scorer.js'

// After a long absence (>10 days), re-score everything and archive items that are now stale.
// Returns count of items archived.
export function runAbsenceFlush(userId: string): number {
  try {
    const lastSession = db.prepare(`
      SELECT created_at FROM agent_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(userId) as any

    if (!lastSession) return 0

    const daysSince = (Date.now() - new Date(lastSession.created_at).getTime()) / 86400000
    if (daysSince < 10) return 0

    // Re-score all queued items with current window and recency
    const window = classifySessionWindow(userId)
    const queued = db.prepare(`SELECT * FROM action_queue WHERE user_id = ? AND status = 'queued'`).all(userId) as any[]

    let archived = 0
    for (const action of queued) {
      const score = scoreAction(action, userId, window)
      db.prepare(`UPDATE action_queue SET priority_score = ? WHERE id = ?`).run(score, action.id)

      // Archive items that scored below Tier 3 threshold — they've gone stale during the absence
      if (score < 2.0) {
        db.prepare(`UPDATE action_queue SET status = 'archived' WHERE id = ?`).run(action.id)
        archived++
      }
    }

    return archived
  } catch { return 0 }
}

// Returns days since last session (or null if no sessions)
export function daysSinceLastSession(userId: string): number | null {
  try {
    const row = db.prepare(`
      SELECT created_at FROM agent_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(userId) as any
    if (!row) return null
    return Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86400000)
  } catch { return null }
}
