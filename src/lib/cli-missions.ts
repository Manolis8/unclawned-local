import type readline from 'node:readline'
import { scoreMissionComplexity, subscribeMissionProgress, broadcastProgress } from './mission/controller.js'
import { MissionScheduler } from './mission/scheduler.js'
import { logEvent, resolveApproval, initMissionTables } from './mission/state-store.js'
import {
  getMission,
  getMissionsForUser,
  getDivisionsForMission,
  getJobsForDivision,
  getArtifactsForMission,
  getPendingApprovals,
} from './mission/state-store.js'

const LINE = '─'.repeat(60)

// ─── Dynamic orchestrator flow ────────────────────────────────────────────────

const CANCEL_WORDS = new Set(['q', 'quit', 'cancel', 'exit', 'n', 'no', 'esc', 'abort'])

async function runPlannerFlow(
  goal: string,
  userId: string,
  promptFn: (q: string) => Promise<string>
): Promise<void> {
  initMissionTables()

  const L = '─'.repeat(55)
  console.log(`\n${L}`)
  console.log('  ⚡ Starting dynamic mission — agents will spawn as needed.')
  console.log('     You will be asked to approve any irreversible actions.')
  console.log('     Press Ctrl+C to stop at any time.')
  console.log(`${L}\n`)

  const { runDynamicOrchestrator } = await import('./orchestrator.js')

  try {
    await runDynamicOrchestrator(
      goal,
      userId,
      (msg: string) => console.log('  ' + msg),
      promptFn,
    )
  } catch (err: any) {
    console.error(`\n  ❌ Mission failed: ${err?.message}\n`)
  }
}

// ─── Status icons ──────────────────────────────────────────────────────────────

function mIcon(s: string): string {
  return { planning: '🧠', running: '⚡', paused: '⏸', completed: '✅', failed: '❌', aborted: '🛑' }[s] ?? '○'
}
function dIcon(s: string): string {
  return { pending: '○', planning: '🧠', executing: '⚡', synthesizing: '📊', completed: '✅', failed: '❌' }[s] ?? '○'
}
function jIcon(s: string): string {
  return { pending: '○', running: '⚡', completed: '✅', failed: '❌' }[s] ?? '○'
}

// ─── List ─────────────────────────────────────────────────────────────────────

async function listMissions(userId: string): Promise<void> {
  const missions = getMissionsForUser(userId)
  console.log(`\n${LINE}`)
  console.log('  MISSIONS')
  console.log(LINE)
  if (!missions.length) {
    console.log('  No missions yet.')
    console.log('  Just describe a complex multi-part goal and Mission Mode will be offered.')
  } else {
    for (const m of missions) {
      const date = new Date(m.createdAt).toISOString().slice(0, 10)
      console.log(`  ${mIcon(m.status)} [${m.id.slice(0, 8)}] ${m.goal.slice(0, 55)}`)
      console.log(`       ${m.status.toUpperCase()}  •  ${date}`)
    }
  }
  console.log(`\n  /missions status <id>   — division + job tree`)
  console.log(`  /missions watch <id>    — live progress`)
  console.log(LINE + '\n')
}

// ─── Status tree ──────────────────────────────────────────────────────────────

async function showStatus(userId: string, prefix: string): Promise<void> {
  const missionId = resolveId(userId, prefix)
  if (!missionId) { console.log(`\n  Mission "${prefix}" not found.\n`); return }

  const mission = getMission(missionId)!
  const divisions = getDivisionsForMission(missionId)
  const artifacts = getArtifactsForMission(missionId)
  const pending = getPendingApprovals(missionId)

  console.log(`\n${LINE}`)
  console.log(`  ${mIcon(mission.status)} MISSION [${mission.id.slice(0, 8)}]  ${mission.status.toUpperCase()}`)
  console.log(LINE)
  console.log(`  ${mission.goal.slice(0, 70)}`)
  if (artifacts.length) console.log(`  Artifacts: ${artifacts.map(a => a.key).join(', ')}`)
  if (pending.length) console.log(`  ⚠️  ${pending.length} approval(s) pending — /missions approvals ${mission.id.slice(0, 8)}`)

  if (divisions.length) {
    console.log(`\n  DIVISIONS`)
    for (const div of divisions) {
      const jobs = getJobsForDivision(div.id)
      const done = jobs.filter(j => j.status === 'completed').length
      const fail = jobs.filter(j => j.status === 'failed').length
      const run  = jobs.filter(j => j.status === 'running').length
      const pend = jobs.filter(j => j.status === 'pending').length
      console.log(`\n  ${dIcon(div.status)} ${div.role}  [${div.status}]`)
      if (div.goal) console.log(`       ${div.goal.slice(0, 60)}`)
      if (jobs.length) {
        console.log(`       ✅${done}  ⚡${run}  ○${pend}  ❌${fail}  (${jobs.length} total)`)
        jobs.forEach(j => console.log(`         ${jIcon(j.status)} ${j.description.slice(0, 55)}`))
      }
      if (div.report) console.log(`       Report: ${div.report.slice(0, 100)}`)
    }
  }

  if (mission.finalReport) {
    console.log(`\n  FINAL REPORT:`)
    mission.finalReport.split('\n').slice(0, 15).forEach(l => console.log('  ' + l))
    if (mission.finalReport.split('\n').length > 15) console.log('  ...')
  }

  console.log(`\n${LINE}\n`)
}

// ─── Watch ────────────────────────────────────────────────────────────────────

async function watchMission(userId: string, prefix: string, promptFn: (q: string) => Promise<string>): Promise<void> {
  const missionId = resolveId(userId, prefix)
  if (!missionId) { console.log(`\n  Mission "${prefix}" not found.\n`); return }

  const TERMINAL = new Set(['completed', 'failed', 'aborted'])
  const initial = getMission(missionId)!

  if (TERMINAL.has(initial.status)) {
    await showStatus(userId, missionId)
    return
  }

  console.log(`\n  Watching [${missionId.slice(0, 8)}] — press Enter to background.\n`)

  let stopped = false
  const unsubscribe = subscribeMissionProgress(missionId, (msg: string) => {
    if (!stopped) console.log('  ' + msg)
  })

  const poll = setInterval(() => {
    const m = getMission(missionId)
    if (m && TERMINAL.has(m.status)) {
      stopped = true
      clearInterval(poll)
      unsubscribe()
      console.log(`\n  Mission ${m.status.toUpperCase()}.`)
      if (m.finalReport) m.finalReport.split('\n').slice(0, 20).forEach(l => console.log('  ' + l))
    }
  }, 2000)

  await promptFn('\n  [watching — press Enter to background] ')
  stopped = true
  clearInterval(poll)
  unsubscribe()
  console.log()
}

// ─── Approvals ────────────────────────────────────────────────────────────────

async function handleApprovals(userId: string, prefix: string, promptFn: (q: string) => Promise<string>): Promise<void> {
  const missionId = resolveId(userId, prefix)
  if (!missionId) { console.log(`\n  Mission "${prefix}" not found.\n`); return }

  const approvals = getPendingApprovals(missionId)
  if (!approvals.length) { console.log(`\n  No pending approvals.\n`); return }

  console.log(`\n${LINE}`)
  console.log(`  PENDING APPROVALS (${approvals.length})`)
  console.log(LINE)

  for (const a of approvals) {
    console.log(`\n  [${a.id.slice(0, 8)}] ${a.actionType.toUpperCase()}`)
    console.log(`  ${a.preview}`)
    if (a.content) {
      a.content.slice(0, 300).split('\n').forEach(l => console.log('    ' + l))
      if (a.content.length > 300) console.log('    ...')
    }
    const ans = (await promptFn('\n  [a] approve  [d] deny  [s] skip > ')).trim().toLowerCase()
    if (ans === 'a' || ans === 'approve' || ans === 'y') {
      resolveApproval(a.id, 'approved')
      logEvent(missionId, 'approval_decided', { approvalId: a.id, decision: 'approved' })
      console.log('  ✓ Approved.')
    } else if (ans === 'd' || ans === 'deny' || ans === 'n') {
      resolveApproval(a.id, 'denied')
      logEvent(missionId, 'approval_decided', { approvalId: a.id, decision: 'denied' })
      console.log('  ✗ Denied.')
    } else {
      console.log('  Skipped.')
    }
  }
  console.log()
}

// ─── Artifacts ────────────────────────────────────────────────────────────────

async function showArtifacts(userId: string, prefix: string): Promise<void> {
  const missionId = resolveId(userId, prefix)
  if (!missionId) { console.log(`\n  Mission "${prefix}" not found.\n`); return }

  const artifacts = getArtifactsForMission(missionId)
  console.log(`\n${LINE}`)
  console.log('  MISSION ARTIFACTS')
  console.log(LINE)
  if (!artifacts.length) {
    console.log('  None yet.')
  } else {
    for (const a of artifacts) {
      console.log(`\n  [${a.key}]`)
      a.value.slice(0, 300).split('\n').forEach(l => console.log('  ' + l))
      if (a.value.length > 300) console.log('  ...')
    }
  }
  console.log(LINE + '\n')
}

// ─── Resolve ID prefix ────────────────────────────────────────────────────────

function resolveId(userId: string, prefix: string): string | null {
  return getMissionsForUser(userId).find(m => m.id.startsWith(prefix))?.id ?? null
}

// ─── Main slash command handler ───────────────────────────────────────────────

export async function handleMissionsCommand(
  _rl: readline.Interface,
  userId: string,
  args: string,
  promptFn: (q: string) => Promise<string>
): Promise<void> {
  initMissionTables()
  const parts = args.trim().split(/\s+/)
  const sub = (parts[0] || '').toLowerCase()
  const rest = parts.slice(1).join(' ').trim()

  switch (sub) {
    case '':
    case 'list':
      await listMissions(userId)
      break

    case 'launch':
      await runPlannerFlow(rest || (await promptFn('  Goal: ')), userId, promptFn)
      break

    case 'status':
    case 'tree':
      if (!rest) { console.log('\n  Usage: /missions status <id>\n'); return }
      await showStatus(userId, rest)
      break

    case 'watch':
      if (!rest) { console.log('\n  Usage: /missions watch <id>\n'); return }
      await watchMission(userId, rest, promptFn)
      break

    case 'approvals':
    case 'approve':
      if (!rest) { console.log('\n  Usage: /missions approvals <id>\n'); return }
      await handleApprovals(userId, rest, promptFn)
      break

    case 'artifacts':
      if (!rest) { console.log('\n  Usage: /missions artifacts <id>\n'); return }
      await showArtifacts(userId, rest)
      break

    case 'pause': {
      const id = resolveId(userId, rest)
      if (!id) { console.log(`\n  Mission "${rest}" not found.\n`); return }
      const { pauseMission } = await import('./mission/controller.js')
      pauseMission(id)
      console.log(`\n  ⏸ Mission paused.\n`)
      break
    }

    case 'resume': {
      const id = resolveId(userId, rest)
      if (!id) { console.log(`\n  Mission "${rest}" not found.\n`); return }
      const { resumeMission } = await import('./mission/controller.js')
      resumeMission(id)
      const m = getMission(id)!
      new MissionScheduler(id, m.userId, (mId, msg) => {
        broadcastProgress(mId, msg)
        logEvent(mId, 'progress', { msg })
      }).start()
      console.log(`\n  ▶ Mission resumed.\n`)
      break
    }

    case 'abort': {
      const id = resolveId(userId, rest)
      if (!id) { console.log(`\n  Mission "${rest}" not found.\n`); return }
      const c = (await promptFn(`  Abort [${rest}]? [y/n] > `)).trim().toLowerCase()
      if (c !== 'y' && c !== 'yes') { console.log('  Cancelled.\n'); return }
      const { abortMission } = await import('./mission/controller.js')
      abortMission(id)
      console.log(`\n  🛑 Aborted.\n`)
      break
    }

    default:
      console.log('\n  Mission Mode — complex multi-division goals with parallel agents')
      console.log('\n  /missions                       — list all missions')
      console.log('  /missions status <id>           — division + job tree')
      console.log('  /missions watch <id>            — live progress stream')
      console.log('  /missions approvals <id>        — handle pending approvals')
      console.log('  /missions artifacts <id>        — view mission artifacts')
      console.log('  /missions pause/resume/abort    — control a running mission\n')
  }
}

// ─── Auto-detect complex goals in runTask ────────────────────────────────────

export async function checkMissionMode(
  task: string,
  userId: string,
  promptFn: (q: string) => Promise<string>
): Promise<boolean> {
  if (task.split(/\s+/).length < 10) return false

  const score = scoreMissionComplexity(task)
  if (!score.suggestMissionMode) return false

  const L = '─'.repeat(55)
  console.log(`\n${L}`)
  console.log('  MISSION MODE SUGGESTED')
  console.log(L)
  console.log(`  Domains: ${score.domains.join(', ')}  •  Score: ${score.score}/100`)
  console.log(`  Estimate: ${score.estimate.divisions} divisions  •  ${score.estimate.agentsMin}-${score.estimate.agentsMax} agents  •  ${score.estimate.hoursMin}-${score.estimate.hoursMax}h`)
  if (score.hasIrreversibleActions) console.log('  ⚠️  Has irreversible actions (publish, send, etc.)')
  console.log(L)

  const ans = (await promptFn('  [m] Build a plan  [n] Run as normal task > ')).trim().toLowerCase()
  if (ans !== 'm' && ans !== 'y' && ans !== 'mission') return false

  try {
    await runPlannerFlow(task, userId, promptFn)
  } catch (err: any) {
    console.error(`\n[mission] Planner flow crashed: ${err?.message ?? err}\n${err?.stack ?? ''}`)
  }
  return true
}
