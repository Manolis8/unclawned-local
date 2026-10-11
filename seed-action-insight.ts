import Database from 'better-sqlite3'
import { homedir } from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

const db = new Database(path.join(homedir(), '.unclawned', 'openclaw.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS action_queue (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action_category TEXT NOT NULL,
    insight_text TEXT NOT NULL, question_text TEXT, evidence TEXT,
    value_score REAL NOT NULL DEFAULT 5.0, confidence REAL NOT NULL DEFAULT 0.6,
    friction REAL NOT NULL DEFAULT 3.0, priority_score REAL,
    status TEXT NOT NULL DEFAULT 'queued', sessions_in_queue INTEGER NOT NULL DEFAULT 0,
    last_scored_at TEXT, dismissal_count INTEGER NOT NULL DEFAULT 0,
    dismiss_lock_until TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_aq_user ON action_queue(user_id, status);
  CREATE TABLE IF NOT EXISTS action_memory (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, queue_id TEXT,
    action_category TEXT NOT NULL, surfaced_at TEXT NOT NULL,
    user_response TEXT, session_window TEXT, priority_score REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_am_user ON action_memory(user_id, created_at);
  CREATE TABLE IF NOT EXISTS action_suppression (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, category TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT 'user_command', expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(user_id, category)
  );
  CREATE INDEX IF NOT EXISTS idx_as_user ON action_suppression(user_id, category);
`)

// Full reset — remove all test data so the seed is always clean
db.prepare("DELETE FROM action_memory WHERE user_id = 'local' AND action_category = 'relationship_cooling'").run()
db.prepare("DELETE FROM action_queue WHERE user_id = 'local' AND action_category = 'relationship_cooling'").run()
db.prepare("DELETE FROM action_suppression WHERE user_id = 'local'").run()

db.prepare(`
  INSERT INTO action_queue
    (id, user_id, action_category, insight_text, question_text, evidence, value_score, confidence, friction, status)
  VALUES
    (?, 'local', 'relationship_cooling',
     'You haven''t mentioned Alex Chen (investor) in 18 days.',
     'Worth a quick check-in, or is that intentional?',
     '{"person_name":"Alex Chen","days_since":18,"mention_count":5}',
     6.5, 0.75, 2.5, 'queued')
`).run(randomUUID())

const rows = db.prepare("SELECT id, action_category, insight_text, status FROM action_queue WHERE user_id='local'").all()
console.log('action_queue:')
console.log(JSON.stringify(rows, null, 2))
console.log('\nRun: npm run cli')
