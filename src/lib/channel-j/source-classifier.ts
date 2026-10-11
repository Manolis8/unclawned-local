export type SourceType =
  | 'academic' | 'industry_report' | 'newsletter' | 'twitter'
  | 'long_form' | 'podcast' | 'data_stats' | 'personal_blog' | 'news'

export type DepthPreference = 'high' | 'low'
export type TaskMode = 'consumption' | 'production'

// ─── J.1 Source type from URL domain ─────────────────────────────────────────

const DOMAIN_SOURCE_MAP: [string[], SourceType][] = [
  [['arxiv.org', 'pubmed.ncbi', 'scholar.google', 'researchgate.net', 'semanticscholar.org', 'jstor.org', 'ncbi.nlm.nih.gov', 'ssrn.com'], 'academic'],
  [['mckinsey.com', 'a16z.com', 'sequoiacap.com', 'hbr.org', 'deloitte.com', 'pwc.com', 'gartner.com', 'forrester.com', 'bcg.com', 'bain.com', 'accenture.com'], 'industry_report'],
  [['substack.com', 'beehiiv.com', 'convertkit.com', 'mailchimp.com', 'tinyletter.com'], 'newsletter'],
  [['twitter.com', 'x.com'], 'twitter'],
  [['spotify.com', 'podcasts.apple.com', 'overcast.fm', 'buzzsprout.com', 'transistor.fm', 'anchor.fm', 'podbean.com'], 'podcast'],
  [['statista.com', 'data.worldbank.org', 'census.gov', 'oecd.org', 'ourworldindata.org', 'kaggle.com'], 'data_stats'],
  [['medium.com', 'ghost.io', 'paulgraham.com', 'lethain.com', 'stratechery.com', 'seths.blog'], 'personal_blog'],
  [['nytimes.com', 'wsj.com', 'bloomberg.com', 'reuters.com', 'techcrunch.com', 'theverge.com', 'wired.com', 'ft.com', 'theguardian.com', 'cnn.com', 'bbc.com', 'bbc.co.uk', 'axios.com', 'politico.com', 'forbes.com', 'businessinsider.com', 'cnbc.com', 'arstechnica.com'], 'news'],
  // long_form: not matched by domain — detected via text patterns instead
]

export function classifyUrlSource(url: string): SourceType | null {
  const lower = url.toLowerCase()
  for (const [domains, type] of DOMAIN_SOURCE_MAP) {
    if (domains.some(d => lower.includes(d))) return type
  }
  // Substack custom domains: any https://xxx.substack.com variant already caught above.
  // Generic heuristic: if not recognized, return null
  return null
}

// ─── J.1 Source type from text (no URL) ──────────────────────────────────────

const TEXT_SOURCE_PATTERNS: [string[], SourceType][] = [
  [['arxiv', 'research paper', 'peer reviewed', 'peer-reviewed', 'published paper', 'the study shows', 'according to the study', 'journal article', 'academic paper'], 'academic'],
  [['mckinsey', 'a16z', 'sequoia report', 'hbr article', 'gartner report', 'forrester', 'industry report', 'whitepaper', 'white paper', 'according to the report', 'firm report'], 'industry_report'],
  [['newsletter', 'substack', 'weekly digest', 'morning brew', 'tldr newsletter', 'my newsletter'], 'newsletter'],
  [['twitter thread', 'tweet by', 'x thread', 'thread by', 'saw on twitter', 'saw on x', 'posted on x', 'posted on twitter'], 'twitter'],
  [['long read', 'long-form', 'longform', 'in-depth article', 'essay by', 'full piece', 'wrote a piece'], 'long_form'],
  [['podcast', 'episode of', 'listened to', 'heard on', 'they said on the podcast', 'podcast episode'], 'podcast'],
  [['the data shows', 'the numbers show', 'statistics show', 'according to data', 'survey found', 'dataset'], 'data_stats'],
  [['paul graham', 'founder blog', 'indie hacker', 'their blog post', 'someone\'s blog', 'practitioner post'], 'personal_blog'],
  [['techcrunch', 'wired article', 'wsj article', 'bloomberg article', 'the article says', 'news says', 'reported that', 'according to the news'], 'news'],
]

export function classifyTextSource(message: string): SourceType | null {
  const lower = message.toLowerCase()
  for (const [patterns, type] of TEXT_SOURCE_PATTERNS) {
    if (patterns.some(p => lower.includes(p))) return type
  }
  return null
}

// Extract all URLs from a message
export function extractUrls(message: string): string[] {
  const matches = message.match(/https?:\/\/[^\s<>"']+/g) ?? []
  return matches
}

// ─── J.2 Depth preference ─────────────────────────────────────────────────────

const LOW_DEPTH_PATTERNS = [
  'briefly', 'brief summary', 'in brief', 'quick summary', 'quick overview',
  'tl;dr', 'tldr', 'in a few words', 'in a sentence', 'bullet points',
  'just the key points', 'just the highlights', 'short version',
  'give me the gist', 'keep it short', 'be concise', 'short answer',
]

const HIGH_DEPTH_PATTERNS = [
  'deep dive', 'comprehensive', 'in depth', 'in-depth', 'thorough',
  'detailed analysis', 'full analysis', 'go deep', 'elaborate',
  'walk me through', 'full breakdown', 'exhaustive', 'nuanced',
  'leave nothing out', 'cover everything', 'don\'t skip anything',
  'full picture', 'complete overview',
]

export function classifyDepthPreference(message: string): DepthPreference | null {
  const lower = message.toLowerCase()
  if (LOW_DEPTH_PATTERNS.some(p => lower.includes(p))) return 'low'
  if (HIGH_DEPTH_PATTERNS.some(p => lower.includes(p))) return 'high'
  return null
}

// ─── J.3 Consumption vs production ───────────────────────────────────────────

const CONSUMPTION_PATTERNS = [
  'research', 'look up', 'look into', 'find out', 'summarize', 'summary of',
  'tell me about', 'explain', 'what is', 'how does', 'analyze', 'analysis of',
  'compare', 'pros and cons', 'overview of', 'find information', 'search for',
  'dig into', 'investigate', 'what are', 'show me', 'give me info',
]

const PRODUCTION_PATTERNS = [
  'write', 'draft', 'create', 'build', 'design', 'compose', 'generate',
  'make', 'develop', 'code', 'program', 'produce', 'publish', 'post',
  'put together', 'structure', 'outline', 'flesh out', 'edit',
]

export function classifyTaskMode(message: string): TaskMode | null {
  const lower = message.toLowerCase()
  const isConsumption = CONSUMPTION_PATTERNS.some(p => lower.includes(p))
  const isProduction = PRODUCTION_PATTERNS.some(p => lower.includes(p))
  if (isConsumption && !isProduction) return 'consumption'
  if (isProduction && !isConsumption) return 'production'
  return null
}

// ─── J.4 Information anxiety ──────────────────────────────────────────────────

const INFO_ANXIETY_PATTERNS = [
  'can you also check', 'can you verify', 'just to make sure', 'to double check',
  'to double-check', 'also look up', 'cross check', 'cross-check',
  'can you confirm', 'make sure that\'s right', 'is that accurate',
  'can you validate', 'double check that', 'verify that', 'check that this is right',
  'want to be sure', 'want to make sure',
]

export function isInfoAnxiety(message: string): boolean {
  const lower = message.toLowerCase()
  return INFO_ANXIETY_PATTERNS.some(p => lower.includes(p))
}
