import { db } from './db.js'
import { createSkillSuggestion, hasPendingSuggestionForTask } from '../db/queries.js'

interface GapRow {
  stuck_type: string
  count: number
  samples: string
}

// Templates for known stuck types — avoids an LLM call since these types are an enum
const GAP_TEMPLATES: Record<string, { name: string; description: string }> = {
  friction_event: {
    name: 'dismiss-friction-gates',
    description: 'Handle cookie banners, login walls, and popups that block page interaction',
  },
  navigation_failure: {
    name: 'navigate-to-section',
    description: 'Navigate reliably to a target page or section when the URL or path keeps changing',
  },
  unknown_page: {
    name: 'handle-unexpected-page',
    description: 'Recover from unexpected page states, layouts, or error screens gracefully',
  },
  action_failure: {
    name: 'retry-failing-action',
    description: 'Retry an action that repeatedly fails due to timing or element availability',
  },
  sub_task_gap: {
    name: 'missing-sub-task-skill',
    description: 'Handle a recurring sub-task that is not covered by any existing skill',
  },
}

// source_task prefix for gap-based suggestions — lets the frontend distinguish them
function gapKey(stuckType: string): string {
  return `gap-pattern:${stuckType}`
}

// Fire-and-forget — called from runAgentWithExtension after every task (success or failure)
export async function checkAndSurfaceGapProposalsAsync(userId: string): Promise<void> {
  try {
    // Query all stuck types above threshold, not just the top one
    const rows = db.prepare(`
      SELECT stuck_type, COUNT(*) as count,
             GROUP_CONCAT(DISTINCT substr(stuck_description, 1, 80)) as samples
      FROM skill_gap_events
      WHERE user_id = ?
        AND created_at >= datetime('now', '-30 days')
      GROUP BY stuck_type
      HAVING count >= 3
      ORDER BY count DESC
      LIMIT 5
    `).all(userId) as GapRow[]

    for (const row of rows) {
      const sourceKey = gapKey(row.stuck_type)

      // Dedup: skip if there's already a pending suggestion for this gap type
      if (hasPendingSuggestionForTask(userId, sourceKey)) continue

      const template = GAP_TEMPLATES[row.stuck_type] ?? {
        name: `handle-${row.stuck_type.replace(/_/g, '-')}`,
        description: `Handle recurring situations that caused ${row.count} stuck events (${row.stuck_type})`,
      }

      createSkillSuggestion({
        user_id: userId,
        suggested_name: template.name,
        suggested_description: template.description,
        skill_type: 'browser',
        source_task: sourceKey,
        tool_call_count: row.count, // repurposed as event count so the UI can show "stuck X times"
      })

      console.log(`[skill-gap] Surfaced gap suggestion "${template.name}" (${row.stuck_type}: ${row.count}x)`)
    }
  } catch (err) {
    console.warn('[skill-gap] Gap proposal check failed (non-fatal):', (err as Error).message)
  }
}
