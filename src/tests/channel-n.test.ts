import assert from 'node:assert/strict'
import { db } from '../lib/db.js'
import {
  extractProperNouns, detectWorldEvents, extractWatchlistEntities, scoreRelevance,
} from '../lib/channel-n/world-scanner.js'
import { trackWorldSignals } from '../lib/channel-n/event-tracker.js'
import { buildChannelNContextBlock } from '../lib/channel-n/context-builder.js'

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

const U = 'cn-test-' + Date.now()

function clean(userId: string) {
  db.prepare(`DELETE FROM channel_n_watchlist WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_n_events WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_n_profiles WHERE user_id = ?`).run(userId)
}

function insertEvent(userId: string, entityName: string, eventType: string, headline: string, score: number, surfaced = 0) {
  db.prepare(`
    INSERT INTO channel_n_events (id, user_id, entity_name, event_type, headline, relevance_score, surfaced)
    VALUES (randomblob(16), ?, ?, ?, ?, ?, ?)
  `).run(userId, entityName, eventType, headline, score, surfaced)
}

// ─── Proper Noun Extraction ───────────────────────────────────────────────────

console.log('\n── Proper Noun Extraction ───────────────────────────────────────────')

test('pn-a: mid-sentence company name extracted', () => {
  const nouns = extractProperNouns('I heard that Stripe just raised a new round of funding')
  assert.ok(nouns.includes('Stripe'), `expected "Stripe" in: ${nouns}`)
})

test('pn-b: two-word proper noun extracted as unit', () => {
  const nouns = extractProperNouns('We should reach out to Sarah Chen about the partnership')
  assert.ok(nouns.includes('Sarah Chen'), `expected "Sarah Chen" in: ${nouns}`)
})

test('pn-c: common sentence-start words skipped', () => {
  const nouns = extractProperNouns('The company is doing well and our team is growing fast')
  assert.ok(!nouns.includes('The'), 'should not include "The"')
  assert.ok(!nouns.includes('Our'), 'should not include "Our"')
})

test('pn-d: multiple entities in one message', () => {
  const nouns = extractProperNouns('I saw that Stripe announced a new product and Anthropic released a model')
  assert.ok(nouns.includes('Stripe'), `expected "Stripe" in: ${nouns}`)
  assert.ok(nouns.includes('Anthropic'), `expected "Anthropic" in: ${nouns}`)
})

test('pn-e: no proper nouns in lowercase message → empty array', () => {
  const nouns = extractProperNouns('help me write a cold email about fundraising')
  assert.equal(nouns.length, 0)
})

// ─── World Event Detection ────────────────────────────────────────────────────

console.log('\n── World Event Detection ─────────────────────────────────────────────')

test('we-a: funding event detected', () => {
  const events = detectWorldEvents('I just heard that Stripe raised $500M in their latest round')
  assert.ok(events.length > 0, 'should detect at least one event')
  const ev = events.find(e => e.eventType === 'funding')
  assert.ok(ev, `expected funding event in: ${JSON.stringify(events)}`)
  assert.equal(ev!.entityName, 'Stripe')
})

test('we-b: launch event detected', () => {
  const events = detectWorldEvents('Anthropic just launched their new Claude model yesterday')
  const ev = events.find(e => e.eventType === 'launch')
  assert.ok(ev, `expected launch event in: ${JSON.stringify(events)}`)
  assert.equal(ev!.entityName, 'Anthropic')
})

test('we-c: personnel event detected', () => {
  const events = detectWorldEvents('John Smith just joined our competitor as their new CTO')
  const ev = events.find(e => e.eventType === 'personnel')
  assert.ok(ev, `expected personnel event in: ${JSON.stringify(events)}`)
})

test('we-d: acquisition/news event detected', () => {
  const events = detectWorldEvents('Salesforce acquired Slack competitor for $2B last week')
  const ev = events.find(e => e.eventType === 'news')
  assert.ok(ev, `expected news event in: ${JSON.stringify(events)}`)
})

test('we-e: no event trigger → empty array', () => {
  const events = detectWorldEvents('write me a cold email about the pitch deck structure for the board')
  assert.equal(events.length, 0)
})

test('we-f: headline extracted correctly', () => {
  const events = detectWorldEvents('I heard Stripe raised $500M in their Series B round')
  assert.ok(events.length > 0)
  assert.ok(events[0].headline.includes('Stripe'), `headline should mention entity: ${events[0].headline}`)
})

// ─── Watchlist Entity Extraction ──────────────────────────────────────────────

console.log('\n── Watchlist Entity Extraction ──────────────────────────────────────')

test('we2-a: company entity extracted', () => {
  const entities = extractWatchlistEntities('We should keep an eye on Stripe and their new pricing model')
  const stripe = entities.find(e => e.name === 'Stripe')
  assert.ok(stripe, `expected Stripe in: ${JSON.stringify(entities)}`)
  assert.equal(stripe!.type, 'company')
})

test('we2-b: person entity classified from context', () => {
  const entities = extractWatchlistEntities('John Smith is now the CTO at our main competitor')
  const john = entities.find(e => e.name === 'John Smith')
  assert.ok(john, `expected "John Smith" in: ${JSON.stringify(entities)}`)
  assert.equal(john!.type, 'person')
})

test('we2-c: no proper nouns → empty array', () => {
  const entities = extractWatchlistEntities('help me with the strategy deck')
  assert.equal(entities.length, 0)
})

// ─── Relevance Scoring ────────────────────────────────────────────────────────

console.log('\n── Relevance Scoring ────────────────────────────────────────────────')

test('rs-a: high mentions + recent → score above surface threshold', () => {
  const score = scoreRelevance(10, 3)  // 10 mentions, 3 days ago
  assert.ok(score >= 50, `expected score >= 50, got ${score}`)
})

test('rs-b: low mentions + old → score below threshold', () => {
  const score = scoreRelevance(1, 120)  // 1 mention, 120 days ago
  assert.ok(score < 50, `expected score < 50, got ${score}`)
})

test('rs-c: moderate mentions + moderate recency → near threshold', () => {
  const score = scoreRelevance(5, 30)  // 5 mentions, 30 days ago
  assert.ok(score >= 30, `expected score >= 30, got ${score}`)
})

test('rs-d: many mentions even if older → still scores', () => {
  const score = scoreRelevance(10, 60)  // 10 mentions, 60 days ago
  assert.ok(score >= 35, `expected score >= 35, got ${score}`)
})

// ─── Tracking + Profile ───────────────────────────────────────────────────────

console.log('\n── Tracking + Profile ───────────────────────────────────────────────')

test('tp-a: watchlist updated when proper nouns mentioned', () => {
  const u = U + '-tp-a'
  clean(u)
  trackWorldSignals(u, 'We should definitely keep an eye on Stripe and their pricing changes')
  const row = db.prepare(`SELECT * FROM channel_n_watchlist WHERE user_id = ? AND entity_name = 'Stripe'`).get(u) as any
  assert.ok(row, 'Stripe should be in watchlist')
  assert.equal(row.mentions_count, 1)
})

test('tp-b: mention count increments on repeated messages', () => {
  const u = U + '-tp-b'
  clean(u)
  trackWorldSignals(u, 'Our competitor Acme is moving fast in our space')
  trackWorldSignals(u, 'I saw Acme just launched a new feature for enterprise')
  const row = db.prepare(`SELECT mentions_count FROM channel_n_watchlist WHERE user_id = ? AND entity_name = 'Acme'`).get(u) as any
  assert.ok(row?.mentions_count >= 2, `expected mentions >= 2, got ${row?.mentions_count}`)
})

test('tp-c: world event logged when event trigger detected', () => {
  const u = U + '-tp-c'
  clean(u)
  trackWorldSignals(u, 'I heard that Stripe just raised a massive Series B funding round')
  const event = db.prepare(`SELECT * FROM channel_n_events WHERE user_id = ?`).get(u) as any
  assert.ok(event, 'event should be logged')
  assert.equal(event.event_type, 'funding')
  assert.equal(event.entity_name, 'Stripe')
})

test('tp-d: no event trigger → no event logged', () => {
  const u = U + '-tp-d'
  clean(u)
  trackWorldSignals(u, 'Help me write an email to the Stripe team about our integration')
  const event = db.prepare(`SELECT * FROM channel_n_events WHERE user_id = ?`).get(u) as any
  assert.equal(event, undefined, 'should not log an event for a non-event message')
})

test('tp-e: relevance score computed based on watchlist mentions', () => {
  const u = U + '-tp-e'
  clean(u)
  // Pre-seed watchlist with high mention count for Anthropic
  db.prepare(`
    INSERT INTO channel_n_watchlist (user_id, entity_name, entity_type, mentions_count, last_mentioned)
    VALUES (?, 'Anthropic', 'company', 8, datetime('now'))
  `).run(u)
  trackWorldSignals(u, 'Anthropic just launched a new product for enterprise customers')
  const event = db.prepare(`SELECT relevance_score FROM channel_n_events WHERE user_id = ?`).get(u) as any
  assert.ok(event?.relevance_score >= 50, `expected score >= 50, got ${event?.relevance_score}`)
})

// ─── Context Builder ──────────────────────────────────────────────────────────

console.log('\n── Context Builder ──────────────────────────────────────────────────')

test('cb-a: no events → null', () => {
  const u = U + '-cb-a'
  clean(u)
  assert.equal(buildChannelNContextBlock(u), null)
})

test('cb-b: events below threshold not surfaced → null', () => {
  const u = U + '-cb-b'
  clean(u)
  insertEvent(u, 'Stripe', 'funding', 'Stripe raised money', 30)  // below threshold of 50
  assert.equal(buildChannelNContextBlock(u), null)
})

test('cb-c: high-relevance event → surfaced in context', () => {
  const u = U + '-cb-c'
  clean(u)
  insertEvent(u, 'Stripe', 'funding', 'Stripe just raised $500M in their Series B', 80)
  const block = buildChannelNContextBlock(u)
  assert.ok(block?.includes('Stripe'), `expected Stripe in block:\n${block}`)
  assert.ok(block?.includes('[Funding]') || block?.includes('Funding'), `expected funding label in:\n${block}`)
})

test('cb-d: max 2 events surfaced per session', () => {
  const u = U + '-cb-d'
  clean(u)
  insertEvent(u, 'Stripe', 'funding', 'Stripe raised $500M', 90)
  insertEvent(u, 'Anthropic', 'launch', 'Anthropic launched new model', 80)
  insertEvent(u, 'OpenAI', 'news', 'OpenAI acquired a startup', 70)
  const block = buildChannelNContextBlock(u)
  // Count only event type lines ([Funding], [Launch], etc.), not the channel header
  const eventLines = (block ?? '').split('\n').filter(l => /^\[(Funding|Launch|Personnel|News|Update)\]/.test(l))
  assert.ok(eventLines.length <= 2, `expected max 2 event lines, got ${eventLines.length}:\n${block}`)
})

test('cb-e: surfaced events are not shown again in same session', () => {
  const u = U + '-cb-e'
  clean(u)
  insertEvent(u, 'Stripe', 'funding', 'Stripe raised $500M', 90)
  const block1 = buildChannelNContextBlock(u)
  assert.ok(block1?.includes('Stripe'), 'first call should surface Stripe')
  // Same session (< 2 hours gap) → null
  const block2 = buildChannelNContextBlock(u)
  assert.equal(block2, null, 'second call in same session should return null')
})

test('cb-f: already-surfaced event not shown again', () => {
  const u = U + '-cb-f'
  clean(u)
  insertEvent(u, 'Stripe', 'funding', 'Stripe raised $500M', 90, 1)  // already surfaced
  assert.equal(buildChannelNContextBlock(u), null)
})

test('cb-g: depleted energy state → null (hold signals)', () => {
  const u = U + '-cb-g'
  clean(u)
  // Simulate depleted energy via channel_k_profiles
  db.prepare(`
    INSERT OR REPLACE INTO channel_k_profiles (user_id, total_messages, avg_message_length, energy_state, confidence_level)
    VALUES (?, 10, 50, 'depleted', 'normal')
  `).run(u)
  insertEvent(u, 'Stripe', 'funding', 'Stripe raised $500M', 90)
  const block = buildChannelNContextBlock(u)
  assert.equal(block, null, 'should not surface world events when energy is depleted')
  // Cleanup
  db.prepare(`DELETE FROM channel_k_profiles WHERE user_id = ?`).run(u)
})

test('cb-h: "before we begin" framing present', () => {
  const u = U + '-cb-h'
  clean(u)
  insertEvent(u, 'Anthropic', 'launch', 'Anthropic unveiled a major new product line', 75)
  const block = buildChannelNContextBlock(u)
  assert.ok(block?.includes('Before we begin') || block?.includes('world'), `expected session-start framing:\n${block}`)
})

// ─── Summary ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n── Results ───────────────────────────────────────────────────────`)
  console.log(`   ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 400)
