import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
// ─── Types ────────────────────────────────────────────────────────────────────
const SNAPSHOT_MAX_BYTES = 1024 * 1024; // 1 MB — store content only below this
const MAX_ENTRIES = 50; // ring buffer cap
// ─── In-memory journal ────────────────────────────────────────────────────────
let _journal = [];
let _idCounter = 0;
// ─── Snapshot ─────────────────────────────────────────────────────────────────
export function takeSnapshot(filePath) {
    if (!fs.existsSync(filePath)) {
        return { contentHash: '', content: null, size: 0, modifiedAt: '', existed: false };
    }
    try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            return { contentHash: '', content: null, size: 0, modifiedAt: stat.mtime.toISOString(), existed: true };
        }
        const buf = fs.readFileSync(filePath);
        const contentHash = crypto.createHash('sha256').update(buf).digest('hex');
        let content = null;
        if (buf.length <= SNAPSHOT_MAX_BYTES) {
            try {
                content = buf.toString('utf-8');
            }
            catch {
                content = null;
            }
        }
        return { contentHash, content, size: buf.length, modifiedAt: stat.mtime.toISOString(), existed: true };
    }
    catch {
        return { contentHash: '', content: null, size: 0, modifiedAt: '', existed: false };
    }
}
// ─── Record ───────────────────────────────────────────────────────────────────
export function addJournalEntry(entry) {
    const id = String(++_idCounter).padStart(4, '0');
    const full = {
        ...entry,
        id,
        timestamp: new Date().toISOString(),
        wasRolledBack: false,
    };
    _journal.push(full);
    if (_journal.length > MAX_ENTRIES)
        _journal = _journal.slice(-MAX_ENTRIES);
}
// ─── Undo helpers ─────────────────────────────────────────────────────────────
function atomicRestoreContent(filePath, content) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.openclaw-undo-${Date.now()}`);
    try {
        fs.writeFileSync(tmp, content, 'utf-8');
        fs.renameSync(tmp, filePath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { }
        throw err;
    }
}
// ─── Undo ─────────────────────────────────────────────────────────────────────
export function undoLastChange(steps = 1) {
    // Collect the last N rollbackable, not-yet-rolled-back entries (newest first)
    const eligible = [..._journal]
        .reverse()
        .filter(e => e.isRollbackable && !e.wasRolledBack)
        .slice(0, steps);
    if (eligible.length === 0) {
        throw new Error('Nothing to undo — no rollbackable operations in this session.');
    }
    const results = [];
    for (const entry of eligible) {
        let message;
        try {
            switch (entry.operation) {
                case 'write': {
                    if (!entry.preSnapshot)
                        throw new Error('No pre-snapshot recorded for this write.');
                    if (!entry.preSnapshot.existed) {
                        // File was newly created — undo by deleting it
                        if (fs.existsSync(entry.targetPath))
                            fs.unlinkSync(entry.targetPath);
                        message = `Deleted newly created file: ${entry.targetPath}`;
                    }
                    else if (entry.preSnapshot.content !== null) {
                        atomicRestoreContent(entry.targetPath, entry.preSnapshot.content);
                        message = `Restored ${entry.targetPath} to previous content (${entry.preSnapshot.size} bytes)`;
                    }
                    else {
                        throw new Error(`Cannot undo: the file was larger than 1 MB before the write — ` +
                            `full content was not snapshotted. Only the hash was recorded.`);
                    }
                    break;
                }
                case 'edit': {
                    if (!entry.preSnapshot?.content) {
                        throw new Error(entry.preSnapshot
                            ? `Cannot undo: file was larger than 1 MB before the edit — content not snapshotted.`
                            : `No pre-snapshot recorded for this edit.`);
                    }
                    atomicRestoreContent(entry.targetPath, entry.preSnapshot.content);
                    message = `Restored ${entry.targetPath} to pre-edit content`;
                    break;
                }
                case 'delete': {
                    const recyclePath = entry.sourcePath;
                    if (!recyclePath)
                        throw new Error('No recycle bin path recorded for this delete.');
                    if (!fs.existsSync(recyclePath)) {
                        throw new Error(`Recycle bin entry no longer exists: ${recyclePath}`);
                    }
                    if (fs.existsSync(entry.targetPath)) {
                        throw new Error(`Cannot restore — something already exists at: ${entry.targetPath}`);
                    }
                    fs.mkdirSync(path.dirname(entry.targetPath), { recursive: true });
                    fs.renameSync(recyclePath, entry.targetPath);
                    message = `Restored deleted item to: ${entry.targetPath}`;
                    break;
                }
                case 'move': {
                    const originalSource = entry.sourcePath;
                    if (!originalSource)
                        throw new Error('No original source path recorded for this move.');
                    if (!fs.existsSync(entry.targetPath)) {
                        throw new Error(`Cannot undo move — file no longer at destination: ${entry.targetPath}`);
                    }
                    if (fs.existsSync(originalSource)) {
                        throw new Error(`Cannot undo move — something already exists at original location: ${originalSource}`);
                    }
                    fs.mkdirSync(path.dirname(originalSource), { recursive: true });
                    fs.renameSync(entry.targetPath, originalSource);
                    message = `Moved back: ${entry.targetPath} → ${originalSource}`;
                    break;
                }
                case 'copy': {
                    if (!fs.existsSync(entry.targetPath)) {
                        message = `Copy at ${entry.targetPath} no longer exists — nothing to delete`;
                    }
                    else {
                        const stat = fs.statSync(entry.targetPath);
                        if (stat.isDirectory()) {
                            fs.rmSync(entry.targetPath, { recursive: true });
                        }
                        else {
                            fs.unlinkSync(entry.targetPath);
                        }
                        message = `Deleted copy at: ${entry.targetPath}`;
                    }
                    break;
                }
                default:
                    throw new Error(`Unknown operation type: ${entry.operation}`);
            }
            entry.wasRolledBack = true;
            results.push({ entry, message });
        }
        catch (err) {
            throw new Error(`Undo failed for "${entry.operation}" on ${entry.targetPath}: ${err.message}`);
        }
    }
    return results;
}
// ─── Called by restore_last_delete so undo_last_change skips the delete ────────
export function markLastDeleteRolledBack(filePath) {
    const resolved = path.resolve(filePath);
    for (let i = _journal.length - 1; i >= 0; i--) {
        const e = _journal[i];
        if (e.operation === 'delete' && path.resolve(e.targetPath) === resolved && !e.wasRolledBack) {
            e.wasRolledBack = true;
            return;
        }
    }
}
// ─── History ──────────────────────────────────────────────────────────────────
export function getHistory(limit = 10) {
    return [..._journal].reverse().slice(0, limit);
}
export function formatHistory(entries) {
    if (entries.length === 0)
        return 'No file operations recorded this session.';
    const lines = ['Session file operations (most recent first):'];
    for (const e of entries) {
        const ts = e.timestamp.slice(11, 19);
        const extra = [
            e.wasRolledBack ? '[undone]' : '',
            !e.isRollbackable ? '[not undoable]' : '',
        ].filter(Boolean).join(' ');
        lines.push(`#${e.id}  [${ts}]  ${e.operation.padEnd(6)}  ${e.targetPath}${extra ? '  ' + extra : ''}`);
        if (e.description)
            lines.push(`         ${e.description}`);
    }
    return lines.join('\n');
}
export function formatUndoResult(results) {
    return results.map(r => `Undone: ${r.message}`).join('\n');
}
// ─── Tool definitions ──────────────────────────────────────────────────────────
export const journalToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'undo_last_change',
            description: [
                'Undo the last file operation performed by the agent this session.',
                'Handles: write (deletes newly created files or restores overwritten content), edit (restores file to pre-edit state), delete (moves file back from recycle bin), move (moves file back to original location), copy (deletes the copy).',
                'Content can only be restored if the file was under 1 MB before the operation — for larger files only the hash was recorded.',
                'This is a safe undo tool and runs automatically without confirmation.',
                'Call show_history first to confirm which operation will be undone.',
            ].join(' '),
            parameters: {
                type: 'object',
                properties: {
                    steps: {
                        type: 'number',
                        description: 'Number of recent operations to undo (default: 1). Operations are undone newest-first.',
                    },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'show_history',
            description: [
                'Show all file operations performed by the agent in this session.',
                'Includes writes, edits, deletes, moves, and copies with timestamps.',
                'Shows whether each operation has already been undone.',
                'Call this before undo_last_change to confirm what will be undone.',
            ].join(' '),
            parameters: {
                type: 'object',
                properties: {
                    limit: {
                        type: 'number',
                        description: 'Maximum number of operations to show (default: 10, max: 50).',
                    },
                },
                required: [],
            },
        },
    },
];
