import {
  getMission, getDivisionsForMission, getDivision, getJob, getJobsForDivision, getReadyDivisions,
  getReadyJobs, updateJobStatus, resetJobForRetry, setJobRetryContext, countRunningJobs,
  allJobsSettled, failOrphanedJobs, updateMissionStatus, updateDivisionStatus, logEvent,
  getPendingApprovals, getApprovalRequest, createApprovalRequest, writeArtifact, writeMissionTokenSummary,
} from './state-store.js'
import type { ConfirmationRequest, ConfirmationResponse } from '../agent-extension.js'
import { runAgentLoop } from '../agent-extension.js'

// Stubs: manager-runner, ceo-runner, and job-classifier replaced by dynamic orchestrator.
// These paths are only reached by old DB-backed missions. New missions use runDynamicOrchestrator.
async function runManagerPlanningPhase(opts: { division: Division; mission: Mission; onProgress: (msg: string) => void; abortSignal?: AbortSignal }): Promise<{ success: boolean; jobsSpawned: number }> {
  updateDivisionStatus(opts.division.id, 'failed', 'replaced by dynamic orchestrator')
  return { success: false, jobsSpawned: 0 }
}
async function runManagerSynthesisPhase(_opts: { division: Division; mission: Mission; onProgress: (msg: string) => void; abortSignal?: AbortSignal }): Promise<{ success: boolean; report: string }> {
  return { success: false, report: 'replaced by dynamic orchestrator' }
}
async function runCEOSynthesisPhase(_opts: { mission: Mission; onProgress: (msg: string) => void; abortSignal?: AbortSignal }): Promise<{ success: boolean; report: string }> {
  return { success: false, report: 'replaced by dynamic orchestrator' }
}
function classifyJobModel(_description: string): 'high' | 'medium' { return 'high' }
import { finalizeMissionTokens } from './token-tracker.js'
import { SUB_AGENT_BLOCKED_TOOLS } from '../multi-agent/delegate.js'
import { resolveRuntime } from '../model-router.js'
import { config } from '../../config.js'
import type { Division, Job, Mission } from './types.js'

// Tools mission workers can never call — would cause infinite delegation loops or agent spawning
const WORKER_BLOCKED_TOOLS_BASE = new Set([
  'delegate_tasks',
  'search_skills',
  'load_skill',
  'patch_skill',
  'confirm_action',
  'get_mid_action_plan',
])

// Local workers: fully air-gapped from browser — keep the full SUB_AGENT_BLOCKED_TOOLS set
const WORKER_BLOCKED_TOOLS_LOCAL = new Set([...SUB_AGENT_BLOCKED_TOOLS])

// Browser workers: only block delegation and skills tools.
// Navigation, snapshot, click, type, and perception tools are all allowed.
// Sub-agents share a CDP connection (hence the broad block in SUB_AGENT_BLOCKED_TOOLS), but
// mission workers each run on their own tabKey in isolation, so browser interaction is safe.
const WORKER_BLOCKED_TOOLS_BROWSER = WORKER_BLOCKED_TOOLS_BASE

export type MissionProgressFn = (missionId: string, msg: string) => void

// ─── Artifact context builder (exported for testing) ──────────────────────────
// Applies per-key limits (300 chars for regular keys, 4000 for _output keys)
// then enforces a 6000-char total ceiling, truncating earlier _output entries
// first so the most-recent upstream data is always preserved intact.

const ARTIFACT_TOTAL_CAP = 6_000

export function buildArtifactContext(artifacts: Record<string, string>): string {
  if (Object.keys(artifacts).length === 0) return ''

  const rawEntries = Object.entries(artifacts).map(([k, v]) => {
    const limit = k.endsWith('_output') ? 4_000 : 300
    return { key: k, val: v.slice(0, limit) }
  })

  const entries = rawEntries.map(e => `${e.key}: ${e.val}`)
  let body = entries.join('\n')

  if (body.length > ARTIFACT_TOTAL_CAP) {
    // Identify _output entry indices — protect the LAST one (most recent division)
    const outputIdxs = rawEntries
      .map((e, i) => ({ i, isOutput: e.key.endsWith('_output') }))
      .filter(x => x.isOutput)
      .map(x => x.i)

    // Truncate from earlier _output entries, leaving the last untouched
    for (const idx of outputIdxs.slice(0, -1)) {
      const over = body.length - ARTIFACT_TOTAL_CAP
      if (over <= 0) break
      const colonPos = entries[idx].indexOf(': ')
      const keep = Math.max(colonPos + 12, entries[idx].length - over - 50)
      entries[idx] = entries[idx].slice(0, keep) + '...[truncated for context budget]'
      body = entries.join('\n')
    }

    // Safety net: if still over after _output truncation
    if (body.length > ARTIFACT_TOTAL_CAP) {
      body = body.slice(0, ARTIFACT_TOTAL_CAP) +
        '\n[Context truncated to fit token budget. Full data available in artifacts table.]'
    }
  }

  return `\n\nAVAILABLE ARTIFACTS:\n${body}`
}

// ─── Mission confirmation handler (exported for testing) ──────────────────────
// Creates an approval record in the DB when a worker calls a confirmation-gated
// tool (write_file, edit_file, etc.), then polls until the user resolves it via
// `/missions approvals <id>`.  Returns 'approved' or 'denied' to the caller so
// the existing tool-handler code path executes the operation normally.

export function createMissionConfirmationHandler(
  missionId: string,
  divisionId: string,
  jobId: string,
  onProgress: (msg: string) => void,
  abortSignal: AbortSignal,
): (req: ConfirmationRequest) => Promise<ConfirmationResponse> {
  return async (req: ConfirmationRequest): Promise<ConfirmationResponse> => {
    const approval = createApprovalRequest({
      missionId,
      divisionId,
      jobId,
      actionType: req.action_type,
      preview: `${req.action_type}: ${req.target}`,
      content: req.content,
    })

    onProgress(`⚠️  APPROVAL NEEDED [job:${jobId.slice(0, 6)}]: ${req.action_type} → ${req.target}`)
    onProgress(`   Resolve with: /missions approvals ${missionId.slice(0, 8)}`)

    const POLL_MS = 500
    const TIMEOUT_MS = 5 * 60 * 1_000   // 5 minutes
    const deadline = Date.now() + TIMEOUT_MS

    while (Date.now() < deadline) {
      if (abortSignal.aborted) return { decision: 'denied' }
      await new Promise(r => setTimeout(r, POLL_MS))
      const current = getApprovalRequest(approval.id)
      if (current?.status === 'approved') return { decision: 'approved' }
      if (current?.status === 'denied')   return { decision: 'denied' }
    }

    onProgress(`  ⏱  Approval timed out for ${req.action_type}: ${req.target} — denying`)
    return { decision: 'denied' }
  }
}

// ─── Active schedulers registry ───────────────────────────────────────────────
// One scheduler per running mission. Stored in memory; if process restarts,
// the controller re-creates schedulers for any missions still in 'running' state.

const activeSchedulers = new Map<string, MissionScheduler>()

export function getScheduler(missionId: string): MissionScheduler | undefined {
  return activeSchedulers.get(missionId)
}

export function stopScheduler(missionId: string): void {
  activeSchedulers.get(missionId)?.stop()
  activeSchedulers.delete(missionId)
}

// ─── MissionScheduler ─────────────────────────────────────────────────────────

export class MissionScheduler {
  private missionId: string
  private userId: string
  private timer: ReturnType<typeof setInterval> | null = null
  private runningPromises = new Map<string, Promise<void>>()  // jobId → promise
  private runningDivisionPromises = new Map<string, Promise<void>>()  // divisionId → promise
  private onProgress: MissionProgressFn
  private abortController = new AbortController()

  constructor(missionId: string, userId: string, onProgress: MissionProgressFn) {
    this.missionId = missionId
    this.userId = userId
    this.onProgress = onProgress
  }

  start(): void {
    // Clear any existing scheduler's timer for this mission — prevents double-ticking after
    // resume (CLI creates a new scheduler while the old one's setInterval is still live).
    const existing = activeSchedulers.get(this.missionId)
    if (existing && existing !== this) {
      if (existing.timer) { clearInterval(existing.timer); existing.timer = null }
    }
    activeSchedulers.set(this.missionId, this)
    this.tick()
    this.timer = setInterval(() => this.tick(), config.SCHEDULER_TICK_MS)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.abortController.abort()
    activeSchedulers.delete(this.missionId)
  }

  private progress(msg: string): void {
    this.onProgress(this.missionId, msg)
  }

  private async tick(): Promise<void> {
    try {
      const mission = getMission(this.missionId)
      if (!mission || mission.status === 'completed' || mission.status === 'failed' || mission.status === 'aborted') {
        this.stop()
        return
      }
      if (mission.status === 'paused') return

      let divisions = getDivisionsForMission(this.missionId)
      const mission_ = mission  // capture for closures

      // ── 1. Launch planning for ready-to-plan divisions ──────────────────────
      const readyDivisions = getReadyDivisions(this.missionId)
        .filter(d => d.status === 'pending' && !this.runningDivisionPromises.has(d.id))

      for (const division of readyDivisions) {
        this.launchDivisionPlanning(division, mission_)
      }

      // Re-read divisions: pre-planned ones transition 'pending'→'executing' synchronously
      // inside launchDivisionPlanning, so a fresh read lets section 2 see them immediately.
      if (readyDivisions.length > 0) {
        divisions = getDivisionsForMission(this.missionId)
      }

      // ── 2. Launch ready jobs within executing divisions (fair-share concurrency) ──
      const pool = mission.poolSize
      const executingDivisions = divisions.filter(d => d.status === 'executing')
      const divCount = Math.max(1, executingDivisions.length)
      const slotsPerDiv = Math.ceil(pool / divCount)

      if (this.runningPromises.size < pool) {
        for (const division of executingDivisions) {
          const divJobs = getJobsForDivision(division.id)
          const runningForDiv = divJobs.filter(j => this.runningPromises.has(j.id)).length
          const divSlotsFree = Math.max(0, slotsPerDiv - runningForDiv)
          const readyJobs = getReadyJobs(division.id).filter(j => !this.runningPromises.has(j.id))
          let launched = 0
          for (const job of readyJobs) {
            if (this.runningPromises.size >= pool) break
            if (launched >= divSlotsFree) break
            this.launchJob(job, division, mission_)
            launched++
          }
        }
      }

      // ── 3. Check divisions whose jobs all settled → wake manager for synthesis
      for (const division of divisions) {
        if (division.status !== 'executing') continue
        if (this.runningDivisionPromises.has(division.id)) continue
        const jobs = getJobsForDivision(division.id)
        if (jobs.some(j => this.runningPromises.has(j.id))) continue
        failOrphanedJobs(division.id)   // fail pending jobs whose dep jobs failed
        if (allJobsSettled(division.id)) {   // true for 0 jobs too — synthesize immediately
          this.launchDivisionSynthesis(division, mission_)
        }
      }

      // ── 4. Check if all divisions settled → wake CEO for final synthesis ─────
      const allSettled = divisions.length > 0 &&
        divisions.every(d => d.status === 'completed' || d.status === 'failed')
      if (allSettled && this.runningDivisionPromises.size === 0 && mission.status === 'running') {
        this.launchCEOSynthesis(mission_)
      }

    } catch (err: any) {
      console.error(`[mission-scheduler:${this.missionId}] tick error:`, err?.message)
    }
  }

  private launchDivisionPlanning(division: Division, mission: Mission): void {
    // Pre-planned path: jobs already exist, activate synchronously without touching
    // runningDivisionPromises — the async body has no awaits, so set() after delete()
    // would permanently strand the division ID in the map and block synthesis forever.
    const existingJobs = getJobsForDivision(division.id)
    if (existingJobs.length > 0) {
      logEvent(this.missionId, 'division_activated', { divisionId: division.id, role: division.role, jobs: existingJobs.length })
      this.progress(`⚡ [${division.role}] ${existingJobs.length} job(s) ready`)
      updateDivisionStatus(division.id, 'executing')
      return
    }

    // LLM-planned path: async manager planning, tracked in runningDivisionPromises
    const promise = (async () => {
      try {
        logEvent(this.missionId, 'division_planning_start', { divisionId: division.id, role: division.role })
        this.progress(`🏢 [${division.role}] Planning...`)
        await runManagerPlanningPhase({
          division,
          mission,
          onProgress: msg => this.progress(msg),
          abortSignal: this.abortController.signal,
        })
      } catch (err: any) {
        console.error(`[mission] division planning error (${division.role}):`, err?.message)
        logEvent(this.missionId, 'division_planning_error', { divisionId: division.id, error: err?.message })
      } finally {
        this.runningDivisionPromises.delete(division.id)
      }
    })()
    this.runningDivisionPromises.set(division.id, promise)
  }

  private launchJob(job: Job, division: Division, mission: Mission): void {
    // Credential health check — before marking the job 'running' (which increments attempts),
    // verify a provider is available. A missing key is permanent for this scheduler run;
    // pausing here lets the user add credentials and resume without burning any retry budget.
    try {
      resolveRuntime()
    } catch (credErr: any) {
      if ((credErr?.message ?? '').includes('No AI provider configured')) {
        const alreadyPaused = getMission(this.missionId)?.status === 'paused'
        updateMissionStatus(this.missionId, 'paused', credErr.message)
        if (!alreadyPaused) {
          logEvent(this.missionId, 'mission_paused', { reason: 'no_provider', error: credErr.message })
          const shortId = this.missionId.slice(0, 8)
          this.progress(`\n⚠️  Mission ${shortId} paused — no AI provider configured.`)
          this.progress(`   Add a key:  jarvis config set openai_api_key sk-...`)
          this.progress(`               jarvis config set xai_api_key xai-...`)
          this.progress(`   Then resume: /missions resume ${shortId}`)
        }
        return  // job stays 'pending', no attempt consumed
      }
      // Non-credential throws fall through to normal job execution below
    }

    updateJobStatus(job.id, 'running')
    logEvent(this.missionId, 'job_start', { jobId: job.id, description: job.description.slice(0, 80) })
    const agentId = job.id.slice(0, 6)
    this.progress(`👷 [${division.role}] Agent ${agentId} → ${job.description.slice(0, 65)}...`)

    const promise = (async () => {
      try {
        // Build context: inject mission brief + any available artifacts (with total ceiling)
        const { readArtifacts } = await import('./state-store.js')
        const artifacts = readArtifacts(mission.id)
        const artifactContext = buildArtifactContext(artifacts)

        const retryPrefix = job.retryContext
          ? `[RETRY CONTEXT — previous attempt failed]\n${job.retryContext}\n\nNow try again with a different approach.\n\n---\n\n`
          : ''

        // Intra-division chaining: inject upstream job outputs when this job depends on others
        let upstreamContext = ''
        if (job.dependsOnJobIds.length > 0) {
          const upstreamParts: string[] = []
          for (const depId of job.dependsOnJobIds) {
            const dep = getJob(depId)
            if (dep?.status === 'completed' && dep.outputSummary) {
              upstreamParts.push(`[Upstream job: ${dep.description.slice(0, 60)}]\n${dep.outputSummary.slice(0, 1_000)}`)
            }
          }
          if (upstreamParts.length > 0) {
            upstreamContext = `\n\nUPSTREAM JOB RESULTS (use this data to complete your task):\n${upstreamParts.join('\n\n')}`
          }
        }

        const result = await runAgentLoop({
          userId: this.userId,
          taskId: `${this.missionId}-div${division.id.slice(0, 6)}-job${job.id.slice(0, 6)}`,
          taskPrompt: retryPrefix + job.description,
          tabKey: `mission-${this.missionId}-job-${job.id}`,
          missionContext: (artifactContext + upstreamContext) || undefined,
          toolSet: job.toolSet,
          modelTier: classifyJobModel(job.description),
          richContext: false,
          delegateDepth: 1,  // workers cannot delegate further
          blockedTools: job.toolSet === 'browser' ? WORKER_BLOCKED_TOOLS_BROWSER : WORKER_BLOCKED_TOOLS_LOCAL,
          preserveTodos: true,
          abortSignal: this.abortController.signal,
          onProgress: async () => {},
          silent: true,  // suppress all per-step console output; job start/done handled by scheduler
          onConfirmationRequest: createMissionConfirmationHandler(
            this.missionId, division.id, job.id,
            msg => this.progress(msg),
            this.abortController.signal,
          ),
        })

        updateJobStatus(job.id, result.success ? 'completed' : 'failed', result.summary)
        logEvent(this.missionId, result.success ? 'job_complete' : 'job_failed', {
          jobId: job.id, summary: result.summary.slice(0, 200),
        })
        if (result.success) {
          this.progress(`  ✓ [${division.role}/${agentId}] Done: ${job.description.slice(0, 60)}`)
        } else {
          this.handleJobFailure(job, division, result.summary)
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') return
        updateJobStatus(job.id, 'failed', `Error: ${err?.message}`)
        logEvent(this.missionId, 'job_error', { jobId: job.id, error: err?.message })
        this.handleJobFailure(job, division, err?.message)
      } finally {
        this.runningPromises.delete(job.id)
        // Eagerly check synthesis so the division completes without waiting for the next tick
        this.checkDivisionSynthesis(division, mission)
      }
    })()

    this.runningPromises.set(job.id, promise)
  }

  private handleJobFailure(job: Job, division: Division, failureSummary?: string): void {
    const crashCeiling = config.MISSION_CRASH_CEILING
    const canRetry = job.attempts + 1 < job.maxAttempts && job.crashCount < crashCeiling
    if (canRetry) {
      if (failureSummary) {
        setJobRetryContext(job.id, `Attempt ${job.attempts} failed with: ${failureSummary.slice(0, 400)}`)
      }
      resetJobForRetry(job.id)
      this.progress(`  ↻ [${division.role}] Retrying: ${job.description.slice(0, 60)} (attempt ${job.attempts + 1}/${job.maxAttempts})`)
      logEvent(this.missionId, 'job_retry', { jobId: job.id, attempt: job.attempts + 1 })
    } else {
      const reason = job.crashCount >= crashCeiling ? `crash-reset ${job.crashCount} times` : `${job.maxAttempts} attempts`
      this.progress(`  ✗ [${division.role}] Job failed after ${reason}: ${job.description.slice(0, 60)}`)
      logEvent(this.missionId, 'job_exhausted', { jobId: job.id, crashCount: job.crashCount })
    }
  }

  private checkDivisionSynthesis(division: Division, mission: Mission): void {
    // Fresh DB read — the division snapshot captured at launchJob time may be stale.
    // Without this, two jobs finishing in the same tick each think the division is
    // still 'executing' and both trigger synthesis.
    const fresh = getDivision(division.id)
    if (!fresh || fresh.status !== 'executing') return
    if (this.runningDivisionPromises.has(division.id)) return
    const jobs = getJobsForDivision(division.id)
    if (jobs.some(j => this.runningPromises.has(j.id))) return
    failOrphanedJobs(division.id)   // fail pending jobs whose dep jobs failed
    if (allJobsSettled(division.id)) {
      this.launchDivisionSynthesis(fresh, mission)
    }
  }

  private launchDivisionSynthesis(division: Division, mission: Mission): void {
    const doneKey = division.role.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_done'

    // Pre-planned divisions (planningContext === null): auto-complete synchronously.
    // Wrapping this in an async IIFE causes the same set-after-delete race that broke
    // launchDivisionPlanning — the finally delete() runs before the outer set(), permanently
    // stranding the division in runningDivisionPromises and blocking CEO synthesis forever.
    if (!division.planningContext) {
      logEvent(this.missionId, 'division_synthesis_start', { divisionId: division.id })
      this.progress(`⚡ [${division.role}] Collating results...`)
      const jobs = getJobsForDivision(division.id)
      const completedJobs = jobs.filter(j => j.status === 'completed')
      const failedJobs = jobs.filter(j => j.status === 'failed')
      const lines = [
        `${completedJobs.length}/${jobs.length} jobs completed.`,
        ...completedJobs.map(j => `✓ ${j.description.slice(0, 80)}: ${(j.outputSummary ?? '').slice(0, 1000)}`),
        ...failedJobs.map(j => `✗ ${j.description.slice(0, 80)}: failed`),
      ]
      const report = lines.join('\n')
      const finalStatus = failedJobs.length === jobs.length || jobs.length === 0 ? 'failed' : 'completed'
      updateDivisionStatus(division.id, finalStatus, report)
      logEvent(this.missionId, 'division_auto_complete', { divisionId: division.id, role: division.role, finalStatus })
      this.progress(`${finalStatus === 'completed' ? '✅' : '❌'} [${division.role}] ${finalStatus === 'completed' ? 'Complete' : 'Failed'} (${completedJobs.length}/${jobs.length} jobs OK)`)
      writeArtifact({ missionId: this.missionId, key: doneKey, value: finalStatus })
      // Write rich output artifact (20KB max) so downstream workers get full data
      const outputKey = doneKey.replace(/_done$/, '_output')
      writeArtifact({ missionId: this.missionId, key: outputKey, value: report.slice(0, config.ARTIFACT_SIZE_CAP) })
      return  // no promise, no runningDivisionPromises entry needed
    }

    // LLM-planned divisions: async manager synthesis, tracked in runningDivisionPromises
    const promise = (async () => {
      try {
        logEvent(this.missionId, 'division_synthesis_start', { divisionId: division.id })
        this.progress(`🔬 [${division.role}] Synthesizing...`)
        const synthResult = await runManagerSynthesisPhase({
          division,
          mission,
          onProgress: msg => this.progress(msg),
          abortSignal: this.abortController.signal,
        })
        // If manager LLM didn't call division_complete/failed (exhausted iterations),
        // force the division out of 'synthesizing' so CEO synthesis can proceed
        const divNow = getDivision(division.id)
        if (divNow?.status === 'synthesizing') {
          const forced = synthResult.success ? 'completed' : 'failed'
          updateDivisionStatus(division.id, forced, synthResult.report || 'Synthesis ended without explicit completion.')
          logEvent(this.missionId, 'division_synthesis_forced', { divisionId: division.id, forced })
        }
        const divFinal = getDivision(division.id)
        const doneValue = divFinal?.status === 'completed' ? 'completed' : 'failed'
        writeArtifact({ missionId: this.missionId, key: doneKey, value: doneValue })
        writeArtifact({ missionId: this.missionId, key: doneKey.replace(/_done$/, '_output'), value: (synthResult.report ?? '').slice(0, config.ARTIFACT_SIZE_CAP) })
      } catch (err: any) {
        console.error(`[mission] division synthesis error (${division.role}):`, err?.message)
        logEvent(this.missionId, 'division_synthesis_error', { divisionId: division.id, error: err?.message })
        updateDivisionStatus(division.id, 'failed', `Synthesis error: ${err?.message}`)
        writeArtifact({ missionId: this.missionId, key: doneKey, value: 'failed' })
        writeArtifact({ missionId: this.missionId, key: doneKey.replace(/_done$/, '_output'), value: '' })
      } finally {
        this.runningDivisionPromises.delete(division.id)
      }
    })()
    this.runningDivisionPromises.set(division.id, promise)
  }

  private launchCEOSynthesis(mission: Mission): void {
    // Prevent double-triggering
    if (this.runningDivisionPromises.has('__ceo_synthesis__')) return

    // Skip LLM call entirely when every division failed — nothing to synthesize
    const allDivisions = getDivisionsForMission(this.missionId)
    if (allDivisions.length > 0 && allDivisions.every(d => d.status === 'failed')) {
      const report = 'Mission failed: all divisions encountered errors. No output was produced.'
      updateMissionStatus(this.missionId, 'failed', report)
      logEvent(this.missionId, 'ceo_synthesis_skipped', { reason: 'all_divisions_failed' })
      this.progress('❌ Mission failed: all divisions encountered errors.')
      try {
        const summary = finalizeMissionTokens(this.missionId)
        writeMissionTokenSummary(this.missionId, summary)
      } catch {}
      this.stop()
      return
    }

    const promise = (async () => {
      try {
        logEvent(this.missionId, 'ceo_synthesis_start', {})
        this.progress(`📊 CEO synthesizing all division reports...`)
        const synthResult = await runCEOSynthesisPhase({
          mission,
          onProgress: msg => this.progress(msg),
          abortSignal: this.abortController.signal,
        })
        // If the LLM exhausted its iteration budget without calling mission_complete/failed,
        // force the mission to a terminal state so it doesn't remain stuck in 'running'
        // with a dead scheduler.
        const missionNow = getMission(this.missionId)
        if (missionNow?.status === 'running') {
          const forced = synthResult.success ? 'completed' : 'failed'
          const report = synthResult.report || (forced === 'completed' ? 'Mission complete.' : 'CEO synthesis exhausted without producing a final report.')
          updateMissionStatus(this.missionId, forced, report)
          logEvent(this.missionId, 'ceo_synthesis_forced', { forced })
          this.progress(forced === 'completed' ? '🎉 Mission complete' : '❌ Mission failed (CEO synthesis exhausted)')
        }
        this.stop()
      } catch (err: any) {
        console.error(`[mission] CEO synthesis error:`, err?.message)
        updateMissionStatus(this.missionId, 'failed', `CEO synthesis failed: ${err?.message}`)
        this.stop()
      } finally {
        // Write token summary regardless of outcome
        try {
          const summary = finalizeMissionTokens(this.missionId)
          writeMissionTokenSummary(this.missionId, summary)
        } catch {}
        this.runningDivisionPromises.delete('__ceo_synthesis__')
      }
    })()
    this.runningDivisionPromises.set('__ceo_synthesis__', promise)
  }
}
