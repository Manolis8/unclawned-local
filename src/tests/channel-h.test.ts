import assert from 'node:assert/strict'
import { db } from '../lib/db.js'
import { indexTaskOutput } from '../lib/channel-h/output-indexer.js'
import { detectOutcomeSignal } from '../lib/channel-h/outcome-detector.js'
import { buildChannelHContextBlock } from '../lib/channel-h/context-builder.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void | Promise<void>) {
  Promise.resolve().then(fn).then(() => {
    console.log(`  ✓ ${name}`)
    passed++
  }).catch((err: Error) => {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    failed++
  })
}

const U = 'ch-test-' + Date.now()

function clean(userId: string) {
  db.prepare(`DELETE FROM channel_h_corpus_items WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_h_profiles WHERE user_id = ?`).run(userId)
}

function seedTask(taskId: string, output: string) {
  try {
    db.prepare(`INSERT INTO tasks (id, user_id, prompt, output, status) VALUES (?, ?, ?, ?, 'done')`)
      .run(taskId, 'test-user', 'test prompt', output)
  } catch {
    db.prepare(`UPDATE tasks SET output = ? WHERE id = ?`).run(output, taskId)
  }
}

function cleanTask(taskId: string) {
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId)
}

// ─── H.1 Content Type Detection + Indexing ────────────────────────────────────

console.log('\n── H.1 Output Indexer ─────────────────────────────────────────────')

test('oi-a: indexes email output and stores content_type = email', () => {
  const u = U + '-oi-a'
  const tid = 'task-h-oi-a'
  clean(u)
  seedTask(tid, 'Dear Sarah,\n\nI hope this finds you well. I wanted to follow up on our conversation about the investment.\n\nBest regards,\nManolis')
  indexTaskOutput(u, tid, 'Draft an email to Sarah about the investment follow up', 'email drafted')
  cleanTask(tid)
  const row = db.prepare(`SELECT content_type FROM channel_h_corpus_items WHERE user_id = ?`).get(u) as any
  assert.ok(row, 'should have corpus item')
  assert.equal(row.content_type, 'email')
})

test('oi-b: indexes post output as post type', () => {
  const u = U + '-oi-b'
  const tid = 'task-h-oi-b'
  clean(u)
  seedTask(tid, '🚀 Three months ago I launched my first product.\n\nHere\'s what I learned about building in public:\n\n1. Ship early\n2. Talk to users\n3. Iterate fast\n\nWhat\'s your experience?')
  indexTaskOutput(u, tid, 'Write a LinkedIn post about my product launch lessons', 'post created')
  cleanTask(tid)
  const row = db.prepare(`SELECT content_type FROM channel_h_corpus_items WHERE user_id = ?`).get(u) as any
  assert.equal(row?.content_type, 'post')
})

test('oi-c: does NOT index execution/automation prompts', () => {
  const u = U + '-oi-c'
  const tid = 'task-h-oi-c'
  clean(u)
  seedTask(tid, 'Navigated to the page and clicked the submit button successfully.')
  indexTaskOutput(u, tid, 'Open my Gmail and archive all emails from last week', 'done')
  cleanTask(tid)
  const row = db.prepare(`SELECT id FROM channel_h_corpus_items WHERE user_id = ?`).get(u)
  assert.equal(row, undefined, 'should not index automation outputs')
})

test('oi-d: skips output shorter than 30 chars', () => {
  const u = U + '-oi-d'
  const tid = 'task-h-oi-d'
  clean(u)
  seedTask(tid, 'Done.')
  indexTaskOutput(u, tid, 'Draft an email to my investor', 'email done')
  cleanTask(tid)
  const row = db.prepare(`SELECT id FROM channel_h_corpus_items WHERE user_id = ?`).get(u)
  assert.equal(row, undefined, 'should not index trivially short outputs')
})

test('oi-e: stores topics JSON from output content', () => {
  const u = U + '-oi-e'
  const tid = 'task-h-oi-e'
  clean(u)
  seedTask(tid, 'Dear Tom,\n\nWe are excited to share our fundraising progress. Our seed round is progressing well with strong investor interest. The term sheet is expected by end of week.\n\nBest regards')
  indexTaskOutput(u, tid, 'Draft an investor update email for our seed round', 'email drafted')
  cleanTask(tid)
  const row = db.prepare(`SELECT topics FROM channel_h_corpus_items WHERE user_id = ?`).get(u) as any
  const topics = JSON.parse(row.topics)
  assert.ok(topics.fundraising >= 1 || topics.startup >= 1, `expected fundraising/startup in topics: ${JSON.stringify(topics)}`)
})

test('oi-f: total_indexed increments with each indexed item', () => {
  const u = U + '-oi-f'
  clean(u)
  for (let i = 0; i < 3; i++) {
    const tid = `task-h-oi-f-${i}`
    seedTask(tid, 'Dear Alice,\n\nFollowing up on our previous conversation about the partnership opportunity. Looking forward to connecting soon.\n\nBest regards')
    indexTaskOutput(u, tid, 'Draft a follow-up email to Alice about the partnership', 'email sent')
    cleanTask(tid)
  }
  const profile = db.prepare(`SELECT total_indexed FROM channel_h_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile.total_indexed, 3)
})

test('oi-g: quality signal resolves to hit after 60 min with no Channel B corrections', () => {
  const u = U + '-oi-g'
  clean(u)
  // Insert a corpus item with created_at 2 hours ago
  db.prepare(`
    INSERT INTO channel_h_corpus_items (id, user_id, task_id, content_type, content_preview, word_count, topics, quality_signal, created_at)
    VALUES (randomblob(16), ?, 'task-g', 'email', 'Dear Alice...', 50, '{}', 'unknown', datetime('now', '-2 hours'))
  `).run(u)
  // No Channel B corrections for this user
  // Trigger quality resolution by indexing a new item
  const tid = 'task-h-oi-g-2'
  seedTask(tid, 'Dear Bob,\n\nThank you for taking the time to speak with us about our startup and the potential investment opportunity.\n\nBest regards')
  indexTaskOutput(u, tid, 'Draft an email to Bob about our fundraising round', 'email indexed')
  cleanTask(tid)
  const items = db.prepare(`SELECT quality_signal FROM channel_h_corpus_items WHERE user_id = ? ORDER BY rowid`).all(u) as any[]
  assert.equal(items[0].quality_signal, 'hit', `expected first item to resolve to 'hit', got ${items[0].quality_signal}`)
})

test('oi-h: quality signal resolves to miss when Channel B correction exists after corpus item', () => {
  const u = U + '-oi-h'
  clean(u)
  // Insert corpus item 2 hours ago
  db.prepare(`
    INSERT INTO channel_h_corpus_items (id, user_id, task_id, content_type, content_preview, word_count, topics, quality_signal, created_at)
    VALUES (randomblob(16), ?, 'task-h', 'email', 'Draft email content here...', 40, '{}', 'unknown', datetime('now', '-2 hours'))
  `).run(u)
  // Insert a Channel B correction signal 1.5 hours ago (within the 60-min window)
  db.prepare(`
    INSERT INTO channel_b_raw_signals (id, user_id, session_id, user_message_text, user_message_length, is_correction, correction_level, created_at)
    VALUES (randomblob(16), ?, 's1', 'That is wrong, please redo it', 30, 1, 2, datetime('now', '-90 minutes'))
  `).run(u)
  // Trigger resolution
  const tid = 'task-h-oi-h-2'
  seedTask(tid, 'Dear Carol,\n\nFollowing up regarding the proposal we discussed last week. I would love to schedule a call to discuss next steps.\n\nBest regards')
  indexTaskOutput(u, tid, 'Draft a follow-up email to Carol about the proposal', 'email drafted')
  cleanTask(tid)
  const items = db.prepare(`SELECT quality_signal FROM channel_h_corpus_items WHERE user_id = ? ORDER BY rowid`).all(u) as any[]
  assert.equal(items[0].quality_signal, 'miss', `expected 'miss', got ${items[0].quality_signal}`)
})

// ─── H.2 Outcome Detector ─────────────────────────────────────────────────────

console.log('\n── H.2 Outcome Detector ───────────────────────────────────────────')

test('od-a: positive outcome message updates most recent corpus item', () => {
  const u = U + '-od-a'
  clean(u)
  db.prepare(`
    INSERT INTO channel_h_corpus_items (id, user_id, task_id, content_type, content_preview, word_count, topics, quality_signal, created_at)
    VALUES (randomblob(16), ?, 'task-x', 'email', 'Email content', 50, '{}', 'hit', datetime('now', '-1 hours'))
  `).run(u)
  detectOutcomeSignal(u, 'Great news — they replied to my email and they\'re interested in moving forward!')
  const row = db.prepare(`SELECT outcome_sentiment FROM channel_h_corpus_items WHERE user_id = ?`).get(u) as any
  assert.equal(row.outcome_sentiment, 'positive')
})

test('od-b: negative outcome message updates most recent corpus item', () => {
  const u = U + '-od-b'
  clean(u)
  db.prepare(`
    INSERT INTO channel_h_corpus_items (id, user_id, task_id, content_type, content_preview, word_count, topics, quality_signal, created_at)
    VALUES (randomblob(16), ?, 'task-x', 'email', 'Email content', 50, '{}', 'hit', datetime('now', '-1 hours'))
  `).run(u)
  detectOutcomeSignal(u, 'They passed on it. No response after a week and then got a rejection.')
  const row = db.prepare(`SELECT outcome_sentiment FROM channel_h_corpus_items WHERE user_id = ?`).get(u) as any
  assert.equal(row.outcome_sentiment, 'negative')
})

test('od-c: neutral message (no outcome signal) leaves outcome_sentiment null', () => {
  const u = U + '-od-c'
  clean(u)
  db.prepare(`
    INSERT INTO channel_h_corpus_items (id, user_id, task_id, content_type, content_preview, word_count, topics, quality_signal, created_at)
    VALUES (randomblob(16), ?, 'task-x', 'email', 'Email content', 50, '{}', 'hit', datetime('now', '-1 hours'))
  `).run(u)
  detectOutcomeSignal(u, 'Can you help me draft another email to a different contact?')
  const row = db.prepare(`SELECT outcome_sentiment FROM channel_h_corpus_items WHERE user_id = ?`).get(u) as any
  assert.equal(row.outcome_sentiment, null, 'should not update outcome for neutral message')
})

test('od-d: does not update corpus items older than 7 days', () => {
  const u = U + '-od-d'
  clean(u)
  db.prepare(`
    INSERT INTO channel_h_corpus_items (id, user_id, task_id, content_type, content_preview, word_count, topics, quality_signal, created_at)
    VALUES (randomblob(16), ?, 'task-old', 'email', 'Old email content', 50, '{}', 'hit', datetime('now', '-8 days'))
  `).run(u)
  detectOutcomeSignal(u, 'They replied to my email — they\'re very interested!')
  const row = db.prepare(`SELECT outcome_sentiment FROM channel_h_corpus_items WHERE user_id = ?`).get(u) as any
  assert.equal(row.outcome_sentiment, null, 'should not update item older than 7 days')
})

// ─── H.3 Context Builder ──────────────────────────────────────────────────────

console.log('\n── H.3 Context Builder ─────────────────────────────────────────────')

test('cb-a: returns null with fewer than 3 indexed items', () => {
  const u = U + '-cb-a'
  clean(u)
  db.prepare(`INSERT INTO channel_h_profiles (user_id, total_indexed) VALUES (?, 2)`).run(u)
  const block = buildChannelHContextBlock(u)
  assert.equal(block, null)
})

test('cb-b: returns null for user with no profile', () => {
  const u = U + '-cb-b'
  clean(u)
  const block = buildChannelHContextBlock(u)
  assert.equal(block, null)
})

test('cb-c: returns block with evergreen topics when 3+ items indexed', () => {
  const u = U + '-cb-c'
  clean(u)
  db.prepare(`INSERT INTO channel_h_profiles (user_id, total_indexed, evergreen_topics)
    VALUES (?, 5, ?)`).run(u, JSON.stringify(['fundraising', 'startup', 'ai_agents']))
  const block = buildChannelHContextBlock(u)
  assert.ok(block !== null, 'should return a context block')
  assert.ok(block!.includes('Output Intelligence'), 'should have header')
  assert.ok(block!.includes('fundraising') || block!.includes('startup building'), `expected topic labels in:\n${block}`)
})

test('cb-d: includes quality benchmark when types have 3+ signals', () => {
  const u = U + '-cb-d'
  clean(u)
  db.prepare(`INSERT INTO channel_h_profiles (user_id, total_indexed, evergreen_topics, hit_rate_by_type)
    VALUES (?, 10, ?, ?)`).run(
    u,
    JSON.stringify(['fundraising']),
    JSON.stringify({ email: { hits: 8, misses: 2 }, analysis: { hits: 1, misses: 4 } })
  )
  const block = buildChannelHContextBlock(u)
  assert.ok(block?.includes('emails (land well)'), `expected email quality signal in:\n${block}`)
  assert.ok(block?.includes('analyses (often need revision)'), `expected analysis signal in:\n${block}`)
})

test('cb-e: includes outcome section when recent outcomes exist', () => {
  const u = U + '-cb-e'
  clean(u)
  db.prepare(`INSERT INTO channel_h_profiles (user_id, total_indexed, evergreen_topics)
    VALUES (?, 5, ?)`).run(u, JSON.stringify(['growth']))
  db.prepare(`
    INSERT INTO channel_h_corpus_items (id, user_id, task_id, content_type, content_preview, word_count, topics, quality_signal, outcome_sentiment, outcome_context, created_at)
    VALUES (randomblob(16), ?, 'task-x', 'email', 'Email content', 50, '{}', 'hit', 'positive', 'They replied the same day and want to move forward', datetime('now'))
  `).run(u)
  const block = buildChannelHContextBlock(u)
  assert.ok(block?.includes('positive') || block?.includes('outcomes'), `expected outcome section in:\n${block}`)
})

test('cb-f: includes vocabulary drift when 3+ months of data exist', () => {
  const u = U + '-cb-f'
  clean(u)
  db.prepare(`INSERT INTO channel_h_profiles (user_id, total_indexed, evergreen_topics, vocabulary_evolution)
    VALUES (?, 15, ?, ?)`).run(
    u,
    JSON.stringify(['ai_agents']),
    JSON.stringify([
      { month: '2026-01', topWords: ['finance', 'budget', 'accounting', 'quarterly', 'revenue'] },
      { month: '2026-03', topWords: ['product', 'roadmap', 'feature', 'ux', 'sprint'] },
      { month: '2026-05', topWords: ['agents', 'llm', 'prompt', 'automation', 'model'] },
    ])
  )
  const block = buildChannelHContextBlock(u)
  assert.ok(block?.includes('Vocabulary drift') || block?.includes('vocabulary'), `expected vocab drift in:\n${block}`)
  assert.ok(block?.includes('finance') || block?.includes('agents'), `expected old/new words in:\n${block}`)
})

// ─── Summary ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n── Results ───────────────────────────────────────────────────────`)
  console.log(`   ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 400)
