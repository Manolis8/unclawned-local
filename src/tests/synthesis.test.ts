import assert from 'node:assert/strict'
import { db } from '../lib/db.js'
import { checkFocusConvergence } from '../lib/synthesis/s1-focus-convergence.js'
import { checkStressComposite } from '../lib/synthesis/s2-stress-composite.js'
import { getHighImportanceRelationships } from '../lib/synthesis/s3-relationship-weight.js'
import { checkGoalReality } from '../lib/synthesis/s4-goal-reality-check.js'
import { findAutomationOpportunity } from '../lib/synthesis/s5-automation-detector.js'
import { buildSynthesisContextBlock } from '../lib/synthesis/context-builder.js'

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

const U = 'syn-test-' + Date.now()

function clean(u: string) {
  db.prepare(`DELETE FROM channel_a_profiles WHERE user_id = ?`).run(u)
  db.prepare(`DELETE FROM channel_a_raw_signals WHERE user_id = ?`).run(u)
  db.prepare(`DELETE FROM channel_m_profiles WHERE user_id = ?`).run(u)
  db.prepare(`DELETE FROM channel_g_task_snapshots WHERE user_id = ?`).run(u)
  db.prepare(`DELETE FROM channel_o_profiles WHERE user_id = ?`).run(u)
  db.prepare(`DELETE FROM channel_f_relationship_profiles WHERE user_id = ?`).run(u)
  db.prepare(`DELETE FROM channel_k_signals WHERE user_id = ?`).run(u)
  db.prepare(`DELETE FROM channel_k_profiles WHERE user_id = ?`).run(u)
  db.prepare(`DELETE FROM channel_b_raw_signals WHERE user_id = ?`).run(u)
  db.prepare(`DELETE FROM channel_l_signals WHERE user_id = ?`).run(u)
  db.prepare(`DELETE FROM channel_n_watchlist WHERE user_id = ?`).run(u)
  db.prepare(`DELETE FROM synthesis_state WHERE user_id = ?`).run(u)
}

function setTribe(u: string, tribe: string) {
  db.prepare(`
    INSERT OR REPLACE INTO channel_a_profiles (user_id, vocabulary_tribe)
    VALUES (?, json_object('primary_tribe', ?, 'secondary_tribe', null, 'tribe_scores', json_object(), 'tribe_word_hits', json_object()))
  `).run(u, tribe)
}

function setDrift(u: string, drift: string) {
  db.prepare(`INSERT OR REPLACE INTO channel_m_profiles (user_id, drift_direction, total_distinct_words) VALUES (?, ?, 20)`).run(u, drift)
}

function addGTask(u: string, category: string, opts: { urgency?: number; lateNight?: number; daysAgo?: number } = {}) {
  db.prepare(`
    INSERT INTO channel_g_task_snapshots (id, user_id, hour_of_day, day_of_week, day_of_month, month_of_year,
      task_category, has_urgency, is_late_night, created_at)
    VALUES (lower(hex(randomblob(8))), ?, 10, 1, 1, 1, ?, ?, ?, datetime('now', ? || ' days'))
  `).run(u, category, opts.urgency ?? 0, opts.lateNight ?? 0, -(opts.daysAgo ?? 0))
}

function addKSignal(u: string, type: string, value: string) {
  db.prepare(`
    INSERT INTO channel_k_signals (id, user_id, signal_type, value, message_length, created_at)
    VALUES (lower(hex(randomblob(8))), ?, ?, ?, 50, datetime('now'))
  `).run(u, type, value)
}

function addBSignal(u: string, opts: { isCorrection?: number; correctionLevel?: number; priorTaskType?: string }) {
  db.prepare(`
    INSERT INTO channel_b_raw_signals (id, user_id, user_message_text, user_message_length, is_correction, correction_level, prior_task_type, created_at)
    VALUES (lower(hex(randomblob(8))), ?, 'test', 30, ?, ?, ?, datetime('now'))
  `).run(u, opts.isCorrection ?? 0, opts.correctionLevel ?? null, opts.priorTaskType ?? 'write')
}

function addLSignal(u: string, type: string, subtype: string) {
  db.prepare(`
    INSERT INTO channel_l_signals (id, user_id, signal_type, subtype, created_at)
    VALUES (randomblob(16), ?, ?, ?, datetime('now'))
  `).run(u, type, subtype)
}

function addFRelationship(u: string, name: string, opts: {
  mentionCount?: number; trajectory?: string; isBridge?: number;
  register?: string; firstSeen?: string; lastSeen?: string
} = {}) {
  db.prepare(`
    INSERT OR REPLACE INTO channel_f_relationship_profiles
      (id, user_id, person_name, mention_count, trajectory, is_bridge, communication_register,
       first_seen, last_seen)
    VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(u, name, opts.mentionCount ?? 5, opts.trajectory ?? 'stable', opts.isBridge ?? 0,
    opts.register ?? null, opts.firstSeen ?? datetime('-7 days'), opts.lastSeen ?? datetime('-1 days'))
}

function datetime(offset = '') {
  // SQLite-compatible datetime string with offset
  const d = new Date()
  const match = offset.match(/([+-])(\d+) days/)
  if (match) {
    d.setDate(d.getDate() + parseInt(match[1] + match[2]))
  }
  return d.toISOString().slice(0, 19)
}

// ─── S1: Focus Convergence ────────────────────────────────────────────────────

console.log('\n── S1: Focus Convergence ────────────────────────────────────────────')

test('fc-a: tribe=dev + drift=technical + dominant task=code → technical convergence', () => {
  const u = U + '-fc-a'
  clean(u)
  setTribe(u, 'dev')
  setDrift(u, 'technical')
  addGTask(u, 'code')
  addGTask(u, 'code')
  addGTask(u, 'code')
  const result = checkFocusConvergence(u)
  assert.ok(result, 'should detect convergence')
  assert.equal(result!.area, 'technical')
  assert.ok(result!.confirmedBy.length >= 3)
})

test('fc-b: tribe=vc + drift=financial only 2 votes → no convergence (need 3)', () => {
  const u = U + '-fc-b'
  clean(u)
  setTribe(u, 'vc')
  setDrift(u, 'financial')
  const result = checkFocusConvergence(u)
  assert.equal(result, null, 'only 2 channels — should not converge')
})

test('fc-c: tribe=founder + drift=business + task=plan → business convergence', () => {
  const u = U + '-fc-c'
  clean(u)
  setTribe(u, 'founder')
  setDrift(u, 'business')
  addGTask(u, 'plan'); addGTask(u, 'plan'); addGTask(u, 'plan')
  const result = checkFocusConvergence(u)
  assert.ok(result)
  assert.equal(result!.area, 'business')
})

test('fc-d: tribe=vc + drift=financial + achievement=raised → financial convergence', () => {
  const u = U + '-fc-d'
  clean(u)
  setTribe(u, 'vc')
  setDrift(u, 'financial')
  db.prepare(`INSERT OR REPLACE INTO channel_o_profiles (user_id, total_achievements, dominant_achievement_type) VALUES (?, 5, 'raised')`).run(u)
  const result = checkFocusConvergence(u)
  assert.ok(result)
  assert.equal(result!.area, 'financial')
})

test('fc-e: no profiles → null', () => {
  const u = U + '-fc-e'
  clean(u)
  assert.equal(checkFocusConvergence(u), null)
})

// ─── S2: Stress State Composite ───────────────────────────────────────────────

console.log('\n── S2: Stress State Composite ───────────────────────────────────────')

test('sc-a: K-overload + K-energy + A-frustration + G-night = 4 → moderate', () => {
  const u = U + '-sc-a'
  clean(u)
  addKSignal(u, 'overload', 'frustrated_simple_request')
  addKSignal(u, 'overload', 'short_vs_baseline')
  db.prepare(`INSERT OR REPLACE INTO channel_k_profiles (user_id, total_messages, energy_state, confidence_level) VALUES (?, 10, 'depleted', 'normal')`).run(u)
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, message_text, message_length, word_count, task_type, frustration_detected, created_at) VALUES (lower(hex(randomblob(8))), ?, 'ugh', 3, 1, 'write', 1, datetime('now'))`).run(u)
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, message_text, message_length, word_count, task_type, frustration_detected, created_at) VALUES (lower(hex(randomblob(8))), ?, 'ugh again', 9, 2, 'write', 1, datetime('now'))`).run(u)
  addGTask(u, 'code', { lateNight: 1 })
  addGTask(u, 'code', { lateNight: 1 })
  const result = checkStressComposite(u)
  assert.ok(result, 'should detect composite stress')
  assert.ok(result!.score >= 4)
  assert.equal(result!.level, 'moderate')
})

test('sc-b: all 7 signals → score=7, level=high', () => {
  const u = U + '-sc-b'
  clean(u)
  // K-overload (2+ in 24h)
  addKSignal(u, 'overload', 'x'); addKSignal(u, 'overload', 'y')
  // K-energy
  db.prepare(`INSERT OR REPLACE INTO channel_k_profiles (user_id, total_messages, energy_state, confidence_level) VALUES (?, 10, 'low', 'normal')`).run(u)
  // A-frustration (2+ in 24h)
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, message_text, message_length, word_count, task_type, frustration_detected, created_at) VALUES (lower(hex(randomblob(8))), ?, 'x', 1, 1, 'write', 1, datetime('now'))`).run(u)
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, message_text, message_length, word_count, task_type, frustration_detected, created_at) VALUES (lower(hex(randomblob(8))), ?, 'y', 1, 1, 'write', 1, datetime('now'))`).run(u)
  // G-night (2+ in 3 days)
  addGTask(u, 'write', { lateNight: 1 }); addGTask(u, 'write', { lateNight: 1 })
  // G-urgency (3+ in 3 days)
  addGTask(u, 'plan', { urgency: 1 }); addGTask(u, 'plan', { urgency: 1 }); addGTask(u, 'plan', { urgency: 1 })
  // B-corrections (2+ level>=3 in last 5)
  addBSignal(u, { isCorrection: 1, correctionLevel: 4 })
  addBSignal(u, { isCorrection: 1, correctionLevel: 3 })
  // L-avoidance (2+ in 24h)
  addLSignal(u, 'avoidance', 'emotional')
  addLSignal(u, 'avoidance', 'priority')
  const result = checkStressComposite(u)
  assert.ok(result)
  assert.equal(result!.score, 7)
  assert.equal(result!.level, 'high')
})

test('sc-c: only 3 signals → null (below threshold of 4)', () => {
  const u = U + '-sc-c'
  clean(u)
  addKSignal(u, 'overload', 'x'); addKSignal(u, 'overload', 'y')
  db.prepare(`INSERT OR REPLACE INTO channel_k_profiles (user_id, total_messages, energy_state) VALUES (?, 10, 'depleted')`).run(u)
  addGTask(u, 'write', { lateNight: 1 }); addGTask(u, 'write', { lateNight: 1 })
  // That's K-overload + K-energy + G-night = 3 only
  const result = checkStressComposite(u)
  assert.equal(result, null, 'should be null at score=3')
})

test('sc-d: K-overload alone (only 1 signal) → null', () => {
  const u = U + '-sc-d'
  clean(u)
  addKSignal(u, 'overload', 'x'); addKSignal(u, 'overload', 'y')
  assert.equal(checkStressComposite(u), null)
})

test('sc-e: G-urgency + G-night + K-depleted + A-frustration = 4 → composite fires', () => {
  const u = U + '-sc-e'
  clean(u)
  addGTask(u, 'plan', { urgency: 1 }); addGTask(u, 'plan', { urgency: 1 }); addGTask(u, 'plan', { urgency: 1 })
  addGTask(u, 'write', { lateNight: 1 }); addGTask(u, 'write', { lateNight: 1 })
  db.prepare(`INSERT OR REPLACE INTO channel_k_profiles (user_id, total_messages, energy_state) VALUES (?, 10, 'depleted')`).run(u)
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, message_text, message_length, word_count, task_type, frustration_detected, created_at) VALUES (lower(hex(randomblob(8))), ?, 'x', 1, 1, 'write', 1, datetime('now'))`).run(u)
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, message_text, message_length, word_count, task_type, frustration_detected, created_at) VALUES (lower(hex(randomblob(8))), ?, 'y', 1, 1, 'write', 1, datetime('now'))`).run(u)
  const result = checkStressComposite(u)
  assert.ok(result)
  assert.ok(result!.score >= 4)
})

// ─── S3: Relationship Importance ──────────────────────────────────────────────

console.log('\n── S3: Relationship Importance ──────────────────────────────────────')

test('rw-a: 15 mentions + rising + bridge → importanceScore >= 5, included', () => {
  const u = U + '-rw-a'
  clean(u)
  addFRelationship(u, 'Alex', { mentionCount: 15, trajectory: 'rising', isBridge: 1, register: 'formal' })
  const result = getHighImportanceRelationships(u)
  assert.ok(result.length >= 1)
  assert.equal(result[0].name, 'Alex')
  assert.ok(result[0].importanceScore >= 5)
})

test('rw-b: 2 mentions → below threshold, not included', () => {
  const u = U + '-rw-b'
  clean(u)
  addFRelationship(u, 'Bob', { mentionCount: 2 })
  const result = getHighImportanceRelationships(u)
  assert.equal(result.length, 0)
})

test('rw-c: 10 mentions + watchlist entry + register → included', () => {
  const u = U + '-rw-c'
  clean(u)
  addFRelationship(u, 'Carol', { mentionCount: 10, register: 'casual' })
  db.prepare(`INSERT OR REPLACE INTO channel_n_watchlist (user_id, entity_name, entity_type, mentions_count) VALUES (?, 'Carol', 'person', 4)`).run(u)
  const result = getHighImportanceRelationships(u)
  assert.ok(result.length >= 1)
  const carol = result.find(r => r.name === 'Carol')
  assert.ok(carol, 'Carol should be included')
})

test('rw-d: empty relationship table → empty array', () => {
  const u = U + '-rw-d'
  clean(u)
  assert.deepEqual(getHighImportanceRelationships(u), [])
})

test('rw-e: multiple people → sorted by score, max 3 returned', () => {
  const u = U + '-rw-e'
  clean(u)
  addFRelationship(u, 'Alpha', { mentionCount: 15, trajectory: 'rising', isBridge: 1, register: 'formal' })
  addFRelationship(u, 'Beta', { mentionCount: 10, trajectory: 'rising', register: 'casual' })
  addFRelationship(u, 'Gamma', { mentionCount: 8, isBridge: 1, register: 'formal' })
  addFRelationship(u, 'Delta', { mentionCount: 20, trajectory: 'rising', isBridge: 1, register: 'casual' })
  const result = getHighImportanceRelationships(u)
  assert.ok(result.length <= 3, 'capped at 3')
  assert.ok(result[0].importanceScore >= result[result.length - 1].importanceScore, 'sorted desc')
})

// ─── S4: Goal Reality Check ───────────────────────────────────────────────────

console.log('\n── S4: Goal Reality Check ───────────────────────────────────────────')

test('gr-a: tribe=dev but 12 write tasks (relational dominant) → divergence', () => {
  const u = U + '-gr-a'
  clean(u)
  setTribe(u, 'dev')
  for (let i = 0; i < 12; i++) addGTask(u, 'write')
  for (let i = 0; i < 2; i++) addGTask(u, 'code')
  const result = checkGoalReality(u)
  assert.ok(result, 'should detect divergence')
  assert.equal(result!.statedFocus, 'technical')
  assert.equal(result!.actualFocus, 'relational')
  assert.ok(result!.actualPercentage >= 50)
})

test('gr-b: tribe=dev + dominant task=code → no divergence', () => {
  const u = U + '-gr-b'
  clean(u)
  setTribe(u, 'dev')
  for (let i = 0; i < 10; i++) addGTask(u, 'code')
  for (let i = 0; i < 2; i++) addGTask(u, 'write')
  assert.equal(checkGoalReality(u), null, 'no divergence when stated matches actual')
})

test('gr-c: no tribe data → null', () => {
  const u = U + '-gr-c'
  clean(u)
  for (let i = 0; i < 10; i++) addGTask(u, 'write')
  assert.equal(checkGoalReality(u), null)
})

test('gr-d: fewer than 10 tasks → null (insufficient data)', () => {
  const u = U + '-gr-d'
  clean(u)
  setTribe(u, 'dev')
  for (let i = 0; i < 5; i++) addGTask(u, 'write')
  assert.equal(checkGoalReality(u), null)
})

test('gr-e: tribe=founder + 60% write tasks → divergence (relational actual)', () => {
  const u = U + '-gr-e'
  clean(u)
  setTribe(u, 'founder')
  for (let i = 0; i < 12; i++) addGTask(u, 'write')
  for (let i = 0; i < 4; i++) addGTask(u, 'plan')
  const result = checkGoalReality(u)
  assert.ok(result)
  assert.equal(result!.statedFocus, 'business')
  assert.equal(result!.actualFocus, 'relational')
})

// ─── S5: Automation Detector ──────────────────────────────────────────────────

console.log('\n── S5: Automation Detector ──────────────────────────────────────────')

test('au-a: 5 write tasks + 0% correction → automation opportunity', () => {
  const u = U + '-au-a'
  clean(u)
  for (let i = 0; i < 5; i++) addGTask(u, 'write')
  // 4 channel B interactions, none corrections
  for (let i = 0; i < 4; i++) addBSignal(u, { isCorrection: 0, priorTaskType: 'write' })
  const result = findAutomationOpportunity(u)
  assert.ok(result, 'should find opportunity')
  assert.equal(result!.taskCategory, 'write')
  assert.ok(result!.correctionRate === 0)
})

test('au-b: only 2 write tasks → below threshold', () => {
  const u = U + '-au-b'
  clean(u)
  addGTask(u, 'write'); addGTask(u, 'write')
  assert.equal(findAutomationOpportunity(u), null)
})

test('au-c: 4 code tasks but 50% correction rate → skipped', () => {
  const u = U + '-au-c'
  clean(u)
  for (let i = 0; i < 4; i++) addGTask(u, 'code')
  for (let i = 0; i < 4; i++) addBSignal(u, { isCorrection: i < 2 ? 1 : 0, correctionLevel: 3, priorTaskType: 'code' })
  const result = findAutomationOpportunity(u)
  assert.equal(result, null, 'high correction rate should skip this category')
})

test('au-d: no tasks → null', () => {
  const u = U + '-au-d'
  clean(u)
  assert.equal(findAutomationOpportunity(u), null)
})

test('au-e: 3 research tasks + urgency + 0% correction → opportunity with urgency flag', () => {
  const u = U + '-au-e'
  clean(u)
  addGTask(u, 'research', { urgency: 1 })
  addGTask(u, 'research', { urgency: 1 })
  addGTask(u, 'research', { urgency: 1 })
  for (let i = 0; i < 4; i++) addBSignal(u, { isCorrection: 0, priorTaskType: 'research' })
  const result = findAutomationOpportunity(u)
  assert.ok(result)
  assert.ok(result!.hasUrgency, 'urgency flag should be set')
})

// ─── Context Builder ──────────────────────────────────────────────────────────

console.log('\n── Context Builder ──────────────────────────────────────────────────')

test('cb-a: no signals → null', () => {
  const u = U + '-cb-a'
  clean(u)
  assert.equal(buildSynthesisContextBlock(u), null)
})

test('cb-b: stress composite present → block includes stress instruction', () => {
  const u = U + '-cb-b'
  clean(u)
  addKSignal(u, 'overload', 'x'); addKSignal(u, 'overload', 'y')
  db.prepare(`INSERT OR REPLACE INTO channel_k_profiles (user_id, total_messages, energy_state) VALUES (?, 10, 'depleted')`).run(u)
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, message_text, message_length, word_count, task_type, frustration_detected, created_at) VALUES (lower(hex(randomblob(8))), ?, 'x', 1, 1, 'write', 1, datetime('now'))`).run(u)
  db.prepare(`INSERT INTO channel_a_raw_signals (id, user_id, message_text, message_length, word_count, task_type, frustration_detected, created_at) VALUES (lower(hex(randomblob(8))), ?, 'y', 1, 1, 'write', 1, datetime('now'))`).run(u)
  addGTask(u, 'write', { lateNight: 1 }); addGTask(u, 'write', { lateNight: 1 })
  addBSignal(u, { isCorrection: 1, correctionLevel: 4 })
  addBSignal(u, { isCorrection: 1, correctionLevel: 3 })
  const block = buildSynthesisContextBlock(u)
  assert.ok(block?.includes('PRESSURE') || block?.includes('pressure'), `expected stress block:\n${block}`)
  assert.ok(block?.includes('one answer') || block?.includes('One answer'), `expected decision instruction:\n${block}`)
})

test('cb-c: relationship exists → relationship block included', () => {
  const u = U + '-cb-c'
  clean(u)
  addFRelationship(u, 'Sarah', { mentionCount: 12, trajectory: 'rising', isBridge: 1, register: 'formal' })
  const block = buildSynthesisContextBlock(u)
  assert.ok(block?.includes('Sarah'), `expected Sarah in block:\n${block}`)
})

test('cb-d: S1 surfaced recently → S1 not re-surfaced in same 7-day window', () => {
  const u = U + '-cb-d'
  clean(u)
  setTribe(u, 'dev')
  setDrift(u, 'technical')
  addGTask(u, 'code'); addGTask(u, 'code'); addGTask(u, 'code')
  // Manually mark S1 as surfaced recently with same value
  db.prepare(`INSERT OR REPLACE INTO synthesis_state (user_id, synthesis_type, last_surfaced_at, last_value) VALUES (?, 's1', datetime('now', '-1 day'), 'technical')`).run(u)
  const block = buildSynthesisContextBlock(u)
  // S1 should NOT appear because it was recently surfaced with the same value
  const hasFocusConvergence = block?.includes('Focus convergence') ?? false
  assert.ok(!hasFocusConvergence, 'Focus convergence should not re-surface within 7-day window')
})

test('cb-e: automation opportunity surfaced → block mentions task type', () => {
  const u = U + '-cb-e'
  clean(u)
  for (let i = 0; i < 5; i++) addGTask(u, 'research')
  for (let i = 0; i < 4; i++) addBSignal(u, { isCorrection: 0, priorTaskType: 'research' })
  const block = buildSynthesisContextBlock(u)
  assert.ok(block?.includes('research') || block?.includes('Automation'), `expected automation block:\n${block}`)
})

// ─── Summary ──────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n── Results ───────────────────────────────────────────────────────`)
  console.log(`   ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 500)
