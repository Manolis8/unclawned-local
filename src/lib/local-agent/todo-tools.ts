// ─── Types ───────────────────────────────────────────────────────────────────

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

// ─── In-memory store (process-scoped, i.e. per session) ──────────────────────

let _todos: TodoItem[] = []

export function readTodos(): TodoItem[] {
  return [..._todos]
}

export function writeTodos(todos: TodoItem[]): void {
  const validStatuses = new Set(['pending', 'in_progress', 'completed'])
  const validPriorities = new Set(['high', 'medium', 'low'])
  for (const t of todos) {
    if (!t.id || !t.content) {
      throw new Error(`Todo item missing id or content: ${JSON.stringify(t)}`)
    }
    if (!validStatuses.has(t.status)) {
      throw new Error(`Invalid status "${t.status}" — must be pending, in_progress, or completed`)
    }
    if (!validPriorities.has(t.priority)) {
      throw new Error(`Invalid priority "${t.priority}" — must be high, medium, or low`)
    }
  }
  const inProgress = todos.filter(t => t.status === 'in_progress')
  if (inProgress.length > 1) {
    throw new Error(`Only one task can be in_progress at a time (found ${inProgress.length}: ${inProgress.map(t => t.id).join(', ')})`)
  }
  _todos = todos.map(t => ({
    id: String(t.id),
    content: String(t.content),
    status: t.status,
    priority: t.priority,
  }))
}

export function clearTodos(): void {
  _todos = []
}

// ─── Format ──────────────────────────────────────────────────────────────────

const STATUS_ICON: Record<TodoItem['status'], string> = {
  completed: '✓',
  in_progress: '→',
  pending: '○',
}

const PRIORITY_LABEL: Record<TodoItem['priority'], string> = {
  high: '[H]',
  medium: '[M]',
  low:  '[L]',
}

export function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '(empty — no tasks in the list)'
  return todos.map(t => {
    const suffix = t.status === 'in_progress' ? ' ← IN PROGRESS' : ''
    return `${STATUS_ICON[t.status]} ${PRIORITY_LABEL[t.priority]} [${t.id}] ${t.content}${suffix}`
  }).join('\n')
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const todoToolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'TodoRead',
      description: [
        'Read the current task list for this session.',
        'Use at the start of each multi-step task to see outstanding work and pick up where you left off.',
        'Returns all todo items with id, content, status (pending/in_progress/completed), and priority (high/medium/low).',
        'Call this before TodoWrite to avoid accidentally overwriting tasks you did not mean to change.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'TodoWrite',
      description: [
        'Create or update the task list for this session.',
        'REPLACES the entire list — always call TodoRead first and include all existing tasks.',
        'When to use: any task that requires 3 or more distinct steps to complete.',
        'When NOT to use: simple single-step actions — the overhead is not worth it.',
        'Mark only ONE task as in_progress at a time.',
        'Immediately mark a task completed as soon as you finish it — do not wait.',
        'Use high priority for blocking/urgent steps, medium for normal work, low for optional polish.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The complete new task list. All existing tasks must be included unless intentionally removed.',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: 'Unique identifier. Short slugs work well: "1", "2", or descriptive like "read-schema".',
                },
                content: {
                  type: 'string',
                  description: 'What needs to be done. Be specific so you can verify it is done.',
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Current state. Only ONE task may be in_progress at a time.',
                },
                priority: {
                  type: 'string',
                  enum: ['high', 'medium', 'low'],
                  description: 'Importance. high = blocking or time-sensitive, medium = normal, low = optional.',
                },
              },
              required: ['id', 'content', 'status', 'priority'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
]
