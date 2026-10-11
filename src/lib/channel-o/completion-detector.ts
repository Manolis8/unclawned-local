export type AchievementType = 'raised' | 'shipped' | 'closed' | 'hired' | 'completed'

export interface DetectedAchievement {
  type: AchievementType
  text: string      // cleaned achievement description (≤ 150 chars)
  trigger: string   // pattern that matched
}

// ─── Trigger vocabulary ───────────────────────────────────────────────────────
// Checked in priority order: raised → shipped → closed → hired → completed

const TRIGGERS: Record<AchievementType, string[]> = {
  raised: [
    'closed the round', 'closed our series', 'closed their series', 'funding came through',
    'we raised', 'just raised', 'raised our', 'round closed', 'term sheet signed',
    'got funded', 'raised the round', 'series a closed', 'series b closed', 'seed closed',
  ],
  shipped: [
    'just shipped', 'finally shipped', "we shipped", 'shipped it', 'went live', 'now live',
    'just launched', 'finally launched', 'just deployed', 'deployed it',
    'shipped the', 'launched the', 'deployed the', 'released the', 'pushed it live',
    "it's live", 'is now live', 'just went live', 'officially live',
  ],
  closed: [
    'just closed', 'closed the deal', 'won the deal', 'landed the deal', 'they signed',
    'we got the contract', 'deal is done', 'deal closed', 'they agreed to',
    'we won the pitch', 'signed the contract', 'signed the deal', 'closed on',
    'they came through', 'they said yes', 'we got the deal',
  ],
  hired: [
    'just hired', 'joined the team', 'offer accepted', 'they accepted the offer',
    'made our first hire', 'hired our first', 'new hire started', 'signed the offer',
    'officially on board', 'officially joined us', 'first employee',
  ],
  completed: [
    'finally done', 'finished it', 'wrapped it up', 'we did it', 'we made it',
    "it's done", 'all done', 'completed the', 'finished the', 'wrapped up the',
    'we won', 'we pulled it off', 'it worked', 'it landed', 'landed well',
    'came through', 'just finished',
  ],
}

// ─── Celebratory language patterns (boost confidence in completion) ───────────

const CELEBRATION_PATTERNS = [
  /\bfinally\b/i, /\bjust\b.{0,20}(shipped|closed|launched|raised|hired|done|live)/i,
  /we did it/i, /we made it/i, /it worked/i, /it('s| is) live/i,
  /!!/, /🎉/, /🚀/, /\bwoo+\b/i, /\byay\b/i,
]

export function isCelebratoryTone(message: string): boolean {
  return CELEBRATION_PATTERNS.some(p => p.test(message))
}

// ─── Achievement text extraction ──────────────────────────────────────────────

function extractAchievementText(message: string, trigger: string): string {
  const lower = message.toLowerCase()
  const idx = lower.indexOf(trigger)
  if (idx === -1) return message.slice(0, 100).trim()

  // Find sentence start (last sentence boundary before the trigger)
  let start = 0
  for (const sep of ['. ', '! ', '? ', '\n']) {
    const pos = message.lastIndexOf(sep, idx)
    if (pos !== -1) start = Math.max(start, pos + sep.length)
  }

  // Find sentence end (first boundary after trigger + match)
  let end = message.length
  const afterTrigger = idx + trigger.length
  for (const sep of ['.', '!', '?', '\n']) {
    const pos = message.indexOf(sep, afterTrigger)
    if (pos !== -1) end = Math.min(end, pos + 1)
  }

  const sentence = message.slice(start, end).trim()
  // Strip leading filler
  return sentence.replace(/^(anyway,?\s*|oh,?\s*|so,?\s*|btw,?\s*|fyi,?\s*|update[:\s]+)/i, '').trim().slice(0, 150)
}

// ─── Main detector ────────────────────────────────────────────────────────────

export function detectCompletion(message: string): DetectedAchievement | null {
  const lower = message.toLowerCase()

  for (const type of ['raised', 'shipped', 'closed', 'hired', 'completed'] as AchievementType[]) {
    for (const trigger of TRIGGERS[type]) {
      if (lower.includes(trigger)) {
        const text = extractAchievementText(message, trigger)
        return { type, text, trigger }
      }
    }
  }

  return null
}

// ─── Past-tense reference detection ──────────────────────────────────────────
// "the campaign we ran last month", "the raise we did in Q1"
// These signal that something previously in-progress is now complete.

const PAST_COMPLETION_PATTERNS = [
  /the (.{5,40}) we (ran|did|launched|shipped|closed|raised|sent|wrote|built) (last|back in|in q|earlier|a few)/i,
  /when we (shipped|launched|closed|raised|hired|finished|wrapped up) (.{5,50})/i,
  /after (closing|shipping|launching|raising|finishing) (.{5,50})/i,
]

export function detectPastReference(message: string): string | null {
  for (const pattern of PAST_COMPLETION_PATTERNS) {
    const m = message.match(pattern)
    if (m) return m[0].slice(0, 150)
  }
  return null
}
