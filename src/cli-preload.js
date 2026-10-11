import dotenv from 'dotenv';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
// Load .env from the package root regardless of CWD (fixes `jarvis` run from any directory)
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(packageRoot, '.env'), override: true });
// Load ~/.unclawned/config.json — fills in any keys not already set by .env
const configPath = join(homedir(), '.unclawned', 'config.json');
if (existsSync(configPath)) {
    try {
        const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
        for (const [key, value] of Object.entries(cfg)) {
            if (typeof value === 'string' && !process.env[key]) {
                process.env[key] = value;
            }
        }
    }
    catch { }
}
