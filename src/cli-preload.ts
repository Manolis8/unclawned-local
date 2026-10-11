import dotenv from 'dotenv'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { injectConfigIntoEnv } from './lib/user-config.js'

// Load .env from the package root regardless of CWD (so `jarvis` works from any directory).
// This runs first so .env values land in process.env before config.json injection.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: join(packageRoot, '.env'), override: true })

// Inject API keys from ~/.unclawned/config.json into process.env for any key not already set.
// Priority: shell env > .env file > config.json
injectConfigIntoEnv()
