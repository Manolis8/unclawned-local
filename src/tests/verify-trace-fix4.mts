/**
 * Verify Trace Fix 4: createMissionFromPlan() is atomic (wrapped in transaction)
 * Run: npx tsx src/tests/verify-trace-fix4.mts
 *
 * Confirms:
 *  1. Happy path: all records created when plan is valid
 *  2. Rollback path: when an error occurs mid-plan, NO partial records remain
 *  3. Transaction leaves DB in a consistent state
 */

import { db } from '../lib/db.js'
import { initMissionTables, createMissionFromPlan, getMission } from '../lib/mission/state-store.js'

initMissionTables()

let pass = 0
let fail = 0
function ok(label: string, cond: boolean) {
  if (cond) { console.log(`  [PASS] ${label}`); pass++ }
  else       { console.error(`  [FAIL] ${label}`); fail++ }
}

const validPlan = {
  brief: 'Collect HN data and write a report.',
  divisions: [
    {
      role: 'Data Collection',
      goal: 'Collect top 10 HN posts.',
      dependsOnRoles: [],
      jobs: [
        { description: 'Visit HN and collect top 10 posts.', toolSet: 'browser' as const },
      ],
    },
    {
      role: 'Report Writing',
      goal: 'Write the report.',
      dependsOnRoles: ['Data Collection'],
      jobs: [
        { description: 'Write the markdown report.', toolSet: 'local' as const },
      ],
    },
  ],
}

// ── Test 1: Happy path — all records created ──────────────────────────────────
console.log('\n── Test 1: happy path — all records created ───────────────────────')

const mission = createMissionFromPlan({ userId: 'trace-fix4-user', goal: 'HN research', plan: validPlan })

const mRow = db.prepare('SELECT * FROM missions WHERE id = ?').get(mission.id) as any
ok('Mission row exists', !!mRow)
ok('Mission status = running', mRow?.status === 'running')

const divRows = db.prepare('SELECT * FROM divisions WHERE mission_id = ?').all(mission.id) as any[]
ok('Two divisions created', divRows.length === 2)
ok('Division 1 role correct', divRows.some(d => d.role === 'Data Collection'))
ok('Division 2 role correct', divRows.some(d => d.role === 'Report Writing'))

const jobRows = db.prepare('SELECT * FROM jobs WHERE mission_id = ?').all(mission.id) as any[]
ok('Two jobs created', jobRows.length === 2)

const artifactRows = db.prepare('SELECT * FROM artifacts WHERE mission_id = ?').all(mission.id) as any[]
ok('mission_brief artifact created', artifactRows.some(a => a.key === 'mission_brief'))

const depRows = db.prepare(`
  SELECT dd.* FROM division_dependencies dd
  JOIN divisions d ON d.id = dd.division_id
  WHERE d.mission_id = ?
`).all(mission.id) as any[]
ok('Dependency row created for Report Writing', depRows.some(d => d.artifact_key === 'data_collection_done'))

// ── Test 2: Rollback path — no partial records on failure ─────────────────────
console.log('\n── Test 2: rollback on failure — no partial records ───────────────')

// Plan with a null description to trigger a NOT NULL constraint error during createJob
const badPlan = {
  brief: 'Bad plan.',
  divisions: [
    {
      role: 'Good Division',
      goal: 'Fine goal.',
      dependsOnRoles: [],
      jobs: [
        { description: 'Normal job.', toolSet: 'local' as const },
        { description: null as any, toolSet: 'local' as const },  // will throw on INSERT (description NOT NULL)
      ],
    },
  ],
}

let threwError = false
let errorMissionId: string | undefined
try {
  const badMission = createMissionFromPlan({ userId: 'trace-fix4-user', goal: 'should roll back', plan: badPlan })
  errorMissionId = badMission.id
} catch {
  threwError = true
}

ok('createMissionFromPlan threw on bad plan', threwError)

// Find missions created for 'should roll back' goal — should be none
const orphaned = db.prepare("SELECT id FROM missions WHERE goal = 'should roll back'").all() as any[]
ok('No orphaned mission row (rolled back)', orphaned.length === 0)

if (errorMissionId) {
  const orphanedDivs = db.prepare('SELECT * FROM divisions WHERE mission_id = ?').all(errorMissionId) as any[]
  ok('No orphaned divisions (rolled back)', orphanedDivs.length === 0)
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
db.prepare('DELETE FROM approval_requests WHERE mission_id = ?').run(mission.id)
db.prepare('DELETE FROM jobs WHERE mission_id = ?').run(mission.id)
const divIds = (db.prepare('SELECT id FROM divisions WHERE mission_id = ?').all(mission.id) as any[]).map(r => r.id)
for (const id of divIds) db.prepare('DELETE FROM division_dependencies WHERE division_id = ?').run(id)
db.prepare('DELETE FROM divisions WHERE mission_id = ?').run(mission.id)
db.prepare('DELETE FROM artifacts WHERE mission_id = ?').run(mission.id)
db.prepare('DELETE FROM missions WHERE id = ?').run(mission.id)

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`)
console.log(`Fix 4: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
