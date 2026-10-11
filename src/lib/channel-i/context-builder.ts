import { db, p } from '../db.js'

export function buildChannelIContextBlock(userId: string): string | null {
  try {
    const profile = db.prepare(`SELECT * FROM channel_i_profiles WHERE user_id = ?`).get(userId) as any
    if (!profile || profile.total_signals < 5) return null

    const lines: string[] = ['## Decision Style Intelligence']
    let hasSomething = false

    // I.1 — Dominant decision style
    const style: string | null = profile.dominant_style
    if (style) {
      const styleCounts: Record<string, number> = p(profile.style_counts) ?? {}
      const total = Object.values(styleCounts).reduce((s, n) => s + n, 0)
      const dominantCount = styleCounts[style] ?? 0
      const pct = total > 0 ? Math.round((dominantCount / total) * 100) : 0

      if (style === 'recommendation_seeker') {
        lines.push(`**Decision style:** This user wants clear recommendations — give ONE answer, not a list of options. State your recommendation directly then briefly explain why.`)
      } else if (style === 'options_seeker') {
        lines.push(`**Decision style:** This user prefers options — present 2–3 distinct approaches before asking which to pursue. Never give just one answer when the user is deciding.`)
      } else if (style === 'data_first') {
        lines.push(`**Decision style:** This user wants numbers/data before deciding — lead with metrics and evidence, then offer a recommendation. Skip the "it depends" framing.`)
      } else if (style === 'precedent_based') {
        lines.push(`**Decision style:** This user references past precedent when deciding — surface what was done before if relevant, or note when this situation is novel.`)
      }
      if (pct >= 60) {
        lines.push(`_(${pct}% of decision signals show this pattern)_`)
      }
      hasSomething = true
    }

    // I.2 — Research depth
    const researchDepth: string = profile.research_depth ?? 'unknown'
    const avgResearch: number = profile.avg_research_per_session ?? 0
    if (researchDepth !== 'unknown' && avgResearch > 0) {
      if (researchDepth === 'heavy') {
        lines.push(`**Research depth:** Heavy researcher (avg ${avgResearch.toFixed(1)} lookups before deciding) — proactively surface related data they may not have thought to ask for.`)
      } else if (researchDepth === 'light') {
        lines.push(`**Research depth:** Light researcher (moves fast, trusts intuition) — don't overwhelm with data they didn't ask for.`)
      }
      hasSomething = true
    }

    // I.3 — Reversal rate
    const reversalRate: number = profile.reversal_rate ?? 0
    const totalReversals: number = profile.total_reversals ?? 0
    if (totalReversals >= 3) {
      if (reversalRate >= 0.3) {
        lines.push(`**Direction changes:** High reversal rate (${Math.round(reversalRate * 100)}%) — ask about constraints before committing to an approach; this user changes direction frequently.`)
      } else if (reversalRate <= 0.05) {
        lines.push(`**Direction changes:** Very decisive — once a path is chosen, they stick with it. Commit fully when they decide.`)
      }
      hasSomething = true
    }

    // I.4 — Approval seeking
    const approvalRate: number = profile.approval_rate ?? 0
    if (approvalRate >= 0.15 && profile.total_signals >= 8) {
      lines.push(`**Validation pattern:** Often seeks confirmation ("does this make sense?") — respond with grounded validation + one specific concern, not a full counter-argument.`)
      hasSomething = true
    }

    if (!hasSomething) return null
    return lines.join('\n')
  } catch {
    return null
  }
}
