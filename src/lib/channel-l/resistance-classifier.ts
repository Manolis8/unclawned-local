export type ResistanceType = 'factual' | 'framing' | 'scope' | 'strategic'
export type AvoidanceType = 'capability' | 'skill' | 'priority' | 'emotional' | 'identity'

// ─── L.1 Resistance classification ───────────────────────────────────────────

const FACTUAL_PATTERNS = [
  "that's not correct", "that's not right", "that's wrong", "you got that wrong",
  "not accurate", "that's inaccurate", "that's false", "you're wrong",
  "that's not true", "wrong fact", "factually incorrect", "the fact is",
  "actually no,", "actually that's wrong", "incorrect —", "incorrect,",
  "no, that's", "nope, that",
]

const FRAMING_PATTERNS = [
  "that's not how i'd put it", "i wouldn't say it that way", "framing is off",
  "that's not how i see it", "not the right framing", "not the right word",
  "i'd frame it differently", "that's not my take", "not the right angle",
  "the word i'd use", "i see it differently", "that framing", "wrong framing",
  "the way i'd say it", "i'd describe it as", "more like a", "not really about",
]

const SCOPE_PATTERNS = [
  "that's too much", "too detailed", "too long", "too deep", "too complex",
  "too basic", "not enough detail", "not detailed enough", "too short",
  "oversimplified", "went too deep", "not deep enough", "that's way too",
  "could be shorter", "needs to be shorter", "needs more detail", "needs less",
  "way too long", "cut it down", "trim it", "expand on", "more than i need",
]

const STRATEGIC_PATTERNS = [
  "that's not the right move", "that's not the right approach", "wrong direction",
  "you're missing the point", "misses the context", "that's not what i'm going for",
  "not the right strategy", "you've misunderstood", "missed the point",
  "that's not my goal", "that's not what i need", "missing the bigger picture",
  "that won't work because", "you don't understand the", "missing the context",
  "wrong angle entirely", "not what i was asking", "that misses",
  "the real issue is", "the actual problem is", "what i'm actually trying",
]

export function classifyResistance(message: string): ResistanceType | null {
  const lower = message.toLowerCase()
  if (FACTUAL_PATTERNS.some(p => lower.includes(p))) return 'factual'
  if (FRAMING_PATTERNS.some(p => lower.includes(p))) return 'framing'
  if (SCOPE_PATTERNS.some(p => lower.includes(p))) return 'scope'
  if (STRATEGIC_PATTERNS.some(p => lower.includes(p))) return 'strategic'
  return null
}

// ─── Domain extraction ────────────────────────────────────────────────────────

const DOMAIN_KEYWORDS: [string, string[]][] = [
  ['email', ['email', 'outreach', 'cold email', 'message to']],
  ['writing', ['writing', 'draft', 'copy', 'content', 'post', 'article', 'blog', 'essay']],
  ['strategy', ['strategy', 'strategic', 'direction', 'roadmap', 'pivot', 'approach', 'positioning']],
  ['finance', ['finance', 'financial', 'budget', 'revenue', 'cost', 'pricing', 'valuation', 'raise', 'runway']],
  ['technical', ['technical', 'code', 'engineering', 'architecture', 'api', 'database', 'backend', 'frontend']],
  ['research', ['research', 'analysis', 'data', 'metrics', 'numbers', 'report', 'benchmark']],
  ['hiring', ['hiring', 'recruiting', 'candidate', 'team', 'role', 'headcount', 'offer']],
  ['sales', ['sales', 'pitch', 'deal', 'customer', 'prospect', 'conversion', 'pipeline', 'close']],
  ['design', ['design', 'ui', 'ux', 'interface', 'visual', 'layout', 'brand']],
]

export function extractDomain(message: string): string | null {
  const lower = message.toLowerCase()
  for (const [domain, keywords] of DOMAIN_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) return domain
  }
  return null
}

// ─── L.2 Avoidance classification ────────────────────────────────────────────

const PRIORITY_AVOIDANCE_PATTERNS = [
  "i've been meaning to", "keep putting off", "i need to finally",
  "been putting this off", "keep delaying", "been procrastinating",
  "keep meaning to", "been on my list", "still haven't", "never get around to",
  "i keep forgetting", "i keep avoiding", "always defer", "always push it",
  "never seem to", "i owe myself", "i know i should", "i should have done",
]

const SKILL_AVOIDANCE_PATTERNS = [
  "i don't know how to", "not sure how to approach", "i'm not good at",
  "i struggle with", "i'm bad at", "never figured out how to",
  "can never get right", "don't really understand", "not my strength",
  "i find this confusing", "i don't get how", "not sure where to start",
]

const CAPABILITY_AVOIDANCE_PATTERNS = [
  "i hate doing", "i always procrastinate on", "i dread", "never like doing",
  "i avoid", "i find it painful", "i find it tedious", "i loathe",
  "i can't stand", "makes me want to", "i detest", "i find it boring",
  "so tedious", "so painful", "so annoying to",
]

const EMOTIONAL_AVOIDANCE_TRIGGERS = [
  'difficult conversation', 'hard conversation', 'uncomfortable conversation',
  'bad news', 'breaking up with', 'letting someone go', 'fire someone',
  'firing', 'lay off', 'layoff', 'reject', 'rejection letter', 'turn someone down',
  'say no to', 'awkward conversation', 'apology email', 'i owe someone an apology',
  'hard to say', 'hard to tell', "don't want to hurt", 'hard email to write',
  'tough email', 'dreading writing', 'been avoiding writing',
]

const IDENTITY_AVOIDANCE_PATTERNS = [
  "not really a", "isn't really my thing", "i don't really do",
  "not the type to", "i'm not a", "never been a",
  "that's not me", "not my style", "not who i am",
  "i'm not really into", "that kind of thing isn't me",
]

export function classifyAvoidance(message: string): AvoidanceType | null {
  const lower = message.toLowerCase()
  if (PRIORITY_AVOIDANCE_PATTERNS.some(p => lower.includes(p))) return 'priority'
  if (EMOTIONAL_AVOIDANCE_TRIGGERS.some(p => lower.includes(p))) return 'emotional'
  if (CAPABILITY_AVOIDANCE_PATTERNS.some(p => lower.includes(p))) return 'capability'
  if (SKILL_AVOIDANCE_PATTERNS.some(p => lower.includes(p))) return 'skill'
  if (IDENTITY_AVOIDANCE_PATTERNS.some(p => lower.includes(p))) return 'identity'
  return null
}

// ─── L.3 Kept work detection ──────────────────────────────────────────────────

const KEPT_WORK_PATTERNS = [
  'i already sent', 'i already handled', 'i took care of', 'i handled it',
  'i did it myself', 'i sorted it out', 'nevermind i did it', 'never mind i did',
  'already done', 'i just did it', 'i already did', 'did it myself',
  'i sent it already', 'i figured it out', 'i took care of the',
  "don't worry i", 'i went ahead and', 'i just went ahead',
  'i already wrote', 'i already sent it', 'i handled the',
]

export function detectKeptWork(message: string): boolean {
  const lower = message.toLowerCase()
  return KEPT_WORK_PATTERNS.some(p => lower.includes(p))
}
