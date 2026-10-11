import assert from 'node:assert/strict'
import { db } from '../lib/db.js'
import {
  detectCompletion, detectPastReference, isCelebratoryTone,
} from '../lib/channel-o/completion-detector.js'
import { trackAchievement } from '../lib/channel-o/achievement-tracker.js'
import { buildChannelOContextBlock } from '../lib/channel-o/context-builder.js'

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

const U = 'co-test-' + Date.now()

function clean(userId: string) {
  db.prepare(`DELETE FROM channel_o_achievements WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_o_profiles WHERE user_id = ?`).run(userId)
}

function insertAchievement(userId: string, type: string, text: string, daysAgo = 0) {
  db.prepare(`
    INSERT INTO channel_o_achievements (id, user_id, achievement_type, achievement_text, created_at)
    VALUES (randomblob(16), ?, ?, ?, datetime('now', ? || ' days'))
  `).run(userId, type, text, -daysAgo)
}

// ─── Completion Detection ─────────────────────────────────────────────────────

console.log('\n── Completion Detection ─────────────────────────────────────────────')

test('cd-a: "just closed the deal" → closed achievement', () => {
  const result = detectCompletion("Great news — we just closed the deal with Acme Corp!")
  assert.ok(result, 'should detect a completion')
  assert.equal(result!.type, 'closed')
})

test('cd-b: "finally shipped it" → shipped achievement', () => {
  const result = detectCompletion("We finally shipped it — the product is live!")
  assert.ok(result)
  assert.equal(result!.type, 'shipped')
})

test('cd-c: "we raised our Series A" → raised achievement', () => {
  const result = detectCompletion("Huge news: we raised our Series A, $5M from Sequoia")
  assert.ok(result)
  assert.equal(result!.type, 'raised')
})

test('cd-d: "just hired" → hired achievement', () => {
  const result = detectCompletion("We just hired our first engineer — she starts Monday")
  assert.ok(result)
  assert.equal(result!.type, 'hired')
})

test('cd-e: "offer accepted" → hired achievement', () => {
  const result = detectCompletion("Offer accepted! Our new VP of Sales starts next month")
  assert.ok(result)
  assert.equal(result!.type, 'hired')
})

test('cd-f: "it went live" → shipped achievement', () => {
  const result = detectCompletion("The landing page went live this morning — looks great")
  assert.ok(result)
  assert.equal(result!.type, 'shipped')
})

test('cd-g: "we closed the round" → raised (not closed/deal)', () => {
  const result = detectCompletion("We closed the round last week — wiring the money now")
  assert.ok(result)
  assert.equal(result!.type, 'raised', `expected raised, got ${result!.type}`)
})

test('cd-h: "wrapped it up" → completed achievement', () => {
  const result = detectCompletion("We wrapped it up — the analysis is done and sent to the board")
  assert.ok(result)
  assert.equal(result!.type, 'completed')
})

test('cd-i: regular task message → null', () => {
  const result = detectCompletion("Can you help me draft an email to the investor?")
  assert.equal(result, null)
})

test('cd-j: achievement text extracted from sentence', () => {
  const result = detectCompletion("We finally shipped it — the v2 is live and users are loving it")
  assert.ok(result)
  assert.ok(result!.text.length > 0, 'text should be non-empty')
  assert.ok(result!.text.length <= 150, 'text should be max 150 chars')
})

// ─── Past Reference Detection ─────────────────────────────────────────────────

console.log('\n── Past Reference Detection ─────────────────────────────────────────')

test('pr-a: "the campaign we ran last month" → past reference detected', () => {
  const ref = detectPastReference("Similar to the campaign we ran last month for the launch")
  assert.ok(ref, `expected past reference, got null`)
})

test('pr-b: "when we shipped the app" → past reference detected', () => {
  const ref = detectPastReference("Remember when we shipped the app in January? Same situation now")
  assert.ok(ref, `expected past reference, got null`)
})

test('pr-c: no past reference in forward-looking message → null', () => {
  const ref = detectPastReference("We need to launch the campaign by end of the month")
  assert.equal(ref, null)
})

// ─── Celebratory Tone Detection ───────────────────────────────────────────────

console.log('\n── Celebratory Tone ─────────────────────────────────────────────────')

test('ct-a: "finally shipped!!" → celebratory', () => {
  assert.ok(isCelebratoryTone("Finally shipped!! The feature is live 🚀"))
})

test('ct-b: "we did it" → celebratory', () => {
  assert.ok(isCelebratoryTone("We did it — the round closed today"))
})

test('ct-c: neutral task message → not celebratory', () => {
  assert.ok(!isCelebratoryTone("Can you help me draft a follow-up email to the investor?"))
})

// ─── Tracking + Profile ───────────────────────────────────────────────────────

console.log('\n── Tracking + Profile ───────────────────────────────────────────────')

test('tp-a: achievement written to DB on completion detected', () => {
  const u = U + '-tp-a'
  clean(u)
  trackAchievement(u, "We raised our Series A — $8M from two top-tier VCs, funding came through!")
  const row = db.prepare(`SELECT * FROM channel_o_achievements WHERE user_id = ?`).get(u) as any
  assert.ok(row, 'achievement should be written to DB')
  assert.equal(row.achievement_type, 'raised')
})

test('tp-b: no achievement written for regular message', () => {
  const u = U + '-tp-b'
  clean(u)
  trackAchievement(u, "Can you help me write a cold email about our product?")
  const row = db.prepare(`SELECT * FROM channel_o_achievements WHERE user_id = ?`).get(u) as any
  assert.equal(row, undefined, 'should not write for non-completion message')
})

test('tp-c: profile total_achievements increments', () => {
  const u = U + '-tp-c'
  clean(u)
  trackAchievement(u, "We finally shipped it — the v2 is live now")
  trackAchievement(u, "We just closed the deal with the enterprise customer!")
  const profile = db.prepare(`SELECT total_achievements FROM channel_o_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile.total_achievements, 2)
})

test('tp-d: dominant_achievement_type computed correctly', () => {
  const u = U + '-tp-d'
  clean(u)
  trackAchievement(u, "We shipped the product last night — it's live")
  trackAchievement(u, "Just shipped the mobile app version too")
  trackAchievement(u, "The new feature shipped this morning")
  const profile = db.prepare(`SELECT dominant_achievement_type FROM channel_o_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile.dominant_achievement_type, 'shipped')
})

test('tp-e: most_recent_achievement updated on each track call', () => {
  const u = U + '-tp-e'
  clean(u)
  trackAchievement(u, "We closed the deal with Acme — just got the signed contract")
  trackAchievement(u, "We shipped the landing page — it went live an hour ago")
  const profile = db.prepare(`SELECT most_recent_achievement FROM channel_o_profiles WHERE user_id = ?`).get(u) as any
  assert.ok(profile.most_recent_achievement, 'most_recent_achievement should be set')
  // The most recent is the "shipped" one
  assert.ok(profile.most_recent_achievement.toLowerCase().includes('live') ||
    profile.most_recent_achievement.toLowerCase().includes('ship') ||
    profile.most_recent_achievement.toLowerCase().includes('landing'),
    `expected shipped achievement, got: ${profile.most_recent_achievement}`)
})

// ─── Context Builder ──────────────────────────────────────────────────────────

console.log('\n── Context Builder ──────────────────────────────────────────────────')

test('cb-a: no profile → null', () => {
  const u = U + '-cb-a'
  clean(u)
  assert.equal(buildChannelOContextBlock(u), null)
})

test('cb-b: fewer than 3 achievements → null (cold-start gate)', () => {
  const u = U + '-cb-b'
  clean(u)
  db.prepare(`INSERT INTO channel_o_profiles (user_id, total_achievements) VALUES (?, 2)`).run(u)
  assert.equal(buildChannelOContextBlock(u), null)
})

test('cb-c: 3+ achievements → achievement record in context', () => {
  const u = U + '-cb-c'
  clean(u)
  insertAchievement(u, 'shipped', 'shipped the v2 product', 60)
  insertAchievement(u, 'closed', 'closed the enterprise deal', 45)
  insertAchievement(u, 'raised', 'closed the Series A round', 30)
  db.prepare(`INSERT INTO channel_o_profiles (user_id, total_achievements, dominant_achievement_type) VALUES (?, 3, 'shipped')`).run(u)
  const block = buildChannelOContextBlock(u)
  assert.ok(block?.includes('milestone') || block?.includes('record'), `expected achievement summary:\n${block}`)
  assert.ok(block?.includes('3'), `expected count in block:\n${block}`)
})

test('cb-d: dominant type "shipped" → execution pattern note', () => {
  const u = U + '-cb-d'
  clean(u)
  insertAchievement(u, 'shipped', 'shipped the mobile app', 20)
  insertAchievement(u, 'shipped', 'shipped the v2 backend', 15)
  insertAchievement(u, 'shipped', 'launched the landing page', 10)
  db.prepare(`INSERT INTO channel_o_profiles (user_id, total_achievements, dominant_achievement_type, most_recent_achievement, most_recent_at) VALUES (?, 3, 'shipped', 'launched the landing page', datetime('now', '-10 days'))`).run(u)
  const block = buildChannelOContextBlock(u)
  assert.ok(block?.toLowerCase().includes('ship') || block?.toLowerCase().includes('execution'), `expected execution pattern:\n${block}`)
})

test('cb-e: dominant type "raised" → fundraising pattern note', () => {
  const u = U + '-cb-e'
  clean(u)
  insertAchievement(u, 'raised', 'closed the seed round', 90)
  insertAchievement(u, 'raised', 'closed the Series A', 60)
  insertAchievement(u, 'raised', 'closed the bridge round', 30)
  db.prepare(`INSERT INTO channel_o_profiles (user_id, total_achievements, dominant_achievement_type) VALUES (?, 3, 'raised')`).run(u)
  const block = buildChannelOContextBlock(u)
  assert.ok(block?.toLowerCase().includes('fundrais') || block?.toLowerCase().includes('raised'), `expected fundraising pattern:\n${block}`)
})

test('cb-f: recent win (< 30 days) → momentum note', () => {
  const u = U + '-cb-f'
  clean(u)
  insertAchievement(u, 'closed', 'closed the enterprise deal', 60)
  insertAchievement(u, 'shipped', 'shipped the v2', 45)
  insertAchievement(u, 'closed', 'closed the startup contract', 5)
  db.prepare(`INSERT INTO channel_o_profiles (user_id, total_achievements, dominant_achievement_type, most_recent_achievement, most_recent_at) VALUES (?, 3, 'closed', 'closed the startup contract', datetime('now', '-5 days'))`).run(u)
  const block = buildChannelOContextBlock(u)
  assert.ok(block?.includes('Momentum') || block?.includes('Recent win') || block?.includes('win'), `expected momentum note:\n${block}`)
})

test('cb-g: low confidence state → confidence anchor note', () => {
  const u = U + '-cb-g'
  clean(u)
  insertAchievement(u, 'shipped', 'shipped the product', 60)
  insertAchievement(u, 'closed', 'closed the first enterprise deal', 45)
  insertAchievement(u, 'raised', 'closed the seed round', 30)
  db.prepare(`INSERT INTO channel_o_profiles (user_id, total_achievements, dominant_achievement_type, most_recent_achievement) VALUES (?, 3, 'shipped', 'closed the seed round')`).run(u)
  db.prepare(`INSERT OR REPLACE INTO channel_k_profiles (user_id, total_messages, energy_state, confidence_level) VALUES (?, 10, 'medium', 'low')`).run(u)
  const block = buildChannelOContextBlock(u)
  assert.ok(block?.toLowerCase().includes('confidence') || block?.toLowerCase().includes('harder'), `expected confidence anchor:\n${block}`)
  db.prepare(`DELETE FROM channel_k_profiles WHERE user_id = ?`).run(u)
})

// ─── Summary ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n── Results ───────────────────────────────────────────────────────`)
  console.log(`   ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 400)
