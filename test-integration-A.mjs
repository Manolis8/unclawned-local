/**
 * Integration Test A — Background pipeline + Drafts + Gap proposals + Staleness
 * Covers: Features 1, 4, 5a
 *
 * Prerequisites: server running on localhost:3001 (npm run dev)
 * Run: node test-integration-A.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

const BASE = 'http://localhost:3001'

// ── Auth ──────────────────────────────────────────────────────────────────────
const db = new DatabaseSync(join(homedir(), '.unclawned', 'openclaw.db'))
const keyRow = db.prepare('SELECT user_id, key FROM api_keys LIMIT 1').get()
if (!keyRow) { console.error('No API key found in DB'); process.exit(1) }
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

// ── Check server is up ────────────────────────────────────────────────────────
try {
  await fetch(`${BASE}/api/skills`, { headers })
} catch {
  console.error(`\nServer not reachable at ${BASE}. Run "npm run dev" first.\n`)
  process.exit(1)
}
console.log(`\nServer OK — user: ${userId}\n`)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — Skill drafts (GET list, GET by id, create, dismiss)
// ══════════════════════════════════════════════════════════════════════════════
console.log('── Feature 1: Skill Drafts ──────────────────────────────────────')

// Seed a draft directly in DB (extractSkillDraftAsync needs LLM — seed manually)
const draftId = randomUUID()
db.prepare(`
  INSERT INTO skill_drafts (id, user_id, draft_name, draft_description, skill_type, execution_plan, source_task, tool_call_count)
  VALUES (?, ?, ?, ?, 'browser', ?, '__integ-test-A draft task__', 8)
`).run(draftId, userId, 'integ-test-linkedin', 'Search LinkedIn for jobs',
  JSON.stringify({ strategy: 'Navigate and search', steps: [
    { number: 1, description: 'Go to LinkedIn Jobs', action_type: 'navigate', url: 'https://linkedin.com/jobs', selectors: [] },
    { number: 2, description: 'Type job title', action_type: 'type', selectors: ['input[aria-label="Search"]'], value: '{{job_title}}' },
  ], variables: [{ name: 'job_title', description: 'What to search for', example: 'Python developer' }] })
)

// GET /api/skills/drafts
const listDrafts = await api('GET', '/api/skills/drafts')
ok('GET /api/skills/drafts → 200', listDrafts.status === 200)
ok('GET /api/skills/drafts → array', Array.isArray(listDrafts.body))
ok('Seeded draft appears in list', listDrafts.body.some(d => d.id === draftId))

// GET /api/skills/drafts/:id
const getDraft = await api('GET', `/api/skills/drafts/${draftId}`)
ok('GET /api/skills/drafts/:id → 200', getDraft.status === 200)
ok('Draft has execution_plan with steps', Array.isArray(getDraft.body.execution_plan?.steps))
ok('Draft has variables in plan', getDraft.body.execution_plan?.variables?.length > 0)

// POST /api/skills/drafts/:id/create — creates real skill from draft
const createFromDraft = await api('POST', `/api/skills/drafts/${draftId}/create`, {
  name: 'integ-test-linkedin-final',
  description: 'Integration test skill created from draft',
})
ok('POST /drafts/:id/create → 200', createFromDraft.status === 200)
ok('Response has skill.id', !!createFromDraft.body.skill?.id)
const createdSkillId = createFromDraft.body.skill?.id

// Verify draft is now status=created
const draftAfter = await api('GET', `/api/skills/drafts/${draftId}`)
ok('Draft status is now "created"', draftAfter.body.status === 'created')

// POST /api/skills/drafts/:id/create again → 409 (already resolved)
const reCreate = await api('POST', `/api/skills/drafts/${draftId}/create`)
ok('Re-create → 409 already resolved', reCreate.status === 409)

// Seed a second draft to test dismiss
const draft2Id = randomUUID()
db.prepare(`
  INSERT INTO skill_drafts (id, user_id, draft_name, draft_description, skill_type, execution_plan, source_task, tool_call_count)
  VALUES (?, ?, 'integ-test-dismiss', 'Will be dismissed', 'browser', '{}', '__integ-test-A dismiss__', 5)
`).run(draft2Id, userId)
const dismiss = await api('POST', `/api/skills/drafts/${draft2Id}/dismiss`)
ok('POST /drafts/:id/dismiss → 200', dismiss.status === 200)
const dismissedDraft = await api('GET', `/api/skills/drafts/${draft2Id}`)
ok('Dismissed draft status = "dismissed"', dismissedDraft.body.status === 'dismissed')


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 4 — Gap proposals (suggestions endpoint)
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Feature 4: Gap Proposals ─────────────────────────────────────')

// Seed gap events and a suggestion (checkAndSurfaceGapProposalsAsync needs 3+ events)
for (let i = 0; i < 3; i++) {
  db.prepare(`
    INSERT INTO skill_gap_events (id, user_id, stuck_description, stuck_type, current_url, current_page_type, task_description)
    VALUES (?, ?, 'Cookie banner appeared', 'friction_event', 'https://example.com', 'unknown', '__integ-test-A__')
  `).run(randomUUID(), userId)
}
const gapSuggId = randomUUID()
db.prepare(`
  INSERT INTO skill_suggestions (id, user_id, suggested_name, suggested_description, skill_type, source_task, tool_call_count)
  VALUES (?, ?, 'dismiss-friction-gates', 'Handle cookie banners', 'browser', 'gap-pattern:friction_event', 3)
`).run(gapSuggId, userId)

// GET /api/skills/suggestions
const suggestions = await api('GET', '/api/skills/suggestions')
ok('GET /api/skills/suggestions → 200', suggestions.status === 200)
ok('Gap suggestion appears in list', Array.isArray(suggestions.body) && suggestions.body.some(s => s.id === gapSuggId))
ok('Gap suggestion has gap-pattern source_task', suggestions.body.find(s => s.id === gapSuggId)?.source_task?.startsWith('gap-pattern:'))

// POST /api/skills/suggestions/:id/accept
const acceptSugg = await api('POST', `/api/skills/suggestions/${gapSuggId}/accept`)
ok('POST /suggestions/:id/accept → 200', acceptSugg.status === 200)
// Verify via list (no GET by id route — accepted ones move to status=accepted)
const suggAfterList = await api('GET', '/api/skills/suggestions?status=accepted')
ok('Suggestion status = accepted (visible in ?status=accepted)', suggAfterList.body.some(s => s.id === gapSuggId))


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 5a — Staleness: GET /api/skills/:id shows staleness field
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Feature 5a: Staleness fields on skill response ───────────────')

if (createdSkillId) {
  // Manually set staleness to check it comes through the API
  db.prepare('UPDATE skills SET staleness = ?, staleness_reason = ? WHERE id = ?')
    .run('stale', 'Failed 2 times in a row', createdSkillId)

  const staleSkill = await api('GET', `/api/skills/${createdSkillId}`)
  ok('GET /api/skills/:id → 200', staleSkill.status === 200)
  ok('staleness field present in response', staleSkill.body.staleness === 'stale')
  ok('staleness_reason field present in response', typeof staleSkill.body.staleness_reason === 'string')

  // Clear it
  db.prepare('UPDATE skills SET staleness = NULL, staleness_reason = NULL WHERE id = ?').run(createdSkillId)
  const cleared = await api('GET', `/api/skills/${createdSkillId}`)
  ok('staleness cleared → null in response', cleared.body.staleness === null)
}


// ══════════════════════════════════════════════════════════════════════════════
// Cleanup
// ══════════════════════════════════════════════════════════════════════════════
if (createdSkillId) db.prepare('DELETE FROM skills WHERE id = ?').run(createdSkillId)
db.prepare("DELETE FROM skill_gap_events WHERE task_description = '__integ-test-A__'").run()
db.prepare('DELETE FROM skill_suggestions WHERE id = ?').run(gapSuggId)

console.log(`\n${'─'.repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
