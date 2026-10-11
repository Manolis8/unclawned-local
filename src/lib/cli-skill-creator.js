import { skillsApi } from './skills-api.js';
import { runAgentWithExtension } from './agent-extension.js';
import { db, uuid } from './db.js';
import { updateSkillPlan } from '../db/queries.js';
import { indexSkillAsync } from './skill-index.js';
import { frictionRegistryForPrompt } from './friction-registry.js';
import { expandSubSkillInPrompt, getSubSkill, subSkillLibraryForPrompt } from './sub-skills.js';
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ask = (rl, q) => new Promise(resolve => rl.question(q, resolve));
const fmtSel = (s) => typeof s === 'string' ? s : JSON.stringify(s);
// ── Runtime variable collection ──────────────────────────────────────────────
export async function collectRuntimeVars(rl, vars) {
    if (!vars?.length)
        return {};
    console.log('\nA few questions before running:\n');
    const result = {};
    for (const v of vars) {
        if (v.type === 'choice' && v.options?.length) {
            console.log(`  ${v.question}`);
            v.options.forEach((opt, i) => console.log(`    ${i + 1}. ${opt}`));
            console.log(`    ${v.options.length + 1}. Other (type your own)`);
            const choice = (await ask(rl, '  Choice: ')).trim();
            const idx = parseInt(choice) - 1;
            if (idx === v.options.length) {
                result[v.name] = (await ask(rl, '  Your answer: ')).trim() || (v.default || '');
            }
            else {
                result[v.name] = (idx >= 0 && idx < v.options.length) ? v.options[idx] : (choice || v.default || '');
            }
        }
        else {
            const answer = (await ask(rl, `  ${v.question} `)).trim();
            result[v.name] = answer || (v.default || '');
        }
    }
    console.log();
    return result;
}
function fmtRuntimeVars(values) {
    const entries = Object.entries(values).filter(([, v]) => v);
    if (!entries.length)
        return '';
    return entries.map(([k, v]) => `${k}: ${v}`).join('\n');
}
// ── Display ─────────────────────────────────────────────────────────────────
const SKILL_FOOTER = '  :test · :name <new-name> · :exit  (or type anything to refine)';
function displayBrowserPlan(plan, skillName) {
    const div = '─'.repeat(64);
    console.log('\n' + div);
    console.log(`  skills/${skillName}   ·  ${plan.steps.length} steps  ·  ~${plan.estimatedTime}`);
    console.log(div);
    plan.steps.forEach(step => {
        if (step.agentAction === 'use_sub_skill' && step.subSkillName) {
            const params = Object.entries(step.subSkillParams || {})
                .map(([k, v]) => `${k}=${v}`).join(', ');
            console.log(`  ${String(step.number).padStart(2)}. [sub-skill] ${step.subSkillName}(${params})`);
            const sub = getSubSkill(step.subSkillName);
            if (sub) {
                sub.steps.forEach((ss, i) => {
                    const letter = 'abcdefghijklmnopqrstuvwxyz'[i];
                    console.log(`        ${step.number}.${letter} ${ss.agentAction}: ${ss.goal}`);
                });
            }
            return;
        }
        const warn = step.uncertain ? ' ⚠' : '';
        const agentTag = step.agentAction ? ` [${step.agentAction}]` : '';
        console.log(`  ${String(step.number).padStart(2)}. ${step.title}${agentTag}${warn}`);
        if (step.description && step.description !== step.title) {
            console.log(`        ${step.description}`);
        }
        if (step.url)
            console.log(`        → ${step.url}`);
        if (step.value)
            console.log(`        value: ${step.value}`);
        if (step.selectors?.length)
            console.log(`        sel: ${fmtSel(step.selectors[0])}`);
        if (step.frictionBefore?.length)
            console.log(`        handles: ${step.frictionBefore.join(', ')}`);
        if (step.onFailureMode) {
            const ofm = step.onFailureMode;
            if (ofm.type === 'retry')
                console.log(`        on fail: retry ×${ofm.maxAttempts ?? 2}`);
            else if (ofm.type === 'skipToStep')
                console.log(`        on fail: skip to step ${ofm.stepNumber}`);
            else if (ofm.type === 'frictionHandler')
                console.log(`        on fail: handle ${ofm.handlerName}`);
            else if (ofm.type === 'exitSkill')
                console.log(`        on fail: exit (${ofm.errorCode})`);
        }
        if (step.uncertain)
            console.log(`        (uncertain — agent will search visually)`);
    });
    if (plan.runtimeVariables?.length) {
        console.log(div);
        console.log('  Asked each run:');
        plan.runtimeVariables.forEach(v => {
            const opts = v.type === 'choice' && v.options?.length ? `  [${v.options.join(' / ')}]` : '';
            console.log(`    • ${v.question}${opts}`);
        });
    }
    else if (plan.variables?.length) {
        console.log(div);
        console.log(`  Inputs: ${plan.variables.map((v) => `{{ ${v} }}`).join('  ')}`);
    }
    const uncertain = plan.steps.filter(s => s.uncertain).length;
    if (uncertain > 0)
        console.log(`\n  ⚠  ${uncertain} step(s) marked uncertain — run :test to see if they work`);
    console.log(div);
    console.log(SKILL_FOOTER);
    console.log(div + '\n');
}
function displayChatTemplate(template, skillName) {
    const div = '─'.repeat(64);
    console.log('\n' + div);
    console.log(`  skills/${skillName}   ·  chat skill`);
    console.log(div);
    console.log(`  Output: ${template.outputDescription}`);
    if (template.runtimeVariables?.length) {
        console.log('  Asked each run:');
        template.runtimeVariables.forEach(v => {
            const opts = v.type === 'choice' && v.options?.length ? `  [${v.options.join(' / ')}]` : '';
            console.log(`    • ${v.question}${opts}`);
        });
    }
    else if (template.variables?.length) {
        console.log(`  Inputs: ${template.variables.map(v => `{{ ${v} }}`).join('  ')}`);
    }
    if (template.exampleOutput) {
        console.log(div);
        console.log('  Example output:');
        template.exampleOutput.split('\n').slice(0, 4).forEach(l => console.log(`    ${l}`));
    }
    console.log(div);
    console.log(SKILL_FOOTER);
    console.log(div + '\n');
}
function displayHybridPlan(plan, skillName) {
    const div = '─'.repeat(64);
    console.log('\n' + div);
    console.log(`  skills/${skillName}   ·  hybrid  ·  ${plan.steps.length} steps  ·  ~${plan.estimatedTime}`);
    console.log(div);
    plan.steps.forEach(step => {
        const tag = step.type === 'browser' ? '[browser]' : '[chat]   ';
        const warn = step.uncertain ? ' ⚠' : '';
        const needs = step.needs?.length ? `  (uses: ${step.needs.map(n => `step ${n + 1}`).join(', ')})` : '';
        const agentTag = step.type === 'browser' && step.agentAction ? ` [${step.agentAction}]` : '';
        console.log(`  ${String(step.number).padStart(2)}. ${tag} ${step.title}${agentTag}${warn}${needs}`);
        if (step.description && step.description !== step.title)
            console.log(`           ${step.description}`);
        if (step.url)
            console.log(`           → ${step.url}`);
        if (step.selectors?.length)
            console.log(`           sel: ${fmtSel(step.selectors[0])}`);
        if (step.frictionBefore?.length)
            console.log(`           handles: ${step.frictionBefore.join(', ')}`);
        if (step.onFailureMode) {
            const ofm = step.onFailureMode;
            if (ofm.type === 'retry')
                console.log(`           on fail: retry ×${ofm.maxAttempts ?? 2}`);
            else if (ofm.type === 'skipToStep')
                console.log(`           on fail: skip to step ${ofm.stepNumber}`);
            else if (ofm.type === 'exitSkill')
                console.log(`           on fail: exit (${ofm.errorCode})`);
        }
        if (step.uncertain)
            console.log(`           (uncertain — agent will search visually)`);
    });
    if (plan.runtimeVariables?.length) {
        console.log(div);
        console.log('  Asked each run:');
        plan.runtimeVariables.forEach(v => {
            const opts = v.type === 'choice' && v.options?.length ? `  [${v.options.join(' / ')}]` : '';
            console.log(`    • ${v.question}${opts}`);
        });
    }
    else if (plan.variables?.length) {
        console.log(div);
        console.log(`  Inputs: ${plan.variables.map(v => `{{ ${v} }}`).join('  ')}`);
    }
    const uncertain = plan.steps.filter(s => s.uncertain).length;
    if (uncertain > 0)
        console.log(`\n  ⚠  ${uncertain} browser step(s) marked uncertain`);
    console.log(div);
    console.log(SKILL_FOOTER);
    console.log(div + '\n');
}
// ── Prompt builder for browser agent ────────────────────────────────────────
export function planToPrompt(skillName, plan, vars, learnedImprovements = [], runtimeVarValues = {}) {
    const allVars = { ...vars, ...runtimeVarValues };
    function subVars(text) {
        let out = text;
        for (const [k, v] of Object.entries(allVars)) {
            out = out.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v);
        }
        return out;
    }
    const steps = plan.steps.map(step => {
        // Sub-skill expansion — inline the sub-skill's steps in place of this step
        if (step.agentAction === 'use_sub_skill' && step.subSkillName) {
            const header = `── Sub-skill: ${step.subSkillName}(${Object.entries(step.subSkillParams || {}).map(([k, v]) => `${k}=${subVars(v)}`).join(', ')}) ──`;
            const expanded = expandSubSkillInPrompt(step.number, step.subSkillName, step.subSkillParams || {}, subVars);
            return `${header}\n${expanded}`;
        }
        const label = step.agentAction ? `[${step.agentAction}]` : '';
        let line = `Step ${step.number}: ${step.description || step.title} ${label}`.trimEnd();
        // Goal (one-sentence intent — helps agent self-check)
        if (step.goal)
            line += `\n   Goal: ${step.goal}`;
        // Navigation target
        if (step.url)
            line += `\n   Navigate to: ${subVars(step.url)}`;
        // Text to type
        if (step.value)
            line += `\n   Type exactly: ${subVars(step.value)}`;
        // Playwright selectors for clicks/types
        if (step.selectors?.length)
            line += `\n   Find element: ${step.selectors.map(fmtSel).join(' OR ')}`;
        // Agent-structured fields (present on new-format plans)
        if (step.agentAction && step.agentDetail) {
            line += `\n   Agent tool: ${step.agentAction} — ${subVars(step.agentDetail)}`;
        }
        if (step.expectedPageType)
            line += `\n   Page before: ${step.expectedPageType}`;
        if (step.successCondition)
            line += `\n   Success when: ${step.successCondition}`;
        if (step.frictionBefore?.length)
            line += `\n   Auto-handle first: ${step.frictionBefore.join(', ')}`;
        // Verification
        if (step.expected)
            line += `\n   Verify: ${step.expected}`;
        // Non-obvious context note
        if (step.note)
            line += `\n   Note: ${step.note}`;
        // Structured failure handling
        if (step.onFailureMode) {
            const ofm = step.onFailureMode;
            if (ofm.type === 'retry') {
                line += `\n   On failure: retry up to ${ofm.maxAttempts ?? 2} times`;
            }
            else if (ofm.type === 'skipToStep') {
                line += `\n   On failure: skip to step ${ofm.stepNumber}${ofm.reason ? ` — ${ofm.reason}` : ''}`;
            }
            else if (ofm.type === 'frictionHandler') {
                line += `\n   On failure: treat as ${ofm.handlerName} friction and resolve it`;
            }
            else if (ofm.type === 'exitSkill') {
                line += `\n   On failure: stop skill — ${ofm.userMessage || ofm.errorCode}`;
            }
        }
        // Uncertainty flag
        if (step.uncertain)
            line += `\n   UNCERTAIN — search accessibility tree visually for: ${step.title}`;
        return line;
    }).join('\n\n');
    const learning = learnedImprovements.length > 0
        ? `\n\nLEARNED FROM PREVIOUS RUNS (these locators + actions worked — use them directly):\n${learnedImprovements.map(l => `• ${l}`).join('\n')}`
        : '';
    const userInputs = fmtRuntimeVars(runtimeVarValues);
    const inputsSection = userInputs ? `\n\nUSER INPUTS FOR THIS RUN:\n${userInputs}` : '';
    return `Execute skill: "${skillName}"

The user is already logged in to all services. Do NOT attempt to log in.
Use Playwright accessibility locators (getByRole, getByLabel, getByText, getByPlaceholder) — not CSS selectors.

${steps}${learning}${inputsSection}

Follow steps in order. Use exact values provided. When a locator fails, inspect the accessibility tree to find the element by its visible role and label. For steps marked with an agent tool, prefer that tool over improvising.`;
}
// ── Skill name generator ─────────────────────────────────────────────────────
async function generateSkillName(description) {
    const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 25,
        temperature: 0,
        messages: [
            {
                role: 'system',
                content: 'You are naming a browser automation tool. Output ONLY a kebab-case name (2-5 words, lowercase, hyphens). Do NOT explain or apologize — just the name. Examples: "search-spacex-news", "post-linkedin-update", "book-google-calendar", "summarize-arxiv-paper", "track-package-status".'
            },
            { role: 'user', content: `Task: ${description}` }
        ]
    });
    return (res.choices[0].message.content?.trim() || 'my-skill')
        .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
        || 'my-skill';
}
// ── Plan refinement ──────────────────────────────────────────────────────────
async function refineBrowserPlan(plan, skillName, description, message) {
    const res = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 3000,
        messages: [
            {
                role: 'system',
                content: `You are refining a browser automation skill plan. Apply the user's change and return the full updated plan.

Skill name: "${skillName}"
Goal: ${description}

Current plan:
${JSON.stringify(plan, null, 2)}

Rules:
- User is already logged in. Never add login steps.
- Keep all existing fields on unchanged steps.
- For any step you add or modify, include BOTH layers:
  • Human layer: description (human prose), title (short label), goal (one-sentence intent)
  • Agent layer: agentAction (from: navigate_to/perceive_and_read/click_element/type_text/read_article/read_search_results/dismiss_friction/go_back_to_results/scroll_to_find/verify_state), agentDetail, expectedPageType, successCondition, frictionBefore (array even if []), note
  • Failure mode: onFailureMode with type one of: retry/skipToStep/frictionHandler/exitSkill
- Selectors: ONLY Playwright accessibility locators (getByRole, getByLabel, getByText, getByPlaceholder). Never CSS.
- Set uncertain: true if unsure of element label/role.

Friction registry (use names in frictionBefore and onFailureMode.handlerName):
${frictionRegistryForPrompt()}

Sub-skill library (use agentAction "use_sub_skill" with subSkillName for these):
${subSkillLibraryForPrompt()}

Valid onFailureMode examples:
  {"type":"retry","maxAttempts":2}
  {"type":"skipToStep","stepNumber":3,"reason":"try next result"}
  {"type":"frictionHandler","handlerName":"soft_paywall"}
  {"type":"exitSkill","errorCode":"SEARCH_FAILED","userMessage":"Could not find results."}

Return ONLY valid JSON:
{
  "skillName": "...",
  "reply": "one sentence what changed",
  "plan": { ...full updated ExecutionPlan... }
}`
            },
            { role: 'user', content: message }
        ]
    });
    const content = res.choices[0].message.content || '{}';
    try {
        const r = JSON.parse(content);
        return { plan: r.plan || plan, skillName: r.skillName || skillName, reply: r.reply || 'Updated.' };
    }
    catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) {
            try {
                const r = JSON.parse(m[0]);
                return { plan: r.plan || plan, skillName: r.skillName || skillName, reply: r.reply || 'Updated.' };
            }
            catch { }
        }
        return { plan, skillName, reply: 'Could not apply — try rephrasing.' };
    }
}
async function refineChatTemplate(template, skillName, description, message) {
    const res = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 1500,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: `You are refining a chat skill template.

Skill name: "${skillName}"
Goal: ${description}

Current template:
${JSON.stringify(template, null, 2)}

Apply the user's request and return JSON:
{
  "skillName": "...",
  "reply": "one sentence what changed",
  "template": { ...full updated ChatSkillTemplate... }
}`
            },
            { role: 'user', content: message }
        ]
    });
    try {
        const r = JSON.parse(res.choices[0].message.content || '{}');
        return { template: r.template || template, skillName: r.skillName || skillName, reply: r.reply || 'Updated.' };
    }
    catch {
        return { template, skillName, reply: 'Could not apply — try rephrasing.' };
    }
}
async function refineHybridPlan(plan, skillName, description, message) {
    const res = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 3000,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: `You are refining a hybrid skill plan (mix of browser and chat steps).

Skill name: "${skillName}"
Goal: ${description}

Current plan:
${JSON.stringify(plan, null, 2)}

Apply the user's request. Keep the same step structure but update as needed. User is already logged in — no auth steps. Browser steps need real selectors (uncertain:true if unsure). Chat steps just need a clear description of what to reason about and which prior steps to use.

Return JSON:
{
  "skillName": "...",
  "reply": "one sentence what changed",
  "plan": { ...full updated HybridSkillPlan... }
}`
            },
            { role: 'user', content: message }
        ]
    });
    try {
        const r = JSON.parse(res.choices[0].message.content || '{}');
        return { plan: r.plan || plan, skillName: r.skillName || skillName, reply: r.reply || 'Updated.' };
    }
    catch {
        return { plan, skillName, reply: 'Could not apply — try rephrasing.' };
    }
}
async function summarizeStepOutput(output, stepTitle) {
    if (output.length <= 300)
        return output;
    const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 150,
        temperature: 0,
        messages: [
            { role: 'system', content: 'Summarize in 2-3 sentences. Keep all specific facts: names, dates, times, numbers.' },
            { role: 'user', content: `Step: ${stepTitle}\nOutput: ${output}` }
        ]
    });
    return res.choices[0].message.content?.trim() || output.slice(0, 300);
}
async function runHybridStep(step, contextSummaries, originalGoal, userId, varValues, learnedImprovements, onProgress, userPreferences, runtimeVarValues = {}) {
    if (step.type === 'browser') {
        const miniPlan = {
            steps: [{
                    number: 1,
                    title: step.title,
                    action: step.action || 'navigate',
                    url: step.url,
                    selectors: step.selectors,
                    fallbackSelectors: step.fallbackSelectors,
                    value: step.value,
                    expected: step.expected,
                    timeout: step.timeout || 8,
                    onError: step.onError || 'retry',
                    description: step.description
                }],
            variables: [],
            estimatedTime: '30s',
            errorHandling: { maxRetries: 2, pauseOnError: false, userInterventionSteps: [] }
        };
        const taskPrompt = planToPrompt(step.title, miniPlan, varValues, learnedImprovements, runtimeVarValues);
        const fullPrompt = contextSummaries
            ? `${taskPrompt}\n\nContext from previous steps:\n${contextSummaries}`
            : taskPrompt;
        return runAgentWithExtension(fullPrompt, userId, onProgress);
    }
    else {
        // Chat step — inject user preferences + runtime answers
        const prefSection = userPreferences ? `\n\nUser preferences for this task:\n${userPreferences}` : '';
        const runtimeSection = fmtRuntimeVars(runtimeVarValues) ? `\n\nUser inputs for this run:\n${fmtRuntimeVars(runtimeVarValues)}` : '';
        const ctxSection = contextSummaries ? `\n\nContext from previous steps:\n${contextSummaries}` : '';
        const res = await openai.chat.completions.create({
            model: 'gpt-4o',
            max_tokens: 2000,
            messages: [
                {
                    role: 'system',
                    content: `You are completing one step of a larger task. Overall goal: "${originalGoal}"${prefSection}${runtimeSection}${ctxSection}

Use specific details from the context above — exact dates, temperatures, numbers, names, prices. Do NOT give generic answers; reference the actual data retrieved.`
                },
                { role: 'user', content: step.description }
            ]
        });
        return res.choices[0].message.content?.trim() || '';
    }
}
// Runs all consecutive browser steps in ONE agent session to avoid tab detach/reattach chaos.
// Each call to runAgentWithExtension creates a tab and detachAllTabs on exit — so per-step
// calls cause the next step to find a dead CDP target. Grouping fixes this.
async function runHybridBrowserGroup(steps, priorContextSummaries, originalGoal, userId, varValues, learnedImprovements, onProgress, userPreferences, runtimeVarValues = {}) {
    const actionMap = {
        navigate_to: 'navigate', click_element: 'click', type_text: 'type', verify_state: 'verify'
    };
    const miniPlan = {
        steps: steps.map((step, idx) => ({
            number: idx + 1,
            title: step.title,
            action: (step.agentAction && actionMap[step.agentAction]) ? actionMap[step.agentAction] : 'navigate',
            url: step.url,
            selectors: step.selectors,
            fallbackSelectors: step.fallbackSelectors,
            value: step.value,
            expected: step.expected,
            timeout: step.timeout || 10,
            onError: step.onError || 'retry',
            description: step.description,
            goal: step.goal,
            agentAction: step.agentAction,
            agentDetail: step.agentDetail,
            expectedPageType: step.expectedPageType,
            successCondition: step.successCondition,
            frictionBefore: step.frictionBefore || [],
            note: step.note,
            onFailureMode: step.onFailureMode,
            uncertain: step.uncertain || false,
        })),
        variables: [],
        estimatedTime: '2-5 min',
        errorHandling: { maxRetries: 2, pauseOnError: false, userInterventionSteps: [] }
    };
    const groupTitle = steps.length === 1 ? steps[0].title : steps.map(s => s.title).join(' → ');
    const taskPrompt = planToPrompt(groupTitle, miniPlan, varValues, learnedImprovements, runtimeVarValues);
    const prefSection = userPreferences ? `\n\nUser preferences: ${userPreferences}` : '';
    const fullPrompt = priorContextSummaries
        ? `${taskPrompt}\n\nContext from previous steps:\n${priorContextSummaries}${prefSection}`
        : taskPrompt + prefSection;
    return runAgentWithExtension(fullPrompt, userId, onProgress, undefined, false, undefined, undefined, false, true);
}
// ── Test runner ──────────────────────────────────────────────────────────────
async function testBrowserSkill(rl, plan, skillName, description, userId, learnedImprovements) {
    const runtimeVarValues = await collectRuntimeVars(rl, plan.runtimeVariables || []);
    const agentPrompt = planToPrompt(skillName, plan, {}, learnedImprovements, runtimeVarValues);
    console.log('\nRunning test...\n');
    let lastLine = '';
    const stepLog = [];
    let success = false;
    let output = '';
    try {
        output = await runAgentWithExtension(agentPrompt, userId, async (step) => {
            if (lastLine)
                process.stdout.write('\r' + ' '.repeat(lastLine.length) + '\r');
            lastLine = step;
            process.stdout.write(step);
            stepLog.push(step);
        }, undefined, false, undefined, undefined, false, true);
        if (lastLine)
            process.stdout.write('\n');
        success = true;
        console.log('\n✅ ' + output);
    }
    catch (err) {
        if (lastLine)
            process.stdout.write('\n');
        output = err instanceof Error ? err.message : String(err);
        console.log('\n❌ ' + output);
    }
    console.log('\nAnalysing run...');
    const analysis = await skillsApi.improveSkillAfterRun(description, 'browser', plan, null, null, stepLog, output, success, learnedImprovements);
    console.log('\n' + (success ? '✅' : '⚠️') + '  ' + analysis.summary);
    if (analysis.issues.length) {
        console.log('\nIssues:');
        analysis.issues.forEach(i => console.log(`  • ${i}`));
    }
    if (analysis.suggestions.length) {
        console.log('\nTo improve:');
        analysis.suggestions.forEach(s => console.log(`  → /edit ${skillName} "${s}"`));
    }
    if (analysis.updatedPlan) {
        console.log('\nPlan automatically improved from this run.');
    }
    return { updatedPlan: analysis.updatedPlan, newLearning: analysis.newLearning };
}
async function testChatSkill(rl, template, skillName, description, learnedImprovements) {
    const runtimeVarValues = await collectRuntimeVars(rl, template.runtimeVariables || []);
    let systemPrompt = template.systemPrompt;
    for (const [k, v] of Object.entries(runtimeVarValues)) {
        systemPrompt = systemPrompt.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v);
    }
    const extraContext = fmtRuntimeVars(runtimeVarValues);
    if (extraContext)
        systemPrompt += `\n\nUser inputs for this run:\n${extraContext}`;
    if (learnedImprovements.length) {
        systemPrompt += `\n\nNote from previous runs:\n${learnedImprovements.map(l => `• ${l}`).join('\n')}`;
    }
    console.log('\nGenerating output...\n');
    const res = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 2000,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: 'Generate the output now.' }
        ]
    });
    const output = res.choices[0].message.content || '';
    console.log(output);
    const feedback = (await ask(rl, '\nWas this good? Any issues? (press Enter to skip) ')).trim();
    if (!feedback)
        return { updatedTemplate: null, newLearning: '' };
    const analysis = await skillsApi.improveSkillAfterRun(description, 'chat', null, template, null, [feedback], output, true, learnedImprovements);
    if (analysis.suggestions.length) {
        console.log('\nTo improve:');
        analysis.suggestions.forEach(s => console.log(`  → /edit ${skillName} "${s}"`));
    }
    return { updatedTemplate: analysis.updatedTemplate, newLearning: analysis.newLearning };
}
async function testHybridSkill(rl, plan, skillName, description, userId, learnedImprovements) {
    const runtimeVarValues = await collectRuntimeVars(rl, plan.runtimeVariables || []);
    const stepSummaries = [];
    const allStepLogs = [];
    let lastOutput = '';
    let success = true;
    let stepIdx = 0;
    while (stepIdx < plan.steps.length) {
        const step = plan.steps[stepIdx];
        if (step.type === 'chat') {
            console.log(`\n[chat]    ${step.title}`);
            const contextSummaries = (step.needs || [])
                .filter(i => i < stepSummaries.length)
                .map(i => `${plan.steps[i].title}: ${stepSummaries[i]}`)
                .join('\n');
            try {
                const output = await runHybridStep(step, contextSummaries, description, userId, {}, learnedImprovements, async () => { }, plan.userPreferences, runtimeVarValues);
                console.log(output);
                stepSummaries.push(await summarizeStepOutput(output, step.title));
                lastOutput = output;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.log('  ❌ ' + msg);
                stepSummaries.push(`Failed: ${msg}`);
                allStepLogs.push(`Step ${step.number} failed: ${msg}`);
                success = false;
                break;
            }
            stepIdx++;
        }
        else {
            // Collect all consecutive browser steps — run them as ONE agent session
            const browserGroup = [];
            const groupStart = stepIdx;
            while (stepIdx < plan.steps.length && plan.steps[stepIdx].type === 'browser') {
                browserGroup.push(plan.steps[stepIdx]);
                stepIdx++;
            }
            const allNeeded = new Set(browserGroup.flatMap(s => s.needs || []));
            const contextParts = [...allNeeded]
                .filter(i => i < stepSummaries.length)
                .map(i => `${plan.steps[i].title}: ${stepSummaries[i]}`);
            const contextSummaries = [...new Set(contextParts)].join('\n');
            const groupLabel = browserGroup.length === 1 ? browserGroup[0].title : `${browserGroup[0].title} → ${browserGroup[browserGroup.length - 1].title}`;
            console.log(`\n[browser] ${groupLabel}`);
            let lastLine = '';
            const onProgress = async (msg) => {
                if (lastLine)
                    process.stdout.write('\r' + ' '.repeat(lastLine.length) + '\r');
                lastLine = msg;
                process.stdout.write(msg);
                allStepLogs.push(msg);
            };
            try {
                const output = await runHybridBrowserGroup(browserGroup, contextSummaries, description, userId, {}, learnedImprovements, onProgress, plan.userPreferences, runtimeVarValues);
                if (lastLine)
                    process.stdout.write('\n');
                console.log('  ✅ ' + output.slice(0, 100));
                const summary = await summarizeStepOutput(output, groupLabel);
                for (let i = groupStart; i < stepIdx; i++)
                    stepSummaries.push(summary);
                lastOutput = output;
            }
            catch (err) {
                if (lastLine)
                    process.stdout.write('\n');
                const msg = err instanceof Error ? err.message : String(err);
                console.log('  ❌ ' + msg);
                for (let i = groupStart; i < stepIdx; i++)
                    stepSummaries.push(`Failed: ${msg}`);
                allStepLogs.push(`Browser steps ${groupStart}-${stepIdx - 1} failed: ${msg}`);
                success = false;
                break;
            }
        }
    }
    if (plan.steps.length > 1) {
        console.log('\nSynthesising...');
        const res = await openai.chat.completions.create({
            model: 'gpt-4o',
            max_tokens: 2000,
            messages: [
                { role: 'system', content: `Combine these results into a single coherent, useful response. Include specific details from the retrieved data — exact dates, temperatures, numbers, names. Do not be vague or generic; use the actual values found. Be natural and don't mention "steps" or the process.` },
                { role: 'user', content: `Goal: ${description}\n\n${plan.steps.map((s, i) => `${s.title}:\n${stepSummaries[i] || 'skipped'}`).join('\n\n')}` }
            ]
        });
        console.log('\n' + res.choices[0].message.content);
    }
    console.log('\nAnalysing run...');
    const analysis = await skillsApi.improveSkillAfterRun(description, 'hybrid', null, null, plan, allStepLogs, lastOutput, success, learnedImprovements);
    console.log('\n' + (success ? '✅' : '⚠️') + '  ' + analysis.summary);
    if (analysis.issues.length) {
        console.log('\nIssues:');
        analysis.issues.forEach(i => console.log(`  • ${i}`));
    }
    if (analysis.suggestions.length) {
        console.log('\nTo improve:');
        analysis.suggestions.forEach(s => console.log(`  → /edit ${skillName} "${s}"`));
    }
    if (analysis.updatedHybridPlan)
        console.log('\nPlan automatically improved from this run.');
    return { updatedPlan: analysis.updatedHybridPlan, newLearning: analysis.newLearning };
}
// ── Save helpers ─────────────────────────────────────────────────────────────
function checkNameAvailable(userId, name, excludeId) {
    const row = db.prepare(`SELECT id FROM skills WHERE user_id = ? AND lower(skill_name) = lower(?)`).get(userId, name);
    if (!row)
        return true;
    if (excludeId && row.id === excludeId)
        return true;
    return false;
}
function saveSkill(userId, skillName, description, skillType, plan, template, hybridPlan, learnedImprovements) {
    const existing = db.prepare(`SELECT id FROM skills WHERE user_id = ? AND lower(skill_name) = lower(?)`).get(userId, skillName);
    if (existing) {
        db.prepare(`DELETE FROM skill_input_variables WHERE skill_id = ?`).run(existing.id);
        db.prepare(`DELETE FROM skills WHERE id = ?`).run(existing.id);
    }
    const skillId = uuid();
    const vars = skillType === 'browser'
        ? (plan?.variables || [])
        : skillType === 'chat'
            ? (template?.variables || [])
            : (hybridPlan?.variables || []);
    db.prepare(`INSERT INTO skills (id, user_id, skill_name, skill_description, skill_type, execution_plan, chat_template, hybrid_plan, status, step_count, plan_approved_at, learned_improvements, run_count, success_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'), ?, 0, 0)`).run(skillId, userId, skillName, description, skillType, plan ? JSON.stringify(plan) : null, template ? JSON.stringify(template) : null, hybridPlan ? JSON.stringify(hybridPlan) : null, hybridPlan?.steps.length || plan?.steps.length || 0, JSON.stringify(learnedImprovements));
    for (const varName of vars) {
        db.prepare(`INSERT INTO skill_input_variables (id, skill_id, variable_name, variable_type, is_required) VALUES (?, ?, ?, 'text', 1)`).run(uuid(), skillId, varName);
    }
    indexSkillAsync(skillId, skillName, description, skillType, plan, hybridPlan, template);
    return skillId;
}
async function skillRefinementLoop(rl, userId, skillType, description, state) {
    const persist = () => {
        saveSkill(userId, state.name, description, skillType, state.plan, state.template, state.hybridPlan, state.learnedImprovements);
        process.stdout.write('  saved.\n');
    };
    const redisplay = () => {
        if (skillType === 'browser')
            displayBrowserPlan(state.plan, state.name);
        else if (skillType === 'chat')
            displayChatTemplate(state.template, state.name);
        else
            displayHybridPlan(state.hybridPlan, state.name);
    };
    while (true) {
        const input = (await ask(rl, '> ')).trim();
        if (!input)
            continue;
        if (input === ':exit') {
            console.log(`\nskills/${state.name} is ready. Run it with: /run ${state.name}\n`);
            return;
        }
        if (input === ':cancel') {
            if (state.isNew) {
                const existing = db.prepare(`SELECT id FROM skills WHERE user_id = ? AND lower(skill_name) = lower(?)`).get(userId, state.name);
                if (existing) {
                    db.prepare(`DELETE FROM skill_input_variables WHERE skill_id = ?`).run(existing.id);
                    db.prepare(`DELETE FROM skills WHERE id = ?`).run(existing.id);
                }
                console.log('Skill discarded.\n');
            }
            else {
                console.log('Edits kept (skill was already saved). Use :exit to leave.\n');
            }
            return;
        }
        if (input.startsWith(':name ')) {
            const newName = input.slice(6).trim()
                .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            if (!newName) {
                console.log('  Invalid name.');
                continue;
            }
            const conflict = db.prepare(`SELECT id FROM skills WHERE user_id = ? AND lower(skill_name) = lower(?)`).get(userId, newName);
            const currentRow = db.prepare(`SELECT id FROM skills WHERE user_id = ? AND lower(skill_name) = lower(?)`).get(userId, state.name);
            if (conflict && conflict.id !== currentRow?.id) {
                console.log(`  "${newName}" is already taken. Choose a different name.`);
                continue;
            }
            if (currentRow) {
                db.prepare(`DELETE FROM skill_input_variables WHERE skill_id = ?`).run(currentRow.id);
                db.prepare(`DELETE FROM skills WHERE id = ?`).run(currentRow.id);
            }
            state.name = newName;
            redisplay();
            persist();
            continue;
        }
        if (input === ':test' || input === ':run') {
            if (skillType === 'browser') {
                const { updatedPlan, newLearning } = await testBrowserSkill(rl, state.plan, state.name, description, userId, state.learnedImprovements);
                if (updatedPlan)
                    state.plan = updatedPlan;
                if (newLearning)
                    state.learnedImprovements.push(...newLearning.split('\n').map(l => l.trim()).filter(Boolean));
                displayBrowserPlan(state.plan, state.name);
            }
            else if (skillType === 'chat') {
                const { updatedTemplate, newLearning } = await testChatSkill(rl, state.template, state.name, description, state.learnedImprovements);
                if (updatedTemplate)
                    state.template = updatedTemplate;
                if (newLearning)
                    state.learnedImprovements.push(...newLearning.split('\n').map(l => l.trim()).filter(Boolean));
                displayChatTemplate(state.template, state.name);
            }
            else {
                const { updatedPlan: updatedHybrid, newLearning } = await testHybridSkill(rl, state.hybridPlan, state.name, description, userId, state.learnedImprovements);
                if (updatedHybrid)
                    state.hybridPlan = updatedHybrid;
                if (newLearning)
                    state.learnedImprovements.push(...newLearning.split('\n').map(l => l.trim()).filter(Boolean));
                displayHybridPlan(state.hybridPlan, state.name);
            }
            persist();
            continue;
        }
        if (input.startsWith(':')) {
            const cmd = input.split(' ')[0];
            console.log(`  Unknown command: ${cmd}`);
            console.log('  Valid: :exit · :cancel · :name <new-name> · :test · :run');
            continue;
        }
        // Freetext → refine
        console.log('Updating...');
        if (skillType === 'browser') {
            const refined = await refineBrowserPlan(state.plan, state.name, description, input);
            state.plan = refined.plan;
            state.name = refined.skillName;
            console.log('  ' + refined.reply);
            displayBrowserPlan(state.plan, state.name);
        }
        else if (skillType === 'chat') {
            const refined = await refineChatTemplate(state.template, state.name, description, input);
            state.template = refined.template;
            state.name = refined.skillName;
            console.log('  ' + refined.reply);
            displayChatTemplate(state.template, state.name);
        }
        else {
            const refined = await refineHybridPlan(state.hybridPlan, state.name, description, input);
            state.hybridPlan = refined.plan;
            state.name = refined.skillName;
            console.log('  ' + refined.reply);
            displayHybridPlan(state.hybridPlan, state.name);
        }
        persist();
    }
}
// ── Creator ──────────────────────────────────────────────────────────────────
export async function runSkillCreator(rl, userId, prefillDescription) {
    const div = '─'.repeat(64);
    console.log('\n' + div);
    console.log('  New Skill');
    console.log(div + '\n');
    let description;
    if (prefillDescription) {
        description = prefillDescription.trim();
        console.log(`What should this skill do?\n> ${description}`);
    }
    else {
        description = (await ask(rl, 'What should this skill do?\n> ')).trim();
    }
    if (!description) {
        console.log('Cancelled.');
        return;
    }
    // Detect type
    console.log('\nDetecting skill type...');
    const skillType = await skillsApi.detectSkillType(description);
    const typeLabel = skillType === 'browser' ? 'Browser skill (uses Chrome)'
        : skillType === 'chat' ? 'Chat skill (AI reasoning — no browser)'
            : 'Hybrid skill (browser + AI reasoning)';
    console.log(`  → ${typeLabel}`);
    // Clarifying questions
    console.log('\nAnalysing...');
    const questions = await skillsApi.generateQuestions(description);
    const answers = {};
    const runtimeVarHints = [];
    if (questions.length > 0) {
        console.log('\nDetected variables (will be asked each time you run this skill):\n');
        for (const q of questions) {
            const isAskEachTime = (s) => s.toLowerCase().includes('ask each time') || s.toLowerCase() === 'each time';
            const cleanOptions = q.type === 'multiple_choice'
                ? q.options.filter((o) => !isAskEachTime(o))
                : [];
            // Auto-mark every clarifying question as a runtime variable — skills are always general-purpose
            answers[q.question] = '[ASK_EACH_RUN]';
            runtimeVarHints.push({ question: q.question, options: cleanOptions });
            console.log(`  • ${q.question}${cleanOptions.length ? ` (${cleanOptions.join(' / ')})` : ''}`);
        }
        console.log();
    }
    // Annotate answers so GPT knows which should become runtime variables
    const annotatedAnswers = {};
    for (const [q, a] of Object.entries(answers)) {
        if (a === '[ASK_EACH_RUN]') {
            const hint = runtimeVarHints.find(h => h.question === q);
            const opts = hint?.options.length ? ` Options: ${hint.options.join(', ')}` : '';
            annotatedAnswers[q] = `[MAKE THIS A RUNTIME VARIABLE — ask the user each time the skill runs.${opts} Add as {{ variable }} placeholder and include in runtimeVariables array.]`;
        }
        else {
            annotatedAnswers[q] = a;
        }
    }
    // Generate plan or template
    console.log('\nGenerating plan...');
    let currentName = await generateSkillName(description);
    let currentPlan = null;
    let currentTemplate = null;
    let currentHybridPlan = null;
    const learnedImprovements = [];
    if (skillType === 'browser') {
        const { plan } = await skillsApi.generatePlan(description, annotatedAnswers);
        currentPlan = plan;
        displayBrowserPlan(currentPlan, currentName);
    }
    else if (skillType === 'chat') {
        currentTemplate = await skillsApi.generateChatSkillTemplate(description, annotatedAnswers);
        displayChatTemplate(currentTemplate, currentName);
    }
    else {
        currentHybridPlan = await skillsApi.generateHybridPlan(description, annotatedAnswers);
        displayHybridPlan(currentHybridPlan, currentName);
    }
    // Initial save then enter shared loop
    saveSkill(userId, currentName, description, skillType, currentPlan, currentTemplate, currentHybridPlan, learnedImprovements);
    process.stdout.write('  saved.\n');
    await skillRefinementLoop(rl, userId, skillType, description, {
        name: currentName,
        plan: currentPlan,
        template: currentTemplate,
        hybridPlan: currentHybridPlan,
        learnedImprovements,
        isNew: true
    });
}
// ── Editor (re-open existing skill) ──────────────────────────────────────────
export async function runSkillEditor(rl, userId, nameOrId) {
    if (!nameOrId) {
        listSkills(userId);
        const name = (await ask(rl, 'Which skill to edit? ')).trim();
        if (!name)
            return;
        return runSkillEditor(rl, userId, name);
    }
    const skill = db.prepare(`SELECT * FROM skills WHERE user_id = ? AND (lower(skill_name) = lower(?) OR id = ?) AND status != 'deleted'`).get(userId, nameOrId, nameOrId);
    if (!skill) {
        console.log(`Skill "${nameOrId}" not found. Use /skills to list yours.`);
        return;
    }
    const skillType = skill.skill_type || 'browser';
    const div = '─'.repeat(64);
    console.log('\n' + div);
    console.log(`  Editing skills/${skill.skill_name}   [${skillType}]`);
    console.log(div + '\n');
    const state = {
        name: skill.skill_name,
        plan: skill.execution_plan ? JSON.parse(skill.execution_plan) : null,
        template: skill.chat_template ? JSON.parse(skill.chat_template) : null,
        hybridPlan: skill.hybrid_plan ? JSON.parse(skill.hybrid_plan) : null,
        learnedImprovements: skill.learned_improvements ? JSON.parse(skill.learned_improvements) : [],
        isNew: false
    };
    if (skillType === 'browser')
        displayBrowserPlan(state.plan, state.name);
    else if (skillType === 'chat')
        displayChatTemplate(state.template, state.name);
    else
        displayHybridPlan(state.hybridPlan, state.name);
    await skillRefinementLoop(rl, userId, skillType, skill.skill_description || skill.skill_name, state);
}
// ── Delete ───────────────────────────────────────────────────────────────────
export async function runSkillDelete(rl, userId, nameOrId) {
    if (!nameOrId.trim()) {
        console.log('\nUsage: /delete <skill name>\n');
        return;
    }
    const skill = db.prepare(`SELECT id, skill_name, skill_description, skill_type, run_count, created_at
     FROM skills WHERE user_id = ? AND (lower(skill_name) = lower(?) OR id = ?) AND status != 'deleted'`).get(userId, nameOrId.trim(), nameOrId.trim());
    if (!skill) {
        // Try partial match
        const partial = db.prepare(`SELECT id, skill_name, skill_description, skill_type, run_count, created_at
       FROM skills WHERE user_id = ? AND lower(skill_name) LIKE lower(?) AND status != 'deleted'
       LIMIT 1`).get(userId, `%${nameOrId.trim()}%`);
        if (!partial) {
            console.log(`\n⚠️  No skill found matching "${nameOrId}". Run /skills to see your skills.\n`);
            return;
        }
        return runSkillDelete(rl, userId, partial.skill_name);
    }
    const div = '─'.repeat(64);
    const typeLabel = skill.skill_type === 'chat' ? 'Chat' : skill.skill_type === 'hybrid' ? 'Hybrid' : 'Browser';
    const runs = skill.run_count ? `${skill.run_count} run${skill.run_count !== 1 ? 's' : ''}` : 'never run';
    const created = new Date(skill.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    console.log(`\n${div}`);
    console.log(`  Delete Skill`);
    console.log(div);
    console.log(`\n  Name:    ${skill.skill_name}`);
    if (skill.skill_description)
        console.log(`  About:   ${skill.skill_description}`);
    console.log(`  Type:    ${typeLabel}`);
    console.log(`  Created: ${created}  ·  ${runs}`);
    console.log(`\n${div}`);
    console.log(`\n  ⚠️  This action is permanent and cannot be undone.`);
    console.log(`  The skill "${skill.skill_name}" will be removed immediately`);
    console.log(`  and will no longer be available to the AI.\n`);
    const answer = (await ask(rl, `  Type the skill name to confirm deletion, or press Enter to cancel:\n  > `)).trim();
    if (answer.toLowerCase() !== skill.skill_name.toLowerCase()) {
        console.log('\n  Cancelled — skill was not deleted.\n');
        return;
    }
    db.prepare('DELETE FROM skill_input_variables WHERE skill_id = ?').run(skill.id);
    db.prepare('DELETE FROM skills WHERE id = ?').run(skill.id);
    console.log(`\n  ✓ "${skill.skill_name}" has been permanently deleted.\n`);
}
// ── List & Run ───────────────────────────────────────────────────────────────
export function listSkills(userId) {
    const skills = db.prepare(`SELECT skill_name, skill_description, skill_type, step_count, run_count, success_count, created_at
     FROM skills WHERE user_id = ? AND status != 'deleted'
     ORDER BY created_at DESC`).all(userId);
    if (skills.length === 0) {
        console.log('\nNo saved skills yet. Create one with /skill\n');
        return;
    }
    console.log(`\nYour skills (${skills.length}):`);
    skills.forEach((s, i) => {
        const type = s.skill_type === 'chat' ? '[chat]   ' : s.skill_type === 'hybrid' ? '[hybrid] ' : '[browser]';
        const runs = s.run_count ? ` · ${s.success_count}/${s.run_count} runs` : '';
        const desc = s.skill_description ? ` — ${s.skill_description}` : '';
        console.log(`  ${String(i + 1).padStart(2)}. ${type} ${s.skill_name}${runs}${desc}`);
    });
    console.log('\nRun a skill with: /run <skill-name>\n');
}
export async function runSavedSkill(rl, userId, nameOrId) {
    if (!nameOrId) {
        listSkills(userId);
        const name = (await ask(rl, 'Which skill to run? ')).trim();
        if (!name)
            return;
        return runSavedSkill(rl, userId, name);
    }
    const skill = db.prepare(`SELECT * FROM skills WHERE user_id = ? AND (lower(skill_name) = lower(?) OR id = ?) AND status != 'deleted'`).get(userId, nameOrId, nameOrId);
    if (!skill) {
        console.log(`Skill "${nameOrId}" not found. Use /skills to list yours.`);
        return;
    }
    const learnedImprovements = skill.learned_improvements
        ? JSON.parse(skill.learned_improvements) : [];
    const execId = uuid();
    db.prepare(`INSERT INTO skill_executions (id, skill_id, user_id, input_values, status, started_at) VALUES (?, ?, ?, ?, 'running', datetime('now'))`).run(execId, skill.id, userId, '{}');
    const start = Date.now();
    let success = false;
    let output = '';
    const stepLog = [];
    if (skill.skill_type === 'hybrid' && skill.hybrid_plan) {
        // ── Hybrid execution ────────────────────────────────────────────────────
        const hybridPlan = JSON.parse(skill.hybrid_plan);
        const runtimeVarValues = await collectRuntimeVars(rl, hybridPlan.runtimeVariables || []);
        console.log(`\nRunning "skills/${skill.skill_name}"...\n`);
        const stepSummaries = [];
        let hybridIdx = 0;
        while (hybridIdx < hybridPlan.steps.length) {
            const step = hybridPlan.steps[hybridIdx];
            const goal = skill.skill_description || skill.skill_name;
            if (step.type === 'chat') {
                console.log(`[chat]    ${step.title}`);
                const ctxParts = (step.needs || [])
                    .filter(i => i < stepSummaries.length)
                    .map(i => `${hybridPlan.steps[i].title}: ${stepSummaries[i]}`);
                try {
                    const stepOutput = await runHybridStep(step, ctxParts.join('\n'), goal, userId, {}, learnedImprovements, async () => { }, hybridPlan.userPreferences, runtimeVarValues);
                    console.log(stepOutput);
                    stepSummaries.push(await summarizeStepOutput(stepOutput, step.title));
                    output = stepOutput;
                }
                catch (err) {
                    output = err instanceof Error ? err.message : String(err);
                    console.log('  ❌ ' + output);
                    stepSummaries.push(`Failed: ${output}`);
                    success = false;
                    break;
                }
                hybridIdx++;
            }
            else {
                // Group all consecutive browser steps into ONE agent session
                const browserGroup = [];
                const groupStart = hybridIdx;
                while (hybridIdx < hybridPlan.steps.length && hybridPlan.steps[hybridIdx].type === 'browser') {
                    browserGroup.push(hybridPlan.steps[hybridIdx]);
                    hybridIdx++;
                }
                const allNeeded = new Set(browserGroup.flatMap(s => s.needs || []));
                const ctxParts = [...allNeeded]
                    .filter(i => i < stepSummaries.length)
                    .map(i => `${hybridPlan.steps[i].title}: ${stepSummaries[i]}`);
                const contextSummaries = [...new Set(ctxParts)].join('\n');
                const groupLabel = browserGroup.length === 1 ? browserGroup[0].title : `${browserGroup[0].title} → ${browserGroup[browserGroup.length - 1].title}`;
                console.log(`[browser] ${groupLabel}`);
                let lastLine = '';
                const onProgress = async (msg) => {
                    if (lastLine)
                        process.stdout.write('\r' + ' '.repeat(lastLine.length) + '\r');
                    lastLine = msg;
                    process.stdout.write(msg);
                    stepLog.push(msg);
                };
                try {
                    const stepOutput = await runHybridBrowserGroup(browserGroup, contextSummaries, goal, userId, {}, learnedImprovements, onProgress, hybridPlan.userPreferences, runtimeVarValues);
                    if (lastLine)
                        process.stdout.write('\n');
                    console.log('  ✅ ' + stepOutput.slice(0, 120));
                    const summary = await summarizeStepOutput(stepOutput, groupLabel);
                    for (let i = groupStart; i < hybridIdx; i++)
                        stepSummaries.push(summary);
                    output = stepOutput;
                }
                catch (err) {
                    if (lastLine)
                        process.stdout.write('\n');
                    output = err instanceof Error ? err.message : String(err);
                    console.log('  ❌ ' + output);
                    for (let i = groupStart; i < hybridIdx; i++)
                        stepSummaries.push(`Failed: ${output}`);
                    success = false;
                    break;
                }
            }
        }
        if (success && hybridPlan.steps.length > 1) {
            console.log('\nSynthesising...\n');
            const res = await openai.chat.completions.create({
                model: 'gpt-4o',
                max_tokens: 2000,
                messages: [
                    { role: 'system', content: 'Combine these results into a single coherent, useful response. Include specific details from the retrieved data — exact dates, temperatures, numbers, names. Do not be vague or generic; use the actual values found. Be natural and don\'t mention "steps".' },
                    { role: 'user', content: `Goal: ${skill.skill_description}\n\n${hybridPlan.steps.map((s, i) => `${s.title}:\n${stepSummaries[i] || 'skipped'}`).join('\n\n')}` }
                ]
            });
            output = res.choices[0].message.content || '';
            console.log(output + '\n');
        }
    }
    else if (skill.skill_type === 'chat' || !skill.execution_plan) {
        // Chat skill
        const template = JSON.parse(skill.chat_template || '{}');
        const runtimeVarValues = await collectRuntimeVars(rl, template.runtimeVariables || []);
        let systemPrompt = template.systemPrompt || '';
        for (const [k, v] of Object.entries(runtimeVarValues)) {
            systemPrompt = systemPrompt.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), v);
        }
        const extraContext = fmtRuntimeVars(runtimeVarValues);
        if (extraContext)
            systemPrompt += `\n\nUser inputs for this run:\n${extraContext}`;
        if (learnedImprovements.length) {
            systemPrompt += `\n\nNote from previous runs:\n${learnedImprovements.map(l => `• ${l}`).join('\n')}`;
        }
        console.log(`\nRunning "skills/${skill.skill_name}"...\n`);
        try {
            const res = await openai.chat.completions.create({
                model: 'gpt-4o',
                max_tokens: 2000,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: 'Generate the output now.' }
                ]
            });
            output = res.choices[0].message.content || '';
            console.log(output + '\n');
            success = true;
        }
        catch (err) {
            output = err instanceof Error ? err.message : String(err);
            console.error('\n❌ ' + output + '\n');
        }
    }
    else {
        // Browser skill
        const plan = JSON.parse(skill.execution_plan);
        const runtimeVarValues = await collectRuntimeVars(rl, plan.runtimeVariables || []);
        const agentPrompt = planToPrompt(skill.skill_name, plan, {}, learnedImprovements, runtimeVarValues);
        console.log(`\nRunning "skills/${skill.skill_name}"...\n`);
        let lastLine = '';
        try {
            output = await runAgentWithExtension(agentPrompt, userId, async (step) => {
                if (lastLine)
                    process.stdout.write('\r' + ' '.repeat(lastLine.length) + '\r');
                lastLine = step;
                process.stdout.write(step);
                stepLog.push(step);
            }, undefined, false, undefined, undefined, false, true);
            if (lastLine)
                process.stdout.write('\n');
            success = true;
            console.log('\n✅ ' + output + '\n');
        }
        catch (err) {
            if (lastLine)
                process.stdout.write('\n');
            output = err instanceof Error ? err.message : String(err);
            console.error('\n❌ ' + output + '\n');
        }
    }
    const duration = Math.round((Date.now() - start) / 1000);
    // Update execution record
    db.prepare(`UPDATE skill_executions SET status = ?, completed_at = datetime('now'), duration_seconds = ?, error_message = ? WHERE id = ?`).run(success ? 'success' : 'error', duration, success ? null : output, execId);
    // Update skill run stats
    db.prepare(`UPDATE skills SET run_count = run_count + 1, success_count = success_count + ? WHERE id = ?`).run(success ? 1 : 0, skill.id);
    // Self-evolution: analyse every run and store learnings
    try {
        const skillType = skill.skill_type || 'browser';
        const plan = skill.execution_plan ? JSON.parse(skill.execution_plan) : null;
        const template = skill.chat_template ? JSON.parse(skill.chat_template) : null;
        const hybridPlanForAnalysis = skill.hybrid_plan ? JSON.parse(skill.hybrid_plan) : null;
        const analysis = await skillsApi.improveSkillAfterRun(skill.skill_description || skill.skill_name, skillType, plan, template, hybridPlanForAnalysis, stepLog, output, success, learnedImprovements);
        if (!success && analysis.suggestions.length) {
            console.log('Suggestions to fix this skill:');
            analysis.suggestions.forEach(s => console.log(`  → /edit ${skill.skill_name} "${s}"`));
            console.log();
        }
        if (analysis.newLearning) {
            const entries = analysis.newLearning.split('\n').map((l) => l.trim()).filter(Boolean);
            learnedImprovements.push(...entries);
            db.prepare(`UPDATE skills SET learned_improvements = ? WHERE id = ?`)
                .run(JSON.stringify(learnedImprovements), skill.id);
        }
        // Apply surgical field-level step updates (preferred — versioned, targeted)
        if (analysis.stepUpdates?.length && skillType === 'browser') {
            const currentPlan = JSON.parse(skill.execution_plan);
            const patchedPlan = skillsApi.applyStepUpdates(currentPlan, analysis.stepUpdates);
            await updateSkillPlan(skill.id, patchedPlan, `auto-improvement after ${success ? 'successful' : 'failed'} run`);
            console.log(`  ${analysis.stepUpdates.length} step patch(es) applied and saved (version bumped).`);
        }
        else if (analysis.updatedPlan && skillType === 'browser') {
            // Fall back to full-plan replacement (structural changes only)
            await updateSkillPlan(skill.id, analysis.updatedPlan, `full plan improvement after run`);
            console.log('Plan structurally improved and saved (version bumped).');
        }
        if (analysis.updatedTemplate && skillType === 'chat') {
            db.prepare(`UPDATE skills SET chat_template = ? WHERE id = ?`)
                .run(JSON.stringify(analysis.updatedTemplate), skill.id);
            console.log('Template improved from this run and saved automatically.');
        }
        if (analysis.updatedHybridPlan && skillType === 'hybrid') {
            db.prepare(`UPDATE skills SET hybrid_plan = ? WHERE id = ?`)
                .run(JSON.stringify(analysis.updatedHybridPlan), skill.id);
            console.log('Hybrid plan improved from this run and saved automatically.');
        }
    }
    catch {
        // Evolution analysis is best-effort — don't crash the skill run
    }
}
