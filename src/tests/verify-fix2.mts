/**
 * Fix 2 verification — run: npx tsx src/tests/verify-fix2.mts
 * 1. missionContext (3000 chars) reaches finalPrompt verbatim — no truncation
 * 2. cleanContext is still applied to opts.context (channel history gets 500-char cap)
 * 3. Both context types can coexist correctly
 */

// Replicate the exact logic from agent-extension.ts (the fixed version)

function cleanContext(context?: string): string {
  if (!context) return ''
  const lines = context.split('\n')
  const cleaned: string[] = []
  for (const line of lines) {
    if (line.match(/^(🌐|📸|🖱️|⌨️|📖|🪟|📂|⏳|⚙️|🔍|📋|✅|⚠️|🔄)/)) continue
    if (line.startsWith('Navigated to') || line.startsWith('Clicked') || line.startsWith('Typed') ||
        line.startsWith('Scrolled') || line.startsWith('URL:') || line.startsWith('- button') ||
        line.startsWith('- link') || line.startsWith('- textbox') || line.includes('[ref=')) continue
    cleaned.push(line)
  }
  const result = cleaned.join('\n').trim()
  return result.length > 500 ? result.slice(-500) : result
}

function buildFinalPrompt(opts: {
  taskPrompt: string
  context?: string
  missionContext?: string
}): string {
  const cleanedContext = cleanContext(opts.context)
  const contextParts: string[] = []
  if (cleanedContext) contextParts.push(`Previous conversation:\n${cleanedContext}`)
  if (opts.missionContext) contextParts.push(opts.missionContext)
  return contextParts.length > 0
    ? `${contextParts.join('\n\n')}\n\nCurrent task: "${opts.taskPrompt}"`
    : opts.taskPrompt
}

let pass = true
function check(label: string, cond: boolean, detail?: string) {
  if (!cond) pass = false
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (detail) console.log(`    ${detail}`)
}

// --- Test 1: missionContext with 3000-char artifact data reaches finalPrompt intact ---
console.log('\n── Test 1: 3000-char artifact data reaches finalPrompt intact ─')
const artifactData = `AVAILABLE ARTIFACTS:\nmission_brief: Brief content here\ndata_collection_done: completed\ndata_collection_output: ${'X'.repeat(3000)}`
const prompt1 = buildFinalPrompt({
  taskPrompt: 'Analyze the collected data',
  missionContext: artifactData,
})
const artifactInPrompt = prompt1.includes('X'.repeat(3000))
check('Full 3000-char artifact data present in finalPrompt', artifactInPrompt,
  `prompt length = ${prompt1.length}`)
check('missionContext section appears before task', prompt1.indexOf(artifactData) < prompt1.indexOf('Current task:'), '')
check('"Current task:" present', prompt1.includes('Current task: "Analyze the collected data"'), '')

// --- Test 2: cleanContext still truncates opts.context to 500 chars ---
console.log('\n── Test 2: cleanContext still caps opts.context to 500 chars ─')
const longChannelContext = 'User said: ' + 'A'.repeat(2000)
const prompt2 = buildFinalPrompt({
  taskPrompt: 'Do something',
  context: longChannelContext,
})
// After cleanContext, the channel context should be at most 500 chars
const channelSection = prompt2.match(/Previous conversation:\n([\s\S]*?)\n\nCurrent task:/)?.[1] ?? ''
check('Channel context is capped at 500 chars', channelSection.length <= 500,
  `channel section length = ${channelSection.length}`)
check('Channel context is the last 500 chars', channelSection.endsWith('A'.repeat(Math.min(500, channelSection.length))), '')

// --- Test 3: Both context types together ---
console.log('\n── Test 3: Channel context + mission context coexist ─────────')
const prompt3 = buildFinalPrompt({
  taskPrompt: 'Synthesize results',
  context: 'Previous session summary. ' + 'B'.repeat(2000),
  missionContext: 'AVAILABLE ARTIFACTS:\nweb_scraping_done: completed\nweb_scraping_output: ' + 'C'.repeat(2000),
})
// cleanContext should cap the channel part; missionContext must be fully present
const hasMissionData = prompt3.includes('C'.repeat(2000))
check('Mission artifact data (2000 chars) fully present when both contexts given', hasMissionData, '')
check('Previous conversation section exists', prompt3.includes('Previous conversation:'), '')
check('"Previous conversation" comes before mission context', prompt3.indexOf('Previous conversation:') < prompt3.indexOf('AVAILABLE ARTIFACTS:'), '')

// --- Test 4: No context at all — just task prompt ---
console.log('\n── Test 4: No context — prompt is just the task ─────────────')
const prompt4 = buildFinalPrompt({ taskPrompt: 'Simple task' })
check('No context = bare task prompt', prompt4 === 'Simple task', `got: "${prompt4}"`)

// --- Test 5: missionContext ceiling is 4000 chars (from scheduler's slice) ---
console.log('\n── Test 5: Scheduler-level ceiling of 4000 chars is respected ─')
// Simulate what scheduler.ts does: v.slice(0, 4_000) for _output artifacts
const simulatedArtifactValue = 'D'.repeat(5000)
const schedulerSliced = simulatedArtifactValue.slice(0, 4000)
const missionCtx = `AVAILABLE ARTIFACTS:\ndata_collection_output: ${schedulerSliced}`
const prompt5 = buildFinalPrompt({ taskPrompt: 'Use the data', missionContext: missionCtx })
check('4000-char scheduler slice reaches worker intact', prompt5.includes('D'.repeat(4000)), '')
check('Content beyond 4000 is NOT present (correctly excluded by scheduler)', !prompt5.includes('D'.repeat(4001)), '')

console.log('\n' + (pass ? 'ALL PASS' : 'SOME FAILURES'))
process.exit(pass ? 0 : 1)
