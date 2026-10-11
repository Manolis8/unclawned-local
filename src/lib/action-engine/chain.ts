import { db } from '../db.js'
import { enqueueInsight } from './queue.js'
import { suppressCategory } from './surface.js'

// Defines what follows each insight type when the user responds positively
const CHAIN_NEXT: Record<string, {
  category: string
  text: string
  question: string
  value: number
  friction: number
}> = {
  relationship_cooling: {
    category: 'chain_relationship_touchpoints',
    text: 'You engaged with the relationship cooling pattern. I can prepare touchpoint drafts for cooling contacts automatically going forward.',
    question: 'Want me to start preparing those for your review? (authorize relationship_touchpoints)',
    value: 6.5, friction: 2.0,
  },
  relationship_opportunity: {
    category: 'chain_relationship_touchpoints',
    text: 'You found the relationship opportunity useful. I can track warming contacts and draft outreach automatically.',
    question: 'Want me to prepare these drafts when I spot them? (y/n)',
    value: 6.0, friction: 2.0,
  },
  focus_drift: {
    category: 'chain_session_prep',
    text: 'You acknowledged the focus drift. A session brief can include a weekly goal alignment check to catch this earlier.',
    question: 'Want me to add goal alignment to session prep? (y/n)',
    value: 6.0, friction: 2.0,
  },
  timing_observation: {
    category: 'chain_timing_tracking',
    text: 'You noted the timing pattern. I can include session timing signals in the daily brief going forward.',
    question: 'Want me to track this in session prep? (y/n)',
    value: 5.5, friction: 1.5,
  },
  hidden_priority: {
    category: 'chain_goal_alignment',
    text: 'You acknowledged the hidden priority. I can surface a goal alignment check weekly so this doesn\'t build up silently.',
    question: 'Want me to include this in session prep? (y/n)',
    value: 6.0, friction: 2.0,
  },
  time_trap: {
    category: 'chain_time_trap_followup',
    text: 'You acknowledged the time trap pattern. I can flag this again if it persists over the next two weeks.',
    question: 'Want me to check in on this next week? (y/n)',
    value: 5.5, friction: 1.5,
  },
  blocking_pattern: {
    category: 'chain_blocking_followup',
    text: 'You noted the blocking pattern. I can track whether time allocation shifts after this.',
    question: 'Want me to revisit this in a week? (y/n)',
    value: 5.5, friction: 1.5,
  },
  capability_ceiling: {
    category: 'chain_calibration',
    text: 'You agreed to help me calibrate. I can build a short calibration brief for next session — a few targeted questions in the areas where I consistently fall short.',
    question: 'Want me to prepare that for next session? (y/n)',
    value: 7.0, friction: 2.0,
  },
}

// Called after an insight is acted on. Creates the chain followup for next session.
export function maybeQueueChainFollowup(userId: string, insightCategory: string): void {
  try {
    const next = CHAIN_NEXT[insightCategory]
    if (!next) return

    // Don't create if chain is blocked (dismissed previously)
    if (isChainBlocked(userId, next.category)) return

    // Don't create if already queued or recently fired
    const existing = db.prepare(`
      SELECT id FROM action_queue WHERE user_id = ? AND action_category = ? AND status = 'queued'
    `).get(userId, next.category)
    if (existing) return

    enqueueInsight(
      userId, next.category, next.text, next.question,
      { chain_origin: insightCategory, chain_step: 'suggestion' },
      next.value, 0.80, next.friction, 'observation'
    )
  } catch {}
}

// Called when a chain followup is dismissed — blocks this chain path for 90 days
export function recordChainBreak(userId: string, category: string): void {
  try {
    const expiry = new Date(Date.now() + 90 * 86400000)
      .toISOString().replace('T', ' ').slice(0, 19)
    suppressCategory(userId, category, expiry, 'chain_break:dismissed')
  } catch {}
}

function isChainBlocked(userId: string, category: string): boolean {
  try {
    const row = db.prepare(`
      SELECT id FROM action_suppression
      WHERE user_id = ? AND category = ?
        AND reason LIKE 'chain_break%'
        AND (expires_at IS NULL OR datetime('now') < expires_at)
    `).get(userId, category) as any
    return !!row
  } catch { return false }
}

// Returns the chain step description for display in /actions show
export function getChainLabel(category: string): string | null {
  if (!category.startsWith('chain_')) return null
  const key = category.slice(6)  // strip 'chain_'
  const labels: Record<string, string> = {
    relationship_touchpoints: 'Relationship maintenance automation (from relationship insight)',
    session_prep: 'Session prep expansion (from focus drift)',
    timing_tracking: 'Timing pattern tracking (from timing observation)',
    goal_alignment: 'Weekly goal alignment check (from hidden priority)',
    time_trap_followup: 'Time allocation follow-up (from time trap)',
    blocking_followup: 'Blocking pattern follow-up',
    calibration: 'Targeted calibration brief (from capability ceiling)',
  }
  return labels[key] ?? category
}
