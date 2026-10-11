import fs from 'fs';
import path from 'path';
import { validatePath, formatBytes } from './security.js';
function detectExistingEncoding(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(4);
        const read = fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        if (read >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
            return 'utf-8-bom';
        if (read >= 2 && buf[0] === 0xFF && buf[1] === 0xFE)
            return 'utf-16-le';
        if (read >= 2 && buf[0] === 0xFE && buf[1] === 0xFF)
            return 'utf-16-be';
        return 'utf-8';
    }
    catch {
        return 'unknown';
    }
}
function encodeContent(content, encoding) {
    if (encoding === 'utf-8-bom') {
        return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(content, 'utf-8')]);
    }
    if (encoding === 'utf-16-le') {
        return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(content, 'utf16le')]);
    }
    if (encoding === 'utf-16-be') {
        // Node has no native utf-16-be encoder — encode as LE then swap byte pairs
        const le = Buffer.from(content, 'utf16le');
        for (let i = 0; i < le.length - 1; i += 2) {
            const tmp = le[i];
            le[i] = le[i + 1];
            le[i + 1] = tmp;
        }
        return Buffer.concat([Buffer.from([0xFE, 0xFF]), le]);
    }
    // Default: UTF-8 without BOM
    return Buffer.from(content, 'utf-8');
}
// ─── Atomic write ─────────────────────────────────────────────────────────────
async function renameWithRetry(src, dst, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            fs.renameSync(src, dst);
            return;
        }
        catch (err) {
            if (attempt === retries - 1) {
                throw new Error(`Could not write file — it may be open in another application.\n` +
                    `Close the file and try again. (${err.message})`);
            }
            await new Promise(r => setTimeout(r, 300));
        }
    }
}
async function atomicWrite(resolvedPath, content, encoding) {
    const dir = path.dirname(resolvedPath);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tmpPath = path.join(dir, `.openclaw-tmp-${suffix}`);
    const buf = encodeContent(content, encoding);
    try {
        fs.writeFileSync(tmpPath, buf);
        const stat = fs.statSync(tmpPath);
        if (stat.size !== buf.length) {
            throw new Error(`Write verification failed (expected ${buf.length} bytes, got ${stat.size}).`);
        }
        await renameWithRetry(tmpPath, resolvedPath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { }
        throw err;
    }
}
// ─── Preview ──────────────────────────────────────────────────────────────────
export function previewWriteFile(filePath, content, mode = 'create') {
    const resolved = validatePath(filePath);
    const existedBefore = fs.existsSync(resolved);
    let existingPreview = null;
    if (existedBefore && mode === 'overwrite') {
        try {
            const existing = fs.readFileSync(resolved, 'utf-8');
            const lines = existing.split('\n').slice(0, 10);
            existingPreview = lines.join('\n') + (existing.split('\n').length > 10 ? '\n...' : '');
        }
        catch {
            existingPreview = '(could not read existing file)';
        }
    }
    const contentLines = content.split('\n');
    const contentPreview = contentLines.slice(0, 20).join('\n') +
        (contentLines.length > 20 ? `\n... (${contentLines.length - 20} more lines)` : '');
    return {
        resolvedPath: resolved,
        mode,
        existedBefore,
        existingPreview,
        contentPreview,
        contentLineCount: contentLines.length,
    };
}
// ─── Execute ──────────────────────────────────────────────────────────────────
export async function executeWriteFile(preview, content) {
    const { resolvedPath: resolved, mode, existedBefore } = preview;
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    if (mode === 'create' && existedBefore) {
        throw new Error(`File already exists: "${resolved}". Use mode "overwrite" to replace it or "append" to add to it.`);
    }
    if (mode === 'append') {
        // Append cannot use atomic rename efficiently — use appendFileSync directly
        fs.appendFileSync(resolved, content, 'utf-8');
    }
    else {
        // create or overwrite — use atomic temp-file-then-rename
        const encoding = (mode === 'overwrite' && existedBefore)
            ? detectExistingEncoding(resolved)
            : 'utf-8';
        await atomicWrite(resolved, content, encoding === 'unknown' ? 'utf-8' : encoding);
    }
    return {
        resolvedPath: resolved,
        bytesWritten: Buffer.byteLength(content, 'utf-8'),
        mode,
        existedBefore,
    };
}
export function formatWriteFileResult(r) {
    const action = r.mode === 'append' ? 'Appended to' : r.existedBefore ? 'Overwrote' : 'Created';
    return `${action}: ${r.resolvedPath} (${formatBytes(r.bytesWritten)})`;
}
export function executeCreateDirectory(dirPath) {
    const resolved = validatePath(dirPath);
    if (fs.existsSync(resolved)) {
        if (!fs.statSync(resolved).isDirectory()) {
            throw new Error(`Path exists but is a file, not a directory: ${resolved}`);
        }
        return { resolvedPath: resolved, alreadyExisted: true };
    }
    fs.mkdirSync(resolved, { recursive: true });
    return { resolvedPath: resolved, alreadyExisted: false };
}
export function formatCreateDirectoryResult(r) {
    return r.alreadyExisted
        ? `Directory already exists: ${r.resolvedPath}`
        : `Created directory: ${r.resolvedPath}`;
}
export const writeToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'create_directory',
            description: [
                'Create a new directory (folder) on the user\'s computer.',
                'Automatically creates all missing intermediate parent directories.',
                'Safe to call even if the directory already exists — reports the path without error.',
                'This is a T0 (auto) operation — no confirmation needed since it is non-destructive.',
            ].join(' '),
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute path of the directory to create.',
                    },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_file',
            description: [
                'Write content to a file on the user\'s local computer.',
                'ALWAYS call confirm_action before writing — this tool triggers the approval flow automatically.',
                'Use create mode for new files, overwrite to replace, append to add to the end.',
                'The user will see a preview of exactly what will be written before it happens.',
                'Writes use atomic temp-file-then-rename — the file is never left half-written.',
                'Overwrite preserves the existing file\'s encoding (UTF-8, UTF-16, etc.).',
            ].join(' '),
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute path where the file will be written. Use the full path including filename and extension.',
                    },
                    content: {
                        type: 'string',
                        description: 'The full text content to write to the file.',
                    },
                    mode: {
                        type: 'string',
                        enum: ['create', 'overwrite', 'append'],
                        description: 'create = new file (fails if exists), overwrite = replace existing, append = add to end. Default: create.',
                    },
                },
                required: ['path', 'content'],
            },
        },
    },
];
