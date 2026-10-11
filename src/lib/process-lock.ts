import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const LOCK_FILE = join(homedir(), '.unclawned', 'cli.lock')

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function acquireCliLock(): void {
  if (existsSync(LOCK_FILE)) {
    const raw = readFileSync(LOCK_FILE, 'utf8').trim()
    const existingPid = parseInt(raw, 10)
    if (!isNaN(existingPid) && existingPid !== process.pid && pidIsAlive(existingPid)) {
      console.error('\n⛔  Another Unclawned session is already running (PID ' + existingPid + ').')
      console.error('   Only one CLI instance is allowed at a time.')
      console.error('   Close the other terminal first, then try again.\n')
      process.exit(1)
    }
  }

  writeFileSync(LOCK_FILE, String(process.pid), 'utf8')

  const release = () => {
    try { unlinkSync(LOCK_FILE) } catch {}
  }

  process.on('exit', release)
  process.on('SIGINT', () => { release(); process.exit(0) })
  process.on('SIGTERM', () => { release(); process.exit(0) })
}

export function isCliLockHeldByThisProcess(): boolean {
  try {
    const raw = readFileSync(LOCK_FILE, 'utf8').trim()
    return parseInt(raw, 10) === process.pid
  } catch {
    return false
  }
}
