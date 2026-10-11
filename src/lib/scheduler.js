import { createHash } from 'crypto';
import { Cron } from 'croner';
import OpenAI from 'openai';
import { db, uuid } from './db.js';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_REFIRE_GAP_MS = 2000;
const MAX_TIMER_DELAY_MS = 60_000;
const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;
const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000];
// ─── In-memory store ──────────────────────────────────────────────────────────
const scheduledTasks = new Map();
const runningTasks = new Set();
let timerHandle = null;
let timerRunning = false;
// ─── Stagger ──────────────────────────────────────────────────────────────────
function resolveStaggerOffset(taskId, windowMs) {
    if (windowMs <= 0)
        return 0;
    const hash = createHash('sha256').update(taskId).digest();
    return hash.readUInt32BE(0) % windowMs;
}
function isTopOfHourCron(expr) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length < 2)
        return false;
    return parts[0] === '0';
}
// ─── Next run computation ─────────────────────────────────────────────────────
export function computeNextRun(taskId, cronExpr, lastRunAt) {
    const nowMs = Date.now();
    const staggerWindowMs = isTopOfHourCron(cronExpr) ? DEFAULT_TOP_OF_HOUR_STAGGER_MS : 0;
    const stagger = resolveStaggerOffset(taskId, staggerWindowMs);
    try {
        const c = new Cron(cronExpr);
        let next = c.nextRun(new Date(nowMs));
        if (!next || next.getTime() <= nowMs)
            next = c.nextRun(new Date(nowMs + 1000));
        if (!next || next.getTime() <= nowMs) {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(0, 0, 1, 0);
            next = c.nextRun(tomorrow);
        }
        if (!next)
            throw new Error(`Cannot compute next run for: ${cronExpr}`);
        return next.getTime() + stagger;
    }
    catch (err) {
        console.error(`computeNextRun error for ${cronExpr}:`, err);
        return nowMs + 3_600_000;
    }
}
function computeNextRunWithBackoff(taskId, cronExpr, consecutiveErrors, endedAtMs) {
    const natural = computeNextRun(taskId, cronExpr, endedAtMs);
    if (consecutiveErrors === 0)
        return natural;
    const backoff = BACKOFF_MS[Math.min(consecutiveErrors - 1, BACKOFF_MS.length - 1)];
    return Math.max(natural, endedAtMs + backoff);
}
// ─── Natural language parsing ─────────────────────────────────────────────────
export async function parseSchedule(input) {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `Convert natural language schedule descriptions to cron expressions.
Return ONLY a valid JSON object with exactly two fields:
- cron: standard 5-field cron expression (minute hour day month weekday)
- human: clean human-readable description

Examples:
"every morning at 9am" -> {"cron":"0 9 * * *","human":"Every day at 9:00 AM"}
"every monday at 8am" -> {"cron":"0 8 * * 1","human":"Every Monday at 8:00 AM"}
"every hour" -> {"cron":"0 * * * *","human":"Every hour"}
"every day at 6pm" -> {"cron":"0 18 * * *","human":"Every day at 6:00 PM"}
"every 30 minutes" -> {"cron":"*/30 * * * *","human":"Every 30 minutes"}
"every weekday at 9am" -> {"cron":"0 9 * * 1-5","human":"Every weekday at 9:00 AM"}
"every sunday at noon" -> {"cron":"0 12 * * 0","human":"Every Sunday at 12:00 PM"}

Return null if input is not a valid schedule description.
Return ONLY the JSON object, no markdown, no explanation.`
                },
                { role: 'user', content: input }
            ],
            max_tokens: 100
        });
        const text = response.choices[0].message.content?.trim() || '';
        if (text === 'null' || !text)
            return null;
        const clean = text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (!parsed.cron || !parsed.human)
            return null;
        return parsed;
    }
    catch (err) {
        console.error('parseSchedule error:', err);
        return null;
    }
}
// ─── Inbox messages ───────────────────────────────────────────────────────────
export async function createMessage(userId, taskId, content) {
    try {
        db.prepare('INSERT INTO messages (id, user_id, task_id, content, read) VALUES (?, ?, ?, ?, 0)')
            .run(uuid(), userId, taskId, content);
    }
    catch (err) {
        console.error('createMessage error:', err);
    }
}
// ─── Timer loop ───────────────────────────────────────────────────────────────
let _runTaskFn = null;
export function setRunTaskFn(fn) {
    _runTaskFn = fn;
}
export function armTimer() {
    if (timerHandle) {
        clearTimeout(timerHandle);
        timerHandle = null;
    }
    if (scheduledTasks.size === 0)
        return;
    const nowMs = Date.now();
    let nearestMs = Infinity;
    for (const task of scheduledTasks.values()) {
        if (task.nextRunAt < nearestMs)
            nearestMs = task.nextRunAt;
    }
    if (nearestMs === Infinity)
        return;
    let delayMs = Math.max(nearestMs - nowMs, 0);
    if (delayMs < MIN_REFIRE_GAP_MS)
        delayMs = MIN_REFIRE_GAP_MS;
    if (delayMs > MAX_TIMER_DELAY_MS)
        delayMs = MAX_TIMER_DELAY_MS;
    console.log(`⏱ Timer armed — next task in ${Math.round(delayMs / 1000)}s`);
    timerHandle = setTimeout(() => onTimer(), delayMs);
}
async function onTimer() {
    if (timerRunning) {
        armTimer();
        return;
    }
    timerRunning = true;
    try {
        const nowMs = Date.now();
        const dueTasks = [];
        for (const task of scheduledTasks.values()) {
            if (task.nextRunAt <= nowMs)
                dueTasks.push(task);
        }
        if (dueTasks.length === 0) {
            armTimer();
            return;
        }
        console.log(`⏰ ${dueTasks.length} task(s) due`);
        for (const task of dueTasks) {
            runScheduledTask(task).catch(err => console.error(`Scheduled task ${task.taskId} threw:`, err));
        }
    }
    finally {
        timerRunning = false;
        armTimer();
    }
}
async function runScheduledTask(task) {
    if (runningTasks.has(task.taskId)) {
        console.log(`Task ${task.taskId} already running in memory, skipping`);
        return;
    }
    runningTasks.add(task.taskId);
    try {
        const { taskId, userId, prompt, cronExpr } = task;
        const { isExtensionConnected } = await import('./extension-state.js');
        // Distributed lock via running_at
        const lockResult = db.prepare('UPDATE tasks SET running_at = ? WHERE id = ? AND running_at IS NULL').run(new Date().toISOString(), taskId);
        if (lockResult.changes === 0) {
            console.warn(`Could not lock task ${taskId} — may already be running`);
            return;
        }
        const extensionConnected = isExtensionConnected(userId);
        if (!extensionConnected) {
            db.prepare("UPDATE tasks SET status = 'queued', running_at = NULL, last_run = ? WHERE id = ?")
                .run(new Date().toISOString(), taskId);
            await createMessage(userId, taskId, `⏳ Task queued — your browser isn't connected. It will run automatically when you open Chrome.`);
            console.log(`Task ${taskId} queued — extension offline`);
            const nextRunAt = computeNextRunWithBackoff(taskId, cronExpr, task.consecutiveErrors, Date.now());
            scheduledTasks.set(taskId, { ...task, nextRunAt });
            db.prepare('UPDATE tasks SET next_run = ? WHERE id = ?').run(new Date(nextRunAt).toISOString(), taskId);
            return;
        }
        db.prepare("UPDATE tasks SET status = 'running', output = '' WHERE id = ?").run(taskId);
        const startedAt = Date.now();
        try {
            if (!_runTaskFn)
                throw new Error('runTaskFn not set');
            await _runTaskFn(taskId, prompt, userId);
            const endedAt = Date.now();
            const nextRunAt = computeNextRunWithBackoff(taskId, cronExpr, 0, endedAt);
            db.prepare('UPDATE tasks SET last_run = ?, next_run = ?, running_at = NULL, consecutive_errors = 0 WHERE id = ?')
                .run(new Date(startedAt).toISOString(), new Date(nextRunAt).toISOString(), taskId);
            scheduledTasks.set(taskId, { ...task, lastRunAt: startedAt, consecutiveErrors: 0, nextRunAt });
            console.log(`✅ Scheduled task ${taskId} done. Next run: ${new Date(nextRunAt).toISOString()}`);
        }
        catch (err) {
            const endedAt = Date.now();
            const newErrors = task.consecutiveErrors + 1;
            const nextRunAt = computeNextRunWithBackoff(taskId, cronExpr, newErrors, endedAt);
            db.prepare("UPDATE tasks SET last_run = ?, next_run = ?, running_at = NULL, consecutive_errors = ?, status = 'error' WHERE id = ?")
                .run(new Date(startedAt).toISOString(), new Date(nextRunAt).toISOString(), newErrors, taskId);
            await createMessage(userId, taskId, `❌ Scheduled task failed (attempt ${newErrors}): ${String(err).slice(0, 200)}`);
            scheduledTasks.set(taskId, { ...task, consecutiveErrors: newErrors, nextRunAt });
            console.error(`Scheduled task ${taskId} failed (errors: ${newErrors}). Next retry: ${new Date(nextRunAt).toISOString()}`);
        }
    }
    finally {
        runningTasks.delete(task.taskId);
    }
}
// ─── Public API ───────────────────────────────────────────────────────────────
export function scheduleTask(taskId, userId, prompt, cronExpr, lastRunAt, consecutiveErrors = 0) {
    const nextRunAt = computeNextRun(taskId, cronExpr, lastRunAt);
    scheduledTasks.set(taskId, { taskId, userId, prompt, cronExpr, lastRunAt, consecutiveErrors, nextRunAt });
    console.log(`📅 Scheduled task ${taskId} — next run: ${new Date(nextRunAt).toISOString()}`);
    armTimer();
}
export function cancelTask(taskId) {
    if (scheduledTasks.has(taskId)) {
        scheduledTasks.delete(taskId);
        console.log(`🗑 Cancelled scheduled task ${taskId}`);
        armTimer();
    }
}
export function getScheduledTask(taskId) {
    return scheduledTasks.get(taskId);
}
export function getAllScheduledTasks() {
    return Array.from(scheduledTasks.values());
}
// ─── Startup — load all recurring tasks from local DB ────────────────────────
export async function loadScheduledTasks(runTaskFn) {
    setRunTaskFn(runTaskFn);
    // Clear stale running_at markers from crashed previous process
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE tasks SET running_at = NULL, status = 'idle' WHERE running_at IS NOT NULL AND running_at < ?")
        .run(twoHoursAgo);
    // Load all recurring tasks
    const tasks = db.prepare("SELECT id, user_id, prompt, schedule, last_run, consecutive_errors, status FROM tasks WHERE is_recurring = 1 AND schedule IS NOT NULL").all();
    if (!tasks.length) {
        console.log('📅 No recurring tasks to load');
        return;
    }
    for (const task of tasks) {
        scheduleTask(task.id, task.user_id, task.prompt, task.schedule, task.last_run ? new Date(task.last_run).getTime() : undefined, task.consecutive_errors || 0);
    }
    console.log(`📅 Loaded ${tasks.length} recurring tasks`);
    armTimer();
}
