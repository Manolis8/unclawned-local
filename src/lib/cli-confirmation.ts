import readline from 'node:readline'
import type { ConfirmationRequest, ConfirmationResponse } from './agent-extension.js'

function box(lines: string[]): void {
  const maxLen = Math.max(...lines.map(l => l.replace(/[\u{1F000}-\u{1FFFF}]/gu, '  ').length))
  const width = Math.min(Math.max(maxLen + 2, 40), 65)
  const pad = (s: string) => {
    const visLen = s.replace(/[\u{1F000}-\u{1FFFF}]/gu, '  ').length
    return s + ' '.repeat(Math.max(0, width - visLen))
  }
  console.log('\n┌─' + '─'.repeat(width) + '─┐')
  for (const line of lines) {
    if (line === '---') {
      console.log('├─' + '─'.repeat(width) + '─┤')
    } else {
      console.log('│ ' + pad(line) + ' │')
    }
  }
  console.log('└─' + '─'.repeat(width) + '─┘')
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise(resolve => rl.question(q, resolve))
}

async function askRedirect(rl: readline.Interface): Promise<ConfirmationResponse> {
  const instruction = (await ask(rl, '  Any instructions for the agent? (press Enter to skip) > ')).trim()
  if (instruction) return { decision: 'denied', redirect_instruction: instruction }
  return { decision: 'denied' }
}

export async function handleConfirmationRequest(
  rl: readline.Interface,
  req: ConfirmationRequest
): Promise<ConfirmationResponse> {
  process.stdout.write('\n')

  if (req.tier === 2) return renderTier2(rl, req)
  if (req.tier === 3) return renderTier3(rl, req)
  if (req.tier === 4) return renderTier4(rl, req)
  return renderTier2(rl, req)  // unknown tier → gentle confirm, never silently destructive
}

async function renderTier2(rl: readline.Interface, req: ConfirmationRequest): Promise<ConfirmationResponse> {
  box([
    '⚡ Action Confirmation Required',
    '---',
    `Action : ${req.action_type.toUpperCase()} — ${req.target}`,
    `Effect : ${req.details}`,
  ])

  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = (await ask(rl, 'Confirm? (y/n) > ')).trim().toLowerCase()
    if (answer === 'y' || answer === 'yes') return { decision: 'approved' }
    if (answer === 'n' || answer === 'no') return askRedirect(rl)
    if (attempt === 0) console.log('  Please enter y or n.')
  }
  return askRedirect(rl)
}

// Social actions use the "Post Preview" flow with edit support.
// Everything else (file writes, commands, etc.) uses a plain approve/cancel flow.
const SOCIAL_ACTIONS = new Set([
  'post', 'comment', 'reply', 'send_message', 'send_dm', 'send_email',
  'publish', 'share', 'upload', 'tweet', 'submit', 'apply',
])

function wrapLines(text: string, maxLen = 60): string[] {
  const out: string[] = []
  for (const rawLine of text.split('\n')) {
    if (rawLine.length <= maxLen) { out.push(rawLine); continue }
    let rem = rawLine
    while (rem.length > maxLen) {
      const cut = rem.lastIndexOf(' ', maxLen)
      out.push(cut > 0 ? rem.slice(0, cut) : rem.slice(0, maxLen))
      rem = cut > 0 ? rem.slice(cut + 1) : rem.slice(maxLen)
    }
    if (rem) out.push(rem)
  }
  return out
}

async function renderTier3(rl: readline.Interface, req: ConfirmationRequest): Promise<ConfirmationResponse> {
  const isSocial = SOCIAL_ACTIONS.has(req.action_type)
  const body = req.content || req.details
  const wrappedLines = wrapLines(body)

  if (isSocial) {
    const platformLabel = req.platform ? ` — ${req.platform}` : ''
    box([
      `📋 Post Preview${platformLabel}`,
      '---',
      ...wrappedLines,
      '---',
      `Target : ${req.target}`,
    ])
    console.log('  a = approve and post   e = edit the content   c = cancel')
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = (await ask(rl, 'Your choice (a/e/c) > ')).trim().toLowerCase()
      if (answer === 'a' || answer === 'approve') return { decision: 'approved' }
      if (answer === 'c' || answer === 'cancel') return askRedirect(rl)
      if (answer === 'e' || answer === 'edit') {
        const instruction = (await ask(rl, 'What should I change? > ')).trim()
        if (!instruction) return { decision: 'denied' }
        return { decision: 'edit', edit_instruction: instruction }
      }
      if (attempt === 0) console.log('  Please type a, e, or c.')
    }
    return askRedirect(rl)
  }

  // Generic confirm for file writes, commands, and any non-social action
  const actionLabel = req.action_type.replace(/_/g, ' ').toUpperCase()
  box([
    `⚡ Confirm: ${actionLabel}`,
    '---',
    ...wrappedLines,
    '---',
    `Target : ${req.target}`,
  ])
  console.log('  y = approve   n = cancel')
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = (await ask(rl, 'Your choice (y/n) > ')).trim().toLowerCase()
    if (answer === 'y' || answer === 'yes') return { decision: 'approved' }
    if (answer === 'n' || answer === 'no') return askRedirect(rl)
    if (attempt === 0) console.log('  Please type y or n.')
  }
  return askRedirect(rl)
}

async function renderTier4(rl: readline.Interface, req: ConfirmationRequest): Promise<ConfirmationResponse> {
  box([
    '🗑️  Permanent Deletion — Cannot Be Undone',
    '---',
    'You are about to permanently delete:',
    '',
    `  "${req.target}"`,
    '',
    req.details,
    '',
    'This action cannot be undone.',
  ])

  const answer = (await ask(rl, 'Type "delete" to confirm, or press Enter to cancel: > ')).trim()
  if (answer === 'delete') return { decision: 'approved' }
  console.log('  Deletion cancelled.')
  return askRedirect(rl)
}
