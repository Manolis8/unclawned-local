function envInt(name: string, def: number): number {
  const raw = process.env[name]
  if (!raw) return def
  const n = parseInt(raw, 10)
  if (isNaN(n)) {
    console.error(`[config] ${name}="${raw}" is not a valid integer — using default ${def}`)
    return def
  }
  return n
}

function envFloat(name: string, def: number): number {
  const raw = process.env[name]
  if (!raw) return def
  const n = parseFloat(raw)
  if (isNaN(n)) {
    console.error(`[config] ${name}="${raw}" is not a valid number — using default ${def}`)
    return def
  }
  return n
}

// Runtime-configurable values read once at startup from environment variables.
// Set them before starting the server. See config.example.env for the full list.
export const config = Object.freeze({
  // Max crash resets before a job permanently fails (range: 0–10)
  MISSION_CRASH_CEILING: envInt('MISSION_CRASH_CEILING', 3),
  // Job retry attempts on non-crash failure (range: 1–10)
  MISSION_MAX_ATTEMPTS: envInt('MISSION_MAX_ATTEMPTS', 2),
  // Worker concurrency pool per mission — reduce if hitting API rate limits (range: 1–64)
  MISSION_POOL_SIZE: envInt('MISSION_POOL_SIZE', 8),
  // Per-mission spend cap in dollars
  MISSION_BUDGET_USD: envFloat('MISSION_BUDGET_USD', 50),
  // CEO planning LLM turn budget (range: 5–50)
  CEO_MAX_ITERATIONS: envInt('CEO_MAX_ITERATIONS', 15),
  // Manager LLM turn budget for planning and synthesis (range: 5–50)
  MANAGER_MAX_ITERATIONS: envInt('MANAGER_MAX_ITERATIONS', 15),
  // Dashboard repaint interval in milliseconds (range: 500–10000)
  DASHBOARD_REFRESH_MS: envInt('DASHBOARD_REFRESH_MS', 2000),
  // Scheduler tick rate in milliseconds (range: 100–10000)
  SCHEDULER_TICK_MS: envInt('SCHEDULER_TICK_MS', 1000),
  // Output artifact size cap in bytes (range: 1000–1000000)
  ARTIFACT_SIZE_CAP: envInt('ARTIFACT_SIZE_CAP', 20000),
  // Checkpoint write interval in events (range: 1–1000)
  CHECKPOINT_INTERVAL: envInt('CHECKPOINT_INTERVAL', 10),
  // Enable verbose HTTP request logging
  LOG_REQUESTS: process.env.LOG_REQUESTS === 'true' || process.env.DEBUG === 'true',
})
