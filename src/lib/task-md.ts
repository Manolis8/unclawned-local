import fs from 'fs'
import path from 'path'
import { TASKS_DIR, ARCHIVE_DIR, initContextDirs } from './context-files.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeTaskId(taskId: string): string {
  // Remove characters unsafe for filenames, keep it short
  return taskId.replace(/[^a-z0-9\-_]/gi, '-').slice(0, 40)
}

function taskFilePath(taskId: string): string {
  return path.join(TASKS_DIR, `${sanitizeTaskId(taskId)}.md`)
}

function archiveFilePath(taskId: string, date: string): string {
  return path.join(ARCHIVE_DIR, `${date}-${sanitizeTaskId(taskId)}.md`)
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function nowIso(): string {
  return new Date().toISOString()
}

// ─── Create TASK.md at task start ─────────────────────────────────────────────

export function createTaskMd(taskId: string, taskPrompt: string): void {
  initContextDirs()
  const content = `# TASK: ${taskPrompt.slice(0, 100)}
Created: ${nowIso()}
Status: in_progress
Task ID: ${taskId}

## Goal
${taskPrompt}

## Progress
(updating as task runs)

## Outcome
(filled at completion)
`
  fs.writeFileSync(taskFilePath(taskId), content, 'utf-8')
}

// ─── Update progress mid-task ─────────────────────────────────────────────────

export function updateTaskMd(taskId: string, stepDescription: string): void {
  const filePath = taskFilePath(taskId)
  if (!fs.existsSync(filePath)) return
  try {
    let content = fs.readFileSync(filePath, 'utf-8')
    const timestamp = new Date().toISOString().slice(11, 19) // HH:MM:SS
    const line = `- [${timestamp}] ${stepDescription}`
    // Replace placeholder on first update, otherwise append before ## Outcome
    if (content.includes('(updating as task runs)')) {
      content = content.replace('(updating as task runs)', line)
    } else {
      content = content.replace('\n## Outcome', `\n${line}\n## Outcome`)
    }
    fs.writeFileSync(filePath, content, 'utf-8')
  } catch {
    // Non-fatal
  }
}

// ─── Archive TASK.md on completion ────────────────────────────────────────────

export function archiveTaskMd(taskId: string, outcome: 'completed' | 'failed', summary?: string): void {
  const src = taskFilePath(taskId)
  if (!fs.existsSync(src)) return

  try {
    let content = fs.readFileSync(src, 'utf-8')
    content = content
      .replace('Status: in_progress', `Status: ${outcome}`)
      .replace('(filled at completion)', summary ? summary.slice(0, 300) : outcome)
    content += `\nArchived: ${nowIso()}\n`

    const dest = archiveFilePath(taskId, today())
    fs.writeFileSync(dest, content, 'utf-8')
    fs.unlinkSync(src)
  } catch {
    // Archive failure is non-fatal
  }
}

// ─── List active tasks (non-archived) ─────────────────────────────────────────

export interface ActiveTask {
  taskId: string
  goal: string
  created: string
  filePath: string
}

export function listActiveTasks(): ActiveTask[] {
  if (!fs.existsSync(TASKS_DIR)) return []
  try {
    return fs.readdirSync(TASKS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = path.join(TASKS_DIR, f)
        const content = fs.readFileSync(filePath, 'utf-8')
        const goalMatch = content.match(/## Goal\n([\s\S]*?)(?=\n##|$)/)
        const createdMatch = content.match(/Created: (.+)/)
        const taskIdMatch = content.match(/Task ID: (.+)/)
        return {
          taskId: taskIdMatch?.[1]?.trim() ?? f.replace('.md', ''),
          goal: goalMatch?.[1]?.trim().slice(0, 100) ?? '(no goal)',
          created: createdMatch?.[1]?.trim() ?? '?',
          filePath,
        }
      })
      .sort((a, b) => b.created.localeCompare(a.created))
  } catch {
    return []
  }
}

// ─── Load active task content for system prompt injection ─────────────────────

export function getActiveTaskContext(taskId: string): string | null {
  const filePath = taskFilePath(taskId)
  if (!fs.existsSync(filePath)) return null
  try {
    return fs.readFileSync(filePath, 'utf-8').trim() || null
  } catch {
    return null
  }
}

// Clean up stale in-progress task files older than 7 days (crash leftovers)
export function cleanStaleTasks(): void {
  if (!fs.existsSync(TASKS_DIR)) return
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  try {
    fs.readdirSync(TASKS_DIR)
      .filter(f => f.endsWith('.md'))
      .forEach(f => {
        const filePath = path.join(TASKS_DIR, f)
        const stat = fs.statSync(filePath)
        if (stat.mtimeMs < sevenDaysAgo) {
          archiveTaskMd(f.replace('.md', ''), 'failed', 'Auto-archived: session ended without completion')
        }
      })
  } catch {
    // Non-fatal
  }
}
