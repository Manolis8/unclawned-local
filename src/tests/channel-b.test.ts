/**
 * Channel B test suite — run with: npx tsx src/tests/channel-b.test.ts
 *
 * Level 1 — Unit tests (pure logic, no DB):
 *   latency-calculator, paste-classifier, correction-detector
 * Level 2 — Integration tests (real DB — added in Part 3+)
 * Level 3 — Behavioral tests (manual, run against live server)
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'

// ─── Latency calculator ───────────────────────────────────────────────────────
import {
  bucketLatency,
  computeLatencySeconds,
  detectRubberStamp,
  isLatencyMeaningful,
} from '../lib/channel-b/latency-calculator.js'

let pass = 0
let fail = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    pass++
  } catch (err: any) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    fail++
  }
}

// ── LATENCY CALCULATOR ────────────────────────────────────────────────────────
console.log('\nLatency Calculator')

test('< 2s → invalid', () => assert.equal(bucketLatency(1), 'invalid'))
test('0s → invalid', () => assert.equal(bucketLatency(0), 'invalid'))
test('2s → immediate', () => assert.equal(bucketLatency(2), 'immediate'))
test('15s → immediate', () => assert.equal(bucketLatency(15), 'immediate'))
test('30s → immediate', () => assert.equal(bucketLatency(30), 'immediate'))
test('31s → quick', () => assert.equal(bucketLatency(31), 'quick'))
test('180s (3m) → quick', () => assert.equal(bucketLatency(180), 'quick'))
test('300s (5m) → quick', () => assert.equal(bucketLatency(300), 'quick'))
test('301s → medium', () => assert.equal(bucketLatency(301), 'medium'))
test('900s (15m) → medium', () => assert.equal(bucketLatency(900), 'medium'))
test('1800s (30m) → medium', () => assert.equal(bucketLatency(1800), 'medium'))
test('1801s → slow', () => assert.equal(bucketLatency(1801), 'slow'))
test('3600s (1h) → slow', () => assert.equal(bucketLatency(3600), 'slow'))
test('14400s (4h) → slow', () => assert.equal(bucketLatency(14400), 'slow'))
test('14401s → session_break', () => assert.equal(bucketLatency(14401), 'session_break'))
test('86400s (1 day) → session_break', () => assert.equal(bucketLatency(86400), 'session_break'))

test('invalid bucket is not meaningful', () => assert.equal(isLatencyMeaningful('invalid'), false))
test('session_break is not meaningful', () => assert.equal(isLatencyMeaningful('session_break'), false))
test('immediate is meaningful', () => assert.equal(isLatencyMeaningful('immediate'), true))
test('slow is meaningful', () => assert.equal(isLatencyMeaningful('slow'), true))

test('rubber stamp: fast + long output + no correction', () => {
  assert.equal(detectRubberStamp(3, 200, false), true)
})
test('rubber stamp: fast + short output → false (could read in 3s)', () => {
  assert.equal(detectRubberStamp(3, 50, false), false)
})
test('rubber stamp: is a correction → false (they did read)', () => {
  assert.equal(detectRubberStamp(3, 200, true), false)
})
test('rubber stamp: latency too high (6s) → false', () => {
  assert.equal(detectRubberStamp(6, 200, false), false)
})
test('rubber stamp: latency < 2s (invalid) → false', () => {
  assert.equal(detectRubberStamp(1, 200, false), false)
})

test('computeLatencySeconds: invalid ISO string → -1', () => {
  const r = computeLatencySeconds('not-a-date', new Date())
  assert.equal(r, -1)
})
test('computeLatencySeconds: 60 seconds difference', () => {
  const prior = new Date(Date.now() - 60_000).toISOString()
  const r = computeLatencySeconds(prior, new Date())
  assert.ok(r >= 59 && r <= 61, `Expected ~60, got ${r}`)
})

// ── PASTE CLASSIFIER ──────────────────────────────────────────────────────────
import { classifyPaste, extractPastedPortion, getPastedTribeHits } from '../lib/channel-b/paste-classifier.js'

console.log('\nPaste Classifier — classifyPaste')

test('code: backtick fences', () => {
  const msg = 'here is the function:\n```typescript\nconst x = 5\nreturn x\n```'
  assert.equal(classifyPaste(msg), 'code')
})
test('code: 3+ code-pattern lines', () => {
  const msg = 'look at this:\nconst x = 5;\nfunction hello() {\n  return x;\n}\nif (x > 0) {'
  assert.equal(classifyPaste(msg), 'code')
})
test('email_thread: From: header with email', () => {
  const msg = 'From: boss@company.com\nSubject: Q3 Results\nHi team,\n\nPlease review the attached...'
  assert.equal(classifyPaste(msg), 'email_thread')
})
test('email_thread: quote markers', () => {
  const msg = 'What do you think?\n\n> Original message:\n> We need to discuss this\n> by Friday.'
  assert.equal(classifyPaste(msg), 'email_thread')
})
test('email_thread: "On [date], [name] wrote:"', () => {
  const msg = 'On Tuesday, Mar 4, John Smith wrote:\n> Hey, can we move the meeting?\n\nSure, works for me'
  assert.equal(classifyPaste(msg), 'email_thread')
})
test('data_numbers: pipe table', () => {
  const msg = 'Q1 results:\n| Product | Revenue | Growth |\n| SaaS | $500k | 12% |\n| On-prem | $200k | 3% |'
  assert.equal(classifyPaste(msg), 'data_numbers')
})
test('data_numbers: high number density lines', () => {
  const msg = 'Performance: Q1: 450k, 12%, $2.3M\nQ2: 520k, 15%, $2.9M\nQ3: 480k, 10%, $2.7M\nQ4: 600k, 18%, $3.5M'
  assert.equal(classifyPaste(msg), 'data_numbers')
})
test('formal_document: executive summary marker', () => {
  const msg = 'Executive Summary\n\nThis document outlines our strategy for FY2025.\n\n1. Market Analysis\n2. Product Roadmap\n3. Financial Projections'
  assert.equal(classifyPaste(msg), 'formal_document')
})
test('formal_document: numbered headings (3+)', () => {
  const msg = '1. Introduction\n2. Problem Statement\n3. Proposed Solution\n4. Budget\n5. Timeline'
  assert.equal(classifyPaste(msg), 'formal_document')
})
test('article_content: "According to" attribution', () => {
  const msg = 'According to a 2024 study by McKinsey, enterprises that adopt AI see 20% efficiency gains. This finding aligns with broader research suggesting automation is transformative.'
  assert.equal(classifyPaste(msg), 'article_content')
})
test('article_content: long paragraphs (2+)', () => {
  const longPara = 'word '.repeat(90)
  const msg = `${longPara}\n\n${longPara}`
  assert.equal(classifyPaste(msg), 'article_content')
})
test('external_writing: long avg sentence length', () => {
  // Sentences averaging 30+ words each
  const s = (w: number) => 'word '.repeat(w).trim() + '. '
  const msg = s(30) + s(35) + s(28) + s(32)
  assert.equal(classifyPaste(msg), 'external_writing')
})
test('unknown: short unremarkable text', () => {
  assert.equal(classifyPaste('some random short text without patterns'), 'unknown')
})

console.log('\nPaste Classifier — extractPastedPortion')

test('exact prefix match', () => {
  const owned = 'can you use this'
  const pasted = '\n\nSubject: Meeting tomorrow\nFrom: ceo@corp.com'
  const result = extractPastedPortion(owned + pasted, owned)
  assert.ok(result.includes('Subject:'), `Expected pasted content, got: "${result}"`)
})
test('empty userOwnedText → returns full message', () => {
  const msg = 'some pasted content'
  assert.equal(extractPastedPortion(msg, ''), msg)
})
test('userOwnedText not found → returns empty string', () => {
  const result = extractPastedPortion('some content', 'xyz abc totally different words 123')
  assert.equal(result, '')
})
test('fuzzy last-5-words match: extra prefix in owned text → pasted content found', () => {
  const msg = 'please review the following email:\n\nFrom: boss@corp.com\nSubject: Partnership'
  const owned = 'extra words at start please review the following email'
  const result = extractPastedPortion(msg, owned)
  assert.ok(result.includes('From:'), `Expected pasted content, got: "${result}"`)
})

console.log('\nPaste Classifier — getPastedTribeHits')

test('startup vocab (5+ terms) → primaryTribe = startup_operator', () => {
  const text = 'Our MRR is growing but our CAC has spiked. We need to reduce churn and extend our runway before the next raise. The funnel conversion is also dropping.'
  const { primaryTribe } = getPastedTribeHits(text)
  assert.equal(primaryTribe, 'startup_operator')
})
test('generic text → primaryTribe = null (< 3 tribe hits)', () => {
  const text = 'The weather forecast shows rain tomorrow. The restaurant was packed on Friday evening. Traffic was heavier than usual this morning.'
  const { primaryTribe } = getPastedTribeHits(text)
  assert.equal(primaryTribe, null)
})
test('short text (< 20 chars) → primaryTribe = null immediately', () => {
  const { primaryTribe } = getPastedTribeHits('MRR CAC churn')
  assert.equal(primaryTribe, null)
})

// ── CORRECTION DETECTOR ───────────────────────────────────────────────────────
import {
  detectContinuation,
  detectCorrection,
  classifyCorrectionLevel,
} from '../lib/channel-b/correction-detector.js'

const PRIOR_WRITE = '[Draft email about our product launch event for Q3...]'

console.log('\nCorrection Detector — detectContinuation')

test('continuation: explicit correction vocabulary', () => {
  assert.equal(detectContinuation('change the tone to be more casual', PRIOR_WRITE), true)
})
test('continuation: references prior output ("the draft")', () => {
  assert.equal(detectContinuation('the draft is too formal', PRIOR_WRITE), true)
})
test('continuation: structural correction', () => {
  assert.equal(detectContinuation('can you restructure this? put value prop first', PRIOR_WRITE), true)
})
test('continuation: "can you fix" — correction overrides can-you starter', () => {
  assert.equal(detectContinuation('can you fix the opening line?', PRIOR_WRITE), true)
})
test('new task: explicit research request', () => {
  assert.equal(detectContinuation('can you find competitor pricing for us?', PRIOR_WRITE), false)
})
test('new task: write request', () => {
  assert.equal(detectContinuation('write me a follow-up email for next week', PRIOR_WRITE), false)
})
test('new task: research request', () => {
  assert.equal(detectContinuation('what is the market size for this segment?', PRIOR_WRITE), false)
})
test('continuation: short message with no new-task starters', () => {
  assert.equal(detectContinuation('too long', PRIOR_WRITE), true)
})
test('continuation: discard signal', () => {
  assert.equal(detectContinuation('forget it, let\'s start over', PRIOR_WRITE), true)
})

console.log('\nCorrection Detector — detectCorrection')

test('is correction: "change the tone"', () => {
  const r = detectCorrection('change the tone to be more casual')
  assert.equal(r.isCorrection, true)
  assert.ok(r.phrases.length > 0)
})
test('is correction: "that\'s not quite right"', () => {
  const r = detectCorrection("that's not quite right, the intro should be shorter")
  assert.equal(r.isCorrection, true)
})
test('is correction: structural', () => {
  const r = detectCorrection('restructure it — put the value prop first')
  assert.equal(r.isCorrection, true)
})
test('not correction: context provision ("here\'s the background")', () => {
  const r = detectCorrection("here's the background on the deal, use this to write the email")
  assert.equal(r.isCorrection, false)
})
test('not correction: "for context" marker', () => {
  const r = detectCorrection('for context, here is the company overview')
  assert.equal(r.isCorrection, false)
})
test('is correction: discard ("forget it")', () => {
  const r = detectCorrection('forget it, this approach is totally wrong')
  assert.equal(r.isCorrection, true)
})

console.log('\nCorrection Detector — classifyCorrectionLevel')

test('L1: short word-swap correction', () => {
  const level = classifyCorrectionLevel('change "utilize" to "use"', 'write', 400)
  assert.equal(level, 1)
})
test('L1: short preference tweak', () => {
  const level = classifyCorrectionLevel('make it shorter', 'write', 400)
  assert.equal(level, 1)
})
test('L2: medium, references specific part ("the intro")', () => {
  const level = classifyCorrectionLevel(
    'the intro paragraph is too stiff — can you rewrite it to sound more approachable and conversational?',
    'write', 400
  )
  assert.equal(level, 2)
})
test('L3: structural — "restructure"', () => {
  const level = classifyCorrectionLevel('can you restructure this? put the value prop first', 'write', 400)
  assert.equal(level, 3)
})
test('L3: structural — "put the X before Y"', () => {
  const level = classifyCorrectionLevel('put the budget section before the timeline section', 'write', 400)
  assert.equal(level, 3)
})
test('L3: structural — "the format should be different"', () => {
  const level = classifyCorrectionLevel('the format should be different — use bullet points not paragraphs', 'write', 400)
  assert.equal(level, 3)
})
test('L4: long user-written version on write task', () => {
  // 50+ words, low instruction density, prior task = write
  const userVersion = 'word '.repeat(55) + 'This is my own version of the content that captures what I actually meant to say and how I want it phrased.'
  const level = classifyCorrectionLevel(userVersion, 'write', 400)
  assert.equal(level, 4)
})
test('L4: does NOT fire on research task (not an output task)', () => {
  const userVersion = 'word '.repeat(55) + 'This is a long message with a lot of content that seems like prose and not instructions at all.'
  const level = classifyCorrectionLevel(userVersion, 'research', 400)
  assert.ok(level !== 4, `Expected not L4, got L${level}`)
})
test('L5: explicit discard + short message', () => {
  const level = classifyCorrectionLevel('forget it, start over', 'write', 400)
  assert.equal(level, 5)
})
test('L5: "never mind" short message', () => {
  const level = classifyCorrectionLevel('never mind that', 'write', 400)
  assert.equal(level, 5)
})
test('L5 requires short message — long discard message → not L5', () => {
  // "forget it" in a long message shouldn't be L5 — might be incidental
  const longMsg = 'forget it, I actually want to take a completely different approach. ' + 'word '.repeat(30)
  const level = classifyCorrectionLevel(longMsg, 'write', 400)
  assert.ok(level !== 5, `Expected not L5, got L${level}`)
})

// Additional correction detector tests (from plan's test list)
test('continuation: "can you add" — correction overrides can-you starter', () => {
  assert.equal(detectContinuation('can you add our company name at the end?', PRIOR_WRITE), true)
})
test('L1: "can you add" targeted addition → L1', () => {
  const level = classifyCorrectionLevel('can you add our company name at the end?', 'write', 400)
  assert.equal(level, 1)
})

// ── INTEGRATION TESTS (real DB) ───────────────────────────────────────────────
import { db } from '../lib/db.js'
import { extractChannelBSignals } from '../lib/channel-b/extractor.js'

const TEST_USER = 'test-channel-b-user'
const TEST_SESSION = 'test-session-channel-b-001'

// Clean slate before integration tests
db.prepare("DELETE FROM channel_b_raw_signals WHERE user_id = ?").run(TEST_USER)
db.prepare("DELETE FROM channel_b_paste_log WHERE user_id = ?").run(TEST_USER)

console.log('\nIntegration Tests — Signal Insertion')

async function runAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    pass++
  } catch (err: any) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    fail++
  }
}

const PRIOR_ASSISTANT = 'Here is your draft email:\n\nSubject: Partnership Opportunity\n\nDear [Name], I hope this finds you well. I wanted to reach out regarding a potential partnership between our companies that could be mutually beneficial. Please let me know if you would be available for a brief call this week.\n\nBest regards'

await runAsync('round-trip: correction signal inserts with correct level', async () => {
  const priorCreatedAt = new Date(Date.now() - 120_000).toISOString() // 2 min ago
  await extractChannelBSignals(
    TEST_USER,
    'can you restructure this? put the value prop first',
    PRIOR_ASSISTANT,
    priorCreatedAt,
    'write me a partnership email',
    TEST_SESSION + '-r1'
  )

  const row = db.prepare(
    "SELECT * FROM channel_b_raw_signals WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(TEST_USER, TEST_SESSION + '-r1') as any

  assert.ok(row, 'Row should exist')
  assert.equal(row.is_continuation, 1)
  assert.equal(row.is_correction, 1)
  assert.equal(row.correction_level, 3, `Expected L3, got L${row.correction_level}`)
  assert.equal(row.prior_task_type, 'write', `Expected 'write', got '${row.prior_task_type}'`)
})

await runAsync('round-trip: acceptance (no correction) inserts with is_correction=0', async () => {
  const priorCreatedAt = new Date(Date.now() - 60_000).toISOString() // 1 min ago
  await extractChannelBSignals(
    TEST_USER,
    'perfect, thanks',
    PRIOR_ASSISTANT,
    priorCreatedAt,
    'write me a partnership email',
    TEST_SESSION + '-r2'
  )

  const row = db.prepare(
    "SELECT * FROM channel_b_raw_signals WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(TEST_USER, TEST_SESSION + '-r2') as any

  assert.ok(row, 'Row should exist')
  assert.equal(row.is_correction, 0)
  assert.equal(row.correction_level, null)
})

await runAsync('latency bucket stored correctly', async () => {
  const priorCreatedAt = new Date(Date.now() - 10_000).toISOString() // 10 seconds ago
  await extractChannelBSignals(
    TEST_USER,
    'change the tone please',
    PRIOR_ASSISTANT,
    priorCreatedAt,
    'write me a partnership email',
    TEST_SESSION + '-r3'
  )

  const row = db.prepare(
    "SELECT latency_seconds, latency_bucket FROM channel_b_raw_signals WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(TEST_USER, TEST_SESSION + '-r3') as any

  assert.ok(row, 'Row should exist')
  assert.equal(row.latency_bucket, 'immediate', `Expected 'immediate', got '${row.latency_bucket}'`)
  assert.ok(row.latency_seconds >= 9 && row.latency_seconds <= 12, `Expected ~10s, got ${row.latency_seconds}`)
})

await runAsync('rubber stamp detection: < 5s + long output + no correction', async () => {
  const priorCreatedAt = new Date(Date.now() - 3_000).toISOString() // 3 seconds ago
  await extractChannelBSignals(
    TEST_USER,
    'sounds good',
    PRIOR_ASSISTANT,
    priorCreatedAt,
    'write me an email',
    TEST_SESSION + '-r4'
  )

  const row = db.prepare(
    "SELECT is_rubber_stamp, latency_seconds FROM channel_b_raw_signals WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(TEST_USER, TEST_SESSION + '-r4') as any

  assert.ok(row, 'Row should exist')
  assert.equal(row.is_rubber_stamp, 1, `Expected rubber stamp, got is_rubber_stamp=${row.is_rubber_stamp}`)
})

await runAsync('multi-turn merge: second correction in same session merges into first', async () => {
  const SESSION_MERGE = TEST_SESSION + '-merge'
  const priorCreated = new Date(Date.now() - 45_000).toISOString()

  // First correction (L1)
  await extractChannelBSignals(
    TEST_USER,
    'change "utilize" to "use"',
    PRIOR_ASSISTANT,
    priorCreated,
    'write me an email',
    SESSION_MERGE
  )

  // Second correction (L3) — within 10 minutes of same session
  await extractChannelBSignals(
    TEST_USER,
    'restructure it — put the CTA at the top',
    PRIOR_ASSISTANT,
    new Date(Date.now() - 30_000).toISOString(),
    'write me an email',
    SESSION_MERGE
  )

  const rows = db.prepare(
    "SELECT correction_level FROM channel_b_raw_signals WHERE user_id = ? AND session_id = ? AND is_correction = 1"
  ).all(TEST_USER, SESSION_MERGE) as any[]

  assert.equal(rows.length, 1, `Expected 1 merged row, got ${rows.length}`)
  assert.equal(rows[0].correction_level, 3, `Expected merged level L3, got L${rows[0].correction_level}`)
})

await runAsync('paste signal: email thread paste → paste_log row inserted', async () => {
  const emailPaste = 'can you use this context:\n\nFrom: partner@startup.com\nSubject: Follow-up on our call\nTo: me@company.com\n\nHey, just wanted to follow up on our conversation last week about the partnership.\n\n' + 'x '.repeat(400)
  const priorCreated = new Date(Date.now() - 60_000).toISOString()

  await extractChannelBSignals(
    TEST_USER,
    emailPaste,
    PRIOR_ASSISTANT,
    priorCreated,
    null,
    TEST_SESSION + '-paste'
  )

  const pasteRow = db.prepare(
    "SELECT paste_type FROM channel_b_paste_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(TEST_USER) as any

  assert.ok(pasteRow, 'Paste log row should exist')
  assert.equal(pasteRow.paste_type, 'email_thread', `Expected email_thread, got ${pasteRow.paste_type}`)

  const rawRow = db.prepare(
    "SELECT contains_paste, paste_type FROM channel_b_raw_signals WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(TEST_USER, TEST_SESSION + '-paste') as any

  assert.equal(rawRow?.contains_paste, 1)
  assert.equal(rawRow?.paste_type, 'email_thread')
})

await runAsync('session_break latency → latency_seconds null in signal', async () => {
  const oldCreated = new Date(Date.now() - 6 * 60 * 60_000).toISOString() // 6 hours ago
  await extractChannelBSignals(
    TEST_USER,
    'change the subject line',
    PRIOR_ASSISTANT,
    oldCreated,
    'write me an email',
    TEST_SESSION + '-break'
  )

  const row = db.prepare(
    "SELECT latency_seconds, latency_bucket FROM channel_b_raw_signals WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(TEST_USER, TEST_SESSION + '-break') as any

  assert.ok(row, 'Row should exist')
  assert.equal(row.latency_seconds, null, `Session break should store null latency, got ${row.latency_seconds}`)
  assert.equal(row.latency_bucket, 'session_break')
})

// ── INTEGRATION TESTS — Profile Builder ───────────────────────────────────────
import { getChannelBProfile, updateChannelBProfile } from '../lib/channel-b/profile-builder.js'
import { buildChannelBContextBlock } from '../lib/channel-b/context-builder.js'

const P4_USER = 'test-channel-b-p4-user'
db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(P4_USER)
db.prepare("DELETE FROM channel_b_raw_signals WHERE user_id = ?").run(P4_USER)
db.prepare("DELETE FROM channel_b_paste_log WHERE user_id = ?").run(P4_USER)

console.log('\nIntegration Tests — Profile Builder')

await runAsync('no profile → getChannelBProfile returns null', async () => {
  const profile = getChannelBProfile(P4_USER)
  assert.equal(profile, null)
})

await runAsync('first signal creates profile with total_reactions=1', async () => {
  updateChannelBProfile(P4_USER, {
    priorTaskType: 'write', isContinuation: true, isCorrection: false,
    correctionLevel: null, containsPaste: false, pasteType: null,
    latencySeconds: 45, latencyBucket: 'quick', isRubberStamp: false,
  })
  const profile = getChannelBProfile(P4_USER)
  assert.ok(profile, 'Profile should exist')
  assert.equal(profile.total_reactions, 1)
})

await runAsync('correction signal increments corrections and sets most_common_level', async () => {
  // 3 more signals: 2 corrections (both L3) + 1 acceptance on write
  for (let i = 0; i < 2; i++) {
    updateChannelBProfile(P4_USER, {
      priorTaskType: 'write', isContinuation: true, isCorrection: true,
      correctionLevel: 3, containsPaste: false, pasteType: null,
      latencySeconds: 60, latencyBucket: 'quick', isRubberStamp: false,
    })
  }
  updateChannelBProfile(P4_USER, {
    priorTaskType: 'write', isContinuation: true, isCorrection: false,
    correctionLevel: null, containsPaste: false, pasteType: null,
    latencySeconds: 90, latencyBucket: 'quick', isRubberStamp: false,
  })

  const profile = getChannelBProfile(P4_USER)!
  const writeStats = profile.correction_profile.by_task_type['write']
  assert.ok(writeStats, 'write stats should exist')
  assert.equal(writeStats.corrections, 2)
  assert.equal(writeStats.level_counts.L3, 2)
  assert.equal(writeStats.most_common_level, 'L3')
})

await runAsync('high_correction_types flagged after 5+ reactions with rate > 30%', async () => {
  // Add 2 more signals to reach 6 total write reactions, 3 corrections = 50% rate
  updateChannelBProfile(P4_USER, {
    priorTaskType: 'write', isContinuation: true, isCorrection: true,
    correctionLevel: 3, containsPaste: false, pasteType: null,
    latencySeconds: 60, latencyBucket: 'quick', isRubberStamp: false,
  })
  // Now 5 write reactions, 3 corrections = 60% correction_rate → high correction
  const profile = getChannelBProfile(P4_USER)!
  assert.ok(
    profile.correction_profile.high_correction_types.includes('write'),
    `Expected write in high_correction_types, got: ${JSON.stringify(profile.correction_profile.high_correction_types)}`
  )
})

await runAsync('low_correction_types flagged after 5+ reactions with rate < 10%', async () => {
  // Add 5 research reactions, 0 corrections
  for (let i = 0; i < 5; i++) {
    updateChannelBProfile(P4_USER, {
      priorTaskType: 'research', isContinuation: false, isCorrection: false,
      correctionLevel: null, containsPaste: false, pasteType: null,
      latencySeconds: 20, latencyBucket: 'immediate', isRubberStamp: false,
    })
  }
  const profile = getChannelBProfile(P4_USER)!
  assert.ok(
    profile.correction_profile.low_correction_types.includes('research'),
    `Expected research in low_correction_types, got: ${JSON.stringify(profile.correction_profile.low_correction_types)}`
  )
})

await runAsync('latency profile tracks avg_seconds and dominant_bucket', async () => {
  // We already sent 5 research signals with 20s latency above
  const profile = getChannelBProfile(P4_USER)!
  const researchLatency = profile.latency_profile.by_task_type['research']
  assert.ok(researchLatency, 'research latency stats should exist')
  assert.equal(researchLatency.count, 5)
  assert.equal(researchLatency.avg_seconds, 20)
  assert.equal(researchLatency.dominant_bucket, 'immediate')
})

await runAsync('fast_task_types flagged when dominant_bucket is immediate', async () => {
  const profile = getChannelBProfile(P4_USER)!
  assert.ok(
    profile.latency_profile.fast_task_types.includes('research'),
    `Expected research in fast_task_types, got: ${JSON.stringify(profile.latency_profile.fast_task_types)}`
  )
})

await runAsync('trust_class HIGH_TRUST when rubber_stamp > 40% and correction_rate < 10%', async () => {
  const TRUST_USER = 'test-cb-trust-user'
  db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(TRUST_USER)

  // 5 admin signals: 0 corrections, all rubber stamps
  for (let i = 0; i < 5; i++) {
    updateChannelBProfile(TRUST_USER, {
      priorTaskType: 'admin', isContinuation: false, isCorrection: false,
      correctionLevel: null, containsPaste: false, pasteType: null,
      latencySeconds: 3, latencyBucket: 'immediate', isRubberStamp: true,
    })
  }
  const profile = getChannelBProfile(TRUST_USER)!
  const adminStats = profile.correction_profile.by_task_type['admin']
  assert.ok(adminStats, 'admin stats should exist')
  assert.equal(adminStats.trust_class, 'HIGH_TRUST',
    `Expected HIGH_TRUST, got ${adminStats.trust_class}`)
  db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(TRUST_USER)
})

await runAsync('trust_class OVERCORRECTED when correction_rate > 30%', async () => {
  // write task already has 60% correction rate in P4_USER
  const profile = getChannelBProfile(P4_USER)!
  const writeStats = profile.correction_profile.by_task_type['write']
  assert.equal(writeStats.trust_class, 'OVERCORRECTED',
    `Expected OVERCORRECTED, got ${writeStats.trust_class}`)
})

await runAsync('slow_task_types: after 5+ slow signals → task type in slow_task_types', async () => {
  const SLOW_USER = 'test-cb-slow-user'
  db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(SLOW_USER)

  for (let i = 0; i < 5; i++) {
    updateChannelBProfile(SLOW_USER, {
      priorTaskType: 'review', isContinuation: false, isCorrection: false,
      correctionLevel: null, containsPaste: false, pasteType: null,
      latencySeconds: 2700, latencyBucket: 'slow', isRubberStamp: false,
    })
  }

  const profile = getChannelBProfile(SLOW_USER)!
  assert.ok(
    profile.latency_profile.slow_task_types.includes('review'),
    `Expected review in slow_task_types, got: ${JSON.stringify(profile.latency_profile.slow_task_types)}`
  )
  db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(SLOW_USER)
})

await runAsync('trust_class RUBBER_STAMP_DISENGAGEMENT: rsRate > 0.4 AND corrRate > 0.25', async () => {
  const RSD_USER = 'test-cb-rsd-user'
  db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(RSD_USER)

  // 6 rubber stamps (immediate, 3s) + 4 corrections → rsRate=60%, corrRate=40%
  for (let i = 0; i < 6; i++) {
    updateChannelBProfile(RSD_USER, {
      priorTaskType: 'write', isContinuation: false, isCorrection: false,
      correctionLevel: null, containsPaste: false, pasteType: null,
      latencySeconds: 3, latencyBucket: 'immediate', isRubberStamp: true,
    })
  }
  for (let i = 0; i < 4; i++) {
    updateChannelBProfile(RSD_USER, {
      priorTaskType: 'write', isContinuation: true, isCorrection: true,
      correctionLevel: 2, containsPaste: false, pasteType: null,
      latencySeconds: 45, latencyBucket: 'quick', isRubberStamp: false,
    })
  }

  const profile = getChannelBProfile(RSD_USER)!
  const stats = profile.correction_profile.by_task_type['write']
  assert.equal(stats.trust_class, 'RUBBER_STAMP_DISENGAGEMENT',
    `Expected RUBBER_STAMP_DISENGAGEMENT, got ${stats.trust_class}`)
  db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(RSD_USER)
})

await runAsync('paste_topic_focus: single paste event → focus NOT set (needs 2+)', async () => {
  const FOCUS_USER = 'test-cb-paste-focus-user'
  db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(FOCUS_USER)
  db.prepare("DELETE FROM channel_b_paste_log WHERE user_id = ?").run(FOCUS_USER)

  db.prepare(`
    INSERT INTO channel_b_paste_log (id, user_id, created_at, paste_type, paste_char_count, primary_tribe)
    VALUES (?, ?, datetime('now'), 'email_thread', 500, 'startup_operator')
  `).run(randomUUID(), FOCUS_USER)

  updateChannelBProfile(FOCUS_USER, {
    priorTaskType: 'write', isContinuation: false, isCorrection: false,
    correctionLevel: null, containsPaste: true, pasteType: 'email_thread',
    latencySeconds: 30, latencyBucket: 'quick', isRubberStamp: false,
  })

  const profile = getChannelBProfile(FOCUS_USER)!
  assert.equal(profile.paste_profile.paste_topic_focus, null,
    `Expected null with only 1 paste event, got ${profile.paste_profile.paste_topic_focus}`)

  // Add a second paste with the same tribe → now focus should be set
  db.prepare(`
    INSERT INTO channel_b_paste_log (id, user_id, created_at, paste_type, paste_char_count, primary_tribe)
    VALUES (?, ?, datetime('now'), 'email_thread', 600, 'startup_operator')
  `).run(randomUUID(), FOCUS_USER)

  updateChannelBProfile(FOCUS_USER, {
    priorTaskType: 'write', isContinuation: false, isCorrection: false,
    correctionLevel: null, containsPaste: true, pasteType: 'email_thread',
    latencySeconds: 30, latencyBucket: 'quick', isRubberStamp: false,
  })

  const profile2 = getChannelBProfile(FOCUS_USER)!
  assert.equal(profile2.paste_profile.paste_topic_focus, 'startup_operator',
    `Expected startup_operator after 2 paste events, got ${profile2.paste_profile.paste_topic_focus}`)

  db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(FOCUS_USER)
  db.prepare("DELETE FROM channel_b_paste_log WHERE user_id = ?").run(FOCUS_USER)
})

await runAsync('upgradeCorrectionLevel corrects level distribution after merge upgrade', async () => {
  const { upgradeCorrectionLevel } = await import('../lib/channel-b/profile-builder.js')
  const MERGE_USER = 'test-cb-merge-upgrade-user'
  db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(MERGE_USER)

  // First correction was L1 (already in profile)
  updateChannelBProfile(MERGE_USER, {
    priorTaskType: 'write', isContinuation: true, isCorrection: true,
    correctionLevel: 1, containsPaste: false, pasteType: null,
    latencySeconds: 60, latencyBucket: 'quick', isRubberStamp: false,
  })

  let profile = getChannelBProfile(MERGE_USER)!
  assert.equal(profile.correction_profile.by_task_type['write'].level_counts.L1, 1)
  assert.equal(profile.correction_profile.by_task_type['write'].level_counts.L3, 0)

  // Merge upgraded it to L3 — fix the profile
  upgradeCorrectionLevel(MERGE_USER, 'write', 1, 3)

  profile = getChannelBProfile(MERGE_USER)!
  const stats = profile.correction_profile.by_task_type['write']
  assert.equal(stats.level_counts.L1, 0, `Expected L1=0 after upgrade, got ${stats.level_counts.L1}`)
  assert.equal(stats.level_counts.L3, 1, `Expected L3=1 after upgrade, got ${stats.level_counts.L3}`)
  assert.equal(stats.most_common_level, 'L3')

  db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(MERGE_USER)
})

// ── INTEGRATION TESTS — Context Builder ──────────────────────────────────────
const CTX_USER = 'test-channel-b-ctx-user'
db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(CTX_USER)

console.log('\nIntegration Tests — Context Builder')

await runAsync('context-builder: no profile → returns empty string', async () => {
  const block = buildChannelBContextBlock(CTX_USER)
  assert.equal(block, '')
})

await runAsync('context-builder cold-start gate: 9 reactions (< 10) → returns empty string', async () => {
  for (let i = 0; i < 9; i++) {
    updateChannelBProfile(CTX_USER, {
      priorTaskType: 'write', isContinuation: true, isCorrection: true,
      correctionLevel: 3, containsPaste: false, pasteType: null,
      latencySeconds: 60, latencyBucket: 'quick', isRubberStamp: false,
    })
  }
  const block = buildChannelBContextBlock(CTX_USER, 'write me an email')
  assert.equal(block, '', `Expected empty at 9 reactions (cold-start), got: "${block}"`)
})

await runAsync('context-builder: 10th reaction crosses cold-start, L3 write → injects structure instruction', async () => {
  updateChannelBProfile(CTX_USER, {
    priorTaskType: 'write', isContinuation: true, isCorrection: true,
    correctionLevel: 3, containsPaste: false, pasteType: null,
    latencySeconds: 60, latencyBucket: 'quick', isRubberStamp: false,
  })
  const block = buildChannelBContextBlock(CTX_USER, 'write me an email about our new product')
  assert.ok(block.length > 0, 'Expected non-empty block after crossing cold-start threshold')
  assert.ok(block.includes('restructure') || block.includes('structure'),
    `Expected L3 structure instruction, got: "${block}"`)
})

await runAsync('context-builder: paste_topic_focus line injected when focus is set', async () => {
  const FOCUS_CTX_USER = 'test-cb-ctx-focus-user'
  db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(FOCUS_CTX_USER)
  db.prepare("DELETE FROM channel_b_paste_log WHERE user_id = ?").run(FOCUS_CTX_USER)

  // Enough reactions to pass cold-start
  for (let i = 0; i < 10; i++) {
    updateChannelBProfile(FOCUS_CTX_USER, {
      priorTaskType: 'write', isContinuation: false, isCorrection: false,
      correctionLevel: null, containsPaste: false, pasteType: null,
      latencySeconds: 20, latencyBucket: 'immediate', isRubberStamp: false,
    })
  }

  // Insert 2 paste log rows with same tribe → paste_topic_focus = 'startup_operator'
  for (let i = 0; i < 2; i++) {
    db.prepare(`
      INSERT INTO channel_b_paste_log (id, user_id, created_at, paste_type, paste_char_count, primary_tribe)
      VALUES (?, ?, datetime('now'), 'email_thread', 500, 'startup_operator')
    `).run(randomUUID(), FOCUS_CTX_USER)
  }
  updateChannelBProfile(FOCUS_CTX_USER, {
    priorTaskType: 'write', isContinuation: false, isCorrection: false,
    correctionLevel: null, containsPaste: true, pasteType: 'email_thread',
    latencySeconds: 20, latencyBucket: 'immediate', isRubberStamp: false,
  })

  const block = buildChannelBContextBlock(FOCUS_CTX_USER)
  assert.ok(block.includes('startup_operator'), `Expected paste topic focus line, got: "${block}"`)

  db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(FOCUS_CTX_USER)
  db.prepare("DELETE FROM channel_b_paste_log WHERE user_id = ?").run(FOCUS_CTX_USER)
})

db.prepare("DELETE FROM channel_b_profiles WHERE user_id = ?").run(CTX_USER)

// ── SUMMARY ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`Channel B — Results: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('SOME TESTS FAILED')
  process.exit(1)
} else {
  console.log('ALL TESTS PASSED')
}
