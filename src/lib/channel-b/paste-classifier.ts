import { detectVocabularyTribeHits, type TribeHits } from '../channel-a/tribe-detector.js'

export type PasteType =
  | 'code'
  | 'email_thread'
  | 'data_numbers'
  | 'formal_document'
  | 'article_content'
  | 'external_writing'
  | 'unknown'

// ─── Main classifier (first match wins — order is specificity priority) ────────

export function classifyPaste(message: string): PasteType {
  if (hasCodePatterns(message))           return 'code'
  if (hasEmailPatterns(message))          return 'email_thread'
  if (hasDataPatterns(message))           return 'data_numbers'
  if (hasFormalDocumentPatterns(message)) return 'formal_document'
  if (hasArticlePatterns(message))        return 'article_content'
  if (hasExternalWritingPatterns(message)) return 'external_writing'
  return 'unknown'
}

// ─── Code ─────────────────────────────────────────────────────────────────────

function hasCodePatterns(text: string): boolean {
  if (/```[\s\S]*?```/.test(text)) return true

  const lines = text.split('\n')
  let codeLines = 0
  for (const line of lines) {
    const t = line.trim()
    if (
      /^(const|let|var|function |def |class |import |export |return |if \(|else \{|for \(|while \(|async |await |interface |type |enum )\b/.test(t) ||
      /[;{}]$/.test(t) ||
      /^\s*(\/\/|#|\/\*)/.test(line)
    ) codeLines++
  }
  return codeLines >= 3
}

// ─── Email thread ─────────────────────────────────────────────────────────────

function hasEmailPatterns(text: string): boolean {
  if (/^From:\s*.+@/im.test(text)) return true
  if (/^Subject:\s*.+/im.test(text) && /^(To:|From:|Date:)/im.test(text)) return true
  const quoteLines = text.split('\n').filter(l => l.trimStart().startsWith('>'))
  if (quoteLines.length >= 2) return true
  if (/On .{5,60} wrote:/i.test(text)) return true
  return false
}

// ─── Data / numbers ───────────────────────────────────────────────────────────

function hasDataPatterns(text: string): boolean {
  const pipeLines = text.split('\n').filter(l => l.includes('|'))
  if (pipeLines.length >= 2 && /\|.+\|.+\|/.test(text)) return true

  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length === 0) return false

  let highNumLines = 0
  for (const line of lines) {
    const nums = line.match(/\b\d[\d,.]*%?|\$\d+|\d+\.\d+/g) ?? []
    if (nums.length >= 3) highNumLines++
  }
  if (highNumLines >= 3) return true

  const csvLines = lines.filter(l => (l.match(/,/g) ?? []).length >= 3)
  if (csvLines.length >= 3) return true

  return false
}

// ─── Formal document ──────────────────────────────────────────────────────────

function hasFormalDocumentPatterns(text: string): boolean {
  if (/^(section\s+\d+|chapter\s+\d+|article\s+\d+)[:\s]/im.test(text)) return true
  const numberedHeadings = text.split('\n').filter(l => /^\d+\.\s+[A-Z]/.test(l.trim()))
  if (numberedHeadings.length >= 3) return true
  if (/(executive summary|table of contents|abstract\n|introduction\n|conclusion\n)/i.test(text)) return true
  return false
}

// ─── Article content ──────────────────────────────────────────────────────────

function hasArticlePatterns(text: string): boolean {
  if (/(according to|a study by|research from|per [a-z]+ \d{4}|cited in|published by)/i.test(text)) return true

  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0)
  const longParagraphs = paragraphs.filter(p => p.trim().split(/\s+/).length >= 80)
  if (longParagraphs.length >= 2) return true

  return false
}

// ─── External writing (register-based fallback) ───────────────────────────────

function hasExternalWritingPatterns(text: string): boolean {
  const sentences: string[] = text.match(/[^.!?]+[.!?]/g) ?? []
  if (sentences.length < 3) return false

  const avgWords = sentences.reduce((sum: number, s: string) => sum + s.trim().split(/\s+/).length, 0) / sentences.length
  if (avgWords > 25) return true

  const passiveMatches = (text.match(/\b(is|are|was|were|be|been|being)\s+\w+ed\b/g) ?? []).length
  if (passiveMatches >= 3) return true

  return false
}

// ─── Extract the pasted portion from the original message ─────────────────────
//
// userOwnedText is the text the user typed (from normalizer). The pasted
// portion is roughly everything after. Used to run tribe hits on pasted content
// WITHOUT contaminating the user's own vocabulary profile.

export function extractPastedPortion(originalMessage: string, userOwnedText: string): string {
  if (!userOwnedText || userOwnedText.trim().length === 0) return originalMessage

  const owned = userOwnedText.trim()
  const lowerMsg = originalMessage.toLowerCase()
  const lowerOwned = owned.toLowerCase()

  if (lowerMsg.startsWith(lowerOwned)) {
    return originalMessage.slice(owned.length).trim()
  }

  const idx = lowerMsg.indexOf(lowerOwned)
  if (idx !== -1) {
    return originalMessage.slice(idx + owned.length).trim()
  }

  // Fuzzy: match the last 5 words of userOwnedText
  const lastWords = lowerOwned.split(/\s+/).slice(-5).join(' ')
  if (lastWords.length > 15) {
    const fuzzyIdx = lowerMsg.lastIndexOf(lastWords)
    if (fuzzyIdx !== -1) {
      return originalMessage.slice(fuzzyIdx + lastWords.length).trim()
    }
  }

  return ''
}

// ─── Tribe hits on pasted content ────────────────────────────────────────────
//
// Channel A guards AGAINST paste contamination of tribe scores.
// Channel B EXPLOITS paste content to read the domain the user is working in.
// Pass containsPastedContent=false so the tribe detector searches the full
// pastedPortion text (we've already isolated it — no further guard needed).

export function getPastedTribeHits(pastedPortion: string): { hits: TribeHits; primaryTribe: string | null } {
  if (!pastedPortion || pastedPortion.trim().length < 20) {
    return { hits: {}, primaryTribe: null }
  }

  const lower = pastedPortion.toLowerCase()
  const words = lower.split(/\s+/).filter(w => w.length > 0)
  const hits = detectVocabularyTribeHits(lower, words, lower, false)

  let primaryTribe: string | null = null
  let maxHits = 0
  for (const [tribe, tribeHits] of Object.entries(hits)) {
    if (tribeHits.length > maxHits) {
      maxHits = tribeHits.length
      primaryTribe = tribe
    }
  }

  if (maxHits < 3) primaryTribe = null

  return { hits, primaryTribe }
}
