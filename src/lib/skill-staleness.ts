import {
  getRecentSkillExecutions,
  countPendingPatchesPerStep,
  setSkillStaleness,
  isSkillPinned,
} from '../db/queries.js'

const CONSECUTIVE_FAILURE_THRESHOLD = 2
const SUCCESS_RATE_MIN = 0.4
const SUCCESS_RATE_MIN_RUNS = 5
const PATCH_PILE_UP_THRESHOLD = 3

interface StalenessResult {
  stale: boolean
  reason: string | null
}

function evaluate(skillId: string): StalenessResult {
  const executions = getRecentSkillExecutions(skillId, 10)

  if (executions.length === 0) return { stale: false, reason: null }

  // Signal 1: consecutive failures from most recent run
  let consecutiveFails = 0
  for (const e of executions) {
    if (e.status === 'error') consecutiveFails++
    else break
  }
  if (consecutiveFails >= CONSECUTIVE_FAILURE_THRESHOLD) {
    return { stale: true, reason: `Failed ${consecutiveFails} times in a row — the skill plan may be outdated` }
  }

  // Signal 2: low success rate (only meaningful with enough data)
  if (executions.length >= SUCCESS_RATE_MIN_RUNS) {
    const successRate = executions.filter(e => e.status === 'success').length / executions.length
    if (successRate < SUCCESS_RATE_MIN) {
      const pct = Math.round(successRate * 100)
      return { stale: true, reason: `Only ${pct}% success rate in last ${executions.length} runs — steps may need review` }
    }
  }

  // Signal 3: patch proposal pile-up on a single step
  const patchCounts = countPendingPatchesPerStep(skillId)
  for (const [step, count] of Object.entries(patchCounts)) {
    if (count >= PATCH_PILE_UP_THRESHOLD) {
      return { stale: true, reason: `Step ${step} has ${count} pending patch proposals — likely needs updating` }
    }
  }

  return { stale: false, reason: null }
}

export async function checkSkillStalenessAsync(skillId: string, wasSuccess: boolean): Promise<void> {
  try {
    // Pinned skills are exempt from all autonomous mutations
    if (isSkillPinned(skillId)) return

    if (wasSuccess) {
      // A successful run clears staleness — the skill is working again
      setSkillStaleness(skillId, null, null)
      return
    }

    const result = evaluate(skillId)
    if (result.stale) {
      setSkillStaleness(skillId, 'stale', result.reason)
      console.log(`[skill-staleness] Marked skill ${skillId} as stale: ${result.reason}`)
    }
  } catch (err) {
    console.warn('[skill-staleness] Staleness check failed (non-fatal):', (err as Error).message)
  }
}
