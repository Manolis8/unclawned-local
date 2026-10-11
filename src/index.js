import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { tasksRouter } from './routes/tasks.js';
import { messagesRouter } from './routes/messages.js';
import { oauthRouter } from './routes/oauth.js';
import { teachingRouter } from './routes/teaching.js';
import skillsRouter from './routes/skills.js';
import { startExtensionWsServer } from './lib/extension-ws-server.js';
import { db } from './lib/db.js';
import { getRelayPortForUser, freeRelayPort, BASE_RELAY_PORT, extensionConnections, pendingCdpCommands, cdpCommandId, sendCdpCommand, sendExtensionMessage, isExtensionConnected, } from './lib/extension-state.js';
export { getRelayPortForUser, freeRelayPort, BASE_RELAY_PORT, extensionConnections, pendingCdpCommands, cdpCommandId, sendCdpCommand, sendExtensionMessage, isExtensionConnected, };
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (recovered):', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (recovered):', reason);
});
const app = express();
const PORT = process.env.PORT || 3001;
const activeTaskTimeouts = new Map();
const generalRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 100,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' }
});
const generateKeyRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many key generation requests, please try again later' }
});
function setTaskTimeout(taskId, _userId) {
    const timer = setTimeout(() => {
        activeTaskTimeouts.delete(taskId);
        db.prepare("UPDATE tasks SET status = 'error', output = ? WHERE id = ? AND status = 'running'")
            .run('⏱️ Task timed out. The task took too long to complete. Please try again with a simpler request.', taskId);
    }, 180_000);
    activeTaskTimeouts.set(taskId, timer);
}
function clearTaskTimeout(taskId) {
    const timer = activeTaskTimeouts.get(taskId);
    if (timer) {
        clearTimeout(timer);
        activeTaskTimeouts.delete(taskId);
    }
}
const allowedOrigins = [
    'https://unclawned.com', 'https://www.unclawned.com',
    'https://test-frontend-unclawned.vercel.app', 'https://www.test-frontend-unclawned.vercel.app'
];
app.use(helmet());
app.use((req, res, next) => {
    if (req.path.startsWith('/api/extension-status'))
        return next();
    return generalRateLimiter(req, res, next);
});
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin))
        res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
    }
    next();
});
app.use(express.json({ limit: '10kb' }));
app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});
app.get('/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date() });
});
app.post('/api/generate-key', generateKeyRateLimiter, async (req, res) => {
    const { userId } = req.body;
    if (!userId || typeof userId !== 'string')
        return res.status(400).json({ error: 'Missing userId' });
    const sanitizedUserId = userId.trim().replace(/\0/g, '');
    if (!sanitizedUserId || sanitizedUserId.length > 100)
        return res.status(400).json({ error: 'Invalid userId' });
    const key = 'felo_' + [...Array(40)].map(() => Math.random().toString(36)[2]).join('');
    try {
        db.prepare("INSERT INTO api_keys (user_id, key) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET key = excluded.key").run(sanitizedUserId, key);
    }
    catch {
        return res.status(500).json({ error: 'Failed to generate key' });
    }
    res.json({ key });
});
app.get('/api/get-key/:userId', async (req, res) => {
    const row = db.prepare('SELECT key FROM api_keys WHERE user_id = ?').get(req.params.userId);
    res.json({ key: row?.key || null });
});
app.get('/api/extension-status/:userId', (req, res) => {
    res.json({ connected: isExtensionConnected(req.params.userId) });
});
app.use('/api', tasksRouter);
app.use('/api', messagesRouter);
app.use('/api', oauthRouter);
app.use('/api', teachingRouter);
app.use('/api/skills', skillsRouter);
const server = createServer(app);
async function drainQueueForUser(userId) {
    const queuedTasks = db.prepare("SELECT * FROM tasks WHERE user_id = ? AND status = 'queued' ORDER BY created_at ASC").all(userId);
    if (!queuedTasks.length)
        return;
    console.log(`🔄 Draining ${queuedTasks.length} queued tasks for ${userId}`);
    const { runTaskInBackground } = await import('./routes/tasks.js');
    for (const task of queuedTasks) {
        db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
        setTaskTimeout(task.id, userId);
        runTaskInBackground(task.id, task.prompt, userId).then(() => {
            clearTaskTimeout(task.id);
        }).catch(() => {
            clearTaskTimeout(task.id);
        });
    }
}
startExtensionWsServer(server, drainQueueForUser);
server.listen(PORT, async () => {
    console.log(`✅ Openclaw backend running on port ${PORT}`);
    console.log(`✅ Local DB: ~/.unclawned/openclaw.db`);
    const { loadScheduledTasks } = await import('./lib/scheduler.js');
    const { runTaskInBackground } = await import('./routes/tasks.js');
    await loadScheduledTasks(runTaskInBackground);
});
