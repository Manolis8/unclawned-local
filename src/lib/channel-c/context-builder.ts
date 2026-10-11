import { db } from '../db.js'
import { getChannelCProfile } from './profile-builder.js'

const COLD_START_MIN = 5

// ─── buildChannelCContextBlock ────────────────────────────────────────────────
//
// Returns 2-3 lines of environment intelligence injected into agent system prompt.
// Returns '' if cold-start gate not passed.

export function buildChannelCContextBlock(userId: string): string {
  const profile = getChannelCProfile(userId)
  if (!profile || profile.total_tasks_observed < COLD_START_MIN) return ''

  const lines: string[] = []
  const ts = profile.tool_stack_profile
  const ftp = profile.file_type_profile
  const wtp = profile.work_time_profile
  const dp = profile.domain_profile

  // ── Tool stack line ──────────────────────────────────────────────────────────
  if (ts && ts.top_tools.length > 0) {
    const toolList = ts.top_tools.slice(0, 5).join(', ')
    lines.push(`User's observed tools: [${toolList}] — reference these when relevant, avoid suggesting unknown alternatives`)
  }

  // ── Work type line ───────────────────────────────────────────────────────────
  const workType = ftp?.work_type_inference
  if (workType && workType !== 'mixed') {
    const workTypeLines: Record<string, string> = {
      developer: 'User is a developer — technical output is appropriate, avoid over-explaining fundamentals',
      analyst: 'User works heavily with data — prefer structured, quantified output formats',
      designer: 'User is design-oriented — visual descriptions and layout structure matter',
      writer: 'User creates substantial written content — match professional writing register',
      operator: 'User is a builder/operator — bias toward actionable, direct output',
    }
    const line = workTypeLines[workType]
    if (line) lines.push(line)
  } else if (ts?.tool_stack_type && ts.tool_stack_type !== 'mixed') {
    const stackTypeLines: Record<string, string> = {
      dev: 'User works primarily with developer tools — technical output is appropriate',
      designer: 'User works primarily with design tools — visual descriptions and structure matter',
      analyst: 'User works primarily with data tools — structured, quantified output preferred',
      writer: 'User works primarily with content creation tools — match professional writing register',
      operator: 'User is a productivity/operations-focused operator — bias toward actionable output',
    }
    const line = stackTypeLines[ts.tool_stack_type]
    if (line) lines.push(line)
  }

  // ── Schedule line — only for non-standard patterns, 5+ tasks ────────────────
  if (wtp && wtp.peak_hour !== null && wtp.total_task_count >= 5) {
    if (wtp.schedule_type === 'early_bird') {
      lines.push('User works early mornings — be direct and ready at the start of sessions')
    } else if (wtp.schedule_type === 'night_owl') {
      lines.push('User works late — may be in focus mode; keep outputs lean and decisive')
    }
  }

  // ── Research intensity line ──────────────────────────────────────────────────
  if (dp?.research_heavy) {
    lines.push('User frequently does multi-step web research — comfortable with iterative information gathering')
  }

  if (lines.length === 0) return ''

  return `## Environment Intelligence\n${lines.join('\n')}`
}

// ─── buildDebugReport ─────────────────────────────────────────────────────────

export function buildDebugReport(userId: string): string {
  const profile = getChannelCProfile(userId)
  const lines: string[] = []

  lines.push('═══════════════════════════════════════════════════════════════')
  lines.push('CHANNEL C DEBUG REPORT')
  lines.push(`User: ${userId}`)
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('═══════════════════════════════════════════════════════════════')
  lines.push('')

  if (!profile) {
    lines.push('No profile found. No tasks observed yet.')
    return lines.join('\n')
  }

  const observed = profile.total_tasks_observed
  const gate = observed >= COLD_START_MIN
    ? `PASSED (${observed}/${COLD_START_MIN})`
    : `NOT PASSED (${observed}/${COLD_START_MIN} needed)`

  lines.push('COLLECTION STATUS')
  lines.push('─────────────────')
  lines.push(`Total tasks observed: ${observed}`)
  lines.push(`Cold-start gate: ${gate}`)

  // Snapshot type breakdown from raw DB
  try {
    const typeRows = db.prepare(`
      SELECT task_type, COUNT(*) AS cnt
      FROM channel_c_task_snapshots
      WHERE user_id = ?
      GROUP BY task_type
    `).all(userId) as Array<{ task_type: string; cnt: number }>
    const byType: Record<string, number> = {}
    for (const r of typeRows) byType[r.task_type] = r.cnt
    lines.push(`Task types: browser=${byType['browser'] ?? 0} | local=${byType['local'] ?? 0} | hybrid=${byType['hybrid'] ?? 0} | research=${byType['research'] ?? 0}`)

    const scanRow = db.prepare(
      'SELECT COUNT(*) AS cnt FROM channel_c_task_snapshots WHERE user_id = ? AND desktop_scanned = 1'
    ).get(userId) as any
    lines.push(`Desktop scans: ${scanRow?.cnt ?? 0} (last: ${profile.desktop_profile?.last_scan_at ?? 'never'})`)
  } catch { /* non-fatal */ }

  lines.push('')

  // ── C.1 Tool Stack ────────────────────────────────────────────────────────────
  const ts = profile.tool_stack_profile
  lines.push('C.1 — TOOL STACK')
  lines.push('─────────────────')

  if (ts) {
    lines.push(`Stack type: ${ts.tool_stack_type}`)
    lines.push(`Dominant categories: ${ts.dominant_categories.join(', ') || 'none yet'}`)
    if (ts.top_tools.length > 0) {
      lines.push('Top tools (3+ tasks, non-research):')
      for (const tool of ts.top_tools.slice(0, 10)) lines.push(`  ${tool}`)
    } else {
      lines.push('Top tools: none yet (need 3+ tasks per domain)')
    }
    const flagged: string[] = []
    if (ts.uses_notion) flagged.push('Notion')
    if (ts.uses_github) flagged.push('GitHub')
    if (ts.uses_figma) flagged.push('Figma')
    if (ts.uses_linear) flagged.push('Linear')
    if (ts.uses_slack) flagged.push('Slack')
    if (ts.uses_gmail) flagged.push('Gmail')
    if (flagged.length > 0) lines.push(`Known tools in use: ${flagged.join(', ')}`)
  } else {
    lines.push('(no tool stack data yet)')
  }

  lines.push('')

  // ── C.2 Work Type ─────────────────────────────────────────────────────────────
  const ftp = profile.file_type_profile
  lines.push('C.2 — WORK TYPE (from file accesses)')
  lines.push('──────────────────────────────────────')

  if (ftp && ftp.total_file_accesses > 0) {
    lines.push(`Work type inference: ${ftp.work_type_inference}`)
    lines.push(`Dominant file type: ${ftp.dominant_file_type}`)
    lines.push(`Total file accesses: ${ftp.total_file_accesses}`)
    lines.push('By category:')
    for (const [cat, count] of Object.entries(ftp.by_category).sort(([, a], [, b]) => b - a)) {
      const pct = Math.round((count / ftp.total_file_accesses) * 100)
      lines.push(`  ${cat.padEnd(14)} ${bar(pct)} ${pct}%`)
    }
  } else {
    lines.push('(no file access data yet)')
  }

  lines.push('')

  // ── C.3 Work Schedule ─────────────────────────────────────────────────────────
  const wtp = profile.work_time_profile
  lines.push('C.3 — WORK SCHEDULE')
  lines.push('────────────────────')

  if (wtp && wtp.total_task_count > 0) {
    lines.push(`Total task count: ${wtp.total_task_count}`)
    lines.push(`Schedule type: ${wtp.schedule_type}`)
    lines.push(`Peak hour: ${wtp.peak_hour !== null ? `${wtp.peak_hour}:00` : 'not determined yet (need 5+ tasks)'}`)
    lines.push(`Works weekends: ${wtp.works_weekends ? 'yes' : 'no'}`)
    const maxCount = Math.max(...wtp.hour_distribution)
    if (maxCount > 0) {
      lines.push('Hour distribution (active hours only):')
      for (let h = 0; h < 24; h++) {
        const count = wtp.hour_distribution[h] ?? 0
        if (count > 0) {
          const pct = Math.round((count / maxCount) * 100)
          lines.push(`  ${String(h).padStart(2, '0')}:00  ${bar(pct)} ${count}`)
        }
      }
    }
  } else {
    lines.push('(no task timing data yet)')
  }

  lines.push('')

  // ── C.4 Domain Profile ────────────────────────────────────────────────────────
  const dp = profile.domain_profile
  lines.push('C.4 — DOMAIN PROFILE (last 30 days)')
  lines.push('─────────────────────────────────────')

  if (dp && dp.top_domains.length > 0) {
    lines.push(`Primary category: ${dp.primary_category ?? 'none'}`)
    lines.push(`Research heavy: ${dp.research_heavy ? 'YES' : 'no'}`)
    lines.push(`AI tools heavy: ${dp.ai_tools_heavy ? 'YES' : 'no'}`)
    lines.push('Top domains:')
    for (const d of dp.top_domains) {
      lines.push(`  ${d.domain.padEnd(30)} [${d.category}]  ${d.count} tasks`)
    }
    if (Object.keys(dp.category_distribution).length > 0) {
      lines.push('Category distribution:')
      for (const [cat, frac] of Object.entries(dp.category_distribution).sort(([, a], [, b]) => b - a)) {
        const pct = Math.round(frac * 100)
        lines.push(`  ${cat.padEnd(14)} ${bar(pct)} ${pct}%`)
      }
    }
  } else {
    lines.push('(no domain data yet)')
  }

  lines.push('')

  // ── C.5 Desktop ───────────────────────────────────────────────────────────────
  const dsk = profile.desktop_profile
  lines.push('C.5 — DESKTOP (from last scan)')
  lines.push('───────────────────────────────')

  if (dsk) {
    lines.push(`Last scanned: ${dsk.last_scan_at}`)
    lines.push(`Organization: ${dsk.organization_style} (${dsk.desktop_file_count} files on desktop)`)
    lines.push(`Desktop dominant type: ${dsk.desktop_dominant_type ?? 'none'}`)
    lines.push(`Home folder count: ${dsk.home_folder_count}`)
    if (dsk.home_folder_names.length > 0) {
      lines.push(`Home folders: ${dsk.home_folder_names.slice(0, 10).join(', ')}`)
    }
    if (dsk.active_app_categories.length > 0) {
      lines.push(`Active app categories: ${dsk.active_app_categories.join(', ')}`)
    }
  } else {
    lines.push('(no desktop scan performed yet)')
  }

  lines.push('')

  // ── Context block preview ─────────────────────────────────────────────────────
  lines.push('CONTEXT BLOCK (injected into agent)')
  lines.push('──────────────────────────────────────')
  const contextBlock = buildChannelCContextBlock(userId)
  lines.push(contextBlock || '(empty — cold-start gate not passed or no signal lines to inject)')

  lines.push('')
  lines.push('═══════════════════════════════════════════════════════════════')

  return lines.join('\n')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bar(pct: number): string {
  const filled = Math.round(Math.min(pct, 100) / 5)
  return '█'.repeat(filled).padEnd(20, '░')
}
