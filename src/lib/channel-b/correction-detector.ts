import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface CorrectionPatterns {
  continuation_references: string[]
  correction_strong: string[]
  correction_structural: string[]
  correction_discard: string[]
  non_correction_starters: string[]
  context_provision_markers: string[]
}

let _patterns: CorrectionPatterns | null = null

function getPatterns(): CorrectionPatterns {
  if (!_patterns) {
    const raw = readFileSync(join(__dirname, '../../data/correction-patterns.json'), 'utf8')
    _patterns = JSON.parse(raw)
  }
  return _patterns!
}

// ─── Stage 1: Topic continuity ────────────────────────────────────────────────
//
// Returns true if the current message is about the prior agent output
// (as opposed to a completely new unrelated request).
//
// Order matters: correction signals override new-task starters, so "can you fix
// the tone?" is correctly identified as a continuation even though it starts with
// the new-task starter "can you".

export function detectContinuation(currentMsg: string, _priorAssistantMsg: string): boolean {
  const p = getPatterns()
  const lower = currentMsg.toLowerCase().trim()
  const words = lower.split(/\s+/).filter(Boolean)

  // Explicit output references → definite continuation
  for (const ref of p.continuation_references) {
    if (lower.includes(ref)) return true
  }

  // Any correction signal → continuation (checked before new-task starters
  // so "can you fix the tone?" doesn't get blocked by "can you")
  const allCorrectionPhrases = [
    ...p.correction_strong,
    ...p.correction_structural,
    ...p.correction_discard,
  ]
  if (allCorrectionPhrases.some(phrase => lower.includes(phrase))) return true

  // New-task starters with no correction signal → new task
  const firstFiveWords = words.slice(0, 5).join(' ')
  for (const starter of p.non_correction_starters) {
    if (firstFiveWords.startsWith(starter)) return false
  }

  // Short message with no new-task starters → probably continuation
  return words.length < 40
}

// ─── Stage 2: Correction intent ──────────────────────────────────────────────
//
// Called only when detectContinuation() returned true.
// Returns false for context provision (user providing background info, not asking
// for a change), which is a common false-positive trap.

export interface CorrectionResult {
  isCorrection: boolean
  phrases: string[]
}

export function detectCorrection(currentMsg: string): CorrectionResult {
  const p = getPatterns()
  const lower = currentMsg.toLowerCase()

  // Context provision negates correction intent:
  // "here's the background, write an email" is a new task, not a correction
  for (const marker of p.context_provision_markers) {
    if (lower.includes(marker)) return { isCorrection: false, phrases: [] }
  }

  const allPhrases = [
    ...p.correction_strong,
    ...p.correction_structural,
    ...p.correction_discard,
  ]
  const matched = allPhrases.filter(phrase => lower.includes(phrase))

  return { isCorrection: matched.length > 0, phrases: matched }
}

// ─── Stage 3: Correction level (1–5) ─────────────────────────────────────────
//
// Called only when detectCorrection() returned isCorrection = true.
// Levels: 1=word swap, 2=sentence rewrite, 3=structural, 4=full rewrite, 5=discard.

export function classifyCorrectionLevel(
  currentMsg: string,
  priorTaskType: string | null,
  priorResponseLength: number
): 1 | 2 | 3 | 4 | 5 {
  const p = getPatterns()
  const lower = currentMsg.toLowerCase()
  const wordCount = currentMsg.trim().split(/\s+/).filter(Boolean).length

  // Level 5 — explicit discard, short message
  if (p.correction_discard.some(phrase => lower.includes(phrase)) && wordCount < 15) return 5

  // Level 3 — structural correction (order, format, layout)
  if (p.correction_structural.some(phrase => lower.includes(phrase))) return 3

  // Level 4 — user provides their own written version
  // Requires: long message, low instruction density, prior was an output task
  if (currentMsg.length > 200 && wordCount > 40) {
    const instructionDensity = countInstructionWords(lower) / wordCount
    const isOutputTask = priorTaskType === 'write' || priorTaskType === 'review'
    if (instructionDensity < 0.12 && isOutputTask) return 4
  }

  // Level 2 — sentence-level correction (references a specific part)
  if (wordCount >= 12 && wordCount <= 80) {
    if (p.continuation_references.some(ref => lower.includes(ref))) return 2
  }

  // Level 1 — word swap / minor preference tweak
  return 1
}

function countInstructionWords(lower: string): number {
  const words = [
    'change', 'make', 'add', 'remove', 'fix', 'adjust', 'update',
    'replace', 'move', 'put', "don't", 'avoid', 'instead',
    'can you', 'could you', 'please', 'try', 'keep', 'drop',
    'reword', 'shorten', 'rephrase',
  ]
  return words.filter(w => lower.includes(w)).length
}
