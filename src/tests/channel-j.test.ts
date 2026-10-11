import assert from 'node:assert/strict'
import { db } from '../lib/db.js'
import {
  classifyUrlSource, classifyTextSource, extractUrls,
  classifyDepthPreference, classifyTaskMode, isInfoAnxiety,
} from '../lib/channel-j/source-classifier.js'
import { trackInfoDiet } from '../lib/channel-j/info-diet-tracker.js'
import { buildChannelJContextBlock } from '../lib/channel-j/context-builder.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void | Promise<void>) {
  Promise.resolve().then(fn).then(() => {
    console.log(`  ✓ ${name}`)
    passed++
  }).catch((err: Error) => {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    failed++
  })
}

const U = 'cj-test-' + Date.now()

function clean(userId: string) {
  db.prepare(`DELETE FROM channel_j_signals WHERE user_id = ?`).run(userId)
  db.prepare(`DELETE FROM channel_j_profiles WHERE user_id = ?`).run(userId)
}

// ─── J.1 URL Source Classifier ────────────────────────────────────────────────

console.log('\n── J.1 URL Source Classifier ───────────────────────────────────────')

test('us-a: arxiv.org URL → academic', () => {
  assert.equal(classifyUrlSource('https://arxiv.org/abs/2304.01234'), 'academic')
})

test('us-b: mckinsey.com URL → industry_report', () => {
  assert.equal(classifyUrlSource('https://www.mckinsey.com/capabilities/strategy/insights'), 'industry_report')
})

test('us-c: a16z.com URL → industry_report', () => {
  assert.equal(classifyUrlSource('https://a16z.com/2024/10/state-of-ai-report'), 'industry_report')
})

test('us-d: twitter.com URL → twitter', () => {
  assert.equal(classifyUrlSource('https://twitter.com/sama/status/1234567'), 'twitter')
})

test('us-e: x.com URL → twitter', () => {
  assert.equal(classifyUrlSource('https://x.com/naval/status/987654'), 'twitter')
})

test('us-f: substack.com URL → newsletter', () => {
  assert.equal(classifyUrlSource('https://stratechery.substack.com/p/ai-strategy'), 'newsletter')
})

test('us-g: nytimes.com URL → news', () => {
  assert.equal(classifyUrlSource('https://www.nytimes.com/2024/technology/ai-agents'), 'news')
})

test('us-h: medium.com URL → personal_blog', () => {
  assert.equal(classifyUrlSource('https://medium.com/@founder/lessons-learned'), 'personal_blog')
})

test('us-i: spotify.com URL → podcast', () => {
  assert.equal(classifyUrlSource('https://open.spotify.com/episode/abc123'), 'podcast')
})

test('us-j: statista.com URL → data_stats', () => {
  assert.equal(classifyUrlSource('https://www.statista.com/statistics/saas-growth'), 'data_stats')
})

test('us-k: unknown domain → null', () => {
  assert.equal(classifyUrlSource('https://some-random-site.com/article'), null)
})

// ─── J.1 Text Source Classifier ───────────────────────────────────────────────

console.log('\n── J.1 Text Source Classifier ──────────────────────────────────────')

test('ts-a: "arxiv paper" → academic', () => {
  assert.equal(classifyTextSource('I found this arxiv paper on transformer architectures'), 'academic')
})

test('ts-b: "research paper" → academic', () => {
  assert.equal(classifyTextSource('There\'s a research paper that argues against this approach'), 'academic')
})

test('ts-c: "mckinsey" reference → industry_report', () => {
  assert.equal(classifyTextSource('The McKinsey report on AI adoption is relevant here'), 'industry_report')
})

test('ts-d: "twitter thread" → twitter', () => {
  assert.equal(classifyTextSource('I saw a twitter thread by Balaji about this'), 'twitter')
})

test('ts-e: "podcast" reference → podcast', () => {
  assert.equal(classifyTextSource('I heard on the podcast that Sequoia expects a reset'), 'podcast')
})

test('ts-f: "newsletter" reference → newsletter', () => {
  assert.equal(classifyTextSource('My newsletter mentioned this trend last week'), 'newsletter')
})

test('ts-g: unrelated message → null', () => {
  assert.equal(classifyTextSource('Draft me a follow-up email to the VC'), null)
})

// ─── J.1 URL Extraction ───────────────────────────────────────────────────────

console.log('\n── J.1 URL Extraction ──────────────────────────────────────────────')

test('ue-a: extracts single URL from message', () => {
  const urls = extractUrls('Check this out: https://arxiv.org/abs/1234 — really relevant')
  assert.equal(urls.length, 1)
  assert.ok(urls[0].includes('arxiv.org'))
})

test('ue-b: extracts multiple URLs', () => {
  const urls = extractUrls('See https://mckinsey.com/report and https://a16z.com/article for reference')
  assert.equal(urls.length, 2)
})

test('ue-c: returns empty array when no URLs', () => {
  const urls = extractUrls('Let\'s think about our pricing strategy')
  assert.equal(urls.length, 0)
})

// ─── J.2 Depth Preference Classifier ─────────────────────────────────────────

console.log('\n── J.2 Depth Preference Classifier ────────────────────────────────')

test('dp-a: "briefly" → low', () => {
  assert.equal(classifyDepthPreference('Can you briefly summarize the key points?'), 'low')
})

test('dp-b: "bullet points" → low', () => {
  assert.equal(classifyDepthPreference('Give me bullet points on the main risks'), 'low')
})

test('dp-c: "tldr" → low', () => {
  assert.equal(classifyDepthPreference('TLDR version please'), 'low')
})

test('dp-d: "deep dive" → high', () => {
  assert.equal(classifyDepthPreference('Do a deep dive on their cap table structure'), 'high')
})

test('dp-e: "comprehensive" → high', () => {
  assert.equal(classifyDepthPreference('Give me a comprehensive analysis of the market'), 'high')
})

test('dp-f: "thorough" → high', () => {
  assert.equal(classifyDepthPreference('Be thorough — don\'t miss anything'), 'high')
})

test('dp-g: neutral message → null', () => {
  assert.equal(classifyDepthPreference('What\'s happening with our Series B timeline?'), null)
})

// ─── J.3 Task Mode Classifier ─────────────────────────────────────────────────

console.log('\n── J.3 Task Mode Classifier ────────────────────────────────────────')

test('tm-a: "research" prompt → consumption', () => {
  assert.equal(classifyTaskMode('Research the top 5 alternatives to Stripe for our market'), 'consumption')
})

test('tm-b: "summarize" prompt → consumption', () => {
  assert.equal(classifyTaskMode('Summarize this investor update for me'), 'consumption')
})

test('tm-c: "compare" prompt → consumption', () => {
  assert.equal(classifyTaskMode('Compare Notion and Linear for our team'), 'consumption')
})

test('tm-d: "write" prompt → production', () => {
  assert.equal(classifyTaskMode('Write a cold outreach email to the LP'), 'production')
})

test('tm-e: "draft" prompt → production', () => {
  assert.equal(classifyTaskMode('Draft a LinkedIn post about our launch'), 'production')
})

test('tm-f: "create" prompt → production', () => {
  assert.equal(classifyTaskMode('Create a one-pager for the partnership proposal'), 'production')
})

test('tm-g: ambiguous prompt → null', () => {
  assert.equal(classifyTaskMode('What do you think about this?'), null)
})

// ─── J.4 Information Anxiety ──────────────────────────────────────────────────

console.log('\n── J.4 Information Anxiety ─────────────────────────────────────────')

test('ia-a: "can you also check" → anxiety', () => {
  assert.ok(isInfoAnxiety('Can you also check if there are any other similar companies?'))
})

test('ia-b: "just to make sure" → anxiety', () => {
  assert.ok(isInfoAnxiety('Just to make sure, is that the right number?'))
})

test('ia-c: "to double check" → anxiety', () => {
  assert.ok(isInfoAnxiety('To double check — you said there are 3 major competitors?'))
})

test('ia-d: "can you verify" → anxiety', () => {
  assert.ok(isInfoAnxiety('Can you verify that this is still the current pricing?'))
})

test('ia-e: normal follow-up → NOT anxiety', () => {
  assert.ok(!isInfoAnxiety('What else should I know about their team?'))
})

// ─── Tracking + Profile ───────────────────────────────────────────────────────

console.log('\n── Tracking + Profile ──────────────────────────────────────────────')

test('tp-a: arxiv URL tracked → dominant_source_type = academic', () => {
  const u = U + '-tp-a'
  clean(u)
  for (let i = 0; i < 4; i++) {
    trackInfoDiet(u, 's1', `Check this paper https://arxiv.org/abs/123${i} — very relevant to our AI strategy`)
  }
  const profile = db.prepare(`SELECT dominant_source_type FROM channel_j_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile?.dominant_source_type, 'academic')
})

test('tp-b: multiple "briefly" messages → depth_preference = low', () => {
  const u = U + '-tp-b'
  clean(u)
  trackInfoDiet(u, 's1', 'Briefly summarize the fundraising options')
  trackInfoDiet(u, 's1', 'Keep it short — just bullet points on the risks')
  trackInfoDiet(u, 's1', 'Give me a brief overview of the competitive landscape')
  const profile = db.prepare(`SELECT depth_preference FROM channel_j_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile?.depth_preference, 'low')
})

test('tp-c: deep dive signals → depth_preference = high', () => {
  const u = U + '-tp-c'
  clean(u)
  trackInfoDiet(u, 's1', 'Do a deep dive on their pricing model')
  trackInfoDiet(u, 's1', 'Give me a comprehensive breakdown of the market')
  trackInfoDiet(u, 's1', 'Be thorough — I want the full picture')
  const profile = db.prepare(`SELECT depth_preference FROM channel_j_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile?.depth_preference, 'high')
})

test('tp-d: mostly consumption tasks → high consumption_ratio', () => {
  const u = U + '-tp-d'
  clean(u)
  for (let i = 0; i < 4; i++) {
    trackInfoDiet(u, `s${i}`, 'Research the pricing models used by SaaS competitors')
  }
  trackInfoDiet(u, 's4', 'Summarize this report for me')
  const profile = db.prepare(`SELECT consumption_ratio FROM channel_j_profiles WHERE user_id = ?`).get(u) as any
  assert.ok(profile?.consumption_ratio > 0.5, `expected consumption_ratio > 0.5, got ${profile?.consumption_ratio}`)
})

test('tp-e: anxiety signals accumulate in info_anxiety_count', () => {
  const u = U + '-tp-e'
  clean(u)
  trackInfoDiet(u, 's1', 'Can you also check if the data is accurate?')
  trackInfoDiet(u, 's1', 'Just to make sure — that was the latest report?')
  trackInfoDiet(u, 's1', 'To double check, did you look at both sources?')
  const profile = db.prepare(`SELECT info_anxiety_count FROM channel_j_profiles WHERE user_id = ?`).get(u) as any
  assert.ok(profile?.info_anxiety_count >= 3, `expected >= 3, got ${profile?.info_anxiety_count}`)
})

test('tp-f: text source (no URL) tracked correctly', () => {
  const u = U + '-tp-f'
  clean(u)
  trackInfoDiet(u, 's1', 'I saw a twitter thread by Andrew Ng on this topic')
  trackInfoDiet(u, 's1', 'There was a tweet by the founder explaining it')
  trackInfoDiet(u, 's1', 'Posted on twitter yesterday about the Series B market')
  const profile = db.prepare(`SELECT dominant_source_type FROM channel_j_profiles WHERE user_id = ?`).get(u) as any
  assert.equal(profile?.dominant_source_type, 'twitter')
})

// ─── Context Builder ──────────────────────────────────────────────────────────

console.log('\n── Context Builder ─────────────────────────────────────────────────')

test('cb-a: returns null with fewer than 5 signals', () => {
  const u = U + '-cb-a'
  clean(u)
  db.prepare(`INSERT INTO channel_j_profiles (user_id, total_signals) VALUES (?, 3)`).run(u)
  assert.equal(buildChannelJContextBlock(u), null)
})

test('cb-b: returns null for user with no profile', () => {
  const u = U + '-cb-b'
  clean(u)
  assert.equal(buildChannelJContextBlock(u), null)
})

test('cb-c: academic dominant → cite original research framing', () => {
  const u = U + '-cb-c'
  clean(u)
  db.prepare(`INSERT INTO channel_j_profiles (user_id, total_signals, dominant_source_type) VALUES (?, 8, 'academic')`).run(u)
  const block = buildChannelJContextBlock(u)
  assert.ok(block?.includes('Information Diet'), `expected header in:\n${block}`)
  assert.ok(block?.includes('research') || block?.includes('studies') || block?.includes('primary'), `expected academic framing in:\n${block}`)
})

test('cb-d: twitter dominant → recency/speed framing', () => {
  const u = U + '-cb-d'
  clean(u)
  db.prepare(`INSERT INTO channel_j_profiles (user_id, total_signals, dominant_source_type) VALUES (?, 7, 'twitter')`).run(u)
  const block = buildChannelJContextBlock(u)
  assert.ok(block?.includes('recency') || block?.includes('now') || block?.includes('current'), `expected twitter framing in:\n${block}`)
})

test('cb-e: low depth preference → "get to the point" framing', () => {
  const u = U + '-cb-e'
  clean(u)
  db.prepare(`INSERT INTO channel_j_profiles (user_id, total_signals, depth_preference) VALUES (?, 6, 'low')`).run(u)
  const block = buildChannelJContextBlock(u)
  assert.ok(block?.includes('answer') || block?.includes('brevity') || block?.includes('point'), `expected brevity framing in:\n${block}`)
})

test('cb-f: high depth preference → nuance/full reasoning framing', () => {
  const u = U + '-cb-f'
  clean(u)
  db.prepare(`INSERT INTO channel_j_profiles (user_id, total_signals, depth_preference) VALUES (?, 6, 'high')`).run(u)
  const block = buildChannelJContextBlock(u)
  assert.ok(block?.includes('nuance') || block?.includes('full') || block?.includes('reasoning'), `expected depth framing in:\n${block}`)
})

test('cb-g: high consumption ratio → curate-and-synthesize framing', () => {
  const u = U + '-cb-g'
  clean(u)
  db.prepare(`INSERT INTO channel_j_profiles (user_id, total_signals, consumption_ratio) VALUES (?, 8, 0.85)`).run(u)
  const block = buildChannelJContextBlock(u)
  assert.ok(block?.includes('curate') || block?.includes('consumer') || block?.includes('synthesize') || block?.includes('gather'), `expected consumption framing in:\n${block}`)
})

test('cb-h: high production ratio → writing assistance framing', () => {
  const u = U + '-cb-h'
  clean(u)
  db.prepare(`INSERT INTO channel_j_profiles (user_id, total_signals, consumption_ratio) VALUES (?, 8, 0.1)`).run(u)
  const block = buildChannelJContextBlock(u)
  assert.ok(block?.includes('produc') || block?.includes('writing') || block?.includes('draft') || block?.includes('creates'), `expected production framing in:\n${block}`)
})

test('cb-i: info anxiety >= 3 → confidence-giving framing', () => {
  const u = U + '-cb-i'
  clean(u)
  db.prepare(`INSERT INTO channel_j_profiles (user_id, total_signals, info_anxiety_count) VALUES (?, 8, 4)`).run(u)
  const block = buildChannelJContextBlock(u)
  assert.ok(block?.includes('anxiety') || block?.includes('confidence') || block?.includes('reassuranc') || block?.includes('consistent'), `expected anxiety framing in:\n${block}`)
})

// ─── Summary ─────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n── Results ───────────────────────────────────────────────────────`)
  console.log(`   ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}, 400)
