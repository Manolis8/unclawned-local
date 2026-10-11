import readline from 'node:readline'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { db, uuid } from './db.js'

const RESUME_INTENT_PATH = join(homedir(), '.unclawned', 'resume-intent.json')

export interface CliSession {
  id: string
  user_id: string
  cwd: string
  title: string | null
  task_count: number
  started_at: string
  ended_at: string | null
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export function openCliSession(userId: string, cwd: string): string {
  const id = uuid()
  db.prepare(`
    INSERT INTO cli_sessions (id, user_id, cwd, started_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(id, userId, cwd)
  return id
}

export function closeCliSession(id: string): void {
  try {
    db.prepare(`UPDATE cli_sessions SET ended_at = datetime('now') WHERE id = ?`).run(id)
  } catch {}
}

export function incrementSessionTaskCount(id: string): void {
  try {
    db.prepare(`UPDATE cli_sessions SET task_count = task_count + 1 WHERE id = ?`).run(id)
  } catch {}
}

export function setSessionTitle(id: string, title: string): void {
  try {
    db.prepare(`UPDATE cli_sessions SET title = ? WHERE id = ?`).run(title, id)
  } catch {}
}

// ── Title generation (fire-and-forget after first task) ───────────────────────

export function generateSessionTitle(sessionId: string, firstPrompt: string): void {
  // Save a quick deterministic title immediately so resume always has something to show,
  // even if the user exits before the async LLM call completes.
  const quickTitle = firstPrompt.trim().split(/\s+/).slice(0, 5).join(' ').replace(/[.!?]+$/, '')
  setSessionTitle(sessionId, quickTitle)

  ;(async () => {
    try {
      const { resolveRuntime } = await import('./model-router.js')
      const rt = resolveRuntime()
      const res = await rt.fastClient.chat.completions.create({
        model: rt.modelFor('low'),
        max_tokens: 15,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: 'Generate a 3-5 word title summarizing this task. Return ONLY the title, no quotes, no punctuation at the end.',
          },
          { role: 'user', content: firstPrompt.slice(0, 300) },
        ],
      })
      const title = res.choices[0].message.content?.trim()
      if (title) setSessionTitle(sessionId, title)
    } catch {}
  })()
}

// ── Turn persistence ──────────────────────────────────────────────────────────

export type ConvRole = 'user' | 'assistant'
export interface ConvTurn { role: ConvRole; content: string }

export function saveSessionTurn(cliSessionId: string, role: ConvRole, content: string): void {
  try {
    db.prepare(`INSERT INTO session_turns (cli_session_id, role, content) VALUES (?, ?, ?)`).run(cliSessionId, role, content)
  } catch {}
}

export function loadSessionTurns(cliSessionId: string, limit = 30): ConvTurn[] {
  try {
    return db.prepare(`
      SELECT role, content FROM session_turns
      WHERE cli_session_id = ? AND active = 1
      ORDER BY id ASC LIMIT ?
    `).all(cliSessionId, limit) as ConvTurn[]
  } catch {
    return []
  }
}

function loadSessionTurnsWithIds(cliSessionId: string, limit = 200): Array<{ id: number; role: ConvRole; content: string }> {
  try {
    return db.prepare(`
      SELECT id, role, content FROM session_turns
      WHERE cli_session_id = ? AND active = 1
      ORDER BY id ASC LIMIT ?
    `).all(cliSessionId, limit) as Array<{ id: number; role: ConvRole; content: string }>
  } catch {
    return []
  }
}

function archiveSessionTurns(ids: number[]): void {
  if (ids.length === 0) return
  try {
    const placeholders = ids.map(() => '?').join(', ')
    db.prepare(`UPDATE session_turns SET active = 0 WHERE id IN (${placeholders})`).run(...ids)
  } catch {}
}

// Compacts the middle portion of the session's conversation into a single LLM-written summary.
// HEAD (first 4 turns) and TAIL (last 4 turns) are preserved verbatim; everything between is
// summarized and archived. Returns compaction stats, or null if there's nothing to compact.
// When the middle already contains a [COMPACTED SUMMARY] block, the LLM is instructed to UPDATE
// it (move items forward, drop stale content) rather than re-summarizing from scratch — this
// keeps the rolling summary accurate across many compactions instead of degrading over time.
export async function compactSessionTurns(
  sessionId: string
): Promise<{ compacted: number; total: number } | null> {
  const turns = loadSessionTurnsWithIds(sessionId, 200)
  if (turns.length < 8) return null

  const HEAD_SIZE = 4
  const TAIL_SIZE = 4
  const middle = turns.slice(HEAD_SIZE, turns.length - TAIL_SIZE)
  if (middle.length < 2) return null

  const hasPriorSummary = middle.some(t => t.content.startsWith('[COMPACTED SUMMARY]'))

  const serialized = middle
    .map(t => `${t.role === 'user' ? 'User' : 'Agent'}: ${t.content.slice(0, 1000)}`)
    .join('\n---\n')

  const { resolveRuntime } = await import('./model-router.js')
  const rt = resolveRuntime()

  const updateInstruction = hasPriorSummary
    ? `\nIMPORTANT: The input contains a [COMPACTED SUMMARY] block from a prior compaction. UPDATE it — move completed items to "Completed", drop resolved blockers, add new progress from the turns that follow it. Do NOT re-summarize it from scratch; treat it as the foundation.`
    : ''

  let summary: string
  try {
    const res = await rt.fastClient.chat.completions.create({
      model: rt.modelFor('medium'),
      max_tokens: 600,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `Compress this conversation section into a handoff summary.
Return ONLY the summary — no preamble, no greeting, no explanation.
Preserve the user's language; never translate.${updateInstruction}

## Active Task
[The most recent unresolved request from the user — quote verbatim if short]

## Completed
[Numbered: what was done and the outcome]

## Key Decisions
[Choices made and why]

## Resolved Q&A
[Questions answered — include the answer inline]

## State
[Anything in progress or blocked]`,
        },
        { role: 'user', content: serialized },
      ],
    })
    summary = res.choices[0].message.content?.trim() || ''
  } catch {
    return null
  }

  if (!summary) return null

  archiveSessionTurns(middle.map(t => t.id))
  db.prepare(
    `INSERT INTO session_turns (cli_session_id, role, content) VALUES (?, 'assistant', ?)`
  ).run(sessionId, `[COMPACTED SUMMARY]\n${summary}`)

  return { compacted: middle.length, total: turns.length }
}

export function countActiveSessionTurns(sessionId: string): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS cnt FROM session_turns WHERE cli_session_id = ? AND active = 1`
    ).get(sessionId) as { cnt: number }
    return row?.cnt ?? 0
  } catch {
    return 0
  }
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function getCliSessionById(id: string): CliSession | null {
  return db.prepare(`SELECT * FROM cli_sessions WHERE id = ?`).get(id) as CliSession | null
}

export function getLastCliSession(userId: string, cwd: string): CliSession | null {
  return db.prepare(`
    SELECT * FROM cli_sessions
    WHERE user_id = ? AND cwd = ? AND task_count > 0
    ORDER BY started_at DESC
    LIMIT 1
  `).get(userId, cwd) as CliSession | null
}

export function listCliSessions(userId: string, cwd: string | null, limit = 10): CliSession[] {
  if (cwd) {
    return db.prepare(`
      SELECT * FROM cli_sessions
      WHERE user_id = ? AND cwd = ? AND task_count > 0
      ORDER BY started_at DESC
      LIMIT ?
    `).all(userId, cwd, limit) as CliSession[]
  }
  return db.prepare(`
    SELECT * FROM cli_sessions
    WHERE user_id = ? AND task_count > 0
    ORDER BY started_at DESC
    LIMIT ?
  `).all(userId, limit) as CliSession[]
}

// ── Resume intent file ────────────────────────────────────────────────────────

export function saveResumeIntent(sessionId: string): void {
  try {
    mkdirSync(join(homedir(), '.unclawned'), { recursive: true })
    writeFileSync(RESUME_INTENT_PATH, JSON.stringify({ sessionId }))
  } catch {}
}

export function loadAndClearResumeIntent(): string | null {
  try {
    if (!existsSync(RESUME_INTENT_PATH)) return null
    const { sessionId } = JSON.parse(readFileSync(RESUME_INTENT_PATH, 'utf8'))
    unlinkSync(RESUME_INTENT_PATH)
    return sessionId || null
  } catch {
    return null
  }
}

// ── Context builder ───────────────────────────────────────────────────────────

export function buildSessionContext(sessionId: string): string {
  const session = db.prepare(`SELECT * FROM cli_sessions WHERE id = ?`).get(sessionId) as CliSession | null
  if (!session) return ''

  let tasks = db.prepare(`
    SELECT task_prompt, task_summary, task_type, outcome
    FROM agent_sessions
    WHERE cli_session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId) as any[]

  // Fallback: time-range query for sessions created before cli_session_id column was added
  if (!tasks.length) {
    const end = session.ended_at || new Date().toISOString().replace('T', ' ').slice(0, 19)
    tasks = db.prepare(`
      SELECT task_prompt, task_summary, task_type, outcome
      FROM agent_sessions
      WHERE user_id = ? AND created_at >= ? AND created_at <= ?
      ORDER BY created_at ASC LIMIT 20
    `).all(session.user_id, session.started_at, end) as any[]
  }

  const title = session.title || 'Previous session'
  const date = session.started_at.slice(0, 10)
  const W = 54

  const lines = [
    '╔══ RESUMED SESSION' + ': ' + title + ' · ' + date + ' ══',
  ]

  if (tasks.length) {
    lines.push(`║  ${tasks.length} task${tasks.length !== 1 ? 's' : ''} completed in previous session:`)
    lines.push('║')
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]
      lines.push(`║  [${i + 1}] ${t.task_prompt.slice(0, 80)}`)
      if (t.task_summary) {
        lines.push(`║       → ${t.task_summary.slice(0, 120)}`)
      }
    }
  } else {
    lines.push('║  (no task details available)')
  }
  lines.push('╚' + '═'.repeat(W))

  return lines.join('\n')
}

// ── Interactive picker (jarvis session_list) ──────────────────────────────────

function fmtDate(iso: string): string {
  const d = new Date(iso.replace(' ', 'T'))
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[d.getMonth()]} ${d.getDate()}  ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

/** Returns the picked session ID, or null if cancelled / no sessions. */
export async function showSessionPicker(cwd: string, showAll: boolean): Promise<string | null> {
  const sessions = listCliSessions('local', showAll ? null : cwd, 10)
  const LINE = '─'.repeat(57)

  if (!sessions.length) {
    const hint = showAll ? '' : ` for this folder (${cwd.replace(/\\/g, '/').split('/').at(-1)})`
    console.log('\n  No saved sessions found' + hint + '.\n')
    console.log('  Tip: run  jarvis session_list --all  to see sessions from all folders.\n')
    return null
  }

  const cwdLabel = cwd.replace(/\\/g, '/').split('/').at(-1) || cwd
  console.log('\n' + LINE)
  console.log(showAll ? '  Sessions (all folders)' : `  Sessions for: ${cwdLabel}`)
  console.log(LINE + '\n')

  sessions.forEach((s, i) => {
    const title = (s.title || '(untitled)').padEnd(32)
    const date  = fmtDate(s.started_at)
    const tasks = `${s.task_count} task${s.task_count !== 1 ? 's' : ''}`
    const folder = showAll ? `  · ${s.cwd.replace(/\\/g, '/').split('/').at(-1)}` : ''
    console.log(`  [${i + 1}]  ${date}  ${title}(${tasks})${folder}`)
  })

  console.log()

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise<string>(r =>
    rl.question('  Enter number to resume, or press Enter to cancel: ', a => { rl.close(); r(a.trim()) })
  )

  const idx = parseInt(answer, 10)
  if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
    return sessions[idx - 1].id
  }

  console.log('  Cancelled.\n')
  return null
}

// ── Resume by ID or last session ─────────────────────────────────────────────

export function getSessionContextById(sessionId: string): string | null {
  const ctx = buildSessionContext(sessionId)
  return ctx || null
}

export function getLastSessionContext(userId: string, cwd: string): string | null {
  const session = getLastCliSession(userId, cwd)
  if (!session) return null
  return buildSessionContext(session.id) || null
}
