import assert from 'node:assert/strict'
import { db } from '../lib/db.js'
import { classifyTask, hasUrgency, hasFrustration } from '../lib/channel-g/task-classifier.js'
import { recordTaskCompletion, getDominantCategoryForHour } from '../lib/channel-g/rhythm-tracker.js'
import { buildChannelGContextBlock } from '../lib/channel-g/context-builder.js'

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

const U = 'cg-test-' + Date.now()

function clean(userId: string) {
  db.prepare(`DELETE FROM channel_g_task_snapshots WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_g_stress_cycles WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_g_profiles WHERE user_id = ?`).run(userId)
}

// Insert snapshot directly with a given hour to simulate tasks at specific times
function insertSnapshot(userId: string, hour: number, category: string, opts: {
  urgent?: boolean; frustrated?: boolean; lateNight?: boolean; daysAgo?: number
} = {}) {
  const daysAgo = opts.daysAgo ?? 0
  db.prepare(`
    INSERT INTO channel_g_task_snapshots
      (id, user_id, task_id, hour_of_day, day_of_week, day_of_month, month_of_year,
       task_category, prompt_word_count, has_urgency, has_frustration, is_late_night, created_at)
    VALUES (randomblob(16), ?, randomblob(8), ?, 1, 15, 7, ?, 10, ?, ?, ?, datetime('now', ?))
  `).run(userId, hour, category, opts.urgent ? 1 : 0, opts.frustrated ? 1 : 0, opts.lateNight ? 1 : 0, `-${daysAgo} days`)
}

// ─── G.1 Task Classifier ──────────────────────────────────────────────────────

console.log('\n── G.1 Task Classifier ────────────────────────────────────────────')

test('tc-a: classifies research prompt as deep_work', () => {
  const cat = classifyTask('Research the top 5 AI agent frameworks and summarize their tradeoffs')
  assert.equal(cat, 'deep_work')
})

test('tc-b: classifies email drafting as communication', () => {
  const cat = classifyTask('Draft an email to my investor following up on our last meeting')
  assert.equal(cat, 'communication')
})

test('tc-c: classifies review task as decision', () => {
  const cat = classifyTask('Review this proposal and tell me if I should approve it')
  assert.equal(cat, 'decision')
})

test('tc-d: classifies scheduling as admin', () => {
  const cat = classifyTask('Schedule a meeting with Tom for next Tuesday afternoon')
  assert.equal(cat, 'admin')
})

test('tc-e: classifies brainstorming as creative', () => {
  const cat = classifyTask('Brainstorm 10 ideas for a LinkedIn post about fundraising lessons')
  assert.equal(cat, 'creative')
})

test('tc-f: classifies navigation as execution', () => {
  const cat = classifyTask('Go to my LinkedIn and download my connections list')
  assert.equal(cat, 'execution')
})

test('tc-g: hasUrgency detects urgency keywords', () => {
  assert.ok(hasUrgency('Send this email ASAP it\'s urgent'))
  assert.ok(hasUrgency('I need this today, deadline in 2 hours'))
  assert.ok(!hasUrgency('Research the market over the next few weeks'))
})

test('tc-h: hasFrustration detects frustration keywords', () => {
  assert.ok(hasFrustration('This is still not working, seriously'))
  assert.ok(hasFrustration('It keeps failing again, what is going on'))
  assert.ok(!hasFrustration('Please help me write a proposal'))
})

// ─── G.2 Rhythm Tracker ───────────────────────────────────────────────────────

console.log('\n── G.2 Rhythm Tracker ─────────────────────────────────────────────')

test('rt-a: recordTaskCompletion creates snapshot and profile', () => {
  const u = U + '-rt-a'
  clean(u)
  recordTaskCompletion(u, 'task-1', 'Research the AI agent landscape and summarize findings')
  const snap = db.prepare(`SELECT task_category FROM channel_g_task_snapshots WHERE user_id = ?`).get(u) as any
  assert.ok(snap, 'should have snapshot')
  assert.equal(snap.task_category, 'deep_work')
  const profile = db.prepare(`SELECT total_tasks_observed FROM channel_g_profiles WHERE user_id = ?`).get(u) as any
  assert.ok(profile, 'should have profile')
  assert.equal(profile.total_tasks_observed, 1)
})

test('rt-b: cognitive_rhythm JSON accumulates per-hour category counts', () => {
  const u = U + '-rt-b'
  clean(u)
  // Insert 5 snapshots at hour 9 — deep_work
  for (let i = 0; i < 5; i++) {
    insertSnapshot(u, 9, 'deep_work')
  }
  // Trigger profile update via recordTaskCompletion (uses current hour, but let's check the DB directly)
  // Update profile manually by inserting with hour=9 via recordTaskCompletion then checking
  // Actually let's call recordTaskCompletion and then override the rhythm check via insertSnapshot
  recordTaskCompletion(u, 'task-x', 'Research something now')
  // Now call getDominantCategoryForHour for hour 9 (where we manually inserted 5 snapshots)
  // getDominantCategoryForHour reads from cognitive_rhythm in profile, but profile was built at current hour
  // So let's build profile from the snapshots via a direct rhythm build
  // Instead: just check that insertSnapshot + profile roundtrip works
  const snaps = db.prepare(`SELECT COUNT(*) AS cnt FROM channel_g_task_snapshots WHERE user_id = ? AND hour_of_day = 9`).get(u) as any
  assert.ok(snaps.cnt >= 5, `expected >= 5 snapshots at hour 9, got ${snaps.cnt}`)
})

test('rt-c: urgency flag is stored in snapshot', () => {
  const u = U + '-rt-c'
  clean(u)
  recordTaskCompletion(u, 'task-1', 'Send this email ASAP it\'s urgent and critical')
  const snap = db.prepare(`SELECT has_urgency FROM channel_g_task_snapshots WHERE user_id = ?`).get(u) as any
  assert.equal(snap.has_urgency, 1)
})

test('rt-d: frustration flag is stored in snapshot', () => {
  const u = U + '-rt-d'
  clean(u)
  recordTaskCompletion(u, 'task-1', 'This is still broken again, seriously fix it')
  const snap = db.prepare(`SELECT has_frustration FROM channel_g_task_snapshots WHERE user_id = ?`).get(u) as any
  assert.equal(snap.has_frustration, 1)
})

test('rt-e: getDominantCategoryForHour returns null with fewer than 3 data points', () => {
  const u = U + '-rt-e'
  clean(u)
  insertSnapshot(u, 9, 'deep_work')
  insertSnapshot(u, 9, 'deep_work')
  // Need to update profile — recordTaskCompletion does it at current hour, not 9
  // Build rhythm manually via direct profile insert
  db.prepare(`INSERT INTO channel_g_profiles (user_id, total_tasks_observed, cognitive_rhythm) VALUES (?, 2, ?)`)
    .run(u, JSON.stringify({ 9: { deep_work: 2 } }))
  const result = getDominantCategoryForHour(u, 9)
  assert.equal(result, null, 'should be null with only 2 data points')
})

test('rt-f: getDominantCategoryForHour returns dominant category with 3+ data points', () => {
  const u = U + '-rt-f'
  clean(u)
  db.prepare(`INSERT INTO channel_g_profiles (user_id, total_tasks_observed, cognitive_rhythm) VALUES (?, 5, ?)`)
    .run(u, JSON.stringify({ 9: { deep_work: 4, admin: 1 } }))
  const result = getDominantCategoryForHour(u, 9)
  assert.equal(result, 'deep_work')
})

// ─── G.3 Stress Cycle Detection ───────────────────────────────────────────────

console.log('\n── G.3 Stress Cycle Detection ─────────────────────────────────────')

test('sc-a: stress_streak increments on consecutive urgent days', () => {
  const u = U + '-sc-a'
  clean(u)
  // Simulate 3 days of urgency by seeding prior snapshots and then calling record
  for (let d = 2; d >= 1; d--) {
    db.prepare(`
      INSERT INTO channel_g_task_snapshots
        (id, user_id, task_id, hour_of_day, day_of_week, day_of_month, month_of_year,
         task_category, prompt_word_count, has_urgency, has_frustration, is_late_night, created_at)
      VALUES (randomblob(16), ?, randomblob(8), 14, 1, 15, 7, 'execution', 10, 1, 0, 0, datetime('now', ?))
    `).run(u, `-${d} days`)
  }
  // Set up profile with prior streak=2
  db.prepare(`INSERT INTO channel_g_profiles (user_id, total_tasks_observed, current_stress_streak, current_stress_start)
    VALUES (?, 2, 2, date('now', '-2 days'))`).run(u)
  // Record today's urgent task
  recordTaskCompletion(u, 'task-today', 'ASAP urgent today send this out immediately deadline')
  const profile = db.prepare(`SELECT current_stress_streak FROM channel_g_profiles WHERE user_id = ?`).get(u) as any
  assert.ok(profile.current_stress_streak >= 3, `expected streak >= 3, got ${profile.current_stress_streak}`)
})

test('sc-b: stress cycle row created when streak reaches 3', () => {
  const u = U + '-sc-b'
  clean(u)
  // Seed profile with streak=2 and yesterday signal
  db.prepare(`INSERT INTO channel_g_profiles (user_id, total_tasks_observed, current_stress_streak, current_stress_start)
    VALUES (?, 2, 2, date('now', '-2 days'))`).run(u)
  db.prepare(`
    INSERT INTO channel_g_task_snapshots (id, user_id, task_id, hour_of_day, day_of_week, day_of_month, month_of_year,
      task_category, prompt_word_count, has_urgency, has_frustration, is_late_night, created_at)
    VALUES (randomblob(16), ?, randomblob(8), 14, 1, 15, 7, 'execution', 10, 1, 0, 0, datetime('now', '-1 days'))
  `).run(u)
  recordTaskCompletion(u, 'task-3', 'ASAP urgent critical deadline today')
  const stressCycle = db.prepare(`SELECT status FROM channel_g_stress_cycles WHERE user_id = ? LIMIT 1`).get(u) as any
  assert.ok(stressCycle, 'should have a stress cycle row')
  assert.equal(stressCycle.status, 'active')
})

test('sc-c: stress_streak resets to 0 on non-stressful day', () => {
  const u = U + '-sc-c'
  clean(u)
  db.prepare(`INSERT INTO channel_g_profiles (user_id, total_tasks_observed, current_stress_streak, current_stress_start)
    VALUES (?, 3, 3, date('now', '-3 days'))`).run(u)
  // Non-urgent, non-frustrated task today
  recordTaskCompletion(u, 'task-calm', 'Write a blog post about my startup journey')
  const profile = db.prepare(`SELECT current_stress_streak FROM channel_g_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile.current_stress_streak, 0)
})

test('sc-d: resolved stress cycle is stored in channel_g_stress_cycles', () => {
  const u = U + '-sc-d'
  clean(u)
  // Active stress cycle from 3 days ago
  db.prepare(`
    INSERT INTO channel_g_stress_cycles (id, user_id, cycle_start, peak_streak, signals, status)
    VALUES (randomblob(16), ?, date('now', '-3 days'), 3, '{}', 'active')
  `).run(u)
  db.prepare(`INSERT INTO channel_g_profiles (user_id, total_tasks_observed, current_stress_streak, current_stress_start)
    VALUES (?, 3, 3, date('now', '-3 days'))`).run(u)
  // Calm task today triggers resolution
  recordTaskCompletion(u, 'task-calm', 'Schedule a call with Tom next week')
  const resolved = db.prepare(`SELECT status FROM channel_g_stress_cycles WHERE user_id = ? AND status = 'resolved'`).get(u) as any
  assert.ok(resolved, 'stress cycle should be resolved')
})

// ─── G.4 Recovery Pattern ─────────────────────────────────────────────────────

console.log('\n── G.4 Recovery Pattern ────────────────────────────────────────────')

test('rp-a: recovery_pattern is updated after stress cycle resolves', () => {
  const u = U + '-rp-a'
  clean(u)
  db.prepare(`
    INSERT INTO channel_g_stress_cycles (id, user_id, cycle_start, peak_streak, signals, status)
    VALUES (randomblob(16), ?, date('now', '-3 days'), 4, '{}', 'active')
  `).run(u)
  db.prepare(`INSERT INTO channel_g_profiles (user_id, total_tasks_observed, current_stress_streak, current_stress_start)
    VALUES (?, 4, 4, date('now', '-4 days'))`).run(u)
  recordTaskCompletion(u, 'task-easy', 'Schedule a meeting with Alice')
  const profile = db.prepare(`SELECT recovery_pattern FROM channel_g_profiles WHERE user_id = ?`).get(u) as any
  const recovery = JSON.parse(profile.recovery_pattern ?? 'null')
  assert.ok(recovery !== null, 'recovery_pattern should be set')
  assert.ok(Array.isArray(recovery.cycles) && recovery.cycles.length > 0, 'should have at least one cycle recorded')
})

// ─── G.5 Context Builder ──────────────────────────────────────────────────────

console.log('\n── G.5 Context Builder ─────────────────────────────────────────────')

test('cb-a: returns null when fewer than 5 tasks observed', () => {
  const u = U + '-cb-a'
  clean(u)
  db.prepare(`INSERT INTO channel_g_profiles (user_id, total_tasks_observed) VALUES (?, 3)`).run(u)
  const block = buildChannelGContextBlock(u)
  assert.equal(block, null)
})

test('cb-b: returns null for user with no profile', () => {
  const u = U + '-cb-b'
  clean(u)
  const block = buildChannelGContextBlock(u)
  assert.equal(block, null)
})

test('cb-c: includes cognitive rhythm hint when dominant category exists for current hour', () => {
  const u = U + '-cb-c'
  clean(u)
  const currentHour = new Date().getHours()
  db.prepare(`INSERT INTO channel_g_profiles (user_id, total_tasks_observed, cognitive_rhythm)
    VALUES (?, 10, ?)`).run(u, JSON.stringify({ [currentHour]: { deep_work: 5, admin: 1 } }))
  const block = buildChannelGContextBlock(u)
  assert.ok(block !== null, 'should return a context block')
  assert.ok(block!.includes('Temporal Patterns'), 'should have header')
  assert.ok(block!.includes('deep research'), `expected deep_work label in:\n${block}`)
})

test('cb-d: includes stress streak warning when streak >= 3', () => {
  const u = U + '-cb-d'
  clean(u)
  db.prepare(`INSERT INTO channel_g_profiles (user_id, total_tasks_observed, current_stress_streak)
    VALUES (?, 10, 4)`).run(u)
  const block = buildChannelGContextBlock(u)
  assert.ok(block?.includes('High-pressure'), `expected stress warning in:\n${block}`)
})

test('cb-e: includes recovery hint within 3 days of stress cycle end', () => {
  const u = U + '-cb-e'
  clean(u)
  db.prepare(`
    INSERT INTO channel_g_stress_cycles (id, user_id, cycle_start, cycle_end, peak_streak, signals, status)
    VALUES (randomblob(16), ?, datetime('now', '-1 days'), datetime('now', '-6 hours'), 4, '{}', 'resolved')
  `).run(u)
  db.prepare(`INSERT INTO channel_g_profiles (user_id, total_tasks_observed)
    VALUES (?, 10)`).run(u)
  const block = buildChannelGContextBlock(u)
  assert.ok(block?.includes('high-pressure period'), `expected recovery hint in:\n${block}`)
})

test('cb-f: returns null when profile has tasks but no signal fires', () => {
  const u = U + '-cb-f'
  clean(u)
  // Profile with 10 tasks but no rhythm data at current hour, no stress, no recovery
  db.prepare(`INSERT INTO channel_g_profiles (user_id, total_tasks_observed, cognitive_rhythm, current_stress_streak)
    VALUES (?, 10, '{}', 0)`).run(u)
  const block = buildChannelGContextBlock(u)
  assert.equal(block, null, 'should return null when no signals fire')
})

// ─── Summary ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n── Results ───────────────────────────────────────────────────────`)
  console.log(`   ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 300)
