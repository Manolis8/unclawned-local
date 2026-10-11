import type { ConfidenceScore } from './confidence-scorer.js'
import { resolveRuntime } from '../model-router.js'

export async function generateClarifyingQuestions(
  userMessage: string,
  confidence: ConfidenceScore,
  userMd?: string
): Promise<string[]> {
  try {
    let questionCount = 1
    if (confidence.overall < 70) questionCount = 2
    if (confidence.overall < 60) questionCount = Math.min(3, confidence.gaps.length)

    const rt = resolveRuntime()
    const response = await rt.fastClient.chat.completions.create({
      model: rt.modelFor('medium'),
      max_tokens: 350,
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content: `Generate EXACTLY ${questionCount} short clarifying questions to better understand this task.

Return ONLY a valid JSON array (no markdown, no backticks):
["Question 1?", "Question 2?", "Question 3?"]

Requirements:
- Each question is SHORT (under 15 words)
- Questions are specific, not vague
- Questions address the gaps
- Make them easy to answer (yes/no, or short phrase)
- CRITICAL: Do NOT ask about anything already answered in the user profile below
- Don't repeat information already provided in the user's message

${userMd ? `USER PROFILE (already known — do NOT ask about these):\n${userMd}\n` : ''}
Gaps to address:
${confidence.gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}

User's original message: "${userMessage}"

Generate only the JSON array, nothing else.`
        }
      ]
    })

    const text = response.choices[0].message.content?.trim() || '[]'
    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)

    return Array.isArray(parsed) ? parsed.slice(0, questionCount) : []
  } catch (err) {
    console.error('[question-generator] Error:', err)
    return [
      'Can you give me more specific details?',
      'Which platform or service are you referring to?'
    ]
  }
}
