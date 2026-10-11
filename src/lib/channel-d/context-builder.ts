import { db } from '../db.js'
import { hasPendingQuestion } from './trigger-detector.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface PendingRow {
  id: string
  user_id: string
  session_id: string | null
  trigger_type: string
  question_text: string
  question_context: string | null
  entity_name: string | null
  earliest_ask_at: string | null
  status: string
  asked_at: string | null
  answered_at: string | null
  created_at: string
}

interface ExtractionRow {
  id: string
  user_id: string
  session_id: string | null
  trigger_type: string
  question_text: string | null
  answer_text: string
  extracted_fact: string | null
  entity_name: string | null
  answer_confidence: string
  sentiment: string | null
  is_active: number
  expires_at: string | null
  created_at: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPendingQuestion(userId: string): PendingRow | null {
  return db.prepare(`
    SELECT * FROM channel_d_pending
    WHERE user_id = ? AND status = 'pending'
      AND (earliest_ask_at IS NULL OR earliest_ask_at <= datetime('now'))
    ORDER BY created_at ASC LIMIT 1
  `).get(userId) as PendingRow | null
}

function getActiveExtractions(userId: string): ExtractionRow[] {
  return db.prepare(`
    SELECT * FROM channel_d_extractions
    WHERE user_id = ? AND is_active = 1
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    ORDER BY created_at DESC LIMIT 10
  `).all(userId) as ExtractionRow[]
}

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24))
}

// ─── Context block builder ────────────────────────────────────────────────────
//
// Returns a block injected into the agent's system prompt. Two sections:
//   1. Known Context — extracted facts from past D-channel answers
//   2. FOLLOW-UP QUESTION directive — if a pending question is ready to ask
//
// Also marks the pending question as 'asked' when the directive is injected.

export function buildChannelDContextBlock(userId: string, sessionId: string): string {
  const parts: string[] = []

  // ── Section 1: Known context from past extractions ─────────────────────────
  try {
    const extractions = getActiveExtractions(userId)
    const contextLines: string[] = []

    for (const row of extractions) {
      if (!row.extracted_fact) continue

      if (row.trigger_type === 'd1_assumption') {
        // Relationship context — permanent, always inject
        contextLines.push(`- Relationship context: ${row.extracted_fact}`)
      } else if (row.trigger_type === 'd2_pressure') {
        // Only inject if this extraction is from the current session
        if (row.session_id === sessionId) {
          contextLines.push(`- ${row.extracted_fact}`)
        }
      } else if (row.trigger_type === 'd3_domain') {
        // Domain intent — inject with age hint
        const days = daysSince(row.created_at)
        const ageNote = days === 0 ? 'confirmed today' : days <= 7 ? `confirmed ${days}d ago` : `confirmed ${Math.round(days / 7)}w ago`
        contextLines.push(`- Domain focus: ${row.extracted_fact} (${ageNote})`)
      }
      // D.4 (task outcomes) not injected — historical only
    }

    if (contextLines.length > 0) {
      parts.push(`## Known Context (confirmed by user)\n${contextLines.join('\n')}`)
    }
  } catch { /* non-fatal */ }

  // ── Section 2: Pending question directive ──────────────────────────────────
  try {
    const pending = getPendingQuestion(userId)
    if (pending) {
      const directive = `## FOLLOW-UP QUESTION\nAfter responding to the user's request, end your response with this exact question as a standalone line (no modifications, no added qualifiers):\n"${pending.question_text}"`
      parts.push(directive)

      // Mark as asked so we don't re-inject it next turn
      db.prepare("UPDATE channel_d_pending SET status = 'asked', asked_at = datetime('now') WHERE id = ?").run(pending.id)
    }
  } catch { /* non-fatal */ }

  return parts.join('\n\n')
}

// ─── Debug report ─────────────────────────────────────────────────────────────

export function buildDebugReport(userId: string, sessionId = ''): string {
  const lines: string[] = []
  lines.push(`CHANNEL D DEBUG REPORT — user: ${userId}`)
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')

  // Pending questions
  try {
    const pending = db.prepare(
      "SELECT * FROM channel_d_pending WHERE user_id = ? ORDER BY created_at DESC LIMIT 10"
    ).all(userId) as PendingRow[]

    lines.push('─── D.1 PENDING QUESTIONS ─────────────────────────────')
    if (pending.length === 0) {
      lines.push('  (none)')
    } else {
      for (const row of pending) {
        const ready = !row.earliest_ask_at || new Date(row.earliest_ask_at) <= new Date()
        lines.push(`  [${row.status.toUpperCase()}] ${row.trigger_type} | entity: ${row.entity_name ?? 'none'}`)
        lines.push(`    Question: "${row.question_text}"`)
        lines.push(`    Created: ${row.created_at}  Ready: ${ready ? 'yes' : `no (wait until ${row.earliest_ask_at})`}`)
        if (row.asked_at)    lines.push(`    Asked: ${row.asked_at}`)
        if (row.answered_at) lines.push(`    Answered: ${row.answered_at}`)
        lines.push('')
      }
    }
  } catch (err) {
    lines.push(`  Error reading pending: ${err}`)
  }

  // Extractions
  try {
    const extractions = db.prepare(
      "SELECT * FROM channel_d_extractions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
    ).all(userId) as ExtractionRow[]

    lines.push('─── D.2 EXTRACTIONS (stored answers) ──────────────────')
    if (extractions.length === 0) {
      lines.push('  (none)')
    } else {
      for (const row of extractions) {
        const expired = row.expires_at ? new Date(row.expires_at) <= new Date() : false
        lines.push(`  [${row.trigger_type}] active=${row.is_active} expired=${expired}`)
        lines.push(`    Fact: ${row.extracted_fact ?? '(none)'}`)
        lines.push(`    Answer: "${row.answer_text.slice(0, 100)}${row.answer_text.length > 100 ? '...' : ''}"`)
        lines.push(`    Confidence: ${row.answer_confidence}  Sentiment: ${row.sentiment ?? 'n/a'}`)
        lines.push(`    Created: ${row.created_at}  Expires: ${row.expires_at ?? 'never'}`)
        lines.push('')
      }
    }
  } catch (err) {
    lines.push(`  Error reading extractions: ${err}`)
  }

  // Context block preview
  try {
    const block = buildChannelDContextBlock(userId, sessionId)
    lines.push('─── D.3 CONTEXT BLOCK (what agent sees) ───────────────')
    if (block) {
      lines.push(block)
    } else {
      lines.push('  (empty — no active extractions or pending questions ready)')
    }
    lines.push('')
  } catch (err) {
    lines.push(`  Error building context: ${err}`)
  }

  // Stats
  try {
    const stats = db.prepare(`
      SELECT trigger_type, status, COUNT(*) as cnt
      FROM channel_d_pending WHERE user_id = ?
      GROUP BY trigger_type, status
    `).all(userId) as any[]

    lines.push('─── D.4 STATS ─────────────────────────────────────────')
    for (const row of stats) {
      lines.push(`  ${row.trigger_type} / ${row.status}: ${row.cnt}`)
    }
    lines.push(`  hasPendingQuestion: ${hasPendingQuestion(userId)}`)
    lines.push('')
  } catch (err) {
    lines.push(`  Error reading stats: ${err}`)
  }

  return lines.join('\n')
}
