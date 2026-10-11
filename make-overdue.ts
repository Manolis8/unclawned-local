import Database from 'better-sqlite3'
import { homedir } from 'os'
import path from 'path'

const db = new Database(path.join(homedir(), '.unclawned', 'openclaw.db'))

const items = db.prepare("SELECT * FROM open_items WHERE user_id = 'local' AND status = 'open'").all() as any[]

if (items.length === 0) {
  console.log('No open items found. Send a task that involves reaching out to someone first.')
} else {
  db.prepare("UPDATE open_items SET opened_at = datetime('now', '-4 days') WHERE user_id = 'local' AND status = 'open'").run()
  console.log(`Backdated ${items.length} open item(s) to 4 days ago:`)
  items.forEach(i => console.log(`  - ${i.summary} (${i.related_person ?? 'no person'})`))
  console.log('\nRestart npm run cli — the greeting will appear.')
}
