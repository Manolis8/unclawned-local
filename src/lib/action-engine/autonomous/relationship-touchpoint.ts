import { db } from '../../db.js'

export interface TouchpointPrep {
  title: string
  content: string
  person_name: string
}

export function prepareRelationshipTouchpoint(
  userId: string,
  scopeParams: { min_cooling_days?: number; max_per_run?: number } = {}
): TouchpointPrep | null {
  try {
    const minDays = scopeParams.min_cooling_days ?? 14

    // Find the most cooling relationship that needs a touchpoint
    const profile = db.prepare(`
      SELECT name, last_seen, mention_count, trajectory, last_topic
      FROM channel_f_relationship_profiles
      WHERE user_id = ?
        AND trajectory IN ('cooling', 'stable')
        AND julianday('now') - julianday(last_seen) >= ?
      ORDER BY julianday('now') - julianday(last_seen) DESC
      LIMIT 1
    `).get(userId, minDays) as any

    if (!profile) return null

    const daysSince = Math.floor((Date.now() - new Date(profile.last_seen).getTime()) / 86400000)

    // Read user goals for context
    const goalsRow = db.prepare(`SELECT value FROM user_profile WHERE user_id = ? AND key = 'current_goals'`).get(userId) as any
    const goals = goalsRow?.value || ''

    // Build a draft touchpoint — simple, contextual, not generic
    const topicLine = profile.last_topic ? `Last discussed: ${profile.last_topic}.` : ''
    const goalHint = goals ? `\n  Note: your current focus is "${goals.slice(0, 50)}" — consider linking if relevant.` : ''

    const draft = `Hey ${profile.name}, wanted to check in — ${topicLine ? `we last talked about ${profile.last_topic}, curious how that's progressing.` : `hope things are going well.`}`

    const content = [
      `  ${profile.name} — last contact ${daysSince} days ago (trajectory: ${profile.trajectory})`,
      topicLine ? `  Context: ${topicLine}` : '',
      ``,
      `  Draft:`,
      `  "${draft}"`,
      goalHint,
    ].filter(Boolean).join('\n')

    return {
      title: `Relationship Touchpoint — ${profile.name}`,
      content,
      person_name: profile.name
    }
  } catch { return null }
}
