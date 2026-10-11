import { resolveRuntime } from './model-router.js'
import {
  createSkillSuggestion,
  hasPendingSuggestionForTask,
} from '../db/queries.js'
import { searchSkillsForTask } from './skill-index.js'

interface SuggestionAnalysis {
  isGoodSkill: boolean
  name: string
  description: string
  skillType: 'browser' | 'chat' | 'hybrid'
  reason: string
}

async function analyzeForSkillSuggestion(
  taskPrompt: string,
  toolCallCount: number
): Promise<SuggestionAnalysis> {
  const rt = resolveRuntime()
  const res = await rt.fastClient.chat.completions.create({
    model: rt.modelFor('low'),
    max_tokens: 200,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You decide whether a completed AI task should be saved as a reusable skill.

A task is a GOOD skill candidate if:
- It describes a repeatable workflow (not one-off)
- It involves a real website or service (LinkedIn, Google, GitHub, Twitter, etc.)
- It could be run again by the same user with minor variations (different search term, different date, etc.)
- It completed successfully with multiple steps

A task is NOT a good skill candidate if:
- It names a specific person, exact date, or one-time event
- It is purely conversational / reasoning (no browser automation)
- It is trivially simple (1-2 steps, e.g. "open google.com")
- It already sounds like a specific task result rather than a repeatable workflow

Return JSON:
{
  "isGoodSkill": true|false,
  "name": "hyphenated-lowercase-name-max-5-words",
  "description": "One sentence, under 100 chars, describes the repeatable workflow",
  "skillType": "browser"|"chat"|"hybrid",
  "reason": "One sentence why"
}

If isGoodSkill is false, name/description can be empty strings.`,
      },
      {
        role: 'user',
        content: `Task: "${taskPrompt}"\nTool calls made: ${toolCallCount}`,
      },
    ],
  })

  try {
    const parsed = JSON.parse(res.choices[0].message.content || '{}')
    return {
      isGoodSkill: Boolean(parsed.isGoodSkill),
      name: (parsed.name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''),
      description: (parsed.description || '').trim().slice(0, 200),
      skillType: ['browser', 'chat', 'hybrid'].includes(parsed.skillType) ? parsed.skillType : 'browser',
      reason: parsed.reason || '',
    }
  } catch {
    return { isGoodSkill: false, name: '', description: '', skillType: 'browser', reason: '' }
  }
}

// Fire-and-forget wrapper — called from runAgentWithExtension after successful tasks
export async function analyzeForSkillSuggestionAsync(
  userId: string,
  taskPrompt: string,
  toolCallCount: number
): Promise<void> {
  try {
    // Skip if we already have a pending suggestion for this same task
    if (hasPendingSuggestionForTask(userId, taskPrompt)) return

    // Skip if an existing skill already covers this task type
    const existing = await searchSkillsForTask(userId, taskPrompt)
    if (existing.length > 0 && existing[0].relevance_score >= 0.7) return

    const analysis = await analyzeForSkillSuggestion(taskPrompt, toolCallCount)
    if (!analysis.isGoodSkill || !analysis.name || !analysis.description) return

    createSkillSuggestion({
      user_id: userId,
      suggested_name: analysis.name,
      suggested_description: analysis.description,
      skill_type: analysis.skillType,
      source_task: taskPrompt,
      tool_call_count: toolCallCount,
    })

    console.log(`[skill-suggestion] Staged suggestion "${analysis.name}" for user ${userId}`)
  } catch (err) {
    // Never crash the main flow
    console.warn('[skill-suggestion] Analysis failed (non-fatal):', (err as Error).message)
  }
}
