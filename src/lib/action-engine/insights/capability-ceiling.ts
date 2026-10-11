import { db } from '../../db.js'
import { enqueueInsight } from '../queue.js'

const MIN_REACTIONS = 5
const MIN_HIGH_CORRECTION_TYPES = 2

export function detectCapabilityCeiling(userId: string): void {
  try {
    // Channel B: correction profile — the agent's self-awareness signal
    const bProfile = db.prepare(`
      SELECT correction_profile, total_reactions FROM channel_b_profiles WHERE user_id = ?
    `).get(userId) as any
    if (!bProfile || (bProfile.total_reactions ?? 0) < MIN_REACTIONS) return

    let corrProfile: any = {}
    try { corrProfile = JSON.parse(bProfile.correction_profile || '{}') } catch {}

    const highCorrTypes: string[] = corrProfile.high_correction_types ?? []
    if (highCorrTypes.length < MIN_HIGH_CORRECTION_TYPES) return

    // Channel G: task categories with frustration signals — confirm the pattern is cross-task
    const frustratedCats = db.prepare(`
      SELECT task_category, COUNT(*) as c, SUM(has_frustration) as frust_count
      FROM channel_g_task_snapshots
      WHERE user_id = ? AND datetime(created_at) > datetime('now', '-30 days')
      GROUP BY task_category
      HAVING frust_count > 0
      ORDER BY frust_count DESC
      LIMIT 3
    `).all(userId) as any[]

    const affectedCategories = frustratedCats.length > 0
      ? frustratedCats.map((r: any) => r.task_category)
      : ['multiple task types']

    const correctionPattern = highCorrTypes.slice(0, 2).join(' and ')
    const categoriesMentioned = affectedCategories.slice(0, 2).join(' and ')

    const insightText = `I've noticed a consistent pattern in my mistakes around "${correctionPattern}" across ${categoriesMentioned} tasks — this might be a gap in my understanding of your work rather than individual errors.`
    const questionText = `Want to spend a few minutes helping me calibrate better in these areas?`

    const evidence = {
      channels: ['channel_b', 'channel_g'],
      high_correction_types: highCorrTypes,
      total_reactions: bProfile.total_reactions,
      affected_categories: affectedCategories,
      observations: [
        `High correction rate in: "${highCorrTypes.slice(0, 3).join('", "')}"`,
        `Pattern spans: ${categoriesMentioned}`,
        `Based on ${bProfile.total_reactions} total tracked reactions`,
      ]
    }

    // Low friction — asking the user for calibration is easy to respond to
    enqueueInsight(
      userId, 'capability_ceiling', insightText, questionText, evidence,
      7.5, 0.75, 2.0, 'compound'
    )
  } catch {}
}
