import { execFile, spawn } from 'child_process'
import { validatePath, getAllowedDirs } from './security.js'
import { getPlatformProfile } from './platform-profile.js'
import { homedir } from 'os'
import path from 'path'
import fs from 'fs'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const MAX_OUTPUT_LINES = 200

// Commands that are never allowed — hard blacklist, checked before any execution
const BLACKLISTED_PATTERNS: RegExp[] = [
  // Destructive file operations
  /\brm\s+-rf?\b/i,
  /\bdel\s+\/[fsFsS]/i,
  /\bremove-item\b.*-recurse/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  // Privilege escalation
  /\bsudo\s+rm\b/i,
  /\bsudo\s+mkfs\b/i,
  /\bchmod\s+777\b/i,
  /\bchown\s+root\b/i,
  // Shutdown / system control
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  // Pipe-to-shell (classic code injection vector)
  /\|\s*(ba)?sh\b/i,
  /\|\s*cmd\b/i,
  /\|\s*powershell\b/i,
  /curl[^|]+\|\s*\w/i,
  /wget[^|]+\|\s*\w/i,
  // Dangerous DB operations
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
]

// System directories the working_dir can never be set to
const BLOCKED_WORKING_DIRS: RegExp[] = [
  /^[A-Za-z]:[/\\]Windows([/\\]|$)/i,
  /^[A-Za-z]:[/\\]Program Files([/\\]|$)/i,
  /^\/etc([/]|$)/,
  /^\/sys([/]|$)/,
  /^\/proc([/]|$)/,
]

// ── Write-indicating keywords — if any appear anywhere, command is NOT read-only ──
const WRITE_KEYWORDS_RE = new RegExp(
  '\\b(' + [
    'Set-Content', 'Add-Content', 'New-Item', 'Remove-Item', 'Move-Item', 'Copy-Item', 'Rename-Item',
    'Out-File', 'Tee-Object', 'Set-Variable', 'Set-ItemProperty', 'Set-Location',
    'Export-Csv', 'Export-Clixml', 'Export-ModuleMember',
    'Write-Output', 'Write-Host', 'Write-Error', 'Write-Warning',
    'Register-', 'Unregister-', 'Enable-', 'Disable-', 'Start-', 'Stop-', 'Restart-', 'Reset-',
    'Install-', 'Uninstall-', 'Update-Module', 'Update-Package',
    'Clear-Content', 'Clear-Item', 'Clear-Variable', 'Clear-History',
    'mkdir', 'md', 'touch', 'mktemp',
    'chmod', 'chown', 'chgrp',
    'ln\\s+-s', 'ln\\s+-f',
    'mv\\b', 'cp\\b',
    'truncate', 'tee\\b',
    'dd\\b',
    'git\\s+(add|commit|push|pull|merge|rebase|checkout\\s+-b|branch\\s+-d|tag\\s+-d|reset|stash\\s+(push|pop|drop|clear)|cherry-pick|apply|am|fetch)',
    'npm\\s+(install|uninstall|update|publish|run|exec|init|link|pack)',
    'yarn\\s+(add|remove|install|upgrade|publish)',
    'pnpm\\s+(add|remove|install|update|publish)',
    'pip\\s+(install|uninstall|download)',
    'pip3\\s+(install|uninstall)',
    'brew\\s+(install|uninstall|upgrade|update|tap|untap|link|unlink|cleanup|cask\\s+install)',
    'apt(-get)?\\s+(install|remove|purge|update|upgrade|autoremove)',
    'apt\\s+(install|remove|purge)',
    'yum\\s+(install|remove|update|upgrade)',
    'dnf\\s+(install|remove|update|upgrade)',
    'pacman\\s+(-S|-R|-U|-D)',
    'snap\\s+(install|remove|refresh)',
    'cargo\\s+(install|uninstall|build|publish|update)',
    'gem\\s+(install|uninstall|update|push)',
    'composer\\s+(install|require|remove|update)',
    'dotnet\\s+(add|remove|restore|build|publish)',
    'systemctl\\s+(start|stop|restart|enable|disable|reload|mask|unmask)',
    'service\\s+\\S+\\s+(start|stop|restart)',
    'crontab\\s+-e',
    'visudo',
    'passwd',
    'useradd', 'userdel', 'usermod', 'groupadd', 'groupdel',
    'sudo\\b', 'su\\b',
  ].join('|') + ')\\b',
  'i'
)

// ── Read-only command patterns — covers Windows/PowerShell, macOS, Linux ──
const READONLY_COMMAND_PATTERNS: RegExp[] = [

  // ── Navigation & location (safe: working_dir handles the actual directory) ──
  /^cd(\s|$)/i,
  /^(Set-Location|Push-Location|Pop-Location|Get-Location|pwd|gl|sl)\b/i,

  // ── File & directory listing ──
  /^(Get-ChildItem|gci|dir|ls|ll|la)\b/i,
  /^ls\s/i,
  /^(find)\s/i,          // find (read-only — no -delete, -exec rm, etc.)
  /^(locate|mdfind)\b/i, // macOS Spotlight + Linux locate

  // ── File reading ──
  /^(Get-Content|gc|cat|tac|type)\b/i,
  /^(head|tail)\b/i,
  /^(less|more|most|bat)\b/i,
  /^(strings)\b/i,

  // ── Text processing & search ──
  /^(grep|egrep|fgrep|rg|ag|ripgrep|the_silver_searcher)\b/i,
  /^(Select-String|sls|findstr)\b/i,
  /^(awk|gawk|mawk)\b/i,
  /^(sed\s+-n)\b/i,            // sed -n is read-only (print only, no edit)
  /^(cut|tr|sort|uniq|comm)\b/i,
  /^(wc|nl|od|xxd|hexdump)\b/i,
  /^(diff|diff3|colordiff|delta)\b/i,
  /^(jq|yq|xmllint)\b/i,        // JSON/YAML/XML readers

  // ── File info & metadata ──
  /^(stat|file|wc)\b/i,
  /^(Get-Item|gi|Get-ItemProperty|gp)\b/i,
  /^(Get-FileHash)\b/i,
  /^(md5|md5sum|sha1sum|sha256sum|sha512sum|shasum|cksum)\b/i,
  /^(Test-Path|tsp)\b/i,
  /^(readlink)\b/i,
  /^(lsattr|getfattr|getfacl)\b/i,

  // ── Disk & filesystem ──
  /^(df|du)\b/i,
  /^(Get-Disk|Get-Volume|Get-Partition|Get-PSDrive)\b/i,
  /^(lsblk|blkid|fdisk\s+-l|parted\s+print)\b/i,
  /^(mount)\b/i,     // listing only (no args = read-only)
  /^(diskutil\s+(list|info|activity))\b/i,  // macOS

  // ── System information ──
  /^(uname|hostname|domainname)\b/i,
  /^(whoami|id|logname|users|who|w)\b/i,
  /^(date|time|timedatectl\s+status)\b/i,
  /^(uptime)\b/i,
  /^(Get-Date|Get-ComputerInfo|Get-Host)\b/i,
  /^(Get-WmiObject|gwmi)\b/i,
  /^(systeminfo)\b/i,
  /^(sysctl)\b/i,              // macOS/Linux: read kernel params
  /^(lscpu|lsmem|lshw|lsusb|lspci|lsdev)\b/i,  // Linux hardware
  /^(sw_vers|system_profiler)\b/i,  // macOS
  /^ipconfig(\s+(\/all|\/displaydns|\/release|\/renew|\/flushdns))?\b/i,  // Windows
  /^(wmic\s+(os|cpu|memorychip|diskdrive|nic)\s+get)\b/i,  // Windows WMI read

  // ── Process & resource monitoring ──
  /^(Get-Process|gps|ps\b)\b/i,
  /^(ps\s)/i,
  /^(top\s+-[bln]|htop\s|atop\s)\b/i,  // non-interactive top
  /^(lsof)\b/i,
  /^(pgrep|pidof|pstree)\b/i,
  /^(Get-Service|gsv)\b/i,
  /^(free|vmstat|iostat|mpstat|sar|dstat)\b/i,
  /^(ulimit\s+-a)\b/i,
  /^(tasklist)\b/i,  // Windows

  // ── Network (read-only) ──
  /^(ifconfig|ip\s+(addr|link|route|neigh|rule))\b/i,
  /^(Get-NetAdapter|Get-NetIPAddress|Get-NetRoute|Get-DnsClient)\b/i,
  /^(netstat|ss)\b/i,
  /^(ping\s+)\b/i,
  /^(nslookup|dig|host|whois|nmap\s+-sn)\b/i,
  /^(traceroute|tracert|mtr)\b/i,
  /^(curl\s+(-V|--version|-I|--head|-sI))\b/i,  // curl info/head only
  /^(wget\s+(--version|-V))\b/i,
  /^(netsh\s+(wlan\s+show|interface\s+show))\b/i,  // Windows wifi/net info
  /^(arp\s+-a)\b/i,

  // ── Environment & shell ──
  /^(env|printenv|export\s+-p)\b/i,
  /^(echo)\b/i,   // echo is safe if no redirect (redirect check handled separately)
  /^(which|whereis|where\b|type\s+)\b/i,
  /^(Get-Variable|gv|Get-Command|gcm|Get-Alias|gal|Get-Module|gmo|Get-Help|Get-Content)\b/i,
  /^\$\w+\b/i,                 // reading a PowerShell variable: $env:PATH, $PSVersionTable
  /^\[System\./i,              // PowerShell .NET read: [System.Environment]::...
  /^(man|info|help|tldr)\b/i,

  // ── Git — all read commands ──
  /^git\s+(status|log|diff|branch|remote|show|stash\s+list|tag|describe|rev-parse|ls-files|ls-tree|shortlog|blame|bisect\s+log|whatchanged|name-rev|cat-file|config\s+--list|config\s+-l|reflog|grep|archive\s+--list|for-each-ref|verify-tag|count-objects|fsck|bundle\s+list-heads)\b/i,
  /^git\s+(--version|-v|--help|-h)\b/i,

  // ── Python ──
  /^(python|python3|python2)\s+(--version|-V|-c\s+"[^"]*print|-m\s+pip\s+(list|show|freeze|check))\b/i,
  /^(python|python3)\s+-m\s+(pip\s+(list|show|freeze|check)|json\.tool|http\.server\s+--help)\b/i,
  /^(pip|pip3)\s+(list|show|freeze|check|search)\b/i,

  // ── Node / npm / yarn / pnpm / bun / deno ──
  /^(node|nodejs)\s+(--version|-v|--help|-e\s+"console)\b/i,
  /^(npm)\s+(--version|-v|list|ls|outdated|info|view|show|config\s+list|whoami|ping|doctor)\b/i,
  /^(yarn)\s+(--version|-v|list|info|why|workspaces\s+info)\b/i,
  /^(pnpm)\s+(--version|-v|list|ls|why|store\s+status)\b/i,
  /^(bun)\s+(--version|-v|pm\s+ls)\b/i,
  /^(deno)\s+(--version|-V|info|doc)\b/i,
  /^(npx)\s+(--version|-v)\b/i,

  // ── Other runtimes & tools ──
  /^(ruby)\s+(--version|-v)\b/i,
  /^(gem)\s+(--version|-v|list|info|environment|contents)\b/i,
  /^(go)\s+(version|env|list|doc)\b/i,
  /^(java|javac|kotlinc)\s+(--version|-version)\b/i,
  /^(dotnet)\s+(--version|--info|list)\b/i,
  /^(rustc|rustup|cargo)\s+(--version|-V|tree|metadata|locate-project|verify-project)\b/i,
  /^(php)\s+(--version|-v|--info|-i|--modules|-m)\b/i,
  /^(composer)\s+(--version|-V|show|info|diagnose|validate|licenses)\b/i,
  /^(swift)\s+(--version|-v)\b/i,

  // ── Package managers — read only ──
  /^(brew)\s+(list|info|outdated|search|deps|desc|uses|commands|shellenv)\b/i,
  /^(apt(-cache)?|apt-get)\s+(show|search|policy|depends|rdepends)\b/i,
  /^(apt)\s+(list)\b/i,
  /^(dpkg)\s+(-l|-s|-L|-S)\b/i,
  /^(rpm)\s+(-qa|-qi|-ql|-qf)\b/i,
  /^(snap)\s+(list|info|find)\b/i,
  /^(yum|dnf)\s+(list|info|search|deplist|repolist)\b/i,
  /^(pacman)\s+(-Q|-Si|-Ql|-Ss|-Qi)\b/i,
  /^(winget)\s+(list|show|search|source\s+list)\b/i,
  /^(choco)\s+(list|info|search|outdated)\b/i,
  /^(scoop)\s+(list|info|search|status)\b/i,

  // ── Database — read-only queries ──
  /^(sqlite3\s+\S+\s+"SELECT)\b/i,
  /^(psql|mysql|mongo)\s+.*--help\b/i,

  // ── PowerShell pipeline: read → transform ──
  /^(Get-Content|dir|cat|ls|Get-ChildItem|gc|gci)\b.*\|\s*(Select-Object|Where-Object|ForEach-Object|Sort-Object|Measure-Object|Group-Object|Format-Table|Format-List|Format-Wide|Out-String|Select-String|ConvertTo-Json|ConvertFrom-Json)\b/i,
]

// cd && read_command  →  strip the cd prefix and re-evaluate the rest
function stripCdPrefix(command: string): string {
  return command.replace(/^cd\s+\S+\s*&&\s*/, '').trim()
}

function isReadonlyCommand(command: string): boolean {
  const trimmed = command.trim()

  // Hard reject: any write/destructive keyword anywhere in the command
  if (WRITE_KEYWORDS_RE.test(trimmed)) return false

  // Hard reject: output redirection
  if (/>>?\s*\S/.test(trimmed)) return false

  // Hard reject: background execution or command chaining with write risk
  if (/[;&]\s*(rm|del|mv|cp|mkdir|touch|chmod|chown|npm\s+install|pip\s+install|brew\s+install)\b/i.test(trimmed)) return false

  // Strip leading "cd path &&" and evaluate the real command
  const effective = stripCdPrefix(trimmed)

  return READONLY_COMMAND_PATTERNS.some(p => p.test(effective))
}

export interface RunCommandPreview {
  command: string
  workingDir: string
  timeoutMs: number
  tier: 0 | 3 | 4  // 0 = safe read-only (auto-run), 3 = needs confirm, 4 = destructive
}

export type CommandErrorType =
  'success' | 'not-installed' | 'not-found' | 'permission-denied' |
  'timeout' | 'syntax-error' | 'unknown'

export interface RunCommandResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  truncated: boolean
  command: string
  workingDir: string
  durationMs: number
  errorType: CommandErrorType
  errorSuggestion: string
}

export function previewRunCommand(
  command: string,
  workingDir?: string,
  timeoutMs?: number
): RunCommandPreview {
  const resolvedDir = resolveWorkingDir(workingDir)
  const safeTimeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

  // Check blacklist — hard block regardless of tier
  for (const pattern of BLACKLISTED_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(
        `Command blocked: matches a protected pattern ("${pattern.source}"). ` +
        `This type of command is not allowed for safety reasons.`
      )
    }
  }

  let tier: 0 | 3 | 4
  if (isReadonlyCommand(command)) {
    tier = 0  // safe read-only — runs without asking
  } else if (/\bdelete\b|\bremove-item\b|\bdel\b|\berase\b|\bwipe\b/i.test(command)) {
    tier = 4  // destructive
  } else {
    tier = 3  // normal write/execute — needs confirm
  }

  return {
    command,
    workingDir: resolvedDir,
    timeoutMs: safeTimeout,
    tier,
  }
}

export async function executeRunCommand(
  command: string,
  workingDir?: string,
  timeoutMs?: number
): Promise<RunCommandResult> {
  const resolvedDir = resolveWorkingDir(workingDir)
  const safeTimeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)

  // Re-check blacklist at execution time (belt + suspenders)
  for (const pattern of BLACKLISTED_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`Command blocked: "${pattern.source}"`)
    }
  }

  const profile = getPlatformProfile()
  const { bin, invokeArgs, utf8Prefix } = profile.shell

  // Suppress color codes from tools that ignore isatty
  const env = { ...process.env }
  if (profile.osFamily !== 'windows') {
    env.TERM = 'dumb'
    env.NO_COLOR = '1'
    env.FORCE_COLOR = '0'
  }

  const start = Date.now()
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  let timedOut = false

  await new Promise<void>((resolve) => {
    let killTimer: NodeJS.Timeout
    const child = execFile(
      bin,
      [...invokeArgs, utf8Prefix + command],
      { cwd: resolvedDir, timeout: safeTimeout, env, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
      (error, out, err) => {
        clearTimeout(killTimer)
        stdout = normalizeOutput(typeof out === 'string' ? out : '')
        stderr = normalizeOutput(typeof err === 'string' ? err : '')
        const code = (error as any)?.code
        exitCode = typeof code === 'number' ? code : (error ? 1 : 0)
        if (error?.killed || (error as any)?.signal === 'SIGTERM') {
          timedOut = true
          exitCode = -1
        }
        resolve()
      }
    )
    killTimer = setTimeout(() => { try { child.kill() } catch {} }, safeTimeout + 1000)
  })

  const durationMs = Date.now() - start

  // Truncate long output
  const stdoutLines = stdout.split('\n')
  const truncated = stdoutLines.length > MAX_OUTPUT_LINES
  if (truncated) {
    stdout = stdoutLines.slice(0, MAX_OUTPUT_LINES).join('\n') +
      `\n[Output truncated — ${stdoutLines.length - MAX_OUTPUT_LINES} more lines omitted. Narrow your command to get less output.]`
  }

  const { errorType, errorSuggestion } = classifyCommandError(exitCode, stderr, stdout, timedOut, profile)

  return { stdout, stderr, exitCode, timedOut, truncated, command, workingDir: resolvedDir, durationMs, errorType, errorSuggestion }
}

// ─── Output normalization ─────────────────────────────────────────────────────

function normalizeOutput(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*[mGKHFABCDJK]/g, '')  // ANSI escape codes (color, cursor, erase)
    .replace(/\x1b\][^\x07]*\x07/g, '')             // OSC sequences (title, hyperlinks)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n').map(l => l.trimEnd()).join('\n')
}

// ─── Error classification ─────────────────────────────────────────────────────

function classifyCommandError(
  exitCode: number,
  stderr: string,
  stdout: string,
  timedOut: boolean,
  profile: ReturnType<typeof getPlatformProfile>,
): { errorType: CommandErrorType; errorSuggestion: string } {
  if (timedOut) {
    return { errorType: 'timeout', errorSuggestion: 'Command timed out. Try a more specific command or increase timeout_ms.' }
  }
  if (exitCode === 0) {
    return { errorType: 'success', errorSuggestion: '' }
  }

  const combined = (stderr + ' ' + stdout).toLowerCase()
  const pkgMgr = profile.packageManager ??
    (profile.osFamily === 'windows' ? 'winget' : profile.osFamily === 'mac' ? 'brew' : 'apt')

  // Not installed — command binary not found
  if (
    exitCode === 127 ||
    combined.includes('is not recognized as') ||
    combined.includes('command not found') ||
    (combined.includes('the term') && combined.includes('is not recognized')) ||
    combined.includes('could not be found') ||
    combined.includes('no such file or directory') && exitCode === 127
  ) {
    return {
      errorType: 'not-installed',
      errorSuggestion: `Tool not found. Install it with: ${pkgMgr} install <package-name>`,
    }
  }

  // Permission denied
  if (
    (exitCode === 5 && profile.osFamily === 'windows') ||
    combined.includes('access is denied') ||
    combined.includes('permission denied') ||
    combined.includes('eacces') ||
    combined.includes('operation not permitted')
  ) {
    const tip = profile.isAdmin
      ? 'Already running as admin — check file ownership.'
      : profile.osFamily === 'windows' ? 'Run as Administrator.' : 'Try prepending sudo.'
    return { errorType: 'permission-denied', errorSuggestion: `Permission denied. ${tip}` }
  }

  // File/directory not found (different from command not found)
  if (
    combined.includes('the system cannot find the file specified') ||
    combined.includes('no such file or directory') ||
    (exitCode === 2 && profile.osFamily === 'windows' && !combined.includes('command'))
  ) {
    return {
      errorType: 'not-found',
      errorSuggestion: 'File or directory not found. Verify the path with find_file or list_directory first.',
    }
  }

  // Shell syntax error
  if (
    combined.includes('unexpected token') ||
    combined.includes('syntax error') ||
    combined.includes('parse error') ||
    combined.includes('missing closing') ||
    combined.includes('unexpected end of file')
  ) {
    return {
      errorType: 'syntax-error',
      errorSuggestion: `Shell syntax error. Check the command syntax for ${profile.shell.name}.`,
    }
  }

  return { errorType: 'unknown', errorSuggestion: '' }
}

function resolveWorkingDir(workingDir?: string): string {
  let raw = workingDir || homedir()

  // Expand ~ to home directory (path.resolve doesn't do this on all platforms)
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = homedir() + raw.slice(1)
  }

  // Normalize path separators to the OS convention
  raw = path.normalize(raw)

  const resolved = path.resolve(raw)

  for (const pattern of BLOCKED_WORKING_DIRS) {
    if (pattern.test(resolved)) {
      throw new Error(`Working directory "${resolved}" is a protected system directory.`)
    }
  }

  const allowed = getAllowedDirs()
  const isAllowed = allowed.some(d => resolved === path.normalize(d) || resolved.startsWith(path.normalize(d) + path.sep))
  if (!isAllowed) {
    throw new Error(`Working directory "${resolved}" is outside your home directory.`)
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Working directory does not exist: "${resolved}"`)
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Working directory path is not a directory: "${resolved}"`)
  }

  return resolved
}

export function formatRunCommandResult(r: RunCommandResult): string {
  const lines: string[] = [
    `Command: ${r.command}`,
    `Exit code: ${r.exitCode}  Duration: ${r.durationMs}ms`,
    '─'.repeat(60),
  ]

  if (r.timedOut) lines.push('[TIMED OUT — command was killed. Increase timeout_ms or narrow the command.]')

  if (r.stdout.trim()) lines.push(r.stdout.trimEnd())
  if (r.stderr.trim()) lines.push(`STDERR: ${r.stderr.trimEnd()}`)
  if (!r.stdout.trim() && !r.stderr.trim()) lines.push('(no output)')

  if (r.errorType !== 'success' && r.errorType !== 'unknown' && r.errorSuggestion) {
    lines.push(`\n[${r.errorType.toUpperCase()}] ${r.errorSuggestion}`)
  }

  return lines.join('\n')
}

export const commandToolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: [
        'Run a shell command on the user\'s computer and return the output.',
        'READ-ONLY commands (Get-Content, dir, ls, cat, git status, python --version, npm list, etc.) run AUTOMATICALLY without asking the user.',
        'WRITE/EXECUTE commands (running scripts, npm install, writing files via shell) ask the user once before running.',
        'Use this to: run Python/Node scripts, check versions, query system info, run npm/pip commands.',
        'Do NOT use this to read or edit files — use read_file and write_file instead (they are safer and faster).',
        'On Windows, use PowerShell syntax. On Mac/Linux, use bash syntax.',
        'ALWAYS include non-interactive flags: --yes, -y, --no-input, --quiet to prevent hanging.',
        'Never run commands that delete files, shutdown the system, or pipe into a shell.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute. Use PowerShell syntax on Windows. Include non-interactive flags.',
          },
          working_dir: {
            type: 'string',
            description: 'Absolute path to run the command in (default: user home directory).',
          },
          timeout_ms: {
            type: 'number',
            description: 'Max milliseconds to wait before killing the command (default: 30000, max: 300000). Increase for slow operations like npm install.',
          },
          background: {
            type: 'boolean',
            description: 'Run the command in the background and return immediately with the process PID. Use for long-running processes: dev servers, build watchers, etc. Default: false.',
          },
        },
        required: ['command'],
      },
    },
  },
]

// ─── Background execution ─────────────────────────────────────────────────────

export interface BackgroundCommandResult {
  pid: number
  command: string
  workingDir: string
}

export function executeRunCommandBackground(
  command: string,
  workingDir?: string,
): BackgroundCommandResult {
  const resolvedDir = resolveWorkingDir(workingDir)

  for (const pattern of BLACKLISTED_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`Command blocked: "${pattern.source}"`)
    }
  }

  const profile = getPlatformProfile()
  const { bin, invokeArgs, utf8Prefix } = profile.shell

  const child = spawn(bin, [...invokeArgs, utf8Prefix + command], {
    cwd: resolvedDir,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  return { pid: child.pid!, command, workingDir: resolvedDir }
}

export function formatBackgroundCommandResult(r: BackgroundCommandResult): string {
  return `Started in background: ${r.command}\nPID: ${r.pid}  Directory: ${r.workingDir}`
}
