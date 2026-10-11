import OpenAI from 'openai';
import { db, j, p, uuid } from './db.js';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const INTENT_TAG_VOCAB = [
    'search', 'login', 'extract', 'navigate', 'form-fill',
    'dismiss-friction', 'paginate', 'upload', 'checkout',
    'read-article', 'summarize', 'account-management',
];
export async function generateSkillEnvelope(skillName, description, skillType, plan, hybridPlan, template) {
    let planSummary = '';
    if (plan) {
        planSummary = plan.steps.map(s => `- ${s.title}: ${s.agentAction || s.action} ${s.url || ''}`).join('\n');
    }
    else if (hybridPlan) {
        planSummary = hybridPlan.steps.map(s => `- [${s.type}] ${s.title}: ${s.agentAction || ''} ${s.url || ''}`).join('\n');
    }
    else if (template) {
        planSummary = `Chat skill: ${(template.systemPrompt || '').slice(0, 200)}`;
    }
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [{
                role: 'system',
                content: `You are indexing a browser automation skill so an AI agent can find it when stuck mid-task.

Skill name: ${skillName}
Description: ${description}
Type: ${skillType}
Steps:
${planSummary}

Return JSON with exactly these fields:
{
  "intent_tags": [...],
  "trigger_phrases": [...],
  "site_scope": "..."
}

intent_tags: 1-4 tags chosen from this exact list only: ${INTENT_TAG_VOCAB.join(', ')}
trigger_phrases: 3-6 short phrases written from the stuck agent's perspective — what the agent would say when it needs this skill. Examples: "cookie banner is blocking the page", "login wall appeared before I could read content", "I am stuck on the Google search results and need to read the articles"
site_scope: one of — a specific domain like "google.com", a category like "news sites", or "any"`
            }]
    });
    try {
        const parsed = JSON.parse(response.choices[0].message.content || '{}');
        return {
            intent_tags: Array.isArray(parsed.intent_tags) ? parsed.intent_tags : [],
            trigger_phrases: Array.isArray(parsed.trigger_phrases) ? parsed.trigger_phrases : [],
            site_scope: typeof parsed.site_scope === 'string' ? parsed.site_scope : 'any',
        };
    }
    catch {
        return { intent_tags: [], trigger_phrases: [], site_scope: 'any' };
    }
}
export function saveSkillEnvelope(skillId, envelope) {
    db.prepare(`
    UPDATE skills
    SET intent_tags = ?, trigger_phrases = ?, site_scope = ?, last_indexed_at = datetime('now')
    WHERE id = ?
  `).run(j(envelope.intent_tags), j(envelope.trigger_phrases), envelope.site_scope, skillId);
}
// Fire-and-forget: call after any skill save. Never throws.
export function indexSkillAsync(skillId, skillName, description, skillType, plan, hybridPlan, template) {
    generateSkillEnvelope(skillName, description, skillType, plan, hybridPlan, template)
        .then(envelope => saveSkillEnvelope(skillId, envelope))
        .catch(err => console.warn(`[skill-index] Envelope generation failed for "${skillName}":`, err.message));
}
export function loadSkillForAgent(skillId, currentPageType, currentUrl, injectionMode, goalWhenStuck) {
    const row = db.prepare(`
    SELECT skill_name, skill_description, skill_type, execution_plan, hybrid_plan, chat_template,
           trigger_phrases, site_scope
    FROM skills WHERE id = ? AND status = 'active'
  `).get(skillId);
    if (!row)
        return null;
    const plan = p(row.execution_plan);
    const hybridPlan = p(row.hybrid_plan);
    const allSteps = plan?.steps || hybridPlan?.steps || [];
    // ── Entry point detection ────────────────────────────────────────────────────
    // Find the first step whose conditions match the agent's current state.
    // Prefer match on expectedPageType first, then URL match.
    // Never inject a navigate step that would take the agent to the URL it is already on.
    let entryIndex = 0; // default: start from beginning
    let entryDetected = false;
    if (currentPageType && allSteps.length > 0) {
        for (let i = 0; i < allSteps.length; i++) {
            const s = allSteps[i];
            // If this step navigates to a URL the agent is already on — skip it and move forward
            if (currentUrl &&
                (s.agentAction === 'navigate_to' || s.action === 'navigate') &&
                s.url && normalizeUrl(s.url) === normalizeUrl(currentUrl)) {
                entryIndex = i + 1; // start from the step AFTER this navigate
                entryDetected = true;
                continue;
            }
            // Match on expectedPageType
            if (s.expectedPageType && s.expectedPageType === currentPageType) {
                entryIndex = i;
                entryDetected = true;
                break;
            }
            // Fallback: if the step has no expectedPageType but has a URL matching current — start here
            if (!entryDetected && currentUrl && s.url && normalizeUrl(s.url) === normalizeUrl(currentUrl)) {
                entryIndex = i;
                entryDetected = true;
                break;
            }
        }
    }
    // If no match found and mode is not explicitly set — demote to reference
    const mode = injectionMode
        ?? (entryDetected ? 'insert' : 'reference');
    // Steps to inject: from entry point onward (or all steps for reference mode)
    const stepsToShow = mode === 'reference' ? allSteps : allSteps.slice(entryIndex);
    // ── Format output ────────────────────────────────────────────────────────────
    const lines = [];
    // Mode header
    if (mode === 'insert') {
        lines.push('═══ SKILL INJECTION [INSERT] ═══');
        lines.push(`Skill: ${row.skill_name}`);
        if (row.skill_description)
            lines.push(`Purpose: ${row.skill_description}`);
        lines.push(`Entry point: step ${allSteps[entryIndex]?.number ?? 1} (steps before it already done or not needed)`);
        lines.push('Follow these steps, then return to your original plan.');
    }
    else if (mode === 'replace') {
        lines.push('═══ SKILL INJECTION [REPLACE] ═══');
        lines.push(`Skill: ${row.skill_name}`);
        if (row.skill_description)
            lines.push(`Purpose: ${row.skill_description}`);
        lines.push('Your original plan is no longer valid. Follow these steps to complete the task.');
    }
    else {
        lines.push('═══ SKILL REFERENCE ═══');
        lines.push(`Skill: ${row.skill_name}`);
        if (row.skill_description)
            lines.push(`Purpose: ${row.skill_description}`);
        lines.push('Consult these steps for the PROCEDURE (navigation flow, what to click, how to handle friction).');
        lines.push('DATA VALUES RULE: Any specific values in these steps (search terms, names, dates, amounts, locations) are EXAMPLES only.');
        lines.push('Always use the values from the user\'s current task message instead of any values shown here.');
        if (!entryDetected && currentPageType) {
            lines.push(`(Note: no step matched your current page type "${currentPageType}" — using full skill as loose guidance)`);
        }
    }
    // Resume context
    if (goalWhenStuck) {
        lines.push('');
        lines.push(`RESUME CONTEXT: You were trying to — ${goalWhenStuck}`);
        lines.push('After this skill handles the stuck situation, continue toward that goal.');
    }
    lines.push('');
    // Steps
    if (stepsToShow.length) {
        for (const s of stepsToShow) {
            const label = hybridPlan ? `[${(s.type || 'browser').toUpperCase()}]` : '[BROWSER]';
            lines.push(`Step ${s.number}: ${s.title} ${label}`);
            if (s.agentAction)
                lines.push(`  action: ${s.agentAction}`);
            if (s.agentDetail)
                lines.push(`  detail: ${s.agentDetail}`);
            if (s.url)
                lines.push(`  url: ${s.url}`);
            if (s.expectedPageType)
                lines.push(`  expect page: ${s.expectedPageType}`);
            if (s.successCondition)
                lines.push(`  success: ${s.successCondition}`);
            if (s.frictionBefore?.length)
                lines.push(`  handles: ${s.frictionBefore.join(', ')}`);
            if (s.onFailureMode?.type)
                lines.push(`  on fail: ${s.onFailureMode.type}`);
            if (s.description && s.description !== s.title)
                lines.push(`  note: ${s.description}`);
        }
    }
    else if (p(row.chat_template)) {
        lines.push('(Chat skill — use its approach as conceptual guidance)');
    }
    else {
        lines.push('(No steps available — use the skill description as guidance only)');
    }
    return lines.join('\n');
}
function normalizeUrl(url) {
    try {
        const u = new URL(url);
        return (u.hostname + u.pathname).replace(/\/$/, '').toLowerCase();
    }
    catch {
        return url.toLowerCase().replace(/\/$/, '');
    }
}
function extractDomain(url) {
    try {
        return new URL(url).hostname.replace('www.', '');
    }
    catch {
        return '';
    }
}
export async function searchSkills(userId, query, stuckType, currentUrl, contextBudget) {
    const rows = db.prepare(`
    SELECT id, skill_name, skill_description, skill_type, trigger_phrases, intent_tags, site_scope, step_count, success_count
    FROM skills
    WHERE user_id = ? AND status = 'active' AND trigger_phrases IS NOT NULL
    ORDER BY success_count DESC
  `).all(userId);
    if (!rows.length)
        return [];
    // Filter 1 — site scope
    const currentDomain = extractDomain(currentUrl);
    const scopeFiltered = rows.filter(row => {
        const scope = row.site_scope || 'any';
        if (scope === 'any')
            return true;
        if (currentDomain && scope === currentDomain)
            return true;
        return currentUrl.includes(scope) || (currentDomain && scope.includes(currentDomain));
    });
    // Filter 2 — context budget (rough: each step ≈ 200 tokens, only load if fits in 30% of remaining budget)
    const budgetFiltered = scopeFiltered.filter(row => (row.step_count || 5) * 200 < contextBudget * 0.3);
    const candidates = (budgetFiltered.length ? budgetFiltered : scopeFiltered).slice(0, 15);
    if (!candidates.length)
        return [];
    const candidateList = candidates.map(row => ({
        id: row.id,
        name: row.skill_name,
        description: row.skill_description || '',
        trigger_phrases: p(row.trigger_phrases) || [],
        step_count: row.step_count || 0,
    }));
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [{
                role: 'system',
                content: `You are helping an AI agent find the right skill to get unstuck.

Agent is stuck:
  stuck_type: ${stuckType}
  description: ${query}
  current_url: ${currentUrl}

Available skills:
${candidateList.map((c, i) => `${i + 1}. ID=${c.id} | name="${c.name}" | description="${c.description}" | triggers: ${c.trigger_phrases.join(' / ')} | steps: ${c.step_count}`).join('\n')}

Return JSON:
{
  "results": [
    { "skill_id": "...", "relevance_score": 0.0-1.0, "why_relevant": "one sentence", "injection_mode": "insert"|"replace"|"reference" }
  ]
}

Rules:
- Return at most 3 results. Only include if relevance_score >= 0.4.
- injection_mode: "reference" for friction/popups, "insert" for sub-tasks, "replace" when the remaining plan is no longer valid.
- If nothing fits, return { "results": [] }.`
            }]
    });
    try {
        const parsed = JSON.parse(response.choices[0].message.content || '{}');
        return (parsed.results || [])
            .filter(r => r.skill_id && (r.relevance_score || 0) >= 0.4)
            .map(r => {
            const skill = candidateList.find(c => c.id === r.skill_id);
            return {
                skill_id: r.skill_id,
                skill_name: skill?.name || '',
                relevance_score: r.relevance_score || 0,
                why_relevant: r.why_relevant || '',
                injection_mode: r.injection_mode || 'reference',
                step_count: skill?.step_count || 0,
            };
        });
    }
    catch {
        return [];
    }
}
// Pre-task suggestion: match a task description against skill envelopes before the run starts.
// Returns at most 3 skills with score >= 0.6 (higher threshold than mid-run search).
export async function searchSkillsForTask(userId, taskDescription) {
    const rows = db.prepare(`
    SELECT id, skill_name, skill_description, trigger_phrases, intent_tags, step_count
    FROM skills
    WHERE user_id = ? AND status = 'active' AND trigger_phrases IS NOT NULL
    ORDER BY success_count DESC
    LIMIT 20
  `).all(userId);
    if (!rows.length)
        return [];
    const candidates = rows.map(row => ({
        id: row.id,
        name: row.skill_name,
        description: row.skill_description || '',
        trigger_phrases: p(row.trigger_phrases) || [],
        step_count: row.step_count || 0,
    }));
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [{
                role: 'system',
                content: `A user is about to run this task: "${taskDescription}"

Available saved skills:
${candidates.map((c, i) => `${i + 1}. ID=${c.id} | name="${c.name}" | description="${c.description}" | triggers: ${c.trigger_phrases.join(' / ')}`).join('\n')}

Which skills (if any) would be useful context for this task?
Return JSON: { "results": [{ "skill_id": "...", "relevance_score": 0.0-1.0, "why_relevant": "one sentence" }] }
Only include skills with relevance_score >= 0.6. Return at most 3. If none are relevant, return { "results": [] }.`
            }]
    });
    try {
        const parsed = JSON.parse(response.choices[0].message.content || '{}');
        return (parsed.results || [])
            .filter(r => r.skill_id && (r.relevance_score || 0) >= 0.6)
            .map(r => {
            const skill = candidates.find(c => c.id === r.skill_id);
            return {
                skill_id: r.skill_id,
                skill_name: skill?.name || '',
                relevance_score: r.relevance_score || 0,
                why_relevant: r.why_relevant || '',
                injection_mode: 'reference',
                step_count: skill?.step_count || 0,
            };
        });
    }
    catch {
        return [];
    }
}
// Build a context block from a list of skill IDs to prepend to a task prompt.
// All skills loaded in REFERENCE mode — the agent consults them, never follows blindly.
// Returns all variables defined across a set of attached skills (deduped by name).
// Covers both CLI-created skills (runtimeVariables in plan JSON) and
// web-created skills (skill_input_variables DB table).
export function getAttachedSkillVariables(skillIds) {
    const seen = new Set();
    const result = [];
    for (const id of skillIds) {
        const row = db.prepare(`SELECT execution_plan, hybrid_plan FROM skills WHERE id = ? AND status = 'active'`).get(id);
        if (!row)
            continue;
        // Source 1: runtimeVariables embedded in the plan JSON (CLI-created skills)
        const plan = p(row.execution_plan) || p(row.hybrid_plan);
        const planVars = plan?.runtimeVariables || [];
        for (const v of planVars) {
            if (!seen.has(v.name)) {
                seen.add(v.name);
                result.push(v);
            }
        }
        // Source 2: skill_input_variables table (web/extension-created skills)
        const dbVars = db.prepare(`SELECT * FROM skill_input_variables WHERE skill_id = ?`).all(id);
        for (const v of dbVars) {
            if (!seen.has(v.variable_name)) {
                seen.add(v.variable_name);
                result.push({
                    name: v.variable_name,
                    question: v.description ? `${v.description}:` : `Enter ${v.variable_name}:`,
                    type: (v.variable_type === 'select' ? 'choice' : 'text'),
                    default: v.default_value ?? undefined,
                });
            }
        }
    }
    return result;
}
export function buildAttachedSkillsContext(skillIds, varValues) {
    if (!skillIds.length)
        return '';
    const blocks = [];
    for (const id of skillIds) {
        let content = loadSkillForAgent(id, undefined, undefined, 'reference');
        if (!content)
            continue;
        // Substitute any {{variable}} placeholders with collected values
        if (varValues && Object.keys(varValues).length) {
            for (const [k, v] of Object.entries(varValues)) {
                content = content.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v);
            }
        }
        blocks.push(content);
    }
    if (!blocks.length)
        return '';
    return [
        '╔══ SKILLS ATTACHED BY USER ══════════════════════════════════╗',
        'These skills were attached as relevant context for this task.',
        'Consult them when you encounter the situations they describe.',
        'They take priority over your default approach for those situations.',
        '╚═════════════════════════════════════════════════════════════╝',
        '',
        blocks.join('\n\n─────────────────────────────────────────────────────────────\n\n'),
        '',
        '══ END ATTACHED SKILLS ══════════════════════════════════════',
        '',
    ].join('\n');
}
// Resolve a skill name (or partial name) to a skill ID for a given user.
// Returns the skill row or null if not found.
export function resolveSkillByName(userId, nameOrId) {
    // Exact match first
    const exact = db.prepare(`
    SELECT id, skill_name FROM skills
    WHERE user_id = ? AND lower(skill_name) = lower(?) AND status = 'active'
  `).get(userId, nameOrId);
    if (exact)
        return exact;
    // Fuzzy: name contains the input
    const fuzzy = db.prepare(`
    SELECT id, skill_name FROM skills
    WHERE user_id = ? AND lower(skill_name) LIKE lower(?) AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).get(userId, `%${nameOrId}%`);
    return fuzzy || null;
}
// Called when search_skills returns no useful results.
export function logSkillGap(userId, stuckDescription, stuckType, currentUrl, currentPageType, taskDescription) {
    try {
        db.prepare(`
      INSERT INTO skill_gap_events (id, user_id, stuck_description, stuck_type, current_url, current_page_type, task_description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), userId, stuckDescription, stuckType, currentUrl, currentPageType, taskDescription);
    }
    catch {
        // Never crash the agent over gap logging
    }
}
// Returns gap events created in the last N seconds for a user.
// Used by CLI to show post-run gap report.
export function getRecentGapEvents(userId, withinSeconds = 120) {
    return db.prepare(`
    SELECT * FROM skill_gap_events
    WHERE user_id = ?
      AND created_at >= datetime('now', '-' || ? || ' seconds')
    ORDER BY created_at ASC
  `).all(userId, withinSeconds);
}
// Checks if any stuck_type has 3+ distinct gap events in the last 30 days.
// Returns a proposal string if so, or null.
export function checkGapProposals(userId) {
    const rows = db.prepare(`
    SELECT stuck_type, COUNT(*) as count,
           GROUP_CONCAT(DISTINCT substr(stuck_description, 1, 80)) as samples
    FROM skill_gap_events
    WHERE user_id = ?
      AND created_at >= datetime('now', '-30 days')
    GROUP BY stuck_type
    HAVING count >= 3
    ORDER BY count DESC
    LIMIT 1
  `).get(userId);
    if (!rows)
        return null;
    const typeLabel = {
        friction_event: 'handling popups and friction gates',
        navigation_failure: 'navigating to the right page',
        sub_task_gap: 'a sub-task your current skills don\'t cover',
        unknown_page: 'dealing with unexpected page types',
        action_failure: 'a specific action that keeps failing',
    };
    const label = typeLabel[rows.stuck_type] || rows.stuck_type;
    return `💡 Skill proposal: "${label}" has caused ${rows.count} stuck events in the last 30 days.\n   Consider creating a skill for it: /skill\n   Recent stuck descriptions: ${rows.samples}`;
}
