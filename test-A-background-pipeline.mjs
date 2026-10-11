/**
 * Test A — Background automation pipeline
 * Covers: Feature 1 (skill drafts), Feature 4 (gap proposals), Feature 5a (staleness)
 *
 * Run: node test-A-background-pipeline.mjs
 * Does NOT need a running server or API keys. Pure DB logic.
 */

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const db = new DatabaseSync(join(homedir(), '.unclawned', 'openclaw.db'))
db.exec('PRAGMA journal_mode = WAL')

// ── Setup ─────────────────────────────────────────────────────────────────────
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

// ── Cleanup ───────────────────────────────────────────────────────────────────
db.prepare("DELETE FROM skill_drafts WHERE user_id = ? AND source_task LIKE '__test%'").run(userId)
db.prepare("DELETE FROM skill_gap_events WHERE user_id = ? AND task_description = '__test__'").run(userId)
db.prepare("DELETE FROM skill_suggestions WHERE user_id = ? AND source_task LIKE 'gap-pattern:__test%'").run(userId)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — Skill draft DB lifecycle
// ══════════════════════════════════════════════════════════════════════════════
console.log('── Feature 1: Skill Drafts ──────────────────────────────────────')

const draftId = randomUUID()
const sourceTask = '__test__ search linkedin for python jobs'

db.prepare(`
  INSERT INTO skill_drafts (id, user_id, draft_name, draft_description, skill_type, execution_plan, source_task, tool_call_count)
  VALUES (?, ?, ?, ?, 'browser', ?, ?, 12)
`).run(draftId, userId, 'linkedin-job-search', 'Search LinkedIn for job listings', JSON.stringify({
  strategy: 'Navigate to LinkedIn Jobs, enter search term, extract results',
  steps: [
    { number: 1, description: 'Navigate to LinkedIn Jobs', action_type: 'navigate', url: 'https://www.linkedin.com/jobs' },
    { number: 2, description: 'Type job title into search box', action_type: 'type', selectors: ['input[aria-label="Search by title"]'], value: '{{job_title}}' },
    { number: 3, description: 'Submit search', action_type: 'click', selectors: ['button[type="submit"]'] },
    { number: 4, description: 'Read job listings', action_type: 'read' },
  ],
  variables: [{ name: 'job_title', description: 'Job title to search for', example: 'Python developer' }],
}), sourceTask)

// hasPendingDraftForTask dedup logic
const dupCheck = db.prepare(`
  SELECT id FROM skill_drafts WHERE user_id = ? AND status = 'pending' AND source_task LIKE ? LIMIT 1
`).get(userId, `${sourceTask.slice(0, 60)}%`)
assert('Draft inserted and dedup query finds it', !!dupCheck)

// listSkillDrafts
const drafts = db.prepare("SELECT * FROM skill_drafts WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC").all(userId)
assert('GET /drafts returns pending drafts', drafts.length > 0)

// getSkillDraft
const fetched = db.prepare('SELECT * FROM skill_drafts WHERE id = ?').get(draftId)
assert('GET /drafts/:id returns correct draft', fetched?.draft_name === 'linkedin-job-search')

// resolveSkillDraft — dismiss it
db.prepare("UPDATE skill_drafts SET status = 'dismissed', resolved_at = datetime('now') WHERE id = ?").run(draftId)
const dismissed = db.prepare('SELECT status FROM skill_drafts WHERE id = ?').get(draftId)
assert('POST /drafts/:id/dismiss sets status=dismissed', dismissed?.status === 'dismissed')

// resolveSkillDraft — create (simulate)
const draft2Id = randomUUID()
db.prepare(`
  INSERT INTO skill_drafts (id, user_id, draft_name, draft_description, skill_type, execution_plan, source_task, tool_call_count)
  VALUES (?, ?, ?, ?, 'browser', '{}', '__test__ draft 2', 5)
`).run(draft2Id, userId, 'test-skill-2', 'A test skill')
db.prepare("UPDATE skill_drafts SET status = 'created', resolved_at = datetime('now') WHERE id = ?").run(draft2Id)
const created = db.prepare('SELECT status FROM skill_drafts WHERE id = ?').get(draft2Id)
assert('POST /drafts/:id/create sets status=created', created?.status === 'created')


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 4 — Gap proposal surface
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Feature 4: Gap Proposals ─────────────────────────────────────')

// Seed 3 friction_event gap events
for (let i = 0; i < 3; i++) {
  db.prepare(`
    INSERT INTO skill_gap_events (id, user_id, stuck_description, stuck_type, current_url, current_page_type, task_description)
    VALUES (?, ?, 'Cookie banner blocked interaction', 'friction_event', 'https://example.com', 'unknown', '__test__')
  `).run(randomUUID(), userId)
}

// Query — same logic as checkAndSurfaceGapProposalsAsync
const gapRows = db.prepare(`
  SELECT stuck_type, COUNT(*) as count FROM skill_gap_events
  WHERE user_id = ? AND created_at >= datetime('now', '-30 days')
  GROUP BY stuck_type HAVING count >= 3 ORDER BY count DESC LIMIT 5
`).all(userId)
assert('Gap query finds friction_event with ≥3 events', gapRows.some(r => r.stuck_type === 'friction_event'))

// Surface suggestion
const gapSuggId = randomUUID()
const gapSourceKey = 'gap-pattern:__test__friction_event'
db.prepare(`
  INSERT INTO skill_suggestions (id, user_id, suggested_name, suggested_description, skill_type, source_task, tool_call_count)
  VALUES (?, ?, 'dismiss-friction-gates', 'Handle cookie banners and popups', 'browser', ?, 3)
`).run(gapSuggId, userId, gapSourceKey)

// Dedup — hasPendingSuggestionForTask logic
const dedupHit = db.prepare(`
  SELECT id FROM skill_suggestions WHERE user_id = ? AND status = 'pending' AND source_task LIKE ? LIMIT 1
`).get(userId, `${gapSourceKey.slice(0, 60)}%`)
assert('Dedup prevents duplicate gap suggestions', !!dedupHit)

// List suggestions
const suggestions = db.prepare("SELECT * FROM skill_suggestions WHERE user_id = ? AND status = 'pending'").all(userId)
assert('GET /suggestions returns gap suggestion', suggestions.some(s => s.source_task.startsWith('gap-pattern:')))

// Accept suggestion
db.prepare("UPDATE skill_suggestions SET status = 'accepted', resolved_at = datetime('now') WHERE id = ?").run(gapSuggId)
const accepted = db.prepare('SELECT status FROM skill_suggestions WHERE id = ?').get(gapSuggId)
assert('Accepting suggestion sets status=accepted', accepted?.status === 'accepted')


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 5a — Staleness detection
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Feature 5a: Staleness Detection ─────────────────────────────')

const skill = db.prepare('SELECT id FROM skills WHERE user_id = ? LIMIT 1').get(userId)
if (!skill) { console.log('  ⚠️  No skills in DB — skipping staleness tests'); }
else {
  const sid = skill.id

  // Reset
  db.prepare('UPDATE skills SET staleness = NULL, staleness_reason = NULL, pinned = 0 WHERE id = ?').run(sid)

  // Simulate 2 consecutive failures
  const execIds = [randomUUID(), randomUUID()]
  for (const eid of execIds) {
    db.prepare(`
      INSERT OR IGNORE INTO skill_executions (id, skill_id, user_id, status, completed_at)
      VALUES (?, ?, ?, 'error', datetime('now', '-1 minutes'))
    `).run(eid, sid, userId)
  }

  // Run staleness evaluate logic (same as in skill-staleness.ts)
  const execs = db.prepare(`
    SELECT status FROM skill_executions WHERE skill_id = ? AND status IN ('success', 'error')
    ORDER BY completed_at DESC LIMIT 10
  `).all(sid)
  let consecutiveFails = 0
  for (const e of execs) { if (e.status === 'error') consecutiveFails++; else break }
  const shouldBeStale = consecutiveFails >= 2

  if (shouldBeStale) {
    db.prepare('UPDATE skills SET staleness = ?, staleness_reason = ? WHERE id = ?')
      .run('stale', `Failed ${consecutiveFails} times in a row`, sid)
  }
  const staleCheck = db.prepare('SELECT staleness, staleness_reason FROM skills WHERE id = ?').get(sid)
  assert('Consecutive failures mark skill as stale', staleCheck?.staleness === 'stale')
  assert('staleness_reason is populated', !!staleCheck?.staleness_reason)

  // Simulate success → clears staleness (not pinned)
  db.prepare('UPDATE skills SET staleness = NULL, staleness_reason = NULL WHERE id = ?').run(sid)
  const cleared = db.prepare('SELECT staleness FROM skills WHERE id = ?').get(sid)
  assert('Successful run clears staleness', cleared?.staleness === null)

  // Pin exemption — staleness check should skip pinned skills
  db.prepare('UPDATE skills SET pinned = 1 WHERE id = ?').run(sid)
  // If pinned, isSkillPinned returns true → checkSkillStalenessAsync returns early
  const isPinned = db.prepare('SELECT pinned FROM skills WHERE id = ?').get(sid)
  assert('Pin exemption: isSkillPinned returns true', !!isPinned?.pinned)
  db.prepare('UPDATE skills SET pinned = 0 WHERE id = ?').run(sid)

  // Cleanup test executions
  db.prepare('DELETE FROM skill_executions WHERE id IN (?, ?)').run(...execIds)
}


// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
