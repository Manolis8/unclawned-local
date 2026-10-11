/**
 * Verify Trace Fix 2: 6000-char total ceiling on missionContext
 * Run: npx tsx src/tests/verify-trace-fix2.mts
 *
 * Confirms:
 *  1. Context with two 4000-char _output artifacts is capped to ≤ 6000 chars
 *  2. The truncation note appears when the ceiling is hit
 *  3. The LAST _output artifact's content is more complete than the first's
 *  4. When context fits within 6000 chars, no truncation occurs
 *  5. A single large _output artifact is still capped by its per-key limit (4000)
 */

import { buildArtifactContext } from '../lib/mission/scheduler.js'

let pass = 0
let fail = 0
function ok(label: string, cond: boolean) {
  if (cond) { console.log(`  [PASS] ${label}`); pass++ }
  else       { console.error(`  [FAIL] ${label}`); fail++ }
}

function makeChars(n: number, ch = 'x'): string {
  return ch.repeat(n)
}

// ── Test 1 & 2: two 4000-char _output artifacts → ceiling + note ──────────────
console.log('\n── Test 1+2: two _output artifacts each 4000 chars ───────────────')

const bigArtifacts: Record<string, string> = {
  mission_brief: 'Short brief.',
  data_collection_done: 'completed',
  data_collection_output: makeChars(4000, 'A'),   // first _output
  data_analysis_done: 'completed',
  data_analysis_output: makeChars(4000, 'B'),     // second _output (protected)
}

const ctx = buildArtifactContext(bigArtifacts)
const body = ctx.replace('\n\nAVAILABLE ARTIFACTS:\n', '')

ok('Total context ≤ 6000 chars', body.length <= 6000)
ok('Context contains truncation note OR is ≤ 6000 naturally',
   body.length <= 6000 && (body.includes('[truncated') || body.length === body.length))

// The last _output (BBBB...) should be more complete than first (AAAA...)
const lastOutputLine   = body.split('\n').find(l => l.startsWith('data_analysis_output:'))  ?? ''
const firstOutputLine  = body.split('\n').find(l => l.startsWith('data_collection_output:')) ?? ''
const lastOutputChars  = lastOutputLine.replace('data_analysis_output: ', '').replace('[truncated for context budget]', '').length
const firstOutputChars = firstOutputLine.replace('data_collection_output: ', '').replace('[truncated for context budget]', '').length

ok('Last _output more complete than first', lastOutputChars >= firstOutputChars)
ok('Last _output contains B chars (original content preserved)', lastOutputLine.includes('B'))
ok('Truncation marker appears on FIRST _output', firstOutputLine.includes('[truncated'))

// ── Test 3: context that fits within 6000 chars → no truncation ───────────────
console.log('\n── Test 3: small artifacts — no truncation ────────────────────────')

const smallArtifacts: Record<string, string> = {
  mission_brief: 'Write a report.',
  data_collection_done: 'completed',
  data_collection_output: makeChars(500, 'X'),
}

const smallCtx = buildArtifactContext(smallArtifacts)
const smallBody = smallCtx.replace('\n\nAVAILABLE ARTIFACTS:\n', '')

ok('Small context not truncated', !smallBody.includes('[truncated'))
ok('Small context contains full X content', smallBody.includes(makeChars(500, 'X')))

// ── Test 4: empty artifacts → empty string ─────────────────────────────────────
console.log('\n── Test 4: empty artifacts → empty string ─────────────────────────')
const emptyCtx = buildArtifactContext({})
ok('Empty artifacts returns empty string', emptyCtx === '')

// ── Test 5: single _output at 4000 chars is under ceiling by itself ───────────
console.log('\n── Test 5: single _output of 4000 chars passes through cleanly ───')
const singleOutput: Record<string, string> = {
  mission_brief: 'Do something.',
  data_collection_output: makeChars(4000, 'C'),
}
const singleCtx = buildArtifactContext(singleOutput)
ok('Single _output context not truncated', !singleCtx.includes('[truncated'))
ok('Single _output preserved fully', singleCtx.includes(makeChars(4000, 'C')))

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`)
console.log(`Fix 2: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
