import { db, uuid, j, p } from '../db.js'
import { classifyTopics } from '../channel-e/topic-classifier.js'

// ─── Content type detection ───────────────────────────────────────────────────

type ContentType = 'email' | 'post' | 'analysis' | 'message' | 'plan' | 'proposal' | 'other'

const CONTENT_TYPE_PATTERNS: [ContentType, string[]][] = [
  ['post',     ['linkedin post', 'twitter post', 'tweet', 'blog post', 'write a post', 'content post', 'social media post']],
  ['proposal', ['proposal', 'write a proposal', 'business proposal', 'pitch deck', 'pitch document']],
  ['plan',     ['write a plan', 'roadmap', 'strategy', 'action plan', 'project plan', 'execution plan']],
  ['analysis', ['analyze', 'analysis', 'report', 'summary of', 'summarize', 'deep dive', 'research report', 'write a report']],
  ['message',  ['message to', 'draft a message', 'write a message', 'slack message', 'text to', 'dm to', 'reach out']],
]

const EMAIL_PHRASES = ['cold email', 'intro email', 'follow-up email', 'follow up email', 'investor email', 'outreach email', 'subject:', 'dear ', 'best regards', 'reply to']
const EMAIL_DRAFT_VERBS = /\b(draft|write|compose|create|prepare|craft|send)\b/

const WRITING_TYPES = new Set<ContentType>(['email', 'post', 'analysis', 'message', 'plan', 'proposal'])

function detectContentType(prompt: string): ContentType {
  const lower = prompt.toLowerCase()
  // Email: specific email phrases OR (action verb + "email" keyword)
  if (EMAIL_PHRASES.some(kw => lower.includes(kw)) ||
      (lower.includes('email') && EMAIL_DRAFT_VERBS.test(lower))) return 'email'
  for (const [type, keywords] of CONTENT_TYPE_PATTERNS) {
    if (keywords.some(kw => lower.includes(kw))) return type
  }
  return 'other'
}

// ─── Vocabulary extraction ────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do',
  'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'this',
  'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him',
  'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'not', 'so', 'as',
  'if', 'what', 'which', 'who', 'how', 'when', 'where', 'also', 'just', 'more', 'about',
])

function extractTopWords(text: string, n = 15): string[] {
  const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []
  const freq: Record<string, number> = {}
  for (const w of words) {
    if (!STOPWORDS.has(w)) freq[w] = (freq[w] ?? 0) + 1
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w)
}

// ─── Quality signal resolution ────────────────────────────────────────────────
// Lazy: checks Channel B corrections in the 60-min window after corpus item was created

function resolveQualitySignals(userId: string): void {
  const unknowns = db.prepare(`
    SELECT id, created_at FROM channel_h_corpus_items
    WHERE user_id = ? AND quality_signal = 'unknown'
    AND created_at <= datetime('now', '-60 minutes')
  `).all(userId) as any[]

  for (const item of unknowns) {
    const corrections = (db.prepare(`
      SELECT COUNT(*) AS cnt FROM channel_b_raw_signals
      WHERE user_id = ? AND is_correction = 1
      AND created_at > ? AND created_at <= datetime(?, '+60 minutes')
    `).get(userId, item.created_at, item.created_at) as any)?.cnt ?? 0

    const signal = corrections > 0 ? 'miss' : 'hit'
    db.prepare(`UPDATE channel_h_corpus_items SET quality_signal = ? WHERE id = ?`).run(signal, item.id)
  }
}

// ─── Profile update ───────────────────────────────────────────────────────────

function updateProfile(userId: string): void {
  // Evergreen topics: aggregate topic distributions across all corpus items
  const items = db.prepare(`
    SELECT content_type, topics, quality_signal, created_at FROM channel_h_corpus_items
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 200
  `).all(userId) as any[]

  const totalTopics: Record<string, number> = {}
  const hitsByType: Record<string, { hits: number; misses: number }> = {}

  for (const item of items) {
    const topics: Record<string, number> = p(item.topics) ?? {}
    for (const [topic, count] of Object.entries(topics)) {
      totalTopics[topic] = (totalTopics[topic] ?? 0) + (count as number)
    }
    if (item.quality_signal !== 'unknown') {
      if (!hitsByType[item.content_type]) hitsByType[item.content_type] = { hits: 0, misses: 0 }
      if (item.quality_signal === 'hit') hitsByType[item.content_type].hits++
      else hitsByType[item.content_type].misses++
    }
  }

  const evergreenTopics = Object.entries(totalTopics)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([t]) => t)

  // Vocabulary evolution: top words by month (last 6 months)
  const months = new Set(items.map(i => (i.created_at as string).slice(0, 7)))
  const vocabEvolution: Array<{ month: string; topWords: string[] }> = []
  for (const month of [...months].sort().slice(-6)) {
    const monthItems = items.filter(i => (i.created_at as string).startsWith(month))
    const combinedText = monthItems.map(i => i.content_preview ?? '').join(' ')
    vocabEvolution.push({ month, topWords: extractTopWords(combinedText, 10) })
  }

  const totalIndexed = (db.prepare(`SELECT COUNT(*) AS cnt FROM channel_h_corpus_items WHERE user_id = ?`).get(userId) as any)?.cnt ?? 0

  const existing = db.prepare(`SELECT user_id FROM channel_h_profiles WHERE user_id = ?`).get(userId)
  if (existing) {
    db.prepare(`
      UPDATE channel_h_profiles SET
        total_indexed = ?, last_indexed_at = datetime('now'),
        evergreen_topics = ?, vocabulary_evolution = ?, hit_rate_by_type = ?,
        last_updated = datetime('now')
      WHERE user_id = ?
    `).run(totalIndexed, j(evergreenTopics), j(vocabEvolution), j(hitsByType), userId)
  } else {
    db.prepare(`
      INSERT INTO channel_h_profiles (user_id, total_indexed, last_indexed_at, evergreen_topics, vocabulary_evolution, hit_rate_by_type)
      VALUES (?, ?, datetime('now'), ?, ?, ?)
    `).run(userId, totalIndexed, j(evergreenTopics), j(vocabEvolution), j(hitsByType))
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function indexTaskOutput(userId: string, taskId: string, taskPrompt: string, taskSummary: string): void {
  try {
    const contentType = detectContentType(taskPrompt)
    if (contentType === 'other') return  // only index writing-type outputs

    // Read the full task output from DB
    const taskRow = db.prepare(`SELECT output FROM tasks WHERE id = ?`).get(taskId) as any
    const outputText: string = taskRow?.output || taskSummary || ''
    if (outputText.length < 30) return  // skip trivially short outputs

    const contentPreview = outputText.slice(0, 600)
    const topics = classifyTopics(outputText)
    const wc = outputText.trim().split(/\s+/).filter(Boolean).length

    db.prepare(`
      INSERT INTO channel_h_corpus_items
        (id, user_id, task_id, content_type, content_preview, task_prompt_preview,
         task_summary, word_count, topics, quality_signal, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', datetime('now'))
    `).run(uuid(), userId, taskId, contentType, contentPreview,
      taskPrompt.slice(0, 200), taskSummary?.slice(0, 200) ?? null, wc, j(topics))

    // Lazily resolve quality signals for older items
    resolveQualitySignals(userId)
    updateProfile(userId)

    console.log(`[channel-h] indexed ${contentType} output (${wc} words) for user ${userId}`)
  } catch (err) {
    console.error('[channel-h] index error:', err)
  }
}

export { resolveQualitySignals }
