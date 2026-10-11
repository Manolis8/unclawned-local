/**
 * Verify Fix 5: Token visibility — run from project root: npx tsx src/tests/verify-fix5.mts
 *
 * Checks:
 *  1. token_summary column exists in missions table after DB init
 *  2. trackTokens accumulates correctly across phases
 *  3. finalizeMissionTokens returns valid JSON with expected shape
 *  4. finalizeMissionTokens cleans up registry (second call returns {error:...})
 *  5. writeMissionTokenSummary persists JSON to missions row
 */

import { db } from '../lib/db.js'
import { trackTokens, finalizeMissionTokens } from '../lib/mission/token-tracker.js'
import { writeMissionTokenSummary, createMission, initMissionTables } from '../lib/mission/state-store.js'

// initMissionTables runs CREATE TABLE IF NOT EXISTS + safe ALTER TABLE migrations
initMissionTables()

let pass = 0
let fail = 0

function ok(label: string, cond: boolean) {
  if (cond) { console.log(`  [PASS] ${label}`); pass++ }
  else       { console.error(`  [FAIL] ${label}`); fail++ }
}

// ── Test 1: token_summary column exists ──────────────────────────────────────
console.log('\n── Test 1: token_summary column in missions table ───────────')
const cols = db.prepare("PRAGMA table_info(missions)").all() as Array<{ name: string }>
const colNames = cols.map((c: any) => c.name)
ok('missions.token_summary column exists', colNames.includes('token_summary'))

// ── Test 2: trackTokens accumulates per phase ────────────────────────────────
console.log('\n── Test 2: trackTokens accumulates correctly ─────────────────')
const MID = 'test-mission-fix5-' + Date.now()

trackTokens(MID, 'ceo_planning', 'grok-4.5', 1, 1000, 500)
trackTokens(MID, 'ceo_planning', 'grok-4.5', 2,  800, 400)
trackTokens(MID, 'mgr_planning', 'grok-4.5', 1,  600, 300)
trackTokens(MID, 'worker',       'grok-4.5', 1, 2000, 800)

// ── Test 3: finalizeMissionTokens returns valid JSON ─────────────────────────
console.log('\n── Test 3: finalizeMissionTokens returns valid JSON ──────────')
const json = finalizeMissionTokens(MID)
let parsed: any
try { parsed = JSON.parse(json); ok('JSON parses without error', true) }
catch { ok('JSON parses without error', false); parsed = {} }

ok('totalIn = 1000+800+600+2000 = 4400', parsed.totalIn === 4400)
ok('totalOut = 500+400+300+800 = 2000',  parsed.totalOut === 2000)
ok('totalTurns = 1+1+1+1 = 4',           parsed.totalTurns === 4)
ok('estCostUsd is a number',             typeof parsed.estCostUsd === 'number')
ok('phases object present',              typeof parsed.phases === 'object')

const ceoPlanPhase = parsed.phases?.['CEO planning']
ok('CEO planning phase present in phases', ceoPlanPhase !== undefined)
ok('CEO planning tokensIn = 1800',         ceoPlanPhase?.tokensIn === 1800)
ok('CEO planning turns = 2',               ceoPlanPhase?.turns === 2)

// ── Test 4: registry cleaned up after finalize ───────────────────────────────
console.log('\n── Test 4: finalizeMissionTokens cleans up registry ──────────')
const json2 = finalizeMissionTokens(MID)
const parsed2 = JSON.parse(json2)
ok('Second finalize returns {error} sentinel', 'error' in parsed2)

// ── Test 5: writeMissionTokenSummary persists to DB ──────────────────────────
console.log('\n── Test 5: writeMissionTokenSummary persists to missions row ─')
const mission = createMission({ userId: 'verify-fix5-user', goal: 'token-visibility-test' })
const tokenJson = JSON.stringify({ totalIn: 9999, totalOut: 1111, totalTurns: 7 })
writeMissionTokenSummary(mission.id, tokenJson)

const row = db.prepare('SELECT token_summary FROM missions WHERE id = ?').get(mission.id) as any
ok('token_summary row populated',        !!row?.token_summary)
ok('token_summary matches written JSON', row?.token_summary === tokenJson)

// cleanup
db.prepare('DELETE FROM missions WHERE id = ?').run(mission.id)

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`)
console.log(`Fix 5: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
