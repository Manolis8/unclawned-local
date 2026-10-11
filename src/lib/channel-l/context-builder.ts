import { db } from '../db.js'

function p(s: string) { try { return JSON.parse(s) } catch { return null } }

export function buildChannelLContextBlock(userId: string): string | null {
  const profile = db.prepare(`SELECT * FROM channel_l_profiles WHERE user_id = ?`).get(userId) as any
  if (!profile) return null
  if (profile.total_signals < 5) return null

  const lines: string[] = ['[Channel L — Resistance & Avoidance]']

  const {
    dominant_resistance,
    factual_resistance_count,
    framing_resistance_count,
    scope_resistance_count,
    strategic_resistance_count,
    blind_spot_domains: blindSpotRaw,
    priority_avoidance_count,
    emotional_avoidance_count,
    skill_avoidance_count,
    capability_avoidance_count,
    identity_avoidance_count,
    kept_work_categories: keptRaw,
    kept_work_offer_made: offerRaw,
  } = profile

  const blindSpots: string[] = p(blindSpotRaw ?? '[]') ?? []
  const keptCategories: string[] = p(keptRaw ?? '[]') ?? []
  const offerMade: Record<string, boolean> = p(offerRaw ?? '{}') ?? {}

  // L.1 Resistance framing
  if (dominant_resistance === 'framing' && framing_resistance_count >= 2) {
    lines.push('Framing resistance: this user frequently pushes back on how things are framed. Pick your words carefully — match their worldview before correcting it.')
  } else if (dominant_resistance === 'factual' && factual_resistance_count >= 2) {
    lines.push('Factual resistance: this user has corrected factual errors multiple times. Double-check any specific claims before stating them.')
  } else if (dominant_resistance === 'scope' && scope_resistance_count >= 2) {
    lines.push('Scope resistance: this user consistently signals miscalibration on depth. Read the task carefully — match depth to what was asked, not what seems complete.')
  } else if (dominant_resistance === 'strategic' && strategic_resistance_count >= 2) {
    lines.push('Strategic resistance: this user has pushed back on direction multiple times. Surface assumptions before committing to an approach; ask about constraints when the goal is ambiguous.')
  }

  // L.1 Blind spot domains
  for (const domain of blindSpots) {
    lines.push(`Known blind spot — ${domain}: 3+ strategic misreads in this domain. State your assumptions explicitly before recommending anything here.`)
  }

  // L.2 Avoidance patterns
  if (emotional_avoidance_count >= 2) {
    lines.push('Emotional avoidance pattern: this user avoids emotionally charged tasks (difficult conversations, rejections, bad news). Approach these with care — offer a softer first draft and check the emotional context before diving in.')
  }
  if (priority_avoidance_count >= 2) {
    lines.push('Priority avoidance: this user repeatedly defers certain tasks that feel important but not urgent. If a task matches this pattern, consider offering to break it into smaller steps rather than returning the whole thing at once.')
  }
  if (skill_avoidance_count >= 2) {
    lines.push('Skill avoidance: this user often signals they don\'t know how to approach certain task types. Offer to lead more actively — don\'t just execute, guide.')
  }
  if (capability_avoidance_count >= 2) {
    lines.push('Capability avoidance: this user actively dislikes certain task types. High automation opportunity — take full ownership without requiring much back-and-forth.')
  }
  if (identity_avoidance_count >= 1) {
    lines.push('Identity avoidance detected: don\'t push tasks the user has flagged as "not who I am." If they come to it naturally, don\'t make it a moment.')
  }

  // L.3 Kept work — growth opportunities
  for (const category of keptCategories) {
    if (!offerMade[category]) {
      lines.push(`Growth opportunity: user has handled ${category} tasks themselves multiple times without asking. This is within agent capability — consider offering to take it once.`)
      // Mark as offered so we don't repeat it
      offerMade[category] = true
    }
  }
  if (Object.keys(offerMade).some(k => keptCategories.includes(k) && offerMade[k])) {
    try {
      db.prepare(`UPDATE channel_l_profiles SET kept_work_offer_made = ? WHERE user_id = ?`)
        .run(JSON.stringify(offerMade), userId)
    } catch { /* non-fatal */ }
  }

  if (lines.length === 1) return null
  return lines.join('\n')
}
