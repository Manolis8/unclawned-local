/**
 * Test: Improvement Proposals (Feature 1)
 * Tests the full DB/routing flow without needing a running server or API keys.
 *
 * Run: node test-proposals.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const db = new DatabaseSync(join(homedir(), '.unclawned', 'openclaw.db'))
db.exec('PRAGMA journal_mode = WAL')
const j = v => JSON.stringify(v)
const p = v => { try { return JSON.parse(v) } catch { return v } }

// Bootstrap tables (server normally does this on startup)
db.exec(`CREATE TABLE IF NOT EXISTS skill_improvement_proposals (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, skill_id TEXT NOT NULL, execution_id TEXT NOT NULL,
  summary TEXT, issues TEXT, suggestions TEXT, step_updates TEXT, updated_plan TEXT,
  new_learning TEXT, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), resolved_at TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, version INTEGER NOT NULL,
  execution_plan TEXT NOT NULL, changed_at TEXT DEFAULT (datetime('now')), change_reason TEXT
)`)

// ── 1. Pick first active skill ────────────────────────────────────────────────
const skill = db.prepare(`SELECT * FROM skills WHERE status = 'active' LIMIT 1`).get()
if (!skill) { console.error('❌ No active skills found. Create a skill first.'); process.exit(1) }

const plan = p(skill.execution_plan)
console.log(`\n✅ Skill: "${skill.skill_name}" (${skill.id})`)
console.log(`   Steps in plan: ${plan?.steps?.length ?? 0}  |  Current version: ${skill.version ?? 1}`)

// ── 2. Stage a mock proposal (simulates what executeSkillAsync does) ──────────
const proposalId = randomUUID()
const userId = skill.user_id
const fakeExecId = randomUUID()

const mockStepUpdates = plan?.steps?.length
  ? [{ stepNumber: plan.steps[0].number, field: 'selectors', newValue: ["getByRole('combobox', { name: 'Search' })"], reason: 'Agent typed into this element successfully (eN)' }]
  : []

db.prepare(`
  INSERT INTO skill_improvement_proposals
    (id, user_id, skill_id, execution_id, summary, issues, suggestions, step_updates, updated_plan, new_learning, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
`).run(
  proposalId, userId, skill.id, fakeExecId,
  'Agent completed the task but used internal element handle (eN) — inferred a reusable Playwright locator.',
  j(['Step 1 used element handle eN instead of a named locator']),
  j(['Add getByRole selector for the search input so future runs are more reliable']),
  j(mockStepUpdates),
  null,
  'Google search box: getByRole("combobox") — typed search query',
)

console.log(`\n✅ Proposal staged: ${proposalId.slice(0, 8)}...`)

// ── 3. List pending — simulates GET /api/skills/proposals ────────────────────
const pending = db.prepare(`
  SELECT p.*, s.skill_name
  FROM skill_improvement_proposals p
  JOIN skills s ON s.id = p.skill_id
  WHERE p.user_id = ? AND p.status = 'pending'
  ORDER BY p.created_at DESC
`).all(userId)

console.log(`\n📬 GET /api/skills/proposals → ${pending.length} pending`)
for (const prop of pending) {
  console.log(`  💡 [${prop.id.slice(0,8)}] "${prop.skill_name}"`)
  console.log(`     summary: ${prop.summary?.slice(0, 70)}`)
  console.log(`     patches: ${p(prop.step_updates)?.length ?? 0}`)
}

// ── 4. Fetch detail — simulates GET /api/skills/proposals/:id ────────────────
const detail = db.prepare('SELECT * FROM skill_improvement_proposals WHERE id = ?').get(proposalId)
const currentPlan = p(skill.execution_plan)

console.log(`\n🔍 GET /api/skills/proposals/${proposalId.slice(0,8)} (detail + diff data)`)
console.log('  summary:', detail.summary)

const patches = p(detail.step_updates) || []
if (patches.length && currentPlan?.steps) {
  const step = currentPlan.steps.find(s => s.number === patches[0].stepNumber)
  console.log('\n  📝 Diff the frontend renders:')
  console.log(`  Step ${patches[0].stepNumber} — field: "${patches[0].field}"`)
  console.log(`    BEFORE: ${JSON.stringify(step?.selectors ?? [])}`)
  console.log(`    AFTER:  ${JSON.stringify(patches[0].newValue)}`)
  console.log(`    Reason: ${patches[0].reason}`)
} else {
  console.log('  (no step patches — plan had no steps to patch)')
}

// ── 5. Apply — simulates POST /api/skills/proposals/:id/apply ────────────────
console.log('\n🖱️  Applying proposal...')

if (patches.length && currentPlan?.steps) {
  const patchedSteps = currentPlan.steps.map(step => {
    const patch = patches.find(u => u.stepNumber === step.number)
    if (!patch) return step
    if (patch.field === 'selectors') {
      return { ...step, selectors: [...new Set([...patch.newValue, ...(step.selectors || [])])] }
    }
    return { ...step, [patch.field]: patch.newValue }
  })
  const patchedPlan = { ...currentPlan, steps: patchedSteps }
  const currentVersion = skill.version ?? 1
  db.prepare('INSERT INTO skill_versions (id, skill_id, version, execution_plan, change_reason) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), skill.id, currentVersion, skill.execution_plan, 'test-apply')
  db.prepare('UPDATE skills SET execution_plan = ?, version = ? WHERE id = ?')
    .run(j(patchedPlan), currentVersion + 1, skill.id)
  console.log(`  Plan updated — version bumped from ${currentVersion} → ${currentVersion + 1}`)
} else {
  console.log('  (no patches to apply — skipping plan update)')
}

db.prepare(`UPDATE skill_improvement_proposals SET status = 'applied', resolved_at = datetime('now') WHERE id = ?`)
  .run(proposalId)

// ── 6. Verify state ───────────────────────────────────────────────────────────
const afterSkill = db.prepare('SELECT version FROM skills WHERE id = ?').get(skill.id)
const afterProposal = db.prepare('SELECT status FROM skill_improvement_proposals WHERE id = ?').get(proposalId)
const versionHistory = db.prepare('SELECT version, change_reason FROM skill_versions WHERE skill_id = ? ORDER BY version DESC LIMIT 3').all(skill.id)

console.log('\n📊 Final state:')
console.log(`  skill version: ${afterSkill.version}`)
console.log(`  proposal: ${afterProposal.status}`)
console.log(`  version history (last 3):`)
for (const v of versionHistory) console.log(`    v${v.version}: "${v.change_reason}"`)

// ── 7. Confirm GET /proposals returns 0 pending now ──────────────────────────
const stillPending = db.prepare(`SELECT COUNT(*) as cnt FROM skill_improvement_proposals WHERE user_id = ? AND status = 'pending'`).get(userId)
console.log(`  pending proposals remaining: ${stillPending.cnt}`)

console.log('\n🎉 Feature 1 test complete.')
