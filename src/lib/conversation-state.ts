import { resolveRuntime } from './model-router.js'

const _rt = () => resolveRuntime()

export interface Entity {
  id: string
  type: 'company' | 'person' | 'job' | 'url' | 'product' | 'location' | 'list' | 'other'
  name: string
  url?: string
  details?: string
  turn: number
}

export interface ConversationalState {
  entities: Entity[]
  last_task: string
  last_result: string
  topic: string
  last_tab_id: number
  turn: number
}

export interface ResolutionResult {
  annotated: string
  confidence: number
  intent: 'continuation' | 'pivot' | 'new_task'
  resolved_entities: Entity[]
  clarification_question?: string
}

// Called after every task completes. Extracts named entities and the topic
// from the task + result so the RRE can resolve future references.
export async function extractEntities(
  task: string,
  result: string,
  turn: number
): Promise<{ entities: Entity[]; topic: string }> {
  try {
    const response = await _rt().fastClient.chat.completions.create({
      model: _rt().modelFor('low'),
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `Extract named entities and the conversation topic from a browser task and its result.

Return JSON:
{
  "topic": "one phrase describing the domain (e.g. job search, company research, travel planning)",
  "entities": [
    { "type": "company|person|job|url|product|location|list|other", "name": "...", "url": "...", "details": "one-line summary" }
  ]
}

Rules:
- Only extract specific named things. Skip generic words ("results", "page", "button").
- For a list of results (e.g. 19 jobs), add ONE entity of type "list" summarising what the list contains.
- Max 10 entities.
- url is optional — include only when clearly present in the result.`
        },
        {
          role: 'user',
          content: `Task: ${task}\n\nResult: ${result.slice(0, 1500)}`
        }
      ]
    })

    const parsed = JSON.parse(response.choices[0].message.content || '{}')
    const entities: Entity[] = ((parsed.entities as any[]) || [])
      .filter(e => e.name)
      .slice(0, 10)
      .map((e: any, i: number) => ({
        id: `e${turn}_${i}`,
        type: (e.type || 'other') as Entity['type'],
        name: String(e.name),
        url: e.url || undefined,
        details: e.details || undefined,
        turn,
      }))

    return { entities, topic: parsed.topic || '' }
  } catch {
    return { entities: [], topic: '' }
  }
}

// Runs on every incoming message when a ConversationalState exists.
// Detects pronouns / vague references and resolves them against known entities.
export async function resolveReferences(
  message: string,
  state: ConversationalState
): Promise<ResolutionResult> {
  // Only skip if there's truly nothing to resolve against
  if (!state.entities.length && !state.last_result && !state.last_task) {
    return { annotated: message, confidence: 0, intent: 'new_task', resolved_entities: [] }
  }

  const currentTurn = state.turn
  const entityLines = state.entities
    .map(e =>
      `[id:${e.id} turn:${e.turn}] ${e.type}: "${e.name}"` +
      (e.url ? ` (${e.url})` : '') +
      (e.details ? ` — ${e.details}` : '')
    )
    .join('\n')

  const lastResultSnippet = state.last_result
    ? `\nLast result / drafted content (what the agent just produced):\n"""\n${state.last_result.slice(0, 800)}\n"""`
    : ''

  try {
    const response = await _rt().fastClient.chat.completions.create({
      model: _rt().modelFor('low'),
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You resolve vague references in a browser-agent conversation.

Entities established in recent context (current turn: ${currentTurn}):
${entityLines || '(none)'}

Last task: "${state.last_task}"
Topic: "${state.topic || 'unknown'}"${lastResultSnippet}

For the new user message:
1. Detect any pronouns or demonstratives that point to established context:
   "it", "that", "this", "them", "they", "their", "the company", "the results",
   "the first one", "tell me more", "click on it", "go to their", "what about",
   "publish this", "post this", "send this", "use that"
   — "this" / "that" can also refer to content in the "Last result" section above.
2. Replace each vague reference with what it actually refers to in "annotated".
   e.g. "okay then publish this" → "post on LinkedIn: [the drafted post text from Last result]"
3. Classify intent:
   - "continuation": deepens current task — same entities, same direction
   - "pivot": uses established entities but changes the goal
   - "new_task": no meaningful connection to prior context
4. Set confidence 0–100. Use <70 when resolution is ambiguous.
5. If confidence < 70 AND intent is not new_task, write one targeted clarification question.

Return JSON:
{
  "annotated": "message with references resolved (identical to input if nothing resolved)",
  "confidence": 85,
  "intent": "continuation",
  "resolved_entity_ids": ["e3_0"],
  "clarification_question": null
}`
        },
        { role: 'user', content: message }
      ]
    })

    const parsed = JSON.parse(response.choices[0].message.content || '{}')
    const resolvedIds: string[] = parsed.resolved_entity_ids || []
    const resolvedEntities = state.entities.filter(e => resolvedIds.includes(e.id))

    return {
      annotated: parsed.annotated || message,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      intent: (['continuation', 'pivot', 'new_task'].includes(parsed.intent) ? parsed.intent : 'new_task') as ResolutionResult['intent'],
      resolved_entities: resolvedEntities,
      clarification_question: parsed.clarification_question || undefined,
    }
  } catch {
    return { annotated: message, confidence: 0, intent: 'new_task', resolved_entities: [] }
  }
}

// Builds the context block injected into the agent when continuing from prior context.
export function buildContinuationContext(
  state: ConversationalState,
  resolvedEntities: Entity[]
): string {
  const entityLines = resolvedEntities
    .map(e => `  - ${e.type}: "${e.name}"${e.url ? ` (${e.url})` : ''}${e.details ? ` — ${e.details}` : ''}`)
    .join('\n')

  const lines = [
    '[PREVIOUS CONTEXT]',
    `Topic: ${state.topic}`,
    `Last task: "${state.last_task}"`,
  ]

  if (entityLines) {
    lines.push('Resolved references:')
    lines.push(entityLines)
  }

  if (state.last_result) {
    lines.push(`Last result: ${state.last_result.slice(0, 600)}`)
  }

  lines.push('[Resume from the same browser tab — call perceive_page first to see current state.]')

  return lines.join('\n')
}
