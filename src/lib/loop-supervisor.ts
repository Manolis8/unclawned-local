// loop-supervisor.ts
// Deterministic between-turn monitor for the agent loop.
// Runs after every tool dispatch — zero LLM cost.

export type SupervisorDirective =
  | { action: 'continue' }
  | { action: 'inject_correction'; message: string }
  | { action: 'inject_checkpoint'; message: string }
  | { action: 'force_partial'; reason: string }

export class LoopSupervisor {
  confidence = 70                        // 0-100, starts at 70
  private stepCount = 0
  private readonly stepBudget: number
  private consecutiveErrors = 0
  private checkpoint50Fired = false
  private checkpoint80Fired = false

  constructor(stepBudget = 25) {
    this.stepBudget = stepBudget
  }

  // Call once per tool dispatch turn. Returns a directive telling the loop
  // what to inject (or not) before the next LLM call.
  checkAfterTurn(
    toolName: string,
    _result: string,
    isError: boolean,
    patternDetected: boolean,
    correctionMessage: string,
    currentTurn: number
  ): SupervisorDirective {
    this.stepCount++

    // Update live confidence based on real signals
    if (isError) {
      this.confidence = Math.max(0, this.confidence - 8)
      this.consecutiveErrors++
    } else {
      this.confidence = Math.min(100, this.confidence + 3)
      this.consecutiveErrors = 0
    }

    // Pattern detected: same (tool, error fingerprint) 3+ times in the window
    if (patternDetected) {
      this.confidence = Math.max(0, this.confidence - 15)
      return {
        action: 'inject_correction',
        message:
          `[Loop Supervisor] You have called ${toolName} and received the same error 3 times in a row. This approach is not working.\n` +
          `${correctionMessage}\n` +
          `Do NOT call ${toolName} again with the same arguments.`,
      }
    }

    // Confidence collapse: 3 consecutive errors + confidence below threshold
    if (this.consecutiveErrors >= 3 && this.confidence < 30) {
      return {
        action: 'inject_correction',
        message:
          `[Loop Supervisor] You appear to be stuck — ${this.consecutiveErrors} consecutive tool failures with confidence at ${this.confidence}%. ` +
          `Try a completely different approach. Describe what you have found so far, then try a different strategy.`,
      }
    }

    // Step budget enforcement — checkpoints fire once each, at 50% and 80%
    const pct = this.stepCount / this.stepBudget
    if (pct >= 1.0) {
      return { action: 'force_partial', reason: `Step budget exhausted (${this.stepCount}/${this.stepBudget} steps)` }
    }
    if (pct >= 0.8 && !this.checkpoint80Fired) {
      this.checkpoint80Fired = true
      return {
        action: 'inject_checkpoint',
        message:
          `[Loop Supervisor] You have used ${this.stepCount} of ${this.stepBudget} steps (80%). ` +
          `You have approximately ${this.stepBudget - this.stepCount} steps remaining. ` +
          `Finalize with what you have or call task_partial with partial results.`,
      }
    }
    if (pct >= 0.5 && !this.checkpoint50Fired) {
      this.checkpoint50Fired = true
      return {
        action: 'inject_checkpoint',
        message:
          `[Loop Supervisor] You are halfway through your step budget (${this.stepCount}/${this.stepBudget} steps). ` +
          `What have you found so far? Commit to a clear path to complete the task efficiently.`,
      }
    }

    return { action: 'continue' }
  }
}
