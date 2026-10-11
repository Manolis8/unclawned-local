import Database from 'better-sqlite3'
import { homedir } from 'os'
import path from 'path'
import { randomUUID } from 'crypto'

const db = new Database(path.join(homedir(), '.unclawned', 'openclaw.db'))

db.prepare(`
  INSERT INTO open_items (id, user_id, item_type, summary, context, related_person, opened_at, follow_up_after_days)
  VALUES (?, 'local', 'pitch_made', 'Sent pitch deck to Sequoia', 'fundraising', 'Sequoia', datetime('now', '-4 days'), 3)
`).run(randomUUID())

const items = db.prepare("SELECT id, summary, related_person, opened_at FROM open_items WHERE user_id='local'").all()
console.log('Open items in DB:')
console.log(JSON.stringify(items, null, 2))
