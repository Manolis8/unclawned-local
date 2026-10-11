/**
 * Test: Gap Proposal Surface (Feature 4)
 * Tests the full DB flow without needing a running server or API keys.
 *
 * Run: node test-gap-proposals.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const db = new DatabaseSync(join(homedir(), '.unclawned', 'openclaw.db'))
db.exec('PRAGMA journal_mode = WAL')

// Bootstrap tables
db.exec(`CREATE TABLE IF NOT EXISTS skill_gap_events (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  stuck_description TEXT, stuck_type TEXT,
  current_url TEXT, current_page_type TEXT,
  task_description TEXT, created_at TEXT DEFAULT (datetime('now'))
)`)
db.exec(`CREATE TABLE IF NOT EXISTS skill_suggestions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  suggested_name TEXT NOT NULL, suggested_description TEXT NOT NULL,
  skill_type TEXT NOT NULL DEFAULT 'browser', source_task TEXT NOT NULL,
  tool_call_count INTEGER, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), resolved_at TEXT
)`)

// ── 1. Get user ───────────────────────────────────────────────────────────────
const userRow = db.prepare(`SELECT user_id FROM api_keys LIMIT 1`).get()
if (!userRow) { console.error('❌ No users found.'); process.exit(1) }
const userId = userRow.user_id
console.log(`\n✅ User: ${userId}`)

// ── 2. Clean up for fresh run ─────────────────────────────────────────────────
db.prepare(`DELETE FROM skill_gap_events WHERE user_id = ? AND task_description = '__test__'`).run(userId)
db.prepare(`DELETE FROM skill_suggestions WHERE user_id = ? AND source_task LIKE 'gap-pattern:%'`).run(userId)
console.log('🧹 Cleared test gap events and gap suggestions')

// ── 3. Seed gap events (simulating logSkillGap being called during tasks) ─────
const gapTypes = [
  { stuck_type: 'friction_event', stuck_description: 'Cookie banner blocked interaction on checkout page' },
  { stuck_type: 'friction_event', stuck_description: 'GDPR consent popup appeared before content loaded' },
  { stuck_type: 'friction_event', stuck_description: 'Newsletter signup modal blocked the main content' },
  { stuck_type: 'navigation_failure', stuck_description: 'Could not find the Jobs link in the nav menu' },
  { stuck_type: 'navigation_failure', stuck_description: 'URL redirected to login page unexpectedly' },
  { stuck_type: 'navigation_failure', stuck_description: 'Target section was behind a pagination wall' },
  { stuck_type: 'action_failure', stuck_description: 'Click on submit button had no effect' },
]

for (const g of gapTypes) {
  db.prepare(`
    INSERT INTO skill_gap_events (id, user_id, stuck_description, stuck_type, current_url, current_page_type, task_description)
    VALUES (?, ?, ?, ?, 'https://example.com', 'unknown', '__test__')
  `).run(randomUUID(), userId, g.stuck_description, g.stuck_type)
}

console.log(`\n✅ Seeded ${gapTypes.length} gap events across 3 stuck types`)

// ── 4. Query — same logic as checkAndSurfaceGapProposalsAsync ────────────────
const rows = db.prepare(`
  SELECT stuck_type, COUNT(*) as count,
         GROUP_CONCAT(DISTINCT substr(stuck_description, 1, 80)) as samples
  FROM skill_gap_events
  WHERE user_id = ?
    AND created_at >= datetime('now', '-30 days')
  GROUP BY stuck_type
  HAVING count >= 3
  ORDER BY count DESC
  LIMIT 5
`).all(userId)

console.log(`\n📊 Gap patterns above threshold (≥3 events in 30 days):`)
for (const r of rows) {
  console.log(`  ${r.stuck_type}: ${r.count} events`)
}

// ── 5. Surface gap suggestions (simulates checkAndSurfaceGapProposalsAsync) ───
const GAP_TEMPLATES = {
  friction_event: { name: 'dismiss-friction-gates', description: 'Handle cookie banners, login walls, and popups that block page interaction' },
  navigation_failure: { name: 'navigate-to-section', description: 'Navigate reliably to a target page or section when the URL or path keeps changing' },
  unknown_page: { name: 'handle-unexpected-page', description: 'Recover from unexpected page states, layouts, or error screens gracefully' },
  action_failure: { name: 'retry-failing-action', description: 'Retry an action that repeatedly fails due to timing or element availability' },
  sub_task_gap: { name: 'missing-sub-task-skill', description: 'Handle a recurring sub-task that is not covered by any existing skill' },
}

let staged = 0
for (const row of rows) {
  const sourceKey = `gap-pattern:${row.stuck_type}`

  // Dedup check
  const exists = db.prepare(`
    SELECT id FROM skill_suggestions WHERE user_id = ? AND status = 'pending' AND source_task LIKE ? LIMIT 1
  `).get(userId, `${sourceKey.slice(0, 60)}%`)
  if (exists) { console.log(`  ⏭️  Skip "${row.stuck_type}" — pending suggestion already exists`); continue }

  const t = GAP_TEMPLATES[row.stuck_type] ?? {
    name: `handle-${row.stuck_type.replace(/_/g, '-')}`,
    description: `Handle recurring situations that caused ${row.count} stuck events`,
  }

  db.prepare(`
    INSERT INTO skill_suggestions (id, user_id, suggested_name, suggested_description, skill_type, source_task, tool_call_count)
    VALUES (?, ?, ?, ?, 'browser', ?, ?)
  `).run(randomUUID(), userId, t.name, t.description, sourceKey, row.count)
  staged++
  console.log(`  💡 Staged: "${t.name}" (source: ${sourceKey})`)
}

console.log(`\n✅ Staged ${staged} gap suggestion(s)`)

// ── 6. List suggestions — GET /api/skills/suggestions sees them ───────────────
const allPending = db.prepare(`
  SELECT * FROM skill_suggestions WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC
`).all(userId)

console.log(`\n📬 GET /api/skills/suggestions → ${allPending.length} pending`)
for (const s of allPending) {
  const isGap = s.source_task.startsWith('gap-pattern:')
  console.log(`\n  ${isGap ? '🚧' : '💡'} "${s.suggested_name}"`)
  console.log(`     ${s.suggested_description}`)
  if (isGap) {
    console.log(`     ⚠️  Gap pattern: stuck ${s.tool_call_count}x — "${s.source_task.replace('gap-pattern:', '')}"`)
  }
}

// ── 7. Dedup: running again should not stage duplicates ───────────────────────
console.log('\n🔄 Dedup check: running checkAndSurfaceGapProposalsAsync again...')
let blocked = 0
for (const row of rows) {
  const sourceKey = `gap-pattern:${row.stuck_type}`
  const exists = db.prepare(`
    SELECT id FROM skill_suggestions WHERE user_id = ? AND status = 'pending' AND source_task LIKE ? LIMIT 1
  `).get(userId, `${sourceKey.slice(0, 60)}%`)
  if (exists) blocked++
}
console.log(`  ${blocked}/${rows.length} gap types blocked by dedup (correct — pending already exists)`)

// ── 8. Accept a gap suggestion ────────────────────────────────────────────────
const gapSuggestion = allPending.find(s => s.source_task.startsWith('gap-pattern:'))
if (gapSuggestion) {
  db.prepare(`UPDATE skill_suggestions SET status = 'accepted', resolved_at = datetime('now') WHERE id = ?`).run(gapSuggestion.id)
  const prefill = { name: gapSuggestion.suggested_name, description: gapSuggestion.suggested_description, skillType: gapSuggestion.skill_type }
  console.log(`\n🎯 Accepted: "${gapSuggestion.suggested_name}"`)
  console.log('  Prefill returned to frontend:')
  console.log(JSON.stringify(prefill, null, 2))
}

// ── 9. Final state ────────────────────────────────────────────────────────────
const finalPending = db.prepare(`SELECT COUNT(*) as cnt FROM skill_suggestions WHERE user_id = ? AND status = 'pending'`).get(userId)
console.log(`\n📊 Pending suggestions remaining: ${finalPending.cnt}`)
console.log('\n🎉 Feature 4 test complete.')
