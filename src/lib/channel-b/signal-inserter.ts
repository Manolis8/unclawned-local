import { db, uuid, j, p } from '../db.js'

export interface RawSignalInput {
  userId: string
  sessionId: string | null
  userMessageText: string
  userMessageLength: number
  priorTaskType: string | null
  priorResponseLength: number
  isContinuation: boolean
  isCorrection: boolean
  correctionLevel: number | null
  correctionPhrases: string[]
  containsPaste: boolean
  pasteType: string | null
  pasteCharCount: number | null
  pasteTribeHits: Record<string, string[]>
  latencySeconds: number | null
  latencyBucket: string | null
  isRubberStamp: boolean
}

export function insertRawSignal(input: RawSignalInput): string {
  const id = uuid()
  db.prepare(`
    INSERT INTO channel_b_raw_signals (
      id, user_id, session_id,
      user_message_text, user_message_length,
      prior_task_type, prior_response_length,
      is_continuation, is_correction, correction_level, correction_phrases,
      contains_paste, paste_type, paste_char_count, paste_tribe_hits,
      latency_seconds, latency_bucket, is_rubber_stamp
    ) VALUES (
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?
    )
  `).run(
    id, input.userId, input.sessionId,
    input.userMessageText.slice(0, 2000), input.userMessageLength,
    input.priorTaskType, input.priorResponseLength,
    input.isContinuation ? 1 : 0,
    input.isCorrection ? 1 : 0,
    input.correctionLevel,
    j(input.correctionPhrases),
    input.containsPaste ? 1 : 0,
    input.pasteType,
    input.pasteCharCount,
    j(input.pasteTribeHits),
    input.latencySeconds,
    input.latencyBucket,
    input.isRubberStamp ? 1 : 0
  )
  return id
}

// ─── Paste log ────────────────────────────────────────────────────────────────

export interface PasteLogInput {
  userId: string
  pasteType: string
  pasteCharCount: number | null
  pasteTribeHits: Record<string, string[]>
  primaryTribe: string | null
}

export function insertPasteLog(input: PasteLogInput): void {
  db.prepare(`
    INSERT INTO channel_b_paste_log (id, user_id, paste_type, paste_char_count, paste_tribe_hits, primary_tribe)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    uuid(),
    input.userId,
    input.pasteType,
    input.pasteCharCount,
    j(input.pasteTribeHits),
    input.primaryTribe
  )
}

// ─── Correction merge ─────────────────────────────────────────────────────────
//
// If the same session already has a correction event in the last 10 minutes,
// update it to the highest level seen instead of inserting a new row.
// This prevents multi-turn corrections ("change tone" → "also fix bullets")
// from inflating the correction count for one output.

export interface MergeResult {
  merged: boolean
  oldLevel: number | null   // null when not merged
  mergedLevel: number
}

export function mergeCorrection(
  sessionId: string,
  newLevel: number,
  newPhrases: string[]
): MergeResult {
  const existing = db.prepare(`
    SELECT id, correction_level, correction_phrases
    FROM channel_b_raw_signals
    WHERE session_id = ?
      AND is_correction = 1
      AND datetime(created_at) >= datetime('now', '-10 minutes')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(sessionId) as { id: string; correction_level: number; correction_phrases: string } | undefined

  if (!existing) return { merged: false, oldLevel: null, mergedLevel: newLevel }

  const oldLevel = existing.correction_level ?? 1
  const mergedLevel = Math.max(oldLevel, newLevel)
  const oldPhrases: string[] = p(existing.correction_phrases) ?? []
  const mergedPhrases = [...new Set([...oldPhrases, ...newPhrases])]

  db.prepare(`
    UPDATE channel_b_raw_signals
    SET correction_level = ?, correction_phrases = ?
    WHERE id = ?
  `).run(mergedLevel, j(mergedPhrases), existing.id)

  return { merged: true, oldLevel: mergedLevel !== oldLevel ? oldLevel : null, mergedLevel }
}
