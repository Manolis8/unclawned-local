import { db } from '../db.js'

export function buildChannelKContextBlock(userId: string): string | null {
  try {
    const profile = db.prepare(`SELECT * FROM channel_k_profiles WHERE user_id = ?`).get(userId) as any
    if (!profile || profile.total_messages < 5) return null

    const lines: string[] = ['## Cognitive State Intelligence']
    let hasSomething = false

    // K.1 — cognitive load: count overload signals in last 30 min
    const overloadCount = (db.prepare(`
      SELECT COUNT(*) AS cnt FROM channel_k_signals
      WHERE user_id = ? AND signal_type = 'overload'
      AND created_at >= datetime('now', '-30 minutes')
    `).get(userId) as any)?.cnt ?? 0

    if (overloadCount >= 3) {
      lines.push(`**⚠ HIGH COGNITIVE LOAD (${overloadCount} signals active):** Keep output short and direct. Give ONE answer — no options list, no "you might also consider." Answer first, reasoning optional. Reduce everything to the minimum viable response.`)
      hasSomething = true
    } else if (overloadCount >= 1) {
      lines.push(`**Elevated load signals:** Lean toward brevity. One clear recommendation where possible.`)
      hasSomething = true
    }

    // K.2 — energy state
    const energy: string = profile.energy_state ?? 'unknown'
    if (energy === 'depleted') {
      lines.push(`**Energy: depleted** — Match pace. One-sentence answers where possible. Avoid multi-part outputs. Don't offer follow-up options unless asked.`)
      hasSomething = true
    } else if (energy === 'low') {
      lines.push(`**Energy: low** — Be concise. Lead with the answer. Save context and elaboration for when they ask.`)
      hasSomething = true
    } else if (energy === 'high') {
      lines.push(`**Energy: high** — User is engaged and in depth-mode. Full analysis is welcome.`)
      hasSomething = true
    }

    // K.3 — confidence level
    const confidence: string = profile.confidence_level ?? 'normal'
    if (confidence === 'low') {
      lines.push(`**Confidence: low** — User is second-guessing outputs. Before proposing something new, validate what's already been established. Anchor to what's working, then offer one refinement at most.`)
      hasSomething = true
    } else if (confidence === 'uncertain') {
      lines.push(`**Confidence: shaky** — One or more second-guessing signals recently. Keep the frame steady — avoid introducing new unknowns.`)
      hasSomething = true
    }

    // K.4 — active assumption signals (last 10 minutes)
    const recentAssumptions = (db.prepare(`
      SELECT message_preview FROM channel_k_signals
      WHERE user_id = ? AND signal_type = 'assumption'
      AND created_at >= datetime('now', '-10 minutes')
      ORDER BY created_at DESC LIMIT 1
    `).get(userId) as any)

    if (recentAssumptions) {
      lines.push(`**Assumption in prompt:** This request carries an embedded assumption (e.g. that persuasion is the right approach, or that a single decision-maker exists). Verify the premise quietly before acting — surface the issue only if it materially changes the task.`)
      hasSomething = true
    }

    if (!hasSomething) return null
    return lines.join('\n')
  } catch {
    return null
  }
}
