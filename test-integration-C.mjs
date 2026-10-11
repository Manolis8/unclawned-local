/**
 * Integration Test C — Lifecycle archival, Pin, Slash command
 * Covers: Features 5b, 6, 8
 *
 * Prerequisites: server running on localhost:3001 (npm run dev)
 * Run: node test-integration-C.mjs
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
console.log(`\nUser: ${userId}\n`)

// Create a test skill via the API so we have a real one to work with
const createRes = await api('POST', '/api/skills/save', {
  skill_name: '__integ-test-C lifecycle skill__',
  skill_description: 'Created by integration test C',
  execution_plan: {
    strategy: 'Test skill for lifecycle and pin tests',
    steps: [
      { number: 1, description: 'Navigate to site', action_type: 'navigate', url: 'https://example.com', selectors: [] },
    ],
    variables: [],
  },
})
const testSkillId = createRes.body?.skill?.id ?? createRes.body?.id
if (!testSkillId) {
  // Fallback: create directly in DB
  const id = randomUUID()
  db.prepare(`
    INSERT INTO skills (id, user_id, skill_name, skill_description, execution_plan, status, run_count, pinned)
    VALUES (?, ?, '__integ-test-C lifecycle skill__', 'Created by integration test C', '{}', 'active', 0, 0)
  `).run(id, userId)
}
const skillId = testSkillId ?? db.prepare(
  "SELECT id FROM skills WHERE user_id = ? AND skill_name = '__integ-test-C lifecycle skill__' LIMIT 1"
).get(userId)?.id
console.log(`Test skill ID: ${skillId}\n`)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 5b — Lifecycle archival
// ══════════════════════════════════════════════════════════════════════════════
console.log('── Feature 5b: Lifecycle Archival ───────────────────────────────')

// Simulate "unused for 100 days" — set run_count=5, last_run_at=100 days ago
db.prepare("UPDATE skills SET run_count=5, last_run_at=datetime('now','-100 days'), status='active', pinned=0 WHERE id=?").run(skillId)

// GET /api/skills triggers checkSkillLifecycle fire-and-forget → should archive it
const listBefore = await api('GET', '/api/skills')
ok('GET /api/skills → 200', listBefore.status === 200)

// Wait a tick for the fire-and-forget to complete
await new Promise(r => setTimeout(r, 300))

// Skill should now be archived — GET /api/skills (default) should not include it
const listAfterArchive = await api('GET', '/api/skills')
const appearsInDefault = listAfterArchive.body.some?.(s => s.id === skillId)
ok('Archived skill absent from default GET /api/skills', !appearsInDefault)

// GET /api/skills?include_archived=true — shows archived skill
const listArchived = await api('GET', '/api/skills?include_archived=true')
const appearsInArchived = listArchived.body.some?.(s => s.id === skillId)
ok('Archived skill present in ?include_archived=true', appearsInArchived)

// Verify the skill's own endpoint shows status=archived
const archivedDetail = await api('GET', `/api/skills/${skillId}`)
ok('GET /api/skills/:id → 200 (archived skills still fetchable)', archivedDetail.status === 200)
ok('Skill status is "archived"', archivedDetail.body.status === 'archived')

// POST /:skillId/restore
const restore = await api('POST', `/api/skills/${skillId}/restore`)
ok('POST /api/skills/:id/restore → 200', restore.status === 200)
ok('Restore response has status=active', restore.body.status === 'active')

// Skill reappears in default list
const listAfterRestore = await api('GET', '/api/skills')
const appearsAfterRestore = listAfterRestore.body.some?.(s => s.id === skillId)
ok('Restored skill appears in default GET /api/skills', appearsAfterRestore)

// Restored skill won't immediately re-archive (last_run_at reset to now)
await new Promise(r => setTimeout(r, 300))
const listAfterRestoreArchive = await api('GET', '/api/skills')
const stillPresent = listAfterRestoreArchive.body.some?.(s => s.id === skillId)
ok('Restored skill stays in default list (not re-archived)', stillPresent)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 6 — Pin mechanism
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Feature 6: Pin Mechanism ─────────────────────────────────────')

// Reset skill to active + old last_run_at (so archival would normally trigger)
db.prepare("UPDATE skills SET status='active', run_count=5, last_run_at=datetime('now','-100 days'), pinned=0 WHERE id=?").run(skillId)

// POST /:skillId/pin
const pin = await api('POST', `/api/skills/${skillId}/pin`)
ok('POST /api/skills/:id/pin → 200', pin.status === 200)
ok('Pin response has pinned=true', pin.body.pinned === true)

// Verify in skill detail
const pinned = await api('GET', `/api/skills/${skillId}`)
ok('GET /api/skills/:id shows pinned=1', pinned.body.pinned === 1)

// GET /api/skills triggers lifecycle — pinned skill should NOT be archived
await api('GET', '/api/skills')
await new Promise(r => setTimeout(r, 300))
const afterLifecycle = await api('GET', '/api/skills')
const pinnedInDefault = afterLifecycle.body.some?.(s => s.id === skillId)
ok('Pinned skill survives lifecycle archival (still in default list)', pinnedInDefault)

const stillActive = await api('GET', `/api/skills/${skillId}`)
ok('Pinned skill status still active after lifecycle run', stillActive.body.status === 'active')

// DELETE /:skillId/pin — unpin
const unpin = await api('DELETE', `/api/skills/${skillId}/pin`)
ok('DELETE /api/skills/:id/pin → 200', unpin.status === 200)
ok('Unpin response has pinned=false', unpin.body.pinned === false)

const unpinned = await api('GET', `/api/skills/${skillId}`)
ok('GET /api/skills/:id shows pinned=0 after unpin', unpinned.body.pinned === 0)


// ══════════════════════════════════════════════════════════════════════════════
// FEATURE 8 — Slash command via POST /chat
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Feature 8: Slash Command in Chat ─────────────────────────────')

// Give the test skill a recognisable name and restore it to active
db.prepare("UPDATE skills SET skill_name='Integ Test Search Skill', status='active', last_run_at=datetime('now'), pinned=0 WHERE id=?").run(skillId)

// Slash with no extra text → skill_loaded response (card)
const sessionId = randomUUID()
const slashCard = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: '/integ-test-search', userId, sessionId }),
}).then(r => r.json()).catch(() => ({}) )

if (slashCard.type === 'skill_loaded') {
  ok('POST /chat /slug (no task) → type=skill_loaded', true)
  ok('Response has skillId', slashCard.skillId === skillId)
  ok('Response has skillName', typeof slashCard.skillName === 'string')
  ok('Response has message (skill card)', typeof slashCard.message === 'string')
  ok('Skill card includes description', slashCard.message?.includes('Integ Test Search Skill'))
} else {
  // Slug may not have matched — check why
  console.log('  ⚠️  Slash card response:', JSON.stringify(slashCard).slice(0, 120))
  ok('POST /chat /slug → skill_loaded', false)
}

// Slash with extra text → skill_task response (runs a browser task)
const slashTask = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: '/integ-test-search find results for "python developer"', userId, sessionId: randomUUID() }),
}).then(r => r.json()).catch(() => ({}) )

if (slashTask.type === 'skill_task') {
  ok('POST /api/chat /slug task-text → type=skill_task', true)
  ok('skill_task response has taskId', typeof slashTask.taskId === 'string')
  ok('skill_task response has skillId', slashTask.skillId === skillId)
  ok('skill_task response has usesBrowser=true', slashTask.usesBrowser === true)
} else if (slashTask.taskAlreadyRunning) {
  console.log('  ℹ️  Another task is already running — /chat with task text skipped')
  ok('Slash task: server responded (task may already be running)', true)
} else {
  console.log('  ⚠️  Slash task response:', JSON.stringify(slashTask).slice(0, 120))
  ok('POST /api/chat /slug task-text → skill_task', false)
}

// Unknown slug → falls through to normal orchestration (not skill_loaded)
const slashUnknown = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: '/xyznonexistentskill99', userId, sessionId: randomUUID() }),
}).then(r => r.json()).catch(() => ({}) )
ok('Unknown slug falls through (not skill_loaded)', slashUnknown.type !== 'skill_loaded')

// Double-slash is not a slash command
const doubleSlash = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: '//this is a comment not a command', userId, sessionId: randomUUID() }),
}).then(r => r.json()).catch(() => ({}) )
ok('// prefix is not treated as slash command', doubleSlash.type !== 'skill_loaded')


// ══════════════════════════════════════════════════════════════════════════════
// Cleanup
// ══════════════════════════════════════════════════════════════════════════════
db.prepare('DELETE FROM skills WHERE id = ?').run(skillId)

console.log(`\n${'─'.repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
