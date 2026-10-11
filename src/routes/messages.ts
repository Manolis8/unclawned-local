import { Router } from 'express'
import { db } from '../lib/db.js'

export const messagesRouter = Router()

messagesRouter.get('/messages/:userId', async (req, res) => {
  const data = db.prepare("SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(req.params.userId)
  res.json(data || [])
})

messagesRouter.get('/messages/:userId/unread', async (req, res) => {
  const row = db.prepare("SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND read = 0").get(req.params.userId) as any
  res.json({ count: row?.count ?? 0 })
})

messagesRouter.patch('/messages/:messageId/read', async (req, res) => {
  db.prepare("UPDATE messages SET read = 1 WHERE id = ?").run(req.params.messageId)
  res.json({ ok: true })
})

messagesRouter.patch('/messages/:userId/read-all', async (req, res) => {
  db.prepare("UPDATE messages SET read = 1 WHERE user_id = ? AND read = 0").run(req.params.userId)
  res.json({ ok: true })
})
