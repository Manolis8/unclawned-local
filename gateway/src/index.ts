/**
 * openclaw-gateway — Cloudflare Worker
 *
 * Sits between openclaw and third-party API providers.
 * Real API keys live here as Worker secrets — never on the openclaw server.
 *
 * Auth: every request must include X-Gateway-Token matching GATEWAY_TOKEN secret.
 * Adding a new provider: add a new action block below and set its key as a secret.
 */

interface Env {
  GATEWAY_TOKEN: string
  TAVILY_API_KEY: string
  // Future providers — add here when ready:
  // BRAVE_API_KEY: string
  // JINA_API_KEY: string
}

const JSON_HEADERS = { 'content-type': 'application/json' }

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: JSON_HEADERS })
}

function badRequest(msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), { status: 400, headers: JSON_HEADERS })
}

async function proxyPost(url: string, payload: Record<string, unknown>): Promise<Response> {
  const upstream = await fetch(url, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  })
  const text = await upstream.text()
  return new Response(text, { status: upstream.status, headers: JSON_HEADERS })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return badRequest('POST only')

    // Server-to-server auth — token never leaves your infrastructure
    const token = request.headers.get('X-Gateway-Token')
    if (!token || token !== env.GATEWAY_TOKEN) return unauthorized()

    let body: { action?: string } & Record<string, unknown>
    try {
      body = await request.json() as any
    } catch {
      return badRequest('Invalid JSON')
    }

    const { action, ...payload } = body

    // ── Tavily ────────────────────────────────────────────────────────────────
    if (action === 'tavily_search') {
      return proxyPost('https://api.tavily.com/search', {
        api_key: env.TAVILY_API_KEY,
        ...payload,
      })
    }

    if (action === 'tavily_extract') {
      return proxyPost('https://api.tavily.com/extract', {
        api_key: env.TAVILY_API_KEY,
        ...payload,
      })
    }

    // ── Future providers go here ──────────────────────────────────────────────
    // if (action === 'brave_search') { ... }
    // if (action === 'jina_extract') { ... }

    return badRequest(`Unknown action: ${action}`)
  },
}
