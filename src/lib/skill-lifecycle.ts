import { db } from './db.js'

const ARCHIVE_AFTER_DAYS = 90

// Fired lazily from GET /skills — archives skills that haven't been run in ARCHIVE_AFTER_DAYS days.
// Only affects skills that have been run at least once (run_count > 0) and are not pinned.
// The 60-day "dormant" warning is computed from last_run_at on the frontend — no status change needed.
export function checkSkillLifecycle(userId: string): void {
  try {
    const affected = db.prepare(`
      UPDATE skills
      SET status = 'archived'
      WHERE user_id = ?
        AND (status IS NULL OR status != 'archived')
        AND pinned = 0
        AND run_count > 0
        AND last_run_at IS NOT NULL
        AND last_run_at < datetime('now', ? || ' days')
    `).run(userId, `-${ARCHIVE_AFTER_DAYS}`)

    if (affected.changes > 0) {
      console.log(`[skill-lifecycle] Archived ${affected.changes} skill(s) unused for ${ARCHIVE_AFTER_DAYS}+ days (user: ${userId})`)
    }
  } catch (err) {
    console.warn('[skill-lifecycle] Lifecycle check failed (non-fatal):', (err as Error).message)
  }
}
