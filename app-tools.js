import { exec, spawn } from 'child_process';
import { validatePath } from './security.js';
// Known app names → their executable / command on each platform
const APP_MAP = {
    'vs code': { win32: 'code', darwin: 'open -a "Visual Studio Code"', linux: 'code' },
    'vscode': { win32: 'code', darwin: 'open -a "Visual Studio Code"', linux: 'code' },
    'notepad': { win32: 'notepad', darwin: 'open -a TextEdit', linux: 'gedit' },
    'textedit': { win32: 'notepad', darwin: 'open -a TextEdit', linux: 'gedit' },
    'explorer': { win32: 'explorer', darwin: 'open .', linux: 'nautilus .' },
    'finder': { win32: 'explorer', darwin: 'open .', linux: 'nautilus .' },
    'excel': { win32: 'start excel', darwin: 'open -a "Microsoft Excel"', linux: 'libreoffice --calc' },
    'word': { win32: 'start winword', darwin: 'open -a "Microsoft Word"', linux: 'libreoffice --writer' },
    'powerpoint': { win32: 'start powerpnt', darwin: 'open -a "Microsoft PowerPoint"', linux: 'libreoffice --impress' },
    'chrome': { win32: 'start chrome', darwin: 'open -a "Google Chrome"', linux: 'google-chrome' },
    'terminal': { win32: 'start cmd', darwin: 'open -a Terminal', linux: 'x-terminal-emulator' },
    'powershell': { win32: 'start powershell', darwin: 'open -a Terminal', linux: 'x-terminal-emulator' },
    'calculator': { win32: 'calc', darwin: 'open -a Calculator', linux: 'gnome-calculator' },
    'calendar': { win32: 'start outlookcal:', darwin: 'open -a Calendar', linux: 'gnome-calendar' },
    'notion': { win32: 'start notion', darwin: 'open -a Notion', linux: 'notion-app' },
    'slack': { win32: 'start slack', darwin: 'open -a Slack', linux: 'slack' },
    'obsidian': { win32: 'start obsidian', darwin: 'open -a Obsidian', linux: 'obsidian' },
};
export function buildOpenAppCommand(app, filePath) {
    const normalizedApp = app.toLowerCase().trim();
    const platform = process.platform;
    const platformKey = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
    // Resolve validated file path if provided
    let resolvedFile = '';
    if (filePath) {
        resolvedFile = validatePath(filePath);
    }
    let command;
    if (APP_MAP[normalizedApp]) {
        const base = APP_MAP[normalizedApp][platformKey];
        command = resolvedFile ? `${base} "${resolvedFile}"` : base;
    }
    else {
        // Unknown app — attempt to launch by name directly
        if (platform === 'win32') {
            command = resolvedFile ? `start "" "${app}" "${resolvedFile}"` : `start "" "${app}"`;
        }
        else if (platform === 'darwin') {
            command = resolvedFile ? `open -a "${app}" "${resolvedFile}"` : `open -a "${app}"`;
        }
        else {
            command = resolvedFile ? `${app} "${resolvedFile}"` : app;
        }
    }
    return { command, resolvedApp: APP_MAP[normalizedApp] ? app : `${app} (unknown — attempting direct launch)` };
}
export async function executeOpenApp(app, filePath) {
    const { command, resolvedApp } = buildOpenAppCommand(app, filePath);
    return new Promise((resolve) => {
        exec(command, { timeout: 10_000 }, (error) => {
            if (error && error.code !== 0) {
                resolve({
                    success: false,
                    app: resolvedApp,
                    command,
                    message: `Could not open "${app}". Make sure it's installed. Error: ${error.message}`,
                });
            }
            else {
                resolve({
                    success: true,
                    app: resolvedApp,
                    command,
                    message: `Opened ${app}${filePath ? ` with ${filePath}` : ''}.`,
                });
            }
        });
    });
}
// ─── Clipboard ────────────────────────────────────────────────────────────────
export async function readClipboard() {
    return new Promise((resolve, reject) => {
        let command;
        if (process.platform === 'win32') {
            // -OutputEncoding UTF8 ensures non-ASCII chars come through correctly
            command = 'powershell.exe -NonInteractive -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard"';
        }
        else if (process.platform === 'darwin') {
            command = 'pbpaste';
        }
        else {
            command = 'xclip -selection clipboard -o';
        }
        exec(command, { timeout: 5000, encoding: 'utf8' }, (error, stdout) => {
            if (error)
                reject(new Error(`Could not read clipboard: ${error.message}`));
            else
                resolve(stdout.trim());
        });
    });
}
export async function writeClipboard(text) {
    return new Promise((resolve, reject) => {
        // Use spawn + stdin for all platforms — avoids shell injection regardless of content
        let proc;
        if (process.platform === 'win32') {
            // PowerShell reads stdin and sets clipboard
            proc = spawn('powershell.exe', [
                '-NonInteractive', '-NoProfile', '-Command',
                '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; [Console]::In.ReadToEnd() | Set-Clipboard',
            ]);
        }
        else if (process.platform === 'darwin') {
            proc = spawn('pbcopy');
        }
        else {
            proc = spawn('xclip', ['-selection', 'clipboard']);
        }
        proc.on('error', (err) => reject(new Error(`Could not write to clipboard: ${err.message}`)));
        proc.on('close', (code) => {
            if (code === 0 || code === null)
                resolve();
            else
                reject(new Error(`Could not write to clipboard (exit code ${code})`));
        });
        proc.stdin.write(text, 'utf-8');
        proc.stdin.end();
    });
}
export const appToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'open_app',
            description: [
                'Open a local application on the user\'s computer, optionally with a specific file.',
                'Works with common apps: VS Code, Excel, Word, Notepad, Chrome, Terminal, Notion, Slack, etc.',
                'Use this at the end of a task to let the user continue working in the right app.',
            ].join(' '),
            parameters: {
                type: 'object',
                properties: {
                    app: {
                        type: 'string',
                        description: 'Name of the app to open. Examples: "VS Code", "Excel", "Notepad", "Chrome", "Terminal", "Notion".',
                    },
                    file: {
                        type: 'string',
                        description: 'Optional: absolute path to a file to open with the app. E.g. open Excel with a specific spreadsheet.',
                    },
                },
                required: ['app'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_clipboard',
            description: 'Read the current contents of the user\'s clipboard. Use when the user says "use what I just copied" or pastes something and you need to access it.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'write_clipboard',
            description: 'Copy text to the user\'s clipboard so they can paste it anywhere. Use when user asks to copy something or after completing research they\'ll want to use manually.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The text to copy to clipboard.' },
                },
                required: ['text'],
            },
        },
    },
];
