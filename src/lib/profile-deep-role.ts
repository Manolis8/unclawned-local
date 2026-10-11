import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import { resolveRuntime } from './model-router.js'
import { loadUserMd, JARVIS_DIR, USER_MD_PATH } from './user-profile.js'

const DRAFT_PATH = path.join(os.homedir(), '.unclawned', 'role-profile-draft.json')
const QUIT_WORDS = new Set(['quit', 'exit', '/quit', 'q', ':q', 'stop', '/stop'])
const MAX_QUESTIONS = 12

// ── Role definitions ──────────────────────────────────────────────────────────

const ROLES = {
  business: {
    label: 'Business',
    description: 'owners, freelancers, consultants',
    sectionHeader: '## Business Context',
    topics: `- What they sell, who they serve, and the real problem they solve (not website version)
- Team structure — employees, freelancers, partners, who does what
- Biggest recurring challenges: meetings they dread, decisions they repeat, tasks that eat their time
- Communication style — how they write emails, run meetings, what they actually sound like
- Financial setup — how they track money, who they report to, what they need for accounting
- Non-negotiables: things Claude should never suggest or assume about their work
- What great output looks like — ask for a specific real example`,
  },
  writer: {
    label: 'Writer',
    description: 'bloggers, newsletter writers, copywriters, journalists',
    sectionHeader: '## Writer Voice',
    topics: `- What they write and who they write for — ask for a real example paragraph
- What their writing sounds like at its best vs. going through the motions
- Phrases they use naturally that feel like "them"
- Words and phrases they hate seeing in their own writing
- Topics they always return to even when not trying
- What they refuse to write or positions they'd never take
- Writers they admire — specifically what they'd steal from each one
- Feedback they keep getting — and feedback they keep ignoring and why`,
  },
  client_work: {
    label: 'Client & Project Work',
    description: 'consultants, agencies, project managers',
    sectionHeader: '## Client Work Context',
    topics: `- The type of work they do with clients — deliverables, services, projects
- How they onboard clients and what they need to know before starting
- Delivery standards — what "done" looks like, what they never send without reviewing
- How they communicate with clients — tone, frequency, what they never say
- Their biggest recurring frustrations with client work
- What makes a project go well vs. badly — specific, not general
- How they handle scope creep, missed deadlines, or difficult conversations
- Tools and systems they use — where projects live, how they track things`,
  },
  creator: {
    label: 'Content Creator',
    description: 'YouTubers, podcasters, newsletter writers, social media',
    sectionHeader: '## Creator Context',
    topics: `- What kind of content they make and where they publish
- Their audience — not who they think it is, but what actually gets response
- Content pillars: the 3-5 topics they return to again and again
- On-camera/on-mic personality vs. off-camera reality
- Content they're most proud of and why it worked
- Content that flopped and what they think went wrong
- Trends they refuse to follow even if they'd probably perform
- The 3 creators they admire most — specifically what they'd take from each`,
  },
  analyst: {
    label: 'Analyst & Researcher',
    description: 'data analysts, researchers, strategists',
    sectionHeader: '## Analyst Context',
    topics: `- What they analyze and for whom — who reads their outputs and what they do with them
- How they define a good analysis — what questions it answers, what format it takes
- Output preferences: how they structure reports, what they always include, what they always cut
- The frameworks or mental models they use most, even informal ones
- What "rigorous" means to them — where they draw the line on confidence and evidence
- Their biggest frustrations with how analysis gets done or presented
- What they never want to see in an analysis — vague language, unsupported claims, lazy phrases`,
  },
}

type RoleKey = keyof typeof ROLES

// ── Types ──────────────────────────────────────────────────────────────────────

interface QAPair { question: string; answer: string }

interface RoleDraft {
  role: RoleKey
  started_at: string
  last_updated_at: string
  status: 'in_progress' | 'compiled'
  qa_pairs: QAPair[]
}

type InterviewResponse =
  | { type: 'question'; text: string }
  | { type: 'pushback'; text: string }
  | { type: 'done' }

// ── Draft persistence ──────────────────────────────────────────────────────────

function loadDraft(): RoleDraft | null {
  try {
    if (!fs.existsSync(DRAFT_PATH)) return null
    const raw = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf-8'))
    if (raw?.role && raw?.status && Array.isArray(raw?.qa_pairs)) return raw as RoleDraft
    return null
  } catch { return null }
}

function saveDraft(draft: RoleDraft): void {
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

// ── JSON parsing ───────────────────────────────────────────────────────────────

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
  const lower = text.toLowerCase()
  if (lower.includes('done') || lower.includes('enough information')) return { type: 'done' }
  const sentences = text.split(/(?<=[.!?])\s+/)
  const question = sentences.find(s => s.trim().endsWith('?'))
  if (question) return { type: 'question', text: question.trim() }
  throw new Error(`Cannot parse: ${text.slice(0, 120)}`)
}

// ── Compact context ────────────────────────────────────────────────────────────

function buildCompactContext(pairs: QAPair[], justPushedBack: boolean): string {
  if (pairs.length === 0) return 'Start the interview.'

  const coveredTopics = pairs
    .map((qa, i) => `${i + 1}. ${qa.question.slice(0, 80)}`)
    .join('\n')

  const recent = pairs.slice(-2)
  const recentText = recent.map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n')

  const pushbackNote = justPushedBack
    ? '\n[Note: you already pushed back on my last answer — move to a new question]'
    : ''

  return `Questions asked (${pairs.length}):\n${coveredTopics}\n\nMost recent exchange:\n${recentText}${pushbackNote}`
}

// ── LLM interviewer ────────────────────────────────────────────────────────────

async function getNextQuestion(
  role: RoleKey,
  pairs: QAPair[],
  justPushedBack: boolean
): Promise<InterviewResponse> {
  const rt = resolveRuntime()
  const def = ROLES[role]

  const remaining = MAX_QUESTIONS - pairs.length
  const countHint = remaining <= 1
    ? '\nThis is the last question. After the user answers, respond with { "type": "done" }.'
    : `\nAim to finish in ${remaining} more question${remaining !== 1 ? 's' : ''}.`

  const system = `You are conducting a deep-dive interview (max ${MAX_QUESTIONS} questions) to build a "${def.label}" context profile for a personal AI assistant.

Cover these topic areas, prioritising what's most revealing:
${def.topics}

Interview rules — follow these strictly:
- ONE question per response, never multiple
- Push back on vague answers — ask for a specific real example (actual email, document, decision)
- Call out contradictions with earlier answers — flag it directly
- Don't accept "I don't know" — reframe the question from a different angle
- No validation — no "great point", "that's interesting" — just ask next or push deeper
- If an answer sounds like how they WISH they worked vs how they ACTUALLY do — call it out
- If an answer could describe anyone in their profession — flag it, ask what's specific to them
- Go deeper on unusual threads before moving on
- Never push back twice on the same topic
${countHint}

YOU MUST respond ONLY in valid JSON — no prose:
{ "type": "question", "text": "your question" }
{ "type": "pushback", "text": "specific follow-up or contradiction call-out" }
{ "type": "done" }`

  const messages: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: system },
    { role: 'user', content: buildCompactContext(pairs, justPushedBack) },
  ]

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await rt.fastClient.chat.completions.create({
        model: rt.modelFor('medium'),
        max_tokens: 180,
        temperature: 0.6,
        messages,
      })
      const text = res.choices[0].message.content?.trim() || ''
      return parseInterviewResponse(text)
    } catch (err) {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue }
      throw err
    }
  }
  throw new Error('Interviewer failed after 3 attempts')
}

// ── Compile into a section ─────────────────────────────────────────────────────

async function compileRoleSection(role: RoleKey, pairs: QAPair[]): Promise<string> {
  const rt = resolveRuntime()
  const def = ROLES[role]

  const transcript = pairs.map((qa, i) => `Q${i + 1}: ${qa.question}\nA: ${qa.answer}`).join('\n\n')

  const res = await rt.client.chat.completions.create({
    model: rt.modelFor('high'),
    max_tokens: 1800,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: `From this interview, write a "${def.label}" context profile section in markdown.

This is injected into an AI assistant's system prompt. Write it as direct, actionable context — not a biography. Use the person's exact words where they reveal something important. Include the specific examples they gave — they're what make this useful. Skip any sub-section where you have no real data.

Start with: ${def.sectionHeader}

Then use relevant sub-headers for the key areas covered. Be specific and concrete — adjectives like "direct" or "warm" mean nothing without examples to back them up. If they gave an actual sample (email, paragraph, decision), include it verbatim under the relevant header.`,
      },
      { role: 'user', content: transcript },
    ],
  })

  return res.choices[0].message.content?.trim() || ''
}

// ── Patch section into USER.md ─────────────────────────────────────────────────

function patchRoleSection(existingMd: string, sectionHeader: string, newSection: string): string {
  const idx = existingMd.indexOf(sectionHeader)
  if (idx === -1) {
    return existingMd.trim() + '\n\n' + newSection
  }
  // Replace existing section up to the next ## header
  const afterHeader = existingMd.slice(idx)
  const nextSectionMatch = afterHeader.slice(sectionHeader.length).search(/\n## /)
  if (nextSectionMatch !== -1) {
    const endIdx = idx + sectionHeader.length + nextSectionMatch
    return existingMd.slice(0, idx) + newSection + existingMd.slice(endIdx)
  }
  return existingMd.slice(0, idx).trimEnd() + '\n\n' + newSection
}

// ── Save compiled section ──────────────────────────────────────────────────────

async function compileAndSave(
  draft: RoleDraft,
  promptFn: (q: string) => Promise<string>
): Promise<void> {
  const LINE = '─'.repeat(55)
  const def = ROLES[draft.role]

  console.log('\n  Compiling your context section...')

  let compiled: string
  try {
    compiled = await compileRoleSection(draft.role, draft.qa_pairs)
  } catch (err) {
    console.error('[profile-deep-role] compile error:', err instanceof Error ? err.message : String(err))
    console.log('\n  ⚠ Compilation failed. Your answers are saved — run /profile deep_setup to retry.\n')
    return
  }

  if (!compiled) {
    console.log('\n  ⚠ Got empty output. Your answers are saved — run /profile deep_setup to retry.\n')
    return
  }

  // Review
  console.log(`\n${LINE}\n  Here's your compiled ${def.label} context:\n${LINE}\n`)
  console.log(compiled.split('\n').map(l => '  ' + l).join('\n'))
  console.log(`\n${LINE}`)

  let confirm = 'y'
  try {
    confirm = (await promptFn('\n  Save this to your profile? [y / n / edit] > ')).trim().toLowerCase()
  } catch {}

  if (confirm === 'n' || confirm === 'no') {
    console.log('\n  Not saved. Your answers are kept — run /profile deep_setup to try again.\n')
    return
  }

  const existingMd = loadUserMd() ?? ''

  if (confirm === 'edit' || confirm === 'e') {
    const patched = patchRoleSection(existingMd, def.sectionHeader, compiled)
    try {
      fs.mkdirSync(JARVIS_DIR, { recursive: true })
      fs.writeFileSync(USER_MD_PATH, patched, 'utf-8')
      if (process.platform === 'win32') {
        execSync(`start notepad "${USER_MD_PATH}"`, { stdio: 'ignore' })
      } else {
        const editor = process.env.EDITOR || 'nano'
        execSync(`${editor} "${USER_MD_PATH}"`)
      }
      console.log('\n  Edit in the editor that just opened.\n')
    } catch {
      console.log('  ⚠ Could not open editor. Section saved as-is.\n')
    }
  } else {
    const patched = patchRoleSection(existingMd, def.sectionHeader, compiled)
    try {
      fs.mkdirSync(JARVIS_DIR, { recursive: true })
      fs.writeFileSync(USER_MD_PATH, patched, 'utf-8')
    } catch {
      console.log('\n  ⚠ Could not write USER.md.\n')
      return
    }
  }

  deleteDraft()

  console.log(`\n${LINE}`)
  console.log(`  ✅ ${def.label} context saved to your profile.`)
  console.log('  The agent now has deep context for this role.')
  console.log('  To view: /profile show')
  console.log('  To edit: /profile edit')
  console.log(LINE + '\n')
}

// ── Role picker ────────────────────────────────────────────────────────────────

async function pickRole(promptFn: (q: string) => Promise<string>): Promise<RoleKey | null> {
  const LINE = '─'.repeat(55)
  console.log(`\n${LINE}`)
  console.log('  Deep Context Setup — choose your category:')
  console.log(LINE)

  const entries = Object.entries(ROLES) as [RoleKey, typeof ROLES[RoleKey]][]
  entries.forEach(([key, def], i) => {
    console.log(`  [${i + 1}] ${def.label}  — ${def.description}`)
  })

  console.log('\n  Type a number or the category name.')
  console.log('  (type "quit" to cancel)\n')

  let input: string
  try {
    input = (await promptFn('  > ')).trim().toLowerCase()
  } catch { return null }

  if (QUIT_WORDS.has(input)) return null

  const num = parseInt(input)
  if (!isNaN(num) && num >= 1 && num <= entries.length) {
    return entries[num - 1][0]
  }

  const match = entries.find(([key, def]) =>
    key === input ||
    def.label.toLowerCase() === input ||
    def.label.toLowerCase().startsWith(input)
  )
  if (match) return match[0]

  // Fuzzy: partial match on key or label words
  const fuzzy = entries.find(([key, def]) =>
    key.includes(input) || def.label.toLowerCase().includes(input)
  )
  if (fuzzy) return fuzzy[0]

  console.log(`\n  Didn't recognise "${input}". Try a number (1-${entries.length}) or a name.\n`)
  return null
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function runDeepRoleSetup(promptFn: (q: string) => Promise<string>): Promise<void> {
  const LINE = '─'.repeat(55)
  const QUIT_HINT = '  (type "quit" to save and exit)\n'

  // Check for existing draft
  const existingDraft = loadDraft()

  let activeDraft: RoleDraft

  if (existingDraft?.status === 'in_progress' && existingDraft.qa_pairs.length > 0) {
    const def = ROLES[existingDraft.role]
    const dateStr = fmtDate(existingDraft.last_updated_at)
    console.log(`\n${LINE}`)
    console.log(`  Unfinished ${def?.label ?? existingDraft.role} deep setup from ${dateStr}`)
    console.log(`  ${existingDraft.qa_pairs.length} question${existingDraft.qa_pairs.length !== 1 ? 's' : ''} answered so far.`)
    console.log(LINE)

    let choice: string
    try {
      choice = (await promptFn('\n  [c] Continue  [r] Start over  [q] Cancel\n\n  > ')).trim().toLowerCase()
    } catch { console.log('\n  Cancelled.\n'); return }

    if (choice === 'q' || choice === 'quit') {
      console.log('\n  Draft still saved. Run /profile deep_setup to resume.\n')
      return
    }

    if (choice === 'r' || choice.startsWith('start') || choice === 'restart') {
      deleteDraft()
      const role = await pickRole(promptFn)
      if (!role) { console.log('\n  Cancelled.\n'); return }
      activeDraft = { role, started_at: new Date().toISOString(), last_updated_at: new Date().toISOString(), status: 'in_progress', qa_pairs: [] }
    } else {
      activeDraft = existingDraft
    }
  } else {
    const role = await pickRole(promptFn)
    if (!role) { console.log('\n  Cancelled.\n'); return }

    const def = ROLES[role]
    activeDraft = { role, started_at: new Date().toISOString(), last_updated_at: new Date().toISOString(), status: 'in_progress', qa_pairs: [] }

    console.log(`\n${LINE}`)
    console.log(`  ${def.label} Deep Setup  (~10-12 questions, ~10 min)`)
    console.log('  The AI will push back on vague answers and ask for real examples.')
    console.log('  That\'s what makes the profile actually useful.')
    console.log(LINE + '\n')
  }

  saveDraft(activeDraft)

  // ── Interview loop ─────────────────────────────────────────────────────────
  let justPushedBack = false

  while (activeDraft.qa_pairs.length < MAX_QUESTIONS) {
    let response: InterviewResponse
    try {
      response = await getNextQuestion(activeDraft.role, activeDraft.qa_pairs, justPushedBack)
    } catch {
      console.log('\n  ⚠ Could not reach the AI. Saving your progress...')
      saveDraft(activeDraft)
      console.log(`  Draft saved (${activeDraft.qa_pairs.length} answers). Run /profile deep_setup to continue.\n`)
      return
    }

    if (response.type === 'done') break

    const isPushback = response.type === 'pushback'
    justPushedBack = isPushback

    if (isPushback) {
      console.log('\n  ↳ ' + response.text)
    } else {
      const n = activeDraft.qa_pairs.length + 1
      console.log(`\n  [${n}/${MAX_QUESTIONS}] ${response.text}`)
    }
    console.log(QUIT_HINT)

    let answer: string
    try {
      answer = (await promptFn('  > ')).trim()
    } catch {
      saveDraft(activeDraft)
      console.log(`\n  Progress saved (${activeDraft.qa_pairs.length} answers). Run /profile deep_setup to continue.\n`)
      return
    }

    if (QUIT_WORDS.has(answer.toLowerCase())) {
      saveDraft(activeDraft)
      console.log(`\n  Progress saved (${activeDraft.qa_pairs.length} questions answered).`)
      if (activeDraft.qa_pairs.length >= 3) {
        let compileNow = 'n'
        try { compileNow = (await promptFn('\n  Compile a partial profile from what we have? (y/n) > ')).trim().toLowerCase() } catch {}
        if (compileNow === 'y' || compileNow === 'yes') {
          await compileAndSave(activeDraft, promptFn)
          return
        }
      }
      console.log('  Run /profile deep_setup to finish later.\n')
      return
    }

    activeDraft.qa_pairs.push({ question: response.text, answer })
    saveDraft(activeDraft)
  }

  await compileAndSave(activeDraft, promptFn)
}
