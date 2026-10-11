export type TaskType =
  | 'write'
  | 'research'
  | 'analyze'
  | 'plan'
  | 'admin'
  | 'code'
  | 'review'
  | 'brief'
  | 'unknown'

// ─── Keyword sets ─────────────────────────────────────────────────────────────
// Order of checks matters — more specific first to avoid mis-classification.

const CODE_KEYWORDS = [
  'debug', 'debugging', 'bug', 'error', 'fix this code', 'function', 'class',
  'endpoint', 'refactor', 'implement', 'algorithm', 'variable', 'typescript',
  'javascript', 'python', 'golang', 'rust', 'sql query', 'regex',
  'syntax', 'compile', 'import', 'export', 'async function', 'await',
  'unit test', 'integration test', 'test case', 'mock', 'type error',
  'npm', 'yarn', 'package.json', 'tsconfig', 'webpack', 'vite',
]

const RESEARCH_KEYWORDS = [
  'find out', 'find me', 'can you find', 'find competitors', 'find examples',
  'find the', 'look up', 'look into', 'what is', 'who is',
  'who are', 'how does', 'how do', 'tell me about', 'background on',
  'information on', 'research', 'summarize', 'summary of', 'explain',
  'what are', 'search for', 'learn about', 'define',
  'overview of', 'give me info', 'what do you know about',
  // standalone "find" — common research trigger but checked after multi-word patterns above
  'find',
]

const WRITE_KEYWORDS = [
  'write', 'compose', 'write me', 'write a',
  'help me write', 'write an email', 'write a message', 'write a post',
  'write a bio', 'write a proposal', 'write a report', 'write a script',
  'write a letter', 'write a description', 'write copy', 'write content',
  'write a follow', 'follow-up email', 'cold email', 'outreach email',
  'linkedin message', 'linkedin post', 'tweet', 'blog post', 'article',
  'announcement', 'newsletter', 'press release', 'job description',
  // "draft" only as a verb at start — "email draft" (noun) should not trigger
  'draft a', 'draft an', 'draft the', 'draft this', 'draft me',
]

const ANALYZE_KEYWORDS = [
  'analyze', 'analyse', 'evaluate', 'assess', 'compare', 'contrast',
  'pros and cons', 'pros/cons', 'feedback on', 'your opinion on',
  'thoughts on', 'critique', 'audit', 'review this', 'look at this',
  'what do you think of', 'is this good', 'strengths and weaknesses',
  'break down', 'break this down', 'what is wrong with', 'assess this',
]

const PLAN_KEYWORDS = [
  'plan', 'strategy', 'roadmap', 'prioritize', 'priorities', 'goals',
  'outline', 'brainstorm', 'ideas for', 'approach to', 'how should i',
  'how do i approach', 'help me think', 'where to start', 'what should i do',
  'what is the best way', 'build a plan', 'create a plan', 'what steps',
  'next steps', 'action items', 'quarterly', 'yearly goal',
  'prep for', 'prepare for', 'get ready for', 'preparing for',
  'pitch prep', 'fundraise', 'how do i get', 'what do i need to',
]

const ADMIN_KEYWORDS = [
  'schedule', 'calendar', 'set up a meeting', 'book a', 'book time', 'set up a call',
  'organize', 'track this', 'manage this', 'todo list', 'task list', 'reminder',
  'invoice', 'expense', 'fill out', 'fill in the form', 'template', 'spreadsheet',
  'update the', 'log this', 'note this down',
]

const REVIEW_KEYWORDS = [
  'proofread', 'proofreading', 'edit this', 'revise', 'check this',
  'correct this', 'improve this', 'better version of', 'rewrite this',
  'clean up', 'polish', 'make this better', 'fix the grammar',
  'fix the wording', 'review my', 'look over my', 'any mistakes',
  'does this sound right', 'does this read well',
]

// ─── Helper ───────────────────────────────────────────────────────────────────

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some(kw => {
    if (!kw.includes(' ')) {
      // Single word: require word boundary so "form" doesn't match "formal"
      return new RegExp(`\\b${kw}\\b`).test(text)
    }
    // Multi-word phrase: substring match is fine
    return text.includes(kw)
  })
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function classifyTaskType(text: string): TaskType {
  const lower = text.toLowerCase().slice(0, 400)

  if (hasAny(lower, CODE_KEYWORDS)) return 'code'
  if (hasAny(lower, RESEARCH_KEYWORDS)) return 'research'
  if (hasAny(lower, REVIEW_KEYWORDS)) return 'review'   // before write — "proofread" > "draft"
  if (hasAny(lower, WRITE_KEYWORDS)) return 'write'
  if (hasAny(lower, ANALYZE_KEYWORDS)) return 'analyze'
  if (hasAny(lower, PLAN_KEYWORDS)) return 'plan'
  if (hasAny(lower, ADMIN_KEYWORDS)) return 'admin'

  const wordCount = text.trim().split(/\s+/).filter(Boolean).length
  if (wordCount <= 6) return 'brief'

  return 'unknown'
}
