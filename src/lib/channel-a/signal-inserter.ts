import { db, uuid, j } from '../db.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawSignalInput {
  userId: string
  taskId: string | null
  messageText: string
  messageLength: number
  wordCount: number
  taskType: string
  priorTurnCount: number
  containsPastedContent: boolean
  tribeWordHits: Record<string, string[]>
  hedgingDetected: boolean
  hedgingPhrases: string[]
  frustrationDetected: boolean
  frustrationPhrases: string[]
  extractionError?: string
}

// ─── Raw signal insert ────────────────────────────────────────────────────────

export function insertRawSignal(input: RawSignalInput): void {
  try {
    db.prepare(`
      INSERT INTO channel_a_raw_signals (
        id, user_id, task_id,
        message_text, message_length, word_count,
        task_type, prior_turn_count, contains_pasted_content,
        tribe_word_hits,
        hedging_detected, hedging_phrases,
        frustration_detected, frustration_phrases,
        extraction_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(),
      input.userId,
      input.taskId ?? null,
      input.messageText.slice(0, 2000),
      input.messageLength,
      input.wordCount,
      input.taskType,
      input.priorTurnCount,
      input.containsPastedContent ? 1 : 0,
      j(input.tribeWordHits),
      input.hedgingDetected ? 1 : 0,
      j(input.hedgingPhrases),
      input.frustrationDetected ? 1 : 0,
      j(input.frustrationPhrases),
      input.extractionError ?? null
    )
  } catch (err) {
    console.error('[channel-a] insertRawSignal failed:', err)
  }
}

// ─── Word frequency upsert ────────────────────────────────────────────────────

export function updateWordFrequency(
  userId: string,
  tribeWordHits: Record<string, string[]>
): void {
  // Collect unique words across all tribes (lowercase, deduplicated)
  const allWords = new Set<string>()
  for (const words of Object.values(tribeWordHits)) {
    for (const word of words) {
      allWords.add(word.toLowerCase())
    }
  }

  if (allWords.size === 0) return

  const now = new Date().toISOString()

  for (const word of allWords) {
    try {
      const existing = db.prepare(
        'SELECT id FROM channel_a_word_frequency WHERE user_id = ? AND word = ?'
      ).get(userId, word)

      if (existing) {
        db.prepare(
          'UPDATE channel_a_word_frequency SET count = count + 1, last_seen = ? WHERE user_id = ? AND word = ?'
        ).run(now, userId, word)
      } else {
        db.prepare(
          'INSERT INTO channel_a_word_frequency (id, user_id, word, count, first_seen, last_seen) VALUES (?, ?, ?, 1, ?, ?)'
        ).run(uuid(), userId, word, now, now)
      }
    } catch (err) {
      console.error(`[channel-a] updateWordFrequency failed for word "${word}":`, err)
    }
  }
}
