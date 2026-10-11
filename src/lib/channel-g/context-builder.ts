import { db, p } from '../db.js'
import { getDominantCategoryForHour, getUpcomingSeasonalPattern } from './rhythm-tracker.js'

const CATEGORY_LABELS: Record<string, string> = {
  deep_work: 'deep research and complex writing',
  communication: 'emails and outreach',
  decision: 'reviewing and evaluating',
  admin: 'admin and quick tasks',
  creative: 'creative and brainstorming work',
  execution: 'browser tasks and automation',
}

const SEASONAL_LABELS: Record<string, string> = {
  month_end: 'end of the month',
  quarter_end: 'end of the quarter',
  month_start: 'start of the month',
}

export function buildChannelGContextBlock(userId: string): string | null {
  try {
    const profile = db.prepare(`SELECT * FROM channel_g_profiles WHERE user_id = ?`).get(userId) as any
    if (!profile || profile.total_tasks_observed < 5) return null

    const lines: string[] = ['## Temporal Patterns']
    let hasSomething = false

    // G.1 — cognitive rhythm: what kind of work the user typically does at this hour
    const currentHour = new Date().getHours()
    const dominantCategory = getDominantCategoryForHour(userId, currentHour)
    if (dominantCategory) {
      const label = CATEGORY_LABELS[dominantCategory] ?? dominantCategory
      lines.push(`**Your typical work at this hour:** ${label}`)
      hasSomething = true
    }

    // G.2 — seasonal pattern approaching
    const seasonal = getUpcomingSeasonalPattern(userId)
    if (seasonal) {
      const seasonLabel = SEASONAL_LABELS[seasonal.type] ?? seasonal.type
      const catLabel = CATEGORY_LABELS[seasonal.dominantCategory] ?? seasonal.dominantCategory
      lines.push(`**Approaching ${seasonLabel}:** You typically have a spike in ${catLabel}`)
      hasSomething = true
    }

    // G.3 — active stress cycle
    const stressStreak: number = profile.current_stress_streak ?? 0
    if (stressStreak >= 3) {
      lines.push(`**High-pressure streak:** Urgency signals detected for ${stressStreak}+ consecutive days — keeping responses tight and decisive`)
      hasSomething = true
    }

    // G.4 — recovery pattern: just came out of a stress cycle
    const activeCycle = db.prepare(
      `SELECT cycle_end, peak_streak FROM channel_g_stress_cycles WHERE user_id = ? AND status = 'resolved' ORDER BY cycle_end DESC LIMIT 1`
    ).get(userId) as any
    if (activeCycle?.cycle_end) {
      const daysSinceRecovery = (Date.now() - new Date(activeCycle.cycle_end).getTime()) / (1000 * 60 * 60 * 24)
      if (daysSinceRecovery <= 3) {
        const recovery: { cycles: Array<{ firstCategory: string }> } = p(profile.recovery_pattern) ?? { cycles: [] }
        const lastRecovery = recovery.cycles[recovery.cycles.length - 1]
        const hint = lastRecovery
          ? ` — last time you came back with ${CATEGORY_LABELS[lastRecovery.firstCategory] ?? lastRecovery.firstCategory}`
          : ''
        lines.push(`**Just out of a high-pressure period:** Easing back in${hint}`)
        hasSomething = true
      }
    }

    if (!hasSomething) return null
    lines.push(`_(${profile.total_tasks_observed} tasks observed)_`)
    return lines.join('\n')
  } catch {
    return null
  }
}
