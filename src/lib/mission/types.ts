export type MissionStatus = 'planning' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted'
export type DivisionStatus = 'pending' | 'planning' | 'executing' | 'synthesizing' | 'completed' | 'failed'
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timed_out'
export type AgentTier = 'ceo' | 'manager' | 'worker'

export interface Mission {
  id: string
  userId: string
  goal: string
  status: MissionStatus
  poolSize: number
  budgetUsd: number
  spentUsd: number
  finalReport: string | null
  createdAt: number
  updatedAt: number
}

export interface Division {
  id: string
  missionId: string
  parentDivisionId: string | null
  goal: string
  role: string
  status: DivisionStatus
  depth: number
  report: string | null
  planningContext: string | null   // serialized artifact keys available when planning ran
  createdAt: number
  completedAt: number | null
}

export interface Job {
  id: string
  divisionId: string
  missionId: string
  description: string
  toolSet: 'browser' | 'local' | 'all'
  status: JobStatus
  attempts: number
  maxAttempts: number
  dependsOnJobIds: string[]        // job IDs this must wait for
  outputSummary: string | null
  retryContext: string | null
  crashCount: number
  createdAt: number
  completedAt: number | null
}

export interface Artifact {
  id: string
  missionId: string
  divisionId: string | null
  key: string
  value: string
  createdByJobId: string | null
  createdAt: number
}

export interface ApprovalRequest {
  id: string
  missionId: string
  divisionId: string
  jobId: string | null
  actionType: string
  preview: string
  content: string | null
  status: ApprovalStatus
  userDecision: string | null
  editedContent: string | null
  createdAt: number
  decidedAt: number | null
}

export interface MissionEvent {
  id: number
  missionId: string
  type: string
  payload: Record<string, unknown>
  createdAt: number
}

export interface LaunchMissionOpts {
  missionId: string           // pre-created mission record ID
  userId: string
  goal: string
  poolSize?: number
  budgetUsd?: number
  abortSignal?: AbortSignal
  onProgress: (msg: string) => void
}

export interface MissionTree {
  mission: Mission
  divisions: Array<Division & { jobs: Job[] }>
  artifacts: Artifact[]
  pendingApprovals: ApprovalRequest[]
}
