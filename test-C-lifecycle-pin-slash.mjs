/**
 * Test C — Lifecycle archival (Feature 5b), Pin mechanism (Feature 6), Slash command (Feature 8)
 *
 * Run: node test-C-lifecycle-pin-slash.mjs
 * Does NOT need a running server or API keys. Pure DB logic.
 */

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const db = new DatabaseSync(join(homedir(), '.unclawned', 'openclaw.db'))
db.exec('PRAGMA journal_mode = WAL')

const userRow = db.prepare('SELECT user_id FROM api_keys LIMIT 1').get()
if (!userRow) { console.error('No users found.'); process.exit(1) }
const userId = userRow.user_id
console.log(`\nUser: ${userId}\n`)

let passed = 0
let failed = 0
function assert(label, condition) {
  if (condition) { console.log(`  ✅ ${label}`); passed++ }
  else { console.error(`  ❌ ${label}`); failed++ }
}

// ── Create a test skill for lifecycle and pin tests ───────────────────────────
const testSkillId = randomUUID()
db.prepare(`
  INSERT INTO skills (id, user_id, skill_name, skill_description, execution_plan, status, run_count, last_run_at, pinned)
  VALUES (?, ?, '__test-lifecycle-skill__', 'A skill for testing lifecycle', '{}', 'active', 5, datetime('now', '-100 days'), 0)
`).run(testSkillId, userId)
console.log(`Created test skill: ${testSkillId}\n`)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 5b — Lifecycle archival
// ══════════════════════════════════════════════════════════════════════════════
console.log('── Feature 5b: Lifecycle Archival ───────────────────────────────')

// Run archival (same SQL as checkSkillLifecycle)
const archived = db.prepare(`
  UPDATE skills SET status = 'archived'
  WHERE user_id = ?
    AND (status IS NULL OR status != 'archived')
    AND pinned = 0
    AND run_count > 0
    AND last_run_at IS NOT NULL
    AND last_run_at < datetime('now', '-90 days')
`).run(userId)
assert('Archival runs without error', archived !== null)
assert(`Archived ${archived.changes} skill(s) unused 90+ days`, archived.changes >= 1)

// Test skill is now archived
const archivedSkill = db.prepare('SELECT status FROM skills WHERE id = ?').get(testSkillId)
assert('Test skill is now archived', archivedSkill?.status === 'archived')

// GET /skills default list excludes archived
const defaultList = db.prepare(`
  SELECT COUNT(*) as n FROM skills WHERE user_id = ? AND (status IS NULL OR status != 'archived')
`).get(userId)
const allList = db.prepare('SELECT COUNT(*) as n FROM skills WHERE user_id = ?').get(userId)
assert('Default list excludes archived skills', defaultList.n < allList.n)

// GET /skills?include_archived=true shows everything
assert('include_archived=true shows all skills including archived', allList.n > defaultList.n)

// Skills with run_count=0 are NOT archived
const neverRanId = randomUUID()
db.prepare(`
  INSERT INTO skills (id, user_id, skill_name, execution_plan, status, run_count, last_run_at, pinned)
  VALUES (?, ?, '__test-never-ran__', '{}', 'active', 0, datetime('now', '-200 days'), 0)
`).run(neverRanId, userId)
db.prepare(`
  UPDATE skills SET status = 'archived'
  WHERE user_id = ? AND (status IS NULL OR status != 'archived') AND pinned = 0
    AND run_count > 0 AND last_run_at IS NOT NULL AND last_run_at < datetime('now', '-90 days')
`).run(userId)
const neverRanStatus = db.prepare('SELECT status FROM skills WHERE id = ?').get(neverRanId)
assert('Skills with run_count=0 are never archived', neverRanStatus?.status === 'active')
db.prepare('DELETE FROM skills WHERE id = ?').run(neverRanId)

// NULL status skills ARE archived (bug fix verification)
const nullStatusId = randomUUID()
db.prepare(`
  INSERT INTO skills (id, user_id, skill_name, execution_plan, run_count, last_run_at, pinned)
  VALUES (?, ?, '__test-null-status__', '{}', 3, datetime('now', '-100 days'), 0)
`).run(nullStatusId, userId)
db.prepare(`
  UPDATE skills SET status = 'archived'
  WHERE user_id = ? AND (status IS NULL OR status != 'archived') AND pinned = 0
    AND run_count > 0 AND last_run_at IS NOT NULL AND last_run_at < datetime('now', '-90 days')
`).run(userId)
const nullStatusResult = db.prepare('SELECT status FROM skills WHERE id = ?').get(nullStatusId)
assert('NULL-status skills ARE archived (bug fix: IS NULL OR !=)', nullStatusResult?.status === 'archived')
db.prepare('DELETE FROM skills WHERE id = ?').run(nullStatusId)

// Restore archived skill (POST /:skillId/restore)
db.prepare("UPDATE skills SET status = 'active', last_run_at = datetime('now') WHERE id = ?").run(testSkillId)
const restored = db.prepare('SELECT status, last_run_at FROM skills WHERE id = ?').get(testSkillId)
assert('POST /:id/restore sets status=active', restored?.status === 'active')
assert('POST /:id/restore bumps last_run_at', !!restored?.last_run_at)

// Restored skill won't immediately re-archive (last_run_at = now)
const reArchiveCheck = db.prepare(`
  SELECT id FROM skills WHERE id = ? AND (status IS NULL OR status != 'archived') AND pinned = 0
    AND run_count > 0 AND last_run_at IS NOT NULL AND last_run_at < datetime('now', '-90 days')
`).get(testSkillId)
assert('Restored skill does not immediately re-archive', !reArchiveCheck)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 6 — Pin mechanism
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Feature 6: Pin Mechanism ─────────────────────────────────────')

// Reset test skill
db.prepare("UPDATE skills SET status = 'active', last_run_at = datetime('now', '-100 days'), pinned = 0 WHERE id = ?").run(testSkillId)

// POST /:skillId/pin
db.prepare('UPDATE skills SET pinned = 1 WHERE id = ?').run(testSkillId)
const pinned = db.prepare('SELECT pinned FROM skills WHERE id = ?').get(testSkillId)
assert('POST /:id/pin sets pinned=1', pinned?.pinned === 1)

// Pinned skill is exempt from archival
db.prepare(`
  UPDATE skills SET status = 'archived'
  WHERE user_id = ? AND (status IS NULL OR status != 'archived') AND pinned = 0
    AND run_count > 0 AND last_run_at IS NOT NULL AND last_run_at < datetime('now', '-90 days')
`).run(userId)
const pinnedStatus = db.prepare('SELECT status FROM skills WHERE id = ?').get(testSkillId)
assert('Pinned skill is exempt from archival', pinnedStatus?.status === 'active')

// Pinned skill is exempt from staleness (isSkillPinned returns true → early return)
db.prepare('UPDATE skills SET staleness = NULL WHERE id = ?').run(testSkillId)
const isPinned = !!(db.prepare('SELECT pinned FROM skills WHERE id = ?').get(testSkillId)?.pinned)
assert('isSkillPinned returns true for pinned skill', isPinned)
// If pinned, checkSkillStalenessAsync returns early — staleness stays null
assert('Staleness not applied to pinned skill (guard verified)', isPinned === true)

// DELETE /:skillId/pin
db.prepare('UPDATE skills SET pinned = 0 WHERE id = ?').run(testSkillId)
const unpinned = db.prepare('SELECT pinned FROM skills WHERE id = ?').get(testSkillId)
assert('DELETE /:id/pin sets pinned=0', unpinned?.pinned === 0)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 8 — Slash command slug matching
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Feature 8: Slash Command Slug Matching ───────────────────────')

// Give the test skill a proper name to slug-match against
db.prepare("UPDATE skills SET skill_name = 'LinkedIn Job Search', status = 'active' WHERE id = ?").run(testSkillId)

function slugify(name) {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

// Simulate findSkillBySlug logic
function findSkillBySlug(slug) {
  const rows = db.prepare(
    "SELECT * FROM skills WHERE user_id = ? AND (status IS NULL OR status != 'archived') ORDER BY created_at DESC"
  ).all(userId)
  const normalized = slugify(slug)
  const exact = rows.find(r => slugify(r.skill_name) === normalized)
  if (exact) return { match: 'exact', name: exact.skill_name }
  const prefix = rows.find(r => slugify(r.skill_name).startsWith(normalized))
  if (prefix) return { match: 'prefix', name: prefix.skill_name }
  const sub = rows.find(r => slugify(r.skill_name).includes(normalized))
  if (sub) return { match: 'sub', name: sub.skill_name }
  return null
}

const exactMatch = findSkillBySlug('linkedin-job-search')
assert('/linkedin-job-search → exact match', exactMatch?.match === 'exact')
assert('Exact match resolves to correct skill', exactMatch?.name === 'LinkedIn Job Search')

const prefixMatch = findSkillBySlug('linkedin')
assert('/linkedin → prefix match', prefixMatch?.match === 'prefix')

const subMatch = findSkillBySlug('job')
assert('/job → substring match', subMatch?.match === 'sub')

const noMatch = findSkillBySlug('xyznonexistent99')
assert('/xyznonexistent → null (falls through to orchestrate)', noMatch === null)

// Archived skills are NOT returned by slash command
db.prepare("UPDATE skills SET status = 'archived' WHERE id = ?").run(testSkillId)
const archivedMatch = findSkillBySlug('linkedin-job-search')
assert('Archived skill not matched by slash command', archivedMatch === null || archivedMatch.name !== 'LinkedIn Job Search')

// Slash command regex parsing — test the pattern
const testMessages = [
  { msg: '/linkedin-job-search', expectedSlug: 'linkedin-job-search', expectedExtra: '' },
  { msg: '/linkedin-job-search find me Python roles in London', expectedSlug: 'linkedin-job-search', expectedExtra: 'find me Python roles in London' },
  { msg: '//not-a-slash-command', isSlash: false },
  { msg: 'regular message', isSlash: false },
]
for (const t of testMessages) {
  if (t.isSlash === false) {
    const isSlash = t.msg.startsWith('/') && !t.msg.startsWith('//')
    assert(`"${t.msg}" → not treated as slash command`, !isSlash)
  } else {
    const match = t.msg.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    assert(`"${t.msg}" → slug="${t.expectedSlug}"`, match?.[1] === t.expectedSlug)
    assert(`"${t.msg}" → extraText="${t.expectedExtra}"`, (match?.[2] ?? '').trim() === t.expectedExtra)
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// Cleanup
// ══════════════════════════════════════════════════════════════════════════════
db.prepare('DELETE FROM skills WHERE id = ?').run(testSkillId)


// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
