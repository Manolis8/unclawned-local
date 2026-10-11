import { db, uuid } from '../db.js'

export interface Commitment {
  id: string
  user_id: string
  commitment_type: string   // time_based | event_based | condition_based
  description: string
  trigger_type: string      // after_N_days | on_condition | on_event
  trigger_value: string | null
  context: string | null
  created_at: string
  due_at: string | null
  status: string            // pending | fired | cancelled | expired
  fired_at: string | null
}

// Expire commitments that have been pending more than 30 days without firing
const EXPIRY_DAYS = 30

export function createCommitment(
  userId: string,
  type: 'time_based' | 'event_based' | 'condition_based',
  description: string,
  triggerType: 'after_N_days' | 'on_condition' | 'on_event',
  triggerValue: string | null,
  context: string | null = null
): string {
  const id = uuid()
  let dueAt: string | null = null

  if (triggerType === 'after_N_days' && triggerValue) {
    const days = parseInt(triggerValue)
    if (!isNaN(days) && days > 0) {
      dueAt = new Date(Date.now() + days * 86400000)
        .toISOString().replace('T', ' ').slice(0, 19)
    }
  }

  try {
    db.prepare(`
      INSERT INTO commitments (id, user_id, commitment_type, description, trigger_type, trigger_value, context, due_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, type, description, triggerType, triggerValue, context, dueAt)
  } catch {}

  return id
}

// Returns commitments whose trigger has now fired
export function checkDueCommitments(userId: string): Commitment[] {
  try {
    const fired: Commitment[] = []

    // Time-based: due_at has passed
    const timeDue = db.prepare(`
      SELECT * FROM commitments
      WHERE user_id = ? AND status = 'pending' AND trigger_type = 'after_N_days'
        AND due_at IS NOT NULL AND datetime('now') >= due_at
      ORDER BY due_at ASC LIMIT 5
    `).all(userId) as Commitment[]
    fired.push(...timeDue)

    // Condition-based: check live_state against trigger_value
    const condPending = db.prepare(`
      SELECT * FROM commitments
      WHERE user_id = ? AND status = 'pending' AND trigger_type = 'on_condition'
      ORDER BY created_at ASC LIMIT 10
    `).all(userId) as Commitment[]

    if (condPending.length > 0) {
      const liveState = db.prepare(`SELECT current_focus_topic, session_intent FROM live_state WHERE user_id = ?`).get(userId) as any
      const focusTopic = (liveState?.current_focus_topic || '').toLowerCase()
      const sessionIntent = (liveState?.session_intent || '').toLowerCase()

      for (const c of condPending) {
        const val = (c.trigger_value || '').toLowerCase()
        if (val && (focusTopic.includes(val) || sessionIntent.includes(val))) {
          fired.push(c)
        }
      }
    }

    return fired
  } catch { return [] }
}

export function markCommitmentFired(id: string): void {
  try {
    db.prepare(`
      UPDATE commitments SET status = 'fired', fired_at = datetime('now') WHERE id = ?
    `).run(id)
  } catch {}
}

export function cancelCommitment(id: string): void {
  try {
    db.prepare(`UPDATE commitments SET status = 'cancelled' WHERE id = ?`).run(id)
  } catch {}
}

export function listCommitments(userId: string): Commitment[] {
  try {
    return db.prepare(`
      SELECT * FROM commitments WHERE user_id = ? AND status = 'pending'
      ORDER BY COALESCE(due_at, created_at) ASC
    `).all(userId) as Commitment[]
  } catch { return [] }
}

// Marks old pending commitments as expired; returns ones that should surface as "never fired" notice
export function expireStaleCommitments(userId: string): Commitment[] {
  try {
    const stale = db.prepare(`
      SELECT * FROM commitments
      WHERE user_id = ? AND status = 'pending'
        AND julianday('now') - julianday(created_at) > ?
    `).all(userId, EXPIRY_DAYS) as Commitment[]

    if (stale.length) {
      const ids = stale.map(c => c.id)
      const placeholders = ids.map(() => '?').join(',')
      db.prepare(`UPDATE commitments SET status = 'expired' WHERE id IN (${placeholders})`).run(...ids)
    }

    return stale
  } catch { return [] }
}

// Natural-language parser: "in 3 days", "in 2 weeks", "when fundraising", "when [X]"
export function parseCommitmentInput(input: string): {
  type: 'time_based' | 'condition_based'
  triggerType: 'after_N_days' | 'on_condition'
  triggerValue: string
} | null {
  const lower = input.toLowerCase()

  // "in N days" / "in N weeks"
  const daysMatch = lower.match(/\bin\s+(\d+)\s+(day|days)\b/)
  if (daysMatch) {
    return { type: 'time_based', triggerType: 'after_N_days', triggerValue: daysMatch[1] }
  }
  const weeksMatch = lower.match(/\bin\s+(\d+)\s+(week|weeks)\b/)
  if (weeksMatch) {
    const days = parseInt(weeksMatch[1]) * 7
    return { type: 'time_based', triggerType: 'after_N_days', triggerValue: String(days) }
  }
  const tomorrowMatch = lower.match(/\btomorrow\b/)
  if (tomorrowMatch) {
    return { type: 'time_based', triggerType: 'after_N_days', triggerValue: '1' }
  }
  const nextWeekMatch = lower.match(/\bnext week\b/)
  if (nextWeekMatch) {
    return { type: 'time_based', triggerType: 'after_N_days', triggerValue: '7' }
  }

  // "when [X]" / "next time [X]"
  const whenMatch = lower.match(/\b(?:when|next time(?:\s+i(?:'m|\s+am)?)?)\s+(.+)/)
  if (whenMatch) {
    const condition = whenMatch[1].replace(/^(?:i(?:'m|'m| am)?\s+)?(?:working on|doing|on)\s+/i, '').trim()
    if (condition.length > 1) {
      return { type: 'condition_based', triggerType: 'on_condition', triggerValue: condition }
    }
  }

  return null
}
