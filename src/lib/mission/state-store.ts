import { db } from '../db.js'
import { randomUUID } from 'crypto'
import { config } from '../../config.js'
import type {
  Mission, Division, Job, Artifact, ApprovalRequest, MissionEvent,
  MissionStatus, DivisionStatus, JobStatus, ApprovalStatus,
} from './types.js'

// ─── Schema init ─────────────────────────────────────────────────────────────

export function initMissionTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS missions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planning',
      pool_size INTEGER NOT NULL DEFAULT 8,
      budget_usd REAL NOT NULL DEFAULT 50.0,
      spent_usd REAL NOT NULL DEFAULT 0.0,
      final_report TEXT,
      token_summary TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS divisions (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      parent_division_id TEXT,
      goal TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      depth INTEGER NOT NULL DEFAULT 1,
      report TEXT,
      planning_context TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (mission_id) REFERENCES missions(id)
    );

    CREATE TABLE IF NOT EXISTS division_dependencies (
      division_id TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      PRIMARY KEY (division_id, artifact_key)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      division_id TEXT NOT NULL,
      mission_id TEXT NOT NULL,
      description TEXT NOT NULL,
      tool_set TEXT NOT NULL DEFAULT 'all',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 2,
      crash_count INTEGER NOT NULL DEFAULT 0,
      depends_on_job_ids TEXT NOT NULL DEFAULT '[]',
      output_summary TEXT,
      retry_context TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (division_id) REFERENCES divisions(id)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      division_id TEXT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_by_job_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (mission_id, key)
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      division_id TEXT NOT NULL,
      job_id TEXT,
      action_type TEXT NOT NULL,
      preview TEXT NOT NULL,
      content TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      user_decision TEXT,
      edited_content TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS mission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mission_checkpoints (
      mission_id TEXT PRIMARY KEY,
      last_checkpoint_at INTEGER NOT NULL,
      snapshot TEXT
    );
  `)
  // Safe migration: add crash_count column to existing jobs tables
  try { db.prepare('ALTER TABLE jobs ADD COLUMN crash_count INTEGER NOT NULL DEFAULT 0').run() } catch {}
  // Safe migration: add snapshot column to existing mission_checkpoints tables
  try { db.prepare('ALTER TABLE mission_checkpoints ADD COLUMN snapshot TEXT').run() } catch {}
  // Safe migration: add token_summary column for per-mission token spend tracking
  try { db.prepare('ALTER TABLE missions ADD COLUMN token_summary TEXT').run() } catch {}
}

// ─── Missions ─────────────────────────────────────────────────────────────────

export function createMission(opts: {
  userId: string; goal: string; poolSize?: number; budgetUsd?: number
}): Mission {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO missions (id, user_id, goal, status, pool_size, budget_usd, spent_usd, created_at, updated_at)
    VALUES (?, ?, ?, 'planning', ?, ?, 0, ?, ?)
  `).run(id, opts.userId, opts.goal, opts.poolSize ?? config.MISSION_POOL_SIZE, opts.budgetUsd ?? config.MISSION_BUDGET_USD, now, now)
  return getMission(id)!
}

export function getMission(id: string): Mission | null {
  const row = db.prepare('SELECT * FROM missions WHERE id = ?').get(id)
  if (!row) return null
  return rowToMission(row)
}

export function getMissionsForUser(userId: string): Mission[] {
  return db.prepare('SELECT * FROM missions WHERE user_id = ? ORDER BY created_at DESC').all(userId).map(rowToMission)
}

export function getRunningMissions(): Mission[] {
  return (db.prepare("SELECT * FROM missions WHERE status = 'running' ORDER BY created_at").all() as any[]).map(rowToMission)
}

export function updateMissionStatus(id: string, status: MissionStatus, finalReport?: string): void {
  db.prepare('UPDATE missions SET status = ?, final_report = COALESCE(?, final_report), updated_at = ? WHERE id = ?')
    .run(status, finalReport ?? null, Date.now(), id)
}

export function writeMissionTokenSummary(id: string, tokenSummaryJson: string): void {
  db.prepare('UPDATE missions SET token_summary = ? WHERE id = ?').run(tokenSummaryJson, id)
}

function rowToMission(row: any): Mission {
  return {
    id: row.id,
    userId: row.user_id,
    goal: row.goal,
    status: row.status,
    poolSize: row.pool_size,
    budgetUsd: row.budget_usd,
    spentUsd: row.spent_usd,
    finalReport: row.final_report,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ─── Divisions ────────────────────────────────────────────────────────────────

export function createDivision(opts: {
  missionId: string
  goal: string
  role: string
  dependsOnArtifactKeys?: string[]
  parentDivisionId?: string
  depth?: number
}): Division {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO divisions (id, mission_id, parent_division_id, goal, role, status, depth, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, opts.missionId, opts.parentDivisionId ?? null, opts.goal, opts.role, opts.depth ?? 1, now)

  if (opts.dependsOnArtifactKeys?.length) {
    for (const key of opts.dependsOnArtifactKeys) {
      db.prepare('INSERT OR IGNORE INTO division_dependencies (division_id, artifact_key) VALUES (?, ?)')
        .run(id, key)
    }
  }
  return getDivision(id)!
}

export function getDivision(id: string): Division | null {
  const row = db.prepare('SELECT * FROM divisions WHERE id = ?').get(id)
  if (!row) return null
  return rowToDivision(row)
}

export function getDivisionsForMission(missionId: string): Division[] {
  return db.prepare('SELECT * FROM divisions WHERE mission_id = ? ORDER BY created_at').all(missionId).map(rowToDivision)
}

export function updateDivisionStatus(id: string, status: DivisionStatus, report?: string): void {
  const now = Date.now()
  const completedAt = (status === 'completed' || status === 'failed') ? now : null
  db.prepare('UPDATE divisions SET status = ?, report = COALESCE(?, report), completed_at = COALESCE(completed_at, ?) WHERE id = ?')
    .run(status, report ?? null, completedAt, id)
}

export function setPlanningContext(divisionId: string, context: string): void {
  db.prepare('UPDATE divisions SET planning_context = ? WHERE id = ?').run(context, divisionId)
}

export function getReadyDivisions(missionId: string): Division[] {
  // A division is ready when it's 'pending' and all its artifact dependencies are fulfilled
  const pending = db.prepare(`
    SELECT d.* FROM divisions d WHERE d.mission_id = ? AND d.status = 'pending'
  `).all(missionId).map(rowToDivision)

  const artifactRows = db.prepare('SELECT key, value FROM artifacts WHERE mission_id = ?').all(missionId) as any[]
  const artifactMap = new Map<string, string>(artifactRows.map((r: any) => [r.key as string, r.value as string]))

  const ready: Division[] = []
  const now = Date.now()

  for (const div of pending) {
    const deps = db.prepare('SELECT artifact_key FROM division_dependencies WHERE division_id = ?')
      .all(div.id).map((r: any) => r.artifact_key as string)

    // If any upstream artifact holds the sentinel value 'failed', cascade the failure
    const failedDep = deps.find(key => artifactMap.get(key) === 'failed')
    if (failedDep !== undefined) {
      const upstreamRole = failedDep.replace(/_done$/, '').replace(/_/g, ' ')
      db.prepare(`UPDATE divisions SET status = 'failed', report = ?, completed_at = ? WHERE id = ?`)
        .run(`Upstream division "${upstreamRole}" failed.`, now, div.id)
      continue
    }

    if (deps.every(key => artifactMap.has(key))) {
      ready.push(div)
    }
  }

  return ready
}

function rowToDivision(row: any): Division {
  return {
    id: row.id,
    missionId: row.mission_id,
    parentDivisionId: row.parent_division_id,
    goal: row.goal,
    role: row.role,
    status: row.status,
    depth: row.depth,
    report: row.report,
    planningContext: row.planning_context,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export function createJob(opts: {
  divisionId: string
  missionId: string
  description: string
  toolSet?: 'browser' | 'local' | 'all'
  dependsOnJobIds?: string[]
  maxAttempts?: number
}): Job {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO jobs (id, division_id, mission_id, description, tool_set, status, attempts, max_attempts, depends_on_job_ids, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(
    id, opts.divisionId, opts.missionId, opts.description,
    opts.toolSet ?? 'all', opts.maxAttempts ?? config.MISSION_MAX_ATTEMPTS,
    JSON.stringify(opts.dependsOnJobIds ?? []), now
  )
  return getJob(id)!
}

export function getJob(id: string): Job | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
  if (!row) return null
  return rowToJob(row)
}

export function getJobsForDivision(divisionId: string): Job[] {
  return db.prepare('SELECT * FROM jobs WHERE division_id = ? ORDER BY created_at').all(divisionId).map(rowToJob)
}

export function getReadyJobs(divisionId: string): Job[] {
  const allJobs = getJobsForDivision(divisionId)
  const completedIds = new Set(allJobs.filter(j => j.status === 'completed').map(j => j.id))
  return allJobs.filter(j =>
    j.status === 'pending' &&
    j.dependsOnJobIds.every(dep => completedIds.has(dep))
  )
}

export function updateJobStatus(id: string, status: JobStatus, outputSummary?: string): void {
  const now = Date.now()
  const completedAt = (status === 'completed' || status === 'failed') ? now : null
  // Only increment attempts when a job starts running — not on completion/failure.
  // Previously incremented on every call (2× per run), making maxAttempts comparisons
  // use incorrect counts (e.g. maxAttempts=1 would allow 2 runs).
  if (status === 'running') {
    db.prepare(`
      UPDATE jobs SET status = ?, attempts = attempts + 1, output_summary = COALESCE(?, output_summary),
      completed_at = COALESCE(completed_at, ?) WHERE id = ?
    `).run(status, outputSummary ?? null, completedAt, id)
  } else {
    db.prepare(`
      UPDATE jobs SET status = ?, output_summary = COALESCE(?, output_summary),
      completed_at = COALESCE(completed_at, ?) WHERE id = ?
    `).run(status, outputSummary ?? null, completedAt, id)
  }
}

export function resetJobForRetry(id: string): void {
  db.prepare("UPDATE jobs SET status = 'pending', completed_at = NULL WHERE id = ?").run(id)
}

export function resetOrphanedRunningJobs(missionId: string): void {
  db.prepare("UPDATE jobs SET status = 'pending', completed_at = NULL, crash_count = crash_count + 1 WHERE mission_id = ? AND status = 'running'").run(missionId)
}

export function resetOrphanedSynthesizingDivisions(missionId: string): void {
  db.prepare("UPDATE divisions SET status = 'executing' WHERE mission_id = ? AND status = 'synthesizing'").run(missionId)
}

export function setJobRetryContext(id: string, context: string): void {
  db.prepare("UPDATE jobs SET retry_context = ? WHERE id = ?").run(context, id)
}

export function countRunningJobs(missionId: string): number {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE mission_id = ? AND status = 'running'").get(missionId) as any
  return row.cnt
}

export function allJobsSettled(divisionId: string): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM jobs WHERE division_id = ? AND status NOT IN ('completed', 'failed')
  `).get(divisionId) as any
  return row.cnt === 0
}

// Marks pending jobs as failed if any of their dependencies has failed.
// Without this, a job whose dep failed stays 'pending' forever: getReadyJobs never
// returns it (only 'completed' deps count), so allJobsSettled never returns true,
// and the division never exits 'executing'.
export function failOrphanedJobs(divisionId: string): void {
  const jobs = db.prepare('SELECT * FROM jobs WHERE division_id = ? ORDER BY created_at').all(divisionId).map(rowToJob)
  const failedIds = new Set(jobs.filter(j => j.status === 'failed').map(j => j.id))
  if (failedIds.size === 0) return
  const now = Date.now()
  for (const job of jobs) {
    if (job.status !== 'pending') continue
    if (job.dependsOnJobIds.some(dep => failedIds.has(dep))) {
      db.prepare(`UPDATE jobs SET status = 'failed', output_summary = 'Skipped: a required dependency job failed.', completed_at = ? WHERE id = ?`)
        .run(now, job.id)
    }
  }
}

function rowToJob(row: any): Job {
  return {
    id: row.id,
    divisionId: row.division_id,
    missionId: row.mission_id,
    description: row.description,
    toolSet: row.tool_set,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    dependsOnJobIds: JSON.parse(row.depends_on_job_ids || '[]'),
    outputSummary: row.output_summary,
    retryContext: row.retry_context ?? null,
    crashCount: row.crash_count ?? 0,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

// ─── Artifacts ────────────────────────────────────────────────────────────────

export function writeArtifact(opts: {
  missionId: string
  divisionId?: string
  key: string
  value: string
  createdByJobId?: string
}): void {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO artifacts (id, mission_id, division_id, key, value, created_by_job_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (mission_id, key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at
  `).run(id, opts.missionId, opts.divisionId ?? null, opts.key, opts.value, opts.createdByJobId ?? null, now)
}

export function readArtifact(missionId: string, key: string): string | null {
  const row = db.prepare('SELECT value FROM artifacts WHERE mission_id = ? AND key = ?').get(missionId, key) as any
  return row?.value ?? null
}

export function readArtifacts(missionId: string, keys?: string[]): Record<string, string> {
  const rows = keys?.length
    ? db.prepare(`SELECT key, value FROM artifacts WHERE mission_id = ? AND key IN (${keys.map(() => '?').join(',')})`)
        .all(missionId, ...keys)
    : db.prepare('SELECT key, value FROM artifacts WHERE mission_id = ?').all(missionId)
  const result: Record<string, string> = {}
  for (const row of rows as any[]) result[row.key] = row.value
  return result
}

export function getArtifactsForMission(missionId: string): Artifact[] {
  return (db.prepare('SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at').all(missionId) as any[])
    .map(row => ({
      id: row.id, missionId: row.mission_id, divisionId: row.division_id,
      key: row.key, value: row.value, createdByJobId: row.created_by_job_id, createdAt: row.created_at,
    }))
}

// ─── Approvals ────────────────────────────────────────────────────────────────

export function createApprovalRequest(opts: {
  missionId: string; divisionId: string; jobId?: string
  actionType: string; preview: string; content?: string
}): ApprovalRequest {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO approval_requests (id, mission_id, division_id, job_id, action_type, preview, content, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, opts.missionId, opts.divisionId, opts.jobId ?? null, opts.actionType, opts.preview, opts.content ?? null, now)
  return getApprovalRequest(id)!
}

export function getApprovalRequest(id: string): ApprovalRequest | null {
  const row = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as any
  if (!row) return null
  return rowToApproval(row)
}

export function getPendingApprovals(missionId: string): ApprovalRequest[] {
  return (db.prepare("SELECT * FROM approval_requests WHERE mission_id = ? AND status = 'pending' ORDER BY created_at")
    .all(missionId) as any[]).map(rowToApproval)
}

export function resolveApproval(id: string, decision: 'approved' | 'denied', editedContent?: string): number {
  const result = db.prepare("UPDATE approval_requests SET status = ?, user_decision = ?, edited_content = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .run(decision, decision, editedContent ?? null, Date.now(), id)
  return result.changes
}

function rowToApproval(row: any): ApprovalRequest {
  return {
    id: row.id, missionId: row.mission_id, divisionId: row.division_id, jobId: row.job_id,
    actionType: row.action_type, preview: row.preview, content: row.content,
    status: row.status, userDecision: row.user_decision, editedContent: row.edited_content,
    createdAt: row.created_at, decidedAt: row.decided_at,
  }
}

// ─── Create mission from pre-approved plan (skips CEO planning LLM) ──────────

function _roleToKey(role: string): string {
  return role.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_done'
}

export function createMissionFromPlan(opts: {
  userId: string
  goal: string
  plan: {
    brief: string
    divisions: Array<{
      role: string
      goal: string
      dependsOnRoles: string[]
      jobs: Array<{ description: string; toolSet: 'browser' | 'local' | 'all' }>
    }>
  }
  poolSize?: number
  budgetUsd?: number
}): Mission {
  const { userId, goal, plan, poolSize = config.MISSION_POOL_SIZE, budgetUsd = config.MISSION_BUDGET_USD } = opts

  let missionId: string

  // All writes are atomic: either the full mission record set is created or nothing is.
  db.exec('BEGIN')
  try {
    const mission = createMission({ userId, goal, poolSize, budgetUsd })
    missionId = mission.id

    writeArtifact({ missionId: mission.id, key: 'mission_brief', value: plan.brief })

    for (const pd of plan.divisions) {
      const dependsOnArtifactKeys = pd.dependsOnRoles.map(_roleToKey)
      const div = createDivision({
        missionId: mission.id,
        goal: pd.goal,
        role: pd.role,
        dependsOnArtifactKeys,
      })

      // Jobs are pre-created. Division stays 'pending' so the scheduler's
      // dependency check (getReadyDivisions) still gates it on artifact keys.
      // The scheduler detects pre-created jobs and skips the manager LLM.
      for (const pj of pd.jobs) {
        createJob({
          divisionId: div.id,
          missionId: mission.id,
          description: pj.description,
          toolSet: pj.toolSet,
          dependsOnJobIds: [],
          maxAttempts: config.MISSION_MAX_ATTEMPTS,
        })
      }
    }

    // Set status to running — scheduler will pick up immediately
    updateMissionStatus(mission.id, 'running')
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch {}
    throw err
  }

  return getMission(missionId!)!
}

// ─── Events ───────────────────────────────────────────────────────────────────

const _eventCounters = new Map<string, number>()

export function logEvent(missionId: string, type: string, payload: Record<string, unknown> = {}): void {
  const now = Date.now()
  db.prepare('INSERT INTO mission_events (mission_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
    .run(missionId, type, JSON.stringify(payload), now)
  const n = (_eventCounters.get(missionId) ?? 0) + 1
  _eventCounters.set(missionId, n)
  if (n % config.CHECKPOINT_INTERVAL === 0) {
    const divisions = (db.prepare('SELECT id, status, role FROM divisions WHERE mission_id = ?').all(missionId) as any[])
      .map(r => ({ id: r.id, status: r.status, role: r.role }))
    const jobs = (db.prepare('SELECT id, status, attempts, crash_count FROM jobs WHERE mission_id = ?').all(missionId) as any[])
      .map(r => ({ id: r.id, status: r.status, attempts: r.attempts, crashCount: r.crash_count }))
    const artifactKeys = (db.prepare('SELECT key FROM artifacts WHERE mission_id = ?').all(missionId) as any[])
      .map(r => r.key as string)
    const snapshot = JSON.stringify({ divisions, jobs, artifactKeys })
    db.prepare('INSERT INTO mission_checkpoints (mission_id, last_checkpoint_at, snapshot) VALUES (?, ?, ?) ON CONFLICT (mission_id) DO UPDATE SET last_checkpoint_at = excluded.last_checkpoint_at, snapshot = excluded.snapshot')
      .run(missionId, now, snapshot)
  }
}

export function getEvents(missionId: string, limit = 200): MissionEvent[] {
  return (db.prepare('SELECT * FROM mission_events WHERE mission_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(missionId, limit) as any[]).map(row => ({
      id: row.id, missionId: row.mission_id, type: row.type,
      payload: JSON.parse(row.payload || '{}'), createdAt: row.created_at,
    }))
}
