import { db } from '../db.js'
import { checkFocusConvergence } from './s1-focus-convergence.js'
import { checkStressComposite } from './s2-stress-composite.js'
import { getHighImportanceRelationships } from './s3-relationship-weight.js'
import { checkGoalReality } from './s4-goal-reality-check.js'
import { findAutomationOpportunity } from './s5-automation-detector.js'

function wasRecentlySurfaced(userId: string, type: string, withinDays: number): boolean {
  try {
    const row = db.prepare(`
      SELECT last_surfaced_at FROM synthesis_state
      WHERE user_id = ? AND synthesis_type = ?
    `).get(userId, type) as any
    if (!row?.last_surfaced_at) return false
    const msAgo = Date.now() - new Date(row.last_surfaced_at + 'Z').getTime()
    return msAgo < withinDays * 24 * 60 * 60 * 1000
  } catch { return false }
}

function getLastValue(userId: string, type: string): string | null {
  try {
    const row = db.prepare(`SELECT last_value FROM synthesis_state WHERE user_id = ? AND synthesis_type = ?`).get(userId, type) as any
    return row?.last_value ?? null
  } catch { return null }
}

function markSurfaced(userId: string, type: string, value: string) {
  try {
    db.prepare(`
      INSERT INTO synthesis_state (user_id, synthesis_type, last_surfaced_at, last_value)
      VALUES (?, ?, datetime('now'), ?)
      ON CONFLICT(user_id, synthesis_type) DO UPDATE
      SET last_surfaced_at = datetime('now'), last_value = excluded.last_value
    `).run(userId, type, value)
  } catch {}
}

export function buildSynthesisContextBlock(userId: string): string | null {
  const blocks: string[] = []

  // ── S2: Stress State Composite ─────────────────────────────────────────────
  // Checked first — affects all behavior immediately. Re-evaluates daily.
  try {
    if (!wasRecentlySurfaced(userId, 's2', 1)) {
      const stress = checkStressComposite(userId)
      if (stress) {
        const label = stress.level === 'high'
          ? `HIGH PRESSURE STATE — ${stress.score}/7 channels confirm`
          : `ELEVATED PRESSURE — ${stress.score}/7 channels`
        blocks.push(
          `[${label}]\n` +
          `One answer, the best one — no options lists.\n` +
          `Conclusions first; reasoning only if they ask.\n` +
          `Make the decision, don't present it as a choice.\n` +
          `Shortest path to done on every task.`
        )
        markSurfaced(userId, 's2', stress.level)
      }
    }
  } catch {}

  // ── S3: Relationship Importance ────────────────────────────────────────────
  // Low cost, high value. No time gate — surface every session when relevant.
  try {
    const people = getHighImportanceRelationships(userId)
    if (people.length > 0) {
      const lines = people.slice(0, 2).map(p => {
        const details: string[] = []
        if (p.trajectory === 'rising') details.push('relationship growing')
        if (p.register) details.push(`${p.register} register`)
        if (p.isBridge) details.push('bridge contact — spans multiple contexts')
        const recency = p.daysSinceContact <= 7 ? 'active this week'
          : p.daysSinceContact <= 30 ? `last mentioned ${p.daysSinceContact}d ago`
          : 'not mentioned recently'
        details.push(recency)
        return `  ${p.name}: ${details.join(', ')}`
      })
      blocks.push(`[Key relationships]\n${lines.join('\n')}`)
    }
  } catch {}

  // ── S1: Focus Convergence ──────────────────────────────────────────────────
  // Only when the focus area is new (changed from last surfaced). Max weekly.
  try {
    if (!wasRecentlySurfaced(userId, 's1', 7)) {
      const convergence = checkFocusConvergence(userId)
      if (convergence) {
        const lastValue = getLastValue(userId, 's1')
        if (lastValue !== convergence.area) {
          blocks.push(
            `[Focus convergence — ${convergence.confirmedBy.length} channels agree]\n` +
            `Current dominant focus: ${convergence.label}.\n` +
            `Pre-load relevant context; weight responses for this domain.`
          )
          markSurfaced(userId, 's1', convergence.area)
        }
      }
    }
  } catch {}

  // ── S4: Goal Reality Check ─────────────────────────────────────────────────
  // Gentle divergence signal. Max bi-weekly.
  try {
    if (!wasRecentlySurfaced(userId, 's4', 14)) {
      const drift = checkGoalReality(userId)
      if (drift) {
        blocks.push(
          `[Focus drift — surface if relevant]\n` +
          `Stated identity: ${drift.statedLabel}. ` +
          `Actual recent work: ${drift.actualPercentage}% ${drift.actualLabel}.\n` +
          `May be deliberate — raise only if it fits the current conversation.`
        )
        markSurfaced(userId, 's4', drift.actualFocus)
      }
    }
  } catch {}

  // ── S5: Automation Opportunity ─────────────────────────────────────────────
  // Surface once per category, max monthly.
  try {
    if (!wasRecentlySurfaced(userId, 's5', 30)) {
      const opp = findAutomationOpportunity(userId)
      if (opp) {
        const urgencyNote = opp.hasUrgency ? ' These often feel time-sensitive.' : ''
        blocks.push(
          `[Automation opportunity]\n` +
          `${opp.occurrenceCount}x "${opp.taskCategory}" tasks in 30 days, ` +
          `${opp.correctionRate}% correction rate.${urgencyNote}\n` +
          `Consider offering a template or schedule for this task type.`
        )
        markSurfaced(userId, 's5', opp.taskCategory)
      }
    }
  } catch {}

  if (blocks.length === 0) return null
  return `[Cross-Channel Intelligence]\n${blocks.join('\n\n')}`
}
