#!/usr/bin/env node
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const tsx = join(__dir, '..', 'node_modules', '.bin', 'tsx')
const preload = join(__dir, '..', 'src', 'cli-preload.ts')
const cli = join(__dir, '..', 'src', 'cli.ts')

const proc = spawn(tsx, ['--import', preload, cli], { stdio: 'inherit' })
proc.on('exit', (code) => process.exit(code ?? 0))
