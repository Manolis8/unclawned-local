const GATEWAY_URL = process.env.GATEWAY_URL
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN
const CHAR_LIMIT = 15000

async function gatewayPost(action, payload) {
  const resp = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gateway-token': GATEWAY_TOKEN },
    body: JSON.stringify({ action, ...payload }),
    signal: AbortSignal.timeout(30000),
  })
  return resp
}

function truncate(content, charLimit) {
  if (content.length <= charLimit) return content
  const headBudget = Math.floor(charLimit * 0.75)
  const tailBudget = charLimit - headBudget
  let head = content.slice(0, headBudget)
  let tail = content.slice(-tailBudget)
  const hn = head.lastIndexOf('\n'); if (hn > headBudget * 0.5) head = head.slice(0, hn)
  const tn = tail.indexOf('\n'); if (tn >= 0 && tn < tailBudget * 0.5) tail = tail.slice(tn + 1)
  return head + '\n\n[... middle omitted ...]\n\n' + tail +
    `\n\n[TRUNCATED: ${content.length.toLocaleString()} total chars, showing ${(head.length+tail.length).toLocaleString()}]`
}

async function web_search(query, limit = 5) {
  console.log(`\n🔍 web_search("${query}")`)
  const resp = await gatewayPost('tavily_search', { query, max_results: limit, include_raw_content: false, include_images: false })
  if (!resp.ok) { console.log(`   ❌ HTTP ${resp.status}: ${await resp.text()}`); return null }
  const raw = await resp.json()
  const results = (raw.results ?? []).map((r, i) => ({ title: r.title, url: r.url, description: r.content, position: i+1 }))
  console.log(`   ✅ ${results.length} results:`)
  results.forEach(r => console.log(`      ${r.position}. ${r.title}\n         ${r.url}`))
  return results
}

async function web_extract(urls) {
  console.log(`\n📄 web_extract(${urls.length} URLs)`)
  const resp = await gatewayPost('tavily_extract', { urls, include_images: false })
  if (!resp.ok) { console.log(`   ❌ HTTP ${resp.status}: ${await resp.text()}`); return null }
  const raw = await resp.json()
  const byUrl = new Map()
  for (const r of (raw.results ?? [])) byUrl.set(r.url, r)
  for (const f of (raw.failed_results ?? [])) byUrl.set(f.url, { ...f, _failed: true })
  return urls.map(url => {
    const r = byUrl.get(url)
    if (!r || r._failed) return { url, error: r?.error ?? 'failed' }
    const content = truncate(r.raw_content ?? r.content ?? '', CHAR_LIMIT)
    console.log(`   ✅ ${url.slice(0, 70)}: ${content.length.toLocaleString()} chars`)
    return { url, title: r.title, content }
  })
}

console.log('='.repeat(60))
console.log('TASK: Top 3 Hacker News stories - summarize each')
console.log('='.repeat(60))

const searchResults = await web_search('top Hacker News stories today', 5)
if (!searchResults) process.exit(1)

const topUrls = searchResults
  .filter(r => r.url && !r.url.includes('/item?'))
  .slice(0, 3).map(r => r.url)

console.log(`\nPicked ${topUrls.length} URLs to extract`)

const extractResults = await web_extract(topUrls)
if (!extractResults) process.exit(1)

console.log('\n' + '='.repeat(60))
console.log('EXTRACT RESULTS')
console.log('='.repeat(60))
extractResults.forEach((r, i) => {
  if (r.error) { console.log(`${i+1}. ❌ ${r.url}: ${r.error}`); return }
  console.log(`\n${i+1}. ✅ ${r.title}`)
  console.log(`   ${r.url}`)
  console.log(`   Preview: ${r.content.slice(0, 300).replace(/\n/g,' ')}...`)
  console.log(`   Total chars: ${r.content.length.toLocaleString()}`)
})

const totalTokens = Math.ceil(extractResults.reduce((s,r) => s + (r.content?.length ?? 0), 0) / 4) + 500
console.log(`\n${'='.repeat(60)}`)
console.log(`✅ Done in 2 tool calls (~${totalTokens.toLocaleString()} tokens est.)`)
console.log(`   vs old browser approach: ~40,000 tokens, 14+ turns`)
