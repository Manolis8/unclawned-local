import assert from 'node:assert/strict'
import { db } from '../lib/db.js'
import { classifyTopics, dominantTopics } from '../lib/channel-e/topic-classifier.js'
import { observeLinkedInContent } from '../lib/channel-e/feed-observer.js'
import { buildChannelEContextBlock } from '../lib/channel-e/context-builder.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void | Promise<void>) {
  Promise.resolve().then(fn).then(() => {
    console.log(`  ✓ ${name}`)
    passed++
  }).catch((err) => {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    failed++
  })
}

const TEST_USER = 'test-channel-e-user-' + Date.now()

function cleanUser(userId: string) {
  db.prepare(`DELETE FROM channel_e_feed_visits WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_e_recurring_accounts WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_e_profiles WHERE user_id = ?`).run(userId)
}

// ─── E.1 Topic Classifier ─────────────────────────────────────────────────────

console.log('\n── E.1 Topic Classifier ──────────────────────────────────────────')

test('tc-a: classifies AI & agents content', () => {
  const dist = classifyTopics('Building an LLM-powered agent with OpenAI embeddings and RAG pipelines')
  assert.ok((dist.ai_agents ?? 0) >= 3, `expected ai_agents >= 3, got ${dist.ai_agents}`)
})

test('tc-b: classifies startup founder content', () => {
  const dist = classifyTopics('We pivoted the startup last week — co-founder and I bootstrapped to 100 users')
  assert.ok((dist.startup ?? 0) >= 2, `expected startup >= 2, got ${dist.startup}`)
})

test('tc-c: classifies fundraising content', () => {
  const dist = classifyTopics('Raised a $2M seed round. The term sheet came in at $8M valuation from our lead angel investor')
  assert.ok((dist.fundraising ?? 0) >= 3, `expected fundraising >= 3, got ${dist.fundraising}`)
})

test('tc-d: classifies mixed content and returns multi-topic distribution', () => {
  const dist = classifyTopics('As a founder building our SaaS product roadmap, we focus on MRR growth and customer acquisition')
  const keys = Object.keys(dist)
  assert.ok(keys.length >= 2, `expected >= 2 topics, got ${keys.join(', ')}`)
})

test('tc-e: empty content returns empty distribution', () => {
  const dist = classifyTopics('')
  assert.deepEqual(dist, {})
})

test('tc-f: dominantTopics returns top N in descending order', () => {
  const dist = { ai_agents: 5, startup: 3, engineering: 1, growth: 4 }
  const top = dominantTopics(dist, 2)
  assert.deepEqual(top, ['ai_agents', 'growth'])
})

test('tc-g: dominantTopics handles fewer topics than N', () => {
  const dist = { ai_agents: 5 }
  const top = dominantTopics(dist, 3)
  assert.deepEqual(top, ['ai_agents'])
})

// ─── E.2 Feed Observer — page type detection ──────────────────────────────────

console.log('\n── E.2 Feed Observer — page type + DB writes ────────────────────')

test('fo-a: ignores non-LinkedIn URLs', () => {
  const u = TEST_USER + '-fo-a'
  cleanUser(u)
  observeLinkedInContent(u, null, 'https://twitter.com/feed', 'some content')
  const row = db.prepare(`SELECT id FROM channel_e_feed_visits WHERE user_id = ?`).get(u)
  assert.equal(row, undefined, 'should not store non-LinkedIn visit')
})

test('fo-b: stores feed visit for linkedin.com/feed URL', () => {
  const u = TEST_USER + '-fo-b'
  cleanUser(u)
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'AI agents automation LLM')
  const row = db.prepare(`SELECT page_type FROM channel_e_feed_visits WHERE user_id = ?`).get(u) as any
  assert.ok(row, 'should store a feed visit')
  assert.equal(row.page_type, 'feed')
})

test('fo-c: stores profile visit for linkedin.com/in/ URL', () => {
  const u = TEST_USER + '-fo-c'
  cleanUser(u)
  observeLinkedInContent(u, null, 'https://www.linkedin.com/in/someone', 'product roadmap')
  const row = db.prepare(`SELECT page_type FROM channel_e_feed_visits WHERE user_id = ?`).get(u) as any
  assert.ok(row, 'should store profile visit')
  assert.equal(row.page_type, 'profile_other')
})

test('fo-d: stores post visit for linkedin.com/posts/ URL', () => {
  const u = TEST_USER + '-fo-d'
  cleanUser(u)
  observeLinkedInContent(u, null, 'https://www.linkedin.com/posts/user_activity-123', 'fundraising series a')
  const row = db.prepare(`SELECT page_type FROM channel_e_feed_visits WHERE user_id = ?`).get(u) as any
  assert.ok(row, 'should store post visit')
  assert.equal(row.page_type, 'post')
})

test('fo-e: topic_distribution is stored as JSON with detected topics', () => {
  const u = TEST_USER + '-fo-e'
  cleanUser(u)
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'building an AI agent with LLM and prompt engineering automation')
  const row = db.prepare(`SELECT topic_distribution FROM channel_e_feed_visits WHERE user_id = ?`).get(u) as any
  const dist = JSON.parse(row.topic_distribution)
  assert.ok((dist.ai_agents ?? 0) >= 2, `expected ai_agents >= 2 in distribution, got ${dist.ai_agents}`)
})

// ─── E.3 Recurring Accounts ───────────────────────────────────────────────────

console.log('\n── E.3 Recurring Accounts ────────────────────────────────────────')

test('ra-a: first occurrence of a name creates recurring account row', () => {
  const u = TEST_USER + '-ra-a'
  cleanUser(u)
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'John Smith shared a post about AI startup')
  const row = db.prepare(
    `SELECT account_name, appearance_count FROM channel_e_recurring_accounts WHERE user_id = ? AND account_name = 'John Smith'`
  ).get(u) as any
  assert.ok(row, 'should create recurring account row')
  assert.equal(row.appearance_count, 1)
})

test('ra-b: second occurrence increments appearance_count', () => {
  const u = TEST_USER + '-ra-b'
  cleanUser(u)
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'Alice Johnson posted about fundraising')
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'Alice Johnson shared about seed round')
  const row = db.prepare(
    `SELECT appearance_count FROM channel_e_recurring_accounts WHERE user_id = ? AND account_name = 'Alice Johnson'`
  ).get(u) as any
  assert.ok(row, 'should have recurring account row')
  assert.equal(row.appearance_count, 2)
})

test('ra-c: multiple distinct names are tracked separately', () => {
  const u = TEST_USER + '-ra-c'
  cleanUser(u)
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'Tom Baker and Sarah Chen both posted about AI agents')
  const rows = db.prepare(
    `SELECT account_name FROM channel_e_recurring_accounts WHERE user_id = ? ORDER BY account_name`
  ).all(u) as any[]
  const names = rows.map(r => r.account_name)
  assert.ok(names.includes('Tom Baker'), `expected Tom Baker in ${names.join(', ')}`)
  assert.ok(names.includes('Sarah Chen'), `expected Sarah Chen in ${names.join(', ')}`)
})

// ─── E.4 Profile / drift detection ───────────────────────────────────────────

console.log('\n── E.4 Profile and drift detection ──────────────────────────────')

test('pd-a: profile row is created after first feed visit', () => {
  const u = TEST_USER + '-pd-a'
  cleanUser(u)
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'AI agent automation')
  const row = db.prepare(`SELECT user_id, total_feed_visits FROM channel_e_profiles WHERE user_id = ?`).get(u) as any
  assert.ok(row, 'profile row should exist')
  assert.equal(row.total_feed_visits, 1)
})

test('pd-b: total_feed_visits increments with each feed visit', () => {
  const u = TEST_USER + '-pd-b'
  cleanUser(u)
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'startup founder bootstrapped')
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'founder pivot mvp')
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'entrepreneurship early stage')
  const row = db.prepare(`SELECT total_feed_visits FROM channel_e_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(row.total_feed_visits, 3)
})

test('pd-c: dominant_topics reflects most common topics across visits', () => {
  const u = TEST_USER + '-pd-c'
  cleanUser(u)
  // 3 visits heavy on AI, 1 on startup
  for (let i = 0; i < 3; i++) {
    observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'LLM agent AI automation prompt engineering openai claude embeddings')
  }
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'startup founder pivot mvp')
  const row = db.prepare(`SELECT dominant_topics FROM channel_e_profiles WHERE user_id = ?`).get(u) as any
  const dominant: string[] = JSON.parse(row.dominant_topics)
  assert.equal(dominant[0], 'ai_agents', `expected ai_agents to be #1, got ${dominant[0]}`)
})

test('pd-d: drift_signal detected when topic share shifts significantly', () => {
  const u = TEST_USER + '-pd-d'
  cleanUser(u)
  // Prior 3 visits: career-heavy
  for (let i = 0; i < 3; i++) {
    observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'career job search interview resume salary promotion workplace')
  }
  // Recent 3 visits: AI-heavy
  for (let i = 0; i < 3; i++) {
    observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'LLM AI agent openai claude prompt engineering automation embeddings fine-tun')
  }
  const row = db.prepare(`SELECT drift_signal FROM channel_e_profiles WHERE user_id = ?`).get(u) as any
  const drift = JSON.parse(row.drift_signal ?? 'null')
  assert.ok(drift !== null, 'drift_signal should be set')
  assert.equal(drift.toTopic, 'ai_agents', `expected drift toward ai_agents, got ${drift.toTopic}`)
  assert.ok(drift.delta > 0.15, `expected delta > 0.15, got ${drift.delta}`)
})

test('pd-e: no drift when visits are consistent', () => {
  const u = TEST_USER + '-pd-e'
  cleanUser(u)
  // All 6 visits same topic
  for (let i = 0; i < 6; i++) {
    observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'startup founder bootstrapped entrepreneurship early stage')
  }
  const row = db.prepare(`SELECT drift_signal FROM channel_e_profiles WHERE user_id = ?`).get(u) as any
  const drift = JSON.parse(row.drift_signal ?? 'null')
  assert.equal(drift, null, 'drift_signal should be null when topics are consistent')
})

// ─── E.5 Context Builder ──────────────────────────────────────────────────────

console.log('\n── E.5 Context Builder ───────────────────────────────────────────')

test('cb-a: returns null when user has fewer than 2 visits', () => {
  const u = TEST_USER + '-cb-a'
  cleanUser(u)
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'AI agents')
  const block = buildChannelEContextBlock(u)
  assert.equal(block, null, 'should return null with only 1 visit')
})

test('cb-b: returns context block after 2+ visits', () => {
  const u = TEST_USER + '-cb-b'
  cleanUser(u)
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'AI agent automation LLM')
  observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'openai claude prompt engineering')
  const block = buildChannelEContextBlock(u)
  assert.ok(block !== null, 'should return a context block with 2 visits')
  assert.ok(block!.includes('LinkedIn Feed Intelligence'), 'should have section header')
})

test('cb-c: context block includes dominant topics', () => {
  const u = TEST_USER + '-cb-c'
  cleanUser(u)
  for (let i = 0; i < 3; i++) {
    observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'startup founder bootstrapped entrepreneurship early stage pivot')
  }
  const block = buildChannelEContextBlock(u)
  assert.ok(block?.includes('startup building'), `expected "startup building" in block:\n${block}`)
})

test('cb-d: context block includes drift signal when present', () => {
  const u = TEST_USER + '-cb-d'
  cleanUser(u)
  for (let i = 0; i < 3; i++) {
    observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'career job search interview resume salary')
  }
  for (let i = 0; i < 3; i++) {
    observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'LLM AI agent openai claude prompt automation embeddings fine-tun')
  }
  const block = buildChannelEContextBlock(u)
  assert.ok(block?.includes('Trend shift') || block?.includes('shift'), `expected drift mention in block:\n${block}`)
})

test('cb-e: context block includes recurring accounts when 3+ appearances', () => {
  const u = TEST_USER + '-cb-e'
  cleanUser(u)
  for (let i = 0; i < 4; i++) {
    observeLinkedInContent(u, null, 'https://www.linkedin.com/feed/', 'Bob Martin shared about engineering startup')
  }
  const block = buildChannelEContextBlock(u)
  assert.ok(block?.includes('Bob Martin'), `expected Bob Martin in recurring accounts block:\n${block}`)
})

test('cb-f: returns null for user with no LinkedIn visits', () => {
  const u = TEST_USER + '-cb-f'
  cleanUser(u)
  const block = buildChannelEContextBlock(u)
  assert.equal(block, null)
})

// ─── Summary ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n── Results ───────────────────────────────────────────────────────`)
  console.log(`   ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 200)
