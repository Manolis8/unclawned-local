export type DriftCategory = 'technical' | 'business' | 'financial' | 'relational' | 'emotional'

export interface ExtractedWord {
  word: string        // normalized lowercase
  original: string    // as appeared in text
  isProperNoun: boolean
}

// ─── Stop words ───────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'that', 'this', 'with', 'from', 'have', 'not',
  'been', 'they', 'will', 'what', 'your', 'which', 'their', 'when', 'were',
  'there', 'than', 'then', 'more', 'also', 'some', 'into', 'just', 'here',
  'about', 'would', 'could', 'should', 'like', 'very', 'much', 'does',
  'really', 'need', 'make', 'want', 'know', 'look', 'help', 'over', 'back',
  'think', 'take', 'good', 'tell', 'work', 'give', 'come', 'only', 'long',
  'well', 'down', 'each', 'even', 'most', 'same', 'turn', 'such',
  'before', 'after', 'those', 'these', 'other', 'time', 'year', 'month',
  'week', 'days', 'next', 'last', 'first', 'going', 'doing', 'using',
  'while', 'still', 'through', 'write', 'draft', 'email', 'send', 'please',
  'thanks', 'okay', 'hello', 'actually', 'basically', 'things', 'something',
  'anything', 'nothing', 'getting', 'trying', 'having', 'being', 'where',
  'right', 'left', 'both', 'maybe', 'either', 'every', 'never', 'always',
  'again', 'already', 'around', 'across', 'along', 'above', 'below',
  'between', 'within', 'without', 'against', 'during', 'because', 'however',
])

// ─── Category vocabulary ──────────────────────────────────────────────────────

const CATEGORY_WORDS: Record<DriftCategory, string[]> = {
  technical: [
    'backend', 'frontend', 'database', 'deployment', 'architecture',
    'algorithm', 'inference', 'embedding', 'vector', 'agent', 'agents',
    'llm', 'gpt', 'claude', 'openai', 'anthropic', 'github', 'docker',
    'kubernetes', 'typescript', 'javascript', 'python', 'react', 'schema',
    'endpoint', 'webhook', 'integration', 'codebase', 'repository',
    'debugging', 'refactor', 'component', 'library', 'framework',
    'infrastructure', 'latency', 'throughput', 'authentication', 'scalable',
    'microservice', 'serverless', 'compute', 'orchestration', 'token',
    'context', 'prompt', 'finetuning', 'retrieval', 'pipeline',
  ],
  business: [
    'revenue', 'profit', 'margin', 'growth', 'market', 'enterprise',
    'saas', 'b2b', 'b2c', 'acquisition', 'retention', 'churn', 'mrr',
    'arr', 'expansion', 'conversion', 'funnel', 'customer', 'roadmap',
    'milestone', 'kpi', 'okr', 'strategy', 'competitive', 'positioning',
    'monetize', 'segment', 'stakeholder', 'executive', 'procurement',
    'vendor', 'contract', 'compliance', 'operations', 'pricing',
    'distribution', 'traction', 'product', 'iteration', 'launch',
  ],
  financial: [
    'fundraising', 'investment', 'valuation', 'dilution', 'series',
    'seed', 'venture', 'equity', 'termsheet', 'diligence', 'investor',
    'runway', 'burn', 'raise', 'priced', 'convertible', 'bridge',
    'portfolio', 'carry', 'returns', 'liquidation', 'preference',
    'capTable', 'optionPool', 'budget', 'forecast', 'cashflow',
    'profitability', 'financial', 'capital', 'investors', 'raise',
    'round', 'funding', 'bootstrapped', 'profitable',
  ],
  relational: [
    'partnership', 'collaboration', 'network', 'community', 'relationship',
    'referral', 'outreach', 'connection', 'hiring', 'culture', 'trust',
    'alignment', 'advisor', 'mentor', 'champion', 'sponsor', 'reference',
    'introduction', 'networking', 'cofounder', 'candidate', 'recruit',
    'onboard', 'teammate', 'connector', 'warm', 'intro', 'relationship',
    'stakeholders', 'champions', 'advocates',
  ],
  emotional: [
    'stressed', 'stress', 'anxiety', 'anxious', 'overwhelmed', 'excited',
    'frustrated', 'confused', 'confident', 'uncertain', 'motivated',
    'burnout', 'clarity', 'vision', 'passion', 'purpose', 'doubt',
    'worried', 'concern', 'nervous', 'pressure', 'tension', 'exhausted',
    'energized', 'inspired', 'blocked', 'thrilled', 'hopeful', 'grateful',
    'proud', 'scared', 'excited', 'drained', 'recharged', 'grounded',
  ],
}

// Build O(1) reverse-lookup
const WORD_CATEGORY_MAP = new Map<string, DriftCategory>()
for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
  for (const word of words) {
    WORD_CATEGORY_MAP.set(word.toLowerCase(), cat as DriftCategory)
  }
}

export function classifyWord(word: string): DriftCategory | null {
  return WORD_CATEGORY_MAP.get(word.toLowerCase()) ?? null
}

// ─── Vocabulary extraction ────────────────────────────────────────────────────

export function extractVocabulary(message: string): ExtractedWord[] {
  const results: ExtractedWord[] = []
  const seen = new Set<string>()

  // Track sentence-start positions so we don't false-positive capitalize proper nouns
  const sentenceStarts = new Set<number>([0])
  for (const m of message.matchAll(/[.!?]\s+/g)) {
    sentenceStarts.add((m.index ?? 0) + m[0].length)
  }

  for (const match of message.matchAll(/\b([A-Za-z][A-Za-z'-]*[A-Za-z])\b/g)) {
    const original = match[1]
    const word = original.toLowerCase()
    const matchStart = match.index ?? 0

    if (word.length < 4) continue
    if (STOP_WORDS.has(word)) continue
    if (seen.has(word)) continue
    seen.add(word)

    const isAtSentenceStart = sentenceStarts.has(matchStart)
    const isAllCaps = original === original.toUpperCase() && original.length >= 3
    // Capitalized mid-sentence and not an acronym → likely proper noun
    const isProperNoun = /^[A-Z]/.test(original) && !isAtSentenceStart && !isAllCaps

    results.push({ word, original, isProperNoun })
  }

  return results
}

// ─── Drift direction ──────────────────────────────────────────────────────────

export function computeDriftFromWords(words: string[]): DriftCategory | null {
  const counts: Record<DriftCategory, number> = {
    technical: 0, business: 0, financial: 0, relational: 0, emotional: 0,
  }

  for (const word of words) {
    const cat = classifyWord(word)
    if (cat) counts[cat]++
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total < 5) return null

  const [top] = (Object.entries(counts) as [DriftCategory, number][]).sort(([, a], [, b]) => b - a)
  if (top[1] / total < 0.2) return null
  return top[0]
}
