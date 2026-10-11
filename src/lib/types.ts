// ============================================
// SKILL TYPES
// ============================================

export interface RuntimeVariable {
  name: string       // kebab-case key used in {{ }} substitution
  question: string   // what to ask the user at run time
  type: 'text' | 'choice'
  options?: string[] // only for choice type
  default?: string
}

export interface ChatSkillTemplate {
  systemPrompt: string
  variables: string[]
  outputDescription: string
  exampleOutput?: string
  runtimeVariables?: RuntimeVariable[]
}

export interface HybridSkillStep {
  number: number
  type: 'browser' | 'chat'
  title: string
  description: string
  needs: number[]          // 0-based indices of prior steps whose output this needs
  // browser-only
  url?: string
  selectors?: string[]
  fallbackSelectors?: string[]
  value?: string
  expected?: string
  timeout?: number
  onError?: 'retry' | 'pause' | 'abort'
  uncertain?: boolean
  // Rich agent-hint fields (same as ExecutionStep — optional so old hybrid plans keep working)
  agentAction?: string
  agentDetail?: string
  expectedPageType?: string
  successCondition?: string
  frictionBefore?: string[]
  goal?: string
  note?: string
  onFailureMode?: OnFailureMode
}

export interface HybridSkillPlan {
  steps: HybridSkillStep[]
  variables: string[]
  estimatedTime: string
  userPreferences?: string
  runtimeVariables?: RuntimeVariable[]
}

export interface Skill {
  id: string
  user_id: string
  skill_name: string
  skill_description: string
  execution_plan: ExecutionPlan
  plan_generated_at?: string
  plan_approved_at?: string
  status: 'draft' | 'approved' | 'active'
  is_public: boolean
  variables?: InputVariable[]
  learned_improvements?: string  // raw JSON string: string[]
  run_count?: number
  success_count?: number
  version?: number
  created_at: string
  updated_at: string
}

export interface InputVariable {
  id: string
  skill_id: string
  variable_name: string
  variable_type: 'text' | 'number' | 'select' | 'checkbox'
  description?: string
  is_required: boolean
  default_value?: string
  created_at: string
}

export interface Phase {
  number: number
  name: string
  description: string
}

export type StepFieldUpdateTarget =
  | 'selectors'
  | 'fallbackSelectors'
  | 'frictionBefore'
  | 'agentDetail'
  | 'note'
  | 'successCondition'
  | 'expectedPageType'
  | 'url'
  | 'value'

export interface StepFieldUpdate {
  stepNumber: number
  field: StepFieldUpdateTarget
  newValue: any
  reason: string
}

export interface OnFailureMode {
  type: 'retry' | 'skipToStep' | 'frictionHandler' | 'exitSkill'
  maxAttempts?: number    // retry: how many times (max 3)
  stepNumber?: number     // skipToStep: which step to jump to
  reason?: string         // skipToStep: why we skip
  handlerName?: string    // frictionHandler: which registry entry
  errorCode?: string      // exitSkill: machine-readable code
  userMessage?: string    // exitSkill: shown to the user
}

export interface ExecutionPlan {
  steps: ExecutionStep[]
  variables: string[]
  estimatedTime: string
  errorHandling: ErrorHandlingStrategy
  runtimeVariables?: RuntimeVariable[]
  phases?: Phase[]        // from phase decomposition turn
}

export interface ExecutionStep {
  number: number
  title: string
  action: 'navigate' | 'click' | 'type' | 'verify' | 'wait'
  url?: string
  selectors?: string[]
  fallbackSelectors?: string[]
  value?: string
  expected?: string
  timeout: number
  onError: 'retry' | 'pause' | 'abort'
  description: string
  uncertain?: boolean
  // Rich agent-hint fields (Part 2+) — optional so old skills keep working
  agentAction?: string
  agentDetail?: string
  expectedPageType?: string
  successCondition?: string
  frictionBefore?: string[]
  goal?: string
  note?: string
  onFailureMode?: OnFailureMode
  // Sub-skill reference (agentAction: 'use_sub_skill')
  subSkillName?: string
  subSkillParams?: Record<string, string>
}

export interface ErrorHandlingStrategy {
  maxRetries: number
  pauseOnError: boolean
  userInterventionSteps: number[]
}

// ============================================
// EXECUTION TYPES
// ============================================

export interface SkillExecution {
  id: string
  skill_id: string
  user_id: string
  input_values: Record<string, string>
  status: 'running' | 'success' | 'error' | 'paused'
  execution_log: StepUpdate[]
  started_at: string
  completed_at?: string
  duration_seconds?: number
  error_message?: string
  final_url?: string
  created_at: string
}

export interface StepUpdate {
  stepNumber: number
  action: string
  status: 'running' | 'success' | 'error' | 'paused'
  duration?: number
  error?: string
  timestamp: string
}

// ============================================
// API RESPONSE TYPES
// ============================================

export interface CreatePlanResponse {
  plan: ExecutionPlan
  questions: ClarifyingQuestion[]
  inputs: InputVariable[]
}

export interface ClarifyingQuestion {
  question: string
  options: string[]
  type: 'yes_no' | 'multiple_choice'
}

export interface ExecutionResult {
  success: boolean
  log: StepUpdate[]
  finalUrl?: string
  errorMessage?: string
  durationMs: number
}

// ============================================
// DATABASE TYPES
// ============================================

export interface CreateSkillInput {
  skill_name: string
  skill_description: string
  execution_plan: ExecutionPlan
  status?: 'draft' | 'approved' | 'active'
  is_public?: boolean
}

export interface CreateInputVariableInput {
  variable_name: string
  variable_type: 'text' | 'number' | 'select' | 'checkbox'
  description?: string
  is_required: boolean
  default_value?: string
}
