import { db, uuid, j, p } from '../db.js'
import { classifyTopics } from './topic-classifier.js'

type LinkedInPageType = 'feed' | 'profile_other' | 'profile_own' | 'post' | 'other'

function detectPageType(url: string, content: string): LinkedInPageType {
  if (url.includes('linkedin.com/feed')) return 'feed'
  if (url.match(/linkedin\.com\/posts\//)) return 'post'
  if (url.match(/linkedin\.com\/in\//)) {
    const lower = content.toLowerCase()
    const isOwn = lower.includes('edit profile') || lower.includes('your dashboard') || lower.includes('post impressions')
    return isOwn ? 'profile_own' : 'profile_other'
  }
  return 'other'
}

// Extract plausible person names (2–3 word capitalized sequences)
function extractAccountNames(content: string): string[] {
  const seen = new Set<string>()
  for (const m of content.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g)) {
    const name = m[1]
    // Skip common phrases that look like names but aren't
    if (!name.match(/^(The |This |That |New |Our |Their |Your |With )/i)) {
      seen.add(name)
    }
  }
  return Array.from(seen).slice(0, 30)
}

export function observeLinkedInContent(userId: string, sessionId: string | null, url: string, content: string): void {
  try {
    const pageType = detectPageType(url, content)
    if (pageType === 'other') return

    const topicDist = classifyTopics(content)
    const accountNames = extractAccountNames(content)

    db.prepare(`
      INSERT INTO channel_e_feed_visits
        (id, user_id, session_id, url, page_type, topic_distribution, accounts_seen, post_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(uuid(), userId, sessionId, url, pageType, j(topicDist), j(accountNames), accountNames.length)

    // E.4: own content — update own_content_topics on own profile visits
    if (pageType === 'profile_own') {
      updateOwnContentTopics(userId, topicDist)
    }

    // Update recurring accounts (only for feed/post pages — not own profile)
    if (pageType === 'profile_own') {
      updateProfile(userId)
      console.log(`[channel-e] observed ${pageType} for user ${userId}: own content topics updated`)
      return
    }
    for (const name of accountNames) {
      const existing = db.prepare(
        `SELECT id FROM channel_e_recurring_accounts WHERE user_id = ? AND account_name = ?`
      ).get(userId, name) as any
      if (existing) {
        db.prepare(`
          UPDATE channel_e_recurring_accounts
          SET appearance_count = appearance_count + 1, last_seen = datetime('now')
          WHERE id = ?
        `).run(existing.id)
      } else {
        const topTopic = Object.entries(topicDist).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
        db.prepare(`
          INSERT INTO channel_e_recurring_accounts
            (id, user_id, account_name, first_seen, last_seen, appearance_count, primary_topic)
          VALUES (?, ?, ?, datetime('now'), datetime('now'), 1, ?)
        `).run(uuid(), userId, name, topTopic)
      }
    }

    updateProfile(userId)
    console.log(`[channel-e] observed ${pageType} for user ${userId}: ${Object.keys(topicDist).join(', ') || 'no topics'}`)
  } catch (err) {
    console.error('[channel-e] observe error:', err)
  }
}

function updateProfile(userId: string): void {
  const visits = db.prepare(`
    SELECT topic_distribution, created_at FROM channel_e_feed_visits
    WHERE user_id = ? AND page_type = 'feed'
    ORDER BY rowid DESC LIMIT 10
  `).all(userId) as any[]

  if (visits.length === 0) return

  const totalDist: Record<string, number> = {}
  const evolution: Array<{ at: string; dist: Record<string, number> }> = []

  for (const v of visits) {
    const dist: Record<string, number> = p(v.topic_distribution) ?? {}
    evolution.push({ at: v.created_at, dist })
    for (const [topic, count] of Object.entries(dist)) {
      totalDist[topic] = (totalDist[topic] ?? 0) + count
    }
  }

  const dominant = Object.entries(totalDist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t)

  const topAccounts = db.prepare(`
    SELECT account_name, appearance_count, primary_topic
    FROM channel_e_recurring_accounts
    WHERE user_id = ?
    ORDER BY appearance_count DESC LIMIT 5
  `).all(userId) as any[]

  // Drift: compare topic share last-3 visits vs prior-3
  let driftSignal: { toTopic: string; delta: number } | null = null
  if (visits.length >= 6) {
    const recent = visits.slice(0, 3)
    const prior  = visits.slice(3, 6)

    const recentDist: Record<string, number> = {}
    const priorDist:  Record<string, number> = {}

    for (const v of recent) {
      for (const [t, c] of Object.entries(p(v.topic_distribution) as Record<string, number> ?? {})) {
        recentDist[t] = (recentDist[t] ?? 0) + (c as number)
      }
    }
    for (const v of prior) {
      for (const [t, c] of Object.entries(p(v.topic_distribution) as Record<string, number> ?? {})) {
        priorDist[t] = (priorDist[t] ?? 0) + (c as number)
      }
    }

    const recentTotal = Object.values(recentDist).reduce((a, b) => a + b, 0) || 1
    const priorTotal  = Object.values(priorDist).reduce((a, b) => a + b, 0) || 1

    let best = { topic: '', delta: 0 }
    const allTopics = new Set([...Object.keys(recentDist), ...Object.keys(priorDist)])
    for (const topic of allTopics) {
      const delta = (recentDist[topic] ?? 0) / recentTotal - (priorDist[topic] ?? 0) / priorTotal
      if (delta > best.delta) best = { topic, delta }
    }
    if (best.delta > 0.15) driftSignal = { toTopic: best.topic, delta: best.delta }
  }

  const totalVisits = (db.prepare(
    `SELECT COUNT(*) AS cnt FROM channel_e_feed_visits WHERE user_id = ?`
  ).get(userId) as any)?.cnt ?? 0

  const existing = db.prepare(`SELECT user_id FROM channel_e_profiles WHERE user_id = ?`).get(userId)
  if (existing) {
    db.prepare(`
      UPDATE channel_e_profiles SET
        total_feed_visits = ?,
        last_visit_at = datetime('now'),
        topic_evolution = ?,
        dominant_topics = ?,
        top_recurring_accounts = ?,
        drift_signal = ?,
        last_updated = datetime('now')
      WHERE user_id = ?
    `).run(totalVisits, j(evolution), j(dominant), j(topAccounts), j(driftSignal), userId)
  } else {
    db.prepare(`
      INSERT INTO channel_e_profiles
        (user_id, total_feed_visits, last_visit_at, topic_evolution, dominant_topics, top_recurring_accounts, drift_signal, last_updated)
      VALUES (?, ?, datetime('now'), ?, ?, ?, ?, datetime('now'))
    `).run(userId, totalVisits, j(evolution), j(dominant), j(topAccounts), j(driftSignal))
  }
}

// E.4: merge new own-profile topic observation into accumulated own_content_topics
function updateOwnContentTopics(userId: string, newTopics: Record<string, number>): void {
  const existing = db.prepare(`SELECT own_content_topics FROM channel_e_profiles WHERE user_id = ?`).get(userId) as any
  let merged: Record<string, number> = {}
  if (existing) {
    merged = p(existing.own_content_topics) ?? {}
  }
  for (const [topic, count] of Object.entries(newTopics)) {
    merged[topic] = (merged[topic] ?? 0) + count
  }
  if (existing) {
    db.prepare(`UPDATE channel_e_profiles SET own_content_topics = ?, last_updated = datetime('now') WHERE user_id = ?`)
      .run(j(merged), userId)
  } else {
    db.prepare(`INSERT INTO channel_e_profiles (user_id, own_content_topics, last_updated) VALUES (?, ?, datetime('now'))`)
      .run(userId, j(merged))
  }
}
