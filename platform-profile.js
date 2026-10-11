import { execFileSync } from 'child_process';
import { homedir as osHomedir, arch as nodeArch } from 'os';
import fs from 'fs';
import path from 'path';
import { getSpecialFolders } from './special-folders.js';
// ─── Singleton ────────────────────────────────────────────────────────────────
let _profile = null;
/** Returns the cached profile, building it on first call (synchronous). */
export function getPlatformProfile() {
    if (!_profile)
        _profile = buildProfile();
    return _profile;
}
/** Clears the cache — useful for testing. */
export function resetPlatformProfile() {
    _profile = null;
}
// ─── Profile builder ──────────────────────────────────────────────────────────
function buildProfile() {
    const osFamily = detectOsFamily();
    const homeDir = osHomedir();
    const arch = nodeArch();
    const osVersion = safe(() => detectOsVersion(osFamily), 'unknown');
    const shell = detectShell(osFamily);
    const isAdmin = safe(() => detectIsAdmin(osFamily), false);
    const runtimes = detectRuntimes(osFamily);
    const pkgManager = safe(() => detectPackageManager(osFamily), null);
    const isWsl = detectIsWsl(osFamily);
    // getSpecialFolders() queries the Windows Shell API (same source as Explorer),
    // so this is always the real Desktop regardless of OneDrive or other redirects.
    const desktopPath = safe(() => getSpecialFolders().Desktop, path.join(homeDir, 'Desktop'));
    let needsBypass = false;
    if (osFamily === 'windows' && shell.name !== 'cmd') {
        needsBypass = safe(() => checkExecutionPolicyRestricted(shell), false);
        if (needsBypass) {
            shell.invokeArgs = ['-ExecutionPolicy', 'Bypass', ...shell.invokeArgs];
        }
    }
    return {
        osFamily,
        osVersion,
        arch,
        homeDir,
        desktopPath,
        pathSep: osFamily === 'windows' ? '\\' : '/',
        lineEnding: osFamily === 'windows' ? '\r\n' : '\n',
        shell,
        isAdmin,
        isWsl,
        installedRuntimes: runtimes,
        packageManager: pkgManager,
        needsExecutionPolicyBypass: needsBypass,
    };
}
// ─── OS family ────────────────────────────────────────────────────────────────
function detectOsFamily() {
    if (process.platform === 'win32')
        return 'windows';
    if (process.platform === 'darwin')
        return 'mac';
    return 'linux';
}
function detectIsWsl(osFamily) {
    if (osFamily !== 'linux')
        return false;
    try {
        const version = fs.readFileSync('/proc/version', 'utf-8');
        return version.toLowerCase().includes('microsoft');
    }
    catch {
        return false;
    }
}
// ─── OS version string ────────────────────────────────────────────────────────
function detectOsVersion(osFamily) {
    if (osFamily === 'windows') {
        const raw = run('cmd', ['/c', 'ver']);
        // "Microsoft Windows [Version 10.0.22631.4391]"
        const m = raw.match(/\[Version\s+([\d.]+)\]/);
        if (!m)
            return 'Windows';
        const [, full] = m;
        const buildNum = parseInt(full.split('.')[2] ?? '0', 10);
        return buildNum >= 22000 ? `Windows 11 (${full})` : `Windows 10 (${full})`;
    }
    if (osFamily === 'mac') {
        const version = run('sw_vers', ['-productVersion']).trim();
        const name = run('sw_vers', ['-productName']).trim();
        return `${name} ${version}`;
    }
    // Linux
    try {
        const release = fs.readFileSync('/etc/os-release', 'utf-8');
        const m = release.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
        if (m)
            return m[1];
    }
    catch { }
    return safe(() => run('uname', ['-sr']).trim(), 'Linux');
}
// ─── Shell detection ──────────────────────────────────────────────────────────
function detectShell(osFamily) {
    return osFamily === 'windows' ? detectWindowsShell() : detectUnixShell();
}
function detectWindowsShell() {
    // Prefer PS7 (pwsh) → PS5 (powershell) → cmd
    const ps7 = safe(() => {
        const out = run('pwsh', ['--version']);
        const version = out.match(/PowerShell\s+([\d.]+)/i)?.[1] ?? '7.x';
        return { version };
    }, null);
    if (ps7) {
        return {
            bin: 'pwsh',
            name: 'pwsh',
            version: ps7.version,
            invokeArgs: ['-NonInteractive', '-NoProfile', '-Command'],
            utf8Prefix: '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ',
        };
    }
    const ps5 = safe(() => {
        const out = run('powershell', [
            '-NonInteractive', '-NoProfile', '-Command',
            '$PSVersionTable.PSVersion.ToString()',
        ]);
        const version = out.trim().split('.').slice(0, 2).join('.') || '5.x';
        return { version };
    }, null);
    if (ps5) {
        return {
            bin: 'powershell',
            name: 'powershell',
            version: ps5.version,
            invokeArgs: ['-NonInteractive', '-NoProfile', '-Command'],
            utf8Prefix: '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ',
        };
    }
    return {
        bin: 'cmd',
        name: 'cmd',
        version: 'unknown',
        invokeArgs: ['/c'],
        utf8Prefix: 'chcp 65001 > nul & ',
    };
}
function detectUnixShell() {
    // Priority: $SHELL env → /bin/zsh → /bin/bash → /bin/sh
    const candidates = [];
    if (process.env.SHELL)
        candidates.push(process.env.SHELL);
    for (const p of ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh']) {
        if (!candidates.includes(p))
            candidates.push(p);
    }
    for (const bin of candidates) {
        if (!fs.existsSync(bin))
            continue;
        const name = path.basename(bin);
        const version = safe(() => {
            const out = run(bin, ['--version']);
            const m = out.match(/([\d]+\.[\d]+\.?[\d]*)/);
            return m?.[1] ?? 'unknown';
        }, 'unknown');
        return {
            bin,
            name: (name === 'zsh' || name === 'bash' ? name : 'sh'),
            version,
            invokeArgs: ['-c'],
            utf8Prefix: '', // UTF-8 is default on modern Mac/Linux; suppress color with TERM=dumb
        };
    }
    return { bin: '/bin/sh', name: 'sh', version: 'unknown', invokeArgs: ['-c'], utf8Prefix: '' };
}
// ─── Admin / root ─────────────────────────────────────────────────────────────
function detectIsAdmin(osFamily) {
    if (osFamily === 'windows') {
        try {
            run('net', ['session']);
            return true;
        }
        catch {
            return false;
        }
    }
    return safe(() => run('id', ['-u']).trim() === '0', false);
}
// ─── Installed runtimes ───────────────────────────────────────────────────────
// Extra directories checked on Mac when 'which' fails
const MAC_EXTRA_DIRS = [
    '/opt/homebrew/bin', // Apple Silicon Homebrew
    '/usr/local/bin', // Intel Mac Homebrew / manual installs
];
const RUNTIME_SPECS = [
    { key: 'node', bins: ['node'], versionFlag: '--version', versionRe: /v?([\d.]+)/ },
    { key: 'npm', bins: ['npm'], versionFlag: '--version', versionRe: /([\d.]+)/ },
    { key: 'npx', bins: ['npx'], versionFlag: '--version', versionRe: /([\d.]+)/ },
    { key: 'python3', bins: ['python3', 'python'], versionFlag: '--version', versionRe: /Python\s+([\d.]+)/i },
    { key: 'git', bins: ['git'], versionFlag: '--version', versionRe: /git version\s+([\d.]+)/i },
    { key: 'bun', bins: ['bun'], versionFlag: '--version', versionRe: /([\d.]+)/ },
    { key: 'deno', bins: ['deno'], versionFlag: '--version', versionRe: /deno\s+([\d.]+)/i },
];
function detectRuntimes(osFamily) {
    const found = {};
    const findCmd = osFamily === 'windows' ? 'where' : 'which';
    for (const spec of RUNTIME_SPECS) {
        if (found[spec.key])
            continue;
        for (const bin of spec.bins) {
            const info = tryLocateRuntime(bin, spec.versionFlag, spec.versionRe, findCmd, osFamily);
            if (info) {
                found[spec.key] = info;
                break;
            }
        }
    }
    // On Mac, also try nvm and volta paths for node if not found via 'which'
    if (osFamily === 'mac' && !found.node) {
        const info = tryNvmNode();
        if (info)
            found.node = info;
    }
    return found;
}
function tryLocateRuntime(bin, versionFlag, versionRe, findCmd, osFamily) {
    let binPath = null;
    // Try OS lookup first
    binPath = safe(() => {
        const out = run(findCmd, [bin]);
        const p = out.split('\n')[0].trim();
        return (p && fs.existsSync(p)) ? p : null;
    }, null);
    // Mac: check extra dirs when 'which' finds nothing
    if (!binPath && osFamily === 'mac') {
        for (const dir of MAC_EXTRA_DIRS) {
            const candidate = path.join(dir, bin);
            if (fs.existsSync(candidate)) {
                binPath = candidate;
                break;
            }
        }
    }
    if (!binPath)
        return null;
    // Try direct execFile first
    let version = safe(() => {
        const out = run(binPath, [versionFlag]);
        return parseVersion(out, versionRe);
    }, null);
    // Windows fallback: .cmd/.ps1 scripts can't be executed directly by execFile
    // Use cmd /c to let the shell resolve the script extension
    if (!version && osFamily === 'windows') {
        version = safe(() => {
            const out = run('cmd', ['/c', bin, versionFlag]);
            return parseVersion(out, versionRe);
        }, null);
    }
    return { path: binPath, version: version ?? 'unknown' };
}
function parseVersion(output, re) {
    const m = output.trim().match(re);
    if (!m)
        return null;
    // Strip trailing dots (e.g. "2.44.0." → "2.44.0")
    return m[1].replace(/\.$/, '');
}
function tryNvmNode() {
    const nvmDir = path.join(osHomedir(), '.nvm', 'versions', 'node');
    if (!fs.existsSync(nvmDir))
        return null;
    // Find the highest version directory
    const dirs = safe(() => fs.readdirSync(nvmDir).filter(d => d.startsWith('v')), []);
    if (!dirs.length)
        return null;
    dirs.sort((a, b) => {
        const parse = (v) => v.replace('v', '').split('.').map(Number);
        const [aMaj, aMin, aPatch] = parse(a);
        const [bMaj, bMin, bPatch] = parse(b);
        return bMaj - aMaj || bMin - aMin || bPatch - aPatch;
    });
    for (const dir of dirs) {
        const nodePath = path.join(nvmDir, dir, 'bin', 'node');
        if (fs.existsSync(nodePath)) {
            const version = safe(() => run(nodePath, ['--version']).match(/v?([\d.]+)/)?.[1] ?? 'unknown', 'unknown');
            return { path: nodePath, version };
        }
    }
    return null;
}
// ─── Package manager ──────────────────────────────────────────────────────────
function detectPackageManager(osFamily) {
    if (osFamily === 'windows') {
        for (const [cmd, args] of [['winget', ['--version']], ['choco', ['--version']], ['scoop', ['--version']]]) {
            if (safe(() => { run(cmd, args); return true; }, false))
                return cmd;
        }
        return null;
    }
    if (osFamily === 'mac') {
        return safe(() => { run('brew', ['--version']); return 'brew'; }, null);
    }
    // Linux: check by binary existence
    for (const [bin, cmd] of [
        ['/usr/bin/apt', 'apt'],
        ['/usr/bin/apt-get', 'apt-get'],
        ['/usr/bin/dnf', 'dnf'],
        ['/usr/bin/pacman', 'pacman'],
        ['/usr/bin/zypper', 'zypper'],
        ['/sbin/apk', 'apk'],
    ]) {
        if (fs.existsSync(bin))
            return cmd;
    }
    return null;
}
// ─── Execution policy (Windows only) ─────────────────────────────────────────
function checkExecutionPolicyRestricted(shell) {
    const policy = run(shell.bin, [...shell.invokeArgs, 'Get-ExecutionPolicy']).trim().toLowerCase();
    return policy === 'restricted' || policy === 'allsigned';
}
// ─── Low-level exec helper ────────────────────────────────────────────────────
function run(bin, args, timeoutMs = 4000) {
    return execFileSync(bin, args, {
        timeout: timeoutMs,
        encoding: 'utf-8',
        env: process.env,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
}
function safe(fn, fallback) {
    try {
        return fn();
    }
    catch {
        return fallback;
    }
}
// ─── System prompt summary ────────────────────────────────────────────────────
export function getPlatformSummary() {
    const p = getPlatformProfile();
    const isWin = p.osFamily === 'windows';
    const shellLabel = p.shell.name === 'pwsh' ? `PowerShell 7 (pwsh)` :
        p.shell.name === 'powershell' ? `Windows PowerShell 5 (powershell)` :
            p.shell.name === 'cmd' ? `cmd.exe` :
                `${p.shell.name}`;
    // Runtime list: key version (path) — include path only if non-standard
    const runtimeLines = Object.entries(p.installedRuntimes)
        .filter(([, info]) => info != null)
        .map(([key, info]) => `${key} ${info.version} (${info.path})`);
    const runtimeSummary = runtimeLines.length ? runtimeLines.join(', ') : 'none detected';
    const pathSep = isWin ? '\\' : '/';
    const lineEnding = isWin ? 'CRLF (\\r\\n)' : 'LF (\\n)';
    // Hard syntax rules — the most critical part of the injection
    const syntaxRules = isWin ? [
        'ALWAYS use PowerShell syntax. NEVER use bash/POSIX syntax.',
        'Chain commands with semicolons (;) — NOT with && (PowerShell 5 does not support &&).',
        'File content: Get-Content (not cat). Directory listing: Get-ChildItem (not ls).',
        'Pattern search: Select-String (not grep). Conditions: Where-Object, ForEach-Object.',
        `Paths: use forward slashes or double-backslashes — ${p.homeDir.replace(/\\/g, '/')} or ${p.homeDir.replace(/\\/g, '\\\\')}`,
    ] : [
        'ALWAYS use POSIX syntax. NEVER use PowerShell syntax.',
        'Chain commands with && or ;. File content: cat. Directory listing: ls.',
        'Pattern search: grep. Conditions: test / [ ] / if statements.',
        `Paths use forward slashes. Home dir: ${p.homeDir}`,
        p.installedRuntimes.python3 ? `Use 'python3' (not 'python') for Python scripts.` : '',
    ].filter(Boolean);
    const pkgHint = p.packageManager
        ? `Package manager: ${p.packageManager}`
        : 'Package manager: none detected';
    const adminLine = p.isAdmin ? 'Privilege: admin / root' : 'Privilege: standard user (no admin)';
    const lines = [
        `USER'S LOCAL MACHINE:`,
        `OS: ${p.osVersion} (${p.arch})${p.isWsl ? ' — running inside WSL (Windows Subsystem for Linux)' : ''}`,
        `Shell: ${shellLabel} at ${p.shell.bin}`,
        `Home: ${p.homeDir}`,
        `Desktop: ${p.desktopPath}`,
        `Path separator: ${pathSep}   Line endings: ${lineEnding}`,
        `Installed runtimes: ${runtimeSummary}`,
        pkgHint,
        adminLine,
        ...(p.needsExecutionPolicyBypass ? ['Note: -ExecutionPolicy Bypass applied to every PS command'] : []),
        '',
        ...syntaxRules,
    ];
    return lines.join('\n');
}
