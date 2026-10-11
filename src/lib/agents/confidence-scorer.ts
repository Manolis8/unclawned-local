import { resolveRuntime } from '../model-router.js'

export interface ConfidenceScore {
  overall: number
  intent: number
  scope: number
  target: number
  action: number
  gaps: string[]
  reason: string
}

export async function scoreConfidence(userMessage: string, userMd?: string): Promise<ConfidenceScore> {
  try {
    const rt = resolveRuntime()
    const response = await rt.fastClient.chat.completions.create({
      model: rt.modelFor('medium'),
      max_tokens: 250,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `You are a task clarity analyzer. Analyze this request and return ONLY valid JSON (no markdown, no backticks).
${userMd ? `\nUSER PROFILE (already known — do NOT count these as gaps):\n${userMd}\n` : ''}
{
  "intent": <0-100>,
  "scope": <0-100>,
  "target": <0-100>,
  "action": <0-100>,
  "gaps": [<list of unclear parts>],
  "reason": "<one sentence why this score>"
}

Score based on:
- intent (0-100): Do we understand what they want to accomplish?
- scope (0-100): Do we know the boundaries? (one item, all items, specific range?)
- target (0-100): Do we know WHERE or WHICH SERVICE? (GitHub, Gmail, Desktop, specific file, etc)
- action (0-100): Do we know WHAT TO DO? (get, check, create, delete, etc)

IMPORTANT: Score HIGH (85+) when the user provides specific details — file names, exact content, numbered steps, or a bulleted list of items. A detailed multi-step task with a clear list is MORE clear, not less.
"Desktop", "my Desktop", a specific folder path = target:90+ (location is known).
Specific file names listed = scope:90+ (exactly what is named).
Numbered steps or bullets = intent:90+, scope:90+.

Examples:
"get my repos" → intent:90, scope:70, target:95, action:85
"help with my stuff" → intent:20, scope:10, target:30, action:40
"oldest GitHub repo" → intent:95, scope:95, target:95, action:85
"Create 3 files on my Desktop: file1.js, file2.js, file3.js with these contents..." → intent:95, scope:95, target:90, action:95
"Create a folder called test on my Desktop, write a file, read it back" → intent:95, scope:90, target:90, action:95
"Post this on LinkedIn: Hello world" → intent:95, scope:95, target:95, action:95`
        },
        {
          role: 'user',
          content: userMessage
        }
      ]
    })

    const text = response.choices[0].message.content?.trim() || '{}'
    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)

    const overall = (parsed.intent + parsed.scope + parsed.target + parsed.action) / 4

    return {
      overall: Math.round(overall),
      intent: parsed.intent || 0,
      scope: parsed.scope || 0,
      target: parsed.target || 0,
      action: parsed.action || 0,
      gaps: parsed.gaps || [],
      reason: parsed.reason || 'Unknown'
    }
  } catch (err) {
    console.error('[confidence-scorer] Error:', err)
    return {
      overall: 70,
      intent: 70,
      scope: 70,
      target: 70,
      action: 70,
      gaps: ['Unable to analyze'],
      reason: 'Error during analysis'
    }
  }
}
