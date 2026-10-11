import { db, uuid, j, p } from '../db.js'
import { classifyTask, hasUrgency, hasFrustration, wordCount } from './task-classifier.js'

// ─── Snapshot recording ───────────────────────────────────────────────────────

export function recordTaskCompletion(userId: string, taskId: string, taskPrompt: string): void {
  try {
    const now = new Date()
    const hour = now.getHours()
    const dayOfWeek = now.getDay()         // 0=Sun, 6=Sat
    const dayOfMonth = now.getDate()
    const month = now.getMonth() + 1       // 1-based

    const category = classifyTask(taskPrompt)
    const urgent = hasUrgency(taskPrompt)
    const frustrated = hasFrustration(taskPrompt)
    const isLateNight = hour >= 21 || hour <= 4
    const wc = wordCount(taskPrompt)

    db.prepare(`
      INSERT INTO channel_g_task_snapshots
        (id, user_id, task_id, hour_of_day, day_of_week, day_of_month, month_of_year,
         task_category, prompt_word_count, has_urgency, has_frustration, is_late_night, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(uuid(), userId, taskId, hour, dayOfWeek, dayOfMonth, month,
      category, wc, urgent ? 1 : 0, frustrated ? 1 : 0, isLateNight ? 1 : 0)

    updateProfile(userId, hour, dayOfWeek, dayOfMonth, month, category, urgent, frustrated, isLateNight, wc)
    console.log(`[channel-g] recorded ${category} task at hour ${hour} for user ${userId}`)
  } catch (err) {
    console.error('[channel-g] record error:', err)
  }
}

// ─── Profile update ───────────────────────────────────────────────────────────

function updateProfile(
  userId: string,
  hour: number,
  dayOfWeek: number,
  dayOfMonth: number,
  month: number,
  category: string,
  urgent: boolean,
  frustrated: boolean,
  isLateNight: boolean,
  wc: number
): void {
  const existing = db.prepare(`SELECT * FROM channel_g_profiles WHERE user_id = ?`).get(userId) as any

  // ── G.1 Cognitive rhythm ────────────────────────────────────────────────────
  const rhythm: Record<number, Record<string, number>> = p(existing?.cognitive_rhythm) ?? {}
  if (!rhythm[hour]) rhythm[hour] = {}
  rhythm[hour][category] = (rhythm[hour][category] ?? 0) + 1

  // ── G.2 Seasonal patterns ───────────────────────────────────────────────────
  const seasonal: Record<string, Record<string, number>> = p(existing?.seasonal_patterns) ?? {}
  const monthEndBucket = dayOfMonth >= 25 ? 'month_end' : dayOfMonth <= 5 ? 'month_start' : null
  const quarterEndMonths = new Set([3, 6, 9, 12])
  const quarterEnd = quarterEndMonths.has(month) && dayOfMonth >= 20

  if (monthEndBucket) {
    if (!seasonal[monthEndBucket]) seasonal[monthEndBucket] = {}
    seasonal[monthEndBucket][category] = (seasonal[monthEndBucket][category] ?? 0) + 1
  }
  if (quarterEnd) {
    if (!seasonal.quarter_end) seasonal.quarter_end = {}
    seasonal.quarter_end[category] = (seasonal.quarter_end[category] ?? 0) + 1
  }

  // ── G.3 Stress cycle detection ──────────────────────────────────────────────
  let stressStreak: number = existing?.current_stress_streak ?? 0
  let stressStart: string | null = existing?.current_stress_start ?? null

  const todayKey = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD

  // Count stress signals across today (urgency + late night + frustration)
  const todayStressSignals = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM channel_g_task_snapshots
    WHERE user_id = ? AND created_at >= ? AND (has_urgency = 1 OR is_late_night = 1 OR has_frustration = 1)
  `).get(userId, todayKey + ' 00:00:00') as any)?.cnt ?? 0

  const yesterdayStressSignals = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM channel_g_task_snapshots
    WHERE user_id = ? AND created_at >= datetime(?, '-1 day') AND created_at < ?
    AND (has_urgency = 1 OR is_late_night = 1 OR has_frustration = 1)
  `).get(userId, todayKey + ' 00:00:00', todayKey + ' 00:00:00') as any)?.cnt ?? 0

  // Stress day = 2+ stress signals in a single day
  const todayIsStressful = (urgent || frustrated || isLateNight) && todayStressSignals >= 1

  if (todayIsStressful) {
    if (!stressStart) {
      stressStart = todayKey
      stressStreak = 1
    } else {
      // Increment if yesterday was also a stress day (streak continuity)
      if (yesterdayStressSignals >= 1) {
        stressStreak = (stressStreak || 0) + 1
      }
    }

    // Log new active stress cycle if threshold crossed
    if (stressStreak >= 3) {
      const activeStress = db.prepare(
        `SELECT id FROM channel_g_stress_cycles WHERE user_id = ? AND status = 'active' LIMIT 1`
      ).get(userId)
      if (!activeStress) {
        db.prepare(`
          INSERT INTO channel_g_stress_cycles (id, user_id, cycle_start, peak_streak, signals, status)
          VALUES (?, ?, ?, ?, ?, 'active')
        `).run(uuid(), userId, stressStart, stressStreak, j({ urgency: urgent, late_night: isLateNight, frustration: frustrated }))
      } else {
        db.prepare(`UPDATE channel_g_stress_cycles SET peak_streak = MAX(peak_streak, ?) WHERE user_id = ? AND status = 'active'`)
          .run(stressStreak, userId)
      }
    }
  } else {
    // Non-stressful day — close any active stress cycle
    const activeStress = db.prepare(
      `SELECT id, cycle_start FROM channel_g_stress_cycles WHERE user_id = ? AND status = 'active' LIMIT 1`
    ).get(userId) as any
    if (activeStress && stressStreak >= 3) {
      db.prepare(`UPDATE channel_g_stress_cycles SET cycle_end = datetime('now'), status = 'resolved' WHERE id = ?`)
        .run(activeStress.id)
      // Record recovery pattern
      updateRecoveryPattern(userId, stressStreak, category)
    }
    stressStreak = 0
    stressStart = null
  }

  // ── G.4 Recovery pattern: track task categories in the day(s) after a stress cycle ──
  // (handled in updateRecoveryPattern when stress cycle resolves)

  const totalTasks = (db.prepare(`SELECT COUNT(*) AS cnt FROM channel_g_task_snapshots WHERE user_id = ?`).get(userId) as any)?.cnt ?? 0

  if (existing) {
    db.prepare(`
      UPDATE channel_g_profiles SET
        total_tasks_observed = ?,
        last_updated = datetime('now'),
        last_task_at = datetime('now'),
        cognitive_rhythm = ?,
        seasonal_patterns = ?,
        current_stress_streak = ?,
        current_stress_start = ?
      WHERE user_id = ?
    `).run(totalTasks, j(rhythm), j(seasonal), stressStreak, stressStart, userId)
  } else {
    db.prepare(`
      INSERT INTO channel_g_profiles
        (user_id, total_tasks_observed, last_updated, last_task_at, cognitive_rhythm, seasonal_patterns,
         current_stress_streak, current_stress_start)
      VALUES (?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?)
    `).run(userId, totalTasks, j(rhythm), j(seasonal), stressStreak, stressStart)
  }
}

function updateRecoveryPattern(userId: string, previousStreakLength: number, firstPostStressCategory: string): void {
  const existing = db.prepare(`SELECT recovery_pattern FROM channel_g_profiles WHERE user_id = ?`).get(userId) as any
  const recovery: { cycles: Array<{ streak: number; firstCategory: string; at: string }> } =
    p(existing?.recovery_pattern) ?? { cycles: [] }

  recovery.cycles.push({ streak: previousStreakLength, firstCategory: firstPostStressCategory, at: new Date().toISOString().slice(0, 10) })
  if (recovery.cycles.length > 10) recovery.cycles.shift()  // keep last 10

  db.prepare(`UPDATE channel_g_profiles SET recovery_pattern = ? WHERE user_id = ?`)
    .run(j(recovery), userId)
}

// ─── Helpers for context builder ──────────────────────────────────────────────

// Returns the dominant task category for a given hour (needs 3+ data points)
export function getDominantCategoryForHour(userId: string, hour: number): string | null {
  const profile = db.prepare(`SELECT cognitive_rhythm FROM channel_g_profiles WHERE user_id = ?`).get(userId) as any
  if (!profile) return null
  const rhythm: Record<number, Record<string, number>> = p(profile.cognitive_rhythm) ?? {}
  const hourData = rhythm[hour]
  if (!hourData) return null
  const total = Object.values(hourData).reduce((a, b) => a + b, 0)
  if (total < 3) return null  // not enough data for this hour
  const top = Object.entries(hourData).sort((a, b) => b[1] - a[1])[0]
  return top?.[0] ?? null
}

// Returns upcoming seasonal pattern based on current day/month
export function getUpcomingSeasonalPattern(userId: string): { type: string; dominantCategory: string } | null {
  const profile = db.prepare(`SELECT seasonal_patterns, total_tasks_observed FROM channel_g_profiles WHERE user_id = ?`).get(userId) as any
  if (!profile || profile.total_tasks_observed < 20) return null

  const seasonal: Record<string, Record<string, number>> = p(profile.seasonal_patterns) ?? {}
  const now = new Date()
  const dayOfMonth = now.getDate()
  const month = now.getMonth() + 1

  const quarterEndMonths = new Set([3, 6, 9, 12])

  // Approaching month-end (days 20-24 = preview window)
  if (dayOfMonth >= 20 && dayOfMonth <= 24 && seasonal.month_end) {
    const top = Object.entries(seasonal.month_end).sort((a, b) => b[1] - a[1])[0]
    if (top) return { type: 'month_end', dominantCategory: top[0] }
  }
  // Approaching quarter-end
  if (quarterEndMonths.has(month) && dayOfMonth >= 15 && seasonal.quarter_end) {
    const top = Object.entries(seasonal.quarter_end).sort((a, b) => b[1] - a[1])[0]
    if (top) return { type: 'quarter_end', dominantCategory: top[0] }
  }
  // Just past month-start (still in start window)
  if (dayOfMonth <= 5 && seasonal.month_start) {
    const top = Object.entries(seasonal.month_start).sort((a, b) => b[1] - a[1])[0]
    if (top) return { type: 'month_start', dominantCategory: top[0] }
  }

  return null
}
