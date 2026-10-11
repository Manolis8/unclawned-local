import { db } from '../db.js'

const DRIFT_INSTRUCTIONS: Record<string, string> = {
  technical:  'Vocabulary is shifting technical. Lead with implementation specifics; less business meta-commentary.',
  business:   'Vocabulary is shifting business/market. Pre-load competitor and positioning context when relevant.',
  financial:  'Financial vocabulary is dominant. User is likely in fundraising or scaling mode — frame outputs accordingly.',
  relational: 'Network-building vocabulary is active. Relationship and partnership framing is high-ROI right now.',
  emotional:  'Elevated emotional vocabulary recently. Check the human context behind tasks; don\'t rush into execution.',
}

export function buildChannelMContextBlock(userId: string): string | null {
  const profile = db.prepare(`SELECT * FROM channel_m_profiles WHERE user_id = ?`).get(userId) as any
  if (!profile) return null
  if ((profile.total_distinct_words ?? 0) < 15) return null

  const lines: string[] = ['[Channel M — Language Evolution]']

  // M.3 Drift direction
  if (profile.drift_direction && DRIFT_INSTRUCTIONS[profile.drift_direction]) {
    lines.push(DRIFT_INSTRUCTIONS[profile.drift_direction])
  }

  // M.1 Arrivals: category or proper-noun words first seen in last 14 days with 3+ count
  const arrivals = db.prepare(`
    SELECT word, total_count, is_proper_noun, category
    FROM channel_m_vocab_summary
    WHERE user_id = ?
      AND (category IS NOT NULL OR is_proper_noun = 1)
      AND first_seen >= datetime('now', '-14 days')
      AND total_count >= 3
    ORDER BY total_count DESC
    LIMIT 6
  `).all(userId) as any[]

  if (arrivals.length > 0) {
    const terms = arrivals.map((r: any) => r.word).join(', ')
    lines.push(`New vocabulary arrived: ${terms}. These may signal a focus shift — surface them when relevant.`)
  }

  // M.2 Departures: category or proper-noun words with 5+ historical count, gone for 30+ days
  const departures = db.prepare(`
    SELECT word
    FROM channel_m_vocab_summary
    WHERE user_id = ?
      AND (category IS NOT NULL OR is_proper_noun = 1)
      AND total_count >= 5
      AND last_seen < datetime('now', '-30 days')
      AND first_seen < datetime('now', '-60 days')
    ORDER BY total_count DESC
    LIMIT 5
  `).all(userId) as any[]

  if (departures.length > 0) {
    const terms = departures.map((r: any) => r.word).join(', ')
    lines.push(`Retired topics (stop surfacing proactively): ${terms}.`)
  }

  if (lines.length === 1) return null
  return lines.join('\n')
}
