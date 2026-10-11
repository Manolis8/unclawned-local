import { Router } from 'express';
import OpenAI from 'openai';
import { authenticateUser } from '../middleware/auth.js';
import { skillsApi } from '../lib/skills-api.js';
import { saveSkill, getSkill, listSkills, createExecution, getExecution, updateExecution, saveInputVariable } from '../db/queries.js';
import { runAgentLoop, registerWorkingTab } from '../lib/agent-extension.js';
import { sendExtensionMessage, isExtensionConnected } from '../lib/extension-state.js';
import { db, uuid } from '../lib/db.js';
import { planToPrompt } from '../lib/cli-skill-creator.js';
import { updateSkillPlan } from '../db/queries.js';
import { indexSkillAsync } from '../lib/skill-index.js';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const router = Router();
router.use(authenticateUser);
router.post('/create-plan', async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            return res.status(401).json({ error: 'Not authenticated' });
        const { skillDescription, answers } = req.body;
        if (!skillDescription || skillDescription.trim().length < 20)
            return res.status(400).json({ error: 'Skill description required (min 20 characters)' });
        if (skillDescription.trim().length > 1000)
            return res.status(400).json({ error: 'Skill description too long (max 1000 characters)' });
        console.log(`[Skills API] Generating plan for: ${skillDescription.substring(0, 50)}...`);
        const { plan, questions, inputs } = await skillsApi.generatePlan(skillDescription, answers || {});
        res.json({ success: true, plan, questions: questions && questions.length > 0 ? questions : [], inputs });
    }
    catch (error) {
        console.error('[Skills API] Error generating plan:', error);
        res.status(500).json({ error: 'Failed to generate plan', details: error instanceof Error ? error.message : 'Unknown error' });
    }
});
router.post('/save', async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            return res.status(401).json({ error: 'Not authenticated' });
        const { skillName, skillDescription, plan, inputs } = req.body;
        if (!skillName || skillName.trim().length === 0)
            return res.status(400).json({ error: 'Skill name is required' });
        if (!skillDescription || skillDescription.trim().length === 0)
            return res.status(400).json({ error: 'Skill description is required' });
        if (!plan || !plan.steps || plan.steps.length === 0)
            return res.status(400).json({ error: 'Valid execution plan is required' });
        const existingSkills = await listSkills(userId);
        if (existingSkills.some((s) => s.skill_name.toLowerCase() === skillName.toLowerCase())) {
            return res.status(409).json({ error: 'A skill with this name already exists' });
        }
        console.log(`[Skills API] Saving skill: ${skillName}`);
        const skill = await saveSkill(userId, { skill_name: skillName, skill_description: skillDescription, execution_plan: plan, status: 'active' });
        if (inputs && inputs.length > 0) {
            for (const input of inputs)
                await saveInputVariable(skill.id, input);
        }
        indexSkillAsync(skill.id, skillName, skillDescription || '', 'browser', plan, null, null);
        res.json({ success: true, skillId: skill.id, message: 'Skill saved successfully' });
    }
    catch (error) {
        console.error('[Skills API] Error saving skill:', error);
        res.status(500).json({ error: 'Failed to save skill', details: error instanceof Error ? error.message : 'Unknown error' });
    }
});
router.get('/', async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            return res.status(401).json({ error: 'Not authenticated' });
        const skills = await listSkills(userId);
        res.json(skills);
    }
    catch (error) {
        console.error('[Skills API] Error listing skills:', error);
        res.status(500).json({ error: 'Failed to list skills', details: error instanceof Error ? error.message : 'Unknown error' });
    }
});
router.get('/:skillId', async (req, res) => {
    try {
        const userId = req.user?.id;
        const skillId = req.params.skillId;
        if (!userId)
            return res.status(401).json({ error: 'Not authenticated' });
        if (!skillId)
            return res.status(400).json({ error: 'Skill ID required' });
        const skill = await getSkill(skillId);
        if (!skill)
            return res.status(404).json({ error: 'Skill not found' });
        if (skill.user_id !== userId && !skill.is_public)
            return res.status(403).json({ error: 'Access denied' });
        res.json(skill);
    }
    catch (error) {
        console.error('[Skills API] Error getting skill:', error);
        res.status(500).json({ error: 'Failed to get skill', details: error instanceof Error ? error.message : 'Unknown error' });
    }
});
router.post('/:skillId/execute', async (req, res) => {
    try {
        const userId = req.user?.id;
        const skillId = req.params.skillId;
        const { inputValues } = req.body;
        if (!userId)
            return res.status(401).json({ error: 'Not authenticated' });
        if (!skillId)
            return res.status(400).json({ error: 'Skill ID required' });
        if (!inputValues || typeof inputValues !== 'object')
            return res.status(400).json({ error: 'Input values object required' });
        const skill = await getSkill(skillId);
        if (!skill)
            return res.status(404).json({ error: 'Skill not found' });
        if (skill.user_id !== userId)
            return res.status(403).json({ error: 'Access denied' });
        const execution = await createExecution(skillId, userId, inputValues);
        executeSkillAsync(execution, skill).catch(err => {
            console.error('[Skills Executor] Execution error:', err);
            updateExecution(execution.id, { status: 'error', error_message: err.message, completed_at: new Date().toISOString() })
                .catch(e => console.error('Failed to update execution:', e));
        });
        res.json({ success: true, executionId: execution.id, status: 'running', message: 'Skill execution started' });
    }
    catch (error) {
        console.error('[Skills API] Error starting execution:', error);
        res.status(500).json({ error: 'Failed to start execution', details: error instanceof Error ? error.message : 'Unknown error' });
    }
});
router.get('/:skillId/executions/:executionId', async (req, res) => {
    try {
        const userId = req.user?.id;
        const executionId = req.params.executionId;
        if (!userId)
            return res.status(401).json({ error: 'Not authenticated' });
        if (!executionId)
            return res.status(400).json({ error: 'Execution ID required' });
        const execution = await getExecution(executionId);
        if (!execution)
            return res.status(404).json({ error: 'Execution not found' });
        if (execution.user_id !== userId)
            return res.status(403).json({ error: 'Access denied' });
        res.json(execution);
    }
    catch (error) {
        console.error('[Skills API] Error polling execution:', error);
        res.status(500).json({ error: 'Failed to get execution status', details: error instanceof Error ? error.message : 'Unknown error' });
    }
});
async function executeSkillAsync(execution, skill) {
    const startTime = Date.now();
    const stepLog = [];
    let runSuccess = false;
    let runOutput = '';
    try {
        if (!isExtensionConnected(execution.user_id)) {
            throw new Error('Extension not connected. Open Unclawned in Chrome first.');
        }
        const validation = skillsApi.validatePlan(skill.execution_plan);
        if (!validation.valid) {
            throw new Error(`Skill plan is invalid: ${validation.errors.join('; ')}`);
        }
        if (validation.warnings?.length) {
            console.warn(`[Skills] Plan warnings for "${skill.skill_name}":`, validation.warnings);
        }
        const learnedImprovements = skill.learned_improvements
            ? JSON.parse(skill.learned_improvements)
            : [];
        const prompt = planToPrompt(skill.skill_name, skill.execution_plan, execution.input_values, learnedImprovements, {});
        const tabResult = await sendExtensionMessage(execution.user_id, 'createAndAttachTab', { url: 'about:blank' }, 60000);
        if (!tabResult?.tabId)
            throw new Error('Extension did not return a tab ID.');
        if (tabResult?.targetId)
            registerWorkingTab(execution.user_id, tabResult.targetId);
        await new Promise(r => setTimeout(r, 2000));
        const result = await runAgentLoop({
            userId: execution.user_id,
            taskId: execution.id,
            taskPrompt: prompt,
            tabKey: `skill-${execution.id}`,
            onProgress: async (msg) => {
                stepLog.push(msg);
                console.log(`[Skills Agent] ${msg}`);
            },
            preApproved: true,
            skillMode: true,
        });
        runSuccess = result.success;
        runOutput = result.summary || '';
        await updateExecution(execution.id, {
            status: result.success ? 'success' : 'error',
            execution_log: [{
                    stepNumber: 1, action: 'agent_loop',
                    status: result.success ? 'success' : 'error',
                    duration: Date.now() - startTime,
                    timestamp: new Date().toISOString(),
                }],
            final_url: '',
            error_message: result.success ? '' : result.summary,
            completed_at: new Date().toISOString(),
            duration_seconds: Math.round((Date.now() - startTime) / 1000),
        });
        // Update run stats
        db.prepare(`UPDATE skills SET run_count = run_count + 1, success_count = success_count + ? WHERE id = ?`)
            .run(result.success ? 1 : 0, skill.id);
    }
    catch (error) {
        console.error('[Skills] Execution failed:', error);
        runOutput = error instanceof Error ? error.message : 'Unknown error';
        await updateExecution(execution.id, {
            status: 'error',
            error_message: runOutput,
            completed_at: new Date().toISOString(),
        }).catch(e => console.error('Failed to update execution:', e));
    }
    finally {
        await sendExtensionMessage(execution.user_id, 'detachAllTabs', {}).catch(() => { });
    }
    // Post-run improvement pass (best-effort — never crashes the execution record)
    if (stepLog.length > 0) {
        try {
            const learnedImprovements = skill.learned_improvements
                ? JSON.parse(skill.learned_improvements)
                : [];
            const analysis = await skillsApi.improveSkillAfterRun(skill.skill_description || skill.skill_name, 'browser', skill.execution_plan, null, null, stepLog, runOutput, runSuccess, learnedImprovements);
            if (analysis.newLearning) {
                const entries = analysis.newLearning.split('\n').map(l => l.trim()).filter(Boolean);
                learnedImprovements.push(...entries);
                db.prepare(`UPDATE skills SET learned_improvements = ? WHERE id = ?`)
                    .run(JSON.stringify(learnedImprovements), skill.id);
            }
            if (analysis.stepUpdates?.length) {
                const patchedPlan = skillsApi.applyStepUpdates(skill.execution_plan, analysis.stepUpdates);
                await updateSkillPlan(skill.id, patchedPlan, `auto-improvement after ${runSuccess ? 'successful' : 'failed'} run`);
                console.log(`[Skills] ${analysis.stepUpdates.length} step patch(es) applied (version bumped).`);
            }
            else if (analysis.updatedPlan) {
                await updateSkillPlan(skill.id, analysis.updatedPlan, 'full plan improvement after run');
                console.log('[Skills] Plan structurally improved (version bumped).');
            }
        }
        catch (e) {
            console.warn('[Skills] Post-run improvement failed (non-fatal):', e.message);
        }
    }
}
router.post('/plan-chat-message', async (req, res) => {
    const userId = req.user?.id;
    if (!userId)
        return res.status(401).json({ error: 'Not authenticated' });
    const { discussionId, userMessage, currentPlan, messageHistory } = req.body;
    if (!discussionId || !userMessage)
        return res.status(400).json({ error: 'Missing required fields' });
    try {
        const planJson = JSON.stringify(currentPlan, null, 2);
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            max_tokens: 2000,
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: `You are helping a user refine a browser automation skill plan.

Current plan (JSON):
${planJson}

The user may ask questions, request changes to steps, or confirm they're ready to save.

Return JSON with exactly these two fields:
{
  "reply": "Your conversational response (2-3 sentences max)",
  "updatedPlan": <the full modified plan JSON if the user requested a change, otherwise null>
}

If you modify the plan, return the COMPLETE updated plan object — not just the changed steps.
If the user is only asking a question or chatting, set updatedPlan to null.
Keep the plan's existing structure: steps array, variables, estimatedTime, errorHandling.
For step changes, keep all existing fields on unchanged steps.
LOCATOR RULES: use Playwright accessibility locators only (getByRole, getByLabel, getByText, getByPlaceholder). Never CSS selectors.`
                },
                ...(messageHistory || []).map((m) => ({ role: m.role, content: m.content })),
                { role: 'user', content: userMessage }
            ]
        });
        const raw = response.choices[0].message.content || '{}';
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            parsed = { reply: raw, updatedPlan: null };
        }
        const aiResponse = parsed.reply || '';
        const updatedPlan = parsed.updatedPlan || null;
        const skillNameMatch = aiResponse.match(/(?:name it|call it|named?)\s+['"]?([^'".,!?]+)['"]?/i);
        const suggestedSkillName = skillNameMatch ? skillNameMatch[1].trim() : null;
        try {
            db.prepare('INSERT INTO chat_messages (id, chat_id, user_id, role, content, skill_id, discussion_type, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
                .run(uuid(), discussionId, userId, 'user', userMessage, 'skill', new Date().toISOString());
            db.prepare('INSERT INTO chat_messages (id, chat_id, user_id, role, content, skill_id, discussion_type, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
                .run(uuid(), discussionId, userId, 'assistant', aiResponse, 'skill', new Date().toISOString());
        }
        catch { }
        res.json({ aiResponse, suggestedSkillName, updatedPlan: updatedPlan ?? currentPlan });
    }
    catch (error) {
        console.error('[plan-chat-message] Error:', error);
        res.status(500).json({ error: 'Failed to process message' });
    }
});
router.post('/approve-and-save', async (req, res) => {
    const userId = req.user?.id;
    if (!userId)
        return res.status(401).json({ error: 'Not authenticated' });
    const { discussionId, skillName, skillDescription, plan, variables } = req.body;
    if (!skillName || !plan)
        return res.status(400).json({ error: 'Missing required fields' });
    try {
        const skill = await saveSkill(userId, {
            skill_name: skillName.trim(),
            skill_description: (skillDescription || '').trim(),
            execution_plan: plan,
            status: 'active'
        });
        if (variables && variables.length > 0) {
            for (const v of variables) {
                await saveInputVariable(skill.id, {
                    variable_name: v.name, variable_type: v.type || 'text',
                    description: v.description || '', is_required: v.required || false
                });
            }
        }
        if (discussionId) {
            try {
                db.prepare('UPDATE chat_messages SET skill_id = ? WHERE chat_id = ?').run(skill.id, discussionId);
            }
            catch { }
        }
        indexSkillAsync(skill.id, skillName.trim(), (skillDescription || '').trim(), 'browser', plan, null, null);
        res.json({ skillId: skill.id, skillName: skill.skill_name, message: 'Skill saved! Ready to execute.' });
    }
    catch (error) {
        console.error('[approve-and-save] Error:', error);
        res.status(500).json({ error: 'Failed to save skill' });
    }
});
export default router;
