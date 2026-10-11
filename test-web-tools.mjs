/**
 * test-web-tools.mjs
 * Run: TAVILY_API_KEY=your_key node test-web-tools.mjs
 *
 * Simulates exactly what the agent would do for the HN task:
 *   "What are the top 3 stories on Hacker News right now? Summarize each."
 *
 * Old approach: browser_navigate → perceive_page → navigate each story → read_page_content × 3
 *               = ~10–15 turns, ~40k tokens
 *
 * New approach: web_search → web_extract (batch 3 URLs) → task_complete
 *               = 2 turns, ~15k tokens
 */

const TAVILY_KEY = process.env.TAVILY_API_KEY
const CHAR_LIMIT = 15000

// ── same helpers as agent-extension.ts ──────────────────────────────────────

function stripBase64Images(text) {
  return text
    .replace(/!\[([^\]]*)\]\(data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+\)/g,
      (_, alt) => alt ? `[IMAGE: ${alt}]` : '[IMAGE]')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE]')
}

function truncateWithFooter(content, charLimit) {
  if (content.length <= charLimit) return { text: content, truncated: false }
  const headBudget = Math.floor(charLimit * 0.75)
  const tailBudget = charLimit - headBudget
  let head = content.slice(0, headBudget)
  let tail = content.slice(-tailBudget)
  const headNl = head.lastIndexOf('\n')
  if (headNl > headBudget * 0.5) head = head.slice(0, headNl)
  const tailNl = tail.indexOf('\n')
  if (tailNl >= 0 && tailNl < tailBudget * 0.5) tail = tail.slice(tailNl + 1)
  const footer = [
    '',
    '────────── [TRUNCATED] ──────────',
    `Showing ${head.length.toLocaleString()} chars (head) + ${tail.length.toLocaleString()} chars (tail) of ${content.length.toLocaleString()} total.`,
    'Use web_extract with a higher char_limit to see more.',
    '─────────────────────────────────',
  ].join('\n')
  return {
    text: head + '\n\n[... middle omitted ...]\n\n' + tail + '\n' + footer,
    truncated: true,
    originalLen: content.length,
    shownLen: head.length + tail.length,
  }
}

// ── tool implementations ─────────────────────────────────────────────────────

async function web_search(query, limit = 5) {
  console.log(`\n🔍 [TOOL: web_search] query="${query}" limit=${limit}`)
  if (!TAVILY_KEY) {
    const err = { success: false, error: 'TAVILY_API_KEY not set' }
    console.log('   ❌ Result:', JSON.stringify(err))
    return JSON.stringify(err)
  }
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_KEY, query,
      max_results: Math.min(limit, 20),
      include_raw_content: false,
      include_images: false,
    }),
    signal: AbortSignal.timeout(30000),
  })
  if (!resp.ok) {
    const err = { success: false, error: `HTTP ${resp.status}` }
    console.log('   ❌ Result:', JSON.stringify(err))
    return JSON.stringify(err)
  }
  const raw = await resp.json()
  const web = (raw.results ?? []).map((r, i) => ({
    title: r.title ?? '', url: r.url ?? '', description: r.content ?? '', position: i + 1,
  }))
  const result = { success: true, data: { web } }
  const resultStr = JSON.stringify(result, null, 2)
  console.log(`   ✅ Got ${web.length} results:`)
  web.forEach((r, i) => console.log(`      ${i+1}. ${r.title}\n         ${r.url}`))
  console.log(`   📏 Result size: ${resultStr.length.toLocaleString()} chars`)
  return resultStr
}

async function web_extract(urls, charLimit = CHAR_LIMIT) {
  console.log(`\n📄 [TOOL: web_extract] urls=${JSON.stringify(urls)} char_limit=${charLimit}`)
  if (!TAVILY_KEY) {
    const err = { results: urls.map(url => ({ url, title: '', content: '', error: 'TAVILY_API_KEY not set' })) }
    console.log('   ❌ Result:', JSON.stringify(err))
    return JSON.stringify(err)
  }
  const resp = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: TAVILY_KEY, urls, include_images: false }),
    signal: AbortSignal.timeout(60000),
  })
  if (!resp.ok) {
    const err = { results: urls.map(url => ({ url, title: '', content: '', error: `HTTP ${resp.status}` })) }
    console.log('   ❌ Result:', JSON.stringify(err))
    return JSON.stringify(err)
  }
  const raw = await resp.json()
  const byUrl = new Map()
  for (const r of (raw.results ?? [])) byUrl.set(r.url ?? '', r)
  for (const f of (raw.failed_results ?? [])) byUrl.set(f.url ?? '', { ...f, _failed: true })

  const results = urls.map(url => {
    const r = byUrl.get(url)
    if (!r || r._failed) return { url, title: r?.title ?? '', content: '', error: r?.error ?? 'extraction failed' }
    const rawContent = r.raw_content ?? r.content ?? ''
    const clean = stripBase64Images(rawContent)
    const { text, truncated, originalLen, shownLen } = truncateWithFooter(clean, charLimit)
    if (truncated) {
      console.log(`   ✂️  ${url}: truncated ${originalLen.toLocaleString()} → ${shownLen.toLocaleString()} chars shown`)
    } else {
      console.log(`   ✅ ${url}: ${clean.length.toLocaleString()} chars (whole)`)
    }
    return { url, title: r.title ?? '', content: text, error: null }
  })

  const resultStr = JSON.stringify({ results }, null, 2)
  console.log(`   📏 Total result size: ${resultStr.length.toLocaleString()} chars`)
  return resultStr
}

// ── simulate the agent loop ──────────────────────────────────────────────────

async function runHNTask() {
  const task = 'What are the top 3 stories on Hacker News right now? Give me the title, URL, and a brief summary of each.'

  console.log('═'.repeat(65))
  console.log('TASK:', task)
  console.log('═'.repeat(65))
  console.log('\n📌 AGENT REASONING (Turn 1):')
  console.log('   "This is info retrieval — use web_search, not browser_navigate."')
  console.log('   "Search for HN top stories, get URLs, then web_extract them."')

  let turn = 0
  const tokenEstimate = (s) => Math.ceil(s.length / 4)

  // ── Turn 1: web_search ───────────────────────────────────────────────────
  turn++
  console.log(`\n${'─'.repeat(65)}`)
  console.log(`TURN ${turn}: web_search`)
  console.log('─'.repeat(65))
  const searchResult = await web_search('Hacker News top stories today', 5)
  const searchData = JSON.parse(searchResult)
  const searchTokens = tokenEstimate(searchResult)
  console.log(`   🪙  ~${searchTokens} tokens`)

  if (!searchData.success) {
    console.log('\n❌ Search failed. Agent would fall back to browser_navigate.')
    return
  }

  // Agent picks top 3 HN story URLs
  const topUrls = searchData.data.web
    .filter(r => r.url && !r.url.includes('news.ycombinator.com/item'))
    .slice(0, 3)
    .map(r => r.url)

  // Also grab the HN thread URLs for context (optional)
  const hnUrls = searchData.data.web
    .filter(r => r.url && r.url.includes('news.ycombinator.com'))
    .slice(0, 3)
    .map(r => r.url)

  console.log(`\n📌 AGENT REASONING (Turn 2):`)
  console.log(`   "Got ${searchData.data.web.length} results. Picking top story URLs to extract."`)
  console.log(`   "Will batch all in one web_extract call — don't need separate turns."`)
  console.log(`   "URLs: ${topUrls.join(', ')}"`)

  // ── Turn 2: web_extract (batch all 3 at once) ────────────────────────────
  turn++
  console.log(`\n${'─'.repeat(65)}`)
  console.log(`TURN ${turn}: web_extract (${topUrls.length} URLs batched)`)
  console.log('─'.repeat(65))

  const urlsToExtract = topUrls.length > 0 ? topUrls : hnUrls.slice(0, 3)
  if (urlsToExtract.length === 0) {
    console.log('   ⚠️  No URLs to extract from search results.')
    return
  }

  const extractResult = await web_extract(urlsToExtract)
  const extractData = JSON.parse(extractResult)
  const extractTokens = tokenEstimate(extractResult)
  console.log(`   🪙  ~${extractTokens} tokens`)

  // ── Turn 3: task_complete ────────────────────────────────────────────────
  turn++
  console.log(`\n${'─'.repeat(65)}`)
  console.log(`TURN ${turn}: task_complete`)
  console.log('─'.repeat(65))
  console.log('   Agent writes summary from the extracted content and calls task_complete.')

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(65)}`)
  console.log('RESULTS SUMMARY')
  console.log('═'.repeat(65))

  extractData.results?.forEach((r, i) => {
    const status = r.error ? `❌ ERROR: ${r.error}` : `✅ OK (${r.content?.length?.toLocaleString()} chars)`
    console.log(`\n${i+1}. ${r.title || '(no title)'}`)
    console.log(`   URL: ${r.url}`)
    console.log(`   Status: ${status}`)
    if (r.content && !r.error) {
      console.log(`   Preview: ${r.content.slice(0, 200).replace(/\n/g, ' ')}...`)
    }
  })

  const totalTokens = searchTokens + extractTokens + 500  // ~500 for task_complete
  console.log(`\n${'═'.repeat(65)}`)
  console.log('TOKEN COMPARISON')
  console.log('═'.repeat(65))
  console.log(`New approach (web_search + web_extract):`)
  console.log(`  Turns: ${turn}`)
  console.log(`  Tool result tokens: ~${totalTokens.toLocaleString()}`)
  console.log(`  Estimated total (incl. system prompt + model reasoning): ~${(totalTokens + 3000).toLocaleString()}`)
  console.log(``)
  console.log(`Old approach (browser_navigate × 4 + perceive_page × 4 + read_page_content × 6):`)
  console.log(`  Turns: ~14`)
  console.log(`  Estimated total: ~40,000–50,000`)
  console.log(``)
  console.log(`Savings: ~${Math.round((1 - (totalTokens + 3000) / 40000) * 100)}% fewer tokens, ${Math.round(14/turn)}x fewer turns`)
}

runHNTask().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
