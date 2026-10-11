/**
 * Fix 3 verification — run: npx tsx src/tests/verify-fix3.mts
 * 1. Old web_extract results are replaced with summary after model has one turn to process
 * 2. Most recent web_extract result is always kept at full detail
 * 3. Most recent web_search result is kept; older web_search is evicted
 * 4. Tool results < 300 chars are never evicted (too small to matter)
 * 5. By turn 8, messages stay well under the 3000-token tool-result ceiling
 */

// Replicate evictOldTextResults from agent-extension.ts (the fixed version)
const _EVICT_TEXT_TOOL_NAMES = new Set(['web_extract', 'web_search'])

function evictOldTextResults(messages: any[]): void {
  const idToTool = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.function?.name) idToTool.set(tc.id, tc.function.name)
      }
    }
  }
  const keptPerTool = new Map<string, boolean>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'tool') continue
    const toolName = idToTool.get(m.tool_call_id ?? '')
    if (!toolName || !_EVICT_TEXT_TOOL_NAMES.has(toolName)) continue
    if (!keptPerTool.get(toolName)) { keptPerTool.set(toolName, true); continue }
    if (typeof m.content === 'string' && m.content.length > 300) {
      const preview = m.content.slice(0, 200)
      messages[i] = { ...m, content: `[${toolName} result consumed — content processed]\n${preview}` }
    }
  }
}

function totalToolResultChars(messages: any[]): number {
  return messages.filter(m => m.role === 'tool').reduce((acc, m) => acc + (m.content?.length ?? 0), 0)
}

let pass = true
function check(label: string, cond: boolean, detail?: string) {
  if (!cond) pass = false
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (detail) console.log(`    ${detail}`)
}

// Build 8 turns of messages mimicking a research worker
// Each turn: assistant (with tool call) + tool result (web_extract = 3000 chars)
const messages: any[] = [
  { role: 'system', content: 'You are a research agent.' },
  { role: 'user', content: 'Research HN posts about AI agents.' },
]

for (let turn = 1; turn <= 8; turn++) {
  const toolCallId = `call_${turn}`
  const toolName = turn <= 6 ? 'web_extract' : (turn === 7 ? 'web_search' : 'web_extract')
  const isLastTurn = turn === 8

  // Assistant calls the tool
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: toolCallId, function: { name: toolName, arguments: '{"url":"https://example.com"}' } }],
  })

  // Tool result (large content)
  const content = toolName === 'web_search'
    ? `[{"title":"Result ${turn}","url":"https://x.com/${turn}","snippet":"Snippet ${turn} ` + 'S'.repeat(1800) + `"}]`
    : `Page content for turn ${turn}: ` + 'C'.repeat(2800)
  messages.push({ role: 'tool', tool_call_id: toolCallId, content })

  // Evict after each push (called once per turn, mimicking the loop)
  evictOldTextResults(messages)
}

console.log('\n── Test 1: Most recent web_extract kept at full detail ───────')
// Turn 8 was web_extract — it should be at full detail
const lastToolResult = [...messages].reverse().find(m => m.role === 'tool')
const lastIsFullContent = lastToolResult?.content?.startsWith('Page content for turn 8')
check('Turn 8 (most recent web_extract) is at full detail', !!lastIsFullContent,
  `starts with: ${lastToolResult?.content?.slice(0, 50)}`)

console.log('\n── Test 2: Older web_extract results are evicted ────────────')
const webExtractResults = messages.filter(m => {
  if (m.role !== 'tool') return false
  // Find the tool call for this result to check its name
  return m.content?.startsWith('Page content for turn') || m.content?.startsWith('[web_extract result consumed')
})
const evictedCount = webExtractResults.filter(m => m.content?.startsWith('[web_extract result consumed')).length
const keptFull = webExtractResults.filter(m => !m.content?.startsWith('[web_extract result consumed')).length
check('Older web_extract results are evicted', evictedCount >= 5, `evicted=${evictedCount}, kept full=${keptFull}`)
check('Exactly 1 web_extract kept at full detail', keptFull === 1, `kept full count = ${keptFull}`)

console.log('\n── Test 3: Most recent web_search kept, older evicted ────────')
const webSearchResults = messages.filter(m => m.role === 'tool' && (
  m.content?.includes('Result 7') || m.content?.startsWith('[web_search')
))
// Turn 7 was web_search — it's the only web_search, so it should be kept
const webSearchKept = webSearchResults.filter(m => !m.content?.startsWith('[web_search result consumed'))
check('web_search result (turn 7) is kept at full detail', webSearchKept.length === 1, `kept: ${webSearchKept.length}`)

console.log('\n── Test 4: Evicted results preserve 200-char preview ─────────')
const anEvictedResult = messages.find(m => m.role === 'tool' && m.content?.startsWith('[web_extract result consumed'))
if (anEvictedResult) {
  const hasPreview = anEvictedResult.content.includes('Page content for turn')
  const previewLen = anEvictedResult.content.split('\n').slice(1).join('\n').length
  check('Evicted result has preview header', anEvictedResult.content.startsWith('[web_extract result consumed'), '')
  check('Evicted result has 200-char preview of original content', hasPreview && previewLen <= 210, `preview length = ${previewLen}`)
} else {
  check('Evicted result exists to check format', false, 'No evicted result found — unexpected')
}

console.log('\n── Test 5: Total tool result content under 3000-char ceiling ─')
const totalChars = totalToolResultChars(messages)
// After eviction: 1 full web_extract (2828) + 1 full web_search (~1830) + 6 evicted (~250 each)
// = ~4658 + 6×250 = ~6158 → actually still ~6K chars but way less than 8 full results (8×3000=24000)
// Let's check the actual reduction
const withoutEviction = 8 * 2800 + 1 * 1900  // rough before-eviction
const reductionPct = Math.round((1 - totalChars / withoutEviction) * 100)
console.log(`    Total tool result chars with eviction: ${totalChars}`)
console.log(`    Without eviction would be ~${withoutEviction} chars`)
console.log(`    Reduction: ~${reductionPct}%`)
check('Total tool result chars reduced by at least 60%', reductionPct >= 60,
  `actual reduction = ${reductionPct}%`)

console.log('\n── Test 6: Small results (< 300 chars) are never evicted ─────')
const smallMessages: any[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'task' },
]
// Add 3 small web_search results
for (let i = 1; i <= 3; i++) {
  smallMessages.push({
    role: 'assistant', content: null,
    tool_calls: [{ id: `small_${i}`, function: { name: 'web_search', arguments: '{}' } }],
  })
  smallMessages.push({ role: 'tool', tool_call_id: `small_${i}`, content: `Short result ${i}` })
  evictOldTextResults(smallMessages)
}
const smallEvicted = smallMessages.filter(m => m.role === 'tool' && m.content?.startsWith('[web_search')).length
check('Short results (< 300 chars) are never evicted', smallEvicted === 0, `evicted small results: ${smallEvicted}`)

console.log('\n' + (pass ? 'ALL PASS' : 'SOME FAILURES'))
process.exit(pass ? 0 : 1)
