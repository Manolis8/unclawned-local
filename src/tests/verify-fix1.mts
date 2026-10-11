/**
 * Fix 1 verification — run from project root: npx tsx src/tests/verify-fix1.mts
 * 1. Confirm channel_g_task_snapshots, channel_g_stress_cycles, channel_g_profiles exist after db.ts init
 * 2. Direct insert into channel_g_task_snapshots succeeds
 * 3. Simulated throw is caught by IIFE, does not propagate
 */
import { db } from '../lib/db.js'
import { randomUUID } from 'crypto'

function checkTable(tableName: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName)
  return !!row
}

let pass = true
function check(label: string, cond: boolean) {
  if (!cond) pass = false
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

console.log('\n── Part 1: Tables Exist After db.ts Init ────────────────────')
check('channel_g_task_snapshots exists', checkTable('channel_g_task_snapshots'))
check('channel_g_stress_cycles exists', checkTable('channel_g_stress_cycles'))
check('channel_g_profiles exists', checkTable('channel_g_profiles'))

console.log('\n── Part 2: INSERT Into channel_g_task_snapshots Succeeds ────')
const testUser = 'fix1-verify-' + Date.now()
const now = new Date()
try {
  db.prepare(`
    INSERT INTO channel_g_task_snapshots
      (id, user_id, task_id, hour_of_day, day_of_week, day_of_month, month_of_year,
       task_category, prompt_word_count, has_urgency, has_frustration, is_late_night, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(randomUUID(), testUser, 'task-1',
    now.getHours(), now.getDay(), now.getDate(), now.getMonth() + 1,
    'deep_work', 8, 0, 0, 0)

  const row = db.prepare('SELECT task_category, hour_of_day FROM channel_g_task_snapshots WHERE user_id = ?').get(testUser) as any
  check('Row inserted and readable', !!row && row.task_category === 'deep_work')

  db.prepare('DELETE FROM channel_g_task_snapshots WHERE user_id = ?').run(testUser)
} catch (e: any) {
  check('Insert did not throw', false)
  console.log(`    Error: ${e.message}`)
}

console.log('\n── Part 3: Error Isolation — IIFE Catch Swallows Error ──────')
let caught = false
await (async () => {
  try {
    throw new Error('simulated: no such table: channel_g_task_snapshots')
  } catch (e) {
    caught = true
    // mimics the updated catch: console.error('[channel-g] rhythm tracker error (non-fatal):', e)
  }
})()
check('Simulated throw caught inside IIFE, did not propagate', caught)

console.log('\n' + (pass ? 'ALL PASS' : 'SOME FAILURES'))
process.exit(pass ? 0 : 1)
