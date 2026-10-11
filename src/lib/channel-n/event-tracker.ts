import { db } from '../db.js'
import { extractWatchlistEntities, detectWorldEvents, scoreRelevance } from './world-scanner.js'

export function trackWorldSignals(userId: string, message: string): void {
  // Update watchlist with every entity mentioned
  const entities = extractWatchlistEntities(message)
  const upsertEntity = db.prepare(`
    INSERT INTO channel_n_watchlist (user_id, entity_name, entity_type, mentions_count, first_seen, last_mentioned)
    VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(user_id, entity_name) DO UPDATE SET
      mentions_count = mentions_count + 1,
      last_mentioned = datetime('now')
  `)
  for (const { name, type } of entities) {
    upsertEntity.run(userId, name, type)
  }

  // Detect world events and log them with relevance scores
  const events = detectWorldEvents(message)
  for (const { entityName, eventType, headline } of events) {
    const watchEntry = db.prepare(`
      SELECT mentions_count,
        CAST(julianday('now') - julianday(last_mentioned) AS INTEGER) as days_since
      FROM channel_n_watchlist WHERE user_id = ? AND entity_name = ?
    `).get(userId, entityName) as { mentions_count: number; days_since: number } | undefined

    const mentionsCount = watchEntry?.mentions_count ?? 1
    const daysSince = watchEntry?.days_since ?? null
    const relevanceScore = scoreRelevance(mentionsCount, daysSince)

    db.prepare(`
      INSERT INTO channel_n_events (id, user_id, entity_name, event_type, headline, relevance_score, surfaced)
      VALUES (randomblob(16), ?, ?, ?, ?, ?, 0)
    `).run(userId, entityName, eventType, headline, relevanceScore)
  }

  // Update profile
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM channel_n_events WHERE user_id = ?`).get(userId) as { cnt: number }
  const existing = db.prepare(`SELECT 1 FROM channel_n_profiles WHERE user_id = ?`).get(userId)
  if (existing) {
    db.prepare(`UPDATE channel_n_profiles SET total_events = ? WHERE user_id = ?`).run(total.cnt, userId)
  } else {
    db.prepare(`INSERT INTO channel_n_profiles (user_id, total_events) VALUES (?, ?)`).run(userId, total.cnt)
  }
}
