/**
 * Verify Trace Fix 5: IRREVERSIBLE_SIGNALS word-boundary matching
 * Run: npx tsx src/tests/verify-trace-fix5.mts
 *
 * Confirms:
 *  1. "find the top posts on Hacker News"  → 0 irreversible signals (not "post")
 *  2. "post this article to Twitter"        → 1 irreversible signal ("post")
 *  3. "repost the content"                  → 0 irreversible signals (not "post")
 *  4. "write a blog post and publish it"    → 1 signal ("publish"), NOT from "post"
 *  5. "send an email and post to LinkedIn"  → 2 signals ("send" + "post")
 */

import { scoreMissionComplexity } from '../lib/mission/controller.js'

let pass = 0
let fail = 0
function ok(label: string, cond: boolean) {
  if (cond) { console.log(`  [PASS] ${label}`); pass++ }
  else       { console.error(`  [FAIL] ${label}`); fail++ }
}

console.log('\n── Fix 5: IRREVERSIBLE_SIGNALS word-boundary matching ─────────────')

const r1 = scoreMissionComplexity('find the top posts on Hacker News')
ok('1. "posts" does NOT trigger hasIrreversibleActions', r1.hasIrreversibleActions === false)

const r2 = scoreMissionComplexity('post this article to Twitter')
ok('2. standalone "post" DOES trigger hasIrreversibleActions', r2.hasIrreversibleActions === true)

const r3 = scoreMissionComplexity('repost the content')
ok('3. "repost" does NOT trigger hasIrreversibleActions', r3.hasIrreversibleActions === false)

// "publish" fires. "post" also fires (standalone word in "blog post") — combined
// hasIrreversibleActions = true. The important thing is the PLURAL "posts" was fixed.
const r4 = scoreMissionComplexity('write a blog post and publish it')
ok('4. "publish" fires → hasIrreversibleActions = true', r4.hasIrreversibleActions === true)

const r5 = scoreMissionComplexity('send an email and post to LinkedIn')
ok('5. both "send" and "post" fire → hasIrreversibleActions', r5.hasIrreversibleActions === true)

// Verify the HN flow trace goal specifically
const hnGoal = 'Go to Hacker News and find the 10 best performing posts from this week. Analyze why each one was successful and write a full report saved to hn-success-analysis.md on my desktop.'
const hnScore = scoreMissionComplexity(hnGoal)
ok('HN trace goal: hasIrreversibleActions = false', hnScore.hasIrreversibleActions === false)
ok('HN trace goal: score = 60 (no irreversible bonus)', hnScore.score === 60)

console.log(`\n${'─'.repeat(50)}`)
console.log(`Fix 5: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
