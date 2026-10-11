// G.1 — classify a task prompt into a cognitive category
// Categories map to different energy/focus requirements

export type TaskCategory =
  | 'deep_work'      // research, analysis, complex writing, strategy
  | 'communication'  // email, message drafting, outreach
  | 'decision'       // reviewing, evaluating, approving, comparing
  | 'admin'          // scheduling, quick lookups, simple forms, reminders
  | 'creative'       // content creation, brainstorming, design
  | 'execution'      // filling forms, data entry, navigation, automation

const PATTERNS: Record<TaskCategory, string[]> = {
  deep_work: [
    'research', 'analyze', 'analysis', 'investigate', 'summarize', 'write a report',
    'write an essay', 'write a proposal', 'strategy', 'plan for', 'deep dive',
    'comprehensive', 'detailed', 'think through', 'evaluate options', 'compare',
    'review document', 'review the report', 'understand', 'explain why',
  ],
  communication: [
    'email', 'message', 'draft a', 'write to', 'reply to', 'respond to',
    'reach out', 'follow up', 'follow-up', 'send to', 'outreach', 'linkedin message',
    'slack message', 'text to', 'introduction', 'intro email', 'cold email',
  ],
  decision: [
    'review', 'approve', 'decide', 'should i', 'which is better', 'compare options',
    'evaluate', 'assess', 'rank', 'prioritize', 'choose', 'pick', 'select',
    'is this good', 'give me feedback', 'what do you think',
  ],
  admin: [
    'schedule', 'calendar', 'reminder', 'set up a meeting', 'find a time',
    'book', 'cancel', 'reschedule', 'track', 'log', 'update spreadsheet',
    'quick question', 'what is', 'who is', 'look up', 'find me',
    'note that', 'remind me', 'add to', 'list of',
  ],
  creative: [
    'brainstorm', 'generate ideas', 'come up with', 'creative', 'ideas for',
    'write a post', 'tweet', 'linkedin post', 'blog post', 'content', 'story',
    'narrative', 'pitch', 'tagline', 'slogan', 'name ideas',
  ],
  execution: [
    'open', 'navigate', 'go to', 'click', 'fill in', 'fill out', 'submit',
    'download', 'upload', 'export', 'import', 'copy', 'paste', 'search for on',
    'log into', 'sign into', 'scrape', 'extract from', 'automate',
  ],
}

const URGENCY_KEYWORDS = [
  'asap', 'urgent', 'urgently', 'immediately', 'right away', 'today', 'tonight',
  'deadline', 'by end of', 'time sensitive', 'critical', 'need it now', 'need this now',
]

const FRUSTRATION_KEYWORDS = [
  'still', 'again', 'wrong', 'broken', 'not working', 'failed', 'ugh', 'seriously',
  'come on', 'how many times', "doesn't work", 'keeps failing', 'terrible', 'useless',
]

export function classifyTask(prompt: string): TaskCategory {
  const lower = prompt.toLowerCase()

  let bestCategory: TaskCategory = 'execution'
  let bestScore = 0

  for (const [category, keywords] of Object.entries(PATTERNS) as [TaskCategory, string[]][]) {
    const score = keywords.filter(kw => lower.includes(kw)).length
    if (score > bestScore) {
      bestScore = score
      bestCategory = category
    }
  }

  return bestCategory
}

export function hasUrgency(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  return URGENCY_KEYWORDS.some(kw => lower.includes(kw))
}

export function hasFrustration(prompt: string): boolean {
  const lower = prompt.toLowerCase()
  return FRUSTRATION_KEYWORDS.some(kw => lower.includes(kw))
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}
