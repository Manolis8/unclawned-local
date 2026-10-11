import { db } from '../db.js'
import { randomUUID } from 'crypto'

export type TriggerType = 'd1_assumption' | 'd2_pressure' | 'd3_domain' | 'd4_followup'

const PRIORITY: Record<TriggerType, number> = {
  d1_assumption: 4,
  d2_pressure: 3,
  d3_domain: 2,
  d4_followup: 1,
}

// ─── Factual correction markers (D.1) ─────────────────────────────────────────
// These detect when the user corrects a factual assumption the agent made about
// their relationships or context (not output corrections — those are Channel B).
const FACTUAL_CORRECTION_MARKERS = [
  "we've met", "we met", "met before", "i know him", "i know her", "i know them",
  "he's my", "she's my", "they're my", "they are my", "is my colleague",
  "is my friend", "is my boss", "is my client", "is my contact",
  "not a cold", "not new to", "been working with", "worked together", "we worked",
  "you assumed", "that's wrong", "that's incorrect", "i never said", "i didn't say",
  "actually we", "actually i know", "actually he", "actually she",
  "been together", "know each other", "have history", "old friend",
]

// ─── Frustration markers (D.2) ────────────────────────────────────────────────
const FRUSTRATION_MARKERS = [
  "this is wrong", "doesn't work", "not working", "wrong again", "how many times",
  "come on", "ugh", "seriously?", "again?", "what is this", "it's broken",
  "its broken", "terrible", "useless", "forget it", "give up", "waste of time",
  "not what i asked", "that's not what", "thats not what", "still wrong",
  "keeps failing", "keeps breaking", "you keep", "every time",
]

// ─── High-stakes output markers (D.4) ─────────────────────────────────────────
const URGENCY_MARKERS = [
  'asap', 'urgent', 'today', 'need to send', 'critical', 'deadline',
  'by end of', 'immediately', 'right away', 'need it now', 'time sensitive',
]
const OUTPUT_ACTION_MARKERS = [
  'send to', 'email to', 'message to', 'post to', 'publish', 'submit', 'apply for',
  'launch', 'ship', 'deploy', 'pitch to', 'sign and send',
]

// ─── Core helpers ──────────────────────────────────────────────────────────────

// Used externally (Part 2: context builder) to check whether to inject a question
export function hasPendingQuestion(userId: string): boolean {
  const row = db.prepare(
    "SELECT id FROM channel_d_pending WHERE user_id = ? AND status IN ('pending', 'asked') LIMIT 1"
  ).get(userId)
  return !!row
}

// Internal gate: block this trigger only if an equal-or-higher priority question exists
function hasHigherOrEqualPriorityPending(userId: string, incomingType: TriggerType): boolean {
  const row = db.prepare(
    "SELECT trigger_type FROM channel_d_pending WHERE user_id = ? AND status IN ('pending', 'asked') LIMIT 1"
  ).get(userId) as any
  if (!row) return false
  const existingPriority = PRIORITY[row.trigger_type as TriggerType] ?? 0
  return existingPriority >= PRIORITY[incomingType]
}

function checkCooldown(userId: string, triggerType: TriggerType, days: number): boolean {
  const row = db.prepare(`
    SELECT id FROM channel_d_pending
    WHERE user_id = ? AND trigger_type = ?
    AND created_at >= datetime('now', '-${days} days')
    LIMIT 1
  `).get(userId, triggerType)
  return !!row
}

function insertPending(
  userId: string,
  sessionId: string | null,
  triggerType: TriggerType,
  questionText: string,
  questionContext?: string | null,
  entityName?: string | null,
  earliestAskAt?: string | null
): void {
  // Supersede any lower-priority pending question
  const existing = db.prepare(
    "SELECT id, trigger_type FROM channel_d_pending WHERE user_id = ? AND status = 'pending' LIMIT 1"
  ).get(userId) as any

  if (existing) {
    const existingPriority = PRIORITY[existing.trigger_type as TriggerType] ?? 0
    if (PRIORITY[triggerType] <= existingPriority) return
    db.prepare("UPDATE channel_d_pending SET status = 'superseded' WHERE id = ?").run(existing.id)
  }

  db.prepare(`
    INSERT INTO channel_d_pending
      (id, user_id, session_id, trigger_type, question_text, question_context, entity_name, earliest_ask_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
  `).run(
    randomUUID(), userId, sessionId, triggerType, questionText,
    questionContext ?? null, entityName ?? null, earliestAskAt ?? null
  )
  console.log(`[channel-d] queued ${triggerType} for user ${userId}`)
}

// ─── D.1 Assumption Correction ────────────────────────────────────────────────
// Triggers when the user corrects a factual assumption about their relationships
// or context. Queues a question to collect the correct framing for future use.

function extractEntity(message: string): string | null {
  // Multi-word proper noun (e.g. "John Smith", "XYZ Corp") — try first
  const multi = message.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/)
  if (multi) return multi[1]
  // Single proper noun — iterate ALL capitalized words, skip sentence starters
  const IGNORE = new Set(['Actually', 'No', 'That', 'This', 'We', 'She', 'He', 'They', 'It', 'The', 'I'])
  for (const m of message.matchAll(/\b([A-Z][a-z]{2,})\b/g)) {
    if (!IGNORE.has(m[1])) return m[1]
  }
  return null
}

export function checkAssumptionCorrectionTrigger(
  userId: string,
  sessionId: string | null,
  message: string
): void {
  try {
    const msgLower = message.toLowerCase()
    if (!FACTUAL_CORRECTION_MARKERS.some(m => msgLower.includes(m))) return
    if (hasHigherOrEqualPriorityPending(userId, 'd1_assumption')) return
    if (checkCooldown(userId, 'd1_assumption', 7)) return

    const entity = extractEntity(message)
    const question = entity
      ? `Got it — for ${entity}, should I treat this as an established relationship going forward, or keep things more formal?`
      : `Good to know — can you give me a bit more context so I handle this correctly going forward?`

    insertPending(userId, sessionId, 'd1_assumption', question, message.slice(0, 300), entity)
  } catch (err) {
    console.error('[channel-d] D.1 trigger error:', err)
  }
}

// ─── D.2 Pressure Check ───────────────────────────────────────────────────────
// Triggers on the 2nd+ frustration signal within a 30-minute window.
// Queues a question about whether the user is under unusual time pressure.

export function checkPressureTrigger(
  userId: string,
  sessionId: string | null,
  currentMessage: string
): void {
  try {
    const msgLower = currentMessage.toLowerCase()
    if (!FRUSTRATION_MARKERS.some(m => msgLower.includes(m))) return

    // Requires at least 1 prior frustration signal in this session (last 30 min)
    const recentCount = (db.prepare(`
      SELECT COUNT(*) AS cnt FROM channel_a_raw_signals
      WHERE user_id = ? AND frustration_detected = 1
      AND created_at >= datetime('now', '-30 minutes')
    `).get(userId) as any)?.cnt ?? 0

    if (recentCount < 1) return
    if (hasHigherOrEqualPriorityPending(userId, 'd2_pressure')) return
    if (checkCooldown(userId, 'd2_pressure', 7)) return

    const question = `Are you under more pressure than usual today? I can adjust — shorter outputs, faster decisions, no extra options.`
    insertPending(userId, sessionId, 'd2_pressure', question)
  } catch (err) {
    console.error('[channel-d] D.2 trigger error:', err)
  }
}

// ─── D.3 New Domain Debut ─────────────────────────────────────────────────────
// Called from channel-a extractor when a tribe with 2+ hits is detected.
// Fires if this is the first time this tribe appears for the user.

const TRIBE_LABELS: Record<string, string> = {
  founder: 'startup building',
  vc: 'venture capital and fundraising',
  product: 'product development',
  growth: 'growth and marketing',
  sales: 'sales and GTM',
  dev: 'software development',
  content: 'content creation',
  finance: 'finance and investing',
  ops: 'operations and systems',
  ai: 'AI and agents',
}

export function checkNewDomainTrigger(
  userId: string,
  sessionId: string | null,
  tribeKey: string,
  tribeWordCount: number
): void {
  try {
    if (tribeWordCount < 2) return
    if (hasHigherOrEqualPriorityPending(userId, 'd3_domain')) return

    // Never ask twice about the same tribe (permanent dedup on entity_name)
    const alreadyAsked = db.prepare(`
      SELECT id FROM channel_d_pending
      WHERE user_id = ? AND trigger_type = 'd3_domain' AND entity_name = ?
      LIMIT 1
    `).get(userId, tribeKey)
    if (alreadyAsked) return

    // Tribe has significant prior history → not a debut
    const priorHistory = (db.prepare(`
      SELECT COUNT(*) AS cnt FROM channel_a_raw_signals
      WHERE user_id = ? AND tribe_word_hits LIKE ?
      AND created_at >= datetime('now', '-60 days')
    `).get(userId, `%"${tribeKey}"%`) as any)?.cnt ?? 0
    if (priorHistory >= 5) return

    const tribeLabel = TRIBE_LABELS[tribeKey] ?? tribeKey.replace(/_/g, ' ')
    const question = `I'm noticing you're working on ${tribeLabel} — is this a new direction for you, or something you've been building for a while?`
    insertPending(userId, sessionId, 'd3_domain', question, null, tribeKey)
  } catch (err) {
    console.error('[channel-d] D.3 trigger error:', err)
  }
}

// ─── D.4 Completion Follow-up ─────────────────────────────────────────────────
// Fires when a high-stakes task (urgency language or outbound action) completes.
// The queued question is shown 2 hours later so the outcome is known.

export function checkCompletionFollowupTrigger(
  userId: string,
  sessionId: string | null,
  taskSummary: string,
  taskPrompt: string
): void {
  try {
    const promptLower = (taskPrompt || '').toLowerCase()
    const hasOutput = OUTPUT_ACTION_MARKERS.some(m => promptLower.includes(m))
    // Require an actual outbound action — urgency alone (e.g. "today" in a calendar lookup)
    // produces too many false positives without a real outcome to follow up on.
    if (!hasOutput) return
    if (hasHigherOrEqualPriorityPending(userId, 'd4_followup')) return

    // Once per task (session_id = taskId in this context)
    if (sessionId) {
      const taskAsked = db.prepare(
        "SELECT id FROM channel_d_pending WHERE user_id = ? AND trigger_type = 'd4_followup' AND session_id = ? LIMIT 1"
      ).get(userId, sessionId)
      if (taskAsked) return
    }

    // Prefer the task prompt for the label since it's intent-based, not output-based.
    // Cap at 6 words and strip trailing punctuation for a clean question.
    const labelSource = taskPrompt || taskSummary
    const shortLabel = labelSource.trim().split(/\s+/).slice(0, 6).join(' ').replace(/[.!?,;:]+$/, '')
    const question = `By the way — how did "${shortLabel}" go?`

    // Delay asking by 2 hours so the outcome has time to play out
    const earliestAskAt = new Date(Date.now() + 2 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19)

    insertPending(userId, sessionId, 'd4_followup', question, (taskSummary || taskPrompt).slice(0, 300), shortLabel, earliestAskAt)
  } catch (err) {
    console.error('[channel-d] D.4 trigger error:', err)
  }
}
