import { db } from '../../db.js'
import { enqueueInsight } from '../queue.js'

export function detectFocusDrift(userId: string): void {
  try {
    const profile = db.prepare(`
      SELECT drift_direction, last_updated FROM channel_m_profiles WHERE user_id = ?
    `).get(userId) as any
    if (!profile?.drift_direction) return

    // Only fire if data is recent
    const daysOld = Math.floor((Date.now() - new Date(profile.last_updated).getTime()) / 86400000)
    if (daysOld > 30) return

    const drift = profile.drift_direction.toLowerCase()

    // Check if drift overlaps with stated goals — if so, it's aligned, don't surface
    const goalsRow = db.prepare(`SELECT value FROM user_profile WHERE user_id = ? AND key = 'current_goals'`).get(userId) as any
    const goals = (goalsRow?.value || '').toLowerCase()
    if (goals) {
      const goalWords = goals.split(/[\s,;]+/).filter((w: string) => w.length > 4)
      const driftWords = drift.split(/[\s,;]+/).filter((w: string) => w.length > 4)
      const overlap = driftWords.filter(w => goalWords.some((g: string) => g.includes(w) || w.includes(g))).length
      if (overlap > 0) return
    }

    enqueueInsight(
      userId,
      'focus_drift',
      `Your recent work has been drifting toward "${profile.drift_direction}".`,
      'Is that where you want to be spending time right now?',
      { drift_direction: profile.drift_direction },
      6.0, 0.65, 3.0
    )
  } catch {}
}
