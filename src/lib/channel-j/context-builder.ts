import { db } from '../db.js'

const SOURCE_FRAMING: Record<string, string> = {
  academic:        'Back claims with original research (papers, studies) rather than summaries. This user trusts primary sources and is skeptical of paraphrasing.',
  industry_report: 'Cite authoritative institutions (McKinsey, a16z, Gartner, etc.) when relevant. This user trusts institutional rigor.',
  newsletter:      'Reference curated voices and specific thinkers. This user values expert curation over raw search results.',
  twitter:         'Lead with what\'s happening now — recency matters more than depth. This user values current signal over comprehensive coverage.',
  long_form:       'This user is willing to go deep. Don\'t truncate the reasoning — give the full analysis when it matters.',
  podcast:         'Frame information conversationally. This user absorbs ideas through dialogue and discussion, not bullet lists.',
  data_stats:      'Lead with numbers and evidence. This user needs quantitative proof before trusting a claim — cite figures specifically.',
  personal_blog:   'Use practitioner experience over institutional citations. This user trusts founder stories and first-hand accounts over official reports.',
  news:            'Ground in current events and recent developments. This user tracks what\'s happening now — timeliness matters.',
}

export function buildChannelJContextBlock(userId: string): string | null {
  try {
    const profile = db.prepare(`SELECT * FROM channel_j_profiles WHERE user_id = ?`).get(userId) as any
    if (!profile || profile.total_signals < 5) return null

    const lines: string[] = ['## Information Diet Intelligence']
    let hasSomething = false

    // J.1 — source authority
    const src: string | null = profile.dominant_source_type
    if (src && SOURCE_FRAMING[src]) {
      lines.push(`**Evidence style:** ${SOURCE_FRAMING[src]}`)
      hasSomething = true
    }

    // J.2 — depth preference
    const depth: string = profile.depth_preference ?? 'unknown'
    if (depth === 'low') {
      lines.push(`**Content depth:** This user prefers brevity — lead with the answer, skip the preamble. They\'ll ask if they want more detail.`)
      hasSomething = true
    } else if (depth === 'high') {
      lines.push(`**Content depth:** This user wants the nuance. Give the full reasoning and don\'t compress. Surface-level answers frustrate them.`)
      hasSomething = true
    }

    // J.3 — consumption/production ratio
    const ratio: number = profile.consumption_ratio ?? 0.5
    if (ratio >= 0.7) {
      lines.push(`**Work mode:** Primarily a consumer — gathers information before deciding. Curate and synthesize is their dominant mode.`)
      hasSomething = true
    } else if (ratio <= 0.3) {
      lines.push(`**Work mode:** Primarily a producer — writes and creates constantly. Writing assistance and drafting is their highest-ROI use of the agent.`)
      hasSomething = true
    }

    // J.4 — information anxiety
    const anxietyCount: number = profile.info_anxiety_count ?? 0
    if (anxietyCount >= 3) {
      lines.push(`**Information anxiety detected:** This user seeks reassurance through additional lookups. Respond with confidence: affirm when the sources are consistent and they have what they need to decide. Don\'t pile on more data.`)
      hasSomething = true
    }

    if (!hasSomething) return null
    return lines.join('\n')
  } catch {
    return null
  }
}
