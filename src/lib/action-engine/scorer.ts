import { db } from '../db.js'
import type { QueuedAction } from './queue.js'

export type SessionWindow = 'sprint' | 'discovery' | 'review' | 'repair' | 'low_energy'

// How well each insight type fits each session mode
const TIMING_FIT: Record<string, Record<SessionWindow, number>> = {
  relationship_cooling:     { sprint: 0.2, discovery: 0.8, review: 0.9, repair: 0.0, low_energy: 0.5 },
  focus_drift:              { sprint: 0.1, discovery: 0.8, review: 1.0, repair: 0.0, low_energy: 0.2 },
  timing_observation:       { sprint: 0.3, discovery: 0.7, review: 0.8, repair: 0.0, low_energy: 0.4 },
  hidden_priority:          { sprint: 0.0, discovery: 0.7, review: 1.0, repair: 0.0, low_energy: 0.2 },
  relationship_opportunity: { sprint: 0.2, discovery: 0.9, review: 0.9, repair: 0.0, low_energy: 0.4 },
  blocking_pattern:          { sprint: 0.0, discovery: 0.7, review: 1.0, repair: 0.0, low_energy: 0.2 },
  time_trap:                 { sprint: 0.0, discovery: 0.6, review: 1.0, repair: 0.0, low_energy: 0.1 },
  identity_drift:            { sprint: 0.0, discovery: 0.4, review: 1.0, repair: 0.0, low_energy: 0.0 },
  capability_ceiling:        { sprint: 0.2, discovery: 0.8, review: 0.9, repair: 0.0, low_energy: 0.3 },
}

export function classifySessionWindow(userId: string): SessionWindow {
  try {
    const s = db.prepare('SELECT * FROM live_state WHERE user_id = ?').get(userId) as any
    if (!s) return 'discovery'
    if (s.session_intent === 'repair') return 'repair'
    if (s.session_intent === 'review') return 'review'
    if (s.urgency_level === 'high' || s.urgency_level === 'critical') return 'sprint'
    if (s.cognitive_load === 'high') return 'low_energy'
    return 'discovery'
  } catch { return 'discovery' }
}

export function scoreAction(action: QueuedAction, userId: string, window: SessionWindow): number {
  try {
    const timing = TIMING_FIT[action.action_category]?.[window] ?? 0.5

    const daysOld = Math.floor((Date.now() - new Date(action.created_at).getTime()) / 86400000)
    const recency = daysOld <= 1 ? 1.0 : daysOld <= 7 ? 0.9 : daysOld <= 30 ? 0.7 : daysOld <= 90 ? 0.4 : 0.2

    const relevance = computeRelevance(action, userId)

    // Starvation boost: prevent insights from aging out of surfacing forever
    const starvationBoost = Math.min(action.sessions_in_queue * 0.3, 1.5)

    // SCORE = VALUE × mean(RELEVANCE, CONFIDENCE, TIMING, RECENCY) / (FRICTION / 5) + starvation
    const meanFactors = (relevance + action.confidence + timing + recency) / 4
    const score = action.value_score * meanFactors / (action.friction / 5) + starvationBoost
    return Math.round(score * 100) / 100
  } catch { return 0 }
}

function computeRelevance(action: QueuedAction, userId: string): number {
  try {
    const state = db.prepare('SELECT current_focus_topic FROM live_state WHERE user_id = ?').get(userId) as any
    const focus = state?.current_focus_topic?.toLowerCase() || ''
    if (!focus) return 0.6

    const text = (action.insight_text + ' ' + (action.evidence || '')).toLowerCase()
    const focusWords = focus.split(/\s+/).filter(w => w.length > 3)
    const matches = focusWords.filter(w => text.includes(w)).length
    if (matches >= 2) return 0.9
    if (matches === 1) return 0.75
    return 0.5
  } catch { return 0.6 }
}
