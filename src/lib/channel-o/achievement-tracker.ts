import { db } from '../db.js'
import { detectCompletion, detectPastReference } from './completion-detector.js'
import type { AchievementType } from './completion-detector.js'

export function trackAchievement(userId: string, message: string): void {
  const completion = detectCompletion(message)
  const pastRef = !completion ? detectPastReference(message) : null

  if (!completion && !pastRef) return

  const text = completion?.text ?? pastRef!
  const type: AchievementType = completion?.type ?? 'completed'
  const detectedFrom = message.slice(0, 200)

  db.prepare(`
    INSERT INTO channel_o_achievements (id, user_id, achievement_type, achievement_text, detected_from)
    VALUES (randomblob(16), ?, ?, ?, ?)
  `).run(userId, type, text, detectedFrom)

  _updateProfile(userId)
}

function _updateProfile(userId: string): void {
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM channel_o_achievements WHERE user_id = ?`).get(userId) as { cnt: number }

  // Dominant achievement type
  const typeCounts = db.prepare(`
    SELECT achievement_type, COUNT(*) as cnt
    FROM channel_o_achievements WHERE user_id = ?
    GROUP BY achievement_type ORDER BY cnt DESC LIMIT 1
  `).get(userId) as { achievement_type: string; cnt: number } | undefined

  // Most recent
  const recent = db.prepare(`
    SELECT achievement_text, created_at FROM channel_o_achievements
    WHERE user_id = ? ORDER BY rowid DESC LIMIT 1
  `).get(userId) as { achievement_text: string; created_at: string } | undefined

  const existing = db.prepare(`SELECT 1 FROM channel_o_profiles WHERE user_id = ?`).get(userId)

  if (existing) {
    db.prepare(`
      UPDATE channel_o_profiles SET
        total_achievements = ?,
        dominant_achievement_type = ?,
        most_recent_achievement = ?,
        most_recent_at = ?,
        last_updated = datetime('now')
      WHERE user_id = ?
    `).run(
      total.cnt,
      typeCounts?.achievement_type ?? null,
      recent?.achievement_text ?? null,
      recent?.created_at ?? null,
      userId
    )
  } else {
    db.prepare(`
      INSERT INTO channel_o_profiles (user_id, total_achievements, dominant_achievement_type, most_recent_achievement, most_recent_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      userId,
      total.cnt,
      typeCounts?.achievement_type ?? null,
      recent?.achievement_text ?? null,
      recent?.created_at ?? null
    )
  }
}
