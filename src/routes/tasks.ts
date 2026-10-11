import { Router } from 'express'
import { db, uuid } from '../lib/db.js'
import { isExtensionConnected, extensionConnections } from '../lib/extension-state.js'
import { runAgentWithExtension } from '../lib/agent-extension.js'
import { orchestrateTask } from '../lib/agents/orchestrator.js'
import { executeHybridTask } from '../lib/hybrid-executor.js'
import { createMessage, parseSchedule, scheduleTask, computeNextRun } from '../lib/scheduler.js'
import { isCliLockHeldByThisProcess } from '../lib/process-lock.js'
import { extractChannelASignals } from '../lib/channel-a/extractor.js'
import { extractChannelBSignals } from '../lib/channel-b/extractor.js'
import { resolveRuntime } from '../lib/model-router.js'
import { createHash } from 'node:crypto'
import { findSkillBySlug } from '../db/queries.js'

const _rt = () => resolveRuntime()

function sanitizeString(input: unknown, maxLength = 100): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/\0/g, '')
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null
}

type ToolHistoryEntry = { toolName: string; argsHash: string; resultHash?: string; timestamp: number }

const taskToolHistory = new Map<string, ToolHistoryEntry[]>()

function hashValue(value: unknown): string {
  try {
    const str = JSON.stringify(value) || String(value)
    return createHash('sha256').update(str).digest('hex').slice(0, 16)
  } catch {
    return String(value).slice(0, 16)
  }
}

function detectLoop(taskId: string, toolName: string, args: unknown, result?: string): {
  stuck: boolean; level?: 'warning' | 'critical'; message?: string
} {
  if (!taskToolHistory.has(taskId)) taskToolHistory.set(taskId, [])
  const history = taskToolHistory.get(taskId)!
  const argsHash = `${toolName}:${hashValue(args)}`
  const resultHash = result ? hashValue(result.slice(0, 500)) : undefined

  history.push({ toolName, argsHash, resultHash, timestamp: Date.now() })
  if (history.length > 30) history.shift()

  const identicalResults = history.filter(h => h.argsHash === argsHash && h.resultHash && h.resultHash === resultHash).length

  if (identicalResults >= 5) {
    return { stuck: true, level: 'critical', message: `CRITICAL: You have called ${toolName} ${identicalResults} times and got the same result each time. Nothing is changing. You MUST now call task_failed with a clear explanation of what you tried.` }
  }
  if (identicalResults >= 3) {
    return { stuck: true, level: 'warning', message: `WARNING: ${toolName} returned the same result ${identicalResults} times in a row. The page is not changing. Try a completely different approach or call task_failed.` }
  }
  if (history.length >= 6) {
    const last6 = history.slice(-6)
    const tools = last6.map(h => h.toolName)
    const isPingPong = tools.every((t, i) => i === 0 || t === tools[i % 2])
    const allSameResults = last6.every(h => h.resultHash === last6[0]?.resultHash)
    if (isPingPong && allSameResults && new Set(tools).size === 2) {
      return { stuck: true, level: 'warning', message: `WARNING: You are alternating between ${tools[0]} and ${tools[1]} with no progress. This is a stuck loop. Stop and call task_failed.` }
    }
  }
  return { stuck: false }
}

function cleanupTaskHistory(taskId: string) {
  taskToolHistory.delete(taskId)
}

export { detectLoop, cleanupTaskHistory }

export const tasksRouter = Router()

type ChatSession = { messages: Array<{ role: string; content: string }>; userId: string; lastActive: number }
const chatSessions = new Map<string, ChatSession>()

setInterval(() => {
  const cutoff = Date.now() - 3600000
  for (const [id, session] of chatSessions) {
    if (session.lastActive < cutoff) chatSessions.delete(id)
  }
}, 3600000)

async function summarizeChunk(messages: Array<{ role: string; content: string }>, maxWords: number): Promise<string> {
  const response = await _rt().fastClient.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `Summarize in max ${maxWords} words. Only keep: names, key facts, completed tasks, user preferences. Be extremely brief.` },
      { role: 'user', content: messages.map(m => `${m.role}: ${m.content}`).join('\n') }
    ],
    max_tokens: Math.ceil(maxWords * 1.5)
  })
  return response.choices[0].message.content || ''
}

async function compactHistory(messages: Array<{ role: string; content: string }>, windowSize = 10): Promise<Array<{ role: string; content: string }>> {
  const total = messages.length
  if (total <= windowSize) return messages

  const chunks: Array<Array<{ role: string; content: string }>> = []
  for (let i = 0; i < total; i += windowSize) chunks.push(messages.slice(i, i + windowSize))

  const lastChunk = chunks[chunks.length - 1]
  const middleChunk = chunks.length >= 2 ? chunks[chunks.length - 2] : null
  const oldChunks = chunks.slice(0, chunks.length - 2)
  const result: Array<{ role: string; content: string }> = []

  if (oldChunks.length > 0) {
    try {
      const shortSummary = await summarizeChunk(oldChunks.flat(), 40)
      result.push({ role: 'system', content: `[Distant past: ${shortSummary}]` })
    } catch {}
  }
  if (middleChunk) {
    try {
      const fullSummary = await summarizeChunk(middleChunk, 80)
      result.push({ role: 'system', content: `[Earlier: ${fullSummary}]` })
    } catch {}
  }
  result.push(...lastChunk)
  return result
}

async function classifyMessage(message: string): Promise<boolean> {
  const browserKeywords = ['open', 'go to', 'navigate', 'search', 'find', 'check', 'look up', 'browse', 'visit', 'show me', 'get me', 'fetch', 'gmail', 'linkedin', 'twitter', 'youtube', 'amazon', 'instagram', 'website', 'webpage', 'url', 'link', 'browser', 'tab', 'notification', 'email', 'inbox', 'summarize my', 'check my', 'news', 'latest', 'price', 'fixtures', 'cinema', 'film', 'movie', 'plugin', 'flight', 'hotel', 'restaurant', 'weather', 'score', 'ticket', 'buy', 'book', 'schedule', 'timetable', 'results', 'premier league', 'odeon', 'showtimes', 'who is', 'what is', 'how much', 'where can', 'when does', 'is there', 'do it again', 'try again', 'do the first', 'redo', 'repeat', 'same thing', 'do that again', 'do it', 'open it', 'go back', 'previous task', 'do what i said', 'as i said', 'like before', 'told you to', 'asked you to', 'tell me more', 'more details', 'give me more', 'expand on', 'more about', 'go deeper', 'read more', 'find out more', 'more info', 'what else', 'continue', 'keep going']
  const lower = message.toLowerCase()
  if (browserKeywords.some(kw => lower.includes(kw))) return true
  const chatOnlyKeywords = ['what are you', 'who are you', 'how are you', 'what can you do', 'help me understand', 'explain', 'what is', 'what does', 'define', 'hello', 'hi ', 'hey', 'thanks', 'thank you', 'good morning', 'what time', 'how do i', 'can you help', 'tell me about yourself']
  if (chatOnlyKeywords.some(kw => lower.includes(kw)) && message.split(' ').length < 6) return false
  return true
}

async function classifyDestructive(message: string): Promise<{ isDestructive: boolean; action: string; details: string }> {
  const timeout = new Promise<{ isDestructive: boolean; action: string; details: string }>(
    resolve => setTimeout(() => resolve({ isDestructive: false, action: '', details: '' }), 3000)
  )
  const classify = (async () => {
    try {
      const response = await _rt().fastClient.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 60,
        messages: [
          { role: 'system', content: `Classify if this browser task is destructive (delete, send, post, purchase, remove). Reply with JSON only: {"isDestructive": true/false, "action": "short name", "details": "one sentence"}` },
          { role: 'user', content: message }
        ]
      })
      const text = response.choices[0].message.content?.trim() ?? '{}'
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
      return { isDestructive: Boolean(parsed.isDestructive), action: String(parsed.action || 'Perform action'), details: String(parsed.details || message) }
    } catch {
      return { isDestructive: false, action: '', details: '' }
    }
  })()
  return Promise.race([classify, timeout])
}

const runningTasksPerUser = new Map<string, boolean>()
const taskAbortControllers = new Map<string, AbortController>()

export { taskAbortControllers }

async function appendOutput(taskId: string, line: string) {
  db.prepare("UPDATE tasks SET output = COALESCE(output, '') || ?, status = 'running' WHERE id = ?").run(line + '\n', taskId)
}

export async function runTaskInBackground(taskId: string, prompt: string, userId: string, useApiMode?: boolean, keepTabOpen = false, context?: string, preApproved = false) {
  console.log(`runTaskInBackground: taskId=${taskId} userId=${userId}`)

  if (!isCliLockHeldByThisProcess()) {
    db.prepare("UPDATE tasks SET status = 'error', output = ? WHERE id = ?")
      .run('⛔ No active CLI session. Please open the Unclawned terminal first.', taskId)
    return
  }

  if (runningTasksPerUser.get(userId)) {
    db.prepare("UPDATE tasks SET status = 'error', output = ? WHERE id = ?")
      .run('⚠️ You already have a task running. Please wait for it to finish before starting a new one.', taskId)
    return
  }
  runningTasksPerUser.set(userId, true)

  const TASK_TIMEOUT_MS = 240_000
  const controller = new AbortController()
  taskAbortControllers.set(taskId, controller)

  await appendOutput(taskId, '☁️ Starting...\n')
  try {
    const onProgress = async (msg: string) => {
      if (controller.signal.aborted) return
      console.log(`[${taskId}] ${msg}`)
      await appendOutput(taskId, msg + '\n')
    }

    const decision = await orchestrateTask(prompt, userId)
    const taskPromise = decision.type === 'hybrid'
      ? executeHybridTask(decision.task, userId, onProgress)
      : runAgentWithExtension(
          prompt, userId, onProgress,
          taskId, keepTabOpen, context, controller.signal, preApproved,
          false, undefined, undefined, decision.type === 'local'
        )

    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error('Task timed out after 2 minutes')), TASK_TIMEOUT_MS)
    )

    const result = await Promise.race([taskPromise, timeoutPromise])

    db.prepare("UPDATE tasks SET status = 'done', output = COALESCE(output, '') || ? WHERE id = ?")
      .run(`✅ Done: ${result}\n`, taskId)

    await createMessage(userId, taskId, `✅ Task complete: ${result.slice(0, 300)}`)
  } catch (err: any) {
    const realErrorMessage = String(err?.message ?? err)
    const isProviderError = realErrorMessage.startsWith('No AI provider configured')
    const outputLine = isProviderError
      ? `❌ ${realErrorMessage}\n`
      : '❌ Error: Something went wrong. Our team is working on a fix.\n'
    const userMessage = isProviderError
      ? `❌ ${realErrorMessage.split('\n')[0]}`
      : '❌ Task failed. Please try again.'
    db.prepare("UPDATE tasks SET status = 'error', output = COALESCE(output, '') || ?, error_details = ? WHERE id = ?")
      .run(outputLine, realErrorMessage, taskId)
    await createMessage(userId, taskId, userMessage)
  } finally {
    taskAbortControllers.delete(taskId)
    runningTasksPerUser.delete(userId)
    cleanupTaskHistory(taskId)
  }
}

const CHAT_SYSTEM_PROMPT = `You are Unclawned, a personal AI assistant that can also control the user's Chrome browser to complete tasks on any website.

When the user asks a general question or wants to chat, answer directly.
When they ask you to do something on a website, open the browser and do it.
Remember everything said earlier in this conversation and use it naturally.
Be concise and friendly. Never write more than needed.`

tasksRouter.post('/chat', async (req, res) => {
  console.log('[chat] received request')
  const { message: rawMessage, userId: rawUserId, sessionId: rawSessionId, clarificationAnswers, keepTabOpen = false } = req.body

  const message = sanitizeString(rawMessage, 2000)
  const userId = sanitizeString(rawUserId, 100)
  const sessionId = sanitizeString(rawSessionId, 100)

  const userExists = db.prepare('SELECT user_id FROM api_keys WHERE user_id = ?').get(userId)
  if (!userExists) return res.status(401).json({ error: 'Unauthorized' })

  if (runningTasksPerUser.get(userId)) {
    return res.status(429).json({ error: 'You already have a task running. Please wait for it to finish.', taskAlreadyRunning: true })
  }

  if (!message || !userId || !sessionId) return res.status(400).json({ error: 'Missing required fields' })

  let historyRows: any[] = []
  if (sessionId) {
    try {
      historyRows = db.prepare("SELECT role, content, created_at FROM chat_messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 6").all(sessionId) as any[]
    } catch {}
  }

  let context = ''
  if (historyRows.length > 0) {
    const reversed = [...historyRows].reverse()
    const historyText = reversed
      .filter((m: any) => m.content?.trim())
      .map((m: any) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`)
      .join('\n')
    context = 'CONVERSATION HISTORY:\n' + historyText
  }

  const history = historyRows.filter((m: any) => m.content && m.content.trim()).map((m: any) => ({ role: m.role as string, content: m.content as string }))
  await compactHistory(history, 8)

  // Channel D: extract answer BEFORE the AI call (user may be answering a D question)
  try {
    const { extractChannelDAnswer } = await import('../lib/channel-d/answer-extractor.js')
    extractChannelDAnswer(userId, sessionId, message)
  } catch { /* non-fatal */ }

  // Fire-and-forget — never blocks the response path
  extractChannelASignals(userId, message, null, historyRows.length)
    .catch(err => console.error('[channel-a] chat extraction error:', err))

  // Channel B: look backwards at the prior assistant response for reaction signals
  const lastAssistant = historyRows[0]?.role === 'assistant' ? historyRows[0] : null
  if (lastAssistant) {
    const priorUserContent = historyRows[1]?.role === 'user' ? (historyRows[1]?.content ?? null) : null
    extractChannelBSignals(userId, message, lastAssistant.content, lastAssistant.created_at, priorUserContent, sessionId)
      .catch(err => console.error('[channel-b] chat extraction error:', err))
  }

  // Channel D triggers — D.1 assumption correction + D.2 pressure check
  ;(async () => {
    try {
      const { checkAssumptionCorrectionTrigger, checkPressureTrigger } = await import('../lib/channel-d/trigger-detector.js')
      checkAssumptionCorrectionTrigger(userId, sessionId, message)
      checkPressureTrigger(userId, sessionId, message)
    } catch (err) {
      console.error('[channel-d] chat trigger error:', err)
    }
  })()

  // Channel F: relationship mention extraction (fire-and-forget)
  ;(async () => {
    try {
      const { trackMessage } = await import('../lib/channel-f/relationship-tracker.js')
      trackMessage(userId, sessionId, message)
    } catch { /* non-fatal */ }
  })()

  // Channel H: detect downstream outcome signals (fire-and-forget)
  ;(async () => {
    try {
      const { detectOutcomeSignal } = await import('../lib/channel-h/outcome-detector.js')
      detectOutcomeSignal(userId, message)
    } catch { /* non-fatal */ }
  })()

  // Channel I: decision pattern signal extraction (fire-and-forget)
  ;(async () => {
    try {
      const { trackDecisionSignal } = await import('../lib/channel-i/decision-tracker.js')
      trackDecisionSignal(userId, sessionId, message)
    } catch { /* non-fatal */ }
  })()

  // Channel J: information diet signal extraction (fire-and-forget)
  ;(async () => {
    try {
      const { trackInfoDiet } = await import('../lib/channel-j/info-diet-tracker.js')
      trackInfoDiet(userId, sessionId, message)
    } catch { /* non-fatal */ }
  })()

  // Channel K: cognitive state signal extraction (fire-and-forget)
  ;(async () => {
    try {
      const { trackCognitiveSignal } = await import('../lib/channel-k/cognitive-tracker.js')
      trackCognitiveSignal(userId, sessionId, message)
    } catch { /* non-fatal */ }
  })()

  // Channel L: resistance and avoidance signal extraction (fire-and-forget)
  ;(async () => {
    try {
      const { trackResistanceSignal } = await import('../lib/channel-l/resistance-tracker.js')
      trackResistanceSignal(userId, sessionId, message)
    } catch { /* non-fatal */ }
  })()

  // Channel M: vocabulary evolution tracking (fire-and-forget)
  ;(async () => {
    try {
      const { trackVocabulary } = await import('../lib/channel-m/vocabulary-tracker.js')
      trackVocabulary(userId, message)
    } catch { /* non-fatal */ }
  })()

  // Channel N: external world monitoring (fire-and-forget)
  ;(async () => {
    try {
      const { trackWorldSignals } = await import('../lib/channel-n/event-tracker.js')
      trackWorldSignals(userId, message)
    } catch { /* non-fatal */ }
  })()

  // Channel O: goal completion and achievement tracking (fire-and-forget)
  ;(async () => {
    try {
      const { trackAchievement } = await import('../lib/channel-o/achievement-tracker.js')
      trackAchievement(userId, message)
    } catch { /* non-fatal */ }
  })()

  // Behavioral contract: detect explicit directives (fire-and-forget)
  ;(async () => {
    try {
      const { detectAndSaveDirectives } = await import('../lib/behavioral-contract/detector.js')
      detectAndSaveDirectives(userId, message)
    } catch { /* non-fatal */ }
  })()

  // Live state: update per-message (fire-and-forget)
  ;(async () => {
    try {
      const { updateLiveState } = await import('../lib/live-state/updater.js')
      updateLiveState(userId, sessionId, message)
    } catch { /* non-fatal */ }
  })()

  // Slash command: /skill-name [optional task text]
  // Resolves the skill and either shows its card (no extra text) or injects its plan into the task
  if (message.startsWith('/') && !message.startsWith('//')) {
    const slashMatch = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
    if (slashMatch) {
      const slug = slashMatch[1]
      const extraText = (slashMatch[2] ?? '').trim()
      const skill = findSkillBySlug(userId, slug)

      if (skill) {
        const variables: any[] = (skill as any).variables ?? []
        const inputHint = variables.length > 0
          ? `\n\nInputs: ${variables.map((v: any) => `${v.variable_name}${v.is_required ? ' (required)' : ''}`).join(', ')}`
          : ''

        if (!extraText) {
          // No task text — return skill card so user knows what it does and can provide inputs
          const cardMessage = `**${skill.skill_name}**\n${skill.skill_description ?? ''}${inputHint}\n\nTell me what you want to do and I'll run it, or go to the Skills tab to execute it directly.`
          try {
            db.prepare('INSERT INTO chat_messages (id, chat_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)').run(uuid(), sessionId, userId, 'user', message)
            db.prepare('INSERT INTO chat_messages (id, chat_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)').run(uuid(), sessionId, userId, 'assistant', cardMessage)
          } catch {}
          return res.json({ type: 'skill_loaded', skillId: skill.id, skillName: skill.skill_name, message: cardMessage, usesBrowser: false })
        }

        // Has extra text — enrich the prompt with the skill plan and run as a browser task
        const planSummary = skill.execution_plan
          ? `\n\nSkill execution plan (follow these steps):\n${JSON.stringify(skill.execution_plan, null, 2)}`
          : ''
        const enrichedPrompt = `[Skill: ${skill.skill_name}] ${extraText}${planSummary}`
        const taskId = uuid()
        db.prepare("INSERT INTO tasks (id, user_id, prompt, output, status) VALUES (?, ?, ?, '', 'running')").run(taskId, userId, enrichedPrompt)
        try {
          db.prepare('INSERT INTO chat_messages (id, chat_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)').run(uuid(), sessionId, userId, 'user', message)
        } catch {}
        res.json({ type: 'skill_task', taskId, skillId: skill.id, skillName: skill.skill_name, usesBrowser: true })
        runTaskInBackground(taskId, enrichedPrompt, userId, false, keepTabOpen, undefined)
        return
      }
      // Slug didn't match any skill — fall through to normal orchestration
    }
  }

  console.log('[chat] orchestrating task')
  const decision = await orchestrateTask(message, userId, clarificationAnswers, { priorTurnCount: historyRows.length, sessionId })

  if (decision.type === 'clarify') {
    console.log('[chat] Decision: CLARIFY with', decision.questions.length, 'questions')
    try {
      db.prepare('INSERT INTO chat_messages (id, chat_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)').run(uuid(), sessionId, userId, 'user', message)
      db.prepare('INSERT INTO chat_messages (id, chat_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)').run(uuid(), sessionId, userId, 'assistant', decision.message + '\n\n' + decision.questions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n'))
    } catch {}
    return res.json({ type: 'clarify', message: decision.message, questions: decision.questions, taskId: null, usesBrowser: false })
  }

  if (decision.type === 'chat') {
    console.log('[chat] Decision: CHAT')
    try {
      db.prepare('INSERT INTO chat_messages (id, chat_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)').run(uuid(), sessionId, userId, 'user', message)
      db.prepare('INSERT INTO chat_messages (id, chat_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)').run(uuid(), sessionId, userId, 'assistant', decision.response)
    } catch {}
    return res.json({ type: 'chat', message: decision.response, usesBrowser: false })
  }

  if (decision.type === 'browser' || decision.type === 'local') {
    const isLocal = decision.type === 'local'
    console.log(`[chat] Decision: ${isLocal ? 'LOCAL' : 'BROWSER'}`)
    const destructiveCheck = await classifyDestructive(message)

    if (destructiveCheck.isDestructive) {
      const taskId = uuid()
      db.prepare("INSERT INTO tasks (id, user_id, prompt, output, status) VALUES (?, ?, ?, ?, 'waiting_permission')")
        .run(taskId, userId, message, '🔐 Waiting for your confirmation...\n')
      db.prepare("INSERT INTO task_permissions (id, task_id, user_id, action, details, platform, status) VALUES (?, ?, ?, ?, ?, '', 'pending')")
        .run(uuid(), taskId, userId, destructiveCheck.action, destructiveCheck.details)

      res.json({ taskId, usesBrowser: !isLocal, waitingPermission: true, action: destructiveCheck.action, details: destructiveCheck.details })

      ;(async () => {
        for (let i = 0; i < 300; i++) {
          await new Promise(r => setTimeout(r, 800))
          const perm = db.prepare("SELECT status FROM task_permissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId) as any
          if (perm?.status === 'approved') {
            db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(taskId)
            runTaskInBackground(taskId, message, userId, false, keepTabOpen, decision.context, true)
            return
          }
          if (perm?.status === 'denied') {
            db.prepare("UPDATE tasks SET status = 'done', output = '⏹️ Action cancelled by user.' WHERE id = ?").run(taskId)
            return
          }
        }
        db.prepare("UPDATE tasks SET status = 'done', output = '⏹️ Permission request timed out.' WHERE id = ?").run(taskId)
      })()

      return
    }

    const taskId = uuid()
    db.prepare("INSERT INTO tasks (id, user_id, prompt, output, status) VALUES (?, ?, ?, '', 'running')").run(taskId, userId, message)
    res.json({ taskId, usesBrowser: !isLocal })
    runTaskInBackground(taskId, message, userId, false, keepTabOpen, decision.context)
  }
})

tasksRouter.post('/create-task', async (req, res) => {
  const { prompt: rawPrompt, userId: rawUserId, useApiMode, keepTabOpen } = req.body
  const prompt = sanitizeString(rawPrompt, 2000)
  const userId = sanitizeString(rawUserId, 100)

  const userExists = db.prepare('SELECT user_id FROM api_keys WHERE user_id = ?').get(userId)
  if (!userExists) return res.status(401).json({ error: 'Unauthorized' })

  if (runningTasksPerUser.get(userId)) {
    return res.status(429).json({ error: 'You already have a task running. Please wait for it to finish.', taskAlreadyRunning: true })
  }

  if (!prompt || !userId) return res.status(400).json({ error: 'Missing or invalid prompt or userId' })

  // Fire-and-forget — create-task is always a fresh task, priorTurnCount = 0
  extractChannelASignals(userId, prompt, null, 0)
    .catch(err => console.error('[channel-a] create-task extraction error:', err))

  console.log(`Create task: userId=${userId}, prompt="${prompt.slice(0, 50)}..."`)
  console.log('[create-task] orchestrating')
  const decision = await orchestrateTask(prompt, userId)

  if (decision.type === 'clarify') {
    console.log('[create-task] Decision: CLARIFY')
    const taskId = uuid()
    db.prepare("INSERT INTO tasks (id, user_id, prompt, output, status) VALUES (?, ?, ?, ?, 'clarification_pending')")
      .run(taskId, userId, prompt, `🤔 ${decision.message}\n\n${decision.questions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')}`)
    return res.json({ taskId, type: 'clarify', message: decision.message, questions: decision.questions, usesBrowser: false })
  }

  if (decision.type === 'chat') {
    console.log('[create-task] Decision: CHAT')
    const taskId = uuid()
    db.prepare("INSERT INTO tasks (id, user_id, prompt, output, status) VALUES (?, ?, ?, ?, 'done')").run(taskId, userId, prompt, decision.response)
    return res.json({ taskId, type: 'chat', message: decision.response, usesBrowser: false })
  }

  if (decision.type === 'browser' || decision.type === 'local') {
    const isLocal = decision.type === 'local'
    console.log(`[create-task] Decision: ${isLocal ? 'LOCAL' : 'BROWSER'}`)
    const destructiveCheck = await classifyDestructive(prompt)

    if (destructiveCheck.isDestructive) {
      const taskId = uuid()
      db.prepare("INSERT INTO tasks (id, user_id, prompt, output, status) VALUES (?, ?, ?, ?, 'waiting_permission')")
        .run(taskId, userId, prompt, '🔐 Waiting for your confirmation...\n')
      db.prepare("INSERT INTO task_permissions (id, task_id, user_id, action, details, platform, status) VALUES (?, ?, ?, ?, ?, '', 'pending')")
        .run(uuid(), taskId, userId, destructiveCheck.action, destructiveCheck.details)

      res.json({ taskId, type: isLocal ? 'local' : 'browser', waitingPermission: true, action: destructiveCheck.action, details: destructiveCheck.details, usesBrowser: !isLocal })

      ;(async () => {
        for (let i = 0; i < 300; i++) {
          await new Promise(r => setTimeout(r, 800))
          const perm = db.prepare("SELECT status FROM task_permissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId) as any
          if (perm?.status === 'approved') {
            db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(taskId)
            runTaskInBackground(taskId, prompt, userId, useApiMode, keepTabOpen, decision.context, true)
            return
          }
          if (perm?.status === 'denied') {
            db.prepare("UPDATE tasks SET status = 'done', output = '⏹️ Action cancelled by user.' WHERE id = ?").run(taskId)
            return
          }
        }
        db.prepare("UPDATE tasks SET status = 'done', output = '⏹️ Permission request timed out.' WHERE id = ?").run(taskId)
      })()

      return
    }

    const taskId = uuid()
    db.prepare("INSERT INTO tasks (id, user_id, prompt, output, status) VALUES (?, ?, ?, '', 'running')").run(taskId, userId, prompt)
    res.json({ taskId, type: isLocal ? 'local' : 'browser', usesBrowser: !isLocal })
    runTaskInBackground(taskId, prompt, userId, useApiMode, keepTabOpen, decision.context)
  }
})

tasksRouter.get('/tasks/:userId', async (req, res) => {
  const data = db.prepare("SELECT id, prompt, status, output, created_at, is_recurring, schedule_human, next_run, last_run FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.params.userId)
  res.json(data || [])
})

tasksRouter.post('/tasks/:taskId/stop', async (req, res) => {
  const { taskId } = req.params
  const { userId: rawUserId } = req.body
  const userId = sanitizeString(rawUserId, 100)
  if (!taskId || !userId) return res.status(400).json({ error: 'Missing fields' })

  const controller = taskAbortControllers.get(taskId)
  if (controller) { controller.abort(); taskAbortControllers.delete(taskId) }

  db.prepare("UPDATE tasks SET status = 'done', output = COALESCE(output, '') || ? WHERE id = ? AND user_id = ?")
    .run('\n⏹️ Task stopped by user.', taskId, userId)
  runningTasksPerUser.delete(userId)
  cleanupTaskHistory(taskId)
  res.json({ ok: true })
})

tasksRouter.post('/tasks/:taskId/confirm', async (req, res) => {
  const { taskId } = req.params
  const { confirmed, userId: rawUserId, alwaysAllow } = req.body
  const userId = sanitizeString(rawUserId, 100)
  if (!taskId || !userId) return res.status(400).json({ error: 'Missing fields' })

  db.prepare("UPDATE task_permissions SET status = ? WHERE task_id = ? AND status = 'pending'")
    .run(confirmed ? 'approved' : 'denied', taskId)

  if (confirmed && alwaysAllow) {
    const permData = db.prepare("SELECT action, platform FROM task_permissions WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId) as any
    if (permData) {
      try {
        db.prepare("INSERT INTO user_memories (id, user_id, fact, source_chat_id) VALUES (?, ?, ?, 'preferences') ON CONFLICT(user_id, fact) DO NOTHING")
          .run(uuid(), userId, `User always allows: ${permData.action} on ${permData.platform || 'any platform'}`)
      } catch {}
    }
  }

  res.json({ ok: true })
})

tasksRouter.post('/settings/auto-approve', async (req, res) => {
  const { userId: rawUserId, enabled } = req.body
  const userId = sanitizeString(rawUserId, 100)
  if (!userId) return res.status(400).json({ error: 'Missing userId' })

  if (enabled) {
    try {
      db.prepare("INSERT INTO user_memories (id, user_id, fact, source_chat_id) VALUES (?, ?, 'auto_approve_all: user has disabled permission confirmations', 'preferences') ON CONFLICT(user_id, fact) DO NOTHING")
        .run(uuid(), userId)
    } catch {}
  } else {
    db.prepare("DELETE FROM user_memories WHERE user_id = ? AND lower(fact) LIKE '%auto_approve_all%'").run(userId)
  }

  res.json({ ok: true })
})

tasksRouter.post('/settings/tavily-key', async (req, res) => {
  const { userId: rawUserId, apiKey: rawKey } = req.body
  const userId = sanitizeString(rawUserId, 100)
  if (!userId) return res.status(400).json({ error: 'Missing userId' })
  const apiKey = typeof rawKey === 'string' ? rawKey.trim() : null
  if (!apiKey) {
    // Clear the key
    db.prepare('UPDATE user_preferences SET tavily_api_key = NULL WHERE user_id = ?').run(userId)
    return res.json({ ok: true, cleared: true })
  }
  if (!apiKey.startsWith('tvly-')) return res.status(400).json({ error: 'Invalid Tavily API key format (should start with tvly-)' })
  db.prepare('INSERT INTO user_preferences (user_id, tavily_api_key) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET tavily_api_key = excluded.tavily_api_key')
    .run(userId, apiKey)
  res.json({ ok: true })
})

tasksRouter.get('/settings/tavily-key/:userId', async (req, res) => {
  const userId = sanitizeString(req.params.userId, 100)
  if (!userId) return res.status(400).json({ error: 'Missing userId' })
  try {
    const row = db.prepare('SELECT tavily_api_key FROM user_preferences WHERE user_id = ?').get(userId) as any
    const key: string | null = row?.tavily_api_key ?? null
    res.json({ configured: !!key, keyPreview: key ? `tvly-...${key.slice(-4)}` : null })
  } catch {
    res.json({ configured: false, keyPreview: null })
  }
})

tasksRouter.post('/refresh-token', async (_req, res) => {
  res.status(501).json({ error: 'Token refresh not available in local mode' })
})

tasksRouter.post('/create-scheduled-task', async (req, res) => {
  const { prompt: rawPrompt, userId: rawUserId, scheduleText: rawSchedule } = req.body
  const prompt = sanitizeString(rawPrompt, 2000)
  const userId = sanitizeString(rawUserId, 100)
  const scheduleText = sanitizeString(rawSchedule, 100)
  if (!prompt || !userId || !scheduleText) return res.status(400).json({ error: 'Missing or invalid prompt, userId, or scheduleText' })

  const parsed = await parseSchedule(scheduleText)
  if (!parsed) return res.status(400).json({ error: 'Could not understand that schedule. Try "every day at 9am" or "every monday at 8am".' })

  const taskId = uuid()
  const nextRun = computeNextRun(taskId, parsed.cron)

  db.prepare(`
    INSERT INTO tasks (id, user_id, prompt, output, status, schedule, schedule_human, is_recurring, requires_extension, next_run)
    VALUES (?, ?, ?, '', 'idle', ?, ?, 1, 1, ?)
  `).run(taskId, userId, prompt, parsed.cron, parsed.human, new Date(nextRun).toISOString())

  scheduleTask(taskId, userId, prompt, parsed.cron)
  await createMessage(userId, taskId, `📅 Scheduled: "${prompt}" — ${parsed.human}`)

  res.json({ taskId, schedule: parsed.human, nextRun: new Date(nextRun).toISOString() })
})

tasksRouter.delete('/scheduled-tasks/:userId', async (req, res) => {
  const { userId } = req.params
  const tasks = db.prepare("SELECT id FROM tasks WHERE user_id = ? AND is_recurring = 1").all(userId) as any[]

  if (!tasks.length) return res.json({ cancelled: 0 })

  const { cancelTask } = await import('../lib/scheduler.js')
  for (const task of tasks) cancelTask(task.id)

  db.prepare("UPDATE tasks SET is_recurring = 0, schedule = NULL, schedule_human = NULL, next_run = NULL, status = 'idle' WHERE user_id = ? AND is_recurring = 1")
    .run(userId)

  res.json({ cancelled: tasks.length })
})

tasksRouter.get('/executions/:userId', async (req, res) => {
  const data = db.prepare("SELECT id, task_id, task_prompt, plan, status, result_summary, steps_log, started_at, completed_at, duration_ms, created_at FROM task_executions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.params.userId)
  res.json(data || [])
})

const ADMIN_USER_ID = '177794f8-f295-4154-a5ff-1db38eed28b1'

tasksRouter.get('/admin/stats', async (req, res) => {
  const authHeader = req.headers.authorization?.replace(/^Bearer\s+/, '')
  if (authHeader !== ADMIN_USER_ID) return res.status(403).json({ error: 'Forbidden' })

  const tasks = db.prepare("SELECT COUNT(*) as count FROM tasks").get() as any
  const apiKeys = db.prepare("SELECT COUNT(*) as count FROM api_keys").get() as any

  res.json({
    totalUsers: apiKeys?.count || 0,
    totalTasks: tasks?.count || 0,
    feedback: [],
    proWaitlistCount: 0,
    proInterestCount: 0,
    referralCount: 0
  })
})

// GET /api/debug/channel-a/:userId
// Returns a plain-text debug report of the Channel A profile for the given user.
// The requesting user must own the profile (or be the admin).
tasksRouter.get('/debug/channel-a/:userId', async (req, res) => {
  const requestingUserId = req.headers.authorization?.replace(/^Bearer\s+/, '')
    ? (db.prepare('SELECT user_id FROM api_keys WHERE key = ?').get(
        req.headers.authorization!.replace(/^Bearer\s+/, '')
      ) as any)?.user_id
    : null

  const targetUserId = req.params.userId
  if (requestingUserId !== targetUserId && requestingUserId !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    const { buildDebugReport } = await import('../lib/channel-a/context-builder.js')
    const report = buildDebugReport(targetUserId)
    res.type('text/plain').send(report)
  } catch (err) {
    res.status(500).json({ error: 'Failed to build debug report', detail: String(err) })
  }
})

// GET /api/debug/channel-b/:userId
// Returns a plain-text debug report of the Channel B profile for the given user.
tasksRouter.get('/debug/channel-b/:userId', async (req, res) => {
  const requestingUserId = req.headers.authorization?.replace(/^Bearer\s+/, '')
    ? (db.prepare('SELECT user_id FROM api_keys WHERE key = ?').get(
        req.headers.authorization!.replace(/^Bearer\s+/, '')
      ) as any)?.user_id
    : null

  const targetUserId = req.params.userId
  if (requestingUserId !== targetUserId && requestingUserId !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    const { buildDebugReport } = await import('../lib/channel-b/context-builder.js')
    const report = buildDebugReport(targetUserId)
    res.type('text/plain').send(report)
  } catch (err) {
    res.status(500).json({ error: 'Failed to build debug report', detail: String(err) })
  }
})

// GET /api/debug/channel-c/:userId
// Returns a plain-text debug report of the Channel C profile for the given user.
tasksRouter.get('/debug/channel-c/:userId', async (req, res) => {
  const requestingUserId = req.headers.authorization?.replace(/^Bearer\s+/, '')
    ? (db.prepare('SELECT user_id FROM api_keys WHERE key = ?').get(
        req.headers.authorization!.replace(/^Bearer\s+/, '')
      ) as any)?.user_id
    : null

  const targetUserId = req.params.userId
  if (requestingUserId !== targetUserId && requestingUserId !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  try {
    const { buildDebugReport } = await import('../lib/channel-c/context-builder.js')
    const report = buildDebugReport(targetUserId)
    res.type('text/plain').send(report)
  } catch (err) {
    res.status(500).json({ error: 'Failed to build debug report', detail: String(err) })
  }
})

// GET /api/debug/channel-d/:userId
// Returns pending questions, stored extractions, and context block preview for Channel D.
tasksRouter.get('/debug/channel-d/:userId', async (req, res) => {
  const requestingUserId = req.headers.authorization?.replace(/^Bearer\s+/, '')
    ? (db.prepare('SELECT user_id FROM api_keys WHERE key = ?').get(
        req.headers.authorization!.replace(/^Bearer\s+/, '')
      ) as any)?.user_id
    : null

  const targetUserId = req.params.userId
  if (requestingUserId !== targetUserId && requestingUserId !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const sessionId = (req.query.sessionId as string) ?? ''

  try {
    const { buildDebugReport } = await import('../lib/channel-d/context-builder.js')
    const report = buildDebugReport(targetUserId, sessionId)
    res.type('text/plain').send(report)
  } catch (err) {
    res.status(500).json({ error: 'Failed to build channel-d debug report', detail: String(err) })
  }
})
