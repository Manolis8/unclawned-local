import { getChannelBProfile } from './profile-builder.js'
import { classifyTaskType } from '../channel-a/task-classifier.js'

const COLD_START_MIN = 10   // minimum reaction events before injecting anything

// ─── Context block ────────────────────────────────────────────────────────────
//
// Returns a short, agent-readable block injected into the system prompt.
// Returns empty string until enough reaction events have been observed.
//
// currentMessage is optional: when provided, used to classify the task type
// so task-type-specific correction and latency lines can be included.
// Without it, only domain-independent lines (paste focus) are shown.

export function buildChannelBContextBlock(userId: string, currentMessage?: string): string {
  try {
    const profile = getChannelBProfile(userId)
    if (!profile || profile.total_reactions < COLD_START_MIN) return ''

    const lines: string[] = []

    // Classify task type for task-specific lines
    let taskType: string | null = null
    if (currentMessage) {
      const raw = classifyTaskType(currentMessage)
      taskType = (raw === 'unknown' || raw === 'brief') ? null : raw
    }

    if (taskType) {
      const cp = profile.correction_profile
      const lp = profile.latency_profile
      const stats = cp.by_task_type[taskType]

      // ── Correction mismatch (highest value signal) ──────────────────────────
      if (cp.high_correction_types.includes(taskType) && stats) {
        switch (stats.most_common_level) {
          case 'L1':
            lines.push(`User frequently changes word choices on ${taskType} outputs — be precise; avoid vague or generic wording`)
            break
          case 'L2':
            lines.push(`User rewrites sentences on ${taskType} outputs — they have strong tone preferences; match their voice closely`)
            break
          case 'L3':
            lines.push(`User restructures ${taskType} outputs — lead with structure before content; offer a skeleton or outline first`)
            break
          case 'L4':
            lines.push(`User fully rewrites ${taskType} outputs — the default approach doesn't fit; ask for an example or style reference first`)
            break
          case 'L5':
            lines.push(`User has discarded ${taskType} outputs before — confirm the task type is correct before executing`)
            break
        }

        // Disengagement warning (overlaps with high correction)
        if (stats.trust_class === 'RUBBER_STAMP_DISENGAGEMENT') {
          lines.push(`[CALIBRATION] User approves ${taskType} outputs quickly but still corrects frequently — may have stopped reading carefully`)
        }
      }

      // ── Trust (low correction — execute directly) ───────────────────────────
      if (cp.low_correction_types.includes(taskType)) {
        lines.push(`User consistently accepts ${taskType} outputs — just execute, no need to offer alternatives`)
      }

      // ── Latency insight ─────────────────────────────────────────────────────
      if (lp.slow_task_types.includes(taskType)) {
        lines.push(`User carefully reviews ${taskType} outputs before using them — prioritize quality over speed`)
      } else if (lp.fast_task_types.includes(taskType)) {
        lines.push(`User acts immediately on ${taskType} outputs — they use it live, prioritize speed`)
      }
    }

    // ── Paste topic focus (domain-independent, works without task type) ────────
    if (profile.paste_profile.paste_topic_focus) {
      lines.push(`User has been pasting ${profile.paste_profile.paste_topic_focus} content recently — likely working in this domain`)
    }

    if (lines.length === 0) return ''
    return `## User Reaction Intelligence\n${lines.join('\n')}`

  } catch {
    return ''
  }
}

// ─── Debug report ─────────────────────────────────────────────────────────────

export function buildDebugReport(userId: string, currentMessage?: string): string {
  const profile = getChannelBProfile(userId)

  const header = [
    '═══════════════════════════════════════════════════════',
    'CHANNEL B DEBUG REPORT',
    `User: ${userId}`,
    `Generated: ${new Date().toISOString()}`,
    '═══════════════════════════════════════════════════════',
  ]

  if (!profile) {
    return [
      ...header, '',
      'No profile found. Not enough reaction events collected yet.',
      `Need at least ${COLD_START_MIN} reactions. Send messages and receive agent responses to start.`,
      '',
    ].join('\n')
  }

  const cp = profile.correction_profile
  const pp = profile.paste_profile
  const lp = profile.latency_profile

  // ── Correction profile rows ────────────────────────────────────────────────
  const correctionRows = Object.entries(cp.by_task_type)
    .sort((a, b) => b[1].correction_rate - a[1].correction_rate)
    .map(([taskType, stats]) => {
      const pct = Math.round(stats.correction_rate * 100)
      const bar = '█'.repeat(Math.round(stats.correction_rate * 20)).padEnd(20, '░')
      const dominant = stats.most_common_level ? ` most common: ${stats.most_common_level}` : ''
      const flag = stats.trust_class !== 'NORMAL' ? ` ← ${stats.trust_class}` : ''
      return `  ${taskType.padEnd(12)} ${bar} ${pct}%  (${stats.total_reactions} reactions, ${stats.corrections} corrections${dominant})${flag}`
    })
    .join('\n')

  // ── Level distribution ────────────────────────────────────────────────────
  const allLevels = { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 }
  for (const stats of Object.values(cp.by_task_type)) {
    for (const [k, v] of Object.entries(stats.level_counts)) {
      allLevels[k as keyof typeof allLevels] += v
    }
  }
  const levelRows = Object.entries(allLevels)
    .map(([level, count]) => `  ${level}: ${count}`)
    .join('  ')

  // ── Paste profile rows ────────────────────────────────────────────────────
  const pasteRows = Object.entries(pp.by_type)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `  ${type.padEnd(20)} ${count}`)
    .join('\n')

  // ── Latency profile rows ──────────────────────────────────────────────────
  const latencyRows = Object.entries(lp.by_task_type)
    .sort((a, b) => a[1].avg_seconds - b[1].avg_seconds)
    .map(([taskType, stats]) => {
      const avg = stats.avg_seconds < 60
        ? `${stats.avg_seconds}s`
        : `${Math.round(stats.avg_seconds / 60)}m`
      const rsRate = Math.round(stats.rubber_stamp_rate * 100)
      return `  ${taskType.padEnd(12)} avg ${avg.padStart(4)}  dominant: ${(stats.dominant_bucket ?? '—').padEnd(10)}  rubber_stamp: ${rsRate}%  (n=${stats.count})`
    })
    .join('\n')

  // ── Context block preview ─────────────────────────────────────────────────
  const contextBlock = buildChannelBContextBlock(userId, currentMessage) || '  (insufficient data — cold start)'

  const lines = [
    ...header, '',
    'COLLECTION STATUS',
    '─────────────────',
    `Total reaction events: ${profile.total_reactions}`,
    `Last updated: ${profile.last_updated}`,
    `Cold-start gate: ${profile.total_reactions >= COLD_START_MIN ? 'PASSED' : `needs ${COLD_START_MIN - profile.total_reactions} more reactions`}`,
    '',
    'B.1 — CORRECTION PROFILE',
    '────────────────────────',
    `High correction types (>30%): ${cp.high_correction_types.join(', ') || 'none yet'}`,
    `Low correction types (<10%, trusted): ${cp.low_correction_types.join(', ') || 'none yet'}`,
    '',
    correctionRows || '  (no correction data yet)',
    '',
    `Level distribution: ${levelRows}`,
    '',
    'B.2 — PASTE PROFILE',
    '───────────────────',
    `Total pastes: ${pp.total_pastes}`,
    `Active topic focus (last 14 days): ${pp.paste_topic_focus ?? 'none'}`,
    '',
    pasteRows || '  (no paste events yet)',
    '',
    'B.3 — LATENCY PROFILE',
    '─────────────────────',
    `Fast task types (dominant: immediate): ${lp.fast_task_types.join(', ') || 'none yet'}`,
    `Slow task types (dominant: slow): ${lp.slow_task_types.join(', ') || 'none yet'}`,
    `Rubber stamp types (>40% rate): ${lp.rubber_stamp_types.join(', ') || 'none yet'}`,
    '',
    latencyRows || '  (no latency data yet)',
    '',
    'CONTEXT BLOCK (what agent sees)',
    '─────────────────────────────────',
    contextBlock,
    '',
    '═══════════════════════════════════════════════════════',
  ]

  return lines.join('\n')
}
