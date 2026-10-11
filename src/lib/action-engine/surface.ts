import { getQueuedActions, markSurfaced, markActed, markDismissed, markDeferred, requeueDeferred, type QueuedAction } from './queue.js'
import { scoreAction, classifySessionWindow, type SessionWindow } from './scorer.js'
import { getModelConfidence } from './confidence.js'
import { db, uuid } from '../db.js'

export const TIER_1_THRESHOLD = 7.0
export const TIER_2_THRESHOLD = 4.0

export interface SurfaceResult {
  action: QueuedAction
  score: number
  window: SessionWindow
}

function isSessionCooledDown(userId: string, sessionStartIso: string): boolean {
  // Was any proactive item already surfaced since this session started?
  const row = db.prepare(`
    SELECT id FROM action_memory
    WHERE user_id = ? AND surfaced_at >= ?
    LIMIT 1
  `).get(userId, sessionStartIso) as any
  return !!row
}

function sameTypeSurfacedLastSession(userId: string, category: string, sessionStartIso: string): boolean {
  // Spacing rule: if this category was the most recent item surfaced before this session, block it
  const row = db.prepare(`
    SELECT action_category FROM action_memory
    WHERE user_id = ? AND surfaced_at < ?
    ORDER BY surfaced_at DESC
    LIMIT 1
  `).get(userId, sessionStartIso) as any
  return row?.action_category === category
}

function isCategorySuppressed(userId: string, category: string): boolean {
  try {
    const row = db.prepare(`
      SELECT id FROM action_suppression
      WHERE user_id = ? AND (category = ? OR category = 'all')
        AND (expires_at IS NULL OR datetime('now') < expires_at)
      LIMIT 1
    `).get(userId, category) as any
    return !!row
  } catch { return false }
}

function isLiveStateSuppressed(userId: string): boolean {
  try {
    const s = db.prepare('SELECT cognitive_load, emotional_temperature FROM live_state WHERE user_id = ?').get(userId) as any
    if (!s) return false
    if (s.cognitive_load === 'high') return true
    if (s.emotional_temperature === 'low' || s.emotional_temperature === 'distressed') return true
    return false
  } catch { return false }
}

export function pickTopInsight(
  userId: string,
  sessionStartIso: string,
  tier: 1 | 2 = 1
): SurfaceResult | null {
  try {
    const window = classifySessionWindow(userId)
    if (window === 'repair' || window === 'sprint') return null
    if (isSessionCooledDown(userId, sessionStartIso)) return null
    if (isLiveStateSuppressed(userId)) return null

    // Confidence gating: low/cold confidence → no proactive insights
    const confidence = getModelConfidence(userId)
    if (confidence.level === 'cold' || confidence.level === 'low') return null

    const threshold = tier === 1 ? TIER_1_THRESHOLD : TIER_2_THRESHOLD

    const actions = getQueuedActions(userId).filter(a => {
      if (isCategorySuppressed(userId, a.action_category)) return false
      if (sameTypeSurfacedLastSession(userId, a.action_category, sessionStartIso)) return false
      return true
    })
    if (!actions.length) return null

    const scored = actions
      .map(a => ({ action: a, score: scoreAction(a, userId, window), window }))
      .filter(r => r.score >= threshold)
      .sort((a, b) => b.score - a.score)

    const top = scored[0] ?? null

    // Starvation: every item considered but not surfaced this call gets sessions_in_queue++
    const surfacedId = top?.action.id
    for (const a of actions) {
      if (a.id !== surfacedId) markDeferred(a.id)
    }

    return top
  } catch { return null }
}

export function recordActionMemory(
  userId: string,
  queueId: string,
  category: string,
  userResponse: string,
  window: SessionWindow,
  priorityScore: number
): void {
  try {
    db.prepare(`
      INSERT INTO action_memory (id, user_id, queue_id, action_category, surfaced_at, user_response, session_window, priority_score)
      VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)
    `).run(uuid(), userId, queueId, category, userResponse, window, priorityScore)
  } catch {}
}

// Reads action_memory outcomes and adjusts value_score for each category
export function applyMemoryFeedback(userId: string): void {
  try {
    const categories = db.prepare(`
      SELECT DISTINCT action_category FROM action_memory WHERE user_id = ?
    `).all(userId) as any[]

    for (const { action_category } of categories) {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN user_response IN ('acted','engaged') THEN 1 ELSE 0 END) as positive,
          SUM(CASE WHEN user_response = 'dismissed' THEN 1 ELSE 0 END) as dismissed
        FROM action_memory
        WHERE user_id = ? AND action_category = ?
      `).get(userId, action_category) as any

      if (!stats) continue

      // Dismissal penalties — applied even with < 3 total outcomes
      if (stats.dismissed >= 3) {
        try {
          db.prepare(`
            INSERT OR IGNORE INTO action_suppression (id, user_id, category, reason, created_at)
            VALUES (?, ?, ?, 'auto:3_dismissals', datetime('now'))
          `).run(uuid(), userId, action_category)
        } catch {}
        continue
      }

      if (stats.dismissed >= 2) {
        // 2nd dismissal: cap value_score at 4.0 — idempotent, makes Tier 1 very unlikely
        db.prepare(`
          UPDATE action_queue
          SET value_score = MIN(value_score, 4.0)
          WHERE user_id = ? AND action_category = ? AND status = 'queued'
        `).run(userId, action_category)
      }

      if (stats.total < 3) continue

      const neutralCount = stats.total - stats.positive - stats.dismissed
      const effectiveness = (stats.positive + 0.5 * neutralCount) / stats.total

      let delta = 0
      if (effectiveness >= 0.7) delta = 0.5
      else if (effectiveness <= 0.3) delta = -1.0

      if (delta !== 0) {
        db.prepare(`
          UPDATE action_queue
          SET value_score = MAX(1.0, MIN(9.0, value_score + ?))
          WHERE user_id = ? AND action_category = ? AND status = 'queued'
        `).run(delta, userId, action_category)
      }
    }
  } catch {}
}

export function suppressCategory(userId: string, category: string, expiresAt: string | null = null, reason = 'user_command'): void {
  try {
    db.prepare(`
      INSERT OR REPLACE INTO action_suppression (id, user_id, category, reason, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(uuid(), userId, category, reason, expiresAt)
  } catch {}
}

export function unsuppressCategory(userId: string, category: string): void {
  try {
    db.prepare(`DELETE FROM action_suppression WHERE user_id = ? AND category = ?`).run(userId, category)
  } catch {}
}

// Auto-archive items that have been in queue > 21 days without surfacing
export function archiveStaleInsights(userId: string): void {
  try {
    db.prepare(`
      UPDATE action_queue
      SET status = 'archived'
      WHERE user_id = ? AND status = 'queued'
        AND julianday('now') - julianday(created_at) > 21
        AND sessions_in_queue > 3
    `).run(userId)
  } catch {}
}

// Returns human-readable score breakdown for /actions why
export function explainScore(userId: string, idPrefix: string): string | null {
  try {
    const action = db.prepare(`
      SELECT * FROM action_queue WHERE user_id = ? AND id LIKE ?
    `).get(userId, `${idPrefix}%`) as any
    if (!action) return null

    const window = classifySessionWindow(userId)
    const score = scoreAction(action, userId, window)

    const TIMING_FIT: Record<string, Record<string, number>> = {
      relationship_cooling:    { sprint: 0.2, discovery: 0.8, review: 0.9, repair: 0.0, low_energy: 0.5 },
      focus_drift:             { sprint: 0.1, discovery: 0.8, review: 1.0, repair: 0.0, low_energy: 0.2 },
      timing_observation:      { sprint: 0.3, discovery: 0.7, review: 0.8, repair: 0.0, low_energy: 0.4 },
      hidden_priority:         { sprint: 0.0, discovery: 0.7, review: 1.0, repair: 0.0, low_energy: 0.2 },
      relationship_opportunity:{ sprint: 0.2, discovery: 0.9, review: 0.9, repair: 0.0, low_energy: 0.4 },
      blocking_pattern:        { sprint: 0.0, discovery: 0.7, review: 1.0, repair: 0.0, low_energy: 0.2 },
      time_trap:               { sprint: 0.0, discovery: 0.6, review: 1.0, repair: 0.0, low_energy: 0.1 },
      identity_drift:          { sprint: 0.0, discovery: 0.4, review: 1.0, repair: 0.0, low_energy: 0.0 },
      capability_ceiling:      { sprint: 0.2, discovery: 0.8, review: 0.9, repair: 0.0, low_energy: 0.3 },
    }
    const timingFit = TIMING_FIT[action.action_category]?.[window] ?? 0.5

    const daysOld = Math.floor((Date.now() - new Date(action.created_at).getTime()) / 86400000)
    const recency = daysOld <= 1 ? 1.0 : daysOld <= 7 ? 0.9 : daysOld <= 30 ? 0.7 : daysOld <= 90 ? 0.4 : 0.2
    const starvation = Math.min(action.sessions_in_queue * 0.3, 1.5)

    const liveRow = db.prepare('SELECT current_focus_topic FROM live_state WHERE user_id = ?').get(userId) as any
    const focus = liveRow?.current_focus_topic || '(none set)'

    const lines = [
      `\nScore breakdown: ${action.action_category} [${action.id.slice(0, 8)}]`,
      `  VALUE:          ${action.value_score.toFixed(1)}  (estimated impact if acted on)`,
      `  CONFIDENCE:     ${action.confidence.toFixed(2)}`,
      `  TIMING FIT:     ${timingFit.toFixed(2)}  (window: ${window})`,
      `  RECENCY:        ${recency.toFixed(2)}  (signal ${daysOld}d old)`,
      `  FRICTION:       ${action.friction.toFixed(1)}  (effort to act)`,
      `  FOCUS TOPIC:    ${focus}`,
      `  STARVATION:     +${starvation.toFixed(1)}  (${action.sessions_in_queue} sessions in queue)`,
      `  `,
      `  SCORE = ${action.value_score.toFixed(1)} × mean(conf,timing,recency) / (friction/5) + starvation`,
      `        = ${score.toFixed(2)}  →  Tier ${score >= TIER_1_THRESHOLD ? '1 (≥7.0, surfaces at session start)' : score >= TIER_2_THRESHOLD ? '2 (≥4.0, surfaces between tasks)' : '3 (<4.0, held)'}`,
      `  STATUS:         ${action.status}`,
      `  FORMAT:         ${action.insight_format || 'observation'}`,
    ]
    return lines.join('\n')
  } catch { return null }
}

export { markSurfaced, markActed, markDismissed, markDeferred, requeueDeferred }
