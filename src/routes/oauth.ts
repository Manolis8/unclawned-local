import { Router } from 'express'
import { OAUTH_CONFIG, OAuthProvider } from '../lib/oauth-config.js'
import { encrypt, decrypt } from '../lib/encryption.js'
import { db, uuid } from '../lib/db.js'

function sanitizeString(input: unknown, maxLength = 100): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/\0/g, '')
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null
}

export const oauthRouter = Router()

oauthRouter.get('/oauth/:provider/connect', (req, res) => {
  const provider = req.params.provider as OAuthProvider
  const userId = sanitizeString(req.query.userId, 100)
  if (!userId || !OAUTH_CONFIG[provider]) return res.status(400).json({ error: 'Invalid provider or missing userId' })

  const config = OAUTH_CONFIG[provider]
  const state = Buffer.from(JSON.stringify({ userId, provider })).toString('base64')
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    state,
    access_type: 'offline',
    prompt: 'consent'
  })
  if (config.scopes.length > 0) params.set('scope', config.scopes.join(' '))
  res.redirect(`${config.authUrl}?${params.toString()}`)
})

oauthRouter.get('/oauth/:provider/callback', async (req, res) => {
  const provider = req.params.provider as OAuthProvider
  const { code, state, error } = req.query

  if (error) return res.redirect(`${process.env.FRONTEND_URL}?oauth_error=${error}`)
  if (!code || !state) return res.status(400).json({ error: 'Missing code or state' })

  let userId: string
  try {
    const decoded = JSON.parse(Buffer.from(state as string, 'base64').toString())
    userId = decoded.userId
  } catch {
    return res.status(400).json({ error: 'Invalid state' })
  }

  const config = OAUTH_CONFIG[provider]

  try {
    const tokenRes = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        ...(provider === 'notion' ? {
          'Authorization': 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
        } : {})
      },
      body: new URLSearchParams({
        code: code as string,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code'
      }).toString()
    })

    const tokens = await tokenRes.json()
    console.log(`OAuth tokens for ${provider}:`, JSON.stringify(tokens).slice(0, 200))

    if (!tokens.access_token && !tokens.authed_user) {
      throw new Error('No access token in response: ' + JSON.stringify(tokens))
    }

    const accessToken = provider === 'slack'
      ? tokens.authed_user?.access_token || tokens.access_token
      : tokens.access_token
    const refreshToken = tokens.refresh_token || null
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null

    db.prepare(`
      INSERT INTO oauth_tokens (id, user_id, provider, access_token, refresh_token, expires_at, scope, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at,
        scope = excluded.scope,
        updated_at = excluded.updated_at
    `).run(uuid(), userId, provider, encrypt(accessToken), refreshToken ? encrypt(refreshToken) : null, expiresAt, tokens.scope || null, new Date().toISOString())

    res.redirect(`${process.env.FRONTEND_URL}?oauth_success=${provider}`)
  } catch (err) {
    console.error(`OAuth callback error for ${provider}:`, err)
    res.redirect(`${process.env.FRONTEND_URL}?oauth_error=token_exchange_failed`)
  }
})

oauthRouter.get('/oauth/status/:userId', async (req, res) => {
  const rows = db.prepare("SELECT provider FROM oauth_tokens WHERE user_id = ?").all(req.params.userId) as any[]
  const connected: Record<string, boolean> = {
    gmail: false, 'google-calendar': false, 'google-sheets': false,
    slack: false, notion: false, github: false
  }
  rows.forEach(row => { connected[row.provider] = true })
  res.json(connected)
})

oauthRouter.delete('/oauth/:provider/:userId', async (req, res) => {
  db.prepare("DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?").run(req.params.userId, req.params.provider)
  res.json({ ok: true })
})

oauthRouter.get('/oauth/token/:provider/:userId', async (req, res) => {
  const { provider, userId } = req.params
  const data = db.prepare("SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?").get(userId, provider) as any
  if (!data) return res.status(404).json({ error: 'Not connected' })

  if (data.expires_at && data.refresh_token) {
    const expiresAt = new Date(data.expires_at)
    if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
      try {
        const config = OAUTH_CONFIG[provider as OAuthProvider]
        const refreshRes = await fetch(config.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: decrypt(data.refresh_token),
            client_id: config.clientId,
            client_secret: config.clientSecret
          }).toString()
        })
        const refreshed = await refreshRes.json()
        if (refreshed.access_token) {
          const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
          db.prepare("UPDATE oauth_tokens SET access_token = ?, expires_at = ?, updated_at = ? WHERE user_id = ? AND provider = ?")
            .run(encrypt(refreshed.access_token), newExpiresAt, new Date().toISOString(), userId, provider)
          return res.json({ accessToken: refreshed.access_token, expiresAt: newExpiresAt })
        }
      } catch (err) {
        console.error('Token refresh error:', err)
      }
    }
  }

  res.json({ accessToken: decrypt(data.access_token), expiresAt: data.expires_at })
})
