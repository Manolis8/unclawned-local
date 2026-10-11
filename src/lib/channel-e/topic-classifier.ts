const TOPICS: Record<string, string[]> = {
  ai_agents: [
    'ai', 'artificial intelligence', 'machine learning', 'llm', 'gpt', 'claude', 'openai',
    'agent', 'automation', 'chatgpt', 'prompt engineering', 'embedding', 'rag', 'fine-tun',
    'language model', 'neural network', 'anthropic', 'gemini', 'mistral', 'copilot',
  ],
  startup: [
    'startup', 'founder', 'co-founder', 'bootstrapped', 'early stage', 'seed stage',
    'entrepreneurship', 'entrepreneur', 'pivot', 'building a company', 'zero to one',
  ],
  fundraising: [
    'series a', 'series b', 'seed round', 'fundraising', 'raised', 'term sheet',
    'venture capital', 'angel investor', 'cap table', 'runway', 'investor',
    'valuation', 'pre-money', 'vc fund',
  ],
  product: [
    'product', 'roadmap', 'user research', 'prototype', 'product-market fit', 'pmf',
    'customer discovery', 'ux', 'ui design', 'wireframe', 'user story', 'sprint', 'agile',
  ],
  leadership: [
    'leadership', 'management', 'team culture', 'hiring', 'remote work', 'company culture',
    'ceo', 'cto', 'executive', 'board', 'delegation', 'vision', 'org design',
  ],
  growth: [
    'growth', 'marketing', 'gtm', 'go-to-market', 'acquisition', 'retention', 'churn',
    'conversion', 'revenue', 'arr', 'mrr', 'saas', 'funnel', 'pipeline', 'lead generation',
  ],
  content: [
    'newsletter', 'audience', 'followers', 'personal brand', 'thought leadership',
    'content creation', 'creator economy', 'viral', 'engagement rate', 'linkedin post',
    'writing online', 'content strategy',
  ],
  engineering: [
    'engineering', 'developer', 'software', 'typescript', 'python', 'react', 'backend',
    'frontend', 'architecture', 'devops', 'cloud', 'aws', 'database', 'api design',
  ],
  career: [
    'career', 'job search', 'interview', 'resume', 'salary', 'layoff', 'open to work',
    'job offer', 'promotion', 'workplace', 'burnout', 'career transition',
  ],
  finance: [
    'unit economics', 'burn rate', 'p&l', 'cfo', 'cash flow', 'budget',
    'quarterly results', 'fiscal', 'profitability', 'saas metrics',
  ],
}

export type TopicKey = keyof typeof TOPICS

export function classifyTopics(text: string): Record<string, number> {
  const lower = text.toLowerCase()
  const counts: Record<string, number> = {}
  for (const [topic, keywords] of Object.entries(TOPICS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        counts[topic] = (counts[topic] ?? 0) + 1
      }
    }
  }
  return counts
}

export function dominantTopics(distribution: Record<string, number>, n = 3): string[] {
  return Object.entries(distribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([topic]) => topic)
}
