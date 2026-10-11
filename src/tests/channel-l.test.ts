import assert from 'node:assert/strict'
import { db } from '../lib/db.js'
import {
  classifyResistance, classifyAvoidance, detectKeptWork, extractDomain,
} from '../lib/channel-l/resistance-classifier.js'
import { trackResistanceSignal } from '../lib/channel-l/resistance-tracker.js'
import { buildChannelLContextBlock } from '../lib/channel-l/context-builder.js'

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

const U = 'cl-test-' + Date.now()

function clean(userId: string) {
  db.prepare(`DELETE FROM channel_l_signals WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_l_profiles WHERE user_id = ?`).run(userId)
}

// ─── L.1 Resistance Classification ───────────────────────────────────────────

console.log('\n── L.1 Resistance Classification ───────────────────────────────────')

test('rc-a: "that\'s not correct" → factual resistance', () => {
  assert.equal(classifyResistance("That's not correct — the Series A average is actually 8x revenue"), 'factual')
})

test('rc-b: "actually no" → factual resistance', () => {
  assert.equal(classifyResistance("Actually no, that's wrong. The correct figure is $2M not $4M"), 'factual')
})

test('rc-c: "that\'s not how I\'d put it" → framing resistance', () => {
  assert.equal(classifyResistance("That's not how I'd put it — I wouldn't describe it as pivoting"), 'framing')
})

test('rc-d: "the framing is off" → framing resistance', () => {
  assert.equal(classifyResistance("The framing is off here — it reads like a sales pitch not a partnership"), 'framing')
})

test('rc-e: "that\'s too much" → scope resistance', () => {
  assert.equal(classifyResistance("That's too much — I just needed the two-line summary not the full breakdown"), 'scope')
})

test('rc-f: "needs more detail" → scope resistance', () => {
  assert.equal(classifyResistance("This needs more detail on the pricing model — too thin"), 'scope')
})

test('rc-g: "that\'s not the right move" → strategic resistance', () => {
  assert.equal(classifyResistance("That's not the right move — we can't go enterprise-first without a clear ICP"), 'strategic')
})

test('rc-h: "you\'re missing the point" → strategic resistance', () => {
  assert.equal(classifyResistance("You're missing the point — the bottleneck isn't the product, it's distribution"), 'strategic')
})

test('rc-i: no resistance signals → null', () => {
  assert.equal(classifyResistance("Can you help me draft a cold email to an investor?"), null)
})

// ─── Domain Extraction ────────────────────────────────────────────────────────

console.log('\n── Domain Extraction ───────────────────────────────────────────────')

test('dom-a: email mention → email domain', () => {
  assert.equal(extractDomain("That cold email approach is completely off-brand"), 'email')
})

test('dom-b: strategy mention → strategy domain', () => {
  assert.equal(extractDomain("That's not the right strategic direction at all"), 'strategy')
})

test('dom-c: code mention → technical domain', () => {
  assert.equal(extractDomain("The architecture you proposed won't scale for our database load"), 'technical')
})

test('dom-d: no clear domain → null', () => {
  assert.equal(extractDomain("That's too much — trim it down"), null)
})

// ─── L.2 Avoidance Classification ────────────────────────────────────────────

console.log('\n── L.2 Avoidance Classification ────────────────────────────────────')

test('av-a: "I\'ve been meaning to" → priority avoidance', () => {
  assert.equal(classifyAvoidance("I've been meaning to update our investor deck for weeks"), 'priority')
})

test('av-b: "keep putting off" → priority avoidance', () => {
  assert.equal(classifyAvoidance("I keep putting off the pricing page rewrite"), 'priority')
})

test('av-c: "I don\'t know how to approach" → skill avoidance', () => {
  assert.equal(classifyAvoidance("I don't know how to approach this board presentation structure"), 'skill')
})

test('av-d: "I hate doing" → capability avoidance', () => {
  assert.equal(classifyAvoidance("I hate doing the monthly reporting — it takes forever"), 'capability')
})

test('av-e: difficult conversation → emotional avoidance', () => {
  assert.equal(classifyAvoidance("I have a difficult conversation I need to have with my co-founder"), 'emotional')
})

test('av-f: rejection letter context → emotional avoidance', () => {
  assert.equal(classifyAvoidance("I need to write a rejection letter to the candidate we interviewed"), 'emotional')
})

test('av-g: "not really a numbers person" → identity avoidance', () => {
  assert.equal(classifyAvoidance("I'm not really a numbers person so I've been avoiding the financial model"), 'identity')
})

test('av-h: standard task → null', () => {
  assert.equal(classifyAvoidance("Write me a LinkedIn post about our product launch"), null)
})

// ─── L.3 Kept Work Detection ──────────────────────────────────────────────────

console.log('\n── L.3 Kept Work Detection ─────────────────────────────────────────')

test('kw-a: "I already sent that" → kept work', () => {
  assert.ok(detectKeptWork("I already sent that email to the investor this morning"))
})

test('kw-b: "I took care of the analysis" → kept work', () => {
  assert.ok(detectKeptWork("I took care of the analysis myself last night"))
})

test('kw-c: "I handled it" → kept work', () => {
  assert.ok(detectKeptWork("I handled it — already done"))
})

test('kw-d: "I went ahead and" → kept work', () => {
  assert.ok(detectKeptWork("I went ahead and wrote the intro email myself"))
})

test('kw-e: regular planning message → NOT kept work', () => {
  assert.ok(!detectKeptWork("Can you help me write a cold email to the VC?"))
})

// ─── Tracking + Profile ───────────────────────────────────────────────────────

console.log('\n── Tracking + Profile ──────────────────────────────────────────────')

test('tp-a: resistance signal written to DB and profile created', () => {
  const u = U + '-tp-a'
  clean(u)
  trackResistanceSignal(u, 's1', "That's not correct — our churn rate is 3%, not 8%")
  const signal = db.prepare(`SELECT * FROM channel_l_signals WHERE user_id = ? AND signal_type = 'resistance'`).get(u) as any
  assert.ok(signal, 'should have written a resistance signal')
  assert.equal(signal.subtype, 'factual')
  const profile = db.prepare(`SELECT * FROM channel_l_profiles WHERE user_id = ?`).get(u) as any
  assert.ok(profile, 'profile should exist')
  assert.equal(profile.factual_resistance_count, 1)
})

test('tp-b: strategic resistance count accumulates correctly', () => {
  const u = U + '-tp-b'
  clean(u)
  trackResistanceSignal(u, 's1', "That's not the right move given where we are in the fundraise")
  trackResistanceSignal(u, 's1', "Wrong direction — we need to lead with retention metrics not growth")
  const profile = db.prepare(`SELECT * FROM channel_l_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile.strategic_resistance_count, 2)
})

test('tp-c: dominant_resistance computed correctly', () => {
  const u = U + '-tp-c'
  clean(u)
  trackResistanceSignal(u, 's1', "That's not how I'd put it — feels too aggressive")
  trackResistanceSignal(u, 's1', "The framing is off — make it more collaborative")
  trackResistanceSignal(u, 's1', "That's not correct")
  const profile = db.prepare(`SELECT * FROM channel_l_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile.dominant_resistance, 'framing')
})

test('tp-d: avoidance signal tracked in DB', () => {
  const u = U + '-tp-d'
  clean(u)
  trackResistanceSignal(u, 's1', "I've been meaning to update our pitch deck for two months now")
  const signal = db.prepare(`SELECT * FROM channel_l_signals WHERE user_id = ? AND signal_type = 'avoidance'`).get(u) as any
  assert.ok(signal)
  assert.equal(signal.subtype, 'priority')
})

test('tp-e: kept work signal written and category appears after 2+ signals', () => {
  const u = U + '-tp-e'
  clean(u)
  trackResistanceSignal(u, 's1', "I already handled the research myself")
  trackResistanceSignal(u, 's1', "I went ahead and did the analysis myself")
  const profile = db.prepare(`SELECT * FROM channel_l_profiles WHERE user_id = ?`).get(u) as any
  const categories = JSON.parse(profile.kept_work_categories ?? '[]')
  assert.ok(Array.isArray(categories), 'kept_work_categories should be an array')
  assert.ok(categories.length > 0, 'should have at least one kept work category after 2+ signals')
})

test('tp-f: blind spot domain appears after 3 strategic resistance on same domain', () => {
  const u = U + '-tp-f'
  clean(u)
  trackResistanceSignal(u, 's1', "That's not the right move — our sales pitch needs to come after trust is built")
  trackResistanceSignal(u, 's1', "You're missing the point — the customer already said yes, I need the contract")
  trackResistanceSignal(u, 's1', "Not what I was asking — I need to pitch the prospect differently here")
  const profile = db.prepare(`SELECT * FROM channel_l_profiles WHERE user_id = ?`).get(u) as any
  const blindSpots = JSON.parse(profile.blind_spot_domains ?? '[]')
  assert.ok(blindSpots.includes('sales'), `expected sales in blind spots: ${JSON.stringify(blindSpots)}`)
})

test('tp-g: message with no signals → nothing written', () => {
  const u = U + '-tp-g'
  clean(u)
  trackResistanceSignal(u, 's1', "Help me write a LinkedIn post about our launch")
  const signal = db.prepare(`SELECT * FROM channel_l_signals WHERE user_id = ?`).get(u) as any
  assert.equal(signal, undefined, 'should write nothing for a normal message')
})

// ─── Context Builder ──────────────────────────────────────────────────────────

console.log('\n── Context Builder ─────────────────────────────────────────────────')

test('cb-a: no profile → null', () => {
  const u = U + '-cb-a'
  clean(u)
  assert.equal(buildChannelLContextBlock(u), null)
})

test('cb-b: < 5 signals → null', () => {
  const u = U + '-cb-b'
  clean(u)
  db.prepare(`INSERT INTO channel_l_profiles (user_id, total_signals) VALUES (?, 3)`).run(u)
  assert.equal(buildChannelLContextBlock(u), null)
})

test('cb-c: framing dominant resistance → framing instruction', () => {
  const u = U + '-cb-c'
  clean(u)
  db.prepare(`INSERT INTO channel_l_profiles (user_id, total_signals, dominant_resistance, framing_resistance_count) VALUES (?, 8, 'framing', 3)`).run(u)
  const block = buildChannelLContextBlock(u)
  assert.ok(block?.includes('Framing') || block?.includes('framing'), `expected framing note:\n${block}`)
})

test('cb-d: factual dominant resistance → fact-check instruction', () => {
  const u = U + '-cb-d'
  clean(u)
  db.prepare(`INSERT INTO channel_l_profiles (user_id, total_signals, dominant_resistance, factual_resistance_count) VALUES (?, 8, 'factual', 3)`).run(u)
  const block = buildChannelLContextBlock(u)
  assert.ok(block?.includes('Factual') || block?.includes('factual') || block?.includes('fact'), `expected factual note:\n${block}`)
})

test('cb-e: strategic dominant resistance → strategic caution', () => {
  const u = U + '-cb-e'
  clean(u)
  db.prepare(`INSERT INTO channel_l_profiles (user_id, total_signals, dominant_resistance, strategic_resistance_count) VALUES (?, 8, 'strategic', 3)`).run(u)
  const block = buildChannelLContextBlock(u)
  assert.ok(block?.includes('Strategic') || block?.includes('strategic') || block?.includes('assumptions'), `expected strategic note:\n${block}`)
})

test('cb-f: blind spot domain → explicit blind spot note', () => {
  const u = U + '-cb-f'
  clean(u)
  db.prepare(`INSERT INTO channel_l_profiles (user_id, total_signals, blind_spot_domains) VALUES (?, 10, '["finance"]')`).run(u)
  const block = buildChannelLContextBlock(u)
  assert.ok(block?.includes('finance') || block?.includes('blind spot'), `expected blind spot note:\n${block}`)
})

test('cb-g: emotional avoidance >= 2 → care instruction', () => {
  const u = U + '-cb-g'
  clean(u)
  db.prepare(`INSERT INTO channel_l_profiles (user_id, total_signals, emotional_avoidance_count) VALUES (?, 8, 2)`).run(u)
  const block = buildChannelLContextBlock(u)
  assert.ok(block?.includes('Emotional') || block?.includes('emotional') || block?.includes('care'), `expected emotional avoidance note:\n${block}`)
})

test('cb-h: priority avoidance >= 2 → decomposition suggestion', () => {
  const u = U + '-cb-h'
  clean(u)
  db.prepare(`INSERT INTO channel_l_profiles (user_id, total_signals, priority_avoidance_count) VALUES (?, 8, 3)`).run(u)
  const block = buildChannelLContextBlock(u)
  assert.ok(block?.includes('Priority') || block?.includes('avoidance') || block?.includes('smaller'), `expected priority avoidance note:\n${block}`)
})

test('cb-i: kept work category → growth opportunity note in context', () => {
  const u = U + '-cb-i'
  clean(u)
  db.prepare(`INSERT INTO channel_l_profiles (user_id, total_signals, kept_work_categories, kept_work_offer_made) VALUES (?, 10, '["research"]', '{}')`).run(u)
  const block = buildChannelLContextBlock(u)
  assert.ok(block?.includes('research') || block?.includes('Growth') || block?.includes('growth'), `expected growth opportunity note:\n${block}`)
})

test('cb-j: growth offer not repeated after first injection', () => {
  const u = U + '-cb-j'
  clean(u)
  db.prepare(`INSERT INTO channel_l_profiles (user_id, total_signals, kept_work_categories, kept_work_offer_made) VALUES (?, 10, '["email"]', '{"email":true}')`).run(u)
  const block = buildChannelLContextBlock(u)
  // email should NOT appear again since offer already made
  assert.ok(!block?.includes('Growth opportunity: user has handled email'), `offer should not repeat:\n${block}`)
})

// ─── Summary ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n── Results ───────────────────────────────────────────────────────`)
  console.log(`   ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 400)
