import { db } from '../../db.js'
import { enqueueInsight } from '../queue.js'

const MIN_AVOIDANCE_SIGNALS = 2

export function detectBlockingPattern(userId: string): void {
  try {
    const lProfile = db.prepare(`
      SELECT dominant_resistance, blind_spot_domains,
             capability_avoidance_count, skill_avoidance_count, priority_avoidance_count
      FROM channel_l_profiles WHERE user_id = ?
    `).get(userId) as any
    if (!lProfile) return

    const avoidCount = (lProfile.capability_avoidance_count ?? 0)
                     + (lProfile.skill_avoidance_count ?? 0)
    if (avoidCount < MIN_AVOIDANCE_SIGNALS && !lProfile.dominant_resistance) return

    let blindSpots: string[] = []
    try { blindSpots = JSON.parse(lProfile.blind_spot_domains || '[]') } catch {}

    const goalsRow = db.prepare(`
      SELECT value FROM user_profile WHERE user_id = ? AND key = 'current_goals'
    `).get(userId) as any
    const goals = (goalsRow?.value || '').toLowerCase()
    if (!goals) return

    // Find an avoidance area that overlaps with stated goals — that's the blocker
    const goalWords = goals.split(/[\s,;]+/).filter((w: string) => w.length > 3)

    let blockedArea: string | null = null
    for (const spot of blindSpots) {
      const spotWords = spot.toLowerCase().split(/[\s,_-]+/).filter((w: string) => w.length > 3)
      if (spotWords.some((w: string) => goalWords.some((g: string) => g.includes(w) || w.includes(g)))) {
        blockedArea = spot
        break
      }
    }
    if (!blockedArea && lProfile.dominant_resistance) {
      const resWords = lProfile.dominant_resistance.toLowerCase().split(/[\s,_-]+/).filter((w: string) => w.length > 3)
      if (resWords.some((w: string) => goalWords.some((g: string) => g.includes(w) || w.includes(g)))) {
        blockedArea = lProfile.dominant_resistance
      }
    }
    if (!blockedArea) return

    // Channel G: time allocation to show where effort actually goes
    const topTask = db.prepare(`
      SELECT task_category, COUNT(*) as c,
             ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 0) as pct
      FROM channel_g_task_snapshots
      WHERE user_id = ? AND datetime(created_at) > datetime('now', '-30 days')
      GROUP BY task_category ORDER BY c DESC LIMIT 1
    `).get(userId) as any

    const topCategory = topTask?.task_category || 'other areas'
    const topPct = topTask?.pct ? `${Math.round(topTask.pct)}%` : 'most'

    const insightText = `Consistent avoidance around "${blockedArea}" may be creating a bottleneck — it appears in your stated goals but shows low engagement while ${topPct} of effort goes to "${topCategory}".`
    const questionText = `Is there something making "${blockedArea}" harder to engage with right now?`

    const evidence = {
      channels: ['channel_l', 'channel_g', 'user_profile'],
      blocked_area: blockedArea,
      avoidance_signals: avoidCount,
      dominant_resistance: lProfile.dominant_resistance,
      top_task_category: topCategory,
      observations: [
        `Avoidance signals: ${avoidCount} (capability + skill areas)`,
        `Identified block: "${blockedArea}" — also present in your stated goals`,
        `Time allocation: ${topPct} of recent effort on "${topCategory}"`,
      ]
    }

    enqueueInsight(
      userId, 'blocking_pattern', insightText, questionText, evidence,
      7.0, 0.65, 3.5, 'compound'
    )
  } catch {}
}
