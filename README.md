# Unclawned (local CLI)

> **Status: not finished.** It works, but with a lot of bugs. Simple browser tasks usually succeed; long or complex tasks often fail or get stuck. Treat this as an experiment, not a finished product.

Unclawned is a local AI agent you talk to in your terminal. You tell it what to do ("open LinkedIn and draft a post about X", "find the cheapest flight on this page") and it does it **in your real Chrome browser**, with your logged-in sessions, through a small Chrome extension.

It started as a fork of [OpenClaw](https://github.com/openclaw/openclaw) (see `OPENCLAW_ATTRIBUTION.md`) and was turned from a hosted backend into a CLI that runs entirely on your own computer.

## How the pieces fit together

```
 You (terminal)                Chrome
      │                           ▲
      ▼                           │  clicks, typing, page reads
 ┌──────────────┐   WebSocket   ┌─┴──────────────────┐
 │ Unclawned CLI│ ◄───────────► │ Unclawned extension │
 │ (this repo)  │  localhost    │ (felo-extension)    │
 └──────┬───────┘               └─────────────────────┘
        │
        ▼
  AI provider (OpenAI / xAI / Anthropic, your own API key)
```

- **The CLI (this repo)** runs the AI agent. It listens on `ws://localhost:3001/extension` (change with `CLI_PORT`).
- **The extension** ([Manolis8/felo-extension](https://github.com/Manolis8/felo-extension)) connects to that address and gives the CLI control of your Chrome tabs using Chrome's debugger API. **Without the extension, browser tasks don't work.**
- There is also an **MCP bridge mode** (`bin/mcp-bridge.js`) that exposes the same browser tools to any MCP-capable agent (Claude Code, Hermes, etc.). That mode listens on port `3011`, which is the extension's default address.

Everything is stored locally in `~/.unclawned/` (API keys in `config.json`, memory and skills in SQLite). Nothing is sent anywhere except to the AI provider you choose.

## Requirements

- **Node.js 22.7 or newer** (it uses the built-in `node:sqlite`, so you'll see an `ExperimentalWarning: SQLite` line on start; that's normal)
- **Google Chrome**
- An API key from at least one of: OpenAI, xAI (Grok), or Anthropic

## Install

```bash
git clone https://github.com/Manolis8/unclawned-local.git
cd unclawned-local
npm install
npm run build
```

Use `npm`, not `pnpm`: `package-lock.json` is the lockfile that's kept up to date.

Optional: create a `.env` file in the project folder. You only need it to change defaults:

```bash
# .env  (never commit this file)
CLI_PORT=3001                       # port the extension connects to
OPENCLAW_GATEWAY_TOKEN=any-long-random-string   # signs the local browser relay (auto-generated if unset)
UNCLAWNED_RELAY_PORT=18792          # change if you run two copies at once
```

## Install the Chrome extension

1. Clone [Manolis8/felo-extension](https://github.com/Manolis8/felo-extension).
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the cloned folder.
3. Pin the extension (puzzle icon in the toolbar).
4. That's it. The extension connects to `ws://localhost:3001` by default. If you changed `CLI_PORT`, or use MCP bridge mode (port `3011`), right-click the extension icon → **Options** and change the address.

## Run

```bash
npm start          # runs the built CLI (bin/jarvis.js)
```

The first run starts a short setup wizard that asks for your API key and saves it to `~/.unclawned/config.json`. Then just type what you want done.

Useful commands:

| Command | What it does |
|---|---|
| `npm start` | Start the agent |
| `node bin/jarvis.js set_api` | Add or change an API key |
| `node bin/jarvis.js models` | Pick which model handles which kind of task |
| `node bin/mcp-bridge.js` | Run as an MCP server instead of an interactive CLI |

If you run `npm link` once in the project folder, you can type `jarvis` instead of `node bin/jarvis.js`.

## Check that it works

1. Start the CLI with `npm start`.
2. Open Chrome with the extension loaded. Its badge should briefly show `…` and then the CLI should report that the extension connected.
3. Ask something simple, like `open wikipedia.org and search for Node.js`. You should see Chrome do it.

If the extension never connects, check that the address in its Options matches `CLI_PORT`, and that nothing else is using that port.

Tested on Windows 11 with Node 24: a fresh clone installs, builds, connects to the extension, and completes tasks like "open wikipedia.org, search for Node.js, and tell me the first sentence of the article".

Also tested on Linux with Node 22 (Oct 2026): a fresh clone installs with `npm install`, builds, the extension connects, and the browser tools navigate, read, type into and click on a page. That run had no AI key, so the full agent loop wasn't exercised there.

### Test the browser control without an API key

MCP bridge mode lets you check the extension link without paying for any AI calls:

```bash
HERMES_LIVE_CHROME_PORT=3001 node bin/mcp-bridge.js
```

With port `3001` the extension connects without changing its Options. Then point any MCP client at it (for example `claude mcp add unclawned -e HERMES_LIVE_CHROME_PORT=3001 -- node /path/to/unclawned-local/bin/mcp-bridge.js`) and call `browser_navigate`, `browser_snapshot`, `browser_type` and `browser_click`.

## Known problems

- Complex multi-step tasks often fail halfway or loop.
- Some sites block the debugger-based control or change layout and confuse the agent.
- A lot of leftover code from OpenClaw (channels, gateway, tests) is still in `src/` and not all of it is used.
- The planning documents in `docs/plans/` describe where the project was heading, not what currently works.
- `railway.json` and `nixpacks.toml` are left over from the old hosted version and aren't used by the local CLI.
- Some `src/` folders contain old compiled `.js` files next to the `.ts` sources. The build only uses the `.ts` files.

## Project layout

```
bin/            entry points (jarvis.js = CLI, mcp-bridge.js = MCP server)
src/cli.ts      the interactive CLI
src/setup.ts    first-run setup wizard
src/lib/        agent loop, memory, skills, extension connection
src/browser/    browser control (Playwright over the extension relay)
gateway/        optional Cloudflare Worker for web search (not required)
docs/plans/     design notes
```

## Security

- Never commit `.env` or `~/.unclawned/config.json`. Both are ignored by git.
- The extension can control any tab in your browser. Only run it with a CLI you trust, on your own machine.
