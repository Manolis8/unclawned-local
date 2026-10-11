import { Request, Response, NextFunction } from 'express'
import { db } from '../lib/db.js'

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string }
    }
  }
}

export async function authenticateUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid authorization header' })
      return
    }
    const token = authHeader.substring(7)
    const row = db.prepare('SELECT user_id FROM api_keys WHERE key = ?').get(token) as any
    if (!row) {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }
    req.user = { id: row.user_id, email: row.user_id }
    next()
  } catch (error) {
    console.error('[Auth] Authentication error:', error)
    res.status(500).json({
      error: 'Authentication failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}

export function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7)
      const row = db.prepare('SELECT user_id FROM api_keys WHERE key = ?').get(token) as any
      if (row) req.user = { id: row.user_id, email: row.user_id }
    }
    next()
  } catch {
    next()
  }
}
