import readline from 'node:readline';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
const CONFIG_PATH = join(homedir(), '.unclawned', 'config.json');
function loadConfig() {
    if (!existsSync(CONFIG_PATH))
        return {};
    try {
        return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    }
    catch {
        return {};
    }
}
function saveConfig(cfg) {
    mkdirSync(join(homedir(), '.unclawned'), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
async function ask(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}
export async function runFirstTimeSetupIfNeeded() {
    const cfg = loadConfig();
    // Backfill any config values not already in env (catches re-run after partial setup)
    for (const [k, v] of Object.entries(cfg)) {
        if (typeof v === 'string' && !process.env[k])
            process.env[k] = v;
    }
    // Auto-generate gateway token if missing everywhere
    if (!process.env.OPENCLAW_GATEWAY_TOKEN) {
        const token = randomBytes(32).toString('hex');
        process.env.OPENCLAW_GATEWAY_TOKEN = token;
        cfg.OPENCLAW_GATEWAY_TOKEN = token;
        saveConfig(cfg);
    }
    const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
    const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
    if (hasAnthropic && hasOpenAI)
        return;
    console.log('\nWelcome to OpenClaw! First-time setup.');
    console.log('Keys will be saved to ~/.unclawned/config.json\n');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!hasAnthropic) {
        const key = (await ask(rl, 'Anthropic API key (sk-ant-...): ')).trim();
        if (!key) {
            console.error('Anthropic API key is required.');
            process.exit(1);
        }
        process.env.ANTHROPIC_API_KEY = key;
        cfg.ANTHROPIC_API_KEY = key;
    }
    if (!hasOpenAI) {
        const key = (await ask(rl, 'OpenAI API key (sk-...):   ')).trim();
        if (!key) {
            console.error('OpenAI API key is required.');
            process.exit(1);
        }
        process.env.OPENAI_API_KEY = key;
        cfg.OPENAI_API_KEY = key;
    }
    rl.close();
    saveConfig(cfg);
    console.log(`\nConfig saved to ${CONFIG_PATH}`);
    console.log(`\nNext step: make sure Chrome is open with the Jarvis extension installed.`);
    console.log(`If browser automation doesn't work, run: npx playwright install chromium\n`);
}
