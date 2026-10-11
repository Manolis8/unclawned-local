import { db, p } from '../db.js'

const TOPIC_LABELS: Record<string, string> = {
  ai_agents: 'AI & agents',
  startup: 'startup building',
  fundraising: 'fundraising',
  product: 'product development',
  leadership: 'leadership & team',
  growth: 'growth & marketing',
  content: 'content creation',
  engineering: 'engineering',
  career: 'career moves',
  finance: 'finance & operations',
}

export function buildChannelEContextBlock(userId: string): string | null {
  try {
    const profile = db.prepare(
      `SELECT * FROM channel_e_profiles WHERE user_id = ?`
    ).get(userId) as any
    if (!profile || profile.total_feed_visits < 2) return null

    const lines: string[] = ['## LinkedIn Feed Intelligence']

    const dominant: string[] = p(profile.dominant_topics) ?? []
    if (dominant.length > 0) {
      const labels = dominant.map((t: string) => TOPIC_LABELS[t] ?? t)
      lines.push(`**Feed focus (top topics):** ${labels.join(', ')}`)
    }

    const drift: { toTopic: string; delta: number } | null = p(profile.drift_signal)
    if (drift) {
      const label = TOPIC_LABELS[drift.toTopic] ?? drift.toTopic
      lines.push(`**Trend shift:** Recent visits show a significant increase in ${label} content`)
    }

    const recurring: Array<{ account_name: string; appearance_count: number }> = p(profile.top_recurring_accounts) ?? []
    const frequent = recurring.filter(a => a.appearance_count >= 3).map(a => a.account_name)
    if (frequent.length > 0) {
      lines.push(`**Recurring in feed:** ${frequent.slice(0, 5).join(', ')}`)
    }

    const ownTopics: Record<string, number> = p(profile.own_content_topics) ?? {}
    if (Object.keys(ownTopics).length > 0) {
      const topOwn = Object.entries(ownTopics).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => TOPIC_LABELS[t] ?? t)
      lines.push(`**Your LinkedIn posts focus on:** ${topOwn.join(', ')}`)
    }

    lines.push(`_(based on ${profile.total_feed_visits} LinkedIn feed visits)_`)
    return lines.join('\n')
  } catch {
    return null
  }
}
