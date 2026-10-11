export type SubTaskToolSet = 'browser' | 'local' | 'all'

export interface SubTaskSpec {
  goal: string
  context?: string
  toolSet?: SubTaskToolSet
  // When set to 'user_voice', the system injects writing samples + identity
  // from the user's profile into the sub-agent's system prompt. Set this for
  // any drafting or writing sub-task. Never pass actual sample text here.
  voiceContext?: 'user_voice'
}

export interface SubTaskResult {
  taskIndex: number
  status: 'completed' | 'failed'
  summary: string
  durationMs: number
}

export interface DelegateTasksArgs {
  tasks: SubTaskSpec[]
}

export interface DelegateTasksResult {
  results: SubTaskResult[]
  totalDurationMs: number
}
