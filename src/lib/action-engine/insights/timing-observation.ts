import { db } from '../../db.js'
import { enqueueInsight } from '../queue.js'

const LATE_NIGHT_MIN = 5    // minimum late-night sessions to fire
const LATE_NIGHT_PCT = 20   // minimum % of recent tasks that are late-night

export function detectTimingPattern(userId: string): void {
  try {
    const lateNight = db.prepare(`
      SELECT COUNT(*) as c FROM channel_g_task_snapshots
      WHERE user_id = ? AND is_late_night = 1
        AND datetime(created_at) > datetime('now', '-30 days')
    `).get(userId) as any

    const count = lateNight?.c ?? 0
    if (count < LATE_NIGHT_MIN) return

    const total = (db.prepare(`
      SELECT COUNT(*) as c FROM channel_g_task_snapshots
      WHERE user_id = ? AND datetime(created_at) > datetime('now', '-30 days')
    `).get(userId) as any)?.c ?? 1

    const pct = Math.round((count / total) * 100)
    if (pct < LATE_NIGHT_PCT) return

    // Find their best non-late-night hour
    const peakHour = db.prepare(`
      SELECT hour_of_day, COUNT(*) as c FROM channel_g_task_snapshots
      WHERE user_id = ? AND is_late_night = 0
        AND datetime(created_at) > datetime('now', '-60 days')
      GROUP BY hour_of_day ORDER BY c DESC LIMIT 1
    `).get(userId) as any

    let insightText: string
    let questionText: string

    if (peakHour?.hour_of_day != null) {
      const h = peakHour.hour_of_day
      const label = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`
      insightText = `${pct}% of your recent work is late-night, but your most active hour looks like ${label}.`
      questionText = 'Worth shifting some tasks to that window?'
    } else {
      insightText = `${count} of your recent sessions have been late-night (${pct}% of the last 30 days).`
      questionText = 'Are those sessions feeling productive?'
    }

    enqueueInsight(
      userId,
      'timing_observation',
      insightText,
      questionText,
      { late_night_count: count, late_night_pct: pct, peak_hour: peakHour?.hour_of_day ?? null },
      5.5, 0.7, 3.0
    )
  } catch {}
}
