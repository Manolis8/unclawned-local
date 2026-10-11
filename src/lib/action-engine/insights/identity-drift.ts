import { db } from '../../db.js'
import { enqueueInsight } from '../queue.js'

// Most sensitive compound — requires all 3 channels to agree on the same shift direction

export function detectIdentityDrift(userId: string): void {
  try {
    // Channel M: vocabulary drift direction
    const mProfile = db.prepare(`
      SELECT drift_direction, total_distinct_words FROM channel_m_profiles WHERE user_id = ?
    `).get(userId) as any
    if (!mProfile?.drift_direction || (mProfile.total_distinct_words ?? 0) < 20) return

    // Channel A: established vocabulary tribe (their professional identity baseline)
    const aProfile = db.prepare(`
      SELECT vocabulary_tribe, total_samples FROM channel_a_profiles WHERE user_id = ?
    `).get(userId) as any
    if (!aProfile || (aProfile.total_samples ?? 0) < 10) return

    let tribe: any = {}
    try { tribe = JSON.parse(aProfile.vocabulary_tribe || '{}') } catch {}
    if (!tribe.primary_tribe) return

    // Channel E: feed content drift
    const eProfile = db.prepare(`
      SELECT dominant_topics, drift_signal, total_feed_visits FROM channel_e_profiles WHERE user_id = ?
    `).get(userId) as any
    if (!eProfile || (eProfile.total_feed_visits ?? 0) < 5) return

    let dominantTopics: string[] = []
    try { dominantTopics = JSON.parse(eProfile.dominant_topics || '[]') } catch {}
    if (!dominantTopics.length) return

    const drift = mProfile.drift_direction.toLowerCase()
    const currentTribe = tribe.primary_tribe.toLowerCase()
    const feedTopic = dominantTopics[0].toLowerCase()

    const driftWords = drift.split(/[\s,_-]+/).filter((w: string) => w.length > 3)
    const tribeWords = currentTribe.split(/[\s,_-]+/).filter((w: string) => w.length > 3)
    const feedWords = feedTopic.split(/[\s,_-]+/).filter((w: string) => w.length > 3)

    // Vocab drift and feed content must point in the same new direction
    const driftFeedOverlap = driftWords.some((w: string) =>
      feedWords.some((f: string) => f.includes(w) || w.includes(f))
    )
    // And that direction must be away from the established tribe
    const driftInTribe = driftWords.some((w: string) =>
      tribeWords.some((t: string) => t.includes(w) || w.includes(t))
    )

    if (!driftFeedOverlap || driftInTribe) return

    const feedSignal = eProfile.drift_signal || 'shifting'

    const insightText = `Your vocabulary has been drifting toward "${mProfile.drift_direction}" and your feed content aligns — a different direction from your established "${tribe.primary_tribe}" identity. Both channels are pointing the same way.`
    const questionText = `Does this reflect a deliberate shift you're making professionally?`

    const evidence = {
      channels: ['channel_m', 'channel_a', 'channel_e'],
      drift_direction: mProfile.drift_direction,
      established_tribe: tribe.primary_tribe,
      feed_topic: dominantTopics[0],
      feed_signal: feedSignal,
      observations: [
        `Vocabulary drift: toward "${mProfile.drift_direction}"`,
        `Established identity: "${tribe.primary_tribe}" (${aProfile.total_samples} samples)`,
        `Feed content: "${dominantTopics[0]}" (signal: ${feedSignal})`,
      ]
    }

    // High value, lower confidence — this is a big claim. Timing fit enforces review-window-only.
    enqueueInsight(
      userId, 'identity_drift', insightText, questionText, evidence,
      8.0, 0.60, 4.0, 'compound'
    )
  } catch {}
}
