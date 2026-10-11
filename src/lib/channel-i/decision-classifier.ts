// Decision style signals extracted from user prompts

export type DecisionStyle = 'recommendation_seeker' | 'options_seeker' | 'data_first' | 'precedent_based'
export type ApprovalSignal = 'approval_seeking'

// I.1 — Decision style patterns
const RECOMMENDATION_PATTERNS = [
  'what would you recommend', 'what do you recommend', 'what should i do', 'what should i go with',
  'just tell me', 'what\'s your take', 'give me your opinion', 'which one should i', 'what\'s the best',
  'tell me what to do', 'which do you think', 'what would you do', 'what do you suggest',
]

const OPTIONS_PATTERNS = [
  'give me options', 'give me a few options', 'what are my options', 'list options',
  'give me alternatives', 'what are the alternatives', 'a few ways', 'a few approaches',
  'options for', 'different ways to', 'how many ways', 'what are some ways',
  'three ways', '3 ways', 'two ways', '2 ways', 'multiple ways',
]

const DATA_FIRST_PATTERNS = [
  'what are the numbers', 'show me the data', 'show me the numbers', 'what does the data say',
  'what\'s the roi', 'what\'s the cost', 'what\'s the rate', 'how much would',
  'what are the stats', 'run the numbers', 'break down the numbers', 'what are the metrics',
  'give me the data', 'what do the numbers say', 'how much does it cost',
]

const PRECEDENT_PATTERNS = [
  'what did we do last time', 'what did i do before', 'how did i handle this before',
  'how did we do it last time', 'find when i last', 'what\'s worked before', 'what worked before',
  'how have i handled', 'similar situation', 'how did i approach this before', 'previous time',
  'last time i did this', 'how did we do this before',
]

// I.4 — Approval seeking patterns
const APPROVAL_SEEKING_PATTERNS = [
  'does this make sense', 'does that make sense', 'am i thinking about this right',
  'is this a good approach', 'is this the right approach', 'what would you do',
  'does this sound right', 'is this correct', 'am i on the right track',
  'does this work', 'is this reasonable', 'is this a good idea', 'does this seem right',
  'what do you think of this', 'does this look good',
]

// I.2 — Research task patterns (tasks that gather data before deciding)
const RESEARCH_PATTERNS = [
  'research', 'look into', 'find out', 'investigate', 'dig into',
  'compare', 'analyze', 'analysis of', 'look up', 'search for',
  'what is', 'how does', 'tell me about', 'give me info on',
  'pros and cons', 'breakdown of', 'overview of',
]

// I.3 — Reversal signals in messages
const REVERSAL_PATTERNS = [
  'actually let\'s', 'actually let me', 'let\'s change', 'let\'s go with',
  'never mind', 'scratch that', 'ignore that', 'forget that', 'changed my mind',
  'let\'s pivot', 'different approach', 'on second thought', 'instead let\'s',
  'actually, let\'s', 'wait, let\'s', 'hold on', 'switch to', 'let\'s do',
]

export function classifyDecisionStyle(prompt: string): DecisionStyle | null {
  const lower = prompt.toLowerCase()
  if (RECOMMENDATION_PATTERNS.some(p => lower.includes(p))) return 'recommendation_seeker'
  if (OPTIONS_PATTERNS.some(p => lower.includes(p))) return 'options_seeker'
  if (DATA_FIRST_PATTERNS.some(p => lower.includes(p))) return 'data_first'
  if (PRECEDENT_PATTERNS.some(p => lower.includes(p))) return 'precedent_based'
  return null
}

export function isApprovalSeeking(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  return APPROVAL_SEEKING_PATTERNS.some(p => lower.includes(p))
}

export function isResearchTask(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  return RESEARCH_PATTERNS.some(p => lower.includes(p))
}

export function isReversalSignal(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  return REVERSAL_PATTERNS.some(p => lower.includes(p))
}
