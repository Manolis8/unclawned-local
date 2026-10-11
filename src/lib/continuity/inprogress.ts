import { db, uuid } from '../db.js'

export interface InProgressTask {
  id: string
  user_id: string
  task_description: string
  progress_summary: string | null
  next_steps: string | null
  last_session_at: string
  deadline: string | null
  status: string
  created_at: string
}

const RECENT_DAYS = 5

export function saveInProgress(
  userId: string,
  taskDescription: string,
  progressSummary: string | null = null,
  nextSteps: string | null = null,
  deadline: string | null = null
): string {
  const desc = taskDescription.slice(0, 300)
  try {
    // Deduplicate: if an active task with this description already exists, touch it instead of inserting a new row
    const existing = db.prepare(`
      SELECT id FROM inprogress_tasks WHERE user_id = ? AND task_description = ? AND status = 'active' LIMIT 1
    `).get(userId, desc) as any
    if (existing) {
      db.prepare(`UPDATE inprogress_tasks SET last_session_at = datetime('now') WHERE id = ?`).run(existing.id)
      return existing.id
    }
    const id = uuid()
    db.prepare(`
      INSERT INTO inprogress_tasks (id, user_id, task_description, progress_summary, next_steps, deadline)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, desc, progressSummary?.slice(0, 500) ?? null, nextSteps?.slice(0, 300) ?? null, deadline)
    return id
  } catch { return uuid() }
}

// Update the last_session_at when the user continues working on an in-progress task
export function touchInProgress(id: string): void {
  try {
    db.prepare(`UPDATE inprogress_tasks SET last_session_at = datetime('now') WHERE id = ?`).run(id)
  } catch {}
}

export function resolveInProgress(id: string): void {
  try {
    const task = db.prepare(`SELECT user_id, task_description FROM inprogress_tasks WHERE id = ?`).get(id) as any
    if (task) {
      db.prepare(`UPDATE inprogress_tasks SET status = 'completed' WHERE user_id = ? AND task_description = ? AND status = 'active'`).run(task.user_id, task.task_description)
    } else {
      db.prepare(`UPDATE inprogress_tasks SET status = 'completed' WHERE id = ?`).run(id)
    }
  } catch {}
}

export function abandonInProgress(id: string): void {
  try {
    // Abandon all active rows with the same description — clears stacked duplicates in one shot
    const task = db.prepare(`SELECT user_id, task_description FROM inprogress_tasks WHERE id = ?`).get(id) as any
    if (task) {
      db.prepare(`UPDATE inprogress_tasks SET status = 'abandoned' WHERE user_id = ? AND task_description = ? AND status = 'active'`).run(task.user_id, task.task_description)
    } else {
      db.prepare(`UPDATE inprogress_tasks SET status = 'abandoned' WHERE id = ?`).run(id)
    }
  } catch {}
}

export function markPrompted(id: string): void {
  try {
    // Mark all active rows with the same description — handles stacked duplicates from before dedup was added
    const task = db.prepare(`SELECT user_id, task_description FROM inprogress_tasks WHERE id = ?`).get(id) as any
    if (task) {
      db.prepare(`
        UPDATE inprogress_tasks SET last_prompted_at = datetime('now')
        WHERE user_id = ? AND task_description = ? AND status = 'active'
      `).run(task.user_id, task.task_description)
    } else {
      db.prepare(`UPDATE inprogress_tasks SET last_prompted_at = datetime('now') WHERE id = ?`).run(id)
    }
  } catch {}
}

// Returns active in-progress tasks worked on within the last RECENT_DAYS
// and not already prompted in the last 20 hours (prevents same-day repetition)
export function getRecentInProgress(userId: string): InProgressTask[] {
  try {
    return db.prepare(`
      SELECT * FROM inprogress_tasks
      WHERE user_id = ? AND status = 'active'
        AND julianday('now') - julianday(last_session_at) <= ?
        AND (last_prompted_at IS NULL OR julianday('now') - julianday(last_prompted_at) >= 0.83)
      ORDER BY last_session_at DESC
      LIMIT 3
    `).all(userId, RECENT_DAYS) as InProgressTask[]
  } catch { return [] }
}

export function getAllActiveInProgress(userId: string): InProgressTask[] {
  try {
    return db.prepare(`
      SELECT * FROM inprogress_tasks
      WHERE user_id = ? AND status = 'active'
      ORDER BY last_session_at DESC
    `).all(userId) as InProgressTask[]
  } catch { return [] }
}

// Auto-detect continuation intent in task summary text
export function detectsContinuationIntent(text: string): boolean {
  return /\b(continue|next session|to be continued|remaining|part [2-9]|step [2-9]|tomorrow|following up|will need to|not finished|incomplete|resume|pick up)\b/i.test(text)
}
