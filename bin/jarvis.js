#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// 1. Load .env first (synchronous, before any other module reads process.env)
const dotenv = require('dotenv')
dotenv.config({ path: join(root, '.env'), override: true })

// 2. Inject API keys from ~/.unclawned/config.json into process.env
const { injectConfigIntoEnv } = await import(pathToFileURL(join(root, 'dist/lib/user-config.js')).href)
injectConfigIntoEnv()

// 3. Run the CLI in this same process (no subprocess needed)
await import(pathToFileURL(join(root, 'dist/cli.js')).href)
