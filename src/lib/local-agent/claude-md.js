import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
const HOME = homedir();
export const UNCLAWNED_DIR = path.join(HOME, '.unclawned');
export const GLOBAL_MD_PATH = path.join(UNCLAWNED_DIR, 'UNCLAWNED.md');
// ─── Starter template ─────────────────────────────────────────────────────────
// Written once to ~/.unclawned/UNCLAWNED.md on first run.
// The user edits this to customise agent behaviour globally.
const STARTER_TEMPLATE = `# My Unclawned Instructions

This file is read by the Unclawned agent before every task.
Edit it to set personal rules, preferences, and project conventions.

## General behaviour
- Be concise and direct — skip unnecessary explanations
- Ask before making large or irreversible changes if the scope is unclear
- Prefer editing existing files over creating new ones

## How to use this file
- Add any rule as a plain English bullet point
- Create a UNCLAWNED.md inside a project folder for project-specific rules
  (the agent reads both — project rules take priority)
- Create UNCLAWNED.local.md for rules you don't want to commit to git

## Example rules you might add
- "My projects live in ~/code/ — check there first"
- "Always use TypeScript, never plain JavaScript"
- "Use pnpm, not npm or yarn"
- "Tests go in __tests__/, not spec/"
`.trim();
// ─── Auto-create global config on first run ───────────────────────────────────
function ensureGlobalConfig() {
    try {
        if (!fs.existsSync(UNCLAWNED_DIR)) {
            fs.mkdirSync(UNCLAWNED_DIR, { recursive: true });
        }
        if (!fs.existsSync(GLOBAL_MD_PATH)) {
            fs.writeFileSync(GLOBAL_MD_PATH, STARTER_TEMPLATE, 'utf-8');
        }
    }
    catch { /* never crash if home dir is read-only */ }
}
// ─── Main loader ──────────────────────────────────────────────────────────────
// Lookup order (matches how Claude Code reads its CLAUDE.md, but for our files):
//   1. ~/.unclawned/UNCLAWNED.md     — global user instructions (primary)
//   2. Walk from home → projectDir   — project-level UNCLAWNED.md / UNCLAWNED.local.md
//   3. Same walk, CLAUDE.md fallback — silent compat for users who already have CC set up
export function loadClaudeMdFiles(projectDir) {
    ensureGlobalConfig();
    const sections = [];
    const seen = new Set();
    function tryRead(filePath, label) {
        const abs = path.resolve(filePath);
        if (seen.has(abs))
            return;
        seen.add(abs);
        try {
            if (!fs.existsSync(abs))
                return;
            const content = fs.readFileSync(abs, 'utf-8').trim();
            if (content)
                sections.push(`<!-- ${label} -->\n${content}`);
        }
        catch { /* skip unreadable files */ }
    }
    // 1. Global: ~/.unclawned/UNCLAWNED.md
    tryRead(GLOBAL_MD_PATH, '~/.unclawned/UNCLAWNED.md');
    // 2 + 3. Walk ancestor dirs from home (or projectDir) and collect per-project files.
    //        Reverse so root comes first (lower priority) and leaf comes last (higher priority).
    const start = projectDir ? path.resolve(projectDir) : HOME;
    const dirs = [];
    let dir = start;
    while (true) {
        dirs.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir || dir === HOME)
            break;
        dir = parent;
    }
    for (const d of dirs.reverse()) {
        const rel = d === HOME ? '~' : `~/${path.relative(HOME, d).replace(/\\/g, '/')}`;
        // Primary: our own files
        tryRead(path.join(d, 'UNCLAWNED.md'), `${rel}/UNCLAWNED.md`);
        tryRead(path.join(d, 'UNCLAWNED.local.md'), `${rel}/UNCLAWNED.local.md`);
        // Silent fallback: CLAUDE.md files (CC users get their rules applied here too)
        tryRead(path.join(d, 'CLAUDE.md'), `${rel}/CLAUDE.md`);
        tryRead(path.join(d, 'CLAUDE.local.md'), `${rel}/CLAUDE.local.md`);
    }
    return sections.length > 0 ? sections.join('\n\n') : null;
}
