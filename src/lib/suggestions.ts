import fs from 'fs'
import path from 'path'
import { JARVIS_DIR } from './soul.js'
import { db } from './db.js'

export const SUGGESTIONS_MD_PATH = path.join(JARVIS_DIR, 'SUGGESTIONS.md')
const MAX_ACTIVE = 3
const STALE_DAYS = 30

export interface Suggestion {
  id: string
  date: string
  text: string
  trigger: string
}

function todayIso(): string {
  return new Date().toISOString().split('T')[0]
}

function genId(): string {
  return Math.random().toString(36).slice(2, 6)
}

export function initSuggestionsMd(): void {
  fs.mkdirSync(JARVIS_DIR, { recursive: true })
  if (!fs.existsSync(SUGGESTIONS_MD_PATH)) {
    fs.writeFileSync(
      SUGGESTIONS_MD_PATH,
      `# Jarvis Suggestions\nLast updated: ${todayIso()}\n\n## [ACTIVE]\n\n## [ARCHIVED]\n`,
      'utf-8'
    )
  }
}

function loadRaw(): string {
  if (!fs.existsSync(SUGGESTIONS_MD_PATH)) initSuggestionsMd()
  return fs.readFileSync(SUGGESTIONS_MD_PATH, 'utf-8')
}

function saveRaw(content: string): void {
  fs.mkdirSync(JARVIS_DIR, { recursive: true })
  const updated = content.replace(/^Last updated: .+$/m, `Last updated: ${todayIso()}`)
  fs.writeFileSync(SUGGESTIONS_MD_PATH, updated, 'utf-8')
}

// Entry format: [id4] YYYY-MM-DD — text (trigger: reason)
const ENTRY_RE = /^\[([a-z0-9]{4})\] (\d{4}-\d{2}-\d{2}) — (.+?) \(trigger: (.+?)\)$/

function parseActive(raw: string): Suggestion[] {
  const section = raw.match(/## \[ACTIVE\]\n([\s\S]*?)(?=## \[ARCHIVED\]|$)/)?.[1] ?? ''
  return section
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const m = ENTRY_RE.exec(line)
      if (!m) return null
      return { id: m[1], date: m[2], text: m[3], trigger: m[4] }
    })
    .filter((s): s is Suggestion => s !== null)
}

export function loadSuggestions(): Suggestion[] {
  return parseActive(loadRaw())
}

const ARCHIVED_RE = /^\[([a-z0-9]{4})\] (\d{4}-\d{2}-\d{2}) \(archived (\d{4}-\d{2}-\d{2})\) — (.+?) \(trigger: (.+?)\)$/

export interface ArchivedSuggestion extends Suggestion {
  archivedDate: string
}

export function loadArchivedSuggestions(): ArchivedSuggestion[] {
  const raw = loadRaw()
  const section = raw.match(/## \[ARCHIVED\]\n([\s\S]*?)$/)?.[1] ?? ''
  return section
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const m = ARCHIVED_RE.exec(line)
      if (!m) return null
      return { id: m[1], date: m[2], archivedDate: m[3], text: m[4], trigger: m[5] }
    })
    .filter((s): s is ArchivedSuggestion => s !== null)
}

export function getPendingSuggestionCount(): number {
  return loadSuggestions().length
}

export function hasPendingSuggestions(): boolean {
  return getPendingSuggestionCount() > 0
}

export function addSuggestion(text: string, trigger: string): boolean {
  initSuggestionsMd()
  const raw = loadRaw()
  const active = parseActive(raw)
  if (active.length >= MAX_ACTIVE) return false
  // Skip exact duplicate (by text prefix)
  const norm = (s: string) => s.toLowerCase().slice(0, 60)
  if (active.some(s => norm(s.text) === norm(text))) return false

  const id = genId()
  const entry = `[${id}] ${todayIso()} — ${text} (trigger: ${trigger})`
  saveRaw(raw.replace('## [ACTIVE]\n', `## [ACTIVE]\n${entry}\n`))
  return true
}

export function dismissSuggestion(id: string): boolean {
  initSuggestionsMd()
  const raw = loadRaw()
  const active = parseActive(raw)
  const target = active.find(s => s.id === id)
  if (!target) return false

  const archiveEntry = `[${target.id}] ${target.date} (archived ${todayIso()}) — ${target.text} (trigger: ${target.trigger})`
  // Remove from ACTIVE, append to ARCHIVED
  const withoutEntry = raw.replace(new RegExp(`\\[${target.id}\\][^\n]+\n`), '')
  saveRaw(withoutEntry.replace('## [ARCHIVED]\n', `## [ARCHIVED]\n${archiveEntry}\n`))
  return true
}

export function archiveStale(): number {
  initSuggestionsMd()
  const raw = loadRaw()
  const active = parseActive(raw)
  const now = Date.now()
  const threshold = STALE_DAYS * 24 * 60 * 60 * 1000
  let current = raw
  let count = 0

  for (const s of active) {
    if (now - new Date(s.date).getTime() > threshold) {
      const archiveEntry = `[${s.id}] ${s.date} (archived ${todayIso()}) — ${s.text} (trigger: ${s.trigger})`
      current = current.replace(new RegExp(`\\[${s.id}\\][^\n]+\n`), '')
      current = current.replace('## [ARCHIVED]\n', `## [ARCHIVED]\n${archiveEntry}\n`)
      count++
    }
  }

  if (count > 0) saveRaw(current)
  return count
}

// ─── Repetition trigger ───────────────────────────────────────────────────────

export function checkRepetitionTrigger(taskPrompt: string, userId: string): string | null {
  try {
    const prefix = taskPrompt.toLowerCase().trim().slice(0, 40).replace(/%/g, '')
    const row = db.prepare(`
      SELECT COUNT(*) as c FROM agent_sessions
      WHERE user_id = ? AND lower(task_prompt) LIKE ?
      AND created_at >= datetime('now', '-30 days')
    `).get(userId, `${prefix}%`) as any
    // Exactly 3 — fire once when count hits the threshold
    if (row?.c === 3) return taskPrompt
    return null
  } catch {
    return null
  }
}
