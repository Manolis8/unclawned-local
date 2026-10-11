import readline from 'node:readline'
import { runAgentWithExtension } from './agent-extension.js'
import { resolveRuntime } from './model-router.js'

// ─── Scratchpad ────────────────────────────────────────────────────────────────
// In-memory, keyed sections. Grows as agents complete work. Total size capped at
// 15000 chars — oldest section compressed to its last 300 chars when exceeded.

const SCRATCHPAD_SIZE_CAP = 15_000
const SCRATCHPAD_COMPRESS_TO = 300
const SCRATCHPAD_SUMMARY_CAP = 4_000
const MAX_CYCLES = 20
const MAX_PARALLEL_AGENTS = 3
const TOKEN_CEILING = 100_000

interface ScratchpadSection {
  content: string
  addedAt: number
}

interface Scratchpad {
  sections: Map<string, ScratchpadSection>
}

function scratchpadAdd(sp: Scratchpad, key: string, content: string): void {
  sp.sections.set(key, { content, addedAt: Date.now() })

  let totalSize = 0
  for (const s of sp.sections.values()) totalSize += s.content.length
  if (totalSize <= SCRATCHPAD_SIZE_CAP) return

  // Compress oldest sections (excluding the one just added) until under the cap
  const sorted = [...sp.sections.entries()].sort((a, b) => a[1].addedAt - b[1].addedAt)
  for (const [k, v] of sorted) {
    if (k === key) continue
    if (totalSize <= SCRATCHPAD_SIZE_CAP) break
    const compressed = v.content.slice(-SCRATCHPAD_COMPRESS_TO)
    const reduction = v.content.length - compressed.length
    sp.sections.set(k, { ...v, content: `...[compressed]\n${compressed}` })
    totalSize -= reduction
  }
}

function scratchpadSummary(sp: Scratchpad): string {
  const parts: string[] = []
  let totalChars = 0
  for (const [key, { content }] of sp.sections.entries()) {
    const line = `[${key}]\n${content}`
    if (totalChars + line.length > SCRATCHPAD_SUMMARY_CAP) break
    parts.push(line)
    totalChars += line.length
  }
  return parts.join('\n\n')
}

function getRelevantSections(sp: Scratchpad, keys: string[]): string {
  if (keys.length === 0) return ''
  const parts: string[] = []
  for (const key of keys) {
    const section = sp.sections.get(key)
    if (section) parts.push(`[${key}]\n${section.content}`)
  }
  return parts.join('\n\n')
}

// ─── Think step ────────────────────────────────────────────────────────────────

type SpawnTask = {
  id: string
  description: string
  toolSet: 'browser' | 'local'
  relevantSections: string[]
}

type ThinkDecision =
  | { type: 'SPAWN'; tasks: SpawnTask[] }
  | { type: 'COMPLETE'; result: string }
  | { type: 'APPROVE_NEEDED'; action: string; details: string }
  | { type: 'FAILED'; reason: string }

const THINK_SYSTEM = `You are a dynamic orchestrator. Each cycle you decide what to do next.

Return exactly ONE JSON decision. Valid decisions:

SPAWN — Launch agents to do work now. Each task description must be fully self-contained.
COMPLETE — The goal is fully accomplished. Include the final result string.
APPROVE_NEEDED — An irreversible action (send email, post publicly, delete data) needs user sign-off.
FAILED — The goal is impossible or unrecoverable. Explain why.

JSON schema (all fields optional except "decision"):
{
  "decision": "SPAWN" | "COMPLETE" | "APPROVE_NEEDED" | "FAILED",
  "tasks": [{ "id": "short_key", "description": "...", "toolSet": "browser"|"local", "relevantSections": ["key1"] }],
  "result": "final answer here",
  "action": "action needing approval", "details": "details",
  "reason": "why failed"
}

Rules:
- Spawn the MINIMUM agents needed RIGHT NOW. Do not plan everything upfront.
- Each task description must include all context the agent needs inline — it has no other memory.
- toolSet "browser" = web navigation (navigate, click, scrape). "local" = files, shell, code.
- relevantSections: scratchpad keys whose content should be prepended to that agent's task.
- Keep this response under 800 tokens.`

async function thinkStep(
  goal: string,
  sp: Scratchpad,
  cycle: number,
  totalTokens: number,
): Promise<{ decision: ThinkDecision; tokensUsed: number }> {
  const rt = resolveRuntime()
  const summary = scratchpadSummary(sp)

  const userPrompt = `GOAL: ${goal}

CYCLE: ${cycle}
TOKENS USED SO FAR: ${totalTokens}

SCRATCHPAD:
${summary || '(empty — this is the first cycle)'}

Decide what to do next.`

  const response = await rt.fastClient.chat.completions.create({
    model: rt.modelFor('medium'),
    max_tokens: 800,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: THINK_SYSTEM },
      { role: 'user', content: userPrompt },
    ],
  })

  const tokensUsed = (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0)

  try {
    const parsed = JSON.parse(response.choices[0].message.content || '{}')
    const dt = parsed.decision as string
    let decision: ThinkDecision

    if (dt === 'SPAWN') {
      const tasks: SpawnTask[] = (parsed.tasks ?? []).map((t: any) => ({
        id: String(t.id || `task_${Math.random().toString(36).slice(2, 8)}`),
        description: String(t.description || ''),
        toolSet: t.toolSet === 'local' ? 'local' : 'browser',
        relevantSections: Array.isArray(t.relevantSections) ? t.relevantSections.map(String) : [],
      })).filter((t: SpawnTask) => t.description)
      decision = { type: 'SPAWN', tasks }
    } else if (dt === 'COMPLETE') {
      decision = { type: 'COMPLETE', result: String(parsed.result ?? '') }
    } else if (dt === 'APPROVE_NEEDED') {
      decision = { type: 'APPROVE_NEEDED', action: String(parsed.action ?? ''), details: String(parsed.details ?? '') }
    } else {
      decision = { type: 'FAILED', reason: String(parsed.reason ?? 'Unknown') }
    }

    return { decision, tokensUsed }
  } catch {
    return { decision: { type: 'FAILED', reason: 'Think step returned invalid JSON' }, tokensUsed }
  }
}

// ─── Approval gate ─────────────────────────────────────────────────────────────
// 5-minute timeout, then auto-deny.

async function waitForApproval(
  action: string,
  details: string,
  promptFn: (q: string) => Promise<string>,
): Promise<boolean> {
  const L = '─'.repeat(55)
  console.log(`\n${L}`)
  console.log('  ⚠️  APPROVAL NEEDED')
  console.log(`  Action:  ${action}`)
  if (details) console.log(`  Details: ${details}`)
  console.log(L)

  let answer = ''
  try {
    answer = await Promise.race<string>([
      promptFn('  Type "approve" to allow, anything else to deny > '),
      new Promise<string>(resolve => setTimeout(() => resolve(''), 5 * 60 * 1_000)),
    ])
  } catch {
    answer = ''
  }

  const approved = ['approve', 'a', 'y', 'yes'].includes(answer.trim().toLowerCase())
  console.log(`  ${approved ? '✓ Approved.' : '✗ Denied.'}\n`)
  return approved
}

// ─── Token summary ─────────────────────────────────────────────────────────────

function printTokenSummary(totalTokens: number, cycles: number, thinkTokens: number): void {
  const L = '━'.repeat(55)
  const workerTokens = Math.max(0, totalTokens - thinkTokens)
  // Grok-4.5 pricing approximation: $2/$6 per MTok in/out
  const estCostUsd = (totalTokens * 4) / 1_000_000  // rough mid-point
  console.log(`\n${L}`)
  console.log(`  DYNAMIC ORCHESTRATOR — TOKEN SUMMARY`)
  console.log(`  Cycles:       ${cycles}`)
  console.log(`  Think tokens: ~${thinkTokens}`)
  console.log(`  Agent tokens: ~${workerTokens}`)
  console.log(`  Total:        ${totalTokens}`)
  console.log(`  Est cost:     ~$${estCostUsd.toFixed(3)}`)
  console.log(L)
}

// ─── Default promptFn using readline ──────────────────────────────────────────

function makeReadlinePrompt(): (q: string) => Promise<string> {
  return (q: string) => new Promise<string>(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const timer = setTimeout(() => { rl.close(); resolve('') }, 5 * 60 * 1_000)
    rl.question(q, answer => { clearTimeout(timer); rl.close(); resolve(answer) })
  })
}

// ─── Main export ───────────────────────────────────────────────────────────────

export async function runDynamicOrchestrator(
  goal: string,
  userId: string,
  onProgress: (msg: string) => void,
  promptFn?: (q: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<{ success: boolean; result: string }> {
  const sp: Scratchpad = { sections: new Map() }
  const _promptFn = promptFn ?? makeReadlinePrompt()
  let totalTokens = 0
  let thinkTokens = 0
  let cycle = 0

  while (cycle < MAX_CYCLES) {
    if (signal?.aborted) break
    if (totalTokens >= TOKEN_CEILING) break

    cycle++
    onProgress(`[Cycle ${cycle}] Thinking...`)

    let decision: ThinkDecision
    let cycleThinkTokens: number

    try {
      const think = await thinkStep(goal, sp, cycle, totalTokens)
      decision = think.decision
      cycleThinkTokens = think.tokensUsed
      totalTokens += cycleThinkTokens
      thinkTokens += cycleThinkTokens
    } catch (err: any) {
      onProgress(`[Cycle ${cycle}] Think step error: ${err?.message}`)
      break
    }

    // ── COMPLETE ──────────────────────────────────────────────────────────────
    if (decision.type === 'COMPLETE') {
      const L = '─'.repeat(55)
      console.log(`\n${L}`)
      console.log('  MISSION COMPLETE')
      console.log(L)
      decision.result.split('\n').forEach(l => console.log('  ' + l))
      console.log(L)
      printTokenSummary(totalTokens, cycle, thinkTokens)
      return { success: true, result: decision.result }
    }

    // ── FAILED ────────────────────────────────────────────────────────────────
    if (decision.type === 'FAILED') {
      onProgress(`[Cycle ${cycle}] Failed: ${decision.reason}`)
      printTokenSummary(totalTokens, cycle, thinkTokens)
      return { success: false, result: decision.reason }
    }

    // ── APPROVE_NEEDED ────────────────────────────────────────────────────────
    if (decision.type === 'APPROVE_NEEDED') {
      const approved = await waitForApproval(decision.action, decision.details, _promptFn)
      const note = approved
        ? `User approved: ${decision.action}`
        : `User denied: ${decision.action} — find an alternative approach`
      scratchpadAdd(sp, `approval_${cycle}`, note)
      onProgress(`[Cycle ${cycle}] ${approved ? 'Approved' : 'Denied'} — continuing.`)
      continue
    }

    // ── SPAWN ─────────────────────────────────────────────────────────────────
    if (decision.type === 'SPAWN') {
      if (decision.tasks.length === 0) {
        onProgress(`[Cycle ${cycle}] No tasks spawned — ending.`)
        break
      }

      const allTasks = decision.tasks
      const batchResults: Array<{ id: string; summary: string }> = []

      for (let i = 0; i < allTasks.length; i += MAX_PARALLEL_AGENTS) {
        if (signal?.aborted) break
        const batch = allTasks.slice(i, i + MAX_PARALLEL_AGENTS)

        const results = await Promise.all(batch.map(async task => {
          const ctx = getRelevantSections(sp, task.relevantSections)
          const taskWithContext = ctx
            ? `CONTEXT FROM PRIOR WORK:\n${ctx}\n\nYOUR TASK:\n${task.description}`
            : task.description

          try {
            const summary = await runAgentWithExtension(
              taskWithContext,
              userId,
              async (msg: string) => onProgress(`  [${task.id}] ${msg}`),
              undefined,   // taskId
              false,       // keepTabOpen
              undefined,   // context
              signal,
              false,       // preApproved
              false,       // skillMode
              undefined,   // resumeTabId
              undefined,   // onConfirmationRequest
              task.toolSet === 'local',
            )
            return { id: task.id, summary }
          } catch (err: any) {
            return { id: task.id, summary: `Failed: ${err?.message ?? String(err)}` }
          }
        }))

        batchResults.push(...results)
      }

      for (const r of batchResults) {
        scratchpadAdd(sp, r.id, r.summary)
      }

      onProgress(`[Cycle ${cycle}] ${batchResults.length} agent(s) completed — ${totalTokens} tokens used.`)
    }
  }

  // ── Exit conditions ────────────────────────────────────────────────────────
  if (signal?.aborted) {
    return { success: false, result: 'Aborted by user.' }
  }

  if (totalTokens >= TOKEN_CEILING) {
    const completed = [...sp.sections.keys()]
    console.log(`\n  ⚠️  Token ceiling hit (${totalTokens} / ${TOKEN_CEILING} tokens).`)
    console.log(`  Completed sections: ${completed.join(', ') || 'none'}`)
    console.log(`  Review the completed work above, then resume the mission manually.`)
    printTokenSummary(totalTokens, cycle, thinkTokens)
    return { success: false, result: `Token ceiling hit after ${cycle} cycles. Completed: ${completed.join(', ') || 'none'}` }
  }

  printTokenSummary(totalTokens, cycle, thinkTokens)
  return { success: false, result: `Mission ended after ${cycle} cycles without COMPLETE signal.` }
}
