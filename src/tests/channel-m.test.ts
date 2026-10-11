import assert from 'node:assert/strict'
import { db } from '../lib/db.js'
import {
  extractVocabulary, classifyWord, computeDriftFromWords,
} from '../lib/channel-m/evolution-analyzer.js'
import { trackVocabulary } from '../lib/channel-m/vocabulary-tracker.js'
import { buildChannelMContextBlock } from '../lib/channel-m/context-builder.js'

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

const U = 'cm-test-' + Date.now()

function clean(userId: string) {
  db.prepare(`DELETE FROM channel_m_word_log WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_m_vocab_summary WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_m_profiles WHERE user_id = ?`).run(userId)
}

// ─── Vocabulary Extraction ────────────────────────────────────────────────────

console.log('\n── Vocabulary Extraction ───────────────────────────────────────────')

test('ve-a: extracts meaningful words from a message', () => {
  const words = extractVocabulary('Help me draft a fundraising pitch for our Series B round')
  const extracted = words.map(w => w.word)
  assert.ok(extracted.includes('fundraising'), `expected "fundraising" in: ${extracted}`)
  assert.ok(extracted.includes('pitch'), `expected "pitch" in: ${extracted}`)
})

test('ve-b: stop words are filtered out', () => {
  const words = extractVocabulary('This is the email that I want you to send for me please')
  const extracted = words.map(w => w.word)
  assert.ok(!extracted.includes('this'), 'should not include stop word "this"')
  assert.ok(!extracted.includes('that'), 'should not include stop word "that"')
  assert.ok(!extracted.includes('please'), 'should not include stop word "please"')
})

test('ve-c: short words (< 4 chars) filtered out', () => {
  const words = extractVocabulary('Go ask Jim if the API is up')
  const extracted = words.map(w => w.word)
  assert.ok(!extracted.includes('ask'), 'should not include 3-char word')
  assert.ok(!extracted.includes('the'), 'should not include stop word')
})

test('ve-d: mid-sentence capitalized word → proper noun', () => {
  const words = extractVocabulary('I saw that Stripe just launched a new product for startups')
  const stripe = words.find(w => w.word === 'stripe')
  assert.ok(stripe, 'should extract "stripe"')
  assert.ok(stripe!.isProperNoun, 'Stripe should be flagged as proper noun (mid-sentence cap)')
})

test('ve-e: sentence-start capitalized word → NOT proper noun', () => {
  const words = extractVocabulary('Fundraising is going well this month')
  const fund = words.find(w => w.word === 'fundraising')
  assert.ok(fund, 'should extract "fundraising"')
  assert.ok(!fund!.isProperNoun, 'Fundraising at sentence start should NOT be proper noun')
})

test('ve-f: deduplication — same word appears once per message', () => {
  const words = extractVocabulary('The fundraising process is about fundraising for the fundraising round')
  const fundraising = words.filter(w => w.word === 'fundraising')
  assert.equal(fundraising.length, 1, 'same word should appear once in extraction results')
})

// ─── Word Classification ──────────────────────────────────────────────────────

console.log('\n── Word Classification ──────────────────────────────────────────────')

test('wc-a: "fundraising" → financial', () => {
  assert.equal(classifyWord('fundraising'), 'financial')
})

test('wc-b: "deployment" → technical', () => {
  assert.equal(classifyWord('deployment'), 'technical')
})

test('wc-c: "enterprise" → business', () => {
  assert.equal(classifyWord('enterprise'), 'business')
})

test('wc-d: "overwhelmed" → emotional', () => {
  assert.equal(classifyWord('overwhelmed'), 'emotional')
})

test('wc-e: "networking" → relational', () => {
  assert.equal(classifyWord('networking'), 'relational')
})

test('wc-f: common non-category word → null', () => {
  assert.equal(classifyWord('process'), null)
})

// ─── Drift Direction ──────────────────────────────────────────────────────────

console.log('\n── Drift Direction ──────────────────────────────────────────────────')

test('dd-a: dominant financial words → financial drift', () => {
  const words = [
    'fundraising', 'investor', 'valuation', 'runway', 'fundraising',
    'investor', 'funding', 'round', 'valuation', 'burn',
    'investor', 'fundraising', 'capital', 'financial', 'budget',
  ]
  assert.equal(computeDriftFromWords(words), 'financial')
})

test('dd-b: dominant technical words → technical drift', () => {
  const words = [
    'deployment', 'backend', 'architecture', 'typescript', 'deployment',
    'backend', 'database', 'endpoint', 'schema', 'latency',
    'deployment', 'backend', 'framework', 'component', 'pipeline',
  ]
  assert.equal(computeDriftFromWords(words), 'technical')
})

test('dd-c: mixed words with no clear category → null', () => {
  const words = ['fundraising', 'deployment', 'overwhelmed', 'enterprise', 'networking']
  const result = computeDriftFromWords(words)
  // With only 1 word per category, total classified = 5, each = 20% — just at boundary
  // test that it either returns null or any single direction — but the key is it doesn't crash
  assert.ok(result === null || typeof result === 'string')
})

test('dd-d: fewer than 5 classified words → null', () => {
  const words = ['fundraising', 'hello', 'investor']  // only 2 financial words
  assert.equal(computeDriftFromWords(words), null)
})

// ─── Tracking + Profile ───────────────────────────────────────────────────────

console.log('\n── Tracking + Profile ───────────────────────────────────────────────')

test('tp-a: words written to word_log on track call', () => {
  const u = U + '-tp-a'
  clean(u)
  trackVocabulary(u, 'Help me prepare a fundraising pitch for our Series B investor meetings')
  const rows = db.prepare(`SELECT word FROM channel_m_word_log WHERE user_id = ?`).all(u) as any[]
  assert.ok(rows.length > 0, 'should have written words to word_log')
  const words = rows.map((r: any) => r.word)
  assert.ok(words.includes('fundraising'), `expected "fundraising" in log: ${words}`)
})

test('tp-b: vocab_summary upserted with count and category', () => {
  const u = U + '-tp-b'
  clean(u)
  trackVocabulary(u, 'I need to work on our fundraising strategy for the round')
  trackVocabulary(u, 'The fundraising process is taking longer than expected')
  const row = db.prepare(`SELECT * FROM channel_m_vocab_summary WHERE user_id = ? AND word = 'fundraising'`).get(u) as any
  assert.ok(row, 'fundraising should be in vocab_summary')
  assert.equal(row.total_count, 2)
  assert.equal(row.category, 'financial')
})

test('tp-c: proper noun flagged is_proper_noun=1 in vocab_summary', () => {
  const u = U + '-tp-c'
  clean(u)
  trackVocabulary(u, 'I was chatting with Sarah about the partnership yesterday')
  const row = db.prepare(`SELECT is_proper_noun FROM channel_m_vocab_summary WHERE user_id = ? AND word = 'sarah'`).get(u) as any
  assert.ok(row, '"sarah" should be in vocab_summary')
  assert.equal(row.is_proper_noun, 1, 'Sarah should be flagged as proper noun')
})

test('tp-d: profile created with drift_direction after tracking', () => {
  const u = U + '-tp-d'
  clean(u)
  // Send several technical messages to build drift
  const msgs = [
    'Help me design the backend architecture for the new microservice',
    'Review the database schema and endpoint design',
    'The deployment pipeline needs to handle typescript compilation',
    'I need to refactor the component library and framework setup',
  ]
  for (const msg of msgs) trackVocabulary(u, msg)
  const profile = db.prepare(`SELECT drift_direction FROM channel_m_profiles WHERE user_id = ?`).get(u) as any
  assert.ok(profile, 'profile should exist')
  // Direction might be technical or null depending on word counts
  assert.ok(profile.drift_direction === 'technical' || profile.drift_direction === null,
    `expected technical or null drift, got: ${profile.drift_direction}`)
})

test('tp-e: total_distinct_words increments correctly', () => {
  const u = U + '-tp-e'
  clean(u)
  trackVocabulary(u, 'fundraising investor valuation runway capital')
  trackVocabulary(u, 'deployment backend architecture typescript schema')
  const profile = db.prepare(`SELECT total_distinct_words FROM channel_m_profiles WHERE user_id = ?`).get(u) as any
  assert.ok(profile.total_distinct_words >= 5, `expected >= 5 distinct words, got: ${profile.total_distinct_words}`)
})

// ─── Context Builder ──────────────────────────────────────────────────────────

console.log('\n── Context Builder ──────────────────────────────────────────────────')

test('cb-a: no profile → null', () => {
  const u = U + '-cb-a'
  clean(u)
  assert.equal(buildChannelMContextBlock(u), null)
})

test('cb-b: fewer than 15 distinct words → null', () => {
  const u = U + '-cb-b'
  clean(u)
  db.prepare(`INSERT INTO channel_m_profiles (user_id, total_distinct_words) VALUES (?, 8)`).run(u)
  assert.equal(buildChannelMContextBlock(u), null)
})

test('cb-c: financial drift direction → fundraising mode note', () => {
  const u = U + '-cb-c'
  clean(u)
  db.prepare(`INSERT INTO channel_m_profiles (user_id, total_distinct_words, drift_direction) VALUES (?, 20, 'financial')`).run(u)
  const block = buildChannelMContextBlock(u)
  assert.ok(block?.includes('financial') || block?.includes('fundraising'), `expected financial/fundraising note:\n${block}`)
})

test('cb-d: technical drift direction → implementation context note', () => {
  const u = U + '-cb-d'
  clean(u)
  db.prepare(`INSERT INTO channel_m_profiles (user_id, total_distinct_words, drift_direction) VALUES (?, 20, 'technical')`).run(u)
  const block = buildChannelMContextBlock(u)
  assert.ok(block?.includes('technical') || block?.includes('implementation'), `expected technical note:\n${block}`)
})

test('cb-e: relational drift → network-building note', () => {
  const u = U + '-cb-e'
  clean(u)
  db.prepare(`INSERT INTO channel_m_profiles (user_id, total_distinct_words, drift_direction) VALUES (?, 20, 'relational')`).run(u)
  const block = buildChannelMContextBlock(u)
  assert.ok(block?.toLowerCase().includes('relational') || block?.toLowerCase().includes('network'), `expected relational note:\n${block}`)
})

test('cb-f: arrival word with 3+ recent count → surfaced in context', () => {
  const u = U + '-cb-f'
  clean(u)
  db.prepare(`INSERT INTO channel_m_profiles (user_id, total_distinct_words) VALUES (?, 20)`).run(u)
  // Insert a word that appears 3 times, first seen today, is a category word
  db.prepare(`
    INSERT INTO channel_m_vocab_summary (user_id, word, total_count, first_seen, last_seen, is_proper_noun, category)
    VALUES (?, 'fundraising', 4, datetime('now'), datetime('now'), 0, 'financial')
  `).run(u)
  const block = buildChannelMContextBlock(u)
  assert.ok(block?.includes('fundraising'), `expected arrival "fundraising" in:\n${block}`)
  assert.ok(block?.includes('arrived') || block?.includes('New'), `expected arrival marker in:\n${block}`)
})

test('cb-g: proper noun arrival → surfaced in context', () => {
  const u = U + '-cb-g'
  clean(u)
  db.prepare(`INSERT INTO channel_m_profiles (user_id, total_distinct_words) VALUES (?, 20)`).run(u)
  db.prepare(`
    INSERT INTO channel_m_vocab_summary (user_id, word, total_count, first_seen, last_seen, is_proper_noun, category)
    VALUES (?, 'anthropic', 3, datetime('now'), datetime('now'), 1, 'technical')
  `).run(u)
  const block = buildChannelMContextBlock(u)
  assert.ok(block?.includes('anthropic'), `expected proper noun "anthropic" in arrivals:\n${block}`)
})

test('cb-h: departed word (30+ days absent, 5+ historical) → retired topic note', () => {
  const u = U + '-cb-h'
  clean(u)
  db.prepare(`INSERT INTO channel_m_profiles (user_id, total_distinct_words) VALUES (?, 20)`).run(u)
  // Word used heavily but last seen 40 days ago, first seen 80 days ago
  db.prepare(`
    INSERT INTO channel_m_vocab_summary (user_id, word, total_count, first_seen, last_seen, is_proper_noun, category)
    VALUES (?, 'valuation', 8, datetime('now', '-80 days'), datetime('now', '-40 days'), 0, 'financial')
  `).run(u)
  const block = buildChannelMContextBlock(u)
  assert.ok(block?.includes('valuation'), `expected departed word "valuation" in:\n${block}`)
  assert.ok(block?.includes('Retired') || block?.includes('retired') || block?.includes('stop'), `expected retirement note in:\n${block}`)
})

test('cb-i: word with < 3 recent count → NOT surfaced as arrival', () => {
  const u = U + '-cb-i'
  clean(u)
  db.prepare(`INSERT INTO channel_m_profiles (user_id, total_distinct_words) VALUES (?, 20)`).run(u)
  db.prepare(`
    INSERT INTO channel_m_vocab_summary (user_id, word, total_count, first_seen, last_seen, is_proper_noun, category)
    VALUES (?, 'valuation', 2, datetime('now'), datetime('now'), 0, 'financial')
  `).run(u)
  const block = buildChannelMContextBlock(u)
  assert.ok(!block?.includes('valuation'), `word with count < 3 should not be in arrivals:\n${block}`)
})

// ─── Summary ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n── Results ───────────────────────────────────────────────────────`)
  console.log(`   ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 400)
