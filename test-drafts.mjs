/**
 * Test: Background Skill Drafts (Feature 3)
 * Tests the full DB flow without needing a running server or API keys.
 *
 * Run: node test-drafts.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const db = new DatabaseSync(join(homedir(), '.unclawned', 'openclaw.db'))
db.exec('PRAGMA journal_mode = WAL')
const j = v => JSON.stringify(v)
const p = v => { try { return JSON.parse(v) } catch { return v } }

// Bootstrap table (server normally does this on startup)
db.exec(`CREATE TABLE IF NOT EXISTS skill_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  draft_name TEXT NOT NULL,
  draft_description TEXT NOT NULL,
  skill_type TEXT NOT NULL DEFAULT 'browser',
  execution_plan TEXT,
  source_task TEXT NOT NULL,
  tool_call_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
)`)

// ── 1. Get user ───────────────────────────────────────────────────────────────
const userRow = db.prepare(`SELECT user_id FROM api_keys LIMIT 1`).get()
if (!userRow) { console.error('❌ No users found.'); process.exit(1) }
const userId = userRow.user_id
console.log(`\n✅ User: ${userId}`)

// ── 2. Clear pending drafts for clean run ─────────────────────────────────────
const cleared = db.prepare(`DELETE FROM skill_drafts WHERE user_id = ? AND status = 'pending'`).run(userId)
console.log(`🧹 Cleared ${cleared.changes} existing pending draft(s)`)

// ── 3. Mock extracted plan (simulates LLM plan extraction output) ─────────────
const mockPlan = {
  strategy: 'Navigate to LinkedIn Jobs, enter the search query, apply remote filter, then read the top job listings.',
  steps: [
    {
      number: 1,
      description: 'Navigate to LinkedIn Jobs search page',
      action_type: 'navigate',
      url: 'https://www.linkedin.com/jobs/search/',
    },
    {
      number: 2,
      description: 'Type the job keyword into the search input',
      action_type: 'type',
      selectors: ["getByPlaceholder('Search jobs')"],
      value: '{{keyword}}',
    },
    {
      number: 3,
      description: 'Click the Remote filter to limit to remote jobs',
      action_type: 'click',
      selectors: ["getByRole('button', { name: 'Remote' })"],
    },
    {
      number: 4,
      description: 'Read the top job listings from the results page',
      action_type: 'read',
    },
  ],
  variables: [
    { name: 'keyword', description: 'Job title or keyword to search for', example: 'Python developer' },
  ],
}

// Insert a mock draft (same as createSkillDraft in queries.ts)
const draftId = randomUUID()
db.prepare(`
  INSERT INTO skill_drafts
    (id, user_id, draft_name, draft_description, skill_type, execution_plan, source_task, tool_call_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  draftId, userId,
  'linkedin-remote-jobs-search',
  'Search LinkedIn for remote jobs by keyword and list top results',
  'browser',
  j(mockPlan),
  'Search LinkedIn for remote Python developer jobs posted this week and list the top 5',
  9,
)
console.log(`\n✅ Draft staged: ${draftId.slice(0, 8)}... (simulating extractSkillDraftAsync output)`)

// ── 4. List pending drafts — simulates GET /api/skills/drafts ─────────────────
const pending = db.prepare(`SELECT * FROM skill_drafts WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(userId)
console.log(`\n📬 GET /api/skills/drafts → ${pending.length} pending`)
for (const d of pending) {
  console.log(`\n  🤖 "${d.draft_name}"`)
  console.log(`     ${d.draft_description}`)
  console.log(`     type: ${d.skill_type} | tool_calls: ${d.tool_call_count}`)
  console.log(`     source: "${d.source_task.slice(0, 55)}..."`)
}

// ── 5. Get draft detail — simulates GET /api/skills/drafts/:id ───────────────
const detail = db.prepare('SELECT * FROM skill_drafts WHERE id = ?').get(draftId)
const plan = p(detail.execution_plan)
console.log(`\n🔍 GET /api/skills/drafts/${draftId.slice(0, 8)} (full plan)`)
console.log(`  strategy: "${plan.strategy.slice(0, 70)}..."`)
console.log(`  steps: ${plan.steps.length}`)
for (const step of plan.steps) {
  console.log(`    Step ${step.number}: [${step.action_type}] ${step.description}`)
  if (step.url) console.log(`      url: ${step.url}`)
  if (step.selectors?.length) console.log(`      selectors: ${step.selectors.join(', ')}`)
  if (step.value) console.log(`      value: ${step.value}`)
}
if (plan.variables?.length) {
  console.log(`  variables:`)
  for (const v of plan.variables) console.log(`    {{${v.name}}} — ${v.description} (e.g. "${v.example}")`)
}

// ── 6. Create skill from draft — simulates POST /api/skills/drafts/:id/create ─
console.log(`\n🖱️  Creating skill from draft...`)

const newSkillId = randomUUID()
db.prepare(`
  INSERT INTO skills (id, user_id, skill_name, skill_description, execution_plan, status, plan_approved_at)
  VALUES (?, ?, ?, ?, ?, 'active', datetime('now'))
`).run(
  newSkillId, userId,
  detail.draft_name,
  detail.draft_description,
  detail.execution_plan,
)
db.prepare(`UPDATE skill_drafts SET status = 'created', resolved_at = datetime('now') WHERE id = ?`).run(draftId)

const newSkill = db.prepare('SELECT * FROM skills WHERE id = ?').get(newSkillId)
const afterDraft = db.prepare('SELECT status FROM skill_drafts WHERE id = ?').get(draftId)
console.log(`  ✅ Skill created: "${newSkill.skill_name}" (${newSkillId.slice(0, 8)}...)`)
console.log(`  Draft status: ${afterDraft.status}`)

// ── 7. Test dedup guard ───────────────────────────────────────────────────────
console.log('\n🔄 Dedup check: same source task after draft was resolved...')
const dupTask = 'Search LinkedIn for remote Python developer jobs posted this week and list the top 5'
const existing = db.prepare(`
  SELECT id FROM skill_drafts
  WHERE user_id = ? AND status = 'pending' AND source_task LIKE ?
  LIMIT 1
`).get(userId, `${dupTask.slice(0, 60)}%`)

if (existing) {
  console.log('  Has pending match — dedup would block creation')
} else {
  console.log('  No pending match — resolved drafts don\'t block new suggestions (correct)')
}

// ── 8. Test dismiss flow ──────────────────────────────────────────────────────
console.log('\n⏭️  Testing dismiss flow...')
const dismissId = randomUUID()
db.prepare(`
  INSERT INTO skill_drafts
    (id, user_id, draft_name, draft_description, skill_type, execution_plan, source_task, tool_call_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(dismissId, userId, 'github-star-repo', 'Star a GitHub repository', 'browser', j({ steps: [] }), 'Go star facebook/react on GitHub', 4)

db.prepare(`UPDATE skill_drafts SET status = 'dismissed', resolved_at = datetime('now') WHERE id = ?`).run(dismissId)
const dismissed = db.prepare('SELECT status FROM skill_drafts WHERE id = ?').get(dismissId)
console.log(`  Draft dismissed → status: ${dismissed.status}`)

// ── 9. Final state ────────────────────────────────────────────────────────────
const pending2 = db.prepare(`SELECT COUNT(*) as cnt FROM skill_drafts WHERE user_id = ? AND status = 'pending'`).get(userId)
const created = db.prepare(`SELECT COUNT(*) as cnt FROM skill_drafts WHERE user_id = ? AND status = 'created'`).get(userId)
const dismissed2 = db.prepare(`SELECT COUNT(*) as cnt FROM skill_drafts WHERE user_id = ? AND status = 'dismissed'`).get(userId)

console.log('\n📊 Final state:')
console.log(`  pending:   ${pending2.cnt}`)
console.log(`  created:   ${created.cnt}`)
console.log(`  dismissed: ${dismissed2.cnt}`)

// Cleanup: remove the test skill we created
db.prepare('DELETE FROM skills WHERE id = ?').run(newSkillId)
console.log('\n🧹 Cleaned up test skill.')
console.log('\n🎉 Feature 3 test complete.')
