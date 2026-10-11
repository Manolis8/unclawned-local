import { getEffectiveSoul } from '../soul.js'
import { resolveRuntime } from '../model-router.js'

export async function chatAgent(
  userMessage: string,
  userMd?: string,
  writingSamples?: string,
  channelAContext?: string,
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>,
  signal?: AbortSignal
): Promise<{ response: string }> {
  const soul = getEffectiveSoul()

  const now = new Date()
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const dateTimeLine = `[Current date and time: ${dateStr}, ${timeStr}]`

  let systemPrompt: string
  if (userMd) {
    systemPrompt = `${dateTimeLine}\n\n${soul}

## Who you're working for (profile defaults — overridden by any explicit task instruction)
${userMd}${writingSamples ? `\n\n## Your voice anchors — real writing samples from this user\nRead these before writing anything on their behalf. Match this voice exactly.\n\n${writingSamples}` : ''}`
  } else {
    systemPrompt = `${dateTimeLine}\n\n${soul}`
  }

  if (channelAContext) {
    systemPrompt += `\n\n${channelAContext}`
  }

  // Token-aware history trim (Hermes preflight concept, simplified).
  // Estimate: 4 chars ≈ 1 token. Keep a safe budget so we never exceed the model's context.
  // We drop the oldest exchange pairs (user+assistant) until it fits — no LLM call needed.
  const CHARS_PER_TOKEN = 4
  const CONTEXT_LIMIT_TOKENS = 60_000  // conservative safe floor across all medium-tier models
  const RESPONSE_BUDGET = 1024
  const sysTokens  = Math.ceil(systemPrompt.length / CHARS_PER_TOKEN)
  const taskTokens = Math.ceil(userMessage.length / CHARS_PER_TOKEN)
  const available  = CONTEXT_LIMIT_TOKENS - sysTokens - taskTokens - RESPONSE_BUDGET

  let history = [...(conversationHistory ?? [])]
  // Drop oldest exchange pairs until history fits within available tokens
  while (history.length >= 2) {
    const histTokens = history.reduce((s, m) => s + Math.ceil(m.content.length / CHARS_PER_TOKEN), 0)
    if (histTokens <= available) break
    history = history.slice(2) // drop oldest user + assistant pair
  }

  // Hermes-style two-list pattern: build api_messages as a copy with trimmed history prepended.
  // The original conversationHistory is never mutated here.
  const apiMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ]

  const rt = resolveRuntime()
  const response = await rt.fastClient.chat.completions.create(
    { model: rt.modelFor('medium'), max_tokens: 1024, messages: apiMessages as any },
    signal ? { signal } : undefined
  )

  return {
    response: response.choices[0].message.content || ''
  }
}
