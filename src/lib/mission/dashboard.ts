/**
 * Live terminal dashboard for mission execution.
 * MultiMissionDashboard renders all active missions in a single frame so
 * concurrent missions don't corrupt each other's cursor positioning.
 * Usage: multiDash.addMission(id); multiDash.addMessage(id, msg); multiDash.removeMission(id)
 */
import { getMission, getDivisionsForMission, getJobsForDivision } from './state-store.js'
import { config } from '../../config.js'

function colWidth(): number {
  return Math.min(process.stdout.columns ?? 80, 120)
}

function pad(s: string, len: number): string {
  const str = String(s).slice(0, len)
  return str + ' '.repeat(Math.max(0, len - str.length))
}

function bar(n: number, max: number, width = 18): string {
  const filled = max > 0 ? Math.round((n / max) * width) : 0
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']'
}

function statusEmoji(status: string): string {
  return (
    { pending: '⏳', executing: '⚙️ ', planning: '🧠', synthesizing: '🔬',
      completed: '✅', failed: '❌', paused: '⏸️ ', running: '🚀', aborted: '🛑' }[status] ?? '?'
  )
}

export class MultiMissionDashboard {
  private timer: ReturnType<typeof setInterval> | null = null
  private lines = 0
  private missionIds: string[] = []
  private messages = new Map<string, string[]>()  // missionId → recent messages

  addMission(missionId: string): void {
    if (!this.missionIds.includes(missionId)) {
      this.missionIds.push(missionId)
      this.messages.set(missionId, [])
    }
  }

  removeMission(missionId: string): void {
    this.missionIds = this.missionIds.filter(id => id !== missionId)
    this.messages.delete(missionId)
  }

  addMessage(missionId: string, msg: string): void {
    const msgs = this.messages.get(missionId)
    if (!msgs) return
    msgs.push(msg)
    if (msgs.length > 10) msgs.shift()
  }

  start(): void {
    process.on('SIGWINCH', () => { this.lines = 0 })
    this.render()
    this.timer = setInterval(() => this.render(), config.DASHBOARD_REFRESH_MS)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    process.stdout.write('\n')
  }

  private render(): void {
    if (this.missionIds.length === 0) return
    // When stdout is not a TTY (piped/logged), skip all output to avoid
    // ANSI garbage in log files. State is still updated via addMessage/addMission.
    if (!process.stdout.isTTY) { this.lines = 0; return }
    const col = colWidth()
    const sep = '─'.repeat(col)
    const lines: string[] = []

    lines.push(sep)
    lines.push(` MISSION DASHBOARD  ${new Date().toLocaleTimeString()}  (${this.missionIds.length} mission${this.missionIds.length > 1 ? 's' : ''})`)
    lines.push(sep)

    for (const missionId of this.missionIds) {
      const mission = getMission(missionId)
      if (!mission) continue

      // Mission header
      lines.push(`  ${statusEmoji(mission.status)} [${missionId.slice(0, 8)}] ${mission.goal.slice(0, col - 18)}`)

      // Divisions
      const divisions = getDivisionsForMission(missionId)
      for (const div of divisions) {
        const jobs = getJobsForDivision(div.id)
        const done = jobs.filter(j => j.status === 'completed').length
        const failed = jobs.filter(j => j.status === 'failed').length
        const running = jobs.filter(j => j.status === 'running').length
        const total = jobs.length
        const b = bar(done + failed, total || 1)
        const failSuffix = failed > 0 ? `, ${failed} failed` : ''
        lines.push(`    ${statusEmoji(div.status)} ${pad(div.role, 14)} ${b} ${done}/${total}${failSuffix}  ⚡${running}`)
      }
      if (divisions.length === 0) lines.push('    (planning...)')

      // Recent messages for this mission
      const recent = (this.messages.get(missionId) ?? []).slice(-4)
      for (const msg of recent) {
        lines.push('    › ' + msg.slice(0, col - 6))
      }

      lines.push(sep)
    }

    // Single cursor reposition + erase for the entire frame
    if (this.lines > 0) {
      process.stdout.write(`\x1b[${this.lines}A\x1b[0J`)
    }
    process.stdout.write(lines.join('\n') + '\n')
    this.lines = lines.length
  }
}

// Backwards-compatible single-mission wrapper kept for any existing callers outside routes/missions.ts
export class MissionDashboard {
  private multi: MultiMissionDashboard
  constructor(private missionId: string) {
    this.multi = new MultiMissionDashboard()
    this.multi.addMission(missionId)
  }
  addMessage(msg: string): void { this.multi.addMessage(this.missionId, msg) }
  start(): void { this.multi.start() }
  stop(): void {
    this.multi.removeMission(this.missionId)
    this.multi.stop()
  }
}
