export type EnergyState = 'high' | 'medium' | 'low' | 'depleted'
export type ConfidenceSignal = 'low_confidence' | 'high_confidence'

// ─── K.1 Overload signal detection ───────────────────────────────────────────

const FRUSTRATION_WORDS = [
  'ugh', 'argh', 'ughhh', 'ughh', 'why won\'t', 'why can\'t', 'still not',
  'again', 'still wrong', 'doesn\'t work', 'not working', 'broken', 'keeps',
  'seriously', 'come on', 'wtf', 'ffs', 'just fix', 'just do',
]

function hasFrustration(message: string): boolean {
  const lower = message.toLowerCase()
  return FRUSTRATION_WORDS.some(w => lower.includes(w))
}

// Simple word-overlap duplicate check against recent message previews
export function isDuplicate(message: string, recentPreviews: string[]): boolean {
  if (!recentPreviews.length) return false
  const words = new Set(message.toLowerCase().split(/\s+/).filter(w => w.length > 3))
  if (words.size < 3) return false
  for (const prev of recentPreviews) {
    const prevWords = new Set(prev.toLowerCase().split(/\s+/).filter(w => w.length > 3))
    const overlap = [...words].filter(w => prevWords.has(w)).length
    const overlapRatio = overlap / Math.min(words.size, prevWords.size)
    if (overlapRatio >= 0.7) return true
  }
  return false
}

export function detectOverloadSignals(message: string, avgLength: number, recentPreviews: string[]): string[] {
  const signals: string[] = []
  const wordCount = message.trim().split(/\s+/).length

  // Signal: frustrated language in what should be a simple request
  if (hasFrustration(message) && wordCount <= 12) {
    signals.push('frustrated_simple_request')
  }

  // Signal: prompt significantly shorter than user's established baseline
  if (avgLength >= 40 && message.length < avgLength * 0.4) {
    signals.push('short_vs_baseline')
  }

  // Signal: "still" / "again" / "why" — signs of repeated failure
  if (/\b(still|again|still not|why (won't|can't|doesn't|isn't))\b/i.test(message) && message.length < 80) {
    signals.push('repeated_failure_marker')
  }

  // Signal: duplicate task — almost identical to a recent message
  if (isDuplicate(message, recentPreviews)) {
    signals.push('duplicate_task')
  }

  return signals
}

// ─── K.2 Energy state ─────────────────────────────────────────────────────────

const COMPLEX_TASK_WORDS = [
  'analyze', 'analysis', 'research', 'strategy', 'comprehensive', 'deep dive',
  'detailed', 'breakdown', 'compare', 'evaluate', 'framework', 'proposal',
  'plan for', 'in depth', 'thorough', 'elaborate',
]

export function classifyEnergy(message: string, hourOfDay: number): EnergyState {
  const len = message.trim().length
  const isLateOrEarly = hourOfDay >= 23 || hourOfDay <= 5
  const hasComplexity = COMPLEX_TASK_WORDS.some(w => message.toLowerCase().includes(w))

  if (len < 25 || (len < 40 && isLateOrEarly)) return 'depleted'
  if (len < 45 && !hasComplexity) return 'low'
  if (len >= 160 && hasComplexity) return 'high'
  return 'medium'
}

// ─── K.3 Confidence signal ────────────────────────────────────────────────────

const LOW_CONFIDENCE_PHRASES = [
  'i\'m not sure if this', 'not sure if this is right', 'might be wrong',
  'probably wrong', 'second-guessing', 'second guessing', 'maybe this is wrong',
  'i think maybe', 'not sure this is correct', 'could be wrong',
  'i might be off', 'feel like i\'m missing', 'is this even right',
  'am i wrong', 'tell me if this is wrong',
]

export function detectConfidenceSignal(message: string): ConfidenceSignal | null {
  const lower = message.toLowerCase()
  if (LOW_CONFIDENCE_PHRASES.some(p => lower.includes(p))) return 'low_confidence'
  return null
}

// ─── K.4 Assumption-laden prompt detection ────────────────────────────────────

const ASSUMPTION_PATTERNS = [
  'convince him to', 'convince her to', 'convince them to',
  'make him', 'make her', 'make them',
  'get him to agree', 'get her to agree', 'get them to agree',
  'get him to sign', 'get her to sign', 'get them to sign',
  'help me persuade', 'help me convince',
  'change his mind', 'change her mind', 'change their mind',
  'force him to', 'force her to', 'force them to',
  'find the ceo of', 'find the founder of', 'find the owner of',
]

export function isAssumptionLaden(message: string): boolean {
  const lower = message.toLowerCase()
  return ASSUMPTION_PATTERNS.some(p => lower.includes(p))
}
