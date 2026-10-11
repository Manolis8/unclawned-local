import assert from 'node:assert/strict'
import { db } from '../lib/db.js'
import { classifyDecisionStyle, isApprovalSeeking, isResearchTask, isReversalSignal } from '../lib/channel-i/decision-classifier.js'
import { trackDecisionSignal } from '../lib/channel-i/decision-tracker.js'
import { buildChannelIContextBlock } from '../lib/channel-i/context-builder.js'

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

const U = 'ci-test-' + Date.now()

function clean(userId: string) {
  db.prepare(`DELETE FROM channel_i_decision_signals WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_i_profiles WHERE user_id = ?`).run(userId)
}

// ─── I.1 Decision Style Classifier ───────────────────────────────────────────

console.log('\n── I.1 Decision Style Classifier ──────────────────────────────────')

test('dc-a: "what would you recommend" → recommendation_seeker', () => {
  const style = classifyDecisionStyle('I have two vendors. What would you recommend I go with?')
  assert.equal(style, 'recommendation_seeker')
})

test('dc-b: "just tell me what to do" → recommendation_seeker', () => {
  const style = classifyDecisionStyle('Just tell me what to do here, I\'m going in circles')
  assert.equal(style, 'recommendation_seeker')
})

test('dc-c: "give me options" → options_seeker', () => {
  const style = classifyDecisionStyle('Give me options for how to structure the deck')
  assert.equal(style, 'options_seeker')
})

test('dc-d: "a few ways to" → options_seeker', () => {
  const style = classifyDecisionStyle('What are a few ways to handle this investor conversation?')
  assert.equal(style, 'options_seeker')
})

test('dc-e: "show me the numbers" → data_first', () => {
  const style = classifyDecisionStyle('Show me the numbers on our burn rate before I decide')
  assert.equal(style, 'data_first')
})

test('dc-f: "run the numbers" → data_first', () => {
  const style = classifyDecisionStyle('Can you run the numbers on CAC vs LTV for us?')
  assert.equal(style, 'data_first')
})

test('dc-g: "what did we do last time" → precedent_based', () => {
  const style = classifyDecisionStyle('What did we do last time when we had a similar situation with a co-founder?')
  assert.equal(style, 'precedent_based')
})

test('dc-h: "what worked before" → precedent_based', () => {
  const style = classifyDecisionStyle('What\'s worked before for cold outreach to investors?')
  assert.equal(style, 'precedent_based')
})

test('dc-i: unrelated message → null (no decision signal)', () => {
  const style = classifyDecisionStyle('Draft an email to my investor about the round close')
  assert.equal(style, null)
})

// ─── I.4 Approval Seeking Classifier ─────────────────────────────────────────

console.log('\n── I.4 Approval Seeking Classifier ────────────────────────────────')

test('as-a: "does this make sense" → approval seeking', () => {
  assert.ok(isApprovalSeeking('Here is my plan for the round. Does this make sense?'))
})

test('as-b: "am I thinking about this right" → approval seeking', () => {
  assert.ok(isApprovalSeeking('Am I thinking about this right or is there a better angle?'))
})

test('as-c: "is this a good approach" → approval seeking', () => {
  assert.ok(isApprovalSeeking('Is this a good approach for the product launch?'))
})

test('as-d: regular task → NOT approval seeking', () => {
  assert.ok(!isApprovalSeeking('Draft a LinkedIn post about our product launch'))
})

// ─── I.2 Research Task Classifier ────────────────────────────────────────────

console.log('\n── I.2 Research Task Classifier ────────────────────────────────────')

test('rt-a: "research X" → research task', () => {
  assert.ok(isResearchTask('Research the top SaaS pricing models for B2B companies'))
})

test('rt-b: "compare X and Y" → research task', () => {
  assert.ok(isResearchTask('Compare Stripe and Paddle for our payments setup'))
})

test('rt-c: "pros and cons" → research task', () => {
  assert.ok(isResearchTask('What are the pros and cons of raising a priced round now vs in 6 months?'))
})

test('rt-d: execution prompt → NOT research task', () => {
  assert.ok(!isResearchTask('Post on LinkedIn: we just closed our seed round'))
})

// ─── I.3 Reversal Signal Classifier ──────────────────────────────────────────

console.log('\n── I.3 Reversal Signal Classifier ─────────────────────────────────')

test('rv-a: "actually let\'s" → reversal', () => {
  assert.ok(isReversalSignal('Actually let\'s go a different direction on this'))
})

test('rv-b: "never mind" → reversal', () => {
  assert.ok(isReversalSignal('Never mind the previous approach, let\'s try something new'))
})

test('rv-c: "scratch that" → reversal', () => {
  assert.ok(isReversalSignal('Scratch that, I want to target enterprise instead'))
})

test('rv-d: "on second thought" → reversal', () => {
  assert.ok(isReversalSignal('On second thought, let\'s hold off on the announcement'))
})

test('rv-e: normal continuation → NOT reversal', () => {
  assert.ok(!isReversalSignal('Can you also add a section about the team background?'))
})

// ─── I.1 Tracking + Profile ───────────────────────────────────────────────────

console.log('\n── I.1 Tracking + Profile ──────────────────────────────────────────')

test('tp-a: recommendation signals accumulate and set dominant_style', () => {
  const u = U + '-tp-a'
  clean(u)
  for (let i = 0; i < 5; i++) {
    trackDecisionSignal(u, 's1', 'What would you recommend here?')
  }
  const profile = db.prepare(`SELECT dominant_style, total_signals FROM channel_i_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile?.dominant_style, 'recommendation_seeker')
  assert.ok(profile.total_signals >= 5)
})

test('tp-b: options signals accumulate and set dominant_style', () => {
  const u = U + '-tp-b'
  clean(u)
  for (let i = 0; i < 5; i++) {
    trackDecisionSignal(u, 's1', 'Give me a few options here')
  }
  const profile = db.prepare(`SELECT dominant_style FROM channel_i_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile?.dominant_style, 'options_seeker')
})

test('tp-c: approval seeking signals are tracked separately from decision style', () => {
  const u = U + '-tp-c'
  clean(u)
  trackDecisionSignal(u, 's1', 'Does this make sense?')
  trackDecisionSignal(u, 's1', 'Am I thinking about this right?')
  trackDecisionSignal(u, 's1', 'Does this seem correct to you?')
  const signals = db.prepare(`SELECT signal_type FROM channel_i_decision_signals WHERE user_id = ?`).all(u) as any[]
  const types = signals.map((s: any) => s.signal_type)
  assert.ok(types.includes('approval_seeking'), `expected approval_seeking in ${types}`)
})

test('tp-d: reversal signals are tracked', () => {
  const u = U + '-tp-d'
  clean(u)
  trackDecisionSignal(u, 's1', 'Actually let\'s take a different approach')
  trackDecisionSignal(u, 's1', 'Scratch that, let\'s pivot')
  trackDecisionSignal(u, 's1', 'Never mind the investor route, let\'s bootstrap')
  const profile = db.prepare(`SELECT total_reversals FROM channel_i_profiles WHERE user_id = ?`).get(u) as any
  assert.ok(profile?.total_reversals >= 3, `expected total_reversals >= 3, got ${profile?.total_reversals}`)
})

test('tp-e: research tasks are tracked and update research_depth', () => {
  const u = U + '-tp-e'
  clean(u)
  for (let i = 0; i < 4; i++) {
    trackDecisionSignal(u, `s${i}`, 'Research the pricing models for our SaaS product')
  }
  const profile = db.prepare(`SELECT research_depth FROM channel_i_profiles WHERE user_id = ?`).get(u) as any
  // 4 research tasks across 4 sessions = avg 1/session → light; but 4 in one session could be heavy
  assert.ok(['light', 'heavy'].includes(profile?.research_depth), `expected light or heavy, got ${profile?.research_depth}`)
})

test('tp-f: mixed signals don\'t overwrite each other', () => {
  const u = U + '-tp-f'
  clean(u)
  trackDecisionSignal(u, 's1', 'What would you recommend?')
  trackDecisionSignal(u, 's1', 'Does this make sense?')
  trackDecisionSignal(u, 's1', 'Research the competitors first')
  trackDecisionSignal(u, 's1', 'Actually let\'s pivot')
  const signals = db.prepare(`SELECT signal_type FROM channel_i_decision_signals WHERE user_id = ?`).all(u) as any[]
  const types = new Set(signals.map((s: any) => s.signal_type))
  assert.ok(types.has('decision_style'), 'missing decision_style')
  assert.ok(types.has('approval_seeking'), 'missing approval_seeking')
  assert.ok(types.has('research_task'), 'missing research_task')
  assert.ok(types.has('reversal'), 'missing reversal')
})

// ─── I.5 Context Builder ──────────────────────────────────────────────────────

console.log('\n── I.5 Context Builder ─────────────────────────────────────────────')

test('cb-a: returns null with fewer than 5 signals', () => {
  const u = U + '-cb-a'
  clean(u)
  db.prepare(`INSERT INTO channel_i_profiles (user_id, total_signals, dominant_style) VALUES (?, 3, 'recommendation_seeker')`).run(u)
  assert.equal(buildChannelIContextBlock(u), null)
})

test('cb-b: returns null for user with no profile', () => {
  const u = U + '-cb-b'
  clean(u)
  assert.equal(buildChannelIContextBlock(u), null)
})

test('cb-c: recommendation_seeker → context says give ONE answer', () => {
  const u = U + '-cb-c'
  clean(u)
  db.prepare(`INSERT INTO channel_i_profiles (user_id, total_signals, dominant_style, style_counts) VALUES (?, 10, 'recommendation_seeker', '{"recommendation_seeker":8,"options_seeker":2}')`)
    .run(u)
  const block = buildChannelIContextBlock(u)
  assert.ok(block?.includes('Decision Style'), `expected header in:\n${block}`)
  assert.ok(block?.includes('ONE answer') || block?.includes('one answer') || block?.includes('recommendation'), `expected recommendation framing in:\n${block}`)
})

test('cb-d: options_seeker → context says present 2-3 approaches', () => {
  const u = U + '-cb-d'
  clean(u)
  db.prepare(`INSERT INTO channel_i_profiles (user_id, total_signals, dominant_style, style_counts) VALUES (?, 8, 'options_seeker', '{"options_seeker":7,"recommendation_seeker":1}')`)
    .run(u)
  const block = buildChannelIContextBlock(u)
  assert.ok(block?.includes('options') || block?.includes('approaches'), `expected options framing in:\n${block}`)
})

test('cb-e: data_first → context mentions leading with metrics/evidence', () => {
  const u = U + '-cb-e'
  clean(u)
  db.prepare(`INSERT INTO channel_i_profiles (user_id, total_signals, dominant_style, style_counts) VALUES (?, 7, 'data_first', '{"data_first":6,"recommendation_seeker":1}')`)
    .run(u)
  const block = buildChannelIContextBlock(u)
  assert.ok(block?.includes('numbers') || block?.includes('data') || block?.includes('metrics') || block?.includes('evidence'), `expected data framing in:\n${block}`)
})

test('cb-f: high reversal rate → context flags ask about constraints', () => {
  const u = U + '-cb-f'
  clean(u)
  db.prepare(`INSERT INTO channel_i_profiles (user_id, total_signals, dominant_style, style_counts, reversal_rate, total_reversals) VALUES (?, 10, 'recommendation_seeker', '{"recommendation_seeker":5}', 0.4, 4)`)
    .run(u)
  const block = buildChannelIContextBlock(u)
  assert.ok(block?.includes('reversal') || block?.includes('constraints') || block?.includes('changes direction') || block?.includes('Direction changes'), `expected reversal note in:\n${block}`)
})

test('cb-g: high approval rate → context notes validation pattern', () => {
  const u = U + '-cb-g'
  clean(u)
  db.prepare(`INSERT INTO channel_i_profiles (user_id, total_signals, dominant_style, style_counts, approval_rate) VALUES (?, 10, 'recommendation_seeker', '{"recommendation_seeker":6}', 0.3)`)
    .run(u)
  const block = buildChannelIContextBlock(u)
  assert.ok(block?.includes('validation') || block?.includes('Validation') || block?.includes('confirmation') || block?.includes('approval'), `expected approval note in:\n${block}`)
})

test('cb-h: heavy researcher → context says proactively surface data', () => {
  const u = U + '-cb-h'
  clean(u)
  db.prepare(`INSERT INTO channel_i_profiles (user_id, total_signals, dominant_style, style_counts, research_depth, avg_research_per_session) VALUES (?, 9, 'data_first', '{"data_first":8}', 'heavy', 4.5)`)
    .run(u)
  const block = buildChannelIContextBlock(u)
  assert.ok(block?.includes('Heavy') || block?.includes('heavy') || block?.includes('proactively') || block?.includes('researcher'), `expected heavy research note in:\n${block}`)
})

// ─── Summary ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n── Results ───────────────────────────────────────────────────────`)
  console.log(`   ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 400)
