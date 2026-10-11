import { db } from '../../db.js'
import { enqueueInsight } from '../queue.js'

export function detectRelationshipOpportunity(userId: string): void {
  try {
    // Find warming relationships with enough mentions
    const warming = db.prepare(`
      SELECT person_name, mention_count, last_seen, cluster_tags, communication_register
      FROM channel_f_relationship_profiles
      WHERE user_id = ?
        AND trajectory = 'warming'
        AND mention_count >= 2
        AND julianday('now') - julianday(last_seen) <= 30
      ORDER BY mention_count DESC
      LIMIT 3
    `).all(userId) as any[]
    if (!warming.length) return

    // Current focus and goals
    const liveRow = db.prepare(`SELECT current_focus_topic FROM live_state WHERE user_id = ?`).get(userId) as any
    const goalsRow = db.prepare(`SELECT value FROM user_profile WHERE user_id = ? AND key = 'current_goals'`).get(userId) as any
    const focus = (liveRow?.current_focus_topic || '').toLowerCase()
    const goals = (goalsRow?.value || '').toLowerCase()
    const context = (focus + ' ' + goals).toLowerCase()

    if (!context.trim()) return

    // Find the warming person most relevant to current focus/goals
    let best: any = null
    let bestOverlap = 0

    for (const person of warming) {
      let tags: string[] = []
      try { tags = JSON.parse(person.cluster_tags || '[]') } catch {}
      const personContext = (tags.join(' ') + ' ' + (person.communication_register || '')).toLowerCase()
      const personWords = personContext.split(/\s+/).filter(w => w.length > 3)
      const contextWords = context.split(/\s+/).filter(w => w.length > 3)
      const overlap = personWords.filter(w => contextWords.some(c => c.includes(w) || w.includes(c))).length
      if (overlap > bestOverlap) { bestOverlap = overlap; best = person }
    }

    if (!best || bestOverlap === 0) return

    let tags: string[] = []
    try { tags = JSON.parse(best.cluster_tags || '[]') } catch {}
    const contextHint = tags.length > 0 ? tags[0] : best.communication_register || 'contact'
    const daysSince = Math.floor((Date.now() - new Date(best.last_seen).getTime()) / 86400000)

    const insightText = `${best.person_name} (${contextHint}) is on a warming trajectory and aligns with your current focus.`
    const questionText = `Want me to draft a message to ${best.person_name.split(' ')[0]}?`

    const evidence = {
      channels: ['channel_f', 'live_state', 'user_profile'],
      person_name: best.person_name,
      trajectory: 'warming',
      mention_count: best.mention_count,
      days_since_last: daysSince,
      focus_overlap: bestOverlap,
      observations: [
        `${best.person_name}: ${best.mention_count} mentions, trajectory warming`,
        `Last contact: ${daysSince} days ago`,
        `Relevant to: ${focus || goals.slice(0, 50)}`
      ]
    }

    enqueueInsight(
      userId,
      'relationship_opportunity',
      insightText,
      questionText,
      evidence,
      7.0, 0.65, 3.0,
      'compound'
    )
  } catch {}
}
