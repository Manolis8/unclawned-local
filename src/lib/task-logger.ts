import { db, uuid, j } from './db.js'

export interface TaskStep {
  stepNumber: number
  toolName: string
  ref?: string
  text?: string
  url?: string
  result: string
  confidence: number
  status: 'success' | 'failed' | 'warning'
}

export interface TaskLog {
  taskId: string
  userId: string
  userPrompt: string
  status: 'started' | 'in_progress' | 'completed' | 'failed'
  plan?: string
  steps: TaskStep[]
  totalTime?: number
  iterationsUsed?: number
  totalSteps?: number
  finalConfidence?: number
  improvements?: string
}

class TaskLogger {
  private log: TaskLog
  private startTime: number
  private silent: boolean

  constructor(taskId: string, userId: string, userPrompt: string, silent = false) {
    this.log = { taskId, userId, userPrompt, status: 'started', steps: [] }
    this.startTime = Date.now()
    this.silent = silent
    if (!silent) {
      console.log(`[LOGGER] Task started: ${taskId}`)
      console.log(`[LOGGER] User prompt: "${userPrompt}"`)
    }
  }

  setPlan(plan: string) {
    this.log.plan = plan
  }

  updateLastStepConfidence(confidence: number) {
    if (this.log.steps.length > 0) {
      this.log.steps[this.log.steps.length - 1].confidence = confidence
    }
  }

  addStep(step: TaskStep) {
    this.log.steps.push(step)
    if (!this.silent) {
      console.log(
        `[LOGGER] Step ${step.stepNumber}: ${step.toolName} | ` +
        `Confidence: ${step.confidence}% | Status: ${step.status}`
      )
    }
  }

  addBrowserStep(
    stepNumber: number,
    toolName: string,
    ref: string | undefined,
    result: string,
    confidence: number,
    url?: string,
    text?: string
  ) {
    this.addStep({
      stepNumber, toolName, ref, text, url, result, confidence,
      status: confidence >= 80 ? 'success' : confidence >= 50 ? 'warning' : 'failed'
    })
  }

  async finalize(
    finalStatus: 'completed' | 'failed',
    iterationsUsed: number,
    finalConfidence: number,
    improvements?: string
  ) {
    const totalTimeSeconds = Math.round((Date.now() - this.startTime) / 1000)
    this.log.status = finalStatus
    this.log.iterationsUsed = iterationsUsed
    this.log.totalSteps = this.log.steps.length
    this.log.finalConfidence = finalConfidence
    this.log.totalTime = totalTimeSeconds
    this.log.improvements = improvements

    if (!this.silent) {
      console.log(`[LOGGER] Task finalized: ${finalStatus}`)
      console.log(`[LOGGER] Time: ${totalTimeSeconds}s | Steps: ${this.log.steps.length} | Confidence: ${finalConfidence}%`)
    }

    try {
      db.prepare(`
        INSERT INTO task_logs (id, task_id, user_id, user_prompt, status, plan, steps, total_time, iterations_used, total_steps, final_confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(), this.log.taskId, this.log.userId, this.log.userPrompt,
        this.log.status, this.log.plan ?? null, j(this.log.steps),
        this.log.totalTime ?? null, this.log.iterationsUsed ?? null,
        this.log.totalSteps ?? null, this.log.finalConfidence ?? null
      )
      if (!this.silent) console.log('[LOGGER] Log saved to local DB')
    } catch (err) {
      console.error('[LOGGER] Error saving log:', err)
    }
  }

  getFormattedLog(): string {
    const stepsList = this.log.steps
      .map(step => {
        const ref = step.ref
          ? ` { ref: "${step.ref}"${step.text ? `, text: "${step.text}"` : ''}${step.url ? `, url: "${step.url}"` : ''} }`
          : ''
        return (
          `Step ${step.stepNumber}: ${step.toolName}${ref}\n` +
          `  Result: ${step.result}\n` +
          `  Confidence: ${step.confidence}%`
        )
      })
      .join('\n\n')

    return `
═════════════════════════════════════════════════════════════
TASK LOG
═════════════════════════════════════════════════════════════

Task ID: ${this.log.taskId}
Prompt: "${this.log.userPrompt}"
Status: ${this.log.status === 'completed' ? '✅' : '❌'} ${this.log.status.toUpperCase()}
Time: ${this.log.totalTime}s | Steps: ${this.log.totalSteps}/${this.log.iterationsUsed} | Confidence: ${this.log.finalConfidence}%

─────────────────────────────────────────────────────────────
PLAN
─────────────────────────────────────────────────────────────
${this.log.plan || 'No plan'}

─────────────────────────────────────────────────────────────
EXECUTION STEPS
─────────────────────────────────────────────────────────────
${stepsList}

─────────────────────────────────────────────────────────────
IMPROVEMENTS FOR NEXT TIME
─────────────────────────────────────────────────────────────
${this.log.improvements || 'None recorded'}

═════════════════════════════════════════════════════════════
`
  }
}

export function createTaskLogger(taskId: string, userId: string, userPrompt: string, silent = false) {
  return new TaskLogger(taskId, userId, userPrompt, silent)
}
