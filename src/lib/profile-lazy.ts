import fs from 'fs'
import { loadUserMd, isProfileUsable, USER_MD_PATH, JARVIS_DIR } from './user-profile.js'
import { resolveRuntime } from './model-router.js'

// ── Section patching ───────────────────────────────────────────────────────────

function appendToSection(md: string, section: string, line: string): string {
  const header = `## ${section}`
  const idx = md.indexOf(header)

  if (idx === -1) {
    return md.trim() + `\n\n${header}\n${line}`
  }

  const afterHeader = md.slice(idx + header.length)
  const nextSection = afterHeader.search(/\n## /)

  if (nextSection !== -1) {
    const insertAt = idx + header.length + nextSection
    return md.slice(0, insertAt) + '\n' + line + md.slice(insertAt)
  }

  return md.trimEnd() + '\n' + line
}

// ── LLM-generated contextual question ─────────────────────────────────────────

async function generateQuestion(md: string, lastTask: string, skippedQuestions: string[] = []): Promise<string | null> {
  try {
    const rt = resolveRuntime()
    const skippedNote = skippedQuestions.length
      ? `\n\nDo NOT ask about: ${skippedQuestions.map(q => `"${q}"`).join(', ')}`
      : ''
    const res = await rt.fastClient.chat.completions.create({
      model: rt.modelFor('medium'),
      max_tokens: 80,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: `You are building a user profile for a personal AI assistant. Based on the user's current profile and their last task, identify ONE meaningful gap and ask a short conversational question to fill it.

Focus on things like: what they're building or working toward, their goals, how they like things done, what frustrates them, what good output looks like to them, their clients, their domain, autonomy preferences.

Rules:
- Return ONLY the question — no intro, no explanation
- One sentence, ends with ?
- If the profile already has strong coverage across all dimensions, return exactly: DONE${skippedNote}`,
        },
        {
          role: 'user',
          content: `Current profile:\n${md.slice(0, 600) || '(no profile yet)'}\n\nUser's last task: "${lastTask.slice(0, 200)}"`,
        },
      ],
    })

    const text = res.choices[0].message.content?.trim() || ''
    if (!text || text === 'DONE' || !text.includes('?')) return null
    // Strip any leading quotes the model might add
    return text.replace(/^["']|["']$/g, '').trim()
  } catch {
    return null
  }
}

// ── Session state ──────────────────────────────────────────────────────────────

let _completedTaskCount = 0
let _doneForSession = false       // set on first skip — no more questions this session
const _skippedQuestions: string[] = []  // passed to LLM so it generates a different question next time

// Questions are surfaced at these exact task milestones, then never again.
const MILESTONES = [3, 5, 10]

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Call after each successfully completed task.
 *
 * Surfaces a profile question at task milestones 3, 5, and 10.
 * - Answer → save, continue to next milestone
 * - Enter  → "Skipped for today." → done for the session
 * After all milestones are exhausted, stops for the session.
 */
export async function maybeSurfaceProfileQuestion(
  promptFn: (q: string) => Promise<string>,
  lastTask = ''
): Promise<void> {
  _completedTaskCount++

  if (_doneForSession) return
  if (!MILESTONES.includes(_completedTaskCount)) return
  if (!isProfileUsable()) return

  const md = loadUserMd() ?? ''
  const question = await generateQuestion(md, lastTask, _skippedQuestions)
  if (!question) return

  console.log(`\n  💬 ${question}`)
  console.log('     (Enter to skip for today)\n')

  let answer: string
  try {
    answer = (await promptFn('  > ')).trim()
  } catch { return }

  // Skip — done for the session
  if (!answer) {
    _doneForSession = true
    _skippedQuestions.push(question)
    console.log('  Skipped for today.\n')
    return
  }

  // Answer — save and continue to next milestone
  const newMd = appendToSection(md, 'Notes', `- ${question.replace(/\?$/, '')}: ${answer}`)
  try {
    fs.mkdirSync(JARVIS_DIR, { recursive: true })
    fs.writeFileSync(USER_MD_PATH, newMd, 'utf-8')
    console.log('  ✓ Saved to your profile.\n')
  } catch {
    console.log('  ⚠ Could not save.\n')
  }

  // If this was the last milestone, stop for the session
  if (_completedTaskCount >= Math.max(...MILESTONES)) {
    _doneForSession = true
  }
}
