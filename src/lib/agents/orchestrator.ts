import { scoreConfidence } from './confidence-scorer.js'
import { generateClarifyingQuestions } from './question-generator.js'
import { chatAgent } from './chat-agent.js'
import { loadUserMd, getWritingSamples } from '../user-profile.js'
import { loadLongTermMd } from '../long-term/generator.js'
import { resolveRuntime } from '../model-router.js'

// Detect if a task is a substantial writing task that benefits from voice samples.
function isSubstantialWritingTask(task: string): boolean {
  return /\b(draft|write|compose|email|post|letter|proposal|reply|message|blog|article)\b/i.test(task)
}

export type OrchestratorResult =
  | {
      type: 'clarify'
      questions: string[]
      message: string
    }
  | {
      type: 'chat'
      response: string
    }
  | {
      type: 'browser'
      task: string
      context: string
    }
  | {
      type: 'local'
      task: string
      context: string
    }
  | {
      type: 'hybrid'
      task: string
    }

async function classifyTaskType(userMessage: string): Promise<'chat' | 'browser' | 'local' | 'hybrid'> {
  const rt = resolveRuntime()
  const response = await rt.fastClient.chat.completions.create({
    model: rt.modelFor('low'),
    max_tokens: 5,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `Classify this task. Reply with ONLY the number:
1 = Browser task — requires visiting a live website, navigating, clicking, reading web pages, posting on social media, booking, searching online.
2 = Chat task — no execution needed. Pure reasoning, writing help, answering questions, brainstorming.
3 = Hybrid task — requires BOTH a substantial browser phase (getting live data from a website) AND a substantial separate local/writing phase. Use sparingly.
4 = Local task — purely local computer work: read/write/edit/delete files and folders, run shell commands, clipboard operations. No web browser needed at all.

RULES:
- Use 4 for anything that only touches the local filesystem or shell.
- Use 1 for anything that needs a live website (even if it also saves a file at the end).
- Use 3 only for tasks with a clear browser-research phase THEN a separate heavy writing/saving phase.
- Use 2 only when the user just wants an answer or help writing — no execution.
- If in doubt between 1 and 4, ask: does this need a website? Yes → 1, No → 4.

Examples:
"What's the weather in London?" → 1
"Book me a flight to Paris" → 1
"Post 'Hello world' on LinkedIn" → 1
"Look up the score of last night's game" → 1
"Search for restaurants near me" → 1
"Go to GitHub and star that repo" → 1
"Search LinkedIn for 5 posts about AI and save them to a file" → 3
"Check my calendar tomorrow and write me a daily plan around it" → 3
"Get my emails and draft replies to the urgent ones" → 3
"Create a folder on my Desktop called test" → 4
"Create a folder, write a file with these 5 lines, then delete it" → 4
"Make a directory, put 3 files in it with specific content, verify they exist" → 4
"Read my notes.txt and add a line at the bottom" → 4
"Run a shell command and save its output to a file" → 4
"Read my contacts CSV file" → 4
"Find my leads file and tell me what's in it" → 4
"List the files in my Documents folder" → 4
"What files do I have on my desktop?" → 4
"Create a todo list, write a python file, fix a bug in it, run python --version" → 4
"TodoWrite a plan, create a file, edit it, search it with regex, run a command" → 4
"Create 3 js files on my Desktop with specific content, search for a pattern, replace it" → 4
"Write a file, get its info, edit a specific line, run python to test it" → 4
"Any sequence of: write/read/edit/delete files + run commands + todo list operations" → 4
"How do I code in Python?" → 2
"Help me think through this decision" → 2
"Write me a LinkedIn post about AI" → 2
"Draft a tweet about my product launch" → 2`
      },
      {
        role: 'user',
        content: userMessage
      }
    ]
  })

  const result = response.choices[0].message.content?.trim() || '2'
  if (result === '1') return 'browser'
  if (result === '3') return 'hybrid'
  if (result === '4') return 'local'
  return 'chat'
}

export async function orchestrateTask(
  userMessage: string,
  userId: string,
  clarificationAnswers?: string[],
  opts?: {
    priorTurnCount?: number
    sessionId?: string
    rawTask?: string
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
    cachedChannelContext?: string
    onChannelContextBuilt?: (ctx: string) => void
    skipConfidenceCheck?: boolean
    signal?: AbortSignal
  }
): Promise<OrchestratorResult> {

  const hasAnswers = clarificationAnswers && clarificationAnswers.length > 0
  const userMd = loadUserMd() ?? undefined

  // rawTask is the bare user sentence without any prepended skills/context blocks.
  // Always score against it so the confidence model sees actual intent, not formatting.
  const taskForScoring = opts?.rawTask ?? userMessage

  let fullContext = userMessage
  if (hasAnswers) {
    const qaBlock = clarificationAnswers!.map((a, i) => `[${i + 1}] ${a}`).join('\n\n')
    fullContext = `${userMessage}\n\n--- User clarifications ---\n${qaBlock}\n--- End clarifications ---`
  }

  // If the user already answered clarifying questions, OR reference resolution already confirmed
  // this is a follow-up (skipConfidenceCheck), skip the confidence check and execute directly.
  if (!hasAnswers && !opts?.skipConfidenceCheck) {
    if (opts?.signal?.aborted) throw Object.assign(new Error('Task stopped by user.'), { aborted: true })
    console.log(`[orchestrator] Scoring confidence for: "${taskForScoring.slice(0, 50)}..."`)
    const confidence = await scoreConfidence(taskForScoring, userMd)
    if (opts?.signal?.aborted) throw Object.assign(new Error('Task stopped by user.'), { aborted: true })
    console.log(`[orchestrator] Confidence: ${confidence.overall}% (intent:${confidence.intent} scope:${confidence.scope} target:${confidence.target} action:${confidence.action})`)

    if (confidence.overall <= 70) {
      console.log(`[orchestrator] LOW confidence (${confidence.overall}%) → asking questions`)
      const questions = await generateClarifyingQuestions(taskForScoring, confidence, userMd)
      return {
        type: 'clarify',
        questions,
        message: `I need a bit more info to help you better:`
      }
    }

    console.log(`[orchestrator] Confidence ${confidence.overall}% → executing`)
  } else if (opts?.skipConfidenceCheck) {
    console.log(`[orchestrator] Reference resolved → skipping confidence check`)
  } else {
    console.log(`[orchestrator] Answers provided → executing directly`)
  }

  if (opts?.signal?.aborted) throw Object.assign(new Error('Task stopped by user.'), { aborted: true })
  const taskType = await classifyTaskType(fullContext)
  if (opts?.signal?.aborted) throw Object.assign(new Error('Task stopped by user.'), { aborted: true })

  if (taskType === 'chat') {
    console.log(`[orchestrator] Classified as CHAT`)
    let writingSamplesContext: string | undefined
    if (isSubstantialWritingTask(fullContext)) {
      const samples = getWritingSamples()
      if (samples.length > 0) {
        writingSamplesContext = samples
          .slice(0, 3)
          .map((s, i) => `[Sample ${i + 1}${s.source_platform ? ` — ${s.source_platform}` : ''}]\n${s.content}`)
          .join('\n\n---\n\n')
      }
    }
    // Channel D is always built fresh — it contains per-task pending questions that
    // are marked 'asked' after injection. Caching it would replay the same question
    // on every subsequent task even after the DB marks it done.
    let freshChannelDBlock: string | undefined
    try {
      const { buildChannelDContextBlock } = await import('../channel-d/context-builder.js')
      freshChannelDBlock = buildChannelDContextBlock(userId, opts?.sessionId ?? '') || undefined
    } catch { /* non-fatal */ }

    // Channel A-O context: use cached version if provided (Hermes NODE 8 — build once per session).
    // On cache miss, build fresh and hand back to cli.ts for caching via onChannelContextBuilt().
    // Channel D is excluded from this cache — it is always freshly appended above.
    let channelAContext: string | undefined = opts?.cachedChannelContext
    if (!channelAContext) {
      try {
        const { buildBehavioralContractBlock } = await import('../behavioral-contract/context-builder.js')
        const { buildLiveStateContextBlock } = await import('../live-state/context-builder.js')
        const { buildChannelAContextBlock, buildLiveFrustrationLine, recordChannelAInjection } = await import('../channel-a/context-builder.js')
        const { buildChannelBContextBlock } = await import('../channel-b/context-builder.js')
        const { buildChannelCContextBlock } = await import('../channel-c/context-builder.js')
        const { buildChannelEContextBlock } = await import('../channel-e/context-builder.js')
        const { buildChannelFContextBlock } = await import('../channel-f/context-builder.js')
        const { buildChannelGContextBlock } = await import('../channel-g/context-builder.js')
        const { buildChannelHContextBlock } = await import('../channel-h/context-builder.js')
        const { buildChannelIContextBlock } = await import('../channel-i/context-builder.js')
        const { buildChannelJContextBlock } = await import('../channel-j/context-builder.js')
        const { buildChannelKContextBlock } = await import('../channel-k/context-builder.js')
        const { buildChannelLContextBlock } = await import('../channel-l/context-builder.js')
        const { buildChannelMContextBlock } = await import('../channel-m/context-builder.js')
        const { buildChannelNContextBlock } = await import('../channel-n/context-builder.js')
        const { buildChannelOContextBlock } = await import('../channel-o/context-builder.js')
        const { buildSynthesisContextBlock } = await import('../synthesis/context-builder.js')
        const behavioralBlock = buildBehavioralContractBlock(userId)
        const liveStateBlock = buildLiveStateContextBlock(userId)
        const longTermBlock = loadLongTermMd() ? `[What's happening right now]\n${loadLongTermMd()}` : null

        let calibrationBlock: string | null = null
        try {
          const { getModelConfidence, buildConfidencePreamble } = await import('../action-engine/confidence.js')
          calibrationBlock = buildConfidencePreamble(getModelConfidence(userId))
        } catch {}
        const profileBlock = buildChannelAContextBlock(userId)
        const frustrationLine = buildLiveFrustrationLine(userId, fullContext, opts?.priorTurnCount ?? 0)
        const channelBBlock = buildChannelBContextBlock(userId, fullContext)
        const channelCBlock = buildChannelCContextBlock(userId)
        const channelEBlock = buildChannelEContextBlock(userId)
        const channelFBlock = buildChannelFContextBlock(userId)
        const channelGBlock = buildChannelGContextBlock(userId)
        const channelHBlock = buildChannelHContextBlock(userId)
        const channelIBlock = buildChannelIContextBlock(userId)
        const channelJBlock = buildChannelJContextBlock(userId)
        const channelKBlock = buildChannelKContextBlock(userId)
        const channelLBlock = buildChannelLContextBlock(userId)
        const channelMBlock = buildChannelMContextBlock(userId)
        const channelNBlock = buildChannelNContextBlock(userId)
        const channelOBlock = buildChannelOContextBlock(userId)
        const synthesisBlock = buildSynthesisContextBlock(userId)
        const combined = [calibrationBlock, behavioralBlock, longTermBlock, profileBlock, frustrationLine, channelBBlock, channelCBlock, channelEBlock, channelFBlock, channelGBlock, channelHBlock, channelIBlock, channelJBlock, channelKBlock, channelLBlock, channelMBlock, channelNBlock, channelOBlock, synthesisBlock, liveStateBlock].filter(Boolean).join('\n\n')
        if (combined) {
          channelAContext = combined
          recordChannelAInjection(userId)
          opts?.onChannelContextBuilt?.(combined)
        }
      } catch { /* non-fatal */ }
    }

    // Merge stable cached context with the always-fresh channel-D block
    const fullChannelContext = [channelAContext, freshChannelDBlock].filter(Boolean).join('\n\n') || undefined

    const chatResponse = await chatAgent(fullContext, userMd, writingSamplesContext, fullChannelContext, opts?.conversationHistory, opts?.signal)
    return { type: 'chat', response: chatResponse.response }
  }

  // For browser/local/hybrid: inject the last 2 prior exchanges as context so the agent
  // knows what was just done. Truncated to keep prompt size reasonable.
  let priorCtxBlock = ''
  if (opts?.conversationHistory?.length) {
    const recent = opts.conversationHistory.slice(-4) // last 2 user+assistant pairs
    priorCtxBlock = '[Recent session context]\n' +
      recent.map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content.slice(0, 200)}`).join('\n') +
      '\n'
  }

  if (taskType === 'hybrid') {
    console.log(`[orchestrator] Classified as HYBRID`)
    return { type: 'hybrid', task: priorCtxBlock ? `${priorCtxBlock}\n${fullContext}` : fullContext }
  }

  if (taskType === 'local') {
    console.log(`[orchestrator] Classified as LOCAL`)
    return { type: 'local', task: userMessage, context: priorCtxBlock ? `${priorCtxBlock}\n${fullContext}` : fullContext }
  }

  console.log(`[orchestrator] Classified as BROWSER`)
  return { type: 'browser', task: userMessage, context: priorCtxBlock ? `${priorCtxBlock}\n${fullContext}` : fullContext }
}
