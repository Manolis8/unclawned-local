#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// 1. Load .env first so OPENCLAW_GATEWAY_TOKEN and all other env vars are present
//    before the MCP server or any imported module reads process.env
const dotenv = require('dotenv')
dotenv.config({ path: join(root, '.env'), override: true })

// 2. Inject API keys from ~/.unclawned/config.json
const { injectConfigIntoEnv } = await import(pathToFileURL(join(root, 'dist/lib/user-config.js')).href)
injectConfigIntoEnv()

// 3. Start the MCP server
await import(pathToFileURL(join(root, 'dist/mcp-server.js')).href)
