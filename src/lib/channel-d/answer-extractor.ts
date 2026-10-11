import { db } from '../db.js'
import { randomUUID } from 'crypto'

// ─── New-task starters (message is a new task, not an answer to the D question) ──
const NEW_TASK_STARTERS = [
  'write', 'create', 'help', 'find', 'build', 'research', 'open', 'go to',
  'make', 'draft', 'send', 'compose', 'generate', 'can you', 'could you',
  'please', 'search', 'look up', 'show me', 'explain', 'analyze',
]

// ─── D.2 yes/no patterns ──────────────────────────────────────────────────────
const PRESSURE_YES = ['yes', 'yeah', 'definitely', 'kind of', 'a bit', 'sort of', 'honestly', 'true', 'indeed', 'yep', 'yup']
const PRESSURE_NO  = ['no', 'nope', 'not really', "i'm fine", "im fine", 'all good', 'not today', "don't think so"]

// ─── D.3 active/exploring patterns ───────────────────────────────────────────
const DOMAIN_ACTIVE   = ['yes', 'active', 'working on', 'building', 'definitely', 'been doing', 'main thing', 'all in', 'full time', 'started']
const DOMAIN_EXPLORING = ['exploring', 'just looking', 'curious', 'not sure', 'thinking about', 'might', 'maybe', 'possibly', 'researching', 'learning']

// ─── D.4 outcome sentiment patterns ──────────────────────────────────────────
const OUTCOME_POSITIVE = ['good', 'great', 'well', 'positive', 'worked', 'yes', 'they replied', 'got a response', 'success', 'got it', 'landed', 'closed', 'they said yes', 'approved', 'amazing', 'perfect', 'went well']
const OUTCOME_NEGATIVE = ['bad', 'no', 'rejected', 'failed', 'no response', 'nothing', 'ghosted', 'didnt work', "didn't work", 'fell through', 'not good', 'terrible', 'disaster', 'wrong', 'said no']

// ─── Is this message an answer or a new task? ────────────────────────────────

function isLikelyNewTask(message: string): boolean {
  const lower = message.toLowerCase().trim()
  const words = lower.split(/\s+/).filter(Boolean)
  const wordCount = words.length

  // Very long messages with action intent → definitely a new task
  if (wordCount > 60) {
    const firstFive = words.slice(0, 5).join(' ')
    if (NEW_TASK_STARTERS.some(s => firstFive.startsWith(s))) return true
  }

  // Short messages with clear new-task starters → still a new task
  const firstThree = words.slice(0, 3).join(' ')
  if (NEW_TASK_STARTERS.some(s => firstThree.startsWith(s))) return true

  return false
}

// ─── Per-type fact extraction ─────────────────────────────────────────────────

function extractD1Fact(message: string, entityName: string | null): { fact: string; confidence: string } {
  // D.1: store raw relationship correction. No parsing needed — the raw message IS the fact.
  const snippet = message.trim().slice(0, 200)
  const fact = entityName
    ? `For ${entityName}: ${snippet}`
    : snippet
  return { fact, confidence: 'high' }
}

function extractD2Fact(message: string): { fact: string; isPressure: boolean } {
  const lower = message.toLowerCase()
  const yes = PRESSURE_YES.some(w => lower.includes(w))
  const no  = PRESSURE_NO.some(w => lower.includes(w))
  if (no && !yes) {
    return { fact: 'User denied pressure — normal mode, no adjustment needed', isPressure: false }
  }
  // Default to yes when ambiguous (better to be brief than to miss a stressed user)
  return { fact: 'User confirmed high-pressure mode — keep responses brief, decisive, limit options to one recommendation', isPressure: true }
}

function extractD3Fact(message: string, entityName: string | null): { fact: string; isActive: boolean } {
  const lower = message.toLowerCase()
  const active   = DOMAIN_ACTIVE.some(w => lower.includes(w))
  const exploring = DOMAIN_EXPLORING.some(w => lower.includes(w))
  const label = entityName ?? 'this domain'
  if (exploring && !active) {
    return { fact: `User is exploring ${label} but it's not an active focus`, isActive: false }
  }
  return { fact: `User is actively working on ${label}`, isActive: true }
}

function extractD4Fact(message: string, entityName: string | null): { fact: string; sentiment: string } {
  const lower = message.toLowerCase()
  const positive = OUTCOME_POSITIVE.some(w => lower.includes(w))
  const negative = OUTCOME_NEGATIVE.some(w => lower.includes(w))
  const label = entityName ?? 'the task'
  let sentiment = 'neutral'
  if (positive && !negative) sentiment = 'positive'
  if (negative && !positive) sentiment = 'negative'
  return { fact: `Task "${label}" outcome: ${sentiment}`, sentiment }
}

// ─── Main entry point ─────────────────────────────────────────────────────────
//
// Called BEFORE the main AI processing, at the top of the chat message handler.
// If there's an 'asked' pending question and this message looks like an answer,
// stores the extraction and marks the question answered.

export function extractChannelDAnswer(
  userId: string,
  sessionId: string,
  message: string
): void {
  try {
    // Find the most recently asked pending question
    const pending = db.prepare(`
      SELECT * FROM channel_d_pending
      WHERE user_id = ? AND status = 'asked'
      ORDER BY asked_at DESC LIMIT 1
    `).get(userId) as any

    if (!pending) return

    // Expire if question is older than 48 hours (user never answered)
    const ageMs = Date.now() - new Date(pending.created_at).getTime()
    if (ageMs > 48 * 60 * 60 * 1000) {
      db.prepare("UPDATE channel_d_pending SET status = 'expired' WHERE id = ?").run(pending.id)
      return
    }

    // If message looks like a new task, mark as ignored
    if (isLikelyNewTask(message)) {
      db.prepare("UPDATE channel_d_pending SET status = 'ignored' WHERE id = ?").run(pending.id)
      console.log(`[channel-d] pending ${pending.trigger_type} marked ignored (new task detected)`)
      return
    }

    // Extract per type
    const triggerType = pending.trigger_type as string
    let extractedFact = ''
    let sentiment: string | null = null
    let confidence = 'medium'
    let expiresAt: string | null = null

    if (triggerType === 'd1_assumption') {
      const r = extractD1Fact(message, pending.entity_name)
      extractedFact = r.fact
      confidence = r.confidence
      expiresAt = null  // permanent
    } else if (triggerType === 'd2_pressure') {
      const r = extractD2Fact(message)
      extractedFact = r.fact
      confidence = 'medium'
      // D.2 only applies to THIS session — we use session_id to filter, not expires_at
      expiresAt = null
    } else if (triggerType === 'd3_domain') {
      const r = extractD3Fact(message, pending.entity_name)
      extractedFact = r.fact
      confidence = 'medium'
      // D.3 expires after 90 days (domain focus can change)
      expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    } else if (triggerType === 'd4_followup') {
      const r = extractD4Fact(message, pending.entity_name)
      extractedFact = r.fact
      sentiment = r.sentiment
      confidence = 'medium'
      expiresAt = null  // permanent
    } else {
      return
    }

    // Insert extraction row
    db.prepare(`
      INSERT INTO channel_d_extractions
        (id, user_id, session_id, pending_id, trigger_type, question_text, answer_text,
         extracted_fact, entity_name, answer_confidence, sentiment, is_active, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))
    `).run(
      randomUUID(), userId, sessionId, pending.id, triggerType, pending.question_text,
      message.slice(0, 1000), extractedFact, pending.entity_name ?? null,
      confidence, sentiment, expiresAt
    )

    // Mark pending as answered
    db.prepare(`
      UPDATE channel_d_pending SET status = 'answered', answered_at = datetime('now') WHERE id = ?
    `).run(pending.id)

    console.log(`[channel-d] extracted ${triggerType} answer for user ${userId}: ${extractedFact.slice(0, 80)}`)
  } catch (err) {
    console.error('[channel-d] answer extraction error:', err)
  }
}
