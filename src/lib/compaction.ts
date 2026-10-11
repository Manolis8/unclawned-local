// compaction.ts
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function estimateMessageTokens(msg: any): number {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
  return estimateTokens(content) + (msg.tool_calls ? estimateTokens(JSON.stringify(msg.tool_calls)) : 0)
}

function estimateMessagesTokens(messages: any[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}


function stripSnapshotDetails(messages: any[]): any[] {
  return messages.map(msg => {
    // Strip legacy assistant-embedded snapshot markers (old format)
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      let s = msg.content
      s = s.replace(/\[snapshot:openclaw\].*/g, '[snapshot: taken]')
      s = s.replace(/refs=\d+.*?interactive=true/g, '[refs available]')
      return { ...msg, content: s }
    }
    // Note: tool result truncation is intentionally NOT done here — evictOldSnapshots
    // in agent-extension.ts replaces stale snapshot results in-place before compaction
    // runs. Truncating here would also hit the CURRENT (live) snapshot and break
    // the agent's ability to read element refs on the active page.
    return msg
  })
}

function summarizeOldMessages(messages: any[]): string {
  let goal = ''
  const toolsCalled: string[] = []
  const completions: string[] = []
  let lastState = ''

  for (const msg of messages) {
    if (msg.role === 'user' && !goal) {
      const content = typeof msg.content === 'string' ? msg.content : ''
      // Skip re-injected summaries and agent enforcement injections
      if (!content.startsWith('[Context from') && !content.startsWith('You MUST call')) {
        goal = content.slice(0, 400).trim()
      }
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.function?.name) toolsCalled.push(tc.function.name)
      }
    }
    if (msg.role === 'assistant' && typeof msg.content === 'string') {
      const c = msg.content
      if (c.includes('✅')) {
        const m = c.match(/✅ (.+)/)
        if (m) completions.push(m[1].slice(0, 200))
      }
      if (c.trim()) lastState = c.slice(0, 200).trim()
    }
  }

  const parts: string[] = ['[Context from earlier in this task — reference only, current page state may differ]']
  if (goal) parts.push(`Goal: ${goal}`)
  if (completions.length) parts.push(`Completed: ${completions.join(' | ')}`)

  const uniqueTools = [...new Set(toolsCalled)].slice(0, 12)
  if (uniqueTools.length) parts.push(`Steps taken: ${uniqueTools.join(' → ')}`)

  if (!completions.length && lastState) parts.push(`Last state: ${lastState}`)

  return parts.join('\n')
}

export function compactMessages(
  messages: any[],
  maxTokens: number = 8000,
  keepRecentCount: number = 10
): any[] {
  if (messages.length === 0) return messages

  const totalTokens = estimateMessagesTokens(messages)
  if (totalTokens <= maxTokens) {
    return stripSnapshotDetails(messages)
  }

  const systemMsg = messages[0]
  const rest = messages.slice(1)

  // Need at least 2 non-system messages to have anything worth compacting
  if (rest.length <= 1) return messages

  // firstUserMsg holds the task goal + plan — always protect it from summarization
  const firstUserMsg = rest[0]

  // middleEnd is where the "recent protected tail" begins.
  // We protect at least 1 message (firstUserMsg) from summarization, so
  // keepRecentCount is bounded to rest.length - 1.
  const effectiveKeep = Math.min(keepRecentCount, rest.length - 1)
  const middleEnd = rest.length - effectiveKeep
  const middleMsgs = rest.slice(1, middleEnd)
  const recentMsgs = rest.slice(middleEnd)

  // Nothing in the middle to summarize — return all messages as-is
  if (middleMsgs.length === 0) {
    return [systemMsg, firstUserMsg, ...stripSnapshotDetails(recentMsgs)]
  }

  const historySummary = summarizeOldMessages(middleMsgs)

  const compacted: any[] = [
    systemMsg,
    firstUserMsg,
    { role: 'user', content: historySummary },
    ...stripSnapshotDetails(recentMsgs),
  ]

  const compactedTokens = estimateMessagesTokens(compacted)
  if (compactedTokens > maxTokens && recentMsgs.length > 3) {
    // Emergency reduction: keep system + goal + summary + last 3 messages
    return compacted.slice(0, 3).concat(compacted.slice(-3))
  }

  return compacted
}

export function logTokenUsage(messages: any[], label: string = 'Messages', silent = false): void {
  if (silent) return
  const tokens = estimateMessagesTokens(messages)
  console.log(`[tokens] ${label}: ${messages.length} messages, ~${tokens} tokens`)
}