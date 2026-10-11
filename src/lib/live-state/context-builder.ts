import { db } from '../db.js'

export function buildLiveStateContextBlock(userId: string): string | null {
  try {
    const state = db.prepare(`SELECT * FROM live_state WHERE user_id = ?`).get(userId) as any
    if (!state) return null

    const parts: string[] = []

    if (state.session_intent === 'repair') {
      parts.push('Session mode: REPAIR — something went wrong. Fix it directly, no new ideas or options unless asked.')
    } else if (state.session_intent === 'review') {
      parts.push('Session mode: REVIEW — critical eye, not generative. Surface problems first. Don\'t generate new content unless explicitly asked.')
    } else if (state.session_intent === 'exploration') {
      parts.push('Session mode: EXPLORATION — user is thinking through options. Offer frameworks, present alternatives, ask one clarifying question if useful.')
    }

    if (state.emotional_temperature === 'negative') {
      parts.push('Emotional state: negative (multiple frustration signals in last 24h). One direct answer — no options lists, no preamble.')
    } else if (state.emotional_temperature === 'muted') {
      parts.push('Emotional state: muted. Lead with results, keep framing grounded.')
    }

    if (state.current_focus_topic) {
      parts.push(`Active topic focus: ${state.current_focus_topic} — pre-load relevant context for this domain when composing responses.`)
    }

    if (state.relationship_context) {
      parts.push(`Active relationship thread this session: ${state.relationship_context} — maintain consistency with prior context about this person.`)
    }

    if (parts.length === 0) return null
    return `[Live Session State]\n${parts.join('\n')}`
  } catch { return null }
}
