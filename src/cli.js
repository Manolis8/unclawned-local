import { createServer } from 'http';
import readline from 'node:readline';
import { orchestrateTask } from './lib/agents/orchestrator.js';
import { runAgentWithExtension, closeAllBrowserConnections, getOpenTabs, getLastUsedTab, wasLastAgentRunSuccessful, getStandingPermissionSuggestion, clearStandingPermissionSuggestion } from './lib/agent-extension.js';
import { handleConfirmationRequest } from './lib/cli-confirmation.js';
import { executeHybridTask } from './lib/hybrid-executor.js';
import { extensionConnections } from './lib/extension-state.js';
import { startExtensionWsServer } from './lib/extension-ws-server.js';
import { runTaskInBackground } from './routes/tasks.js';
import { runFirstTimeSetupIfNeeded } from './lib/first-run.js';
import { db } from './lib/db.js';
import { WebSocket } from 'ws';
import { runSkillCreator, listSkills, runSavedSkill, runSkillEditor, collectRuntimeVars, runSkillDelete } from './lib/cli-skill-creator.js';
import { searchSkillsForTask, buildAttachedSkillsContext, resolveSkillByName, getRecentGapEvents, checkGapProposals, getAttachedSkillVariables } from './lib/skill-index.js';
import { extractEntities, resolveReferences, buildContinuationContext } from './lib/conversation-state.js';
import { acquireCliLock } from './lib/process-lock.js';
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PLATFORM_NAMES = {
    linkedin: 'LinkedIn', twitter: 'Twitter', instagram: 'Instagram',
    facebook: 'Facebook', 'x.com': 'X'
};
async function extractPostContent(chatResponse) {
    try {
        const res = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            max_tokens: 500,
            messages: [
                { role: 'system', content: 'Extract only the social media post content from this text. Return ONLY the post body — remove any intro phrase ("Here is your post:", "Sure! Here\'s a suggestion:", "Absolutely!"), any sign-off ("Feel free to tweak it"), and any meta-commentary. Return just the post text, exactly as written.' },
                { role: 'user', content: chatResponse }
            ]
        });
        return res.choices[0].message.content?.trim() || chatResponse;
    }
    catch {
        return chatResponse;
    }
}
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (recovered):', err.message);
});
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (msg.includes('Duplicate target') || msg.includes('Session with given id not found') || msg.includes('Target closed') || msg.includes('Browser has been closed')) {
        // These are Playwright CDP lifecycle errors. The target/page is already registered or
        // the session is being torn down — Playwright can still operate. Do NOT reset or close
        // the browser connection here: doing so triggers browser.close() which cascades into
        // the extension closing Chrome, which kills the relay and exits the process.
        console.error('Unhandled rejection (recovered):', msg);
        return;
    }
    console.error('Unhandled rejection (recovered):', reason);
});
// ── Global shutdown ───────────────────────────────────────────────────────────
const activeAgents = new Set();
let shuttingDown = false;
async function shutdown(reason = 'Interrupted') {
    if (shuttingDown)
        return;
    shuttingDown = true;
    // Abort every running agent loop
    for (const ctrl of activeAgents) {
        try {
            ctrl.abort();
        }
        catch { }
    }
    // Disconnect Playwright from Chrome — removes the "unclawned debugging" banner
    await closeAllBrowserConnections().catch(() => { });
    // Mark any DB tasks still marked running as failed
    try {
        db.prepare(`UPDATE tasks SET status = 'error', error = ? WHERE status = 'running'`).run(reason);
    }
    catch { }
    // Close with code 1001 — extension detects this and detaches all debugger sessions (removes the banner)
    try {
        for (const [, ws] of extensionConnections) {
            try {
                ws.close(1001, 'Server shutting down');
            }
            catch { }
        }
    }
    catch { }
    console.log('\nGoodbye!');
    process.exit(0);
}
process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(0)); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(0)); });
const CLI_PORT = parseInt(process.env.CLI_PORT || '3001');
const server = createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    }
    else {
        res.writeHead(404);
        res.end();
    }
});
async function drainQueueForUser(userId) {
    const queued = db.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'queued' ORDER BY created_at ASC").all(userId);
    for (const task of queued) {
        db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
        runTaskInBackground(task.id, task.prompt, userId).catch(() => { });
    }
}
startExtensionWsServer(server, drainQueueForUser);
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\nError: port ${CLI_PORT} is already in use.`);
        console.error(`Another unclawed instance may be running.`);
        console.error(`To use a different port: CLI_PORT=3003 unclawed\n`);
    }
    else {
        console.error(`Server error: ${err.message}`);
    }
    process.exit(1);
});
server.listen(CLI_PORT, async () => {
    const { loadScheduledTasks } = await import('./lib/scheduler.js');
    await loadScheduledTasks(runTaskInBackground);
});
function getConnectedUserId() {
    for (const [userId, ws] of extensionConnections) {
        if (ws.readyState === WebSocket.OPEN)
            return userId;
    }
    return null;
}
const EXTENSION_URL = 'https://chromewebstore.google.com/detail/pnefilbidikmcmphjgemiioomldkcdoe';
async function waitForExtension() {
    // Fast path: extension already connected (Chrome was already open)
    const immediate = getConnectedUserId();
    if (immediate)
        return immediate;
    // Show setup instructions
    const line = '─'.repeat(60);
    console.log('');
    console.log(line);
    console.log('  jarvis needs the Unclawed Chrome extension to work.');
    console.log(line);
    console.log('');
    console.log('  1. Install the extension:');
    console.log('');
    console.log('     ' + EXTENSION_URL);
    console.log('');
    console.log('  2. Open Chrome');
    console.log('  3. Come back — it connects automatically');
    console.log('');
    console.log(line);
    console.log('  Waiting for extension to connect...');
    console.log(line);
    console.log('');
    let seconds = 0;
    while (true) {
        await new Promise(r => setTimeout(r, 1000));
        seconds++;
        const userId = getConnectedUserId();
        if (userId)
            return userId;
        if (seconds % 60 === 0) {
            console.log(`  Still waiting (${Math.round(seconds / 60)}m)... Open Chrome with the extension enabled.`);
            console.log(`  ${EXTENSION_URL}`);
        }
    }
}
async function prompt(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}
async function maybeShowStandingPermissionSuggestion(rl) {
    const spSuggestion = getStandingPermissionSuggestion();
    if (!spSuggestion)
        return;
    clearStandingPermissionSuggestion();
    const platLabel = spSuggestion.platform ? ` on ${spSuggestion.platform}` : '';
    console.log(`\n💡 You've approved "${spSuggestion.action_type}"${platLabel} 3 times in a row.`);
    const spAnswer = (await prompt(rl, `   Auto-approve future "${spSuggestion.action_type}"${platLabel} without confirmation? (y/n) > `)).trim().toLowerCase();
    if (spAnswer === 'y' || spAnswer === 'yes') {
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const scopeNote = `${spSuggestion.action_type}${platLabel} (auto-approved)`;
        const { randomUUID: spUUID } = await import('crypto');
        db.prepare("INSERT INTO standing_permissions (id, user_id, action_type, platform, scope_note, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(spUUID(), spSuggestion.userId, spSuggestion.action_type, spSuggestion.platform || null, scopeNote, expiresAt);
        console.log(`   ✓ Auto-approval set (expires ${expiresAt}). Use /permissions to manage.\n`);
    }
    else {
        console.log();
    }
}
async function maybeOfferSkillCreation(rl, userId, originalTask) {
    console.log(`💡 Want to create a skill so the AI handles this better next time? (y/n)`);
    console.log(`   Task: "${originalTask.slice(0, 120)}"`);
    const answer = (await prompt(rl, '> ')).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') {
        await runSkillCreator(rl, userId, originalTask);
    }
}
async function main() {
    acquireCliLock();
    await runFirstTimeSetupIfNeeded();
    const userId = await waitForExtension();
    console.log('✅ Chrome extension connected. Jarvis is ready.\n');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('close', () => shutdown('Terminal closed'));
    // Session-level skill attachments — cleared after each task completes
    const sessionAttachedSkillIds = [];
    // Conversational state — updated after every task, used to resolve follow-up references
    let conversationalState = null;
    async function runTask(task) {
        const currentUserId = getConnectedUserId();
        if (!currentUserId) {
            console.log('\n⚠️  Chrome extension disconnected.');
            console.log('   Make sure Chrome is open and the Unclawed extension is active, then try again.');
            console.log(`   Need to install? ${EXTENSION_URL}\n`);
            return;
        }
        // ── Skill suggestion (pre-run) ────────────────────────────────────────────
        // Check if any saved skills are relevant to this task. Show suggestions and
        // allow the user to attach them before the agent starts.
        try {
            const suggestions = await searchSkillsForTask(currentUserId, task);
            const unattached = suggestions.filter(s => !sessionAttachedSkillIds.includes(s.skill_id));
            if (unattached.length) {
                console.log(`\n💡 Relevant skill${unattached.length > 1 ? 's' : ''} found:`);
                unattached.forEach(s => console.log(`   • ${s.skill_name} — ${s.why_relevant}`));
                const answer = await prompt(rl, `   Attach ${unattached.length > 1 ? 'them' : 'it'}? [y/n] `);
                if (answer.trim().toLowerCase() === 'y') {
                    sessionAttachedSkillIds.push(...unattached.map(s => s.skill_id));
                    console.log(`   ✓ ${unattached.map(s => s.skill_name).join(', ')} attached.\n`);
                }
                else {
                    console.log();
                }
            }
        }
        catch {
            // Suggestion failure is non-fatal — silently skip
        }
        // Collect runtime variable values for attached skills (if any define them)
        let skillVarValues = {};
        if (sessionAttachedSkillIds.length) {
            const skillVars = getAttachedSkillVariables(sessionAttachedSkillIds);
            if (skillVars.length) {
                skillVarValues = await collectRuntimeVars(rl, skillVars);
            }
        }
        // Build context block from attached skills (substituting any collected variable values)
        const skillsContext = buildAttachedSkillsContext(sessionAttachedSkillIds, skillVarValues);
        // Reference resolution — resolve pronouns/demonstratives against conversational state
        let effectiveTask = task;
        let continuationContext = '';
        let resumeTabId;
        if (conversationalState) {
            const resolution = await resolveReferences(task, conversationalState);
            if (resolution.confidence >= 70 && resolution.intent !== 'new_task') {
                effectiveTask = resolution.annotated;
                continuationContext = buildContinuationContext(conversationalState, resolution.resolved_entities);
                resumeTabId = conversationalState.last_tab_id > 0 ? conversationalState.last_tab_id : undefined;
                const lastTab = getLastUsedTab(currentUserId);
                if (lastTab) {
                    console.log(`\n🔁 Resuming from: "${lastTab.title.slice(0, 60)}" (${lastTab.url.slice(0, 70)})\n`);
                }
            }
            else if (resolution.confidence >= 40 && resolution.intent !== 'new_task' && resolution.clarification_question) {
                console.log();
                const clarified = (await prompt(rl, `  ${resolution.clarification_question} `)).trim();
                if (clarified) {
                    effectiveTask = `${resolution.annotated} (${clarified})`;
                    continuationContext = buildContinuationContext(conversationalState, resolution.resolved_entities);
                    resumeTabId = conversationalState.last_tab_id > 0 ? conversationalState.last_tab_id : undefined;
                }
            }
        }
        const taskWithSkills = skillsContext ? `${skillsContext}\n${effectiveTask}` : effectiveTask;
        const ac = new AbortController();
        activeAgents.add(ac);
        let lastLine = '';
        const onStep = async (step) => {
            if (lastLine)
                process.stdout.write('\r' + ' '.repeat(lastLine.length) + '\r');
            lastLine = step;
            process.stdout.write(step);
        };
        const onConfirmationRequest = async (req) => {
            // Clear the current progress line before rendering the confirmation UI
            if (lastLine) {
                process.stdout.write('\r' + ' '.repeat(lastLine.length) + '\r');
                lastLine = '';
            }
            return handleConfirmationRequest(rl, req);
        };
        try {
            const result = await orchestrateTask(taskWithSkills, currentUserId);
            if (result.type === 'chat') {
                console.log('\n' + result.response + '\n');
                // Update conversational state so follow-ups like "okay then publish this" can resolve
                try {
                    const newTurn = (conversationalState?.turn ?? 0) + 1;
                    const { entities: newEntities, topic: newTopic } = await extractEntities(task, result.response, newTurn);
                    const allEntities = [...(conversationalState?.entities ?? []), ...newEntities].slice(-30);
                    conversationalState = {
                        entities: allEntities,
                        last_task: task,
                        last_result: result.response,
                        topic: newTopic || conversationalState?.topic || '',
                        last_tab_id: conversationalState?.last_tab_id ?? 0,
                        turn: newTurn,
                    };
                }
                catch { }
                // If the user asked to draft a post for a specific platform, offer to publish it now
                const platformMatch = /\b(linkedin|twitter|instagram|facebook|x\.com)\b/i.exec(task);
                const isDraftIntent = /\b(write|draft|create|suggest|give me|help me|make)\b/i.test(task);
                const isPostIntent = /\b(post|tweet|publish|share|send)\b/i.test(task);
                if (platformMatch && (isDraftIntent || isPostIntent)) {
                    const platformKey = platformMatch[0].toLowerCase();
                    const platform = PLATFORM_NAMES[platformKey] || platformKey.charAt(0).toUpperCase() + platformKey.slice(1);
                    const yn = (await prompt(rl, `📤 Post this to ${platform}? (y/n) > `)).trim().toLowerCase();
                    if (yn === 'y' || yn === 'yes') {
                        const postContent = await extractPostContent(result.response);
                        await runTask(`Go to ${platform} and post this exact content — do not change a single word:\n\n${postContent}`);
                    }
                }
                return;
            }
            if (result.type === 'hybrid') {
                const output = await executeHybridTask(result.task, currentUserId, onStep, onConfirmationRequest);
                if (lastLine)
                    process.stdout.write('\n');
                console.log('\n✅ ' + output + '\n');
                return;
            }
            if (result.type === 'clarify') {
                console.log('\n' + result.message);
                result.questions.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
                const answers = [];
                for (let i = 0; i < result.questions.length; i++) {
                    const a = (await prompt(rl, `  Answer ${i + 1}: `)).trim();
                    // Include the question text with the answer so the agent has full context
                    answers.push(`${result.questions[i]}\n→ ${a}`);
                }
                console.log();
                const clarifiedResult = await orchestrateTask(task, currentUserId, answers);
                if (clarifiedResult.type === 'browser' || clarifiedResult.type === 'local') {
                    const clarifiedCtx = [skillsContext, continuationContext, clarifiedResult.context].filter(Boolean).join('\n\n');
                    const output = await runAgentWithExtension(effectiveTask, currentUserId, onStep, undefined, false, clarifiedCtx || undefined, ac.signal, false, false, undefined, onConfirmationRequest, clarifiedResult.type === 'local');
                    if (lastLine)
                        process.stdout.write('\n');
                    if (!wasLastAgentRunSuccessful()) {
                        console.log('\n❌ ' + output + '\n');
                        await maybeOfferSkillCreation(rl, currentUserId, effectiveTask);
                    }
                    else {
                        console.log('\n✅ ' + output + '\n');
                    }
                    await maybeShowStandingPermissionSuggestion(rl);
                }
                else if (clarifiedResult.type === 'hybrid') {
                    const output = await executeHybridTask(clarifiedResult.task, currentUserId, onStep, onConfirmationRequest);
                    if (lastLine)
                        process.stdout.write('\n');
                    console.log('\n✅ ' + output + '\n');
                }
                else if (clarifiedResult.type === 'chat') {
                    console.log('\n' + clarifiedResult.response + '\n');
                    try {
                        const newTurn = (conversationalState?.turn ?? 0) + 1;
                        const { entities: newEntities, topic: newTopic } = await extractEntities(task, clarifiedResult.response, newTurn);
                        const allEntities = [...(conversationalState?.entities ?? []), ...newEntities].slice(-30);
                        conversationalState = {
                            entities: allEntities,
                            last_task: task,
                            last_result: clarifiedResult.response,
                            topic: newTopic || conversationalState?.topic || '',
                            last_tab_id: conversationalState?.last_tab_id ?? 0,
                            turn: newTurn,
                        };
                    }
                    catch { }
                }
                return;
            }
            const combinedCtx = [skillsContext, continuationContext, result.context].filter(Boolean).join('\n\n');
            const isLocalOnly = result.type === 'local';
            const output = await runAgentWithExtension(effectiveTask, currentUserId, onStep, undefined, false, combinedCtx || undefined, ac.signal, false, false, resumeTabId, onConfirmationRequest, isLocalOnly);
            if (lastLine)
                process.stdout.write('\n');
            if (!wasLastAgentRunSuccessful()) {
                console.log('\n❌ ' + output + '\n');
                await maybeOfferSkillCreation(rl, currentUserId, effectiveTask);
            }
            else {
                console.log('\n✅ ' + output + '\n');
            }
            await maybeShowStandingPermissionSuggestion(rl);
            // Update conversational state — extract entities for future reference resolution
            try {
                const tabInfo = getLastUsedTab(currentUserId);
                const newTurn = (conversationalState?.turn ?? 0) + 1;
                const { entities: newEntities, topic: newTopic } = await extractEntities(task, output, newTurn);
                const allEntities = [...(conversationalState?.entities ?? []), ...newEntities].slice(-30);
                conversationalState = {
                    entities: allEntities,
                    last_task: task,
                    last_result: output,
                    topic: newTopic || conversationalState?.topic || '',
                    last_tab_id: tabInfo?.tabId ?? conversationalState?.last_tab_id ?? 0,
                    turn: newTurn,
                };
            }
            catch {
                // State update failure is non-fatal — next turn just starts fresh
            }
        }
        catch (err) {
            if (lastLine)
                process.stdout.write('\n');
            console.error('\n❌ ' + (err instanceof Error ? err.message : String(err)) + '\n');
        }
        finally {
            activeAgents.delete(ac);
            // Post-run gap report — show any stuck situations that had no skill
            try {
                const gaps = getRecentGapEvents(currentUserId, 120);
                if (gaps.length) {
                    console.log(`\n⚠️  Skill gap${gaps.length > 1 ? 's' : ''} detected during this run:`);
                    gaps.forEach(g => {
                        console.log(`   • [${g.stuck_type}] ${g.stuck_description}`);
                        if (g.current_url)
                            console.log(`     at: ${g.current_url}`);
                    });
                    const proposal = checkGapProposals(currentUserId);
                    if (proposal)
                        console.log('\n' + proposal);
                    console.log();
                }
            }
            catch {
                // Gap report failure is non-fatal
            }
            // Clear session attachments after every task — next task starts fresh
            sessionAttachedSkillIds.length = 0;
        }
    }
    const handleCommand = async (cmd) => {
        const parts = cmd.slice(1).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1).join(' ');
        const userId = getConnectedUserId();
        if (!userId) {
            console.log('⚠️  Extension disconnected.');
            return;
        }
        switch (command) {
            case 'skill':
                await runSkillCreator(rl, userId);
                break;
            case 'skills':
                listSkills(userId);
                break;
            case 'run':
                await runSavedSkill(rl, userId, args);
                break;
            case 'edit':
                await runSkillEditor(rl, userId, args);
                break;
            case 'delete':
                await runSkillDelete(rl, userId, args);
                break;
            case 'attach': {
                if (!args) {
                    console.log('Usage: /attach <skill-name>');
                    break;
                }
                const found = resolveSkillByName(userId, args);
                if (!found) {
                    console.log(`  ✗ Skill "${args}" not found. Use /skills to see your saved skills.`);
                }
                else if (sessionAttachedSkillIds.includes(found.id)) {
                    console.log(`  ✓ "${found.skill_name}" is already attached.`);
                }
                else {
                    sessionAttachedSkillIds.push(found.id);
                    console.log(`  ✓ "${found.skill_name}" attached — will be used as context for your next task.`);
                }
                break;
            }
            case 'detach': {
                if (!args) {
                    // Detach all
                    sessionAttachedSkillIds.length = 0;
                    console.log('  All attached skills cleared.');
                }
                else {
                    const found = resolveSkillByName(userId, args);
                    if (found) {
                        const idx = sessionAttachedSkillIds.indexOf(found.id);
                        if (idx !== -1) {
                            sessionAttachedSkillIds.splice(idx, 1);
                            console.log(`  ✓ "${found.skill_name}" detached.`);
                        }
                        else {
                            console.log(`  "${found.skill_name}" was not attached.`);
                        }
                    }
                    else {
                        console.log(`  Skill "${args}" not found.`);
                    }
                }
                break;
            }
            case 'attached': {
                if (!sessionAttachedSkillIds.length) {
                    console.log('  No skills attached for the next task.');
                }
                else {
                    console.log(`  Attached skills (${sessionAttachedSkillIds.length}):`);
                    for (const id of sessionAttachedSkillIds) {
                        const row = resolveSkillByName(userId, id) ?? { skill_name: id };
                        console.log(`    • ${row.skill_name}`);
                    }
                }
                break;
            }
            case 'task':
                if (!args) {
                    console.log('Usage: /task <description>');
                    break;
                }
                await runTask(args);
                break;
            case 'tabs': {
                const tabUserId = getConnectedUserId();
                if (!tabUserId) {
                    console.log('⚠️  Extension disconnected.');
                    break;
                }
                const tabs = await getOpenTabs(tabUserId);
                if (!tabs.length) {
                    console.log('\nNo open tabs found (or extension not responding).\n');
                    break;
                }
                const line = '─'.repeat(60);
                console.log(`\n${line}`);
                console.log('  OPEN BROWSER TABS');
                console.log(line);
                tabs.filter(t => !t.isSensitive).slice(0, 15).forEach((t, i) => {
                    const flags = [t.active ? 'ACTIVE' : '', t.isAttached ? 'ATTACHED' : ''].filter(Boolean).join(', ');
                    const url = t.url.slice(0, 70);
                    console.log(`  [${i + 1}] Tab ${t.tabId}${flags ? ` (${flags})` : ''}`);
                    console.log(`      "${t.title.slice(0, 60)}"`);
                    console.log(`      ${url}`);
                });
                console.log(line);
                console.log('  Tip: mention the site name in your task and jarvis will use the existing tab.');
                console.log(`      e.g. "go to Twitter and..." → automatically uses an open Twitter tab\n`);
                break;
            }
            case 'permissions': {
                const perms = db.prepare("SELECT * FROM standing_permissions WHERE user_id = ? ORDER BY created_at DESC").all(userId);
                if (!perms.length) {
                    console.log('\n  No standing permissions set.');
                    console.log('  After approving the same action 3 times, you\'ll be offered to create one.\n');
                }
                else {
                    console.log(`\n  Standing permissions (${perms.length}):`);
                    console.log('  ' + '─'.repeat(55));
                    perms.forEach((p, i) => {
                        const expires = p.expires_at ? `expires ${p.expires_at}` : 'permanent';
                        const label = p.scope_note || `${p.action_type}${p.platform ? ' on ' + p.platform : ''}`;
                        console.log(`  [${i + 1}] ${label} — ${expires}`);
                    });
                    console.log('  ' + '─'.repeat(55));
                    const spAnswer = (await prompt(rl, '  Enter number to revoke, or Enter to close: > ')).trim();
                    const idx = parseInt(spAnswer) - 1;
                    if (!isNaN(idx) && idx >= 0 && idx < perms.length) {
                        db.prepare("DELETE FROM standing_permissions WHERE id = ?").run(perms[idx].id);
                        console.log(`  ✓ Revoked: ${perms[idx].scope_note || perms[idx].action_type}`);
                    }
                    console.log();
                }
                break;
            }
            case 'audit': {
                const logs = db.prepare(`
          SELECT * FROM confirmation_audit_log
          WHERE user_id = ?
          ORDER BY decided_at DESC LIMIT 20
        `).all(userId);
                if (!logs.length) {
                    console.log('\n  No confirmation history yet.\n');
                }
                else {
                    console.log(`\n  Last ${logs.length} confirmation events:`);
                    console.log('  ' + '─'.repeat(60));
                    for (const l of logs) {
                        const when = (l.decided_at || '?').split('T')[0];
                        const icon = l.decision === 'approved' ? '✓' : l.decision === 'denied' ? '✗' : l.decision === 'timeout' ? '⏱' : '✎';
                        const auto = l.via_standing_permission ? ' (auto)' : '';
                        console.log(`  ${icon} [${when}] ${l.action_type} — ${l.target}${auto}  [T${l.tier}]`);
                        if (l.content_snapshot) {
                            const preview = l.content_snapshot.slice(0, 80);
                            console.log(`      "${preview}${l.content_snapshot.length > 80 ? '...' : ''}"`);
                        }
                    }
                    console.log('  ' + '─'.repeat(60));
                    console.log();
                }
                break;
            }
            case 'help':
                console.log('\nAvailable commands:');
                console.log('  /skill            — create a new skill');
                console.log('  /skills           — list your saved skills');
                console.log('  /run <name>       — run a saved skill');
                console.log('  /edit <name>      — re-open a saved skill for editing');
                console.log('  /attach <name>    — attach a skill as context for the next task');
                console.log('  /detach [name]    — detach a skill (or all if no name given)');
                console.log('  /attached         — show currently attached skills');
                console.log('  /task <desc>      — run a task (same as typing it directly)');
                console.log('  /tabs             — list open Chrome tabs (shows what jarvis can see)');
                console.log('  /permissions      — view and revoke standing auto-approvals');
                console.log('  /audit            — show last 20 agent confirmation events');
                console.log('  /help             — show this menu');
                console.log('  exit / quit     — close jarvis');
                console.log('\nOr just type any task directly without a slash.');
                console.log('Jarvis will suggest relevant skills before starting if any are found.\n');
                break;
            default:
                console.log(`Unknown command: /${command}. Type /help for available commands.`);
        }
    };
    console.log('Type a task or /help for commands. Type "exit" to quit.');
    console.log('Tip: end a line with \\ to continue typing on the next line.\n');
    const loop = async () => {
        const firstLine = await prompt(rl, '> ');
        const trimmedFirst = firstLine.trim();
        if (trimmedFirst === 'exit' || trimmedFirst === 'quit') {
            rl.close();
            return;
        }
        if (!trimmedFirst) {
            loop();
            return;
        }
        // Multi-line input: lines ending with \ continue; blank line or non-\ line submits.
        // This lets users paste multi-line tasks without each line becoming a separate command.
        let task;
        if (trimmedFirst.startsWith('/')) {
            task = trimmedFirst;
        }
        else {
            // Blank-line-submit: always show '...' after the first line so pasted
            // multi-line content is collected naturally. A blank line (or Ctrl+D) submits.
            const lines = [firstLine.replace(/\\$/, '')];
            while (true) {
                const more = await prompt(rl, '... ');
                if (!more.trim())
                    break; // blank line = submit
                lines.push(more.replace(/\\$/, ''));
            }
            task = lines.join('\n').trim();
        }
        if (task.startsWith('/')) {
            await handleCommand(task).catch(err => console.error('Command error:', err.message));
        }
        else {
            await runTask(task);
        }
        loop();
    };
    loop();
}
main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
