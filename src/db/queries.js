import { db, uuid, j, p } from '../lib/db.js';
function rowToSkill(row) {
    if (!row)
        return null;
    return { ...row, execution_plan: p(row.execution_plan), is_public: Boolean(row.is_public) };
}
function rowToExecution(row) {
    if (!row)
        return null;
    return { ...row, input_values: p(row.input_values) ?? {}, execution_log: p(row.execution_log) ?? [] };
}
// ============================================
// SKILLS QUERIES
// ============================================
export async function saveSkill(userId, skill) {
    const id = uuid();
    db.prepare(`
    INSERT INTO skills (id, user_id, skill_name, skill_description, execution_plan, status, is_public, plan_approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, skill.skill_name, skill.skill_description ?? null, j(skill.execution_plan), skill.status || 'active', skill.is_public ? 1 : 0, new Date().toISOString());
    return rowToSkill(db.prepare('SELECT * FROM skills WHERE id = ?').get(id));
}
export async function getSkill(skillId) {
    const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
    if (!row)
        return null;
    const variables = db.prepare('SELECT * FROM skill_input_variables WHERE skill_id = ?').all(skillId);
    return { ...rowToSkill(row), variables };
}
export async function listSkills(userId) {
    const rows = db.prepare('SELECT * FROM skills WHERE user_id = ? ORDER BY created_at DESC').all(userId);
    return rows.map(row => ({
        ...rowToSkill(row),
        variables: db.prepare('SELECT * FROM skill_input_variables WHERE skill_id = ?').all(row.id)
    }));
}
export async function updateSkill(skillId, updates) {
    const allowed = ['skill_name', 'skill_description', 'execution_plan', 'status', 'is_public'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
        if (key in updates) {
            sets.push(`${key} = ?`);
            vals.push(key === 'execution_plan' ? j(updates[key]) : updates[key]);
        }
    }
    if (sets.length > 0) {
        db.prepare(`UPDATE skills SET ${sets.join(', ')} WHERE id = ?`).run(...vals, skillId);
    }
    return rowToSkill(db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId));
}
export async function deleteSkill(skillId) {
    db.prepare('DELETE FROM skills WHERE id = ?').run(skillId);
}
export async function updateSkillPlan(skillId, newPlan, changeReason) {
    const current = db.prepare('SELECT version, execution_plan FROM skills WHERE id = ?').get(skillId);
    if (!current)
        throw new Error(`Skill ${skillId} not found`);
    const currentVersion = current.version ?? 1;
    const currentPlan = current.execution_plan;
    // Save current version before overwriting
    if (currentPlan) {
        db.prepare(`
      INSERT INTO skill_versions (id, skill_id, version, execution_plan, changed_at, change_reason)
      VALUES (?, ?, ?, ?, datetime('now'), ?)
    `).run(uuid(), skillId, currentVersion, currentPlan, changeReason);
    }
    // Update plan and bump version
    db.prepare(`UPDATE skills SET execution_plan = ?, version = ? WHERE id = ?`)
        .run(j(newPlan), currentVersion + 1, skillId);
    return rowToSkill(db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId));
}
export function getSkillVersions(skillId) {
    const rows = db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version DESC').all(skillId);
    return rows.map(r => ({ ...r, execution_plan: p(r.execution_plan) }));
}
export async function rollbackSkillToVersion(skillId, versionId) {
    const version = db.prepare('SELECT * FROM skill_versions WHERE id = ? AND skill_id = ?')
        .get(versionId, skillId);
    if (!version)
        throw new Error('Version not found');
    return updateSkillPlan(skillId, p(version.execution_plan), `Rollback to version ${version.version}`);
}
// ============================================
// INPUT VARIABLES QUERIES
// ============================================
export async function saveInputVariable(skillId, variable) {
    const id = uuid();
    db.prepare(`
    INSERT INTO skill_input_variables (id, skill_id, variable_name, variable_type, description, is_required, default_value)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, skillId, variable.variable_name, variable.variable_type ?? null, variable.description ?? null, variable.is_required ? 1 : 0, variable.default_value ?? null);
    return db.prepare('SELECT * FROM skill_input_variables WHERE id = ?').get(id);
}
export async function getInputVariables(skillId) {
    return db.prepare('SELECT * FROM skill_input_variables WHERE skill_id = ?').all(skillId);
}
// ============================================
// EXECUTIONS QUERIES
// ============================================
export async function createExecution(skillId, userId, inputValues) {
    const id = uuid();
    db.prepare(`
    INSERT INTO skill_executions (id, skill_id, user_id, input_values, status, execution_log)
    VALUES (?, ?, ?, ?, 'running', '[]')
  `).run(id, skillId, userId, j(inputValues));
    return rowToExecution(db.prepare('SELECT * FROM skill_executions WHERE id = ?').get(id));
}
export async function getExecution(executionId) {
    const row = db.prepare('SELECT * FROM skill_executions WHERE id = ?').get(executionId);
    return row ? rowToExecution(row) : null;
}
export async function updateExecution(executionId, updates) {
    const allowed = ['status', 'execution_log', 'final_url', 'error_message', 'completed_at', 'duration_seconds'];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
        if (key in updates) {
            sets.push(`${key} = ?`);
            vals.push(key === 'execution_log' ? j(updates[key]) : updates[key]);
        }
    }
    if (sets.length > 0) {
        db.prepare(`UPDATE skill_executions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, executionId);
    }
    return rowToExecution(db.prepare('SELECT * FROM skill_executions WHERE id = ?').get(executionId));
}
export async function appendExecutionLog(executionId, logEntry) {
    const execution = await getExecution(executionId);
    if (!execution)
        throw new Error('Execution not found');
    await updateExecution(executionId, { execution_log: [...(execution.execution_log || []), logEntry] });
}
export async function getExecutionHistory(skillId, limit = 50) {
    const rows = db.prepare('SELECT * FROM skill_executions WHERE skill_id = ? ORDER BY started_at DESC LIMIT ?').all(skillId, limit);
    return rows.map(rowToExecution);
}
