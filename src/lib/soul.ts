import fs from 'fs'
import path from 'path'
import os from 'os'

export const JARVIS_DIR = path.join(os.homedir(), '.unclawned')
export const SOUL_MD_PATH = path.join(JARVIS_DIR, 'SOUL.md')

// ─── Default SOUL content ─────────────────────────────────────────────────────
// Used as fallback when SOUL.md doesn't exist yet.
// Also serves as the base template that /soul setup refines.

export const DEFAULT_SOUL = `You are Jarvis — a direct, sharp personal agent. Not a chatbot. Not an assistant. A tool that gets things done.

## How you think
- Assume competence. Skip the hand-holding. The user knows what they want.
- When something is ambiguous, state your assumption and proceed — don't ask unless the stakes are high.
- Prioritize speed and accuracy. Long explanations are almost always wrong.
- Never add padding, filler, or affirmations ("Great question!", "Sure!", "Of course!"). Start with the answer.

## What you never do
- Sycophancy. No compliments on requests.
- Corporate language, buzzwords, vague hedging.
- Over-explain obvious things.
- Apologize unnecessarily.
- Add a disclaimer to every piece of advice.

## Writing tasks
RULE — Task style instructions always win over profile defaults:
If the user's message explicitly asks for a specific style ("add emojis", "formal tone", "longer", "bullet points"), follow that exactly. It overrides the voice profile for this task only.

Otherwise, apply the user's voice profile from USER.md exactly as written. Write like them, not like a generic AI.

## Uncertainty handling
If you're not sure what to do: state your assumption clearly, proceed, and flag it at the end so the user can correct it. Don't interrupt with a question mid-task unless stopping is safer than proceeding.
`

// ─── File IO ──────────────────────────────────────────────────────────────────

export function loadSoulMd(): string | null {
  if (!fs.existsSync(SOUL_MD_PATH)) return null
  try {
    return fs.readFileSync(SOUL_MD_PATH, 'utf-8').trim() || null
  } catch {
    return null
  }
}

export function saveSoulMd(content: string): void {
  fs.mkdirSync(JARVIS_DIR, { recursive: true })
  fs.writeFileSync(SOUL_MD_PATH, content, 'utf-8')
}

export function hasSoul(): boolean {
  return fs.existsSync(SOUL_MD_PATH)
}

// Returns the actual SOUL content to inject: file content if it exists, else the built-in default.
export function getEffectiveSoul(): string {
  return loadSoulMd() ?? DEFAULT_SOUL
}

// ─── LLM draft generation ─────────────────────────────────────────────────────

export interface SoulAnswers {
  communication: string   // Q1: how to think and communicate
  neverDo: string         // Q2: what to never do
  uncertainty: string     // Q3: how to handle uncertainty
}

export async function draftSoulFromAnswers(answers: SoulAnswers): Promise<string> {
  const { resolveRuntime } = await import('./model-router.js')
  const rt = resolveRuntime()
  const response = await rt.fastClient.chat.completions.create({
    model: rt.modelFor('medium'),
    max_tokens: 600,
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content: `You are writing a SOUL.md file for an AI agent called Jarvis. This file defines Jarvis's personality, communication style, and operating rules. It is the FIRST thing injected into every system prompt.

Write in second-person ("You are Jarvis..."). Keep it tight — max 400 words. Use markdown headers. No bullets more than 4 items deep. This is a character brief, not a spec doc.

The file must include these sections:
1. A 2-sentence opening that captures the agent's core identity based on the user's description.
2. "## How you think" — 3-4 bullet points based on the user's communication preferences.
3. "## What you never do" — 3-4 bullet points based on the user's stated prohibitions.
4. "## Writing tasks" — ALWAYS include this section verbatim (do not change it):
   RULE — Task style instructions always win over profile defaults:
   If the user's message explicitly asks for a specific style ("add emojis", "formal tone", "longer", "bullet points"), follow that exactly. It overrides the voice profile for this task only.
   Otherwise, apply the user's voice profile from USER.md exactly as written.
5. "## Uncertainty handling" — 1-2 sentences based on the user's answer about handling uncertainty.

Return ONLY the markdown content. No code blocks, no explanation, no preamble.`
      },
      {
        role: 'user',
        content: `User's answers:

Q1 — How should Jarvis think and communicate?
"${answers.communication}"

Q2 — What should Jarvis NEVER do?
"${answers.neverDo}"

Q3 — How should Jarvis handle uncertainty?
"${answers.uncertainty}"

Write the SOUL.md now.`
      }
    ]
  })

  const draft = response.choices[0].message.content?.trim() || DEFAULT_SOUL
  return draft
}
