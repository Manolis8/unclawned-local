import { db } from '../../db.js'
import { enqueueInsight } from '../queue.js'

const COOLING_DAYS = 14
const MIN_MENTIONS = 3

export function detectRelationshipCooling(userId: string): void {
  try {
    // People with 3+ mentions whose last_seen was 14+ days ago
    const candidates = db.prepare(`
      SELECT person_name, mention_count, last_seen, cluster_tags
      FROM channel_f_relationship_profiles
      WHERE user_id = ?
        AND mention_count >= ?
        AND julianday('now') - julianday(last_seen) >= ?
      ORDER BY mention_count DESC
      LIMIT 3
    `).all(userId, MIN_MENTIONS, COOLING_DAYS) as any[]

    if (!candidates.length) return

    const person = candidates[0]
    const days = Math.floor((Date.now() - new Date(person.last_seen).getTime()) / 86400000)
    const daysLabel = days === 1 ? '1 day' : `${days} days`

    let tags: string[] = []
    try { tags = JSON.parse(person.cluster_tags || '[]') } catch {}
    const contextHint = tags.length > 0 ? ` (${tags[0]})` : ''

    enqueueInsight(
      userId,
      'relationship_cooling',
      `You haven't mentioned ${person.person_name}${contextHint} in ${daysLabel}.`,
      'Worth a quick check-in, or is that intentional?',
      { person_name: person.person_name, days_since: days, mention_count: person.mention_count },
      6.5, 0.75, 2.5
    )
  } catch {}
}
