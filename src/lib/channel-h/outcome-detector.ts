import { db } from '../db.js'

// H.2 — detect downstream outcome signals from user messages and link them to corpus items

const POSITIVE_OUTCOMES = [
  'they replied', 'got a reply', 'got a response', 'she replied', 'he replied',
  'they said yes', 'she said yes', 'he said yes', 'approved', 'they approved',
  'accepted', 'it worked', 'worked great', 'landed', 'closed', 'signed', 'got the deal',
  'got the job', 'got a call', 'scheduled a call', 'got feedback', 'loved it',
  'great feedback', 'positive feedback', 'really liked it', 'they were impressed',
  'moved forward', 'next steps', 'they want to meet', 'interested', 'they\'re in',
]

const NEGATIVE_OUTCOMES = [
  'no response', 'no reply', 'didn\'t reply', 'didn\'t respond', 'ghosted',
  'they passed', 'passed on it', 'not interested', 'rejected', 'got rejected',
  'didn\'t work', 'it failed', 'fell through', 'they said no', 'declined',
  'bad feedback', 'negative feedback', 'they didn\'t like it', 'not what they wanted',
]

export function detectOutcomeSignal(userId: string, message: string): void {
  try {
    const lower = message.toLowerCase()

    const isPositive = POSITIVE_OUTCOMES.some(p => lower.includes(p))
    const isNegative = NEGATIVE_OUTCOMES.some(p => lower.includes(p))

    if (!isPositive && !isNegative) return

    const sentiment: 'positive' | 'negative' = isPositive && !isNegative ? 'positive' : 'negative'
    const context = message.slice(0, 200)

    // Find the most recent corpus item without an outcome yet (last 7 days)
    const recent = db.prepare(`
      SELECT id FROM channel_h_corpus_items
      WHERE user_id = ? AND outcome_sentiment IS NULL
      AND created_at >= datetime('now', '-7 days')
      ORDER BY rowid DESC LIMIT 1
    `).get(userId) as any

    if (recent) {
      db.prepare(`
        UPDATE channel_h_corpus_items
        SET outcome_sentiment = ?, outcome_context = ?
        WHERE id = ?
      `).run(sentiment, context, recent.id)
      console.log(`[channel-h] outcome signal: ${sentiment} for corpus item ${recent.id}`)
    }
  } catch (err) {
    console.error('[channel-h] outcome detection error:', err)
  }
}
