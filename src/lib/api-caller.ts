import { db, j } from './db.js'
import { OAUTH_CONFIG, OAuthProvider } from './oauth-config.js'
import { encrypt, decrypt } from './encryption.js'

export interface TokenData {
  accessToken: string
  expiresAt?: string
}

export async function getAndRefreshToken(userId: string, provider: OAuthProvider): Promise<TokenData | null> {
  try {
    const data = db.prepare('SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?').get(userId, provider) as any
    if (!data) {
      console.log(`No token found for ${provider}/${userId}`)
      return null
    }

    let accessToken = decrypt(data.access_token)
    let expiresAt = data.expires_at

    if (expiresAt && data.refresh_token) {
      const expiresTime = new Date(expiresAt).getTime()
      if (expiresTime - Date.now() < 5 * 60 * 1000) {
        try {
          const config = OAUTH_CONFIG[provider]
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
            accessToken = refreshed.access_token
            expiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
            db.prepare('UPDATE oauth_tokens SET access_token = ?, expires_at = ?, updated_at = ? WHERE user_id = ? AND provider = ?')
              .run(encrypt(refreshed.access_token), expiresAt, new Date().toISOString(), userId, provider)
            console.log(`Refreshed ${provider} token for ${userId}`)
          }
        } catch (refreshErr) {
          console.error(`Token refresh failed for ${provider}:`, refreshErr)
        }
      }
    }

    return { accessToken, expiresAt }
  } catch (err) {
    console.error(`getAndRefreshToken error for ${provider}:`, err)
    return null
  }
}

export async function makeApiCall(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: any; authorization?: string } = {}
): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...options.headers }
  if (options.authorization) headers['Authorization'] = options.authorization

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    ...(options.body && { body: JSON.stringify(options.body) })
  })

  const text = await response.text()
  if (!response.ok) throw new Error(`API call failed (${response.status}): ${text}`)
  return text ? JSON.parse(text) : null
}

export async function isProviderConnected(userId: string, provider: OAuthProvider): Promise<boolean> {
  return (await getAndRefreshToken(userId, provider)) !== null
}
