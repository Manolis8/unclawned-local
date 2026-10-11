import { execSync } from 'child_process'
import fs from 'fs'
import {
  SOUL_MD_PATH, JARVIS_DIR,
  loadSoulMd, saveSoulMd, hasSoul, draftSoulFromAnswers,
  type SoulAnswers,
} from './soul.js'

type PromptFn = (question: string) => Promise<string>

// ─── Helpers ──────────────────────────────────────────────────────────────────

function header(text: string) {
  const line = '─'.repeat(55)
  console.log(`\n${line}`)
  console.log(`  ${text}`)
  console.log(line)
}

async function ask(promptFn: PromptFn, question: string): Promise<string> {
  return (await promptFn(`  ${question}\n  > `)).trim()
}

// Collect multi-line input. User types "---" alone on a line to finish.
async function askMultiLine(promptFn: PromptFn, question: string): Promise<string> {
  console.log(`\n  ${question}`)
  console.log('  (When done, type --- on a new line and press Enter)')
  const lines: string[] = []
  while (true) {
    const line = await promptFn('')
    if (line.trim() === '---') break
    lines.push(line)
    // Safety: stop after 200 lines to prevent runaway pastes
    if (lines.length >= 200) break
  }
  return lines.join('\n').trim()
}

// ─── /soul setup ─────────────────────────────────────────────────────────────

export async function runSoulSetup(promptFn: PromptFn): Promise<void> {
  const resuming = hasSoul()

  header(resuming ? 'Soul Setup — Rewriting SOUL.md' : 'Soul Setup — Give Jarvis a Personality')

  if (resuming) {
    console.log('  This will replace your current SOUL.md. Answer to rebuild it.\n')
  } else {
    console.log('  3 questions. Takes 2 minutes.')
    console.log('  Jarvis uses this as the foundation for how it thinks and writes.\n')
  }

  // Q1 — Communication style
  console.log('  Question 1 of 3')
  const communication = await ask(
    promptFn,
    'How do you want Jarvis to think and communicate?\n  (e.g. "direct and sharp, no fluff, gets to the point, talks like a person not a press release")'
  )
  if (!communication) {
    console.log('\n  Setup cancelled — no input given.\n')
    return
  }

  // Q2 — What to never do
  console.log('\n  Question 2 of 3')
  const neverDo = await ask(
    promptFn,
    'What should Jarvis NEVER do in its responses?\n  (e.g. "no sycophancy, no corporate buzzwords, no bullet points for everything, no excessive disclaimers")'
  )

  // Q3 — Uncertainty handling
  console.log('\n  Question 3 of 3')
  const uncertainty = await ask(
    promptFn,
    'How should Jarvis handle situations where it\'s not sure what to do?\n  (e.g. "state your assumption and proceed" or "ask me first if the risk is high")'
  )

  console.log('\n  Drafting SOUL.md...')

  const answers: SoulAnswers = {
    communication: communication || 'Direct, sharp, no fluff. Gets to the point.',
    neverDo: neverDo || 'No sycophancy, no corporate language, no over-explaining.',
    uncertainty: uncertainty || 'State your assumption and proceed. Flag it at the end.',
  }

  let draft: string
  try {
    draft = await draftSoulFromAnswers(answers)
  } catch (err: any) {
    console.log(`\n  Error drafting SOUL.md: ${err.message}`)
    console.log('  Using built-in default instead.\n')
    const { DEFAULT_SOUL } = await import('./soul.js')
    draft = DEFAULT_SOUL
  }

  // Show the draft
  const line = '─'.repeat(55)
  console.log(`\n${line}`)
  console.log('  DRAFT SOUL.md')
  console.log(line)
  console.log()
  console.log(draft.split('\n').map(l => '  ' + l).join('\n'))
  console.log(`\n${line}\n`)

  const answer = (await promptFn('  Save this? (y = save, e = edit in Notepad, n = cancel) > ')).trim().toLowerCase()

  if (answer === 'e' || answer === 'edit') {
    // Write draft first so notepad has something to open
    fs.mkdirSync(JARVIS_DIR, { recursive: true })
    saveSoulMd(draft)
    openSoulInEditor()
    const _ = await promptFn('\n  Press Enter after you finish editing in Notepad... ')
    // Re-read what they saved
    const edited = loadSoulMd()
    if (edited) {
      console.log('\n  SOUL.md saved with your edits.\n')
    }
    return
  }

  if (answer !== 'y' && answer !== 'yes') {
    console.log('\n  Setup cancelled. SOUL.md not changed.\n')
    return
  }

  saveSoulMd(draft)

  console.log(`\n${line}`)
  console.log('  SOUL.md saved.')
  console.log('  Jarvis will use this personality from the next task onward.')
  console.log(`  To edit: /soul edit`)
  console.log(line + '\n')
}

// ─── /soul show ───────────────────────────────────────────────────────────────

export function showSoul(): void {
  const content = loadSoulMd()
  const line = '─'.repeat(55)

  if (!content) {
    console.log(`\n${line}`)
    console.log('  SOUL.md — not set up yet')
    console.log(line)
    console.log('  Jarvis is using the built-in default personality.')
    console.log('  Run /soul setup to customize it.')
    console.log(`  File will be saved at: ${SOUL_MD_PATH}`)
    console.log(line + '\n')
    return
  }

  console.log(`\n${line}`)
  console.log('  SOUL.md — Jarvis Personality')
  console.log(line)
  console.log()
  console.log(content.split('\n').map(l => '  ' + l).join('\n'))
  console.log()
  console.log(`  File: ${SOUL_MD_PATH}`)
  console.log(`  Edit directly: /soul edit`)
  console.log(`  Redo setup: /soul setup`)
  console.log(line + '\n')
}

// ─── /soul edit ───────────────────────────────────────────────────────────────

export function openSoulInEditor(): void {
  if (!hasSoul()) {
    console.log('\n  No SOUL.md yet. Run /soul setup first.\n')
    return
  }
  try {
    if (process.platform === 'win32') {
      execSync(`start notepad "${SOUL_MD_PATH}"`, { stdio: 'ignore' })
    } else {
      const editor = process.env.EDITOR || 'nano'
      execSync(`${editor} "${SOUL_MD_PATH}"`)
    }
    console.log(`\n  Opened SOUL.md in editor. Changes take effect on the next task.\n`)
  } catch {
    console.log(`\n  Could not open editor automatically.`)
    console.log(`  Edit the file directly at:\n  ${SOUL_MD_PATH}\n`)
  }
}
