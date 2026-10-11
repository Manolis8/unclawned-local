import { db, uuid, j, p } from '../db.js'
import { extractMentions, extractCoMentionMap, type Tone, type ReferenceStyle } from './mention-extractor.js'

// ─── Trajectory thresholds ────────────────────────────────────────────────────
// "rising" if mentions in last 7 days > mentions in prior 7 days by 50%+ and >= 2 recent
// "cooling" if mentions dropped 50%+ and there were prior mentions
// "silent"  if no mention in 14+ days and had >= 3 prior mentions total
// "stable"  otherwise

function recalcTrajectory(userId: string, personName: string): 'rising' | 'stable' | 'cooling' | 'silent' {
  const totalRow = db.prepare(
    `SELECT mention_count, last_seen FROM channel_f_relationship_profiles WHERE user_id = ? AND person_name = ?`
  ).get(userId, personName) as any
  if (!totalRow) return 'stable'

  const daysSilent = (Date.now() - new Date(totalRow.last_seen).getTime()) / (1000 * 60 * 60 * 24)
  if (daysSilent > 14 && totalRow.mention_count >= 3) return 'silent'

  const recentCount = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM channel_f_person_mentions
    WHERE user_id = ? AND person_name = ? AND created_at >= datetime('now', '-7 days')
  `).get(userId, personName) as any)?.cnt ?? 0

  const priorCount = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM channel_f_person_mentions
    WHERE user_id = ? AND person_name = ?
    AND created_at < datetime('now', '-7 days')
    AND created_at >= datetime('now', '-14 days')
  `).get(userId, personName) as any)?.cnt ?? 0

  if (recentCount >= 2 && recentCount > priorCount * 1.5) return 'rising'
  if (priorCount >= 2 && recentCount < priorCount * 0.5) return 'cooling'
  return 'stable'
}

function detectClusters(userId: string, personName: string, coMentioned: string[]): string[] {
  // Look at what topics appear alongside mentions of this person
  // Also look at co-mention patterns: are these people always mentioned together?
  const tags: string[] = []

  // Get tone history for this person
  const tones = (db.prepare(`
    SELECT context_tone FROM channel_f_person_mentions
    WHERE user_id = ? AND person_name = ?
    ORDER BY rowid DESC LIMIT 10
  `).all(userId, personName) as any[]).map(r => r.context_tone as Tone)

  const urgentCount = tones.filter(t => t === 'urgent').length
  const positiveCount = tones.filter(t => t === 'positive').length
  const negativeCount = tones.filter(t => t === 'negative').length

  if (urgentCount >= 2) tags.push('fire_drill')
  if (positiveCount >= 3) tags.push('trusted_circle')

  // Infer cluster from reference styles
  const styles = (db.prepare(`
    SELECT reference_style FROM channel_f_person_mentions
    WHERE user_id = ? AND person_name = ?
    ORDER BY rowid DESC LIMIT 5
  `).all(userId, personName) as any[]).map(r => r.reference_style as ReferenceStyle)

  const roleTitleCount = styles.filter(s => s === 'role_title').length
  if (roleTitleCount >= 2) tags.push('professional_contact')

  return tags
}

function detectBridges(userId: string): void {
  // A bridge is a person who appears in 2+ different cluster contexts
  const profiles = db.prepare(
    `SELECT person_name, cluster_tags FROM channel_f_relationship_profiles WHERE user_id = ? AND mention_count >= 3`
  ).all(userId) as any[]

  for (const profile of profiles) {
    const tags: string[] = p(profile.cluster_tags) ?? []
    const isBridge = tags.length >= 2 ? 1 : 0

    // Also check co-mention diversity: does this person get co-mentioned with many different people?
    const uniqueCoMentioned = (db.prepare(`
      SELECT DISTINCT json_each.value
      FROM channel_f_person_mentions, json_each(co_mentioned)
      WHERE channel_f_person_mentions.user_id = ? AND channel_f_person_mentions.person_name = ?
        AND co_mentioned IS NOT NULL AND co_mentioned != '[]'
    `).all(userId, profile.person_name) as any[]).length

    const finalBridge = (isBridge || uniqueCoMentioned >= 3) ? 1 : 0
    db.prepare(`UPDATE channel_f_relationship_profiles SET is_bridge = ? WHERE user_id = ? AND person_name = ?`)
      .run(finalBridge, userId, profile.person_name)
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function trackMessage(userId: string, sessionId: string | null, message: string): void {
  try {
    const mentions = extractMentions(message)
    if (mentions.length === 0) return

    const coMentionMap = extractCoMentionMap(mentions)

    for (const mention of mentions) {
      const { personName, contextExcerpt, tone, referenceStyle } = mention
      const coMentioned = coMentionMap[personName] ?? []

      // Insert raw mention log
      db.prepare(`
        INSERT INTO channel_f_person_mentions
          (id, user_id, session_id, person_name, mention_context, context_tone, reference_style, co_mentioned, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(uuid(), userId, sessionId, personName, contextExcerpt, tone, referenceStyle, j(coMentioned))

      // Upsert relationship profile
      const existing = db.prepare(
        `SELECT id, mention_count, recent_tones, reference_style_counts FROM channel_f_relationship_profiles WHERE user_id = ? AND person_name = ?`
      ).get(userId, personName) as any

      if (existing) {
        const recentTones: Tone[] = p(existing.recent_tones) ?? []
        recentTones.unshift(tone)
        if (recentTones.length > 5) recentTones.pop()

        const styleCounts: Record<string, number> = p(existing.reference_style_counts) ?? {}
        styleCounts[referenceStyle] = (styleCounts[referenceStyle] ?? 0) + 1

        const clusterTags = detectClusters(userId, personName, coMentioned)
        const trajectory = recalcTrajectory(userId, personName)

        db.prepare(`
          UPDATE channel_f_relationship_profiles SET
            last_seen = datetime('now'),
            mention_count = mention_count + 1,
            trajectory = ?,
            recent_tones = ?,
            reference_style_counts = ?,
            cluster_tags = ?,
            last_updated = datetime('now')
          WHERE user_id = ? AND person_name = ?
        `).run(trajectory, j(recentTones), j(styleCounts), j(clusterTags), userId, personName)
      } else {
        const styleCounts: Record<string, number> = { [referenceStyle]: 1 }
        db.prepare(`
          INSERT INTO channel_f_relationship_profiles
            (id, user_id, person_name, first_seen, last_seen, mention_count, trajectory,
             recent_tones, reference_style_counts, cluster_tags, is_bridge, last_updated)
          VALUES (?, ?, ?, datetime('now'), datetime('now'), 1, 'stable', ?, ?, '[]', 0, datetime('now'))
        `).run(uuid(), userId, personName, j([tone]), j(styleCounts))
      }
    }

    // Recheck bridge nodes periodically (fire-and-forget, cheap query)
    detectBridges(userId)

    console.log(`[channel-f] tracked ${mentions.length} mention(s) for user ${userId}: ${mentions.map(m => m.personName).join(', ')}`)
  } catch (err) {
    console.error('[channel-f] track error:', err)
  }
}

// Infer communication register from a user's message when it contains drafting intent
// e.g. "write a message to Tom" or "draft an email to Sarah Chen"
export function inferRegisterFromMessage(userId: string, personName: string, messageText: string): void {
  try {
    const lower = messageText.toLowerCase()
    // Formal signals: "Dear X", "Hope this finds you well", complete sentences, professional sign-offs
    const formalSignals = ['dear ', 'to whom', 'best regards', 'kind regards', 'sincerely', 'per our conversation', 'as discussed']
    const casualSignals = ['hey ', 'hi there', 'yo ', 'lol', 'btw', 'fyi', 'asap', '!', ':)', ':D', 'haha']

    let register: 'formal' | 'semi_formal' | 'casual' | 'personal' = 'semi_formal'
    const formalHits = formalSignals.filter(s => lower.includes(s)).length
    const casualHits = casualSignals.filter(s => lower.includes(s)).length
    if (formalHits >= 2) register = 'formal'
    else if (casualHits >= 2) register = 'casual'
    else if (casualHits >= 1 && formalHits === 0) register = 'personal'

    const existing = db.prepare(
      `SELECT id FROM channel_f_relationship_profiles WHERE user_id = ? AND person_name = ?`
    ).get(userId, personName)
    if (existing) {
      db.prepare(`UPDATE channel_f_relationship_profiles SET communication_register = ? WHERE user_id = ? AND person_name = ?`)
        .run(register, userId, personName)
    }
  } catch (err) {
    console.error('[channel-f] register inference error:', err)
  }
}
