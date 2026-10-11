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

const TYPE_LABELS: Record<string, string> = {
  email: 'emails',
  post: 'posts',
  analysis: 'analyses',
  message: 'messages',
  plan: 'plans',
  proposal: 'proposals',
}

export function buildChannelHContextBlock(userId: string): string | null {
  try {
    const profile = db.prepare(`SELECT * FROM channel_h_profiles WHERE user_id = ?`).get(userId) as any
    if (!profile || profile.total_indexed < 3) return null

    const lines: string[] = ['## Output Intelligence']
    let hasSomething = false

    // H.1 — Evergreen topics
    const evergreen: string[] = p(profile.evergreen_topics) ?? []
    if (evergreen.length > 0) {
      const labels = evergreen.slice(0, 5).map((t: string) => TOPIC_LABELS[t] ?? t)
      lines.push(`**Your most common work topics:** ${labels.join(', ')}`)
      hasSomething = true
    }

    // H.1 — Quality benchmark: which types land first draft vs need revision
    const hitRates: Record<string, { hits: number; misses: number }> = p(profile.hit_rate_by_type) ?? {}
    const typeSummaries: string[] = []
    for (const [type, counts] of Object.entries(hitRates)) {
      const total = counts.hits + counts.misses
      if (total < 3) continue
      const hitPct = counts.hits / total
      const label = TYPE_LABELS[type] ?? type
      if (hitPct >= 0.7) typeSummaries.push(`${label} (land well)`)
      else if (hitPct <= 0.4) typeSummaries.push(`${label} (often need revision)`)
    }
    if (typeSummaries.length > 0) {
      lines.push(`**Draft quality patterns:** ${typeSummaries.join('; ')}`)
      hasSomething = true
    }

    // H.1 — Vocabulary evolution: drift between earliest and latest month
    const vocabEvol: Array<{ month: string; topWords: string[] }> = p(profile.vocabulary_evolution) ?? []
    if (vocabEvol.length >= 3) {
      const earliest = vocabEvol[0]
      const latest = vocabEvol[vocabEvol.length - 1]
      const dropped = earliest.topWords.filter(w => !latest.topWords.includes(w)).slice(0, 3)
      const gained = latest.topWords.filter(w => !earliest.topWords.includes(w)).slice(0, 3)
      if (dropped.length > 0 && gained.length > 0) {
        lines.push(`**Vocabulary drift (${earliest.month} → ${latest.month}):** writing shifted from [${dropped.join(', ')}] toward [${gained.join(', ')}]`)
        hasSomething = true
      }
    }

    // H.2 — Recent outcome signals
    const recentOutcomes = db.prepare(`
      SELECT outcome_sentiment, outcome_context, content_type, created_at
      FROM channel_h_corpus_items
      WHERE user_id = ? AND outcome_sentiment IS NOT NULL
      ORDER BY rowid DESC LIMIT 3
    `).all(userId) as any[]

    if (recentOutcomes.length > 0) {
      const pos = recentOutcomes.filter(o => o.outcome_sentiment === 'positive').length
      const neg = recentOutcomes.filter(o => o.outcome_sentiment === 'negative').length
      if (pos > neg) lines.push(`**Recent output outcomes:** mostly positive (${pos} of last ${recentOutcomes.length})`)
      else if (neg > pos) lines.push(`**Recent output outcomes:** mostly negative feedback (${neg} of last ${recentOutcomes.length})`)

      // Surface latest outcome context for agent awareness
      const latest = recentOutcomes[0]
      if (latest.outcome_context) {
        const typeLabel = TYPE_LABELS[latest.content_type] ?? latest.content_type
        lines.push(`**Latest feedback on ${typeLabel}:** "${latest.outcome_context.slice(0, 100)}"`)
      }
      hasSomething = true
    }

    if (!hasSomething) return null
    lines.push(`_(${profile.total_indexed} outputs indexed)_`)
    return lines.join('\n')
  } catch {
    return null
  }
}
