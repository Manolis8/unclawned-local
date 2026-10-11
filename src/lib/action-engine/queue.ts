import { db, uuid } from '../db.js'

export interface QueuedAction {
  id: string
  user_id: string
  action_category: string
  insight_text: string
  question_text: string | null
  evidence: string | null
  insight_format: string  // 'observation' | 'pattern' | 'compound'
  value_score: number
  confidence: number
  friction: number
  priority_score: number | null
  status: string
  sessions_in_queue: number
  last_scored_at: string | null
  dismissal_count: number
  dismiss_lock_until: string | null
  created_at: string
}

// Cooldown windows: how long to block re-queuing after a user response
const REQUEUE_COOLDOWN_DAYS: Record<string, number> = {
  acted: 180,      // user said yes — don't revisit for 6 months
  dismissed: 365,  // user said no — don't revisit for a year
  engaged: 90,     // user engaged with it — give them 3 months
  deferred: 7,     // user said "later" — check back in a week
  ignored: 90,     // user skipped — don't ask again for 3 months
  surfaced: 2,     // shown but no response recorded — retry after 2 days
}

// Deduplicated — if same category already queued, OR user recently responded, skip
export function enqueueInsight(
  userId: string,
  category: string,
  insightText: string,
  questionText: string | null = null,
  evidence: Record<string, unknown> | null = null,
  valueScore = 5.0,
  confidence = 0.6,
  friction = 3.0,
  format: 'observation' | 'pattern' | 'compound' = 'observation'
): void {
  try {
    // Already queued — do nothing
    const existing = db.prepare(`
      SELECT id FROM action_queue
      WHERE user_id = ? AND action_category = ? AND status = 'queued'
    `).get(userId, category)
    if (existing) return

    // Check if user recently acted on / dismissed this category — suppress re-queue
    const lastResponse = db.prepare(`
      SELECT user_response, surfaced_at FROM action_memory
      WHERE user_id = ? AND action_category = ?
      ORDER BY surfaced_at DESC LIMIT 1
    `).get(userId, category) as any
    if (lastResponse) {
      const cooldownDays = REQUEUE_COOLDOWN_DAYS[lastResponse.user_response]
      if (cooldownDays) {
        const daysSince = (Date.now() - new Date(lastResponse.surfaced_at + 'Z').getTime()) / 86400000
        if (daysSince < cooldownDays) return
      }
    }

    db.prepare(`
      INSERT INTO action_queue (id, user_id, action_category, insight_text, question_text, evidence, value_score, confidence, friction, insight_format)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), userId, category, insightText, questionText, evidence ? JSON.stringify(evidence) : null, valueScore, confidence, friction, format)
  } catch {}
}

export function getQueuedActions(userId: string): QueuedAction[] {
  try {
    return db.prepare(`
      SELECT * FROM action_queue
      WHERE user_id = ? AND status = 'queued'
        AND (dismiss_lock_until IS NULL OR datetime('now') > dismiss_lock_until)
      ORDER BY COALESCE(priority_score, -1) DESC, created_at ASC
    `).all(userId) as QueuedAction[]
  } catch { return [] }
}

export function markSurfaced(id: string, priorityScore: number): void {
  try {
    const row = db.prepare('SELECT user_id, action_category FROM action_queue WHERE id = ?').get(id) as any
    db.prepare(`
      UPDATE action_queue SET status = 'surfaced', priority_score = ?, last_scored_at = datetime('now')
      WHERE id = ?
    `).run(priorityScore, id)
    // Also write to action_memory so isSessionCooledDown() sees this surfacing immediately.
    // Without this, the cooldown check only fires after the user responds — so the same
    // category can surface multiple times in one session if the user ignores each prompt.
    if (row) {
      db.prepare(`
        INSERT INTO action_memory (id, user_id, queue_id, action_category, surfaced_at, user_response, session_window, priority_score)
        VALUES (?, ?, ?, ?, datetime('now'), 'surfaced', 'normal', ?)
      `).run(uuid(), row.user_id, id, row.action_category, priorityScore)
    }
  } catch {}
}

export function markActed(id: string): void {
  try {
    db.prepare(`UPDATE action_queue SET status = 'acted' WHERE id = ?`).run(id)
  } catch {}
}

export function markDismissed(id: string): void {
  try {
    db.prepare(`
      UPDATE action_queue
      SET status = 'dismissed', dismissal_count = dismissal_count + 1,
          dismiss_lock_until = datetime('now', '+60 days')
      WHERE id = ?
    `).run(id)
  } catch {}
}

export function markDeferred(id: string): void {
  try {
    db.prepare(`
      UPDATE action_queue SET sessions_in_queue = sessions_in_queue + 1 WHERE id = ?
    `).run(id)
  } catch {}
}

// User explicitly said "later" — put back in queue with a small value boost
export function requeueDeferred(id: string): void {
  try {
    db.prepare(`
      UPDATE action_queue
      SET status = 'queued',
          sessions_in_queue = sessions_in_queue + 1,
          value_score = MIN(9.0, value_score + 0.3)
      WHERE id = ?
    `).run(id)
  } catch {}
}
