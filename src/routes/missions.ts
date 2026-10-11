import { Router } from 'express'
import { db } from '../lib/db.js'
import { initMissionTables } from '../lib/mission/state-store.js'
import {
  launchMission, scoreMissionComplexity, pauseMission, resumeMission,
  abortMission, subscribeMissionProgress, getMission, getMissionsForUser,
} from '../lib/mission/controller.js'
import {
  getMission as getMissionState,
  getDivisionsForMission,
  getJobsForDivision,
  getArtifactsForMission,
  getPendingApprovals,
  resolveApproval,
  getApprovalRequest,
  getEvents,
  createMission,
  updateMissionStatus,
  logEvent,
} from '../lib/mission/state-store.js'
import { MultiMissionDashboard } from '../lib/mission/dashboard.js'
import { config } from '../config.js'
import type { MissionTree } from '../lib/mission/types.js'

// Initialize tables on first import
initMissionTables()

// ─── Singleton multi-mission dashboard ───────────────────────────────────────
const multiDash = new MultiMissionDashboard()
multiDash.start()

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted'])

function trackMissionInDashboard(missionId: string): void {
  multiDash.addMission(missionId)
  const unsubscribe = subscribeMissionProgress(missionId, (msg: string) => {
    multiDash.addMessage(missionId, msg)
    const mission = getMissionState(missionId)
    if (mission && TERMINAL_STATUSES.has(mission.status)) {
      multiDash.removeMission(missionId)
      unsubscribe()
    }
  })
}

export const missionsRouter = Router()

// ─── Auth helper ──────────────────────────────────────────────────────────────

function getUserId(req: any): string | null {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '')
  if (!apiKey) return null
  const row = db.prepare('SELECT user_id FROM api_keys WHERE key = ?').get(apiKey) as any
  return row?.user_id ?? null
}

function requireAuth(req: any, res: any, next: any): void {
  const userId = getUserId(req)
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
  req.userId = userId
  next()
}

// ─── POST /missions/score — analyze complexity before launching ───────────────

missionsRouter.post('/score', requireAuth, (req: any, res: any) => {
  const { goal } = req.body
  if (!goal || typeof goal !== 'string') return res.status(400).json({ error: 'goal required' })
  res.json(scoreMissionComplexity(goal))
})

// ─── POST /missions — launch a new mission ────────────────────────────────────

missionsRouter.post('/', requireAuth, (req: any, res: any) => {
  const { goal, poolSize, budgetUsd } = req.body
  if (!goal || typeof goal !== 'string') return res.status(400).json({ error: 'goal required' })
  if (goal.length > 5000) return res.status(400).json({ error: 'goal too long (max 5000 chars)' })
  if (goal.trim().split(/\s+/).length < 4) return res.status(400).json({ error: 'goal too vague (minimum 4 words)' })
  if (scoreMissionComplexity(goal).score < 5) return res.status(400).json({ error: 'goal too simple for mission mode — use a task instead' })

  const userId: string = req.userId

  // Create mission record immediately so we can return the ID
  const mission = createMission({ userId, goal, poolSize: poolSize ?? config.MISSION_POOL_SIZE, budgetUsd: budgetUsd ?? config.MISSION_BUDGET_USD })
  res.json({ missionId: mission.id, status: 'launching' })

  trackMissionInDashboard(mission.id)

  // Launch async — caller listens on /stream
  launchMission({
    missionId: mission.id,
    userId,
    goal,
    poolSize: poolSize ?? config.MISSION_POOL_SIZE,
    budgetUsd: budgetUsd ?? config.MISSION_BUDGET_USD,
    onProgress: msg => { logEvent(mission.id, 'progress', { msg }) },
  }).catch(err => {
    console.error(`[mission:${mission.id}] launch error:`, err?.message)
  })
})

// ─── GET /missions — list user's missions ─────────────────────────────────────

missionsRouter.get('/', requireAuth, (req: any, res: any) => {
  const missions = getMissionsForUser(req.userId)
  res.json({ missions })
})

// ─── GET /missions/:id — mission tree (status + all divisions + jobs) ─────────

missionsRouter.get('/:id', requireAuth, (req: any, res: any) => {
  const mission = getMissionState(req.params.id)
  if (!mission || mission.userId !== req.userId) return res.status(404).json({ error: 'Not found' })

  const divisions = getDivisionsForMission(mission.id)
  const tree: MissionTree = {
    mission,
    divisions: divisions.map(d => ({ ...d, jobs: getJobsForDivision(d.id) })),
    artifacts: getArtifactsForMission(mission.id),
    pendingApprovals: getPendingApprovals(mission.id),
  }
  res.json(tree)
})

// ─── GET /missions/:id/stream — SSE progress stream ──────────────────────────

missionsRouter.get('/:id/stream', requireAuth, (req: any, res: any) => {
  const mission = getMissionState(req.params.id)
  if (!mission || mission.userId !== req.userId) { res.status(404).end(); return }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // Send current status immediately
  res.write(`data: ${JSON.stringify({ type: 'status', mission })}\n\n`)

  const unsubscribe = subscribeMissionProgress(mission.id, (msg: string) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify({ type: 'progress', msg, ts: Date.now() })}\n\n`)
  })

  // Heartbeat every 15s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    if (res.writableEnded) { clearInterval(heartbeat); return }
    res.write(`: heartbeat\n\n`)
  }, 15000)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
})

// ─── GET /missions/:id/approvals — pending approval queue ────────────────────

missionsRouter.get('/:id/approvals', requireAuth, (req: any, res: any) => {
  const mission = getMissionState(req.params.id)
  if (!mission || mission.userId !== req.userId) return res.status(404).json({ error: 'Not found' })
  res.json({ approvals: getPendingApprovals(mission.id) })
})

// ─── POST /missions/:id/approvals/:aid — decide on an approval ───────────────

missionsRouter.post('/:id/approvals/:aid', requireAuth, (req: any, res: any) => {
  const mission = getMissionState(req.params.id)
  if (!mission || mission.userId !== req.userId) return res.status(404).json({ error: 'Not found' })

  const approval = getApprovalRequest(req.params.aid)
  if (!approval || approval.missionId !== mission.id) return res.status(404).json({ error: 'Approval not found' })
  if (approval.status !== 'pending') return res.status(409).json({ error: 'Already decided' })

  const { decision, editedContent } = req.body
  if (decision !== 'approved' && decision !== 'denied') {
    return res.status(400).json({ error: 'decision must be "approved" or "denied"' })
  }

  const changed = resolveApproval(approval.id, decision, editedContent)
  if (changed === 0) return res.status(409).json({ error: 'Approval already decided' })
  logEvent(mission.id, 'approval_decided', { approvalId: approval.id, decision })

  res.json({ ok: true, approvalId: approval.id, decision })
})

// ─── POST /missions/:id/pause ─────────────────────────────────────────────────

missionsRouter.post('/:id/pause', requireAuth, (req: any, res: any) => {
  const mission = getMissionState(req.params.id)
  if (!mission || mission.userId !== req.userId) return res.status(404).json({ error: 'Not found' })
  if (mission.status !== 'running') return res.status(409).json({ error: 'Mission is not running' })
  pauseMission(mission.id)
  res.json({ ok: true, status: 'paused' })
})

// ─── POST /missions/:id/resume ────────────────────────────────────────────────

missionsRouter.post('/:id/resume', requireAuth, async (req: any, res: any) => {
  const mission = getMissionState(req.params.id)
  if (!mission || mission.userId !== req.userId) return res.status(404).json({ error: 'Not found' })
  if (mission.status !== 'paused') return res.status(409).json({ error: 'Mission is not paused' })

  resumeMission(mission.id)

  try {
    const { MissionScheduler } = await import('../lib/mission/scheduler.js')
    const scheduler = new MissionScheduler(mission.id, mission.userId,
      (id: string, msg: string) => { logEvent(id, 'progress', { msg }) }
    )
    scheduler.start()
  } catch (err: any) {
    console.error(`[mission:${mission.id}] scheduler start error on resume:`, err?.message)
    updateMissionStatus(mission.id, 'failed', 'Scheduler failed to start on resume.')
    return res.status(500).json({ error: 'Scheduler failed to start on resume' })
  }

  res.json({ ok: true, status: 'running' })
})

// ─── DELETE /missions/:id — abort mission ─────────────────────────────────────

missionsRouter.delete('/:id', requireAuth, (req: any, res: any) => {
  const mission = getMissionState(req.params.id)
  if (!mission || mission.userId !== req.userId) return res.status(404).json({ error: 'Not found' })
  abortMission(mission.id)
  res.json({ ok: true, status: 'aborted' })
})

// ─── GET /missions/:id/logs — event log ──────────────────────────────────────

missionsRouter.get('/:id/logs', requireAuth, (req: any, res: any) => {
  const mission = getMissionState(req.params.id)
  if (!mission || mission.userId !== req.userId) return res.status(404).json({ error: 'Not found' })
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500)
  res.json({ events: getEvents(mission.id, limit) })
})

// ─── GET /missions/:id/artifacts — all artifacts ──────────────────────────────

missionsRouter.get('/:id/artifacts', requireAuth, (req: any, res: any) => {
  const mission = getMissionState(req.params.id)
  if (!mission || mission.userId !== req.userId) return res.status(404).json({ error: 'Not found' })
  res.json({ artifacts: getArtifactsForMission(mission.id) })
})
