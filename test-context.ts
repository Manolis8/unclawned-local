// Run with: npx tsx test-context.ts
// Shows exactly what context the agent receives for user 'local'

import { db } from './src/lib/db.js'

const userId = 'local'

function section(title: string) {
  console.log('\n' + '═'.repeat(50))
  console.log(`  ${title}`)
  console.log('═'.repeat(50))
}

function show(label: string, value: string | null) {
  if (value) {
    console.log(`\n✅ ${label}:\n${value}`)
  } else {
    console.log(`\n⬜ ${label}: (cold start — not enough data yet)`)
  }
}

// ── RAW COUNTS ──────────────────────────────────────────────────────────────
section('RAW SIGNAL COUNTS')

const tables = [
  ['channel_a_raw_signals', 'A signals (language patterns)'],
  ['channel_b_raw_signals', 'B signals (corrections)'],
  ['channel_k_signals',     'K signals (cognitive load)'],
  ['channel_m_word_log',    'M word log (vocab drift)'],
  ['channel_g_task_snapshots', 'G snapshots (task patterns)'],
  ['channel_f_relationship_profiles', 'F profiles (relationships)'],
  ['channel_o_achievements', 'O achievements'],
  ['synthesis_state',       'Synthesis state (gates)'],
]

for (const [table, label] of tables) {
  try {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE user_id = ?`).get(userId) as any
    const status = row.cnt > 0 ? `✅ ${row.cnt} rows` : `⬜ 0 rows (cold)`
    console.log(`  ${status.padEnd(20)} ${label}`)
  } catch (e: any) {
    console.log(`  ❌ ERROR: ${e.message} — ${label}`)
  }
}

// ── CHANNEL A PROFILE ────────────────────────────────────────────────────────
section('CHANNEL A — Language Profile')
try {
  const p = db.prepare(`SELECT * FROM channel_a_profiles WHERE user_id = ?`).get(userId) as any
  if (p) {
    console.log(`  vocabulary_tribe:    ${p.vocabulary_tribe ?? 'null'}`)
    console.log(`  hedging_profile:     ${p.hedging_profile ?? 'null'}`)
    console.log(`  frustration_fingerprint: ${p.frustration_fingerprint ?? 'null'}`)
    console.log(`  brevity_preference:  ${p.brevity_preference ?? 'null'}`)
    console.log(`  total_samples:       ${p.total_samples ?? 0}`)
  } else {
    console.log('  (no profile yet)')
  }
} catch (e: any) { console.log(`  ERROR: ${e.message}`) }

// ── CHANNEL K PROFILE ────────────────────────────────────────────────────────
section('CHANNEL K — Cognitive State')
try {
  const p = db.prepare(`SELECT * FROM channel_k_profiles WHERE user_id = ?`).get(userId) as any
  if (p) {
    console.log(`  energy_state:        ${p.energy_state ?? 'null'}`)
    console.log(`  confidence_level:    ${p.confidence_level ?? 'null'}`)
    console.log(`  avg_message_length:  ${p.avg_message_length ?? 'null'}`)
    console.log(`  total_messages:      ${p.total_messages ?? 0}`)
  } else {
    console.log('  (no profile yet)')
  }
} catch (e: any) { console.log(`  ERROR: ${e.message}`) }

// ── CHANNEL M PROFILE ────────────────────────────────────────────────────────
section('CHANNEL M — Vocabulary Drift')
try {
  const p = db.prepare(`SELECT * FROM channel_m_profiles WHERE user_id = ?`).get(userId) as any
  if (p) {
    console.log(`  drift_direction:     ${p.drift_direction ?? 'null'}`)
    console.log(`  total_distinct_words: ${p.total_distinct_words ?? 0}`)
  } else {
    console.log('  (no profile yet)')
  }
} catch (e: any) { console.log(`  ERROR: ${e.message}`) }

// ── CONTEXT BLOCKS (what the agent actually sees) ────────────────────────────
section('CONTEXT BLOCKS (injected into every response)')

try {
  const { buildChannelAContextBlock, buildLiveFrustrationLine } = await import('./src/lib/channel-a/context-builder.js')
  show('Channel A', buildChannelAContextBlock(userId))
  show('Channel A live frustration', buildLiveFrustrationLine(userId, '', 0))
} catch (e: any) { console.log(`❌ Channel A error: ${e.message}`) }

try {
  const { buildChannelBContextBlock } = await import('./src/lib/channel-b/context-builder.js')
  show('Channel B', buildChannelBContextBlock(userId, ''))
} catch (e: any) { console.log(`❌ Channel B error: ${e.message}`) }

try {
  const { buildChannelKContextBlock } = await import('./src/lib/channel-k/context-builder.js')
  show('Channel K', buildChannelKContextBlock(userId))
} catch (e: any) { console.log(`❌ Channel K error: ${e.message}`) }

try {
  const { buildChannelMContextBlock } = await import('./src/lib/channel-m/context-builder.js')
  show('Channel M', buildChannelMContextBlock(userId))
} catch (e: any) { console.log(`❌ Channel M error: ${e.message}`) }

try {
  const { buildChannelFContextBlock } = await import('./src/lib/channel-f/context-builder.js')
  show('Channel F (relationships)', buildChannelFContextBlock(userId))
} catch (e: any) { console.log(`❌ Channel F error: ${e.message}`) }

try {
  const { buildChannelOContextBlock } = await import('./src/lib/channel-o/context-builder.js')
  show('Channel O (achievements)', buildChannelOContextBlock(userId))
} catch (e: any) { console.log(`❌ Channel O error: ${e.message}`) }

try {
  const { buildSynthesisContextBlock } = await import('./src/lib/synthesis/context-builder.js')
  show('Synthesis (cross-channel)', buildSynthesisContextBlock(userId))
} catch (e: any) { console.log(`❌ Synthesis error: ${e.message}`) }

section('DONE')
console.log('Run this again after sending 10+ messages in the app to see the difference.\n')
