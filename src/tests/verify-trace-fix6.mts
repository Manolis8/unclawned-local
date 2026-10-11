/**
 * Verify Trace Fix 6: CEO synthesis skipped when all divisions fail
 * Run: npx tsx src/tests/verify-trace-fix6.mts
 *
 * Confirms:
 *  1. When all divisions have status='failed', launchCEOSynthesis() does NOT fire
 *     the LLM (no runCEOSynthesisPhase call — confirmed by mission status change being
 *     synchronous and mission reaching 'failed' before any await)
 *  2. Mission status becomes 'failed' with the static report
 *  3. token_summary is written to the missions row (finalizeMissionTokens fires)
 *  4. The ceo_synthesis_skipped event is logged
 *  5. When at least one division completed, CEO synthesis proceeds normally
 *     (we only verify it doesn't short-circuit — no LLM is actually called here
 *      since we abort the scheduler immediately)
 */

import { db } from '../lib/db.js'
import { initMissionTables, createMission, createDivision, getMission, getEvents } from '../lib/mission/state-store.js'
import { MissionScheduler, stopScheduler } from '../lib/mission/scheduler.js'

initMissionTables()

let pass = 0
let fail = 0
function ok(label: string, cond: boolean) {
  if (cond) { console.log(`  [PASS] ${label}`); pass++ }
  else       { console.error(`  [FAIL] ${label}`); fail++ }
}

// Helper: create a mission with divisions in given statuses, then start scheduler
// and let it run one tick
async function runScenario(divisionStatuses: ('completed' | 'failed')[]): Promise<string> {
  const mission = createMission({ userId: 'trace-fix6-user', goal: 'test ceo skip' })
  db.prepare("UPDATE missions SET status = 'running' WHERE id = ?").run(mission.id)

  for (let i = 0; i < divisionStatuses.length; i++) {
    const div = createDivision({ missionId: mission.id, goal: `div ${i}`, role: `Division ${i}` })
    // Pre-set division status — skip planning
    db.prepare('UPDATE divisions SET status = ?, planning_context = ? WHERE id = ?')
      .run(divisionStatuses[i], '{}', div.id)
  }

  return mission.id
}

// ── Test 1-4: all divisions failed → static failure, no LLM ──────────────────
console.log('\n── Tests 1-4: all divisions failed → skip CEO synthesis LLM ──────')

const failMissionId = await runScenario(['failed', 'failed', 'failed'])

const scheduler = new MissionScheduler(failMissionId, 'trace-fix6-user', () => {})

// Manually invoke launchCEOSynthesis via tick() — but since tick() is private
// we'll directly observe the scheduler's effect after running it for a short time.
// The scheduler's tick detects all divisions settled and triggers CEO synthesis check.
scheduler.start()

// Wait for synchronous CEO skip logic to fire (no async LLM = fast)
await new Promise(r => setTimeout(r, 200))

const failedMission = getMission(failMissionId)!
ok('Mission status = failed (static, no LLM)', failedMission?.status === 'failed')
ok('Final report is the static message', failedMission?.finalReport?.includes('all divisions encountered errors') ?? false)

const events = getEvents(failMissionId, 50)
ok('ceo_synthesis_skipped event logged', events.some(e => e.type === 'ceo_synthesis_skipped'))
ok('Reason is all_divisions_failed', events.some(e => e.type === 'ceo_synthesis_skipped' && (e.payload as any)?.reason === 'all_divisions_failed'))

const tokenRow = db.prepare('SELECT token_summary FROM missions WHERE id = ?').get(failMissionId) as any
// token_summary may be the error sentinel '{"error":"no token data..."}' since no tokens were tracked
ok('token_summary written (finalizeMissionTokens fired)', tokenRow?.token_summary != null)

// ── Test 5: at least one division completed → scheduler proceeds (not skipped) ─
console.log('\n── Test 5: one completed division → CEO synthesis not skipped ─────')

const partialMissionId = await runScenario(['completed', 'failed'])
const scheduler2 = new MissionScheduler(partialMissionId, 'trace-fix6-user', () => {})
scheduler2.start()

// Give it a moment — if CEO synthesis fires, the mission transitions away from 'running'
await new Promise(r => setTimeout(r, 150))
stopScheduler(partialMissionId)

// It shouldn't be instantly 'failed' with static message (would need real LLM to complete)
const partialMission = getMission(partialMissionId)
const staticSkipFired = partialMission?.finalReport?.includes('all divisions encountered errors') ?? false
ok('CEO not skipped when one division completed', !staticSkipFired)

// ── Cleanup ───────────────────────────────────────────────────────────────────
stopScheduler(failMissionId)
stopScheduler(partialMissionId)

for (const mId of [failMissionId, partialMissionId]) {
  db.prepare('DELETE FROM mission_events WHERE mission_id = ?').run(mId)
  db.prepare('DELETE FROM mission_checkpoints WHERE mission_id = ?').run(mId)
  const divIds = (db.prepare('SELECT id FROM divisions WHERE mission_id = ?').all(mId) as any[]).map(r => r.id)
  for (const id of divIds) db.prepare('DELETE FROM division_dependencies WHERE division_id = ?').run(id)
  db.prepare('DELETE FROM divisions WHERE mission_id = ?').run(mId)
  db.prepare('DELETE FROM missions WHERE id = ?').run(mId)
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`)
console.log(`Fix 6: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
