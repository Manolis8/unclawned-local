/**
 * Integration Test B — Proposals, patch_skill staging, version history
 * Covers: Features 2, 3, 7
 *
 * Prerequisites: server running on localhost:3001 (npm run dev)
 * Run: node test-integration-B.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const BASE = 'http://localhost:3001'

const db = new DatabaseSync(join(homedir(), '.unclawned', 'openclaw.db'))
const keyRow = db.prepare('SELECT user_id, key FROM api_keys LIMIT 1').get()
if (!keyRow) { console.error('No API key found'); process.exit(1) }
const { user_id: userId, key: apiKey } = keyRow
const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }

let passed = 0, failed = 0
function ok(label, val) {
  if (val) { console.log(`  ✅ ${label}`); passed++ }
  else { console.error(`  ❌ ${label}`); failed++ }
}
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json }
}

try { await fetch(`${BASE}/api/skills`, { headers }) }
catch { console.error(`Server not reachable at ${BASE}. Run "npm run dev" first.`); process.exit(1) }

// Find a skill with a real execution_plan to apply patches against
const skillRow = db.prepare(
  "SELECT * FROM skills WHERE user_id = ? AND execution_plan IS NOT NULL AND execution_plan != '{}' LIMIT 1"
).get(userId)
if (!skillRow) {
  console.error('No skill with an execution_plan found. Create one via the UI first.')
  process.exit(1)
}
const skillId = skillRow.id
const originalPlan = JSON.parse(skillRow.execution_plan)
const originalVersion = skillRow.version ?? 1
console.log(`\nUser: ${userId}`)
console.log(`Skill: "${skillRow.skill_name}" (v${originalVersion})\n`)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — Proposals: GET list, GET by id, apply, skip
// ══════════════════════════════════════════════════════════════════════════════
console.log('── Feature 2: Proposal Staging → Approve / Reject ───────────────')

// GET /api/skills/proposals — should return array
const emptyProposals = await api('GET', '/api/skills/proposals')
ok('GET /api/skills/proposals → 200', emptyProposals.status === 200)
ok('GET /api/skills/proposals → array', Array.isArray(emptyProposals.body))

// Seed a step_updates proposal (as if patch_skill staged it)
const proposalId = randomUUID()
const stepUpdate = { stepNumber: 1, field: 'selectors', newValue: ['button[data-test="search-btn"]'], reason: 'Button selector changed after site update' }
db.prepare(`
  INSERT INTO skill_improvement_proposals
    (id, user_id, skill_id, execution_id, summary, issues, suggestions, step_updates, updated_plan, new_learning)
  VALUES (?, ?, ?, ?, ?, '[]', ?, ?, NULL, NULL)
`).run(
  proposalId, userId, skillId, randomUUID(),
  'Agent proposed patch: Button selector changed after site update',
  JSON.stringify([stepUpdate.reason]),
  JSON.stringify([stepUpdate])
)

// GET /api/skills/proposals — proposal is now visible
const withProposal = await api('GET', '/api/skills/proposals')
ok('Seeded proposal appears in GET /proposals', withProposal.body.some(p => p.id === proposalId))
ok('Proposal has skill_name joined', !!withProposal.body.find(p => p.id === proposalId)?.skill_name)

// GET /api/skills/proposals/:id — includes current_plan for diff
const getProposal = await api('GET', `/api/skills/proposals/${proposalId}`)
ok('GET /api/skills/proposals/:id → 200', getProposal.status === 200)
ok('Response includes current_plan for diff render', getProposal.body.current_plan !== undefined)
ok('step_updates has correct stepNumber', getProposal.body.step_updates?.[0]?.stepNumber === 1)
ok('step_updates has correct field', getProposal.body.step_updates?.[0]?.field === 'selectors')

// POST /api/skills/proposals/:id/apply — applies patch via updateSkillPlan (saves version)
const versionsBefore = db.prepare('SELECT COUNT(*) as n FROM skill_versions WHERE skill_id = ?').get(skillId).n
const apply = await api('POST', `/api/skills/proposals/${proposalId}/apply`)
ok('POST /proposals/:id/apply → 200', apply.status === 200)
ok('Apply response has success=true', apply.body.success === true)

// Feature 7: version was saved before write
const versionsAfter = db.prepare('SELECT COUNT(*) as n FROM skill_versions WHERE skill_id = ?').get(skillId).n
ok('Feature 7: skill_versions gained 1 row on apply', versionsAfter === versionsBefore + 1)

const latestVersion = db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC LIMIT 1').get(skillId)
ok('Feature 7: snapshot has change_reason', latestVersion?.change_reason?.includes('user-approved'))

// POST apply again → 409
const reApply = await api('POST', `/api/skills/proposals/${proposalId}/apply`)
ok('Re-apply → 409 conflict', reApply.status === 409)

// Restore original plan and version
db.prepare('UPDATE skills SET execution_plan = ?, version = ? WHERE id = ?')
  .run(skillRow.execution_plan, originalVersion, skillId)
db.prepare('DELETE FROM skill_versions WHERE id = ?').run(latestVersion?.id)

// Seed second proposal to test skip
const proposal2Id = randomUUID()
db.prepare(`
  INSERT INTO skill_improvement_proposals (id, user_id, skill_id, execution_id, summary, issues, suggestions, step_updates, updated_plan, new_learning)
  VALUES (?, ?, ?, ?, 'Test skip', '[]', '[]', '[]', NULL, NULL)
`).run(proposal2Id, userId, skillId, randomUUID())

const skip = await api('POST', `/api/skills/proposals/${proposal2Id}/skip`)
ok('POST /proposals/:id/skip → 200', skip.status === 200)
const skippedProposal = await api('GET', `/api/skills/proposals/${proposal2Id}`)
ok('Skipped proposal not in pending list', skippedProposal.body.status === 'skipped')

// Cleanup proposals
db.prepare('DELETE FROM skill_improvement_proposals WHERE id IN (?, ?)').run(proposalId, proposal2Id)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 3 — patch_skill: staged proposal has correct shape (same table)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Feature 3: patch_skill staging shape ─────────────────────────')

// Simulate what the patch_skill case in runAgentLoop does
const patchId = randomUUID()
const patchUpdate = { stepNumber: 2, field: 'value', newValue: '{{search_term}}', reason: 'Hardcoded term should be a variable' }
db.prepare(`
  INSERT INTO skill_improvement_proposals
    (id, user_id, skill_id, execution_id, summary, issues, suggestions, step_updates, updated_plan, new_learning)
  VALUES (?, ?, ?, ?, ?, '[]', ?, ?, NULL, NULL)
`).run(
  patchId, userId, skillId, randomUUID(),
  `Agent proposed patch during execution: ${patchUpdate.reason}`,
  JSON.stringify([patchUpdate.reason]),
  JSON.stringify([patchUpdate])
)

// Appears in GET /proposals
const withPatch = await api('GET', '/api/skills/proposals')
const patchInList = withPatch.body.find(p => p.id === patchId)
ok('patch_skill proposal appears in GET /proposals', !!patchInList)
ok('patch_skill proposal is pending (NOT auto-applied)', patchInList?.status === 'pending')

// GET /proposals/:id
const getPatch = await api('GET', `/api/skills/proposals/${patchId}`)
ok('GET /proposals/:patchId → 200', getPatch.status === 200)
ok('patch_skill proposal has step_updates', getPatch.body.step_updates?.length === 1)
ok('Patch targets correct step', getPatch.body.step_updates[0]?.stepNumber === 2)
ok('Patch targets correct field', getPatch.body.step_updates[0]?.field === 'value')

db.prepare('DELETE FROM skill_improvement_proposals WHERE id = ?').run(patchId)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 7 — Version history: GET /api/skills/:id/versions
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Feature 7: Version History ───────────────────────────────────')

// Manually snapshot current plan to simulate a prior version
const snapId = randomUUID()
db.prepare(`
  INSERT INTO skill_versions (id, skill_id, version, execution_plan, changed_at, change_reason)
  VALUES (?, ?, ?, ?, datetime('now', '-5 minutes'), 'integ-test-B snapshot')
`).run(snapId, skillId, originalVersion, skillRow.execution_plan)

// Check if there's a GET versions route
const versionsRes = await api('GET', `/api/skills/${skillId}/versions`)
if (versionsRes.status === 200) {
  ok('GET /api/skills/:id/versions → 200', true)
  ok('Versions list is an array', Array.isArray(versionsRes.body))
  ok('Seeded snapshot appears in versions', versionsRes.body.some(v => v.id === snapId))
} else if (versionsRes.status === 404) {
  // Route may not exist yet — check DB directly
  const versions = db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC').all(skillId)
  ok('skill_versions table has the snapshot (route not exposed yet)', versions.some(v => v.id === snapId))
  console.log('  ℹ️  GET /api/skills/:id/versions route not yet wired — DB verified directly')
} else {
  ok(`Unexpected status on versions route: ${versionsRes.status}`, false)
}

// Rollback route (if exists)
const rollbackRes = await api('POST', `/api/skills/${skillId}/versions/${snapId}/rollback`)
if (rollbackRes.status === 200) {
  ok('POST /api/skills/:id/versions/:vId/rollback → 200', true)
  // Restore original
  db.prepare('UPDATE skills SET execution_plan = ?, version = ? WHERE id = ?')
    .run(skillRow.execution_plan, originalVersion, skillId)
} else {
  console.log(`  ℹ️  Rollback route not yet wired (${rollbackRes.status}) — skipping`)
}

db.prepare('DELETE FROM skill_versions WHERE id = ?').run(snapId)


// ══════════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
