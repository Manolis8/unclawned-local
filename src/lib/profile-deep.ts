import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import { resolveRuntime } from './model-router.js'
import {
  setProfileField, setProfileFields, loadUserMd, isProfileUsable,
  JARVIS_DIR, USER_MD_PATH,
} from './user-profile.js'

const DRAFT_PATH = path.join(os.homedir(), '.unclawned', 'profile-draft.json')
const QUIT_WORDS = new Set(['quit', 'exit', '/quit', 'q', ':q', 'stop', '/stop'])

// Max questions before forcing compile. 3-5 is typical; 6 is the hard cap.
const MAX_QUESTIONS = 6

// ── Types ──────────────────────────────────────────────────────────────────────

interface QAPair { question: string; answer: string }

interface ProfileDraft {
  started_at: string
  last_updated_at: string
  status: 'in_progress' | 'compiled'
  is_refresh: boolean
  existing_profile: string
  qa_pairs: QAPair[]
  voice_sample?: string
}

type InterviewResponse =
  | { type: 'question'; text: string }
  | { type: 'pushback'; text: string }
  | { type: 'done' }

// ── Draft persistence ──────────────────────────────────────────────────────────

function loadDraft(): ProfileDraft | null {
  try {
    if (!fs.existsSync(DRAFT_PATH)) return null
    const raw = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf-8'))
    if (raw?.status && Array.isArray(raw?.qa_pairs)) return raw as ProfileDraft
    return null
  } catch { return null }
}

function saveDraft(draft: ProfileDraft): void {
  try {
    draft.last_updated_at = new Date().toISOString()
    fs.mkdirSync(path.dirname(DRAFT_PATH), { recursive: true })
    fs.writeFileSync(DRAFT_PATH, JSON.stringify(draft, null, 2), 'utf-8')
  } catch {}
}

function deleteDraft(): void {
  try { fs.unlinkSync(DRAFT_PATH) } catch {}
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return iso.slice(0, 10) }
}

// ── JSON parsing with fallbacks ────────────────────────────────────────────────

function parseJson(text: string): any {
  try { return JSON.parse(text.trim()) } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) try { return JSON.parse(fence[1].trim()) } catch {}
  const obj = text.match(/\{[\s\S]*\}/)
  if (obj) try { return JSON.parse(obj[0]) } catch {}
  throw new Error('no JSON in response')
}

function parseInterviewResponse(text: string): InterviewResponse {
  try {
    const parsed = parseJson(text)
    if (['question', 'pushback', 'done'].includes(parsed?.type) && (parsed.type === 'done' || parsed.text)) {
      return parsed as InterviewResponse
    }
  } catch {}
  // Prose fallback: if the model returned text with a question, extract it
  const lower = text.toLowerCase()
  if (lower.includes('done') || lower.includes('enough information')) return { type: 'done' }
  const sentences = text.split(/(?<=[.!?])\s+/)
  const question = sentences.find(s => s.trim().endsWith('?'))
  if (question) return { type: 'question', text: question.trim() }
  throw new Error(`Cannot parse response: ${text.slice(0, 120)}`)
}

// ── Token-efficient history summary ───────────────────────────────────────────
// Instead of sending all Q&A pairs each call, send a compact summary so the
// LLM knows what's been covered without blowing up the context.

function buildCompactContext(pairs: QAPair[], justPushedBack: boolean): string {
  if (pairs.length === 0) return 'Start the interview.'

  const coveredTopics = pairs
    .map((qa, i) => `${i + 1}. ${qa.question.slice(0, 80)}`)
    .join('\n')

  const recent = pairs.slice(-2)
  const recentText = recent
    .map(qa => `Q: ${qa.question}\nA: ${qa.answer}`)
    .join('\n\n')

  const pushbackNote = justPushedBack
    ? '\n[Note: you already pushed back on my last answer — please move to a new question]'
    : ''

  return `Questions asked so far (${pairs.length}):\n${coveredTopics}\n\nMost recent exchange:\n${recentText}${pushbackNote}`
}

// ── LLM interviewer ────────────────────────────────────────────────────────────

const INTERVIEW_TOPICS = `- Who they are, their role, and what they actually do day-to-day
- What they're currently building or working on, and what winning looks like for them
- Their bigger vision or goal — where they want to be in 6-12 months
- Output preferences: tone, length, format, what they hate seeing in AI responses
- Autonomy rules: what the AI can do freely vs. what always needs their sign-off
- Domain expertise, what they're learning, and what frustrates them about current tools`

async function getNextQuestion(
  pairs: QAPair[],
  existingProfile: string,
  isRefresh: boolean,
  justPushedBack: boolean
): Promise<InterviewResponse> {
  const rt = resolveRuntime()

  const refreshHint = isRefresh && existingProfile
    ? `\nExisting profile to update:\n${existingProfile.slice(0, 800)}\nFocus only on what may have changed.`
    : ''

  const remaining = MAX_QUESTIONS - pairs.length
  const countHint = remaining <= 1
    ? '\nThis is the last question. After the user answers, respond with { "type": "done" }.'
    : `\nAim to finish in ${remaining} more question${remaining !== 1 ? 's' : ''}.`

  const system = `You are conducting a short onboarding interview (maximum ${MAX_QUESTIONS} questions total) to build a user profile for a personal AI assistant.

Ask ONE focused question at a time. Cover the most important areas first:
${INTERVIEW_TOPICS}${refreshHint}${countHint}

Rules:
- One question per response, never multiple
- If an answer is vague, push back ONCE for a specific example
- Never push back twice on the same topic
- Signal done after ${MAX_QUESTIONS} questions or when you have enough to write a useful profile

YOU MUST respond ONLY in valid JSON — no prose, no explanation:
{ "type": "question", "text": "your question" }
{ "type": "pushback", "text": "follow-up for a specific example" }
{ "type": "done" }`

  const userContext = buildCompactContext(pairs, justPushedBack)

  const messages: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: system },
    { role: 'user', content: userContext },
  ]

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await rt.fastClient.chat.completions.create({
        model: rt.modelFor('medium'),
        max_tokens: 150,
        temperature: 0.6,
        messages,
      })
      const text = res.choices[0].message.content?.trim() || ''
      return parseInterviewResponse(text)
    } catch (err) {
      console.error(`[profile-deep] interviewer attempt ${attempt + 1} failed:`, err instanceof Error ? err.message : String(err))
      if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue }
      throw err
    }
  }
  throw new Error('LLM interviewer failed after 3 attempts')
}

// ── Voice sample collection ────────────────────────────────────────────────────

async function collectVoiceSample(promptFn: (q: string) => Promise<string>): Promise<string> {
  const LINE = '─'.repeat(55)
  console.log(`\n${LINE}`)
  console.log('  Voice sample (optional)')
  console.log('  Paste a recent message, email, or post you wrote.')
  console.log('  The AI will match your writing style automatically.')
  console.log('  Type --- on its own line when done, or press Enter to skip.')
  console.log(LINE + '\n')

  const lines: string[] = []
  let isFirst = true

  while (true) {
    let line: string
    try { line = await promptFn(isFirst ? '  > ' : '') } catch { break }
    isFirst = false
    if (line.trim() === '---') break
    if (lines.length === 0 && line.trim() === '') return ''  // skip
    lines.push(line)
    if (lines.length >= 100) break
  }

  return lines.join('\n').trim()
}

// ── Compile Q&A + voice sample into USER.md ────────────────────────────────────

async function compileProfile(pairs: QAPair[], existingProfile: string, voiceSample: string): Promise<string> {
  const rt = resolveRuntime()

  const transcript = pairs
    .map((qa, i) => `Q${i + 1}: ${qa.question}\nA: ${qa.answer}`)
    .join('\n\n')

  const voiceBlock = voiceSample
    ? `\n\nWriting sample from the user (match this voice and style):\n---\n${voiceSample.slice(0, 1200)}\n---`
    : ''

  const mergeHint = existingProfile
    ? `\nMerge with existing profile — keep what's still true, update what's changed:\n${existingProfile}`
    : ''

  const res = await rt.client.chat.completions.create({
    model: rt.modelFor('high'),
    max_tokens: 1500,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: `From this short interview and any voice sample, write a comprehensive user profile in markdown.

This profile is injected into an AI assistant's system prompt for every task. Write it as direct, actionable context — not a biography. Be specific. Use the person's exact words where they reveal something important. Skip any section where you have no real data.${mergeHint}

Use these headers (omit any you have no data for):

## About
[who they are, role, company, what they really do day-to-day]

## Work Style
[how they think, make decisions, pace, how they give instructions]

## Output Preferences
[tone, length, format — be specific and concrete]

## Never
[exact phrases, styles, behaviors the AI must never produce]

## Good Work Looks Like
[concrete examples of what excellent output means to this person]

## Goals Right Now
[current focus and what success looks like]

## Tools
[email client, social, notes, CRM, key folder paths]

## Autonomy
[what the AI can do freely vs. what always needs sign-off]

## Domain & Expertise
[what they know deeply, what they're learning]

## Voice
[only if a writing sample was provided — describe their writing style concisely]`,
      },
      { role: 'user', content: transcript + voiceBlock },
    ],
  })

  return res.choices[0].message.content?.trim() || ''
}

// ── Basic DB field extraction ──────────────────────────────────────────────────

async function extractBasicFields(compiled: string): Promise<{ name?: string; role?: string; current_goals?: string }> {
  try {
    const rt = resolveRuntime()
    const res = await rt.fastClient.chat.completions.create({
      model: rt.modelFor('low'),
      max_tokens: 80,
      temperature: 0,
      messages: [
        { role: 'system', content: 'Return JSON only: {"name":"first name or null","role":"job title or null","current_goals":"one sentence or null"}' },
        { role: 'user', content: compiled.slice(0, 600) },
      ],
    })
    return parseJson(res.choices[0].message.content?.trim() || '{}')
  } catch { return {} }
}

// ── Quick goals patch for deep profiles ───────────────────────────────────────

export async function patchGoalsInDeepProfile(promptFn: (q: string) => Promise<string>): Promise<void> {
  const LINE = '─'.repeat(55)
  console.log(`\n${LINE}\n  Quick Goals Update\n${LINE}\n`)

  let goals: string
  try {
    goals = (await promptFn('  What are you working on right now?\n  (type "quit" to cancel)\n\n  > ')).trim()
    if (!goals || QUIT_WORDS.has(goals.toLowerCase())) { console.log('  Cancelled.\n'); return }
  } catch { return }

  let success = ''
  try {
    success = (await promptFn('\n  What does winning look like this month? (Enter to skip)\n\n  > ')).trim()
  } catch {}

  const goalsBlock = `## Goals Right Now\n${goals}${success ? `\n\nSuccess this month: ${success}` : ''}`
  const md = loadUserMd() ?? ''

  const newMd = md.includes('## Goals Right Now')
    ? md.replace(/## Goals Right Now[\s\S]*?(?=\n##|$)/, goalsBlock)
    : md.trim() + '\n\n' + goalsBlock

  try {
    fs.mkdirSync(JARVIS_DIR, { recursive: true })
    fs.writeFileSync(USER_MD_PATH, newMd.trim(), 'utf-8')
    setProfileField('current_goals', goals)
    if (success) setProfileField('success_metric', success)
    setProfileField('goals_updated_at', new Date().toISOString().split('T')[0])
    console.log('\n  ✓ Goals updated.\n')
  } catch { console.log('  ⚠ Could not update goals.\n') }
}

// ── Public helper ──────────────────────────────────────────────────────────────

/** True when USER.md was produced by the deep setup (has ## section headers). */
export function isDeepProfile(): boolean {
  const md = loadUserMd()
  return !!md && md.includes('## ') && md.length > 300
}

// ── Compile + save (shared between quit-with-compile and natural end) ──────────

async function compileAndSave(
  draft: ProfileDraft,
  promptFn: (q: string) => Promise<string>
): Promise<void> {
  const LINE = '─'.repeat(55)

  console.log('\n  Compiling your profile...')

  let compiled: string
  try {
    compiled = await compileProfile(draft.qa_pairs, draft.existing_profile, draft.voice_sample ?? '')
  } catch (err) {
    console.error('[profile-deep] compile error:', err instanceof Error ? err.message : String(err))
    console.log('\n  ⚠ Compilation failed. Your answers are saved — run /profile setup to retry.\n')
    return
  }

  if (!compiled) {
    console.log('\n  ⚠ Got an empty profile. Your answers are saved — run /profile setup to retry.\n')
    return
  }

  // ── Review step ────────────────────────────────────────────────────────────
  console.log(`\n${LINE}\n  Here's your compiled profile:\n${LINE}\n`)
  console.log(compiled.split('\n').map(l => '  ' + l).join('\n'))
  console.log(`\n${LINE}`)

  let confirm = 'y'
  try {
    confirm = (await promptFn('\n  Save this as your profile? [y / n / edit] > ')).trim().toLowerCase()
  } catch {}

  if (confirm === 'n' || confirm === 'no') {
    console.log('\n  Not saved. Your answers are kept — run /profile setup to try again.\n')
    return
  }

  if (confirm === 'edit' || confirm === 'e') {
    try {
      fs.mkdirSync(JARVIS_DIR, { recursive: true })
      fs.writeFileSync(USER_MD_PATH, compiled, 'utf-8')
      if (process.platform === 'win32') {
        execSync(`start notepad "${USER_MD_PATH}"`, { stdio: 'ignore' })
      } else {
        const editor = process.env.EDITOR || 'nano'
        execSync(`${editor} "${USER_MD_PATH}"`)
      }
      console.log('\n  Edit in the editor that just opened. Changes are saved automatically.\n')
      try { compiled = fs.readFileSync(USER_MD_PATH, 'utf-8').trim() } catch {}
    } catch {
      console.log('  ⚠ Could not open editor. Profile saved as-is.\n')
      try { fs.mkdirSync(JARVIS_DIR, { recursive: true }); fs.writeFileSync(USER_MD_PATH, compiled, 'utf-8') } catch {}
    }
  } else {
    try {
      fs.mkdirSync(JARVIS_DIR, { recursive: true })
      fs.writeFileSync(USER_MD_PATH, compiled, 'utf-8')
    } catch {
      console.log('\n  ⚠ Could not write USER.md.\n')
      return
    }
  }

  // Populate basic DB fields so isProfileUsable() / goal freshness work
  try {
    const basic = await extractBasicFields(compiled)
    const updates: Record<string, string> = {}
    if (basic.name) updates.name = basic.name
    if (basic.role) updates.role = basic.role
    if (basic.current_goals) { updates.current_goals = basic.current_goals; updates.goals_updated_at = new Date().toISOString().split('T')[0] }
    if (Object.keys(updates).length > 0) setProfileFields(updates as any)
  } catch {}

  deleteDraft()

  console.log(`\n${LINE}`)
  console.log('  ✅ Profile saved. Every task from now on knows who it\'s working for.')
  console.log('  To view:   /profile show')
  console.log('  To edit:   /profile edit')
  console.log('  To update: /profile setup  (short refresh, ~5 min)')
  console.log(LINE + '\n')
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function runDeepProfileSetup(promptFn: (q: string) => Promise<string>): Promise<void> {
  const LINE = '─'.repeat(55)
  const QUIT_HINT = '  (type "quit" to save and exit)\n'

  // ── Resume / restart / fresh start decision ────────────────────────────────
  let activeDraft: ProfileDraft
  const existingDraft = loadDraft()

  if (existingDraft?.status === 'in_progress' && existingDraft.qa_pairs.length > 0) {
    const dateStr = fmtDate(existingDraft.last_updated_at)
    console.log(`\n${LINE}`)
    console.log(`  Unfinished setup from ${dateStr}`)
    console.log(`  ${existingDraft.qa_pairs.length} question${existingDraft.qa_pairs.length !== 1 ? 's' : ''} answered so far.`)
    console.log(LINE)

    let choice: string
    try {
      choice = (await promptFn('\n  [c] Continue  [r] Start over  [q] Cancel\n\n  > ')).trim().toLowerCase()
    } catch { console.log('\n  Cancelled.\n'); return }

    if (choice === 'q' || choice === 'quit' || choice === 'cancel') {
      console.log('\n  Draft still saved. Run /profile setup to resume.\n')
      return
    }
    if (choice === 'r' || choice.startsWith('start') || choice === 'restart' || choice === 'new') {
      deleteDraft()
      const existingMd = loadUserMd() ?? ''
      activeDraft = { started_at: new Date().toISOString(), last_updated_at: new Date().toISOString(), status: 'in_progress', is_refresh: isProfileUsable() && !!existingMd, existing_profile: existingMd, qa_pairs: [] }
    } else {
      activeDraft = existingDraft
    }
  } else {
    const existingMd = loadUserMd() ?? ''
    const isRefresh = isProfileUsable() && !!existingMd
    activeDraft = { started_at: new Date().toISOString(), last_updated_at: new Date().toISOString(), status: 'in_progress', is_refresh: isRefresh, existing_profile: existingMd, qa_pairs: [] }

    console.log(`\n${LINE}`)
    if (isRefresh) {
      console.log('  Profile Update  (~5 questions, ~5 min)')
      console.log('  Focused on what may have changed.')
    } else {
      console.log('  Profile Setup  (~5 questions, ~5 min)')
      console.log('  Quick setup — the agent learns the rest as you work.')
    }
    console.log(LINE + '\n')
  }

  saveDraft(activeDraft)

  // ── Interview loop ─────────────────────────────────────────────────────────
  let justPushedBack = false

  while (activeDraft.qa_pairs.length < MAX_QUESTIONS) {
    let response: InterviewResponse
    try {
      response = await getNextQuestion(
        activeDraft.qa_pairs,
        activeDraft.existing_profile,
        activeDraft.is_refresh,
        justPushedBack
      )
    } catch {
      console.log('\n  ⚠ Could not reach the AI. Saving your progress...')
      saveDraft(activeDraft)
      console.log(`  Draft saved (${activeDraft.qa_pairs.length} answers). Run /profile setup to continue.\n`)
      return
    }

    if (response.type === 'done') break

    const isPushback = response.type === 'pushback'
    justPushedBack = isPushback

    // Print question with label and quit hint
    if (isPushback) {
      console.log('\n  ↳ ' + response.text)
    } else {
      const n = activeDraft.qa_pairs.length + 1
      const total = MAX_QUESTIONS
      console.log(`\n  [${n}/${total}] ${response.text}`)
    }
    console.log(QUIT_HINT)

    let answer: string
    try {
      answer = (await promptFn('  > ')).trim()
    } catch {
      console.log('\n')
      saveDraft(activeDraft)
      console.log(`  Progress saved (${activeDraft.qa_pairs.length} answers). Run /profile setup to continue.\n`)
      return
    }

    if (QUIT_WORDS.has(answer.toLowerCase())) {
      saveDraft(activeDraft)
      console.log(`\n  Progress saved (${activeDraft.qa_pairs.length} questions answered).`)
      if (activeDraft.qa_pairs.length >= 2) {
        let compileNow = 'n'
        try { compileNow = (await promptFn('\n  Compile a partial profile from what we have? (y/n) > ')).trim().toLowerCase() } catch {}
        if (compileNow === 'y' || compileNow === 'yes') {
          await compileAndSave(activeDraft, promptFn)
          return
        }
      }
      console.log('  Run /profile setup to finish later.\n')
      return
    }

    activeDraft.qa_pairs.push({ question: response.text, answer })
    saveDraft(activeDraft)
  }

  // ── Voice sample (offered after questions) ─────────────────────────────────
  const voiceSample = await collectVoiceSample(promptFn)
  if (voiceSample) {
    activeDraft.voice_sample = voiceSample
    saveDraft(activeDraft)
  }

  await compileAndSave(activeDraft, promptFn)
}
