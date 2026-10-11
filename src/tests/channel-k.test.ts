import assert from 'node:assert/strict'
import { db } from '../lib/db.js'
import {
  detectOverloadSignals, classifyEnergy, detectConfidenceSignal,
  isAssumptionLaden, isDuplicate,
} from '../lib/channel-k/cognitive-classifier.js'
import { trackCognitiveSignal } from '../lib/channel-k/cognitive-tracker.js'
import { buildChannelKContextBlock } from '../lib/channel-k/context-builder.js'

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

const U = 'ck-test-' + Date.now()

function clean(userId: string) {
  db.prepare(`DELETE FROM channel_k_signals WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_k_profiles WHERE user_id = ?`).run(userId)
}

// ─── K.1 Overload Signal Detection ───────────────────────────────────────────

console.log('\n── K.1 Overload Signal Detection ───────────────────────────────────')

test('ol-a: frustrated + short request → frustrated_simple_request signal', () => {
  const signals = detectOverloadSignals('ugh why won\'t this work', 80, [])
  assert.ok(signals.includes('frustrated_simple_request'), `expected frustrated_simple_request in: ${signals}`)
})

test('ol-b: message << user avg → short_vs_baseline signal', () => {
  const signals = detectOverloadSignals('just fix it', 120, [])
  assert.ok(signals.includes('short_vs_baseline'), `expected short_vs_baseline in: ${signals}`)
})

test('ol-c: "still not working" short → repeated_failure_marker', () => {
  const signals = detectOverloadSignals('still not working', 80, [])
  assert.ok(signals.includes('repeated_failure_marker'), `expected repeated_failure_marker in: ${signals}`)
})

test('ol-d: "again" in short message → repeated_failure_marker', () => {
  const signals = detectOverloadSignals('again? this is broken', 80, [])
  assert.ok(signals.includes('repeated_failure_marker'), `expected repeated_failure_marker in: ${signals}`)
})

test('ol-e: normal elaborate message → no overload signals', () => {
  const signals = detectOverloadSignals(
    'Can you help me draft a comprehensive investor update covering our Q2 metrics and Series A timeline?',
    120, []
  )
  assert.equal(signals.length, 0)
})

test('ol-f: avg=0 (no baseline) → no short_vs_baseline even for short message', () => {
  const signals = detectOverloadSignals('ok', 0, [])
  assert.ok(!signals.includes('short_vs_baseline'))
})

// ─── K.1 Duplicate Detection ──────────────────────────────────────────────────

console.log('\n── K.1 Duplicate Detection ─────────────────────────────────────────')

test('dd-a: identical message → duplicate detected', () => {
  const prev = ['write a cold email to the investor about the round']
  assert.ok(isDuplicate('write a cold email to the investor about the round', prev))
})

test('dd-b: near-identical message (70%+ word overlap) → duplicate', () => {
  const prev = ['write a cold email to the investor about our seed round']
  assert.ok(isDuplicate('write a cold email to the investor about our series a round', prev))
})

test('dd-c: different topic → NOT duplicate', () => {
  const prev = ['research the best CRMs for early-stage startups']
  assert.ok(!isDuplicate('write a linkedin post about our product launch', prev))
})

test('dd-d: empty recent messages → NOT duplicate', () => {
  assert.ok(!isDuplicate('do something', []))
})

// ─── K.2 Energy State ─────────────────────────────────────────────────────────

console.log('\n── K.2 Energy State ────────────────────────────────────────────────')

test('es-a: long complex prompt at 10am → high energy', () => {
  const energy = classifyEnergy(
    'Do a comprehensive analysis of our burn rate vs runway, compare it against our Series A milestones, and give me a detailed breakdown of where we can trim costs without impacting growth velocity.',
    10
  )
  assert.equal(energy, 'high')
})

test('es-b: very short prompt (< 25 chars) → depleted', () => {
  const energy = classifyEnergy('fix the email', 11)
  assert.equal(energy, 'depleted')
})

test('es-c: short prompt at 2am → depleted', () => {
  const energy = classifyEnergy('can you check this', 2)
  assert.equal(energy, 'depleted')
})

test('es-d: medium-length non-complex prompt → medium energy', () => {
  const energy = classifyEnergy('Draft a follow-up email to the VC we met last week', 14)
  assert.equal(energy, 'medium')
})

test('es-e: short simple prompt at normal hour → low energy', () => {
  const energy = classifyEnergy('write me an email to Sarah', 15)
  assert.equal(energy, 'low')
})

// ─── K.3 Confidence Signal ────────────────────────────────────────────────────

console.log('\n── K.3 Confidence Signal ───────────────────────────────────────────')

test('cs-a: "I\'m not sure if this is right" → low_confidence', () => {
  assert.equal(detectConfidenceSignal('I\'m not sure if this is right — can you check?'), 'low_confidence')
})

test('cs-b: "second-guessing" → low_confidence', () => {
  assert.equal(detectConfidenceSignal('I keep second-guessing myself on the approach here'), 'low_confidence')
})

test('cs-c: "might be wrong" → low_confidence', () => {
  assert.equal(detectConfidenceSignal('I might be wrong but this seems off to me'), 'low_confidence')
})

test('cs-d: direct confident request → null', () => {
  assert.equal(detectConfidenceSignal('Draft the investor update for tomorrow\'s board meeting'), null)
})

// ─── K.4 Assumption Detection ─────────────────────────────────────────────────

console.log('\n── K.4 Assumption Detection ────────────────────────────────────────')

test('as-a: "convince him to invest" → assumption laden', () => {
  assert.ok(isAssumptionLaden('Help me write an email to convince him to invest in our round'))
})

test('as-b: "make her sign" → assumption laden', () => {
  assert.ok(isAssumptionLaden('I need to make her sign the term sheet by Friday'))
})

test('as-c: "help me persuade" → assumption laden', () => {
  assert.ok(isAssumptionLaden('Help me persuade the board that we should pivot now'))
})

test('as-d: "change his mind" → assumption laden', () => {
  assert.ok(isAssumptionLaden('How do I change his mind about the valuation?'))
})

test('as-e: "find the CEO of" → assumption laden', () => {
  assert.ok(isAssumptionLaden('Find the CEO of Acme Corp and draft an outreach email'))
})

test('as-f: standard request → NOT assumption laden', () => {
  assert.ok(!isAssumptionLaden('Draft an intro email to the Acme Corp team'))
})

// ─── Tracking + Profile ───────────────────────────────────────────────────────

console.log('\n── Tracking + Profile ──────────────────────────────────────────────')

test('tp-a: avg_message_length updates as messages are tracked', () => {
  const u = U + '-tp-a'
  clean(u)
  trackCognitiveSignal(u, 's1', 'Draft a cold email to the LP')
  trackCognitiveSignal(u, 's1', 'Help me write a LinkedIn post about our launch milestone this quarter')
  trackCognitiveSignal(u, 's1', 'Research the top five SaaS pricing models for B2B enterprise software')
  const profile = db.prepare(`SELECT avg_message_length, total_messages FROM channel_k_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile.total_messages, 3)
  assert.ok(profile.avg_message_length > 0, 'avg_message_length should be > 0')
})

test('tp-b: overload signals are written to channel_k_signals', () => {
  const u = U + '-tp-b'
  clean(u)
  // Build baseline first
  for (let i = 0; i < 5; i++) {
    trackCognitiveSignal(u, 's1', 'Help me research the competitive landscape for our Series A fundraising deck')
  }
  // Now send a frustrated short message
  trackCognitiveSignal(u, 's1', 'ugh still not working')
  const overloads = db.prepare(`SELECT value FROM channel_k_signals WHERE user_id = ? AND signal_type = 'overload'`).all(u) as any[]
  assert.ok(overloads.length > 0, 'should have at least one overload signal')
})

test('tp-c: confidence_level updates to "low" after multiple low_confidence signals', () => {
  const u = U + '-tp-c'
  clean(u)
  trackCognitiveSignal(u, 's1', 'I\'m not sure if this is right — probably wrong actually')
  trackCognitiveSignal(u, 's1', 'Second-guessing this whole approach — might be wrong')
  const profile = db.prepare(`SELECT confidence_level FROM channel_k_profiles WHERE user_id = ?`).get(u) as any
  assert.ok(
    profile?.confidence_level === 'low' || profile?.confidence_level === 'uncertain',
    `expected low/uncertain, got ${profile?.confidence_level}`
  )
})

test('tp-d: assumption signals written to DB', () => {
  const u = U + '-tp-d'
  clean(u)
  trackCognitiveSignal(u, 's1', 'Help me convince him to invest in our round')
  const assumptions = db.prepare(`SELECT value FROM channel_k_signals WHERE user_id = ? AND signal_type = 'assumption'`).all(u) as any[]
  assert.ok(assumptions.length >= 1, 'expected assumption signal in DB')
})

test('tp-e: energy signals are always written (one per message)', () => {
  const u = U + '-tp-e'
  clean(u)
  trackCognitiveSignal(u, 's1', 'Draft an email to my investor')
  trackCognitiveSignal(u, 's1', 'Research the top SaaS metrics benchmarks for Series A')
  const energySignals = db.prepare(`SELECT value FROM channel_k_signals WHERE user_id = ? AND signal_type = 'energy'`).all(u) as any[]
  assert.equal(energySignals.length, 2)
})

// ─── Context Builder ──────────────────────────────────────────────────────────

console.log('\n── Context Builder ─────────────────────────────────────────────────')

test('cb-a: < 5 messages → null', () => {
  const u = U + '-cb-a'
  clean(u)
  db.prepare(`INSERT INTO channel_k_profiles (user_id, total_messages) VALUES (?, 3)`).run(u)
  assert.equal(buildChannelKContextBlock(u), null)
})

test('cb-b: no profile → null', () => {
  const u = U + '-cb-b'
  clean(u)
  assert.equal(buildChannelKContextBlock(u), null)
})

test('cb-c: 3+ overload signals in last 30 min → HIGH COGNITIVE LOAD instruction', () => {
  const u = U + '-cb-c'
  clean(u)
  db.prepare(`INSERT INTO channel_k_profiles (user_id, total_messages, avg_message_length, energy_state, confidence_level) VALUES (?, 10, 120, 'medium', 'normal')`).run(u)
  // Insert 3 overload signals with NOW timestamps
  for (let i = 0; i < 3; i++) {
    db.prepare(`
      INSERT INTO channel_k_signals (id, user_id, session_id, signal_type, value, message_length, message_preview, created_at)
      VALUES (randomblob(16), ?, 's1', 'overload', 'frustrated_simple_request', 15, 'ugh still', datetime('now'))
    `).run(u)
  }
  const block = buildChannelKContextBlock(u)
  assert.ok(block?.includes('HIGH COGNITIVE LOAD') || block?.includes('LOAD'), `expected high-load mode in:\n${block}`)
  assert.ok(block?.includes('ONE answer') || block?.includes('short') || block?.includes('direct'), `expected brevity instruction in:\n${block}`)
})

test('cb-d: depleted energy state → concise/match pace instruction', () => {
  const u = U + '-cb-d'
  clean(u)
  db.prepare(`INSERT INTO channel_k_profiles (user_id, total_messages, energy_state, confidence_level) VALUES (?, 8, 'depleted', 'normal')`).run(u)
  const block = buildChannelKContextBlock(u)
  assert.ok(block?.includes('depleted') || block?.includes('concise') || block?.includes('pace'), `expected energy framing in:\n${block}`)
})

test('cb-e: low confidence → anchor + validate instruction', () => {
  const u = U + '-cb-e'
  clean(u)
  db.prepare(`INSERT INTO channel_k_profiles (user_id, total_messages, energy_state, confidence_level) VALUES (?, 8, 'medium', 'low')`).run(u)
  const block = buildChannelKContextBlock(u)
  assert.ok(block?.includes('second-guessing') || block?.includes('Confidence') || block?.includes('anchor') || block?.includes('validate'), `expected confidence framing in:\n${block}`)
})

test('cb-f: recent assumption signal → premise note in context', () => {
  const u = U + '-cb-f'
  clean(u)
  db.prepare(`INSERT INTO channel_k_profiles (user_id, total_messages, energy_state, confidence_level) VALUES (?, 8, 'medium', 'normal')`).run(u)
  db.prepare(`
    INSERT INTO channel_k_signals (id, user_id, session_id, signal_type, value, message_length, message_preview, created_at)
    VALUES (randomblob(16), ?, 's1', 'assumption', 'assumption_detected', 50, 'convince him to invest', datetime('now'))
  `).run(u)
  const block = buildChannelKContextBlock(u)
  assert.ok(block?.includes('assumption') || block?.includes('premise') || block?.includes('Assumption'), `expected assumption note in:\n${block}`)
})

test('cb-g: high energy + normal confidence → surfaces high energy note', () => {
  const u = U + '-cb-g'
  clean(u)
  db.prepare(`INSERT INTO channel_k_profiles (user_id, total_messages, energy_state, confidence_level) VALUES (?, 8, 'high', 'normal')`).run(u)
  const block = buildChannelKContextBlock(u)
  assert.ok(block?.includes('high') || block?.includes('engaged') || block?.includes('depth'), `expected high energy note in:\n${block}`)
})

// ─── Summary ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n── Results ───────────────────────────────────────────────────────`)
  console.log(`   ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 400)
