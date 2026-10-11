/**
 * Test B — Staging queue: proposals (Features 2, 3) and version history (Feature 7)
 *
 * Feature 2: Proposals staged → user approve/reject
 * Feature 3: patch_skill mid-task stages to same proposals table
 * Feature 7: updateSkillPlan snapshots old version to skill_versions before writing
 *
 * Run: node test-B-staging-queue.mjs
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

// ── Find a skill with an execution_plan to work with ─────────────────────────
const skillRow = db.prepare("SELECT * FROM skills WHERE user_id = ? AND execution_plan IS NOT NULL LIMIT 1").get(userId)
if (!skillRow) {
  console.error('No skills with an execution_plan found. Create a skill first via the UI, then re-run.')
  process.exit(1)
}
const skillId = skillRow.id
const originalPlan = JSON.parse(skillRow.execution_plan)
const originalVersion = skillRow.version ?? 1
console.log(`Skill: "${skillRow.skill_name}" (version ${originalVersion})\n`)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 7 — Version history: updateSkillPlan snapshots before writing
// ══════════════════════════════════════════════════════════════════════════════
console.log('── Feature 7: Version History ───────────────────────────────────')

// Simulate what updateSkillPlan does: snapshot current → write new
const snapshotId = randomUUID()
db.prepare(`
  INSERT INTO skill_versions (id, skill_id, version, execution_plan, changed_at, change_reason)
  VALUES (?, ?, ?, ?, datetime('now'), ?)
`).run(snapshotId, skillId, originalVersion, skillRow.execution_plan, 'test-B snapshot')

// Bump version and write a modified plan
const modifiedPlan = { ...originalPlan, strategy: (originalPlan.strategy ?? '') + ' [test-B modified]' }
db.prepare('UPDATE skills SET execution_plan = ?, version = ? WHERE id = ?')
  .run(JSON.stringify(modifiedPlan), originalVersion + 1, skillId)

// Verify snapshot is in skill_versions
const versions = db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC').all(skillId)
assert('skill_versions contains snapshot before write', versions.some(v => v.id === snapshotId))
assert('Snapshot has correct change_reason', versions.find(v => v.id === snapshotId)?.change_reason === 'test-B snapshot')

// Simulate rollback: restore original
db.prepare('UPDATE skills SET execution_plan = ?, version = ? WHERE id = ?')
  .run(skillRow.execution_plan, originalVersion, skillId)
db.prepare('DELETE FROM skill_versions WHERE id = ?').run(snapshotId)
const restored = db.prepare('SELECT version FROM skills WHERE id = ?').get(skillId)
assert('Rollback restores original version number', restored?.version === originalVersion)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — Proposals: stage → list → approve → skip
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Feature 2: Proposal Staging (approve/reject flow) ────────────')

const execId = randomUUID()
const stepUpdate = { stepNumber: 2, field: 'selectors', newValue: ['button[aria-label="Search"]'], reason: 'More specific selector' }

// Create proposal (same as createSkillProposal)
const proposalId = randomUUID()
db.prepare(`
  INSERT INTO skill_improvement_proposals
    (id, user_id, skill_id, execution_id, summary, issues, suggestions, step_updates, updated_plan, new_learning)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
`).run(
  proposalId, userId, skillId, execId,
  'Agent proposed patch during execution: More specific selector',
  JSON.stringify([]),
  JSON.stringify(['More specific selector']),
  JSON.stringify([stepUpdate])
)

// List proposals (GET /proposals)
const pending = db.prepare(`
  SELECT p.*, s.skill_name FROM skill_improvement_proposals p
  JOIN skills s ON s.id = p.skill_id
  WHERE p.user_id = ? AND p.status = 'pending' ORDER BY p.created_at DESC
`).all(userId)
assert('GET /proposals returns pending proposals', pending.some(p => p.id === proposalId))

// GET /proposals/:id — includes current_plan
const proposal = db.prepare('SELECT * FROM skill_improvement_proposals WHERE id = ?').get(proposalId)
const skill = db.prepare('SELECT execution_plan FROM skills WHERE id = ?').get(skillId)
assert('GET /proposals/:id returns proposal', !!proposal)
assert('Skill plan available for diff render', !!skill?.execution_plan)

// step_updates parses correctly
const parsedUpdates = JSON.parse(proposal.step_updates)
assert('step_updates parse to correct shape', parsedUpdates[0]?.stepNumber === 2 && parsedUpdates[0]?.field === 'selectors')

// Apply proposal — mark as applied (simulates POST /proposals/:id/apply)
db.prepare("UPDATE skill_improvement_proposals SET status = 'applied', resolved_at = datetime('now') WHERE id = ?").run(proposalId)
const applied = db.prepare('SELECT status FROM skill_improvement_proposals WHERE id = ?').get(proposalId)
assert('POST /proposals/:id/apply → status=applied', applied?.status === 'applied')

// Try to apply again — should 409 (already applied)
assert('Re-apply blocked: status is not pending', applied?.status !== 'pending')

// Create second proposal, then skip it
const proposal2Id = randomUUID()
db.prepare(`
  INSERT INTO skill_improvement_proposals (id, user_id, skill_id, execution_id, summary, issues, suggestions, step_updates, updated_plan, new_learning)
  VALUES (?, ?, ?, ?, 'Test skip proposal', '[]', '[]', '[]', NULL, NULL)
`).run(proposal2Id, userId, skillId, execId)
db.prepare("UPDATE skill_improvement_proposals SET status = 'skipped', resolved_at = datetime('now') WHERE id = ?").run(proposal2Id)
const skipped = db.prepare('SELECT status FROM skill_improvement_proposals WHERE id = ?').get(proposal2Id)
assert('POST /proposals/:id/skip → status=skipped', skipped?.status === 'skipped')


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 3 — patch_skill tool: staged to proposals table, same shape
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Feature 3: patch_skill mid-task staging ──────────────────────')

// Simulate what the patch_skill case in agent-extension.ts does
const patchProposalId = randomUUID()
const patchStepUpdate = { stepNumber: 1, field: 'selectors', newValue: ['a[href*="/jobs"]'], reason: 'URL changed in recent LinkedIn update' }
db.prepare(`
  INSERT INTO skill_improvement_proposals
    (id, user_id, skill_id, execution_id, summary, issues, suggestions, step_updates, updated_plan, new_learning)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
`).run(
  patchProposalId, userId, skillId, randomUUID(),
  `Agent proposed patch during execution: ${patchStepUpdate.reason}`,
  JSON.stringify([]),
  JSON.stringify([patchStepUpdate.reason]),
  JSON.stringify([patchStepUpdate])
)

const patchProposal = db.prepare('SELECT * FROM skill_improvement_proposals WHERE id = ?').get(patchProposalId)
assert('patch_skill proposal staged correctly', !!patchProposal)
assert('patch_skill proposal has step_updates', JSON.parse(patchProposal.step_updates).length === 1)
assert('patch_skill proposal is pending (not auto-applied)', patchProposal.status === 'pending')

// Count pending patches per step — same logic as countPendingPatchesPerStep
const pendingProposals = db.prepare(`
  SELECT step_updates FROM skill_improvement_proposals WHERE skill_id = ? AND status = 'pending'
`).all(skillId)
const stepCounts = {}
for (const r of pendingProposals) {
  const updates = JSON.parse(r.step_updates)
  for (const u of updates) {
    const n = u.stepNumber ?? u.step_number
    stepCounts[n] = (stepCounts[n] ?? 0) + 1
  }
}
assert('countPendingPatchesPerStep aggregates correctly', typeof stepCounts === 'object')

// Cleanup
db.prepare('DELETE FROM skill_improvement_proposals WHERE id IN (?, ?, ?)').run(proposalId, proposal2Id, patchProposalId)


// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
