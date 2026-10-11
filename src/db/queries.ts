import { db, uuid, j, p } from '../lib/db.js'
import {
  Skill,
  InputVariable,
  SkillExecution,
  StepUpdate,
  CreateSkillInput,
  CreateInputVariableInput,
  ExecutionPlan,
} from '../lib/types.js'

function rowToSkill(row: any): any {
  if (!row) return null
  return { ...row, execution_plan: p(row.execution_plan), is_public: Boolean(row.is_public) }
}

function rowToExecution(row: any): any {
  if (!row) return null
  return { ...row, input_values: p(row.input_values) ?? {}, execution_log: p(row.execution_log) ?? [] }
}

// ============================================
// SKILLS QUERIES
// ============================================

export async function saveSkill(userId: string, skill: CreateSkillInput): Promise<Skill> {
  const id = uuid()
  db.prepare(`
    INSERT INTO skills (id, user_id, skill_name, skill_description, execution_plan, status, is_public, plan_approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId, skill.skill_name, skill.skill_description ?? null,
    j(skill.execution_plan), skill.status || 'active',
    (skill as any).is_public ? 1 : 0, new Date().toISOString()
  )
  return rowToSkill(db.prepare('SELECT * FROM skills WHERE id = ?').get(id)) as Skill
}

export async function getSkill(skillId: string): Promise<Skill | null> {
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as any
  if (!row) return null
  const variables = db.prepare('SELECT * FROM skill_input_variables WHERE skill_id = ?').all(skillId)
  return { ...rowToSkill(row), variables }
}

export async function listSkills(userId: string, includeArchived = false): Promise<Skill[]> {
  const sql = includeArchived
    ? 'SELECT * FROM skills WHERE user_id = ? ORDER BY created_at DESC'
    : "SELECT * FROM skills WHERE user_id = ? AND (status IS NULL OR status != 'archived') ORDER BY created_at DESC"
  const rows = db.prepare(sql).all(userId) as any[]
  return rows.map(row => ({
    ...rowToSkill(row),
    variables: db.prepare('SELECT * FROM skill_input_variables WHERE skill_id = ?').all(row.id)
  }))
}

export async function updateSkill(skillId: string, updates: Partial<Skill>): Promise<Skill> {
  const allowed = ['skill_name', 'skill_description', 'execution_plan', 'status', 'is_public'] as const
  const sets: string[] = []
  const vals: any[] = []
  for (const key of allowed) {
    if (key in updates) {
      sets.push(`${key} = ?`)
      vals.push(key === 'execution_plan' ? j((updates as any)[key]) : (updates as any)[key])
    }
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`).run(...vals, skillId)
  }
  return rowToSkill(db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId)) as Skill
}

export async function deleteSkill(skillId: string): Promise<void> {
  db.prepare('DELETE FROM skills WHERE id = ?').run(skillId)
}

export interface SkillVersion {
  id: string
  skill_id: string
  version: number
  execution_plan: ExecutionPlan
  changed_at: string
  change_reason: string | null
}

export async function updateSkillPlan(
  skillId: string,
  newPlan: ExecutionPlan,
  changeReason: string
): Promise<Skill> {
  const current = db.prepare('SELECT version, execution_plan FROM skills WHERE id = ?').get(skillId) as any
  if (!current) throw new Error(`Skill ${skillId} not found`)

  const currentVersion = current.version ?? 1
  const currentPlan = current.execution_plan

  // Save current version before overwriting
  if (currentPlan) {
    db.prepare(`
      INSERT INTO skill_versions (id, skill_id, version, execution_plan, changed_at, change_reason)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
    `).run(uuid(), skillId, currentVersion, currentPlan, changeReason)
  }

  // Update plan and bump version
  db.prepare(`UPDATE skills SET execution_plan = ?, version = ? WHERE id = ?`)
    .run(j(newPlan), currentVersion + 1, skillId)

  return rowToSkill(db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId)) as Skill
}

export function getSkillVersions(skillId: string): SkillVersion[] {
  const rows = db.prepare(
    'SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC'
  ).all(skillId) as any[]
  return rows.map(r => ({ ...r, execution_plan: p(r.execution_plan) }))
}

export async function rollbackSkillToVersion(skillId: string, versionId: string): Promise<Skill> {
  const version = db.prepare('SELECT * FROM skill_versions WHERE id = ? AND skill_id = ?')
    .get(versionId, skillId) as any
  if (!version) throw new Error('Version not found')
  return updateSkillPlan(skillId, p(version.execution_plan), `Rollback to version ${version.version}`)
}

// ============================================
// INPUT VARIABLES QUERIES
// ============================================

export async function saveInputVariable(skillId: string, variable: CreateInputVariableInput): Promise<InputVariable> {
  const id = uuid()
  db.prepare(`
    INSERT INTO skill_input_variables (id, skill_id, variable_name, variable_type, description, is_required, default_value)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, skillId, variable.variable_name, variable.variable_type ?? null,
    variable.description ?? null, variable.is_required ? 1 : 0, variable.default_value ?? null
  )
  return db.prepare('SELECT * FROM skill_input_variables WHERE id = ?').get(id) as unknown as InputVariable
}

export async function getInputVariables(skillId: string): Promise<InputVariable[]> {
  return db.prepare('SELECT * FROM skill_input_variables WHERE skill_id = ?').all(skillId) as unknown as InputVariable[]
}

// ============================================
// EXECUTIONS QUERIES
// ============================================

export async function createExecution(skillId: string, userId: string, inputValues: Record<string, string>): Promise<SkillExecution> {
  const id = uuid()
  db.prepare(`
    INSERT INTO skill_executions (id, skill_id, user_id, input_values, status, execution_log)
    VALUES (?, ?, ?, ?, 'running', '[]')
  `).run(id, skillId, userId, j(inputValues))
  return rowToExecution(db.prepare('SELECT * FROM skill_executions WHERE id = ?').get(id)) as SkillExecution
}

export async function getExecution(executionId: string): Promise<SkillExecution | null> {
  const row = db.prepare('SELECT * FROM skill_executions WHERE id = ?').get(executionId) as any
  return row ? rowToExecution(row) : null
}

export async function updateExecution(executionId: string, updates: Partial<SkillExecution>): Promise<SkillExecution> {
  const allowed = ['status', 'execution_log', 'final_url', 'error_message', 'completed_at', 'duration_seconds'] as const
  const sets: string[] = []
  const vals: any[] = []
  for (const key of allowed) {
    if (key in updates) {
      sets.push(`${key} = ?`)
      vals.push(key === 'execution_log' ? j((updates as any)[key]) : (updates as any)[key])
    }
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE skill_executions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, executionId)
  }
  return rowToExecution(db.prepare('SELECT * FROM skill_executions WHERE id = ?').get(executionId)) as SkillExecution
}

export async function appendExecutionLog(executionId: string, logEntry: StepUpdate): Promise<void> {
  const execution = await getExecution(executionId)
  if (!execution) throw new Error('Execution not found')
  await updateExecution(executionId, { execution_log: [...(execution.execution_log || []), logEntry] })
}

export async function getExecutionHistory(skillId: string, limit = 50): Promise<SkillExecution[]> {
  const rows = db.prepare('SELECT * FROM skill_executions WHERE skill_id = ? ORDER BY started_at DESC LIMIT ?').all(skillId, limit) as any[]
  return rows.map(rowToExecution)
}

// ============================================
// SKILL SUGGESTIONS
// ============================================

export interface SkillSuggestion {
  id: string
  user_id: string
  suggested_name: string
  suggested_description: string
  skill_type: 'browser' | 'chat' | 'hybrid'
  source_task: string
  tool_call_count: number
  status: 'pending' | 'accepted' | 'dismissed'
  created_at: string
  resolved_at: string | null
}

export function createSkillSuggestion(s: Omit<SkillSuggestion, 'id' | 'status' | 'created_at' | 'resolved_at'>): SkillSuggestion {
  const id = uuid()
  db.prepare(`
    INSERT INTO skill_suggestions
      (id, user_id, suggested_name, suggested_description, skill_type, source_task, tool_call_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, s.user_id, s.suggested_name, s.suggested_description, s.skill_type, s.source_task, s.tool_call_count)
  return db.prepare('SELECT * FROM skill_suggestions WHERE id = ?').get(id) as SkillSuggestion
}

export function listSkillSuggestions(userId: string, status = 'pending'): SkillSuggestion[] {
  return db.prepare(`
    SELECT * FROM skill_suggestions
    WHERE user_id = ? AND status = ?
    ORDER BY created_at DESC
  `).all(userId, status) as SkillSuggestion[]
}

export function getSkillSuggestion(id: string): SkillSuggestion | null {
  return db.prepare('SELECT * FROM skill_suggestions WHERE id = ?').get(id) as SkillSuggestion | null
}

export function resolveSkillSuggestion(id: string, status: 'accepted' | 'dismissed'): void {
  db.prepare(`
    UPDATE skill_suggestions SET status = ?, resolved_at = datetime('now') WHERE id = ?
  `).run(status, id)
}

export function hasPendingSuggestionForTask(userId: string, taskPrefix: string): boolean {
  const row = db.prepare(`
    SELECT id FROM skill_suggestions
    WHERE user_id = ? AND status = 'pending'
      AND source_task LIKE ?
    LIMIT 1
  `).get(userId, `${taskPrefix.slice(0, 60)}%`) as any
  return !!row
}

// ============================================
// SKILL IMPROVEMENT PROPOSALS
// ============================================

export interface SkillProposal {
  id: string
  user_id: string
  skill_id: string
  execution_id: string
  summary: string | null
  issues: string[]
  suggestions: string[]
  step_updates: any[]
  updated_plan: ExecutionPlan | null
  new_learning: string | null
  status: 'pending' | 'applied' | 'skipped'
  created_at: string
  resolved_at: string | null
}

function rowToProposal(row: any): SkillProposal {
  return {
    ...row,
    issues: p(row.issues) ?? [],
    suggestions: p(row.suggestions) ?? [],
    step_updates: p(row.step_updates) ?? [],
    updated_plan: p(row.updated_plan) ?? null,
  }
}

export function createSkillProposal(proposal: Omit<SkillProposal, 'id' | 'status' | 'created_at' | 'resolved_at'>): SkillProposal {
  const id = uuid()
  db.prepare(`
    INSERT INTO skill_improvement_proposals
      (id, user_id, skill_id, execution_id, summary, issues, suggestions, step_updates, updated_plan, new_learning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, proposal.user_id, proposal.skill_id, proposal.execution_id,
    proposal.summary ?? null,
    j(proposal.issues),
    j(proposal.suggestions),
    j(proposal.step_updates),
    proposal.updated_plan ? j(proposal.updated_plan) : null,
    proposal.new_learning ?? null,
  )
  return rowToProposal(db.prepare('SELECT * FROM skill_improvement_proposals WHERE id = ?').get(id))
}

export function listSkillProposals(userId: string, status = 'pending'): SkillProposal[] {
  const rows = db.prepare(`
    SELECT p.*, s.skill_name
    FROM skill_improvement_proposals p
    JOIN skills s ON s.id = p.skill_id
    WHERE p.user_id = ? AND p.status = ?
    ORDER BY p.created_at DESC
  `).all(userId, status) as any[]
  return rows.map(rowToProposal)
}

export function getSkillProposal(id: string): SkillProposal | null {
  const row = db.prepare('SELECT * FROM skill_improvement_proposals WHERE id = ?').get(id) as any
  return row ? rowToProposal(row) : null
}

export function resolveSkillProposal(id: string, status: 'applied' | 'skipped'): void {
  db.prepare(`
    UPDATE skill_improvement_proposals
    SET status = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).run(status, id)
}

// ============================================
// SKILL DRAFTS (background auto-creation)
// ============================================

export interface SkillDraft {
  id: string
  user_id: string
  draft_name: string
  draft_description: string
  skill_type: string
  execution_plan: any
  source_task: string
  tool_call_count: number | null
  status: 'pending' | 'created' | 'dismissed'
  created_at: string
  resolved_at: string | null
}

function rowToDraft(row: any): SkillDraft {
  return { ...row, execution_plan: p(row.execution_plan) }
}

export function createSkillDraft(input: {
  user_id: string
  draft_name: string
  draft_description: string
  skill_type: string
  execution_plan: any
  source_task: string
  tool_call_count: number
}): void {
  db.prepare(`
    INSERT INTO skill_drafts
      (id, user_id, draft_name, draft_description, skill_type, execution_plan, source_task, tool_call_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuid(), input.user_id, input.draft_name, input.draft_description,
    input.skill_type, j(input.execution_plan), input.source_task, input.tool_call_count
  )
}

export function listSkillDrafts(userId: string, status = 'pending'): SkillDraft[] {
  return (db.prepare(`
    SELECT * FROM skill_drafts WHERE user_id = ? AND status = ? ORDER BY created_at DESC
  `).all(userId, status) as any[]).map(rowToDraft)
}

export function getSkillDraft(id: string): SkillDraft | null {
  const row = db.prepare('SELECT * FROM skill_drafts WHERE id = ?').get(id) as any
  return row ? rowToDraft(row) : null
}

export function resolveSkillDraft(id: string, status: 'created' | 'dismissed'): void {
  db.prepare(`
    UPDATE skill_drafts SET status = ?, resolved_at = datetime('now') WHERE id = ?
  `).run(status, id)
}

export function hasPendingDraftForTask(userId: string, taskPrompt: string): boolean {
  const row = db.prepare(`
    SELECT id FROM skill_drafts
    WHERE user_id = ? AND status = 'pending' AND source_task LIKE ?
    LIMIT 1
  `).get(userId, `${taskPrompt.slice(0, 60)}%`) as any
  return !!row
}

// ============================================
// SKILL STALENESS
// ============================================

export interface RecentExecution {
  id: string
  status: string
  completed_at: string | null
}

export function getRecentSkillExecutions(skillId: string, limit = 10): RecentExecution[] {
  return db.prepare(`
    SELECT id, status, completed_at
    FROM skill_executions
    WHERE skill_id = ? AND status IN ('success', 'error')
    ORDER BY completed_at DESC
    LIMIT ?
  `).all(skillId, limit) as RecentExecution[]
}

export function countPendingPatchesPerStep(skillId: string): Record<number, number> {
  const rows = db.prepare(`
    SELECT step_updates FROM skill_improvement_proposals
    WHERE skill_id = ? AND status = 'pending'
  `).all(skillId) as any[]

  const counts: Record<number, number> = {}
  for (const row of rows) {
    const updates: any[] = p(row.step_updates) ?? []
    for (const u of updates) {
      const n = Number(u.stepNumber ?? u.step_number)
      if (!isNaN(n)) counts[n] = (counts[n] ?? 0) + 1
    }
  }
  return counts
}

export function setSkillStaleness(skillId: string, staleness: 'stale' | null, reason: string | null): void {
  db.prepare(`UPDATE skills SET staleness = ?, staleness_reason = ? WHERE id = ?`)
    .run(staleness, reason, skillId)
}

// ============================================
// SKILL SLASH COMMAND LOOKUP
// ============================================

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

export function findSkillBySlug(userId: string, slug: string): Skill | null {
  const rows = db.prepare(
    "SELECT * FROM skills WHERE user_id = ? AND (status IS NULL OR status != 'archived') ORDER BY created_at DESC"
  ).all(userId) as any[]

  const normalized = slugify(slug)

  const withVars = (row: any) => {
    const skill = rowToSkill(row) as any
    skill.variables = db.prepare('SELECT * FROM skill_input_variables WHERE skill_id = ?').all(row.id)
    return skill as Skill
  }

  // Exact slug match first
  const exact = rows.find(r => slugify(r.skill_name) === normalized)
  if (exact) return withVars(exact)

  // Prefix match (user typed partial slug)
  const prefix = rows.find(r => slugify(r.skill_name).startsWith(normalized))
  if (prefix) return withVars(prefix)

  // Substring match (slug appears anywhere in skill name slug)
  const sub = rows.find(r => slugify(r.skill_name).includes(normalized))
  if (sub) return withVars(sub)

  return null
}

// ============================================
// SKILL PIN
// ============================================

export function isSkillPinned(skillId: string): boolean {
  const row = db.prepare('SELECT pinned FROM skills WHERE id = ?').get(skillId) as any
  return !!(row?.pinned)
}

export function setSkillPinned(skillId: string, pinned: boolean): void {
  db.prepare('UPDATE skills SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, skillId)
}
