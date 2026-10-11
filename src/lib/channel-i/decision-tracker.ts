import { db, uuid, j, p } from '../db.js'
import {
  classifyDecisionStyle, isApprovalSeeking, isResearchTask, isReversalSignal,
  type DecisionStyle,
} from './decision-classifier.js'

// ─── I.1 Decision style tracking ─────────────────────────────────────────────

function recordDecisionStyle(userId: string, sessionId: string, style: DecisionStyle, messagePreview: string): void {
  db.prepare(`
    INSERT INTO channel_i_decision_signals
      (id, user_id, session_id, signal_type, style_label, message_preview, created_at)
    VALUES (?, ?, ?, 'decision_style', ?, ?, datetime('now'))
  `).run(uuid(), userId, sessionId, style, messagePreview.slice(0, 150))
}

// ─── I.2 Research session tracking ───────────────────────────────────────────

function recordResearchTask(userId: string, sessionId: string, messagePreview: string): void {
  db.prepare(`
    INSERT INTO channel_i_decision_signals
      (id, user_id, session_id, signal_type, message_preview, created_at)
    VALUES (?, ?, ?, 'research_task', ?, datetime('now'))
  `).run(uuid(), userId, sessionId, messagePreview.slice(0, 150))
}

// Count research tasks in the last 30 minutes in the same session (before a decision)
function countRecentResearchBeforeDecision(userId: string, sessionId: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM channel_i_decision_signals
    WHERE user_id = ? AND session_id = ? AND signal_type = 'research_task'
    AND created_at >= datetime('now', '-30 minutes')
  `).get(userId, sessionId) as any
  return row?.cnt ?? 0
}

// ─── I.3 Reversal tracking ────────────────────────────────────────────────────

function recordReversal(userId: string, sessionId: string, messagePreview: string): void {
  db.prepare(`
    INSERT INTO channel_i_decision_signals
      (id, user_id, session_id, signal_type, message_preview, created_at)
    VALUES (?, ?, ?, 'reversal', ?, datetime('now'))
  `).run(uuid(), userId, sessionId, messagePreview.slice(0, 150))
}

// ─── I.4 Approval seeking tracking ───────────────────────────────────────────

function recordApprovalSeeking(userId: string, sessionId: string, messagePreview: string): void {
  db.prepare(`
    INSERT INTO channel_i_decision_signals
      (id, user_id, session_id, signal_type, message_preview, created_at)
    VALUES (?, ?, ?, 'approval_seeking', ?, datetime('now'))
  `).run(uuid(), userId, sessionId, messagePreview.slice(0, 150))
}

// ─── Profile update ───────────────────────────────────────────────────────────

function updateProfile(userId: string): void {
  // I.1 — dominant decision style (last 60 signals)
  const styleRows = db.prepare(`
    SELECT style_label, COUNT(*) AS cnt FROM channel_i_decision_signals
    WHERE user_id = ? AND signal_type = 'decision_style' AND style_label IS NOT NULL
    ORDER BY created_at DESC LIMIT 60
  `).all(userId) as any[]

  const styleCounts: Record<string, number> = {}
  for (const row of styleRows) {
    styleCounts[row.style_label] = (styleCounts[row.style_label] ?? 0) + (row.cnt as number)
  }

  const dominantStyle = Object.entries(styleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  // I.2 — research depth classification
  const researchSignals = db.prepare(`
    SELECT session_id, COUNT(*) AS cnt FROM channel_i_decision_signals
    WHERE user_id = ? AND signal_type = 'research_task'
    GROUP BY session_id
    ORDER BY MIN(created_at) DESC LIMIT 20
  `).all(userId) as any[]

  const avgResearchPerSession = researchSignals.length > 0
    ? researchSignals.reduce((sum: number, r: any) => sum + (r.cnt as number), 0) / researchSignals.length
    : 0

  const researchDepth = avgResearchPerSession >= 3 ? 'heavy' : avgResearchPerSession >= 1 ? 'light' : 'unknown'

  // I.3 — reversal rate (reversals / total style+reversal signals)
  const totalDecisions = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM channel_i_decision_signals
    WHERE user_id = ? AND signal_type IN ('decision_style', 'reversal')
  `).get(userId) as any)?.cnt ?? 0

  const totalReversals = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM channel_i_decision_signals
    WHERE user_id = ? AND signal_type = 'reversal'
  `).get(userId) as any)?.cnt ?? 0

  const reversalRate = totalDecisions > 0 ? totalReversals / totalDecisions : 0

  // I.4 — approval seeking rate (last 30 signals total)
  const recentTotal = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM channel_i_decision_signals
    WHERE user_id = ? AND created_at >= datetime('now', '-30 days')
  `).get(userId) as any)?.cnt ?? 0

  const recentApproval = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM channel_i_decision_signals
    WHERE user_id = ? AND signal_type = 'approval_seeking'
    AND created_at >= datetime('now', '-30 days')
  `).get(userId) as any)?.cnt ?? 0

  const approvalRate = recentTotal > 0 ? recentApproval / recentTotal : 0

  const totalSignals = (db.prepare(`SELECT COUNT(*) AS cnt FROM channel_i_decision_signals WHERE user_id = ?`).get(userId) as any)?.cnt ?? 0

  const existing = db.prepare(`SELECT user_id FROM channel_i_profiles WHERE user_id = ?`).get(userId)
  if (existing) {
    db.prepare(`
      UPDATE channel_i_profiles SET
        dominant_style = ?, style_counts = ?,
        research_depth = ?, avg_research_per_session = ?,
        reversal_rate = ?, total_reversals = ?,
        approval_rate = ?, total_signals = ?,
        last_updated = datetime('now')
      WHERE user_id = ?
    `).run(dominantStyle, j(styleCounts), researchDepth, avgResearchPerSession,
           reversalRate, totalReversals, approvalRate, totalSignals, userId)
  } else {
    db.prepare(`
      INSERT INTO channel_i_profiles
        (user_id, dominant_style, style_counts, research_depth, avg_research_per_session,
         reversal_rate, total_reversals, approval_rate, total_signals)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, dominantStyle, j(styleCounts), researchDepth, avgResearchPerSession,
           reversalRate, totalReversals, approvalRate, totalSignals)
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function trackDecisionSignal(userId: string, sessionId: string, message: string): void {
  try {
    const style = classifyDecisionStyle(message)
    const approval = isApprovalSeeking(message)
    const research = isResearchTask(message)
    const reversal = isReversalSignal(message)

    if (style) {
      recordDecisionStyle(userId, sessionId, style, message)
      // I.2: if a decision style fires, record research depth context
      const researchCount = countRecentResearchBeforeDecision(userId, sessionId)
      if (researchCount > 0) {
        // research depth is computed in updateProfile, so just let it aggregate
      }
    }
    if (approval) recordApprovalSeeking(userId, sessionId, message)
    if (research) recordResearchTask(userId, sessionId, message)
    if (reversal) recordReversal(userId, sessionId, message)

    if (style || approval || research || reversal) {
      updateProfile(userId)
    }
  } catch (err) {
    console.error('[channel-i] track error:', err)
  }
}
