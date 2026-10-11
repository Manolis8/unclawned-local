import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Stopwords ───────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'but', 'not',
  'with', 'from', 'by', 'this', 'that', 'it', 'its', 'as',
  'he', 'she', 'they', 'we', 'you', 'i', 'me', 'my', 'our', 'your',
  'his', 'her', 'their', 'him', 'us', 'them', 'who', 'what', 'which',
  'when', 'where', 'why', 'how', 'all', 'each', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'only', 'same', 'so',
  'than', 'too', 'very', 'just', 'also', 'then', 'once', 'here', 'there',
  'if', 'because', 'while', 'although', 'though', 'about', 'above',
  'after', 'before', 'between', 'into', 'through', 'during', 'without',
  'within', 'along', 'following', 'across', 'behind', 'beyond', 'plus',
  'up', 'out', 'around', 'down', 'off', 'over', 'under', 'again',
  'any', 'get', 'got', 'let', 'use', 'used', 'using', 'make', 'made',
  'take', 'took', 'give', 'gave', 'go', 'went', 'come', 'came',
  'see', 'say', 'said', 'know', 'think', 'like', 'look', 'want',
  'well', 'back', 'even', 'still', 'way', 'new', 'good', 'old',
  'high', 'own', 'right', 'big', 'great', 'long', 'little', 'different',
  'now', 'always', 'often', 'every', 'much', 'many', 'first', 'last',
  'next', 'since', 'per', 'two', 'three', 'one', 'put', 'set',
])

// ─── Paste detection heuristics ──────────────────────────────────────────────

const PASTE_HEADER_PATTERNS = [
  /^from:\s/im,
  /^subject:\s/im,
  /^to:\s/im,
  /^date:\s/im,
  /^----+/m,
  /^===+/m,
]

function detectPastedContent(text: string): boolean {
  // Very long messages with email-style headers
  if (text.length > 800) {
    for (const pattern of PASTE_HEADER_PATTERNS) {
      if (pattern.test(text)) return true
    }
  }

  // Long unbroken blocks (>300 chars without newline = likely pasted paragraph)
  const wordCount = text.trim().split(/\s+/).length
  const hasLongBlock = /[^\n]{400,}/.test(text)
  if (wordCount > 200 && hasLongBlock) return true

  return false
}

// Take the user's own words: everything before a large paste block
function extractUserOwnedText(text: string): string {
  // If message contains a long block, take everything before it
  const longBlockMatch = /^([\s\S]{0,300}?)\n{0,2}[^\n]{400,}/m.exec(text)
  if (longBlockMatch) return longBlockMatch[1].trim()
  return text.slice(0, 200)
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NormalizedMessage {
  originalText: string
  normalizedText: string    // lowercased, stripped of URLs/code/markdown
  words: string[]           // meaningful words (stopwords removed)
  wordCount: number         // raw word count before stopword filtering
  charCount: number
  containsPastedContent: boolean
  userOwnedText: string     // text before any large paste block
  firstThird: string        // first 1/3 of normalizedText — used by hedging detector
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function normalizeMessage(text: string): NormalizedMessage {
  const originalText = text
  const charCount = text.length

  const containsPastedContent = detectPastedContent(text)
  const userOwnedText = containsPastedContent ? extractUserOwnedText(text) : text

  let normalized = text.toLowerCase()

  // Strip URLs
  normalized = normalized.replace(/https?:\/\/[^\s]+/g, ' ')
  // Strip emails
  normalized = normalized.replace(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/g, ' ')
  // Strip fenced code blocks
  normalized = normalized.replace(/```[\s\S]*?```/g, ' ')
  // Strip inline code
  normalized = normalized.replace(/`[^`\n]*`/g, ' ')
  // Strip markdown symbols
  normalized = normalized.replace(/[#*_~|>\\]/g, ' ')
  // Collapse whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim()

  const rawWords = normalized.split(' ').filter(w => w.length > 0)
  const wordCount = rawWords.length

  // Keep words that are 2+ chars and not stopwords
  const words = rawWords.filter(w => w.length >= 2 && !STOPWORDS.has(w))

  const firstThird = normalized.slice(0, Math.ceil(normalized.length / 3))

  return {
    originalText,
    normalizedText: normalized,
    words,
    wordCount,
    charCount,
    containsPastedContent,
    userOwnedText,
    firstThird,
  }
}
