import { Router, Request, Response } from 'express'
import OpenAI from 'openai'
import { authenticateUser } from '../middleware/auth.js'
import { skillsApi } from '../lib/skills-api.js'
import {
  saveSkill,
  getSkill,
  listSkills,
  createExecution,
  getExecution,
  updateExecution,
  saveInputVariable,
  updateSkillPlan,
  createSkillProposal,
  listSkillProposals,
  getSkillProposal,
  resolveSkillProposal,
  listSkillSuggestions,
  getSkillSuggestion,
  resolveSkillSuggestion,
  listSkillDrafts,
  getSkillDraft,
  resolveSkillDraft,
  isSkillPinned,
  setSkillPinned,
} from '../db/queries.js'
import { Skill, SkillExecution } from '../lib/types.js'
import { runAgentLoop, registerWorkingTab } from '../lib/agent-extension.js'
import { sendExtensionMessage, isExtensionConnected } from '../lib/extension-state.js'
import { db, uuid } from '../lib/db.js'
import { planToPrompt } from '../lib/cli-skill-creator.js'
import { indexSkillAsync } from '../lib/skill-index.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const router = Router()

router.use(authenticateUser)

router.post('/create-plan', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })

    const { skillDescription, answers } = req.body
    if (!skillDescription || skillDescription.trim().length < 20) return res.status(400).json({ error: 'Skill description required (min 20 characters)' })
    if (skillDescription.trim().length > 1000) return res.status(400).json({ error: 'Skill description too long (max 1000 characters)' })

    console.log(`[Skills API] Generating plan for: ${skillDescription.substring(0, 50)}...`)
    const { plan, questions, inputs } = await skillsApi.generatePlan(skillDescription, answers || {})

    res.json({ success: true, plan, questions: questions && questions.length > 0 ? questions : [], inputs })
  } catch (error) {
    console.error('[Skills API] Error generating plan:', error)
    res.status(500).json({ error: 'Failed to generate plan', details: error instanceof Error ? error.message : 'Unknown error' })
  }
})

router.post('/save', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })

    const { skillName, skillDescription, plan, inputs } = req.body
    if (!skillName || skillName.trim().length === 0) return res.status(400).json({ error: 'Skill name is required' })
    if (!skillDescription || skillDescription.trim().length === 0) return res.status(400).json({ error: 'Skill description is required' })
    if (!plan || !plan.steps || plan.steps.length === 0) return res.status(400).json({ error: 'Valid execution plan is required' })

    const existingSkills = await listSkills(userId)
    if (existingSkills.some((s: any) => s.skill_name.toLowerCase() === skillName.toLowerCase())) {
      return res.status(409).json({ error: 'A skill with this name already exists' })
    }

    console.log(`[Skills API] Saving skill: ${skillName}`)
    const skill = await saveSkill(userId, { skill_name: skillName, skill_description: skillDescription, execution_plan: plan, status: 'active' })

    if (inputs && inputs.length > 0) {
      for (const input of inputs) await saveInputVariable(skill.id, input)
    }

    indexSkillAsync(skill.id, skillName, skillDescription || '', 'browser', plan, null, null)

    res.json({ success: true, skillId: skill.id, message: 'Skill saved successfully' })
  } catch (error) {
    console.error('[Skills API] Error saving skill:', error)
    res.status(500).json({ error: 'Failed to save skill', details: error instanceof Error ? error.message : 'Unknown error' })
  }
})

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const includeArchived = req.query.include_archived === 'true'
    // Fire lifecycle check lazily — archives skills unused for 90+ days before returning the list
    import('../lib/skill-lifecycle.js').then(m => m.checkSkillLifecycle(userId)).catch(() => {})
    const skills = await listSkills(userId, includeArchived)
    res.json(skills)
  } catch (error) {
    console.error('[Skills API] Error listing skills:', error)
    res.status(500).json({ error: 'Failed to list skills', details: error instanceof Error ? error.message : 'Unknown error' })
  }
})

// ── Skill suggestions (must be before /:skillId to avoid route shadowing) ──────

router.get('/suggestions', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const status = (req.query.status as string) || 'pending'
    res.json(listSkillSuggestions(userId, status))
  } catch {
    res.status(500).json({ error: 'Failed to list suggestions' })
  }
})

// ── Improvement proposals (must be before /:skillId to avoid route shadowing) ──

router.get('/proposals', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const status = (req.query.status as string) || 'pending'
    res.json(listSkillProposals(userId, status))
  } catch {
    res.status(500).json({ error: 'Failed to list proposals' })
  }
})

router.get('/proposals/:proposalId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const proposal = getSkillProposal(String(req.params.proposalId))
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' })
    if (proposal.user_id !== userId) return res.status(403).json({ error: 'Access denied' })
    // Include current skill plan so the frontend can render a before/after diff
    const skill = await getSkill(proposal.skill_id)
    res.json({ ...proposal, current_plan: skill?.execution_plan ?? null })
  } catch {
    res.status(500).json({ error: 'Failed to get proposal' })
  }
})

// ── Skill drafts (background auto-creation, must be before /:skillId) ────────

router.get('/drafts', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const status = (req.query.status as string) || 'pending'
    res.json(listSkillDrafts(userId, status))
  } catch {
    res.status(500).json({ error: 'Failed to list drafts' })
  }
})

router.get('/drafts/:draftId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const draft = getSkillDraft(String(req.params.draftId))
    if (!draft) return res.status(404).json({ error: 'Draft not found' })
    if (draft.user_id !== userId) return res.status(403).json({ error: 'Access denied' })
    res.json(draft)
  } catch {
    res.status(500).json({ error: 'Failed to get draft' })
  }
})

// ── Restore archived skill ────────────────────────────────────────────────────

router.post('/:skillId/restore', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    const skillId = req.params.skillId as string
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const skill = await getSkill(skillId)
    if (!skill) return res.status(404).json({ error: 'Skill not found' })
    if (skill.user_id !== userId) return res.status(403).json({ error: 'Access denied' })
    db.prepare("UPDATE skills SET status = 'active', last_run_at = datetime('now') WHERE id = ?").run(skillId)
    res.json({ success: true, status: 'active' })
  } catch {
    res.status(500).json({ error: 'Failed to restore skill' })
  }
})

// ── Pin / Unpin ───────────────────────────────────────────────────────────────

router.post('/:skillId/pin', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    const skillId = req.params.skillId as string
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const skill = await getSkill(skillId)
    if (!skill) return res.status(404).json({ error: 'Skill not found' })
    if (skill.user_id !== userId) return res.status(403).json({ error: 'Access denied' })
    setSkillPinned(skillId, true)
    res.json({ success: true, pinned: true })
  } catch {
    res.status(500).json({ error: 'Failed to pin skill' })
  }
})

router.delete('/:skillId/pin', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    const skillId = req.params.skillId as string
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const skill = await getSkill(skillId)
    if (!skill) return res.status(404).json({ error: 'Skill not found' })
    if (skill.user_id !== userId) return res.status(403).json({ error: 'Access denied' })
    setSkillPinned(skillId, false)
    res.json({ success: true, pinned: false })
  } catch {
    res.status(500).json({ error: 'Failed to unpin skill' })
  }
})

// ── Skill by ID ───────────────────────────────────────────────────────────────

router.get('/:skillId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    const skillId = req.params.skillId as string
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    if (!skillId) return res.status(400).json({ error: 'Skill ID required' })

    const skill = await getSkill(skillId)
    if (!skill) return res.status(404).json({ error: 'Skill not found' })
    if (skill.user_id !== userId && !skill.is_public) return res.status(403).json({ error: 'Access denied' })

    res.json(skill)
  } catch (error) {
    console.error('[Skills API] Error getting skill:', error)
    res.status(500).json({ error: 'Failed to get skill', details: error instanceof Error ? error.message : 'Unknown error' })
  }
})

router.post('/:skillId/execute', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    const skillId = req.params.skillId as string
    const { inputValues } = req.body
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    if (!skillId) return res.status(400).json({ error: 'Skill ID required' })
    if (!inputValues || typeof inputValues !== 'object') return res.status(400).json({ error: 'Input values object required' })

    const skill = await getSkill(skillId)
    if (!skill) return res.status(404).json({ error: 'Skill not found' })
    if (skill.user_id !== userId) return res.status(403).json({ error: 'Access denied' })

    const execution = await createExecution(skillId, userId, inputValues)

    executeSkillAsync(execution, skill).catch(err => {
      console.error('[Skills Executor] Execution error:', err)
      updateExecution(execution.id, { status: 'error', error_message: err.message, completed_at: new Date().toISOString() })
        .catch(e => console.error('Failed to update execution:', e))
    })

    res.json({ success: true, executionId: execution.id, status: 'running', message: 'Skill execution started' })
  } catch (error) {
    console.error('[Skills API] Error starting execution:', error)
    res.status(500).json({ error: 'Failed to start execution', details: error instanceof Error ? error.message : 'Unknown error' })
  }
})

router.get('/:skillId/executions/:executionId', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    const executionId = req.params.executionId as string
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    if (!executionId) return res.status(400).json({ error: 'Execution ID required' })

    const execution = await getExecution(executionId)
    if (!execution) return res.status(404).json({ error: 'Execution not found' })
    if (execution.user_id !== userId) return res.status(403).json({ error: 'Access denied' })

    res.json(execution)
  } catch (error) {
    console.error('[Skills API] Error polling execution:', error)
    res.status(500).json({ error: 'Failed to get execution status', details: error instanceof Error ? error.message : 'Unknown error' })
  }
})

async function executeSkillAsync(execution: SkillExecution, skill: Skill): Promise<void> {
  const startTime = Date.now()
  const stepLog: string[] = []
  let runSuccess = false
  let runOutput = ''

  try {
    if (!isExtensionConnected(execution.user_id)) {
      throw new Error('Extension not connected. Open Unclawned in Chrome first.')
    }

    const validation = skillsApi.validatePlan(skill.execution_plan)
    if (!validation.valid) {
      throw new Error(`Skill plan is invalid: ${validation.errors.join('; ')}`)
    }
    if (validation.warnings?.length) {
      console.warn(`[Skills] Plan warnings for "${skill.skill_name}":`, validation.warnings)
    }

    const learnedImprovements: string[] = skill.learned_improvements
      ? JSON.parse(skill.learned_improvements)
      : []

    const prompt = planToPrompt(skill.skill_name, skill.execution_plan, execution.input_values, learnedImprovements, {})

    const tabResult = await sendExtensionMessage(execution.user_id, 'createAndAttachTab', { url: 'about:blank' }, 60000) as any
    if (!tabResult?.tabId) throw new Error('Extension did not return a tab ID.')
    if (tabResult?.targetId) registerWorkingTab(execution.user_id, tabResult.targetId)
    await new Promise(r => setTimeout(r, 2000))

    const result = await runAgentLoop({
      userId: execution.user_id,
      taskId: execution.id,
      taskPrompt: prompt,
      tabKey: `skill-${execution.id}`,
      onProgress: async (msg) => {
        stepLog.push(msg)
        console.log(`[Skills Agent] ${msg}`)
      },
      preApproved: true,
      skillMode: true,
      skillId: skill.id,
      toolSet: 'browser',
      richContext: false,
    })

    runSuccess = result.success
    runOutput = result.summary || ''

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
    })

    // Update run stats and last_run_at
    db.prepare(`UPDATE skills SET run_count = run_count + 1, success_count = success_count + ?, last_run_at = datetime('now') WHERE id = ?`)
      .run(result.success ? 1 : 0, skill.id)

    // Staleness check — fire-and-forget, never blocks the response
    import('../lib/skill-staleness.js')
      .then(m => m.checkSkillStalenessAsync(skill.id, result.success))
      .catch(() => {})

  } catch (error) {
    console.error('[Skills] Execution failed:', error)
    runOutput = error instanceof Error ? error.message : 'Unknown error'
    await updateExecution(execution.id, {
      status: 'error',
      error_message: runOutput,
      completed_at: new Date().toISOString(),
    }).catch(e => console.error('Failed to update execution:', e))
    import('../lib/skill-staleness.js')
      .then(m => m.checkSkillStalenessAsync(skill.id, false))
      .catch(() => {})
  } finally {
    await sendExtensionMessage(execution.user_id, 'detachAllTabs', {}).catch(() => {})
  }

  // Post-run improvement analysis — stage proposals for user review, never auto-apply
  // Pinned skills are exempt from all autonomous mutations
  if (stepLog.length > 0 && !isSkillPinned(skill.id)) {
    try {
      const learnedImprovements: string[] = skill.learned_improvements
        ? JSON.parse(skill.learned_improvements)
        : []

      const skillType = (skill as any).skill_type || 'browser'
      const analysis = await skillsApi.improveSkillAfterRun(
        skill.skill_description || skill.skill_name,
        skillType as 'browser' | 'chat' | 'hybrid',
        skillType === 'browser' ? skill.execution_plan : null,
        skillType === 'chat' ? (skill as any).chat_template : null,
        skillType === 'hybrid' ? (skill as any).hybrid_plan : null,
        stepLog,
        runOutput,
        runSuccess,
        learnedImprovements
      )

      // new_learning is low-risk text notes — append immediately
      if (analysis.newLearning) {
        const entries = analysis.newLearning.split('\n').map((l: string) => l.trim()).filter(Boolean)
        learnedImprovements.push(...entries)
        db.prepare(`UPDATE skills SET learned_improvements = ? WHERE id = ?`)
          .run(JSON.stringify(learnedImprovements), skill.id)
      }

      // Plan changes go to a staging queue — user must approve before applying
      const hasChanges = (analysis.stepUpdates?.length > 0) || !!analysis.updatedPlan
      if (hasChanges) {
        createSkillProposal({
          user_id: execution.user_id,
          skill_id: skill.id,
          execution_id: execution.id,
          summary: analysis.summary || null,
          issues: analysis.issues || [],
          suggestions: analysis.suggestions || [],
          step_updates: analysis.stepUpdates || [],
          updated_plan: analysis.updatedPlan || null,
          new_learning: null, // already applied above
        })
        console.log(`[Skills] Improvement proposal staged for "${skill.skill_name}" (${analysis.stepUpdates?.length ?? 0} step patches)`)
      }
    } catch (e) {
      console.warn('[Skills] Post-run improvement analysis failed (non-fatal):', (e as Error).message)
    }
  }
}


router.post('/plan-chat-message', async (req: Request, res: Response) => {
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Not authenticated' })

  const { discussionId, userMessage, currentPlan, messageHistory } = req.body
  if (!discussionId || !userMessage) return res.status(400).json({ error: 'Missing required fields' })

  try {
    const planJson = JSON.stringify(currentPlan, null, 2)

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
        ...(messageHistory || []).map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user', content: userMessage }
      ]
    })

    const raw = response.choices[0].message.content || '{}'
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = { reply: raw, updatedPlan: null }
    }

    const aiResponse: string = parsed.reply || ''
    const updatedPlan = parsed.updatedPlan || null

    const skillNameMatch = aiResponse.match(/(?:name it|call it|named?)\s+['"]?([^'".,!?]+)['"]?/i)
    const suggestedSkillName = skillNameMatch ? skillNameMatch[1].trim() : null

    try {
      db.prepare('INSERT INTO chat_messages (id, chat_id, user_id, role, content, skill_id, discussion_type, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
        .run(uuid(), discussionId, userId, 'user', userMessage, 'skill', new Date().toISOString())
      db.prepare('INSERT INTO chat_messages (id, chat_id, user_id, role, content, skill_id, discussion_type, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
        .run(uuid(), discussionId, userId, 'assistant', aiResponse, 'skill', new Date().toISOString())
    } catch {}

    res.json({ aiResponse, suggestedSkillName, updatedPlan: updatedPlan ?? currentPlan })
  } catch (error) {
    console.error('[plan-chat-message] Error:', error)
    res.status(500).json({ error: 'Failed to process message' })
  }
})

router.post('/approve-and-save', async (req: Request, res: Response) => {
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Not authenticated' })

  const { discussionId, skillName, skillDescription, plan, variables } = req.body
  if (!skillName || !plan) return res.status(400).json({ error: 'Missing required fields' })

  try {
    const skill = await saveSkill(userId, {
      skill_name: skillName.trim(),
      skill_description: (skillDescription || '').trim(),
      execution_plan: plan,
      status: 'active'
    })

    if (variables && variables.length > 0) {
      for (const v of variables) {
        await saveInputVariable(skill.id, {
          variable_name: v.name, variable_type: v.type || 'text',
          description: v.description || '', is_required: v.required || false
        })
      }
    }

    if (discussionId) {
      try {
        db.prepare('UPDATE chat_messages SET skill_id = ? WHERE chat_id = ?').run(skill.id, discussionId)
      } catch {}
    }

    indexSkillAsync(skill.id, skillName.trim(), (skillDescription || '').trim(), 'browser', plan, null, null)

    res.json({ skillId: skill.id, skillName: skill.skill_name, message: 'Skill saved! Ready to execute.' })
  } catch (error) {
    console.error('[approve-and-save] Error:', error)
    res.status(500).json({ error: 'Failed to save skill' })
  }
})

// ── Skill suggestions (post-task auto-detect) ─────────────────────────────────

router.post('/suggestions/:suggestionId/accept', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const suggestion = getSkillSuggestion(String(req.params.suggestionId))
    if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' })
    if (suggestion.user_id !== userId) return res.status(403).json({ error: 'Access denied' })
    if (suggestion.status !== 'pending') return res.status(409).json({ error: `Already ${suggestion.status}` })
    resolveSkillSuggestion(suggestion.id, 'accepted')
    // Return pre-filled data for the creation wizard — frontend handles the rest
    res.json({
      success: true,
      prefill: {
        name: suggestion.suggested_name,
        description: suggestion.suggested_description,
        skillType: suggestion.skill_type,
      },
    })
  } catch {
    res.status(500).json({ error: 'Failed to accept suggestion' })
  }
})

router.post('/suggestions/:suggestionId/dismiss', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })
    const suggestion = getSkillSuggestion(String(req.params.suggestionId))
    if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' })
    if (suggestion.user_id !== userId) return res.status(403).json({ error: 'Access denied' })
    resolveSkillSuggestion(suggestion.id, 'dismissed')
    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Failed to dismiss suggestion' })
  }
})

// ── Improvement proposals ─────────────────────────────────────────────────────

router.post('/proposals/:proposalId/apply', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })

    const proposal = getSkillProposal(String(req.params.proposalId))
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' })
    if (proposal.user_id !== userId) return res.status(403).json({ error: 'Access denied' })
    if (proposal.status !== 'pending') return res.status(409).json({ error: `Proposal already ${proposal.status}` })

    const skill = await getSkill(proposal.skill_id)
    if (!skill) return res.status(404).json({ error: 'Skill not found' })

    if (proposal.step_updates?.length > 0) {
      const patched = skillsApi.applyStepUpdates(skill.execution_plan, proposal.step_updates)
      await updateSkillPlan(skill.id, patched, `user-approved improvement (${proposal.step_updates.length} patch${proposal.step_updates.length === 1 ? '' : 'es'})`)
    } else if (proposal.updated_plan) {
      await updateSkillPlan(skill.id, proposal.updated_plan, 'user-approved structural improvement')
    }

    resolveSkillProposal(proposal.id, 'applied')
    res.json({ success: true, message: 'Improvements applied.' })
  } catch (error) {
    console.error('[proposals/apply]', error)
    res.status(500).json({ error: 'Failed to apply proposal' })
  }
})

router.post('/proposals/:proposalId/skip', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })

    const proposal = getSkillProposal(String(req.params.proposalId))
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' })
    if (proposal.user_id !== userId) return res.status(403).json({ error: 'Access denied' })
    if (proposal.status !== 'pending') return res.status(409).json({ error: `Proposal already ${proposal.status}` })

    resolveSkillProposal(proposal.id, 'skipped')
    res.json({ success: true, message: 'Proposal skipped.' })
  } catch (error) {
    res.status(500).json({ error: 'Failed to skip proposal' })
  }
})

// ── Skill draft actions ───────────────────────────────────────────────────────

router.post('/drafts/:draftId/create', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })

    const draft = getSkillDraft(String(req.params.draftId))
    if (!draft) return res.status(404).json({ error: 'Draft not found' })
    if (draft.user_id !== userId) return res.status(403).json({ error: 'Access denied' })
    if (draft.status !== 'pending') return res.status(409).json({ error: `Draft already ${draft.status}` })

    // Allow name/description overrides from the user before creating
    const name = (req.body?.name || draft.draft_name).trim()
    const description = (req.body?.description || draft.draft_description).trim()

    const skill = await saveSkill(userId, {
      skill_name: name,
      skill_description: description,
      execution_plan: draft.execution_plan,
      status: 'active',
    })

    resolveSkillDraft(draft.id, 'created')
    indexSkillAsync(skill.id, name, description, draft.skill_type as any, draft.execution_plan, null, null)

    res.json({ success: true, skill })
  } catch (error) {
    console.error('[drafts/create]', error)
    res.status(500).json({ error: 'Failed to create skill from draft' })
  }
})

router.post('/drafts/:draftId/dismiss', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ error: 'Not authenticated' })

    const draft = getSkillDraft(String(req.params.draftId))
    if (!draft) return res.status(404).json({ error: 'Draft not found' })
    if (draft.user_id !== userId) return res.status(403).json({ error: 'Access denied' })

    resolveSkillDraft(draft.id, 'dismissed')
    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Failed to dismiss draft' })
  }
})

export default router
