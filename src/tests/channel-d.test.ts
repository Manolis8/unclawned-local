/**
 * Channel D test suite — run with: npx tsx src/tests/channel-d.test.ts
 *
 * Level 1 — Trigger logic (requires DB for insert/read, but tests detection patterns)
 * Level 2 — Integration (real DB round-trips: trigger → ask → answer → context)
 * Level 3 — Behavioral tests (manual, live server — see CHANNEL_TESTS.txt)
 */

import assert from 'node:assert/strict'
import { db } from '../lib/db.js'
import {
  hasPendingQuestion,
  checkAssumptionCorrectionTrigger,
  checkPressureTrigger,
  checkNewDomainTrigger,
  checkCompletionFollowupTrigger,
} from '../lib/channel-d/trigger-detector.js'
import { extractChannelDAnswer } from '../lib/channel-d/answer-extractor.js'
import { buildChannelDContextBlock, buildDebugReport } from '../lib/channel-d/context-builder.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

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

function freshUser(tag: string): string {
  const userId = `cd-test-${tag}-${Date.now()}`
  db.prepare("DELETE FROM channel_d_pending WHERE user_id = ?").run(userId)
  db.prepare("DELETE FROM channel_d_extractions WHERE user_id = ?").run(userId)
  return userId
}

function pendingCount(userId: string, status?: string): number {
  if (status) {
    return (db.prepare("SELECT COUNT(*) as c FROM channel_d_pending WHERE user_id = ? AND status = ?").get(userId, status) as any)?.c ?? 0
  }
  return (db.prepare("SELECT COUNT(*) as c FROM channel_d_pending WHERE user_id = ?").get(userId) as any)?.c ?? 0
}

function latestPending(userId: string) {
  return db.prepare("SELECT * FROM channel_d_pending WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(userId) as any
}

function latestExtraction(userId: string) {
  return db.prepare("SELECT * FROM channel_d_extractions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(userId) as any
}

function markPendingAsked(userId: string) {
  db.prepare("UPDATE channel_d_pending SET status = 'asked', asked_at = datetime('now') WHERE user_id = ? AND status = 'pending'").run(userId)
}

// ─── Section 1: D.1 — Assumption Correction Trigger ──────────────────────────

console.log('\nD.1 — Assumption Correction Trigger')

test('fires when message contains factual correction marker "we\'ve met"', () => {
  const u = freshUser('d1-a')
  checkAssumptionCorrectionTrigger(u, 's1', "Actually we've met before — she's my investor")
  assert.equal(hasPendingQuestion(u), true)
  assert.equal(latestPending(u)?.trigger_type, 'd1_assumption')
})

test('fires on "is my client" marker', () => {
  const u = freshUser('d1-b')
  checkAssumptionCorrectionTrigger(u, 's1', "John is my client, not a cold lead")
  assert.equal(hasPendingQuestion(u), true)
})

test('fires on "he\'s my" marker', () => {
  const u = freshUser('d1-c')
  checkAssumptionCorrectionTrigger(u, 's1', "he's my boss, I need a different tone")
  assert.equal(hasPendingQuestion(u), true)
})

test('does NOT fire on routine correction with no factual markers', () => {
  const u = freshUser('d1-d')
  checkAssumptionCorrectionTrigger(u, 's1', "can you change the tone to be more formal please")
  assert.equal(hasPendingQuestion(u), false)
})

test('does NOT fire on new-task message', () => {
  const u = freshUser('d1-e')
  checkAssumptionCorrectionTrigger(u, 's1', "write me an email to sarah at acme corp")
  assert.equal(hasPendingQuestion(u), false)
})

test('extracts multi-word entity name (e.g. "John Smith")', () => {
  const u = freshUser('d1-f')
  checkAssumptionCorrectionTrigger(u, 's1', "Actually we've met — John Smith is my co-founder")
  const row = latestPending(u)
  assert.equal(row?.entity_name, 'John Smith')
})

test('generates entity-specific question when entity found', () => {
  const u = freshUser('d1-g')
  // "we've met" marker fires; "Sarah" is extracted (skips "Actually" in IGNORE set)
  checkAssumptionCorrectionTrigger(u, 's1', "Actually we've met — Sarah is my investor")
  const row = latestPending(u)
  assert.ok(row?.question_text.includes('Sarah'), `Expected question to mention Sarah, got: ${row?.question_text}`)
})

test('generates generic question when no entity found', () => {
  const u = freshUser('d1-h')
  checkAssumptionCorrectionTrigger(u, 's1', "actually we've met before, keep that in mind")
  const row = latestPending(u)
  assert.ok(row?.question_text.includes('context'), `Expected generic context question, got: ${row?.question_text}`)
})

test('respects 7-day cooldown (existing pending within 7 days blocks)', () => {
  const u = freshUser('d1-i')
  checkAssumptionCorrectionTrigger(u, 's1', "Actually we've met — Tom is my advisor")
  assert.equal(pendingCount(u), 1)
  // Mark first as answered to reset hasPendingQuestion, but cooldown still active
  db.prepare("UPDATE channel_d_pending SET status = 'answered' WHERE user_id = ?").run(u)
  checkAssumptionCorrectionTrigger(u, 's2', "Actually we've met — another person too")
  assert.equal(pendingCount(u), 1, 'Should still be 1 (cooldown blocked second trigger)')
})

// ─── Section 2: D.2 — Pressure Check Trigger ─────────────────────────────────

console.log('\nD.2 — Pressure Check Trigger')

test('does NOT fire when no prior frustration signal in DB', () => {
  const u = freshUser('d2-a')
  checkPressureTrigger(u, 's1', "ugh this keeps failing")
  assert.equal(hasPendingQuestion(u), false)
})

test('fires when prior frustration signal exists in last 30 minutes', () => {
  const u = freshUser('d2-b')
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, task_id, message_text, message_length, word_count, task_type, frustration_detected, created_at)
    VALUES (randomblob(16), ?, null, 'test', 4, 1, 'write', 1, datetime('now', '-5 minutes'))`).run(u)
  checkPressureTrigger(u, 's1', "ugh still wrong, this is terrible")
  assert.equal(hasPendingQuestion(u), true)
  assert.equal(latestPending(u)?.trigger_type, 'd2_pressure')
  db.prepare("DELETE FROM channel_a_raw_signals WHERE user_id = ?").run(u)
})

test('does NOT fire if prior frustration was more than 30 minutes ago', () => {
  const u = freshUser('d2-c')
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, task_id, message_text, message_length, word_count, task_type, frustration_detected, created_at)
    VALUES (randomblob(16), ?, null, 'old', 3, 1, 'write', 1, datetime('now', '-45 minutes'))`).run(u)
  checkPressureTrigger(u, 's1', "ugh this is wrong again")
  assert.equal(hasPendingQuestion(u), false)
  db.prepare("DELETE FROM channel_a_raw_signals WHERE user_id = ?").run(u)
})

test('does NOT fire when message has no frustration marker', () => {
  const u = freshUser('d2-d')
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, task_id, message_text, message_length, word_count, task_type, frustration_detected, created_at)
    VALUES (randomblob(16), ?, null, 'test', 4, 1, 'write', 1, datetime('now', '-2 minutes'))`).run(u)
  checkPressureTrigger(u, 's1', "can you make this shorter please")
  assert.equal(hasPendingQuestion(u), false)
  db.prepare("DELETE FROM channel_a_raw_signals WHERE user_id = ?").run(u)
})

test('question asks about pressure', () => {
  const u = freshUser('d2-e')
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, task_id, message_text, message_length, word_count, task_type, frustration_detected, created_at)
    VALUES (randomblob(16), ?, null, 'test', 4, 1, 'write', 1, datetime('now', '-1 minutes'))`).run(u)
  checkPressureTrigger(u, 's1', "this is wrong ugh come on")
  const row = latestPending(u)
  assert.ok(row?.question_text.toLowerCase().includes('pressure'), `Question should ask about pressure: ${row?.question_text}`)
  db.prepare("DELETE FROM channel_a_raw_signals WHERE user_id = ?").run(u)
})

// ─── Section 3: D.3 — New Domain Debut Trigger ───────────────────────────────

console.log('\nD.3 — New Domain Debut Trigger')

test('does NOT fire when tribe word count < 2', () => {
  const u = freshUser('d3-a')
  checkNewDomainTrigger(u, null, 'founder', 1)
  assert.equal(hasPendingQuestion(u), false)
})

test('fires when tribe word count >= 2 and no prior history', () => {
  const u = freshUser('d3-b')
  checkNewDomainTrigger(u, null, 'founder', 2)
  assert.equal(hasPendingQuestion(u), true)
  assert.equal(latestPending(u)?.trigger_type, 'd3_domain')
  assert.equal(latestPending(u)?.entity_name, 'founder')
})

test('does NOT fire again for same tribe (permanent dedup)', () => {
  const u = freshUser('d3-c')
  checkNewDomainTrigger(u, null, 'sales', 3)
  assert.equal(pendingCount(u), 1)
  db.prepare("UPDATE channel_d_pending SET status = 'answered' WHERE user_id = ?").run(u)
  checkNewDomainTrigger(u, null, 'sales', 3)
  assert.equal(pendingCount(u), 1, 'Should not fire again for same tribe')
})

test('fires for a DIFFERENT tribe (each tribe is independent)', () => {
  const u = freshUser('d3-d')
  checkNewDomainTrigger(u, null, 'dev', 2)
  db.prepare("UPDATE channel_d_pending SET status = 'answered' WHERE user_id = ?").run(u)
  checkNewDomainTrigger(u, null, 'ai', 3)
  assert.equal(pendingCount(u), 2, 'Should fire for a new different tribe')
})

test('does NOT fire if tribe has 5+ prior signals in 60 days', () => {
  const u = freshUser('d3-e')
  for (let i = 0; i < 5; i++) {
    db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, task_id, message_text, message_length, word_count, task_type, tribe_word_hits, frustration_detected, created_at)
      VALUES (randomblob(16), ?, null, 'test', 4, 1, 'write', '{"vc":["Series A","term sheet"]}', 0, datetime('now', '-${i + 1} days'))`).run(u)
  }
  checkNewDomainTrigger(u, null, 'vc', 3)
  assert.equal(hasPendingQuestion(u), false, 'Tribe with 5+ prior signals should not be treated as debut')
  db.prepare("DELETE FROM channel_a_raw_signals WHERE user_id = ?").run(u)
})

test('question mentions the tribe label (not raw key)', () => {
  const u = freshUser('d3-f')
  checkNewDomainTrigger(u, null, 'founder', 2)
  const row = latestPending(u)
  assert.ok(row?.question_text.includes('startup building'), `Expected tribe label in question, got: ${row?.question_text}`)
})

// ─── Section 4: D.4 — Completion Follow-up Trigger ───────────────────────────

console.log('\nD.4 — Completion Follow-up Trigger')

test('fires when prompt contains urgency marker "asap"', () => {
  const u = freshUser('d4-a')
  checkCompletionFollowupTrigger(u, 'task1', 'Sent the email', 'send this to john asap')
  assert.equal(hasPendingQuestion(u), true)
  assert.equal(latestPending(u)?.trigger_type, 'd4_followup')
})

test('fires when prompt contains output marker "email to"', () => {
  const u = freshUser('d4-b')
  checkCompletionFollowupTrigger(u, 'task1', 'Composed the message', 'email to the client about the contract')
  assert.equal(hasPendingQuestion(u), true)
})

test('does NOT fire for routine tasks without urgency or output markers', () => {
  const u = freshUser('d4-c')
  checkCompletionFollowupTrigger(u, 'task1', 'Summarized the document', 'summarize this for me')
  assert.equal(hasPendingQuestion(u), false)
})

test('does NOT fire twice for the same task (session dedup)', () => {
  const u = freshUser('d4-d')
  checkCompletionFollowupTrigger(u, 'task1', 'Done', 'send this asap')
  assert.equal(pendingCount(u), 1)
  db.prepare("UPDATE channel_d_pending SET status = 'answered' WHERE user_id = ?").run(u)
  checkCompletionFollowupTrigger(u, 'task1', 'Done again', 'send this asap')
  assert.equal(pendingCount(u), 1)
})

test('queued D.4 has earliest_ask_at ~2 hours from now', () => {
  const u = freshUser('d4-e')
  const before = Date.now()
  checkCompletionFollowupTrigger(u, 'task1', 'Task complete', 'submit the application today')
  const row = latestPending(u)
  assert.ok(row?.earliest_ask_at, 'Should have earliest_ask_at set')
  // The stored value is a UTC ISO string (from .toISOString()). Parse explicitly as UTC.
  const askAt = new Date(row!.earliest_ask_at.replace(' ', 'T') + 'Z').getTime()
  const expectedMin = before + 90 * 60 * 1000   // 90 min from now (allowing test slack)
  const expectedMax = before + 150 * 60 * 1000  // 150 min from now
  assert.ok(askAt >= expectedMin && askAt <= expectedMax, `earliest_ask_at ${row!.earliest_ask_at} not in expected range`)
})

test('D.4 question contains task summary', () => {
  const u = freshUser('d4-f')
  checkCompletionFollowupTrigger(u, 'task1', 'Send the proposal to Acme Corp today', 'send to acme today')
  const row = latestPending(u)
  assert.ok(row?.question_text.includes('Send the proposal'), `Expected summary in question, got: ${row?.question_text}`)
})

test('D.4 not ready before earliest_ask_at (context block withholds directive)', () => {
  const u = freshUser('d4-g')
  checkCompletionFollowupTrigger(u, 'task1', 'Done', 'send to client asap')
  // earliest_ask_at is 2h from now — context block should NOT inject it yet
  const block = buildChannelDContextBlock(u, 'sess1')
  assert.ok(!block.includes('FOLLOW-UP QUESTION'), 'D.4 directive should not appear before delay')
})

// ─── Section 5: Priority and Supersede ───────────────────────────────────────

console.log('\nPriority + Supersede')

test('D.1 supersedes D.4 (higher priority)', () => {
  const u = freshUser('pri-a')
  checkCompletionFollowupTrigger(u, 'task1', 'Done', 'send to client asap')
  assert.equal(latestPending(u)?.trigger_type, 'd4_followup')
  checkAssumptionCorrectionTrigger(u, 's1', "Actually we've met before — Lisa is my co-founder")
  const rows = db.prepare("SELECT trigger_type, status FROM channel_d_pending WHERE user_id = ?").all(u) as any[]
  const d4 = rows.find(r => r.trigger_type === 'd4_followup')
  const d1 = rows.find(r => r.trigger_type === 'd1_assumption')
  assert.equal(d4?.status, 'superseded')
  assert.equal(d1?.status, 'pending')
})

test('D.2 supersedes D.4 but NOT D.1', () => {
  const u = freshUser('pri-b')
  // First put D.4 in pending
  checkCompletionFollowupTrigger(u, 'task1', 'Done', 'send asap')
  assert.equal(latestPending(u)?.trigger_type, 'd4_followup')
  // D.2 fires — should supersede D.4
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, task_id, message_text, message_length, word_count, task_type, frustration_detected, created_at)
    VALUES (randomblob(16), ?, null, 'test', 4, 1, 'write', 1, datetime('now', '-2 minutes'))`).run(u)
  checkPressureTrigger(u, 's1', "ugh this keeps failing come on")
  const rows = db.prepare("SELECT trigger_type, status FROM channel_d_pending WHERE user_id = ?").all(u) as any[]
  assert.equal(rows.find(r => r.trigger_type === 'd4_followup')?.status, 'superseded')
  assert.equal(rows.find(r => r.trigger_type === 'd2_pressure')?.status, 'pending')
  db.prepare("DELETE FROM channel_a_raw_signals WHERE user_id = ?").run(u)
})

test('D.3 does NOT supersede existing D.1 (lower priority)', () => {
  const u = freshUser('pri-c')
  checkAssumptionCorrectionTrigger(u, 's1', "Actually he's my boss not a client")
  assert.equal(latestPending(u)?.trigger_type, 'd1_assumption')
  checkNewDomainTrigger(u, null, 'founder', 3)
  // D.3 should be blocked — D.1 is higher priority
  const rows = db.prepare("SELECT trigger_type, status FROM channel_d_pending WHERE user_id = ?").all(u) as any[]
  assert.equal(rows.length, 1, 'Should still be only 1 pending row (D.3 blocked)')
  assert.equal(rows[0].trigger_type, 'd1_assumption')
})

test('hasPendingQuestion: true when pending or asked', () => {
  const u = freshUser('hpq-a')
  assert.equal(hasPendingQuestion(u), false)
  checkAssumptionCorrectionTrigger(u, 's1', "Actually we've met — Tom is my contact")
  assert.equal(hasPendingQuestion(u), true)
  db.prepare("UPDATE channel_d_pending SET status = 'asked' WHERE user_id = ?").run(u)
  assert.equal(hasPendingQuestion(u), true)
  db.prepare("UPDATE channel_d_pending SET status = 'answered' WHERE user_id = ?").run(u)
  assert.equal(hasPendingQuestion(u), false)
})

// ─── Section 6: Answer Extractor ─────────────────────────────────────────────

console.log('\nAnswer Extractor')

test('D.1: extracts raw correction as fact with entity', () => {
  const u = freshUser('ae-d1')
  // "we've met" marker fires; "Tom Baker" is multi-word entity → entity extracted
  checkAssumptionCorrectionTrigger(u, 's1', "Actually we've met — Tom Baker is my co-founder")
  markPendingAsked(u)
  extractChannelDAnswer(u, 's1', "Yes Tom Baker is my co-founder, we've been building together since 2022")
  const extr = latestExtraction(u)
  assert.equal(extr?.trigger_type, 'd1_assumption')
  assert.ok(extr?.extracted_fact?.includes('Tom Baker'), `Expected Tom Baker in fact, got: ${extr?.extracted_fact}`)
  assert.equal(latestPending(u)?.status, 'answered')
})

test('D.2: "yes" → confirmed high-pressure', () => {
  const u = freshUser('ae-d2-yes')
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, task_id, message_text, message_length, word_count, task_type, frustration_detected, created_at)
    VALUES (randomblob(16), ?, null, 'test', 4, 1, 'write', 1, datetime('now', '-2 minutes'))`).run(u)
  checkPressureTrigger(u, 's1', "ugh this is still broken")
  markPendingAsked(u)
  extractChannelDAnswer(u, 's1', "yeah definitely, I have a big deadline")
  const extr = latestExtraction(u)
  assert.ok(extr?.extracted_fact?.includes('high-pressure'))
  db.prepare("DELETE FROM channel_a_raw_signals WHERE user_id = ?").run(u)
})

test('D.2: "no" → denied pressure (no mode switch)', () => {
  const u = freshUser('ae-d2-no')
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, task_id, message_text, message_length, word_count, task_type, frustration_detected, created_at)
    VALUES (randomblob(16), ?, null, 'test', 4, 1, 'write', 1, datetime('now', '-2 minutes'))`).run(u)
  checkPressureTrigger(u, 's1', "this keeps failing ugh")
  markPendingAsked(u)
  extractChannelDAnswer(u, 's1', "not really, I'm fine")
  const extr = latestExtraction(u)
  assert.ok(extr?.extracted_fact?.includes('denied'), `Expected denied in fact, got: ${extr?.extracted_fact}`)
  db.prepare("DELETE FROM channel_a_raw_signals WHERE user_id = ?").run(u)
})

test('D.3: "yes active" → actively working on domain', () => {
  const u = freshUser('ae-d3-active')
  checkNewDomainTrigger(u, null, 'founder', 3)
  markPendingAsked(u)
  extractChannelDAnswer(u, 's1', "Yes I'm actively building this full time since January")
  const extr = latestExtraction(u)
  assert.ok(extr?.extracted_fact?.includes('actively working'))
  assert.ok(extr?.expires_at, 'D.3 should have expiry set')
})

test('D.3: "exploring" → not active focus', () => {
  const u = freshUser('ae-d3-exp')
  checkNewDomainTrigger(u, null, 'sales', 2)
  markPendingAsked(u)
  // "my focus" removed from DOMAIN_ACTIVE so this is detected as exploring
  extractChannelDAnswer(u, 's1', "just exploring, not sure if it's my focus")
  const extr = latestExtraction(u)
  assert.ok(extr?.extracted_fact?.includes('exploring'), `Expected exploring in fact, got: ${extr?.extracted_fact}`)
})

test('D.4: positive sentiment → "positive" in extracted fact', () => {
  const u = freshUser('ae-d4-pos')
  // Set earliest_ask_at to past so context builder can ask it
  db.prepare(`INSERT INTO channel_d_pending (id, user_id, session_id, trigger_type, question_text, entity_name, earliest_ask_at, status, created_at)
    VALUES (randomblob(16), ?, 'task1', 'd4_followup', 'How did it go?', 'the proposal', datetime('now', '-3 hours'), 'asked', datetime('now', '-3 hours'))`).run(u)
  extractChannelDAnswer(u, 'task1', "went great, they said yes and we're moving forward")
  const extr = latestExtraction(u)
  assert.equal(extr?.trigger_type, 'd4_followup')
  assert.equal(extr?.sentiment, 'positive')
  assert.ok(extr?.extracted_fact?.includes('positive'))
})

test('D.4: negative sentiment → "negative" in extracted fact', () => {
  const u = freshUser('ae-d4-neg')
  db.prepare(`INSERT INTO channel_d_pending (id, user_id, session_id, trigger_type, question_text, entity_name, earliest_ask_at, status, created_at)
    VALUES (randomblob(16), ?, 'task1', 'd4_followup', 'How did it go?', 'the pitch', datetime('now', '-3 hours'), 'asked', datetime('now', '-3 hours'))`).run(u)
  extractChannelDAnswer(u, 'task1', "bad, they rejected it, no response")
  const extr = latestExtraction(u)
  assert.equal(extr?.sentiment, 'negative')
})

test('D.4: neutral sentiment when unclear', () => {
  const u = freshUser('ae-d4-neu')
  db.prepare(`INSERT INTO channel_d_pending (id, user_id, session_id, trigger_type, question_text, entity_name, earliest_ask_at, status, created_at)
    VALUES (randomblob(16), ?, 'task1', 'd4_followup', 'How did it go?', 'the meeting', datetime('now', '-3 hours'), 'asked', datetime('now', '-3 hours'))`).run(u)
  extractChannelDAnswer(u, 'task1', "it happened, we discussed a few things")
  const extr = latestExtraction(u)
  assert.equal(extr?.sentiment, 'neutral')
})

test('marks as IGNORED when message starts with new-task verb', () => {
  const u = freshUser('ae-ign')
  checkAssumptionCorrectionTrigger(u, 's1', "Actually he's my boss not a client")
  markPendingAsked(u)
  extractChannelDAnswer(u, 's1', "Write an email to him about the project timeline")
  assert.equal(latestPending(u)?.status, 'ignored')
  assert.equal(latestExtraction(u), undefined, 'No extraction should be created for ignored answer')
})

test('marks as EXPIRED when question is older than 48 hours', () => {
  const u = freshUser('ae-exp')
  db.prepare(`INSERT INTO channel_d_pending (id, user_id, session_id, trigger_type, question_text, status, asked_at, created_at)
    VALUES (randomblob(16), ?, 's1', 'd1_assumption', 'How are they related?', 'asked', datetime('now', '-49 hours'), datetime('now', '-49 hours'))`).run(u)
  extractChannelDAnswer(u, 's1', "they are my co-founder")
  assert.equal(latestPending(u)?.status, 'expired')
  assert.equal(latestExtraction(u), undefined, 'No extraction for expired question')
})

test('no-op when no asked question exists', () => {
  const u = freshUser('ae-noop')
  extractChannelDAnswer(u, 's1', "some message here")
  assert.equal(pendingCount(u), 0)
})

// ─── Section 7: Context Builder ───────────────────────────────────────────────

console.log('\nContext Builder')

test('empty block when no extractions and no pending', () => {
  const u = freshUser('cb-empty')
  assert.equal(buildChannelDContextBlock(u, 'sess1'), '')
})

test('injects FOLLOW-UP QUESTION directive when pending question is ready', () => {
  const u = freshUser('cb-q')
  // Direct insert: isolates context builder from trigger detection logic
  db.prepare(`INSERT INTO channel_d_pending (id, user_id, session_id, trigger_type, question_text, status, created_at)
    VALUES (randomblob(16), ?, 's1', 'd1_assumption', 'For Alice, established or more formal relationship?', 'pending', datetime('now'))`).run(u)
  const block = buildChannelDContextBlock(u, 's1')
  assert.ok(block.includes('FOLLOW-UP QUESTION'), `Missing FOLLOW-UP QUESTION in block: "${block}"`)
  assert.ok(block.includes('Alice'), `Missing Alice in block: "${block}"`)
})

test('marks pending as "asked" after injecting directive', () => {
  const u = freshUser('cb-asked')
  checkAssumptionCorrectionTrigger(u, 's1', "Actually he's my advisor")
  buildChannelDContextBlock(u, 's1')
  assert.equal(latestPending(u)?.status, 'asked')
})

test('does NOT re-inject directive on second call (already asked)', () => {
  const u = freshUser('cb-nore')
  checkAssumptionCorrectionTrigger(u, 's1', "Actually we've met — Bob is my partner")
  buildChannelDContextBlock(u, 's1')  // first call — marks asked
  const secondBlock = buildChannelDContextBlock(u, 's1')  // second call
  assert.ok(!secondBlock.includes('FOLLOW-UP QUESTION'))
})

test('D.1 extraction appears in Known Context block', () => {
  const u = freshUser('cb-d1')
  db.prepare(`INSERT INTO channel_d_extractions (id, user_id, session_id, pending_id, trigger_type, question_text, answer_text, extracted_fact, entity_name, answer_confidence, is_active, created_at)
    VALUES (randomblob(16), ?, 's1', 'test-pending', 'd1_assumption', 'q', 'answer', 'For Carol: treat as established colleague', 'Carol', 'high', 1, datetime('now'))`).run(u)
  const block = buildChannelDContextBlock(u, 's1')
  assert.ok(block.includes('Known Context'))
  assert.ok(block.includes('Carol'))
  assert.ok(block.includes('Relationship context'))
})

test('D.2 pressure mode appears ONLY for matching session_id', () => {
  const u = freshUser('cb-d2')
  db.prepare(`INSERT INTO channel_d_extractions (id, user_id, session_id, pending_id, trigger_type, question_text, answer_text, extracted_fact, answer_confidence, is_active, created_at)
    VALUES (randomblob(16), ?, 'session-A', 'test-pending', 'd2_pressure', 'q', 'yes', 'User confirmed high-pressure mode — keep responses brief, decisive, limit options to one recommendation', 'medium', 1, datetime('now'))`).run(u)
  // Same session: pressure mode should appear
  const blockSameSession = buildChannelDContextBlock(u, 'session-A')
  assert.ok(blockSameSession.includes('high-pressure'), 'Pressure mode should appear for same session')
  // Different session: pressure mode should NOT appear
  const blockOtherSession = buildChannelDContextBlock(u, 'session-B')
  assert.ok(!blockOtherSession.includes('high-pressure'), 'Pressure mode should NOT appear for different session')
})

test('D.3 domain focus appears in context with age note', () => {
  const u = freshUser('cb-d3')
  db.prepare(`INSERT INTO channel_d_extractions (id, user_id, session_id, pending_id, trigger_type, question_text, answer_text, extracted_fact, entity_name, answer_confidence, is_active, created_at)
    VALUES (randomblob(16), ?, 's1', 'test-pending', 'd3_domain', 'q', 'yes active', 'User is actively working on sales and GTM', 'sales', 'medium', 1, datetime('now'))`).run(u)
  const block = buildChannelDContextBlock(u, 's1')
  assert.ok(block.includes('Domain focus'))
  assert.ok(block.includes('sales and GTM'))
  assert.ok(block.includes('confirmed today'))
})

test('D.4 extraction does NOT appear in context (historical only)', () => {
  const u = freshUser('cb-d4')
  db.prepare(`INSERT INTO channel_d_extractions (id, user_id, session_id, pending_id, trigger_type, question_text, answer_text, extracted_fact, sentiment, answer_confidence, is_active, created_at)
    VALUES (randomblob(16), ?, 's1', 'test-pending', 'd4_followup', 'q', 'great', 'Task "send email" outcome: positive', 'positive', 'medium', 1, datetime('now'))`).run(u)
  const block = buildChannelDContextBlock(u, 's1')
  // D.4 should NOT appear in context injection (it's historical record only)
  assert.ok(!block.includes('outcome'), `D.4 outcome should not appear in context block: ${block}`)
})

test('pending D.4 with future earliest_ask_at does NOT inject directive', () => {
  const u = freshUser('cb-d4-delay')
  db.prepare(`INSERT INTO channel_d_pending (id, user_id, session_id, trigger_type, question_text, entity_name, earliest_ask_at, status, created_at)
    VALUES (randomblob(16), ?, 'task1', 'd4_followup', 'How did it go?', 'the task', datetime('now', '+2 hours'), 'pending', datetime('now'))`).run(u)
  const block = buildChannelDContextBlock(u, 'task1')
  assert.ok(!block.includes('FOLLOW-UP QUESTION'), 'D.4 directive should not appear before earliest_ask_at')
})

test('expired extractions do NOT appear in context', () => {
  const u = freshUser('cb-expired')
  db.prepare(`INSERT INTO channel_d_extractions (id, user_id, session_id, pending_id, trigger_type, question_text, answer_text, extracted_fact, answer_confidence, is_active, expires_at, created_at)
    VALUES (randomblob(16), ?, 's1', 'test-pending', 'd3_domain', 'q', 'yes active', 'User is actively working on vc', 'medium', 1, datetime('now', '-1 day'), datetime('now', '-91 days'))`).run(u)
  const block = buildChannelDContextBlock(u, 's1')
  assert.ok(!block.includes('vc'), 'Expired D.3 extraction should not appear in context')
})

// ─── Section 8: Debug Report ──────────────────────────────────────────────────

console.log('\nDebug Report')

test('debug report contains all 4 sections', () => {
  const u = freshUser('dr-a')
  checkAssumptionCorrectionTrigger(u, 's1', "Actually he's my advisor")
  const report = buildDebugReport(u, 's1')
  assert.ok(report.includes('PENDING QUESTIONS'))
  assert.ok(report.includes('EXTRACTIONS'))
  assert.ok(report.includes('CONTEXT BLOCK'))
  assert.ok(report.includes('STATS'))
})

test('debug report shows pending trigger type', () => {
  const u = freshUser('dr-b')
  checkCompletionFollowupTrigger(u, 'task1', 'Task done', 'send to client asap')
  const report = buildDebugReport(u, 'task1')
  assert.ok(report.includes('d4_followup'))
})

test('debug report shows extraction after answer', () => {
  const u = freshUser('dr-c')
  checkNewDomainTrigger(u, null, 'ai', 3)
  markPendingAsked(u)
  extractChannelDAnswer(u, 's1', "yes I'm actively building AI agents")
  const report = buildDebugReport(u, 's1')
  assert.ok(report.includes('d3_domain'))
  assert.ok(report.includes('actively working'))
})

// ─── Full Round-trips ─────────────────────────────────────────────────────────

console.log('\nFull Round-trips')

await runAsync('D.1 full round-trip: trigger → ask → answer → context shows fact', async () => {
  const u = freshUser('rt-d1')
  // Trigger — "Emma Chen" is multi-word, extracted directly by extractEntity
  checkAssumptionCorrectionTrigger(u, 'sess1', "Actually we've met — Emma Chen is my co-investor")
  assert.equal(hasPendingQuestion(u), true)
  // Context block injects directive and marks as asked
  const block1 = buildChannelDContextBlock(u, 'sess1')
  assert.ok(block1.includes('FOLLOW-UP QUESTION'), `block1 missing FOLLOW-UP QUESTION: "${block1}"`)
  assert.equal(latestPending(u)?.status, 'asked')
  // User answers
  extractChannelDAnswer(u, 'sess1', "Emma Chen is my co-investor at Fund XYZ, treat her as a trusted partner")
  assert.equal(latestPending(u)?.status, 'answered')
  assert.ok(latestExtraction(u)?.extracted_fact?.includes('Emma Chen'))
  // Next context block shows the fact
  const block2 = buildChannelDContextBlock(u, 'sess1')
  assert.ok(block2.includes('Known Context'))
  assert.ok(block2.includes('Emma Chen'))
  assert.ok(!block2.includes('FOLLOW-UP QUESTION'), 'No new question in this turn')
})

await runAsync('D.3 full round-trip: debut tribe → ask → answer → domain in context', async () => {
  const u = freshUser('rt-d3')
  // Trigger from "new tribe"
  checkNewDomainTrigger(u, null, 'content', 4)
  // Verify pending was created before calling context builder
  const pendingRow = db.prepare("SELECT * FROM channel_d_pending WHERE user_id=? AND status='pending'").get(u) as any
  assert.ok(pendingRow, `D.3 pending row missing after trigger for user: ${u}`)
  const block1 = buildChannelDContextBlock(u, 'sess1')
  assert.ok(block1.includes('content creation'), `block1 missing 'content creation': "${block1.slice(0, 200)}"`)
  // Context builder marked it as 'asked'
  assert.equal(latestPending(u)?.status, 'asked')
  extractChannelDAnswer(u, 'sess1', "yes I'm actively creating content, it's my main channel")
  const block2 = buildChannelDContextBlock(u, 'sess1')
  assert.ok(block2.includes('Domain focus'), `block2 missing 'Domain focus': "${block2.slice(0, 200)}"`)
  // Extracted fact stores entity_name key ('content'), not the label ('content creation')
  assert.ok(block2.includes('content'), `block2 missing 'content': "${block2.slice(0, 200)}"`)
})

await runAsync('D.2 full round-trip: frustration → ask → answer → pressure in context (session-scoped)', async () => {
  const u = freshUser('rt-d2')
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, task_id, message_text, message_length, word_count, task_type, frustration_detected, created_at)
    VALUES (randomblob(16), ?, null, 'test', 4, 1, 'write', 1, datetime('now', '-3 minutes'))`).run(u)
  checkPressureTrigger(u, 'session-X', "ugh still wrong come on")
  buildChannelDContextBlock(u, 'session-X')  // marks asked
  extractChannelDAnswer(u, 'session-X', "yeah definitely under a lot of pressure today")
  // Pressure appears in same session
  const blockSame = buildChannelDContextBlock(u, 'session-X')
  assert.ok(blockSame.includes('high-pressure'))
  // Pressure does NOT appear in new session
  const blockNew = buildChannelDContextBlock(u, 'session-NEW')
  assert.ok(!blockNew.includes('high-pressure'), 'Pressure should not carry across sessions')
  db.prepare("DELETE FROM channel_a_raw_signals WHERE user_id = ?").run(u)
})

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail > 0 ? 1 : 0)
