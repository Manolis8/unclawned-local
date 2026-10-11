import { updateMissionStatus, getMission, getMissionsForUser, getRunningMissions, logEvent, resetOrphanedRunningJobs, resetOrphanedSynthesizingDivisions } from './state-store.js'
import { MissionScheduler, stopScheduler } from './scheduler.js'
import type { Mission, LaunchMissionOpts } from './types.js'

// ─── Complexity scoring ───────────────────────────────────────────────────────

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  website:    ['website', 'site', 'landing page', 'publish', 'deploy', 'web app', 'build a'],
  social:     ['twitter', 'x.com', 'tweet', 'instagram', 'linkedin', 'post', 'campaign', 'ad', 'promote'],
  outreach:   ['influencer', 'dm', 'email', 'contact', 'reach out', 'partnership', 'deal', 'negotiate'],
  content:    ['write', 'blog', 'article', 'copy', 'content', 'draft', 'script'],
  research:   ['research', 'analyze', 'find', 'gather', 'collect', 'survey', 'competitor'],
  financial:  ['spend', 'budget', 'pay', 'purchase', 'subscription', 'invoice'],
  code:       ['code', 'develop', 'build', 'implement', 'integrate', 'api', 'database'],
}

const SEQUENTIAL_SIGNALS = ['then', 'after that', 'once', 'first', 'next', 'following', 'depends on', 'when complete']
const IRREVERSIBLE_SIGNALS = ['publish', 'send', 'post', 'deploy', 'email', 'dm', 'submit', 'pay', 'launch']

export interface ComplexityScore {
  score: number              // 0-100
  suggestMissionMode: boolean
  domains: string[]
  hasIrreversibleActions: boolean
  hasSequentialDependencies: boolean
  estimate: { divisions: number; agentsMin: number; agentsMax: number; hoursMin: number; hoursMax: number }
}

export function scoreMissionComplexity(goal: string): ComplexityScore {
  const lower = goal.toLowerCase()

  const domains = Object.entries(DOMAIN_KEYWORDS)
    .filter(([, kws]) => kws.some(kw => lower.includes(kw)))
    .map(([domain]) => domain)

  const hasIrreversibleActions = IRREVERSIBLE_SIGNALS.some(s => new RegExp(`\\b${s}\\b`, 'i').test(lower))
  const hasSequentialDependencies = SEQUENTIAL_SIGNALS.some(s => lower.includes(s))
  const wordCount = goal.split(/\s+/).length

  let score = 0
  score += Math.min(domains.length * 20, 60)   // up to 60 pts for domain breadth
  score += hasIrreversibleActions ? 15 : 0      // irreversible = complex coordination
  score += hasSequentialDependencies ? 10 : 0   // sequential dependencies = phased execution
  score += wordCount > 50 ? 10 : 0              // detailed request = complex task
  score += wordCount > 100 ? 5 : 0

  const divisionCount = Math.min(Math.max(domains.length, 2), 5)
  const agentsMin = divisionCount * 3
  const agentsMax = divisionCount * 8

  return {
    score,
    suggestMissionMode: score >= 35 || domains.length >= 2,
    domains,
    hasIrreversibleActions,
    hasSequentialDependencies,
    estimate: {
      divisions: divisionCount,
      agentsMin,
      agentsMax,
      hoursMin: Math.max(1, Math.floor(divisionCount * 0.5)),
      hoursMax: Math.max(2, divisionCount * 2),
    },
  }
}

// ─── Progress relay ────────────────────────────────────────────────────────────

// In-process subscribers: missionId → array of callbacks
const progressSubscribers = new Map<string, Array<(msg: string) => void>>()

export function subscribeMissionProgress(missionId: string, cb: (msg: string) => void): () => void {
  if (!progressSubscribers.has(missionId)) progressSubscribers.set(missionId, [])
  progressSubscribers.get(missionId)!.push(cb)
  return () => {
    const subs = progressSubscribers.get(missionId)
    if (subs) {
      const idx = subs.indexOf(cb)
      if (idx >= 0) subs.splice(idx, 1)
    }
  }
}

export function broadcastProgress(missionId: string, msg: string): void {
  const subs = progressSubscribers.get(missionId) ?? []
  for (const cb of subs) {
    try { cb(msg) } catch {}
  }
}

// ─── In-flight abort controllers — one per mission during CEO planning phase ──

const missionAbortControllers = new Map<string, AbortController>()

// ─── Launch ────────────────────────────────────────────────────────────────────

export async function launchMission(opts: LaunchMissionOpts): Promise<Mission> {
  const { missionId, userId, goal, onProgress } = opts

  const mission = getMission(missionId)
  if (!mission) throw new Error(`Mission ${missionId} not found`)

  subscribeMissionProgress(missionId, onProgress)

  const abortController = new AbortController()
  missionAbortControllers.set(missionId, abortController)

  try {
    logEvent(missionId, 'mission_created', { goal: goal.slice(0, 200) })
    updateMissionStatus(missionId, 'running')
    broadcastProgress(missionId, `⚡ Dynamic orchestrator starting (id: ${missionId.slice(0, 8)})`)

    const { runDynamicOrchestrator } = await import('../orchestrator.js')
    const result = await runDynamicOrchestrator(
      goal,
      userId,
      msg => broadcastProgress(missionId, msg),
      undefined,
      abortController.signal,
    )

    updateMissionStatus(missionId, result.success ? 'completed' : 'failed', result.result)
    logEvent(missionId, result.success ? 'mission_complete' : 'mission_failed', { result: result.result.slice(0, 500) })
    broadcastProgress(missionId, result.success ? '🎉 Mission complete' : `❌ Mission failed: ${result.result.slice(0, 100)}`)
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      updateMissionStatus(missionId, 'failed', err?.message)
      broadcastProgress(missionId, `❌ Mission failed: ${err?.message}`)
    }
  } finally {
    missionAbortControllers.delete(missionId)
  }

  return getMission(missionId)!
}

// ─── Control operations ────────────────────────────────────────────────────────

export function pauseMission(missionId: string): void {
  stopScheduler(missionId)
  updateMissionStatus(missionId, 'paused')
  logEvent(missionId, 'mission_paused', {})
}

export function resumeMission(missionId: string): void {
  const mission = getMission(missionId)
  if (!mission || mission.status !== 'paused') return
  updateMissionStatus(missionId, 'running')
  logEvent(missionId, 'mission_resumed', {})
  // Re-start scheduler if it stopped
  // The caller must re-subscribe progress if needed
}

export function abortMission(missionId: string): void {
  stopScheduler(missionId)
  updateMissionStatus(missionId, 'aborted')
  logEvent(missionId, 'mission_aborted', {})
  // Abort any in-flight CEO planning so launchMission's async continuation exits
  // without overwriting 'aborted' with 'running' when planning finishes.
  const ac = missionAbortControllers.get(missionId)
  if (ac) { ac.abort(); missionAbortControllers.delete(missionId) }
}

// ─── Process-restart recovery ──────────────────────────────────────────────────

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000

export function recoverRunningMissions(
  onProgress: (missionId: string, msg: string) => void
): number {
  const running = getRunningMissions()
  if (running.length === 0) return 0
  const progressRelay = (missionId: string, msg: string) => {
    broadcastProgress(missionId, msg)
    onProgress(missionId, msg)
  }
  let recovered = 0
  for (const mission of running) {
    // Abort missions stuck for 2+ hours — they are unrecoverable and the dynamic
    // orchestrator is stateless, so there's nothing meaningful to resume.
    if (Date.now() - mission.updatedAt > TWO_HOURS_MS) {
      try {
        updateMissionStatus(mission.id, 'aborted', 'Aborted at startup: stuck for more than 2 hours.')
        logEvent(mission.id, 'mission_aborted', { reason: 'startup_stale', staleMs: Date.now() - mission.updatedAt })
        console.log(`  [recovery:${mission.id.slice(0, 8)}] stale (>2h) — aborted`)
      } catch (err: any) {
        console.error(`[recovery:${mission.id}] abort failed:`, err?.message)
      }
      continue
    }
    try {
      resetOrphanedRunningJobs(mission.id)
      resetOrphanedSynthesizingDivisions(mission.id)
      logEvent(mission.id, 'mission_recovered', { recoveredAt: Date.now() })
      const scheduler = new MissionScheduler(mission.id, mission.userId, progressRelay)
      scheduler.start()
      recovered++
    } catch (err: any) {
      console.error(`[recovery:${mission.id}] recovery failed, skipping:`, err?.message)
    }
  }
  return recovered
}

export { getMission, getMissionsForUser }
