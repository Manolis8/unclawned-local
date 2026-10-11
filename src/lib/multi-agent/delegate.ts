import { randomUUID } from 'crypto'
import { getWritingSamples, loadUserMd } from '../user-profile.js'
import type { DelegateTasksArgs, DelegateTasksResult, SubTaskResult, SubTaskSpec } from './types.js'

const MAX_TASKS = 3
const MAX_DEPTH = 1
// Per-summary budget: split evenly across the batch, floor at 2000 chars.
// Head 75% / tail 25% trim on overflow, snapped to newline boundaries.
const MIN_SUMMARY_CHARS = 2000
const MAX_TOTAL_SUMMARY_CHARS = 12000

// Tools sub-agents are never allowed to call regardless of toolSet.
// All browser_* interaction tools share a single CDP connection per user —
// parallel calls from multiple sub-agents would interleave tab state.
export const SUB_AGENT_BLOCKED_TOOLS = new Set([
  'delegate_tasks',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_key',
  'browser_hover',
  'browser_select',
  'browser_page_scroll',
  'browser_scroll_to_ref',
  'browser_snapshot',
  'browser_wait',
  'browser_wait_for',
  'browser_evaluate',
  'browser_dismiss_cookie',
  'browser_switch_tab',
  'perceive_page',
  'read_page_content',
  'scroll_and_read',
  'go_back',
  'confirm_action',
  'get_mid_action_plan',
  'patch_skill',
  'search_skills',
  'load_skill',
])

function trimSummary(text: string, budget: number): string {
  if (text.length <= budget) return text
  const head = Math.floor(budget * 0.75)
  const tail = budget - head
  let headStr = text.slice(0, head)
  let tailStr = text.slice(-tail)
  const headNl = headStr.lastIndexOf('\n')
  if (headNl > head * 0.5) headStr = headStr.slice(0, headNl)
  const tailNl = tailStr.indexOf('\n')
  if (tailNl >= 0 && tailNl < tail * 0.3) tailStr = tailStr.slice(tailNl + 1)
  return `${headStr}\n...[trimmed]...\n${tailStr}`
}

function buildVoiceBlock(userId: string): string {
  const parts: string[] = []

  const userMd = loadUserMd()
  if (userMd) {
    // Extract identity + voice sections only (not goals/autonomy/platforms)
    const identityLines: string[] = []
    let inSection = false
    for (const line of userMd.split('\n')) {
      if (line.startsWith('**About the user') || line.startsWith('**Communication style')) {
        inSection = true
      } else if (line.startsWith('**') && inSection) {
        inSection = false
      }
      if (inSection || line.startsWith('**About the user') || line.startsWith('**Communication style')) {
        identityLines.push(line)
      }
    }
    if (identityLines.length > 0) {
      parts.push(`## Who you're writing for\n${identityLines.join('\n')}`)
    }
  }

  const samples = getWritingSamples(userId)
  if (samples.length > 0) {
    // Cap at 3 most recent samples, 600 chars each to stay within budget
    const sampleText = samples
      .slice(0, 3)
      .map((s, i) => {
        const label = s.source_platform ? ` (${s.source_platform})` : ''
        return `[Sample ${i + 1}${label}]\n${s.content.slice(0, 600)}`
      })
      .join('\n\n---\n\n')
    parts.push(`## Writing samples — match this voice exactly\n${sampleText}`)
  }

  if (parts.length === 0) return ''
  return `\n\n${parts.join('\n\n')}`
}

export async function delegateTasks(
  args: DelegateTasksArgs,
  opts: {
    userId: string
    parentTaskId: string
    delegateDepth: number
    onProgress: (msg: string) => Promise<void>
    abortSignal?: AbortSignal
  }
): Promise<DelegateTasksResult> {
  const { tasks } = args
  const { userId, parentTaskId, delegateDepth, onProgress, abortSignal } = opts

  // Depth gate — hard rejection
  if (delegateDepth >= MAX_DEPTH) {
    throw new Error(
      `Delegation depth limit reached (max depth ${MAX_DEPTH}). Sub-agents cannot spawn further sub-agents.`
    )
  }

  // Batch size gate — hard rejection
  if (tasks.length === 0) {
    throw new Error('delegate_tasks requires at least 1 task.')
  }
  if (tasks.length > MAX_TASKS) {
    throw new Error(
      `Too many tasks: ${tasks.length} requested, maximum is ${MAX_TASKS}. Split into two sequential delegate_tasks calls.`
    )
  }

  await onProgress(`🔀 Delegating ${tasks.length} sub-task${tasks.length > 1 ? 's' : ''}...`)

  // Dynamic import to avoid circular dependency (agent-extension imports this module)
  const { runAgentLoop } = await import('../agent-extension.js')

  const perSummaryBudget = Math.max(
    MIN_SUMMARY_CHARS,
    Math.floor(MAX_TOTAL_SUMMARY_CHARS / tasks.length)
  )

  // Shared web tool quota across all sub-agents in this batch.
  // Without this, each sub-agent gets its own cap of 10, making 3 sub-agents = 30 calls.
  // With this ref, the whole batch shares a single counter — mutations are visible to all.
  const sharedWebToolCountRef = { value: 0, cap: 10 }

  const startedAt = Date.now()

  const settled = await Promise.allSettled(
    tasks.map((task: SubTaskSpec, i: number) => {
      const subTaskId = `${parentTaskId}-sub${i}-${randomUUID().slice(0, 8)}`
      const tabKey = `sub-${i}-${Date.now()}`

      const voiceBlock =
        task.voiceContext === 'user_voice' ? buildVoiceBlock(userId) : ''

      const subStart = Date.now()
      return runAgentLoop({
        userId,
        taskId: subTaskId,
        taskPrompt: task.goal,
        tabKey,
        onProgress: async (msg: string) => {
          await onProgress(`  [sub-agent ${i + 1}] ${msg}`)
        },
        context: task.context,
        abortSignal,
        toolSet: task.toolSet ?? 'all',
        richContext: false,
        delegateDepth: delegateDepth + 1,
        voiceContextBlock: voiceBlock || undefined,
        blockedTools: SUB_AGENT_BLOCKED_TOOLS,
        preserveTodos: true,        // parent owns the todo list; sub-agents must not wipe it
        sharedWebToolCountRef,      // shared across all sub-agents in this batch
      }).then((r: { success: boolean; summary: string }) => ({
        ...r,
        taskIndex: i,
        durationMs: Date.now() - subStart,
      }))
    })
  )

  const results: SubTaskResult[] = settled.map((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      const r = outcome.value as { success: boolean; summary: string; taskIndex: number; durationMs: number }
      return {
        taskIndex: i,
        status: r.success ? 'completed' : 'failed',
        summary: trimSummary(r.summary, perSummaryBudget),
        durationMs: r.durationMs,
      }
    } else {
      return {
        taskIndex: i,
        status: 'failed',
        summary: String(outcome.reason instanceof Error ? outcome.reason.message : outcome.reason),
        durationMs: 0,
      }
    }
  })

  const totalDurationMs = Date.now() - startedAt

  const completedCount = results.filter(r => r.status === 'completed').length
  const failedCount = results.length - completedCount
  const summaryLine =
    failedCount === 0
      ? `all ${results.length} completed`
      : `${completedCount} completed, ${failedCount} failed`
  await onProgress(
    `✅ Delegation complete (${(totalDurationMs / 1000).toFixed(1)}s — ${summaryLine})`
  )

  return { results, totalDurationMs }
}

export function formatDelegateResult(result: DelegateTasksResult): string {
  const lines: string[] = [
    `Delegation complete (${(result.totalDurationMs / 1000).toFixed(1)}s total):`,
    '',
  ]
  for (const r of result.results) {
    const statusIcon = r.status === 'completed' ? '✓' : '✗'
    const durationStr = r.durationMs > 0 ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : ''
    const failLabel = r.status === 'failed' ? ' — failed' : ''
    lines.push(`[Sub-agent ${r.taskIndex + 1}] ${statusIcon}${durationStr}${failLabel}`)
    lines.push(r.summary)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
