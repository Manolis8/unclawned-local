/**
 * Verify Trace Fix 1: write_file approval gate for mission workers
 * Run: npx tsx src/tests/verify-trace-fix1.mts
 *
 * Confirms:
 *  1. createMissionConfirmationHandler queues an approval_request in DB
 *  2. The record has the correct fields (actionType, jobId, missionId, status=pending)
 *  3. When resolveApproval() is called, the handler polling returns 'approved'
 *  4. executeWriteFile() then writes the file to disk at the resolved path
 */

import { db } from '../lib/db.js'
import { initMissionTables, createMission, createDivision, createJob, resolveApproval, getPendingApprovals } from '../lib/mission/state-store.js'
import { createMissionConfirmationHandler } from '../lib/mission/scheduler.js'
import { previewWriteFile, executeWriteFile } from '../lib/local-agent/write-tools.js'
import type { ConfirmationRequest } from '../lib/agent-extension.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

initMissionTables()

let pass = 0
let fail = 0
function ok(label: string, cond: boolean) {
  if (cond) { console.log(`  [PASS] ${label}`); pass++ }
  else       { console.error(`  [FAIL] ${label}`); fail++ }
}

const MID = 'trace-fix1-' + Date.now()

// ── Setup: create mission / division / job in DB ──────────────────────────────
const mission  = createMission({ userId: 'trace-fix1-user', goal: 'write test file' })
const division = createDivision({ missionId: mission.id, goal: 'write report', role: 'Report Writing' })
const job      = createJob({ divisionId: division.id, missionId: mission.id, description: 'write the markdown report' })

const tmpPath = path.join(os.tmpdir(), `trace-fix1-${Date.now()}.md`)
const content = '# HN Success Analysis\n\nHello from Fix 1 test.'

// ── Test 1: Handler creates approval record in DB ─────────────────────────────
console.log('\n── Test 1: approval record created in DB ─────────────────────────')

const ac = new AbortController()

const mockReq: ConfirmationRequest = {
  id: 'mock-req-1',
  tier: 3,
  action_type: 'write_file',
  target: tmpPath,
  details: `${content.split('\n').length} lines will be written`,
  content: content.slice(0, 200),
  timestamp: Date.now(),
}

const handler = createMissionConfirmationHandler(
  mission.id, division.id, job.id,
  (msg) => { /* suppress progress output in test */ },
  ac.signal,
)

// Start handler in background — it will create the approval record then poll
const handlerPromise = handler(mockReq)

// Give the handler 150ms to create the approval record before we query
await new Promise(r => setTimeout(r, 150))

const pending = getPendingApprovals(mission.id)
ok('Approval record created in DB', pending.length === 1)
ok('Approval actionType = write_file', pending[0]?.actionType === 'write_file')
ok('Approval jobId matches', pending[0]?.jobId === job.id)
ok('Approval missionId matches', pending[0]?.missionId === mission.id)
ok('Approval status = pending', pending[0]?.status === 'pending')

// ── Test 2: Resolving approval makes handler return 'approved' ────────────────
console.log('\n── Test 2: handler returns approved after resolution ──────────────')

if (pending[0]) {
  resolveApproval(pending[0].id, 'approved')
}

// Handler polls every 500ms — wait up to 1.2s for it to see the resolution
const resp = await Promise.race([
  handlerPromise,
  new Promise<never>((_, rej) => setTimeout(() => rej(new Error('handler timed out')), 1200)),
]).catch(err => ({ decision: 'timeout', err: err.message } as any))

ok('Handler returns decision=approved', resp.decision === 'approved')

// ── Test 3: executeWriteFile writes the file when approved ────────────────────
console.log('\n── Test 3: file written to disk after approval ────────────────────')

if (resp.decision === 'approved') {
  const preview = previewWriteFile(tmpPath, content, 'create')
  await executeWriteFile(preview, content)
}

ok('File exists on disk', fs.existsSync(tmpPath))
ok('File content matches', fs.existsSync(tmpPath) && fs.readFileSync(tmpPath, 'utf-8') === content)

// ── Cleanup ───────────────────────────────────────────────────────────────────
ac.abort()
if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
db.prepare('DELETE FROM approval_requests WHERE mission_id = ?').run(mission.id)
db.prepare('DELETE FROM jobs WHERE mission_id = ?').run(mission.id)
db.prepare('DELETE FROM division_dependencies WHERE division_id = ?').run(division.id)
db.prepare('DELETE FROM divisions WHERE mission_id = ?').run(mission.id)
db.prepare('DELETE FROM missions WHERE id = ?').run(mission.id)

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`)
console.log(`Fix 1: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
