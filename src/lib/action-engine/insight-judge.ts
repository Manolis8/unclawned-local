import { db } from '../db.js'
import { resolveRuntime } from '../model-router.js'
import type { QueuedAction } from './queue.js'

export interface JudgmentResult {
  shouldSurface: boolean
  question: string
}

interface CategoryHistory {
  responses: string[]  // e.g. ['acted on 2025-06-01', 'ignored on 2025-06-08']
  everResponded: boolean
}

function getCategoryHistory(userId: string, category: string): CategoryHistory {
  const rows = db.prepare(`
    SELECT user_response, surfaced_at FROM action_memory
    WHERE user_id = ? AND action_category = ?
    ORDER BY surfaced_at DESC LIMIT 10
  `).all(userId, category) as any[]

  const responses = rows.map((r: any) => `${r.user_response} on ${r.surfaced_at?.slice(0, 10)}`)
  const everResponded = rows.some((r: any) =>
    ['acted', 'dismissed', 'engaged', 'ignored'].includes(r.user_response)
  )
  return { responses, everResponded }
}

function buildUserContext(userId: string, category: string, history: CategoryHistory): string {
  const profile = db.prepare(
    `SELECT key, value FROM user_profile WHERE user_id = ? LIMIT 12`
  ).all(userId) as any[]

  const sessions = db.prepare(`
    SELECT task_prompt FROM agent_sessions
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 6
  `).all(userId) as any[]

  const profileStr = profile.length
    ? profile.map((r: any) => `${r.key}: ${r.value}`).join('\n')
    : 'No profile yet'

  const sessionsStr = sessions.length
    ? sessions.map((r: any) => `- ${r.task_prompt}`).join('\n')
    : 'No recent sessions'

  const historyStr = history.responses.length
    ? history.responses.join(', ')
    : 'Never surfaced before'

  return `User profile:\n${profileStr}\n\nRecent tasks (newest first):\n${sessionsStr}\n\nPrior responses to this category: ${historyStr}`
}

// Calls LLM to decide whether the insight is genuinely worth surfacing right now,
// and if so, generates a fresh contextual question instead of the hardcoded one.
// Falls back to { shouldSurface: true, question: original } on any LLM error.
export async function generateInsightQuestion(
  userId: string,
  action: QueuedAction
): Promise<JudgmentResult> {
  const fallback: JudgmentResult = {
    shouldSurface: true,
    question: action.question_text || '',
  }
  try {
    const rt = resolveRuntime()
    const history = getCategoryHistory(userId, action.action_category)
    const userContext = buildUserContext(userId, action.action_category, history)

    let evidenceStr = ''
    try {
      const ev = JSON.parse(action.evidence || '{}')
      const obs: string[] = ev.observations ?? []
      evidenceStr = obs.length ? obs.join('\n') : action.evidence || ''
    } catch { evidenceStr = action.evidence || '' }

    // Hard block: user has already responded to this category → don't surface unless new data
    const alreadySeenNote = history.everResponded
      ? `\nCRITICAL: The user has already responded to this category before (see history above). Do NOT surface again unless the evidence shows a clearly different or significantly more extreme pattern than what was previously surfaced. When in doubt, return should_surface: false.`
      : ''

    const system = `You are a perceptive AI assistant deciding whether to surface a behavioral observation to the user and, if yes, what single question to ask.

Be very selective. Only say "should_surface": true when ALL of these hold:
- The pattern is real and significant, not a minor or obvious trend
- It's actionable right now given what the user has been doing
- The user has not already acknowledged, skipped, or addressed it in a prior session${alreadySeenNote}

If you do surface it, write one short conversational question — not a therapist, not a coach, just a perceptive friend who noticed something. Avoid jargon. Max 20 words.

Respond ONLY in valid JSON, no other text:
{ "should_surface": true, "question": "your question here" }
{ "should_surface": false, "question": "" }`

    const userMsg = `${userContext}

Detected pattern [${action.action_category}]:
${action.insight_text}

Evidence signals:
${evidenceStr || '(none)'}

Should I bring this up?`

    const res = await rt.fastClient.chat.completions.create({
      model: rt.modelFor('low'),
      max_tokens: 80,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
    })

    const text = res.choices[0].message.content?.trim() || ''
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim()
    const parsed = JSON.parse(cleaned)

    return {
      shouldSurface: !!parsed.should_surface,
      question: (parsed.question as string) || fallback.question,
    }
  } catch {
    return fallback
  }
}
