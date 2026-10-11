// F.1/F.3 — extract person name mentions with tone + reference style from a message

const TONE_POSITIVE = [
  'great', 'love', 'excellent', 'appreciate', 'trust', 'valuable', 'amazing', 'helpful',
  'brilliant', 'excited', 'happy', 'thankful', 'impressed', 'glad', 'proud', 'respect',
  'recommended', 'introduced', 'excited to work', 'good meeting',
]
const TONE_NEGATIVE = [
  'problem', 'issue', 'frustrated', 'concerned', 'worried', 'disappointed', 'failed',
  'blocked', 'ghosted', 'ghosting', 'slow', 'unreliable', 'missed', 'cancelled', 'no response',
  'haven\'t heard', 'hasn\'t responded', 'pushed back', 'rejected', 'difficult',
]
const TONE_URGENT = [
  'asap', 'urgent', 'deadline', 'waiting for', 'overdue', 'critical', 'need response',
  'follow up', 'following up', 'time sensitive', 'by end of', 'need to hear',
]

// Role-title markers that indicate non-casual reference or distancing language
const ROLE_TITLE_PREFIXES = [
  'my ', 'our ', 'the ', 'this '
]
const ROLE_NOUNS = [
  'investor', 'advisor', 'partner', 'client', 'customer', 'colleague', 'boss', 'manager',
  'cto', 'ceo', 'co-founder', 'cofounder', 'founder', 'lawyer', 'accountant', 'mentor',
  'coach', 'board member', 'lead', 'contact', 'friend', 'teammate', 'employee',
  'contractor', 'vendor', 'vp', 'director', 'head of',
]

// Sentence-start words that look capitalized but aren't person names
const NOT_NAMES = new Set([
  'I', 'We', 'They', 'He', 'She', 'It', 'This', 'That', 'The', 'A', 'An',
  'Also', 'Now', 'Then', 'Actually', 'Basically', 'Just', 'So', 'But', 'And',
  'Ok', 'Okay', 'Hi', 'Hey', 'Yes', 'No', 'Sure', 'Thanks', 'Thank', 'Please',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December',
  'LinkedIn', 'Google', 'Facebook', 'Twitter', 'GitHub', 'Slack', 'Notion',
])

export type Tone = 'positive' | 'negative' | 'urgent' | 'neutral'
export type ReferenceStyle = 'first_name' | 'full_name' | 'role_title' | 'distancing'

export interface PersonMention {
  personName: string
  contextExcerpt: string
  tone: Tone
  referenceStyle: ReferenceStyle
}

function getToneInWindow(lower: string, nameIdx: number): Tone {
  const window = lower.slice(Math.max(0, nameIdx - 80), nameIdx + 80)
  if (TONE_URGENT.some(k => window.includes(k))) return 'urgent'
  if (TONE_NEGATIVE.some(k => window.includes(k))) return 'negative'
  if (TONE_POSITIVE.some(k => window.includes(k))) return 'positive'
  return 'neutral'
}

function detectReferenceStyle(text: string, name: string, nameIdx: number): ReferenceStyle {
  const before = text.slice(Math.max(0, nameIdx - 15), nameIdx).toLowerCase()
  // "my Sarah" / "our advisor Sarah" / just a role without a name attached
  if (ROLE_TITLE_PREFIXES.some(p => before.endsWith(p)) && ROLE_NOUNS.some(r => before.includes(r))) {
    return 'role_title'
  }
  // Distancing: using a collective noun with no personal name ("the fund", "the team")
  const lower = text.toLowerCase()
  const distancingPhrases = ['the fund', 'the team', 'the board', 'the company', 'the firm', 'the group']
  if (distancingPhrases.some(d => lower.includes(d)) && name.split(' ').length === 1) {
    return 'distancing'
  }
  // Multi-word name = full_name style
  if (name.split(' ').length >= 2) return 'full_name'
  return 'first_name'
}

export function extractMentions(message: string): PersonMention[] {
  const lower = message.toLowerCase()
  const found: PersonMention[] = []
  const seenNames = new Set<string>()

  // Extract multi-word proper names first (e.g. "Tom Baker", "Sarah Chen Winters")
  for (const m of message.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g)) {
    const name = m[1]
    // Skip if any word in the name is a NOT_NAMES entry
    const words = name.split(' ')
    if (words.some(w => NOT_NAMES.has(w))) continue
    if (seenNames.has(name)) continue
    seenNames.add(name)
    // Mark each word as claimed so single-word pass doesn't double-count
    words.forEach(w => seenNames.add(w))

    const idx = m.index!
    const contextExcerpt = message.slice(Math.max(0, idx - 30), idx + name.length + 30).trim()
    found.push({
      personName: name,
      contextExcerpt: contextExcerpt.slice(0, 80),
      tone: getToneInWindow(lower, idx),
      referenceStyle: detectReferenceStyle(message, name, idx),
    })
  }

  // Single-word proper names not already claimed
  for (const m of message.matchAll(/\b([A-Z][a-z]{2,})\b/g)) {
    const name = m[1]
    if (NOT_NAMES.has(name)) continue
    if (seenNames.has(name)) continue
    seenNames.add(name)

    const idx = m.index!
    const contextExcerpt = message.slice(Math.max(0, idx - 30), idx + name.length + 30).trim()
    found.push({
      personName: name,
      contextExcerpt: contextExcerpt.slice(0, 80),
      tone: getToneInWindow(lower, idx),
      referenceStyle: detectReferenceStyle(message, name, idx),
    })
  }

  return found
}

export function extractCoMentionMap(mentions: PersonMention[]): Record<string, string[]> {
  const names = mentions.map(m => m.personName)
  const map: Record<string, string[]> = {}
  for (const name of names) {
    map[name] = names.filter(n => n !== name)
  }
  return map
}
