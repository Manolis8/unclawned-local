/**
 * Channel A — Full Test Suite
 *
 * Run with:  npx tsx src/tests/channel-a.test.ts
 *
 * Covers three levels from the build plan (CHANNEL_A_BUILD_PLAN.txt Part 10):
 *   Level 1 — Unit tests: pure logic, no DB
 *   Level 2 — Integration tests: real DB, verifies persistence
 *   Level 3 — Cold-start gate + progressive context unlock
 *
 * Level 4 (behavioral agent tests) are manual — instructions at the bottom.
 * Run these tests AFTER all channels are built, before going to production.
 */

import assert from 'node:assert/strict'

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const failures: string[] = []

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (err: any) {
    console.log(`  ✗  ${name}`)
    console.log(`     ${err.message}`)
    failed++
    failures.push(`${name}: ${err.message}`)
  }
}

function section(label: string) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(label)
  console.log('─'.repeat(60))
}

function report() {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`RESULTS: ${passed} passed, ${failed} failed`)
  if (failures.length > 0) {
    console.log('\nFailed tests:')
    for (const f of failures) console.log(`  ✗ ${f}`)
  }
  console.log('═'.repeat(60))
  if (failed > 0) process.exit(1)
}

// ─── Imports ──────────────────────────────────────────────────────────────────

import { classifyTaskType } from '../lib/channel-a/task-classifier.js'
import { detectHedging } from '../lib/channel-a/hedging-detector.js'
import { detectFrustration } from '../lib/channel-a/frustration-detector.js'
import { normalizeMessage } from '../lib/channel-a/normalizer.js'
import { detectVocabularyTribeHits } from '../lib/channel-a/tribe-detector.js'
import { extractChannelASignals } from '../lib/channel-a/extractor.js'
import { getChannelAProfile } from '../lib/channel-a/profile-builder.js'
import { buildChannelAContextBlock, buildLiveFrustrationLine, buildDebugReport, getInjectionCount } from '../lib/channel-a/context-builder.js'
import { db } from '../lib/db.js'

// Unique prefix to isolate test data
const UID = `test-ca-${Date.now()}`

// ═════════════════════════════════════════════════════════════════════════════
// LEVEL 1 — UNIT TESTS (pure logic, no DB)
// ═════════════════════════════════════════════════════════════════════════════

section('LEVEL 1 — TASK CLASSIFIER')

await test('classifies write task', () => {
  assert.equal(classifyTaskType('can you write me a cold email to an investor'), 'write')
})

await test('classifies write: "draft"', () => {
  assert.equal(classifyTaskType('draft a proposal for our Q3 launch'), 'write')
})

await test('classifies research task', () => {
  assert.equal(classifyTaskType('what is the cap table structure for an LLC vs a C-corp'), 'research')
})

await test('classifies research: "find"', () => {
  assert.equal(classifyTaskType('find competitors in the B2B SaaS space'), 'research')
})

await test('classifies code task', () => {
  assert.equal(classifyTaskType('debug this function it keeps throwing undefined'), 'code')
})

await test('classifies code: "implement"', () => {
  assert.equal(classifyTaskType('implement a rate limiter for our API endpoint'), 'code')
})

await test('classifies plan task', () => {
  assert.equal(classifyTaskType('plan my Q3 priorities around the fundraise'), 'plan')
})

await test('classifies plan: "roadmap"', () => {
  assert.equal(classifyTaskType('create a roadmap for the next 6 months'), 'plan')
})

await test('classifies analyze task', () => {
  assert.equal(classifyTaskType('analyze the pros and cons of this pricing model'), 'analyze')
})

await test('classifies review task', () => {
  assert.equal(classifyTaskType('proofread this email draft and fix the tone'), 'review')
})

await test('classifies admin task', () => {
  assert.equal(classifyTaskType('schedule a meeting with the team for thursday'), 'admin')
})

await test('classifies brief: "ok"', () => {
  assert.equal(classifyTaskType('ok'), 'brief')
})

await test('classifies brief: very short input', () => {
  assert.equal(classifyTaskType('lets go'), 'brief')
})

await test('code priority over write (debug vs write keywords)', () => {
  // "debug" and "write" both appear — code should win (checked first)
  assert.equal(classifyTaskType('debug this and write a test for it'), 'code')
})

await test('does not classify "form" as admin (word boundary test)', () => {
  // "formal" should not match "form" admin keyword
  const result = classifyTaskType('write a formal email to our investors')
  assert.notEqual(result, 'admin')
})

await test('classifies pitch prep as plan', () => {
  assert.equal(classifyTaskType('prep for my Series A pitch'), 'plan')
})

// ─────────────────────────────────────────────────────────────────────────────
section('LEVEL 1 — HEDGING DETECTOR')

await test('no hedging in confident request', () => {
  const { detected } = detectHedging(normalizeMessage('write a follow-up email to sarah').firstThird)
  assert.equal(detected, false)
})

await test('1 strong hedge fires immediately', () => {
  const { detected, phrases } = detectHedging(
    normalizeMessage("i'm not sure if this is right but maybe write a follow-up").firstThird
  )
  assert.equal(detected, true)
  assert.ok(phrases.some(p => p.includes("not sure")))
})

await test('2 soft hedges fire together', () => {
  const msg = "i think maybe we should try a different approach"
  const { detected, phrases } = detectHedging(normalizeMessage(msg).firstThird)
  assert.equal(detected, true)
  assert.ok(phrases.includes('i think'))
  assert.ok(phrases.includes('maybe'))
})

await test('1 soft hedge alone does not fire', () => {
  // Single "maybe" is noise
  const { detected } = detectHedging(normalizeMessage('maybe write a follow-up to sarah').firstThird)
  assert.equal(detected, false)
})

await test('position filter: hedge in last third does not fire', () => {
  // "i think" at the END — should be past the first third
  const longMsg = 'write a detailed marketing plan for Q3 that covers all our channels and campaigns, i think'
  const { detected } = detectHedging(normalizeMessage(longMsg).firstThird)
  assert.equal(detected, false)
})

await test('i guess triggers soft hedge detection with another', () => {
  const { detected } = detectHedging(
    normalizeMessage('i guess maybe we could try the email approach').firstThird
  )
  assert.equal(detected, true)
})

// ─────────────────────────────────────────────────────────────────────────────
section('LEVEL 1 — FRUSTRATION DETECTOR')

await test('no frustration on first message (priorTurnCount = 0)', () => {
  const { detected } = detectFrustration(
    normalizeMessage("this is still not right, i need the tone to be warmer").normalizedText,
    0, // first message — gated
    []
  )
  assert.equal(detected, false)
})

await test('frustration fires on correction in back-and-forth', () => {
  const { detected, phrases } = detectFrustration(
    normalizeMessage("this is still not right, i need the tone to be warmer").normalizedText,
    2,
    []
  )
  assert.equal(detected, true)
  assert.ok(phrases.some(p => p.includes('still not right') || p.includes('still')))
})

await test('"as i mentioned" fires in conversation context', () => {
  const { detected } = detectFrustration(
    normalizeMessage("as i mentioned earlier, sarah is my cofounder not my advisor").normalizedText,
    3,
    []
  )
  assert.equal(detected, true)
})

await test('personalized pattern fires when provided', () => {
  const { detected, phrases } = detectFrustration(
    normalizeMessage("nope, that's completely off").normalizedText,
    2,
    ["nope, that's completely off"]  // user-specific pattern
  )
  assert.equal(detected, true)
})

await test('clean message at turn 5 does not fire', () => {
  const { detected } = detectFrustration(
    normalizeMessage("great, now can you also add a section on pricing").normalizedText,
    5,
    []
  )
  assert.equal(detected, false)
})

// ─────────────────────────────────────────────────────────────────────────────
section('LEVEL 1 — NORMALIZER')

await test('lowercases text', () => {
  const { normalizedText } = normalizeMessage('Hello WORLD')
  assert.equal(normalizedText, 'hello world')
})

await test('strips URLs', () => {
  const { normalizedText } = normalizeMessage('check https://example.com for details')
  assert.ok(!normalizedText.includes('https'))
})

await test('strips fenced code blocks', () => {
  const msg = 'here is the code:\n```js\nconst x = 1\n```\nwhat do you think?'
  const { normalizedText } = normalizeMessage(msg)
  assert.ok(!normalizedText.includes('const x'))
})

await test('firstThird is first 1/3 of normalized text', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz'  // 26 chars → firstThird = ~9 chars
  const { firstThird } = normalizeMessage(text)
  assert.ok(firstThird.length <= Math.ceil(text.length / 3) + 1)
  assert.ok(firstThird.startsWith('a'))
})

await test('detects pasted content for long message with email headers', () => {
  // Must be > 800 chars to trigger the email-header paste heuristic
  const longPaste = 'From: boss@company.com\nSubject: Q3 review\n' + 'x '.repeat(400)
  const { containsPastedContent } = normalizeMessage(longPaste)
  assert.equal(containsPastedContent, true)
})

await test('normal short message not flagged as pasted', () => {
  const { containsPastedContent } = normalizeMessage('write a follow-up email to sarah about the proposal')
  assert.equal(containsPastedContent, false)
})

// ─────────────────────────────────────────────────────────────────────────────
section('LEVEL 1 — TRIBE DETECTOR')

await test('detects startup_operator vocabulary', () => {
  const msg = 'I need to prep for my Series A pitch, our ARR is $1.2M and we have good traction but need to explain our burn to investors'
  const norm = normalizeMessage(msg)
  const hits = detectVocabularyTribeHits(norm.normalizedText, norm.words, norm.userOwnedText, norm.containsPastedContent)
  assert.ok(hits.startup_operator?.length >= 3, `Expected 3+ startup_operator hits, got: ${JSON.stringify(hits.startup_operator)}`)
})

await test('startup: specific words detected', () => {
  const msg = 'our ARR is growing, but burn rate is high'
  const norm = normalizeMessage(msg)
  const hits = detectVocabularyTribeHits(norm.normalizedText, norm.words, norm.userOwnedText, norm.containsPastedContent)
  const words = hits.startup_operator ?? []
  assert.ok(words.some(w => w.toLowerCase().includes('arr')), `ARR not found in ${JSON.stringify(words)}`)
})

await test('detects technical vocabulary', () => {
  const msg = 'help me deploy this to production, the endpoint is timing out under load'
  const norm = normalizeMessage(msg)
  const hits = detectVocabularyTribeHits(norm.normalizedText, norm.words, norm.userOwnedText, norm.containsPastedContent)
  assert.ok(hits.technical?.length >= 2, `Expected 2+ technical hits, got: ${JSON.stringify(hits.technical)}`)
})

await test('pasted content: tribe detection uses userOwnedText only', () => {
  // Short user intro + long pasted enterprise body
  const userPart = 'summarize this for me'
  const pastedPart = '\nFrom: vp@enterprise.com\nSubject: stakeholder alignment\n' + 'procurement compliance SLA KPI C-suite enterprise B2B '.repeat(20)
  const msg = userPart + pastedPart
  const norm = normalizeMessage(msg)
  const hits = detectVocabularyTribeHits(norm.normalizedText, norm.words, norm.userOwnedText, norm.containsPastedContent)
  // The key guarantee: words from the LONG PASTED BODY should not contaminate tribe detection.
  // Header words (Subject: stakeholder alignment) may appear in userOwnedText framing — that's acceptable.
  // What must NOT be detected: repeated body words from the pasted document.
  const enterpriseHits = (hits.enterprise ?? []).map(h => h.toLowerCase())
  const bodyOnlyWords = ['procurement', 'compliance', 'kpi', 'c-suite']
  for (const word of bodyOnlyWords) {
    assert.ok(!enterpriseHits.includes(word), `"${word}" is a pasted body word and must not appear in tribe hits`)
  }
})

await test('generic request has no dominant tribe', () => {
  const msg = 'can you help me with something'
  const norm = normalizeMessage(msg)
  const hits = detectVocabularyTribeHits(norm.normalizedText, norm.words, norm.userOwnedText, norm.containsPastedContent)
  const totalHits = Object.values(hits).reduce((sum, arr) => sum + arr.length, 0)
  assert.equal(totalHits, 0)
})

// ═════════════════════════════════════════════════════════════════════════════
// LEVEL 2 — INTEGRATION TESTS (real DB)
// ═════════════════════════════════════════════════════════════════════════════

section('LEVEL 2 — SIGNAL INSERTION')

await test('extractChannelASignals writes a row to channel_a_raw_signals', async () => {
  const userId = `${UID}-insert`
  await extractChannelASignals(userId, 'analyze the pros and cons of this pricing strategy', null, 0)
  const row = db.prepare('SELECT * FROM channel_a_raw_signals WHERE user_id = ?').get(userId) as any
  assert.ok(row, 'Row not found in DB')
  assert.equal(row.user_id, userId)
  assert.ok(row.message_length > 0)
  assert.equal(row.task_type, 'analyze')
})

await test('raw signal captures tribe word hits as JSON', async () => {
  const userId = `${UID}-tribe-insert`
  await extractChannelASignals(userId, 'our ARR is growing and we need to optimize our burn rate before the Series A', null, 0)
  const row = db.prepare('SELECT tribe_word_hits FROM channel_a_raw_signals WHERE user_id = ?').get(userId) as any
  assert.ok(row, 'Row not found')
  const hits = JSON.parse(row.tribe_word_hits)
  assert.ok(hits.startup_operator?.length > 0, `Expected startup_operator hits, got: ${JSON.stringify(hits)}`)
})

await test('raw signal captures hedging when 2+ soft hedges present', async () => {
  const userId = `${UID}-hedge-insert`
  // "i think" + "maybe" in first third → should detect hedging
  await extractChannelASignals(userId, 'i think maybe we should write a follow-up email', null, 0)
  const row = db.prepare('SELECT hedging_detected, hedging_phrases FROM channel_a_raw_signals WHERE user_id = ?').get(userId) as any
  assert.ok(row)
  assert.equal(row.hedging_detected, 1, 'Expected hedging_detected = 1')
})

await test('raw signal does NOT capture frustration on first message', async () => {
  const userId = `${UID}-nofrust`
  await extractChannelASignals(userId, 'still not right, tone is wrong', null, 0)
  const row = db.prepare('SELECT frustration_detected FROM channel_a_raw_signals WHERE user_id = ?').get(userId) as any
  assert.ok(row)
  assert.equal(row.frustration_detected, 0, 'priorTurnCount=0 should block frustration detection')
})

await test('raw signal captures frustration on turn 2+', async () => {
  const userId = `${UID}-frust`
  await extractChannelASignals(userId, 'still not right, tone is wrong', null, 2)
  const row = db.prepare('SELECT frustration_detected FROM channel_a_raw_signals WHERE user_id = ?').get(userId) as any
  assert.ok(row)
  assert.equal(row.frustration_detected, 1, 'Expected frustration_detected = 1')
})

// ─────────────────────────────────────────────────────────────────────────────
section('LEVEL 2 — WORD FREQUENCY TABLE')

await test('word frequency increments correctly', async () => {
  const userId = `${UID}-wf`
  // Send 3 messages all containing "ARR"
  for (let i = 0; i < 3; i++) {
    await extractChannelASignals(userId, `our ARR target is $2M for next year round ${i}`, null, 0)
  }
  const row = db.prepare(
    "SELECT count FROM channel_a_word_frequency WHERE user_id = ? AND LOWER(word) = 'arr'"
  ).get(userId) as any
  assert.ok(row, 'Word frequency row not found')
  assert.ok(row.count >= 3, `Expected count >= 3, got ${row.count}`)
})

// ─────────────────────────────────────────────────────────────────────────────
section('LEVEL 2 — PROFILE BUILD')

await test('profile is created after first extraction', async () => {
  const userId = `${UID}-profile`
  await extractChannelASignals(userId, 'research startup funding trends for seed stage companies', null, 0)
  const profile = getChannelAProfile(userId)
  assert.ok(profile, 'Profile not found')
  assert.equal(profile!.total_samples, 1)
})

await test('total_samples increments with each extraction', async () => {
  const userId = `${UID}-count`
  for (let i = 0; i < 5; i++) {
    await extractChannelASignals(userId, `message number ${i} about our startup ARR and burn`, null, i)
  }
  const profile = getChannelAProfile(userId)
  assert.equal(profile?.total_samples, 5)
})

await test('task_types_seen is populated in profile', async () => {
  const userId = `${UID}-types`
  await extractChannelASignals(userId, 'write a fundraising email to investors', null, 0)
  await extractChannelASignals(userId, 'research competitor pricing in B2B SaaS', null, 1)
  await extractChannelASignals(userId, 'analyze our churn numbers from last quarter', null, 2)
  const profile = getChannelAProfile(userId)
  assert.ok(profile?.negative_space.task_types_seen.includes('write'), 'write not in task_types_seen')
  assert.ok(profile?.negative_space.task_types_seen.includes('research'), 'research not in task_types_seen')
  assert.ok(profile?.negative_space.task_types_seen.includes('analyze'), 'analyze not in task_types_seen')
})

await test('vocabulary_tribe primary_tribe set after enough startup vocab', async () => {
  const userId = `${UID}-tribe-profile`
  const startupMessages = [
    'our ARR hit $1M last month, burn rate is under control',
    'need to prep for the Series A pitch with investor deck',
    'our GTM strategy needs work before we push for traction',
    'can you help with our fundraise narrative and cap table',
    'analyze our churn and MRR trends before the board meeting',
  ]
  for (const msg of startupMessages) {
    await extractChannelASignals(userId, msg, null, 0)
  }
  const profile = getChannelAProfile(userId)
  assert.equal(profile?.vocabulary_tribe.primary_tribe, 'startup_operator',
    `Expected startup_operator, got: ${profile?.vocabulary_tribe.primary_tribe}`)
})

await test('hedging_profile counts hedged messages per task type', async () => {
  const userId = `${UID}-hedge-profile`
  // 3 hedging write messages + 1 confident write message
  // Note: both soft hedges must appear in the firstThird of the message
  await extractChannelASignals(userId, 'i think maybe write a follow-up email to sarah', null, 0)  // hedging: i think + maybe
  await extractChannelASignals(userId, 'i guess i think we should draft a proposal for them', null, 1) // hedging: i guess + i think
  await extractChannelASignals(userId, 'write a cold email to the investor', null, 2)               // confident
  const profile = getChannelAProfile(userId)
  const writeCount = profile?.hedging_profile.counts_by_type['write']
  assert.ok(writeCount, 'No write count in hedging profile')
  assert.ok(writeCount.total >= 3, `Expected >= 3 write samples, got ${writeCount.total}`)
  assert.ok(writeCount.hedged >= 2, `Expected >= 2 hedged write samples, got ${writeCount.hedged}`)
})

await test('frustration fingerprint updated after frustration detection', async () => {
  const userId = `${UID}-frust-profile`
  await extractChannelASignals(userId, 'first message about something', null, 0)
  await extractChannelASignals(userId, 'still not right, need a warmer tone', null, 1)   // frustration
  await extractChannelASignals(userId, 'still not right, still too formal', null, 2)     // frustration
  const profile = getChannelAProfile(userId)
  assert.ok(profile?.frustration_fingerprint.last_frustration !== null, 'Expected last_frustration to be set')
  assert.ok(profile!.frustration_fingerprint.known_patterns.length > 0, 'Expected known_patterns to be populated')
})

// ═════════════════════════════════════════════════════════════════════════════
// LEVEL 3 — COLD-START GATE + PROGRESSIVE CONTEXT UNLOCK
// ═════════════════════════════════════════════════════════════════════════════

section('LEVEL 3 — COLD-START GATE')

await test('0 samples → context block returns empty string', () => {
  const block = buildChannelAContextBlock(`${UID}-cold`)
  assert.equal(block, '', `Expected empty string, got: "${block}"`)
})

await test('4 samples → still returns empty (under TRIBE_MIN=5)', async () => {
  const userId = `${UID}-gate4`
  for (let i = 0; i < 4; i++) {
    await extractChannelASignals(userId, `startup ARR burn rate traction message ${i}`, null, 0)
  }
  const block = buildChannelAContextBlock(userId)
  assert.equal(block, '', `Expected empty at 4 samples, got: "${block}"`)
})

await test('5+ samples with tribe → context block non-empty', async () => {
  const userId = `${UID}-gate5`
  // Need enough unique tribe words to clear the 0.05 threshold (5% of 124 terms = ~7 words)
  // Each message should cover different startup terms
  const msgs = [
    'our ARR is growing and churn is low — founder-market fit is strong',
    'runway is 18 months, burn is controlled, MRR tracking well',
    'prepping for Series A pitch with investors — need help with the deck',
    'go-to-market strategy for our ICP segment, GTM and traction plan',
    'pivot the product or double down — what do you think about PMF signals',
  ]
  for (const msg of msgs) {
    await extractChannelASignals(userId, msg, null, 0)
  }
  const block = buildChannelAContextBlock(userId)
  assert.ok(block.length > 0, 'Expected non-empty context block at 5+ samples')
  assert.ok(block.includes('startup_operator'), `Expected startup_operator in block: "${block}"`)
})

await test('5-14 samples → hedging NOT included (below HEDGING_MIN=15)', async () => {
  const userId = `${UID}-gate10`
  // 10 hedging messages — but still < 15 samples so hedging profile shouldn't inject
  for (let i = 0; i < 10; i++) {
    await extractChannelASignals(userId, `i think maybe startup ARR burn message ${i}`, null, 0)
  }
  const block = buildChannelAContextBlock(userId)
  // Below 15 samples — even if hedging was detected, the profile block won't show it
  assert.ok(!block.includes('uncertain') && !block.includes('confident'),
    `Hedging context should not appear at < 15 samples, got: "${block}"`)
})

await test('negative space not injected before 8 weeks + 50 samples', async () => {
  const userId = `${UID}-negspace`
  for (let i = 0; i < 35; i++) {
    await extractChannelASignals(userId, `startup ARR burn rate message ${i}`, null, 0)
  }
  const profile = getChannelAProfile(userId)
  // Even at 35 samples, weeks_since_start will be 0 (just created now)
  assert.equal(profile?.negative_space.negative_space_confident, false,
    'Negative space should not be confident without 8 weeks')
  const block = buildChannelAContextBlock(userId)
  assert.ok(!block.includes('never requested'), `Negative space should not appear yet: "${block}"`)
})

// ─────────────────────────────────────────────────────────────────────────────
section('LEVEL 3 — LIVE FRUSTRATION INJECTION')

await test('buildLiveFrustrationLine returns empty for priorTurnCount=0', () => {
  const line = buildLiveFrustrationLine(`${UID}-lf1`, 'still not right', 0)
  assert.equal(line, '')
})

await test('buildLiveFrustrationLine returns context line when frustration detected at turn 2', () => {
  const line = buildLiveFrustrationLine(`${UID}-lf2`, 'still not right, needs a warmer tone', 2)
  assert.ok(line.length > 0, 'Expected non-empty frustration line')
  assert.ok(line.includes('FRUSTRATION'), `Expected FRUSTRATION marker in: "${line}"`)
})

await test('buildLiveFrustrationLine returns empty for clean message even at turn 5', () => {
  const line = buildLiveFrustrationLine(`${UID}-lf3`, 'great job, can you now add a pricing section', 5)
  assert.equal(line, '')
})

// ─────────────────────────────────────────────────────────────────────────────
section('LEVEL 3 — CALIBRATION ALERT')

await test('debug report shows calibration health field', async () => {
  const userId = `${UID}-calib`
  for (let i = 0; i < 5; i++) {
    await extractChannelASignals(userId, `startup ARR message for calibration test ${i}`, null, 0)
  }
  const report = buildDebugReport(userId)
  assert.ok(report.includes('Calibration health:'), `Expected calibration health in report: ${report.slice(0, 200)}`)
})

await test('debug report shows collection status', async () => {
  const userId = `${UID}-debug`
  for (let i = 0; i < 3; i++) {
    await extractChannelASignals(userId, `write a startup fundraising email ${i}`, null, 0)
  }
  const report = buildDebugReport(userId)
  assert.ok(report.includes('Total signals: 3'), `Expected 3 signals in report`)
  assert.ok(report.includes('INJECTION STATUS'), 'Expected INJECTION STATUS section')
})

await test('debug report for unknown user shows helpful message', () => {
  const report = buildDebugReport(`${UID}-nobody`)
  assert.ok(report.includes('No profile found'), `Expected no-profile message, got: ${report.slice(0, 100)}`)
})

// ─────────────────────────────────────────────────────────────────────────────

report()

// ═════════════════════════════════════════════════════════════════════════════
// LEVEL 4 — BEHAVIORAL TESTS (manual)
// ═════════════════════════════════════════════════════════════════════════════
//
// These cannot be automated. Run them manually against a live server.
//
// TEST A — Tribe context changes output
//   1. Clear channel_a_raw_signals and channel_a_profiles for test user
//   2. Send 20 messages with startup vocabulary (ARR, burn, Series A, etc.)
//   3. Ask: "help me write a message to a contact about my work"
//   4. Observe: agent output should use startup-appropriate framing
//   5. Repeat with fresh user (no profile) — output should be more generic
//   6. Pass if: profiled response is more calibrated to the startup world
//
// TEST B — Hedging triggers collaborative mode
//   1. Send 10 "write" messages with hedging (i think, maybe)
//   2. Send new confident write request: "draft a fundraising email"
//   3. Observe: agent should ask a clarifying question OR offer options before drafting
//   4. Send a "research" request (hedging profile = low on research)
//   5. Observe: agent should just answer, no options
//   6. Pass if: behavior differs between the two task types
//
// TEST C — Frustration changes response character
//   1. Send a message with "[FRUSTRATION]" signal at turn 2+
//   2. Observe the NEXT response:
//      ✓ Shorter than baseline response for this task type
//      ✓ No preamble ("Of course! Sure, let me help...")
//      ✓ No options or alternatives presented
//      ✓ Direct answer only
//      ✓ Agent does NOT say "I see you're frustrated" or similar
//   3. Pass if: all 5 criteria met
//
// TEST D — Debug endpoint verification
//   Call: GET /api/debug/channel-a/:userId (with your Bearer token)
//   Manually verify:
//      - Every field in the report matches what you see in the DB directly
//      - injection_count > 0 after sending 5+ messages (if 0: check injection wiring)
//      - context block preview shows tribe name correctly
//      - Tribe bar chart scores sum to <= 100% each
//
// ═════════════════════════════════════════════════════════════════════════════
