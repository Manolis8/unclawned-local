import { Router } from 'express';
import { db, uuid, j } from '../lib/db.js';
import { processSteps } from '../lib/teaching-processor.js';
export const teachingRouter = Router();
function sanitizeString(input, maxLength = 100) {
    if (typeof input !== 'string')
        return null;
    const trimmed = input.trim().replace(/\0/g, '');
    return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}
teachingRouter.post('/teaching/save-skill', async (req, res) => {
    try {
        const { sessionId: rawSession, skillName: rawName, skillDetails: rawDetails, steps, userId: rawUserId, rawSessionData, conversionMetadata } = req.body;
        const userId = sanitizeString(rawUserId, 100);
        const skillName = sanitizeString(rawName, 200);
        const skillDetails = sanitizeString(rawDetails, 2000) ?? '';
        const sessionId = sanitizeString(rawSession, 100) ?? undefined;
        if (!userId || !skillName)
            return res.status(400).json({ error: 'Missing required fields: userId, skillName' });
        const userExists = db.prepare('SELECT user_id FROM api_keys WHERE user_id = ?').get(userId);
        if (!userExists)
            return res.status(401).json({ error: 'Unauthorized: invalid userId' });
        const existingSkill = db.prepare('SELECT id FROM skills WHERE user_id = ? AND skill_name = ?').get(userId, skillName);
        if (existingSkill)
            return res.status(409).json({ error: 'Skill with this name already exists' });
        if (!Array.isArray(steps) || steps.length === 0)
            return res.status(400).json({ error: 'steps must be a non-empty array' });
        if (steps.length > 200)
            return res.status(400).json({ error: 'Too many steps (max 200)' });
        for (const step of steps) {
            if (typeof step.step_number !== 'number' || typeof step.action_type !== 'string' || typeof step.description !== 'string') {
                return res.status(400).json({ error: 'Each step must have step_number (number), action_type (string), and description (string)' });
            }
        }
        console.log('[teaching] Saving skill:', skillName, 'for user:', userId);
        const { processedSteps, variables, summary } = await processSteps(steps, skillName, skillDetails);
        const skillId = uuid();
        db.prepare(`
      INSERT INTO skills (id, user_id, session_id, skill_name, skill_details, summary, variables, step_count,
        raw_session_data, element_registry, playwright_metadata, conversion_metadata,
        verified_by_playwright, needs_semantic_analysis)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(skillId, userId, sessionId ?? null, skillName, skillDetails, summary, j(variables), processedSteps.length, rawSessionData ? JSON.stringify(rawSessionData) : null, rawSessionData ? JSON.stringify(rawSessionData.elementRegistry) : null, rawSessionData ? JSON.stringify(rawSessionData.playwrightMetadata) : null, conversionMetadata ? JSON.stringify(conversionMetadata) : null, rawSessionData ? 1 : 0);
        console.log('[teaching] Skill saved:', skillId);
        const stepRows = processedSteps.map((step, index) => ({
            id: uuid(),
            skill_id: skillId,
            step_number: step.step_number,
            action_type: step.action_type,
            description: step.description,
            screenshot: step.screenshot ?? null,
            identified_variables: j(step.identified_variables),
            is_manual: step.is_manual ? 1 : 0,
            raw_event_data: rawSessionData?.events[index] ? JSON.stringify(rawSessionData.events[index]) : null,
            element_ref: rawSessionData?.events[index]?.elementRef ?? null,
            element_selector: rawSessionData?.events[index]?.elementData?.selector ?? null
        }));
        const insertStep = db.prepare(`
      INSERT INTO skill_steps (id, skill_id, step_number, action_type, description, screenshot, identified_variables, is_manual, raw_event_data, element_ref, element_selector)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        try {
            db.exec('BEGIN');
            for (const r of stepRows) {
                insertStep.run(r.id, r.skill_id, r.step_number, r.action_type, r.description, r.screenshot, r.identified_variables, r.is_manual, r.raw_event_data, r.element_ref, r.element_selector);
            }
            db.exec('COMMIT');
        }
        catch (stepsError) {
            try { db.exec('ROLLBACK'); } catch {}
            console.error('[teaching] Failed to insert steps:', stepsError);
            db.prepare('DELETE FROM skills WHERE id = ?').run(skillId);
            return res.status(500).json({ error: 'Failed to save steps' });
        }
        console.log('[teaching] Steps saved:', processedSteps.length, {
            hasRawData: !!rawSessionData,
            rawEventCount: rawSessionData?.events.length ?? 0,
            readyForPlaywright: !!rawSessionData?.playwrightMetadata?.needsPlaywrightVerification,
            readyForSemanticAnalysis: !!rawSessionData
        });
        return res.status(201).json({
            skillId,
            skillName,
            steps: processedSteps,
            variables,
            summary,
            rawDataProcessed: !!rawSessionData,
            playwrightVerificationPending: !!rawSessionData?.playwrightMetadata?.needsPlaywrightVerification,
            semanticAnalysisPending: !!rawSessionData
        });
    }
    catch (err) {
        console.error('[teaching] Unexpected error:', err);
        return res.status(500).json({ error: 'Internal error processing skill' });
    }
});
teachingRouter.get('/teaching/skills/:userId', async (req, res) => {
    try {
        const userId = sanitizeString(req.params.userId, 100);
        if (!userId)
            return res.status(400).json({ error: 'Invalid userId' });
        const userExists = db.prepare('SELECT user_id FROM api_keys WHERE user_id = ?').get(userId);
        if (!userExists)
            return res.status(401).json({ error: 'Unauthorized' });
        const data = db.prepare('SELECT id, skill_name, skill_details, summary, variables, step_count, created_at FROM skills WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(userId);
        return res.json(data || []);
    }
    catch (err) {
        console.error('[teaching] Unexpected error:', err);
        return res.status(500).json({ error: 'Internal error' });
    }
});
teachingRouter.get('/teaching/skills/:skillId/steps', async (req, res) => {
    try {
        const skillId = req.params.skillId;
        if (!skillId || typeof skillId !== 'string')
            return res.status(400).json({ error: 'Invalid skillId' });
        const data = db.prepare('SELECT * FROM skill_steps WHERE skill_id = ? ORDER BY step_number ASC').all(skillId);
        return res.json(data || []);
    }
    catch (err) {
        console.error('[teaching] Unexpected error:', err);
        return res.status(500).json({ error: 'Internal error' });
    }
});
