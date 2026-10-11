import { db } from '../db.js'
import { extractVocabulary, classifyWord, computeDriftFromWords } from './evolution-analyzer.js'

export function trackVocabulary(userId: string, message: string): void {
  const words = extractVocabulary(message)
  if (words.length === 0) return

  const insertLog = db.prepare(`
    INSERT INTO channel_m_word_log (id, user_id, word, created_at)
    VALUES (randomblob(16), ?, ?, datetime('now'))
  `)

  const upsertSummary = db.prepare(`
    INSERT INTO channel_m_vocab_summary (user_id, word, total_count, first_seen, last_seen, is_proper_noun, category)
    VALUES (?, ?, 1, datetime('now'), datetime('now'), ?, ?)
    ON CONFLICT(user_id, word) DO UPDATE SET
      total_count = total_count + 1,
      last_seen = datetime('now'),
      is_proper_noun = is_proper_noun OR excluded.is_proper_noun
  `)

  for (const { word, isProperNoun } of words) {
    insertLog.run(userId, word)
    const category = classifyWord(word)
    upsertSummary.run(userId, word, isProperNoun ? 1 : 0, category)
  }

  _updateProfile(userId)
}

function _updateProfile(userId: string): void {
  // Compute drift from recent word log (last 30 days)
  const recentWords = db.prepare(`
    SELECT word FROM channel_m_word_log
    WHERE user_id = ? AND created_at >= datetime('now', '-30 days')
  `).all(userId) as { word: string }[]

  const driftDirection = computeDriftFromWords(recentWords.map(r => r.word))

  const totalDistinct = db.prepare(`
    SELECT COUNT(*) as cnt FROM channel_m_vocab_summary WHERE user_id = ?
  `).get(userId) as { cnt: number }

  const existing = db.prepare(`SELECT 1 FROM channel_m_profiles WHERE user_id = ?`).get(userId)

  if (existing) {
    db.prepare(`
      UPDATE channel_m_profiles SET drift_direction = ?, total_distinct_words = ?, last_updated = datetime('now')
      WHERE user_id = ?
    `).run(driftDirection, totalDistinct.cnt, userId)
  } else {
    db.prepare(`
      INSERT INTO channel_m_profiles (user_id, drift_direction, total_distinct_words)
      VALUES (?, ?, ?)
    `).run(userId, driftDirection, totalDistinct.cnt)
  }
}
