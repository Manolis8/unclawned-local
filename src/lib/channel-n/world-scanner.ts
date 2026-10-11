export type EntityType = 'company' | 'person'
export type EventType = 'funding' | 'launch' | 'personnel' | 'news'

export interface DetectedEntity {
  name: string
  type: EntityType
}

export interface DetectedEvent {
  entityName: string
  eventType: EventType
  headline: string
}

// ─── Common words that happen to start capitalized ────────────────────────────

const SKIP_WORDS = new Set([
  'The', 'This', 'That', 'These', 'Those', 'There', 'Here', 'When', 'Where',
  'What', 'Which', 'How', 'Why', 'Who', 'We', 'You', 'He', 'She', 'They',
  'Our', 'Your', 'His', 'Her', 'Their', 'And', 'But', 'Or', 'So', 'Yet',
  'For', 'Nor', 'As', 'If', 'In', 'On', 'At', 'To', 'Of', 'By', 'From',
  'With', 'About', 'Would', 'Could', 'Should', 'Will', 'Can', 'Has', 'Have',
  'Had', 'Did', 'Does', 'Do', 'Am', 'Are', 'Was', 'Were', 'Be', 'Been',
  'Also', 'Very', 'Just', 'Not', 'Still', 'Even', 'Then', 'Than', 'Most',
  'Some', 'Before', 'After', 'While', 'Since', 'Although', 'Because',
  'However', 'Therefore', 'Instead', 'Actually', 'Basically', 'Today',
  'Yesterday', 'Tomorrow', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
  'Friday', 'Saturday', 'Sunday', 'Both', 'Each', 'Neither', 'Either', 'January', 'February', 'March', 'April',
  'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
])

// ─── Event trigger vocabulary ─────────────────────────────────────────────────

const EVENT_TRIGGERS: Record<EventType, string[]> = {
  funding: [
    'raised', 'raise', 'raising', 'funded', 'funding', 'investment', 'invested',
    'closed round', 'closed a round', 'series a', 'series b', 'series c',
    'seed round', 'secured', 'announced round', 'just raised', 'new round',
  ],
  launch: [
    'launched', 'released', 'shipped', 'announced', 'unveiled', 'introduced',
    'dropped', 'just launched', 'just released', 'just shipped', 'new product',
    'new feature', 'went live', 'now available',
  ],
  personnel: [
    'joined', 'hired', 'promoted', 'became', 'named as', 'appointed',
    'left', 'departed', 'resigned', 'stepping down', 'now at', 'just joined',
    'recently joined', 'became cto', 'became ceo', 'new role',
  ],
  news: [
    'acquired', 'acquisition', 'merged with', 'merger', 'shut down', 'closed down',
    'went public', 'ipo', 'listed', 'partnership with', 'deal with',
  ],
}

function detectEventType(window: string): EventType | null {
  const lower = window.toLowerCase()
  for (const [type, triggers] of Object.entries(EVENT_TRIGGERS)) {
    if (triggers.some(t => lower.includes(t))) return type as EventType
  }
  return null
}

// ─── Proper noun extraction ───────────────────────────────────────────────────

const PERSON_CUES = [
  'ceo', 'cto', 'cpo', 'coo', 'vp', 'founder', 'cofounder', 'co-founder',
  'partner', 'head of', 'director', 'officer', 'chairman', 'president',
]

function classifyEntityType(name: string, context: string): EntityType {
  const lower = context.toLowerCase()
  if (PERSON_CUES.some(c => lower.includes(c))) {
    if (/^[A-Z][a-z]+ [A-Z][a-z]+/.test(name)) return 'person'
  }
  if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(name)) return 'person'
  return 'company'
}

export function extractProperNouns(message: string): string[] {
  const result: string[] = []
  const wordMatches = [...message.matchAll(/\b([A-Z][a-z]{2,})\b/g)]

  for (let i = 0; i < wordMatches.length; i++) {
    const m = wordMatches[i]
    const word = m[1]
    if (SKIP_WORDS.has(word)) continue

    const idx = m.index ?? 0
    const next = wordMatches[i + 1]

    if (next && (next.index ?? 0) === idx + word.length + 1 && !SKIP_WORDS.has(next[1])) {
      result.push(`${word} ${next[1]}`)
      i++
    } else {
      result.push(word)
    }
  }

  return [...new Set(result)]
}

export function detectWorldEvents(message: string): DetectedEvent[] {
  const events: DetectedEvent[] = []
  const entities = extractProperNouns(message)

  for (const entity of entities) {
    const entityIdx = message.indexOf(entity)
    if (entityIdx === -1) continue

    const window = message.slice(Math.max(0, entityIdx - 40), Math.min(message.length, entityIdx + 120))
    const eventType = detectEventType(window)
    if (!eventType) continue

    const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const sentenceMatch = message.match(new RegExp(`[^.!?]*\\b${escaped}\\b[^.!?]*`, 'i'))
    const headline = (sentenceMatch?.[0] ?? `${entity} — ${eventType}`).trim().slice(0, 200)

    events.push({ entityName: entity, eventType, headline })
  }

  return events
}

export function extractWatchlistEntities(message: string): DetectedEntity[] {
  const entities = extractProperNouns(message)
  return entities.map(name => {
    const idx = message.indexOf(name)
    const context = message.slice(Math.max(0, idx - 60), Math.min(message.length, idx + 60))
    return { name, type: classifyEntityType(name, context) }
  })
}

// ─── Relevance scoring ────────────────────────────────────────────────────────
// Criterion 1: entity is in user's relationship graph / focus (mentions_count)
// Criterion 2: entity was recently mentioned (daysSinceLastMention)
// Score >= 50 → surface; < 50 → store only

export function scoreRelevance(mentionsCount: number, daysSinceLastMention: number | null): number {
  let score = 0

  // Criterion 1: presence and frequency
  if (mentionsCount >= 10) score += 35
  else if (mentionsCount >= 5) score += 25
  else if (mentionsCount >= 2) score += 15
  else score += 5

  // Criterion 2: recency
  if (daysSinceLastMention !== null) {
    if (daysSinceLastMention <= 7) score += 50
    else if (daysSinceLastMention <= 30) score += 30
    else if (daysSinceLastMention <= 90) score += 10
  }

  return Math.min(score, 100)
}
