import fs from 'fs'
import path from 'path'
import { JARVIS_DIR } from './soul.js'

export const MEMORY_MD_PATH = path.join(JARVIS_DIR, 'MEMORY.md')
export const MEMORY_MAX_CHARS = 3000
export const MEMORY_CAPACITY_THRESHOLD = 0.80

export type MemorySection =
  | 'ENVIRONMENT'
  | 'PROJECTS'
  | 'PEOPLE'
  | 'PLATFORM OBSERVATIONS'
  | 'VOICE OBSERVATIONS'
  | 'LESSONS'

export const ALL_SECTIONS: MemorySection[] = [
  'ENVIRONMENT',
  'PROJECTS',
  'PEOPLE',
  'PLATFORM OBSERVATIONS',
  'VOICE OBSERVATIONS',
  'LESSONS',
]

// ─── Init ─────────────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().split('T')[0]
}

const DEFAULT_MEMORY = `# MEMORY.md — Jarvis Working Memory
Last updated: ${todayIso()}

## [ENVIRONMENT]

## [PROJECTS]

## [PEOPLE]

## [PLATFORM OBSERVATIONS]

## [VOICE OBSERVATIONS]

## [LESSONS]
`

export function initMemoryMd(): void {
  fs.mkdirSync(JARVIS_DIR, { recursive: true })
  if (!fs.existsSync(MEMORY_MD_PATH)) {
    fs.writeFileSync(MEMORY_MD_PATH, DEFAULT_MEMORY, 'utf-8')
  }
}

export function loadMemoryMd(): string | null {
  if (!fs.existsSync(MEMORY_MD_PATH)) return null
  try {
    return fs.readFileSync(MEMORY_MD_PATH, 'utf-8').trim() || null
  } catch {
    return null
  }
}

export function saveMemoryMd(content: string): void {
  fs.mkdirSync(JARVIS_DIR, { recursive: true })
  fs.writeFileSync(MEMORY_MD_PATH, content, 'utf-8')
}

// ─── Section parsing ──────────────────────────────────────────────────────────

export type ParsedSections = Partial<Record<MemorySection, string>>

export function parseMemorySections(content: string): ParsedSections {
  const result: ParsedSections = {}
  const sectionRegex = /## \[([^\]]+)\]\s*\n([\s\S]*?)(?=## \[|$)/g
  let match: RegExpExecArray | null
  while ((match = sectionRegex.exec(content)) !== null) {
    const name = match[1].trim() as MemorySection
    const body = match[2].trim()
    if (ALL_SECTIONS.includes(name)) result[name] = body
  }
  return result
}

export function rebuildMemoryMd(sections: ParsedSections, updateDate = true): string {
  const header = `# MEMORY.md — Jarvis Working Memory\nLast updated: ${todayIso()}\n`
  const body = ALL_SECTIONS.map(s => `## [${s}]\n${sections[s] ?? ''}`).join('\n\n')
  return `${header}\n${body}\n`
}

// ─── Section update ───────────────────────────────────────────────────────────

export function appendToSection(section: MemorySection, entry: string): void {
  initMemoryMd()
  const raw = loadMemoryMd() ?? DEFAULT_MEMORY
  const sections = parseMemorySections(raw)
  const existing = sections[section] ?? ''
  sections[section] = existing ? `${existing}\n${entry}` : entry
  saveMemoryMd(rebuildMemoryMd(sections))
}

export function getSectionContent(section: MemorySection): string {
  const raw = loadMemoryMd()
  if (!raw) return ''
  const sections = parseMemorySections(raw)
  return sections[section] ?? ''
}

// ─── Capacity ─────────────────────────────────────────────────────────────────

export function isNearCapacity(): boolean {
  const raw = loadMemoryMd()
  if (!raw) return false
  return raw.length >= MEMORY_MAX_CHARS * MEMORY_CAPACITY_THRESHOLD
}

export function getCapacityPercent(): number {
  const raw = loadMemoryMd()
  if (!raw) return 0
  return Math.round((raw.length / MEMORY_MAX_CHARS) * 100)
}

// Trim the oldest project diary entries if [PROJECTS] section is too long.
// Simple strategy: keep the last N lines where N = half the current line count.
export function trimOldestProjectEntries(): void {
  const raw = loadMemoryMd()
  if (!raw) return
  const sections = parseMemorySections(raw)
  const projects = sections['PROJECTS'] ?? ''
  const lines = projects.split('\n').filter(l => l.trim())
  if (lines.length <= 4) return
  sections['PROJECTS'] = lines.slice(Math.floor(lines.length / 2)).join('\n')
  saveMemoryMd(rebuildMemoryMd(sections))
}

// ─── Staleness marking ────────────────────────────────────────────────────────

const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/

export function markStaleEntries(content: string, daysThreshold = 60): string {
  const now = Date.now()
  const threshold = daysThreshold * 24 * 60 * 60 * 1000
  return content
    .split('\n')
    .map(line => {
      // Skip lines that already have the stale marker or are section headers
      if (line.includes('(may be stale)') || line.startsWith('#')) return line
      const m = ISO_DATE_RE.exec(line)
      if (!m) return line
      const lineDate = new Date(m[1]).getTime()
      if (now - lineDate > threshold) {
        return line.replace(m[0], `${m[0]} (may be stale)`)
      }
      return line
    })
    .join('\n')
}

export function applyStaleMarking(): void {
  const raw = loadMemoryMd()
  if (!raw) return
  const marked = markStaleEntries(raw)
  if (marked !== raw) saveMemoryMd(marked)
}

// ─── Smart section selection ──────────────────────────────────────────────────

const PLATFORM_KEYWORDS = ['linkedin', 'twitter', 'gmail', 'instagram', 'facebook', 'x.com', 'youtube', 'reddit']
const WRITING_KEYWORDS = /\b(draft|write|compose|email|post|letter|proposal|reply|message|blog|article)\b/i

export function getRelevantMemoryContext(task: string, maxChars = 1200): string | null {
  const raw = loadMemoryMd()
  if (!raw) return null

  const sections = parseMemorySections(raw)
  const taskLower = task.toLowerCase()
  const selected: string[] = []
  let budget = maxChars

  // Always: LESSONS (small, high signal)
  if (sections['LESSONS']?.trim()) {
    const chunk = `[LESSONS]\n${sections['LESSONS']}`
    if (chunk.length <= budget) { selected.push(chunk); budget -= chunk.length }
  }

  // Writing task: VOICE OBSERVATIONS
  if (WRITING_KEYWORDS.test(task) && sections['VOICE OBSERVATIONS']?.trim()) {
    const chunk = `[VOICE OBSERVATIONS]\n${sections['VOICE OBSERVATIONS']}`
    if (chunk.length <= budget) { selected.push(chunk); budget -= chunk.length }
  }

  // Platform mentioned: PLATFORM OBSERVATIONS
  const mentionedPlatform = PLATFORM_KEYWORDS.find(p => taskLower.includes(p))
  if (mentionedPlatform && sections['PLATFORM OBSERVATIONS']?.trim()) {
    const chunk = `[PLATFORM OBSERVATIONS]\n${sections['PLATFORM OBSERVATIONS']}`
    if (chunk.length <= budget) { selected.push(chunk); budget -= chunk.length }
  }

  // Person name detected (capitalized word not at sentence start, matches entry in PEOPLE)
  if (sections['PEOPLE']?.trim()) {
    const properNouns: string[] = task.match(/\b[A-Z][a-z]{2,}\b/g) ?? []
    const peopleContent: string = sections['PEOPLE'] ?? ''
    const hasPerson = properNouns.some((n: string) => peopleContent.toLowerCase().includes(n.toLowerCase()))
    if (hasPerson) {
      const chunk = `[PEOPLE]\n${sections['PEOPLE']}`
      if (chunk.length <= budget) { selected.push(chunk); budget -= chunk.length }
    }
  }

  // Project reference: PROJECTS
  if (sections['PROJECTS']?.trim()) {
    const projectWords = task.split(/\s+/).filter((w: string) => w.length > 4)
    const projectContent = sections['PROJECTS']
    const hasProject = projectWords.some(w => projectContent.toLowerCase().includes(w.toLowerCase()))
    if (hasProject) {
      const chunk = `[PROJECTS]\n${sections['PROJECTS']}`
      if (chunk.length <= budget) { selected.push(chunk); budget -= chunk.length }
    }
  }

  // ENVIRONMENT only for local-only tasks or if budget allows
  if (sections['ENVIRONMENT']?.trim() && budget > 200) {
    selected.push(`[ENVIRONMENT]\n${sections['ENVIRONMENT']}`)
  }

  if (selected.length === 0) return null
  return selected.join('\n\n')
}

// ─── Known people utilities ───────────────────────────────────────────────────

export interface KnownPerson {
  name: string
  date: string
  line: string
  isStale: boolean
}

export function getKnownPeople(): KnownPerson[] {
  const content = getSectionContent('PEOPLE')
  if (!content.trim()) return []

  const now = Date.now()
  const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000

  return content
    .split('\n')
    .filter(l => l.trim())
    .map(line => {
      const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/)
      if (!dateMatch) return null
      const date = dateMatch[1]
      // Name is the text after the date prefix, before the first ( or — character
      const afterDate = line.replace(/^\d{4}-\d{2}-\d{2}:?\s*/, '')
      const nameMatch = afterDate.match(/^([A-Z][^(—\n]+?)(?=\s*[(—]|$)/)
      const name = nameMatch?.[1]?.trim() ?? ''
      if (!name) return null
      const isStale = (now - new Date(date).getTime()) > SIXTY_DAYS
      return { name, date, line, isStale }
    })
    .filter((p): p is KnownPerson => p !== null)
}

// Returns first known person whose full name appears in the task string.
// Only matches multi-word names to avoid false positives on common first names.
export function findKnownPersonInTask(task: string, people: KnownPerson[]): KnownPerson | null {
  const taskLower = task.toLowerCase()
  for (const person of people) {
    if (person.name.includes(' ') && taskLower.includes(person.name.toLowerCase())) {
      return person
    }
  }
  return null
}

// ─── Section breakdown for /memory display ────────────────────────────────────

export function getMemoryStats(): Array<{ section: MemorySection; lines: number; chars: number }> {
  const raw = loadMemoryMd()
  if (!raw) return ALL_SECTIONS.map(s => ({ section: s, lines: 0, chars: 0 }))
  const sections = parseMemorySections(raw)
  return ALL_SECTIONS.map(s => {
    const content = sections[s] ?? ''
    return {
      section: s,
      lines: content.split('\n').filter(l => l.trim()).length,
      chars: content.length,
    }
  })
}
