import { resolveRuntime } from './model-router.js'
import { createSkillDraft, hasPendingDraftForTask } from '../db/queries.js'
import { searchSkillsForTask } from './skill-index.js'

export interface ToolCallEntry {
  name: string
  args: Record<string, any>
}

// Keys to include per tool — keeps transcript compact and avoids dumping HTML snapshots
const COMPACT_KEYS: Record<string, string[]> = {
  browser_navigate: ['url'],
  browser_type: ['ref', 'text'],
  browser_click: ['ref'],
  browser_select: ['ref', 'option'],
  browser_key: ['ref', 'key'],
  browser_hover: ['ref'],
  browser_scroll_to_ref: ['ref'],
  browser_dismiss_cookie: [],
  browser_wait: ['duration'],
  browser_evaluate: ['script'],
  browser_switch_tab: ['tab_id'],
  web_search: ['query'],
  web_extract: ['urls'],
  perceive_page: [],
  browser_snapshot: [],
  read_page_content: [],
  scroll_and_read: ['action'],
  go_back: [],
}

function buildTranscript(toolCalls: ToolCallEntry[]): string {
  return toolCalls
    .filter(tc => tc.name !== 'task_complete' && tc.name !== 'task_failed')
    .map((tc, i) => {
      const allowedKeys = COMPACT_KEYS[tc.name]
      let argStr = ''
      if (allowedKeys === undefined) {
        argStr = Object.entries(tc.args).slice(0, 3).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 80)}`).join(', ')
      } else if (allowedKeys.length > 0) {
        argStr = allowedKeys
          .filter(k => tc.args[k] !== undefined)
          .map(k => `${k}=${JSON.stringify(tc.args[k]).slice(0, 100)}`)
          .join(', ')
      }
      return `${i + 1}. ${tc.name}(${argStr})`
    })
    .join('\n')
}

async function analyzeIfWorthDrafting(
  taskPrompt: string,
  toolCallCount: number,
  transcript: string
): Promise<{ isGoodSkill: boolean; name: string; description: string; skillType: 'browser' | 'chat' | 'hybrid' }> {
  const rt = resolveRuntime()
  const res = await rt.fastClient.chat.completions.create({
    model: rt.modelFor('low'),
    max_tokens: 200,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Decide if this completed AI task should become a reusable skill draft.

Good candidates: repeatable workflows on real websites, could run again with minor variations (different search term, date, keyword), has clear navigation steps.
Bad candidates: one-off tasks (specific person/exact date), purely conversational, trivially simple (1-2 steps), results-only tasks with no automation.

Return JSON: { "isGoodSkill": true|false, "name": "hyphenated-lowercase-max-5-words", "description": "one sentence under 100 chars", "skillType": "browser"|"chat"|"hybrid" }
If isGoodSkill is false, name/description can be empty strings.`,
      },
      {
        role: 'user',
        content: `Task: "${taskPrompt}"\nTool calls: ${toolCallCount}\nFirst steps:\n${transcript.slice(0, 600)}`,
      },
    ],
  })

  try {
    const parsed = JSON.parse(res.choices[0].message.content || '{}')
    return {
      isGoodSkill: Boolean(parsed.isGoodSkill),
      name: (parsed.name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''),
      description: (parsed.description || '').trim().slice(0, 200),
      skillType: ['browser', 'chat', 'hybrid'].includes(parsed.skillType) ? parsed.skillType as 'browser' | 'chat' | 'hybrid' : 'browser',
    }
  } catch {
    return { isGoodSkill: false, name: '', description: '', skillType: 'browser' }
  }
}

async function extractExecutionPlan(
  taskPrompt: string,
  name: string,
  description: string,
  transcript: string
): Promise<any | null> {
  const rt = resolveRuntime()
  const res = await rt.client.chat.completions.create({
    model: rt.modelFor('medium'),
    max_tokens: 1500,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Extract a reusable skill execution plan from an AI task transcript.

The transcript is a numbered list of tool calls. Convert it into structured steps another agent can follow.

Rules:
- Describe the intent of each step, not the raw element ref (eN refs change between runs)
- Group 2-3 related tool calls into one logical step where sensible
- For selectors prefer descriptive ones: getByRole('button', {name: 'Search'}), getByPlaceholder('Search')
- Identify which values are variables (search terms, dates) vs hardcoded (site URLs, fixed UI paths)
- Include the starting URL

Return JSON:
{
  "strategy": "One paragraph describing the overall approach",
  "steps": [
    {
      "number": 1,
      "description": "Human-readable step description",
      "action_type": "navigate|type|click|select|wait|snapshot|read|extract",
      "url": "https://...",
      "selectors": ["selector1"],
      "value": "{{variable_name}} or fixed text",
      "notes": "What to watch for or fallback"
    }
  ],
  "variables": [
    { "name": "variable_name", "description": "what it represents", "example": "example value" }
  ]
}`,
      },
      {
        role: 'user',
        content: `Skill: "${name}"\nDescription: "${description}"\nOriginal task: "${taskPrompt}"\n\nTool call transcript:\n${transcript}`,
      },
    ],
  })

  try {
    const parsed = JSON.parse(res.choices[0].message.content || '{}')
    if (!parsed.steps || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null
    return parsed
  } catch {
    return null
  }
}

// Fire-and-forget — called from runAgentWithExtension after successful browser tasks
export async function extractSkillDraftAsync(
  userId: string,
  taskPrompt: string,
  toolCallLog: ToolCallEntry[],
  toolCallCount: number
): Promise<void> {
  try {
    if (hasPendingDraftForTask(userId, taskPrompt)) return

    const existing = await searchSkillsForTask(userId, taskPrompt)
    if (existing.length > 0 && existing[0].relevance_score >= 0.7) return

    const transcript = buildTranscript(toolCallLog)
    if (!transcript) return

    const analysis = await analyzeIfWorthDrafting(taskPrompt, toolCallCount, transcript)
    if (!analysis.isGoodSkill || !analysis.name || !analysis.description) return

    const plan = await extractExecutionPlan(taskPrompt, analysis.name, analysis.description, transcript)
    if (!plan) return

    createSkillDraft({
      user_id: userId,
      draft_name: analysis.name,
      draft_description: analysis.description,
      skill_type: analysis.skillType,
      execution_plan: plan,
      source_task: taskPrompt,
      tool_call_count: toolCallCount,
    })

    console.log(`[skill-draft] Draft staged "${analysis.name}" for user ${userId}`)
  } catch (err) {
    console.warn('[skill-draft] Extraction failed (non-fatal):', (err as Error).message)
  }
}
