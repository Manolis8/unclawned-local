import { resolveRuntime } from './model-router.js'
import { ExecutionPlan, ClarifyingQuestion, InputVariable, ChatSkillTemplate, HybridSkillPlan, RuntimeVariable, StepFieldUpdate } from './types.js'
import { frictionRegistryForPrompt, FRICTION_NAMES } from './friction-registry.js'
import { subSkillLibraryForPrompt, SUB_SKILL_NAMES } from './sub-skills.js'

const _rt = () => resolveRuntime()

function extractVariables(plan: ExecutionPlan): InputVariable[] {
  return (plan.variables || []).map((varName, idx) => ({
    id: `var-${idx}`,
    skill_id: '',
    variable_name: varName,
    variable_type: 'text' as const,
    description: `Enter value for ${varName}`,
    is_required: true,
    created_at: new Date().toISOString()
  }))
}

export const skillsApi = {
  async generateQuestions(description: string): Promise<ClarifyingQuestion[]> {
    try {
      console.log('[GPT] Generating clarifying questions for:', description.substring(0, 50))

      const response = await _rt().fastClient.chat.completions.create({
        model: _rt().modelFor('medium'),
        temperature: 0.7,
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content: `You are helping design a browser automation skill. You are NOT performing the task yourself — you are asking questions to help BUILD the automation correctly. The skill will run on a real Chrome browser controlled by an AI agent.

Given a user's skill description, generate 3-5 clarifying questions to understand their needs.

RULES:
- Every question MUST be multiple_choice with 2-4 concrete options
- NEVER generate open-ended or free-text questions — always provide explicit choices
- For any detail that might vary each time the skill runs (e.g. topic, destination, name, style), include "Ask each time I run this" as the LAST option
- Focus on decisions that meaningfully change how the skill is built

Return ONLY valid JSON (no markdown, no preamble):
[
  {
    "question": "Should the repository be public or private?",
    "type": "multiple_choice",
    "options": ["Public", "Private", "Ask each time I run this"]
  },
  {
    "question": "What style should the output be?",
    "type": "multiple_choice",
    "options": ["Detailed analysis", "Bullet points", "Short summary", "Ask each time I run this"]
  },
  {
    "question": "Which specific topic should be searched?",
    "type": "multiple_choice",
    "options": ["Ask each time I run this"]
  }
]`
          },
          { role: 'user', content: description }
        ]
      })

      const content = response.choices[0].message.content || '[]'

      try {
        return JSON.parse(content)
      } catch {
        const jsonMatch = content.match(/\[[\s\S]*\]/)
        if (jsonMatch) return JSON.parse(jsonMatch[0])
        console.warn('[GPT] Could not parse questions, returning empty array')
        return []
      }
    } catch (error) {
      console.error('[GPT] Error generating questions:', error)
      throw error
    }
  },

  async generatePlan(
    description: string,
    answers: Record<string, string>
  ): Promise<{
    plan: ExecutionPlan
    questions: ClarifyingQuestion[]
    inputs: InputVariable[]
  }> {
    try {
      console.log('[GPT] Generating plan for:', description.substring(0, 50))

      if (Object.keys(answers).length === 0) {
        const questions = await this.generateQuestions(description)
        return {
          plan: {
            steps: [],
            variables: [],
            estimatedTime: '',
            errorHandling: { maxRetries: 3, pauseOnError: false, userInterventionSteps: [] }
          },
          questions,
          inputs: []
        }
      }

      const answerContext = Object.entries(answers)
        .map(([q, a]) => `Q: ${q}\nA: ${a}`)
        .join('\n\n')

      // ── Turn 1: Phase decomposition (cheap, fast, catches misunderstandings) ──
      let phaseContext = ''
      try {
        const phaseRes = await _rt().fastClient.chat.completions.create({
          model: _rt().modelFor('low'),
          temperature: 0.2,
          max_tokens: 300,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `Break this browser automation task into 2-6 high-level phases (not steps — phases are bigger chunks).
Return JSON: { "phases": [{ "number": 1, "name": "Short phase name", "description": "one sentence what this phase achieves" }] }
Keep names short (2-4 words). Cover the whole task from start to finish.`
            },
            { role: 'user', content: `Task: ${description}\n\nUser preferences:\n${answerContext}` }
          ]
        })
        const phaseData = JSON.parse(phaseRes.choices[0].message.content || '{}')
        if (phaseData.phases?.length) {
          phaseContext = `\n\nTASK PHASES (structure your steps to cover all of these):\n${phaseData.phases.map((p: any) => `  ${p.number}. ${p.name}: ${p.description}`).join('\n')}`
          console.log(`[GPT] Phase decomposition: ${phaseData.phases.length} phases`)
        }
      } catch (e) {
        console.warn('[GPT] Phase decomposition failed (continuing):', (e as Error).message)
      }

      // ── Turn 2: Happy path draft with dual-layer step format ──────────────────
      const response = await _rt().fastClient.chat.completions.create({
        model: _rt().modelFor('medium'),
        temperature: 0.3,
        max_tokens: 4000,
        messages: [
          {
            role: 'system',
            content: `You are designing automation steps for an AI agent that controls a REAL Chrome browser. You are NOT performing this task yourself — you are writing instructions the agent will follow.

Each step has TWO layers:
1. Human-readable fields (description, title) — shown in the UI to the user
2. Structured agent fields (agentAction, agentDetail, expectedPageType, successCondition, frictionBefore, goal, note) — used by the AI agent at execution time

The agent CAN browse the web, click, type, read pages, handle popups — it has a full Chrome browser. Write plans that take full advantage of that.
USER IS ALREADY LOGGED IN. Never add login or auth steps.

HOMEPAGE-FIRST RULE: For any platform-specific task (LinkedIn, Twitter/X, Instagram, Reddit, Facebook, TikTok, YouTube, GitHub, Amazon, Spotify, etc.) step 1 MUST be navigate_to the platform's MAIN HOMEPAGE (e.g., "https://www.linkedin.com" — NOT "https://www.linkedin.com/jobs/"). Navigate to specific pages only in subsequent steps. This ensures the browser has an active session before going deeper.
If the platform requires a search, put the search query as a runtimeVariable and type it into the platform's own search bar — do NOT pre-fill queries in the URL for step 1.

═══ AGENT ACTION VOCABULARY — use ONLY these for agentAction ═══
navigate_to       — browser_navigate to exact URL. Use for: start, direct page, Google search via URL.
perceive_and_read — perceive_page to understand current state. Use after navigation when URL alone isn't enough.
click_element     — browser_snapshot then click by ref or by visible text. Use for: buttons, links, tabs.
type_text         — browser_type into input. Use for: search boxes, form fields, any text entry.
read_article      — read_page_content chunks then scroll_and_read. Use for: news, docs, long-form text.
read_search_results — perceive_page on google_serp returns numbered results [1]..[N]. Use for: picking a result.
dismiss_friction  — resolve cookie banner, consent gate, popup. Put in frictionBefore, not as a step unless explicit.
go_back_to_results — go_back to previous SERP or list. Use after reading an article that didn't help.
scroll_to_find    — scroll until target element is visible.
verify_state      — perceive_page and check result. Use after form submit, after login, to confirm success.

═══ PERCEPTION CONTRACT — what perceive_page returns ═══
google_home: search bar ready — use navigate_to with search URL instead of typing
google_serp: numbered results [1]..[N] with URL and snippet
article: text chunks 2000 chars each, moreContent flag if more below
login: email/password/submit fields
cookie_banner: consent buttons (prefer Refuse over Accept)
social_feed: twitter/reddit/instagram post lists (NOT article content)
paywall: partial content only — always go_back_to_results
captcha: no content — always exit skill
unknown: list of visible interactive elements

═══ FRICTION CATALOGUE — reference by name in frictionBefore ═══
eu_cookie_banner, google_consent_gate, captcha_block, soft_paywall,
login_wall, newsletter_popup, rate_limit_page

═══ SUB-SKILL LIBRARY — use these instead of writing steps from scratch ═══
${subSkillLibraryForPrompt()}

When a step matches a sub-skill pattern, use it like this:
{
  "number": N, "title": "Search Google for flights", "action": "navigate",
  "description": "Search Google for the query to get relevant results.",
  "goal": "Land on SERP with results for the task.",
  "agentAction": "use_sub_skill", "subSkillName": "google_search",
  "subSkillParams": { "query": "{{search_query}}" },
  "expectedPageType": "any", "successCondition": "Google SERP loaded with results",
  "frictionBefore": [], "timeout": 15, "onError": "retry", "uncertain": false, "note": ""
}
Use google_search whenever the task starts with a web search.
Use article_reader after navigating to an article URL.
Use cookie_dismiss only when a cookie banner is the explicit task — for passive handling, put eu_cookie_banner in frictionBefore instead.

═══ LOCATOR RULES ═══
ONLY Playwright accessibility locators: getByRole(), getByLabel(), getByText(), getByPlaceholder()
NEVER CSS, [data-id], [jsname], nth-child, or DOM attributes
"selectors" MUST be an array of plain strings.
Set uncertain: true when unsure of exact element label/role.

═══ QUALITY CHECKLIST — verify before returning ═══
□ Every step has frictionBefore (array, even if empty [])
□ Every agentAction is from the 10-action vocabulary above
□ successCondition is checkable — not "page looks correct" but "perceive_page returns X" or "URL contains Y"
□ description is human prose (1-2 sentences) for UI display
□ goal is one sentence of intent (what completing this step achieves)

RETURN only valid JSON matching this structure:
{
  "steps": [
    {
      "number": 1,
      "title": "Navigate to Google",
      "action": "navigate",
      "url": "https://www.google.com/search?q={{search_query}}",
      "selectors": [],
      "value": "",
      "expected": "Google search results page loaded",
      "timeout": 10,
      "onError": "retry",
      "uncertain": false,
      "description": "Navigate to Google with the search query pre-filled in the URL to land directly on the results page.",
      "goal": "Reach Google SERP with results for the given query.",
      "agentAction": "navigate_to",
      "agentDetail": "https://www.google.com/search?q={{search_query}}",
      "expectedPageType": "any",
      "successCondition": "perceive_page returns google_serp with at least 3 results",
      "frictionBefore": ["eu_cookie_banner", "google_consent_gate"],
      "note": ""
    }
  ],
  "variables": [],
  "estimatedTime": "30-60 seconds",
  "errorHandling": { "maxRetries": 3, "pauseOnError": false, "userInterventionSteps": [] },
  "runtimeVariables": [
    { "name": "search_query", "question": "What should I search for?", "type": "text" }
  ]
}

Keep steps focused on key interactions. The agent handles small sub-actions automatically.

═══ FIXED vs DYNAMIC VALUES — CRITICAL ═══
Before writing any step detail, classify every value as FIXED or DYNAMIC:

FIXED — hardcode it directly in the step:
- Values that are always the same for THIS specific skill regardless of who runs it
- Examples: "click the Remote filter" (if this skill is specifically for remote jobs), "navigate to linkedin.com"

DYNAMIC — replace with {{variable_name}} and add to runtimeVariables:
- Search terms, keywords, job titles, company names
- Dates, date ranges, time periods
- Amounts, prices, quantities
- Locations (city, country) — unless the skill is explicitly for one location
- Names (people, products, brands) provided by the user
- Any value the user would naturally want to change between runs

RULE: When in doubt, make it a variable. A skill with variables is reusable. A skill with hardcoded user-specific values is single-use.

Set runtimeVariables for every DYNAMIC value. Use type "choice" with options for fixed sets.
If truly nothing varies, set "runtimeVariables": [].`
          },
          {
            role: 'user',
            content: `Skill Description:\n${description}\n\nUser Preferences:\n${answerContext}${phaseContext}\n\nGenerate the complete execution plan as JSON.`
          }
        ]
      })

      const t2Content = response.choices[0].message.content || '{}'
      let plan: ExecutionPlan
      try {
        plan = JSON.parse(t2Content)
      } catch {
        const mdMatch = t2Content.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (mdMatch) {
          plan = JSON.parse(mdMatch[1])
        } else {
          const objMatch = t2Content.match(/\{[\s\S]*\}/)
          if (objMatch) {
            plan = JSON.parse(objMatch[0])
          } else {
            throw new Error('Could not parse GPT response as JSON')
          }
        }
      }

      if (!plan.steps || !Array.isArray(plan.steps) || plan.steps.length === 0) {
        throw new Error('Plan has no steps')
      }

      plan.variables = plan.variables || []
      plan.estimatedTime = plan.estimatedTime || '30 seconds'
      plan.errorHandling = plan.errorHandling || { maxRetries: 3, pauseOnError: false, userInterventionSteps: [] }
      plan.runtimeVariables = plan.runtimeVariables || []
      console.log(`[GPT] Turn 2 complete: ${plan.steps.length} steps`)

      // ── Turn 3: Friction augmentation ─────────────────────────────────────────
      try {
        const t3Res = await _rt().fastClient.chat.completions.create({
          model: _rt().modelFor('medium'),
          temperature: 0.1,
          max_tokens: 3000,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `You are completing the friction handling for a browser automation skill plan.

FRICTION REGISTRY (reference entries by name):
${frictionRegistryForPrompt()}

TASK: Review every step's frictionBefore array. For each step ask: "What friction from the registry could appear BEFORE or DURING this step runs?"
Guidelines:
- Navigation to any Google property on first visit: eu_cookie_banner, google_consent_gate
- Navigation to any EU-accessible site on first visit: eu_cookie_banner
- Any step that loads content from a third-party site: soft_paywall, newsletter_popup
- Any step on x.com / twitter.com: twitter_login_wall
- Any step that loads a new page: captcha_block is possible
- Steps that don't load new pages (type, click within a form): usually []
- If no friction is likely for a step: set frictionBefore to [] explicitly (never omit it)

Return the COMPLETE plan JSON with updated frictionBefore arrays. Do not change any other fields.`
            },
            {
              role: 'user',
              content: `Skill: ${description}\n\nPlan:\n${JSON.stringify(plan, null, 2)}`
            }
          ]
        })
        const t3Data = JSON.parse(t3Res.choices[0].message.content || '{}')
        if (t3Data.steps?.length === plan.steps.length) {
          // Merge only frictionBefore from Turn 3 back into the plan
          plan.steps = plan.steps.map((step: any, i: number) => ({
            ...step,
            frictionBefore: Array.isArray(t3Data.steps[i]?.frictionBefore)
              ? t3Data.steps[i].frictionBefore
              : (step.frictionBefore ?? [])
          }))
          console.log('[GPT] Turn 3 complete: friction augmentation applied')
        }
      } catch (e) {
        console.warn('[GPT] Friction augmentation failed (continuing):', (e as Error).message)
      }

      // ── Turn 4: Failure mode pass ──────────────────────────────────────────────
      try {
        const t4Res = await _rt().fastClient.chat.completions.create({
          model: _rt().modelFor('medium'),
          temperature: 0.1,
          max_tokens: 3000,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `You are adding structured failure handling to a browser automation skill plan.

TASK: For every step, add an "onFailureMode" field describing exactly what should happen when the step fails.

onFailureMode options:
  { "type": "retry", "maxAttempts": 2 }  — retry the same action (max 3 attempts)
  { "type": "skipToStep", "stepNumber": N, "reason": "why" }  — jump to step N (must exist)
  { "type": "frictionHandler", "handlerName": "friction_name" }  — treat the failure as friction and resolve it
  { "type": "exitSkill", "errorCode": "CODE", "userMessage": "shown to user" }  — stop the skill entirely

Rules for choosing:
- Navigate step fails to load: retry maxAttempts 2
- Click/type step can't find element: retry maxAttempts 1, then if still failing: exitSkill
- Read/verify step finds nothing: if there are more results to try, skipToStep the retry step; otherwise exitSkill
- Any step where failure means the task is impossible: exitSkill with a clear userMessage
- Never use "pause" — the agent runs unattended
- skipToStep.stepNumber must be a real step number in the plan

Valid friction handler names: ${FRICTION_NAMES.join(', ')}

Return the COMPLETE plan JSON with onFailureMode added to every step. Do not change any other fields.`
            },
            {
              role: 'user',
              content: `Skill: ${description}\n\nPlan:\n${JSON.stringify(plan, null, 2)}`
            }
          ]
        })
        const t4Data = JSON.parse(t4Res.choices[0].message.content || '{}')
        if (t4Data.steps?.length === plan.steps.length) {
          // Merge only onFailureMode from Turn 4
          plan.steps = plan.steps.map((step: any, i: number) => ({
            ...step,
            onFailureMode: t4Data.steps[i]?.onFailureMode ?? step.onFailureMode ?? null
          }))
          console.log('[GPT] Turn 4 complete: failure modes applied')
        }
      } catch (e) {
        console.warn('[GPT] Failure mode pass failed (continuing):', (e as Error).message)
      }

      const inputs = extractVariables(plan)

      const validation = skillsApi.validatePlan(plan)
      if (!validation.valid) {
        console.warn('[GPT] Generated plan has validation errors:', validation.errors)
      }
      if (validation.warnings?.length) {
        console.warn('[GPT] Generated plan warnings:', validation.warnings)
      }
      console.log(`[GPT] Generated plan with ${plan.steps.length} steps`)

      return { plan, questions: [], inputs }
    } catch (error) {
      console.error('[GPT] Error generating plan:', error)
      throw error
    }
  },

  validatePlan(plan: ExecutionPlan): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = []
    const warnings: string[] = []

    const VALID_AGENT_ACTIONS = [
      'navigate_to', 'perceive_and_read', 'click_element', 'type_text',
      'read_article', 'read_search_results', 'dismiss_friction',
      'go_back_to_results', 'scroll_to_find', 'verify_state', 'use_sub_skill'
    ]

    if (!plan.steps || plan.steps.length === 0) {
      errors.push('Plan has no steps')
      return { valid: false, errors, warnings }
    }

    plan.steps.forEach((step: any, idx) => {
      if (!step.number || step.number !== idx + 1) {
        errors.push(`Step ${idx + 1} has invalid number`)
      }

      const isSubSkillStep = step.agentAction === 'use_sub_skill'

      if (!isSubSkillStep) {
        if (!['navigate', 'click', 'type', 'verify', 'wait'].includes(step.action)) {
          errors.push(`Step ${step.number} has invalid action: ${step.action}`)
        }

        if (step.action === 'navigate' && !step.url) {
          errors.push(`Step ${step.number} (navigate) missing URL`)
        }

        if ((step.action === 'click' || step.action === 'type') && !step.selectors?.length) {
          errors.push(`Step ${step.number} (${step.action}) missing selectors`)
        }

        if (step.action === 'type' && !step.value) {
          errors.push(`Step ${step.number} (type) missing value`)
        }
      }

      if (isSubSkillStep && !step.subSkillName) {
        errors.push(`Step ${step.number} uses use_sub_skill but missing subSkillName`)
      }

      if (isSubSkillStep && step.subSkillName && !SUB_SKILL_NAMES.includes(step.subSkillName)) {
        warnings.push(`Step ${step.number} references unknown sub-skill: ${step.subSkillName}`)
      }

      if (!step.timeout || step.timeout <= 0) {
        errors.push(`Step ${step.number} has invalid timeout`)
      }

      if (!['retry', 'pause', 'abort'].includes(step.onError)) {
        errors.push(`Step ${step.number} has invalid onError: ${step.onError}`)
      }

      // Rich field checks (warn only — old plans without these still run)
      if (step.agentAction && !VALID_AGENT_ACTIONS.includes(step.agentAction)) {
        warnings.push(`Step ${step.number} has unknown agentAction: ${step.agentAction}`)
      }
      if (step.frictionBefore !== undefined && !Array.isArray(step.frictionBefore)) {
        warnings.push(`Step ${step.number} frictionBefore must be an array`)
      }
      if (step.agentAction && !step.successCondition) {
        warnings.push(`Step ${step.number} has agentAction but no successCondition`)
      }
      if (step.agentAction && !step.goal) {
        warnings.push(`Step ${step.number} has agentAction but no goal`)
      }

      // onFailureMode checks
      if (step.onFailureMode) {
        const ofm = step.onFailureMode
        const VALID_FAILURE_TYPES = ['retry', 'skipToStep', 'frictionHandler', 'exitSkill']
        if (!VALID_FAILURE_TYPES.includes(ofm.type)) {
          warnings.push(`Step ${step.number} onFailureMode.type is invalid: ${ofm.type}`)
        }
        if (ofm.type === 'skipToStep' && ofm.stepNumber !== undefined) {
          if (ofm.stepNumber < 1 || ofm.stepNumber > plan.steps.length) {
            warnings.push(`Step ${step.number} onFailureMode.skipToStep references non-existent step ${ofm.stepNumber}`)
          }
        }
        if (ofm.type === 'frictionHandler' && !ofm.handlerName) {
          warnings.push(`Step ${step.number} onFailureMode.frictionHandler missing handlerName`)
        }
        if (ofm.type === 'exitSkill' && !ofm.errorCode) {
          warnings.push(`Step ${step.number} onFailureMode.exitSkill missing errorCode`)
        }
      }
    })

    return { valid: errors.length === 0, errors, warnings }
  },

  async detectSkillType(description: string): Promise<'browser' | 'chat' | 'hybrid'> {
    const res = await _rt().fastClient.chat.completions.create({
      model: _rt().modelFor('low'),
      max_tokens: 5,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `Classify this skill. Reply with ONLY the number:
1 = Browser only (purely web automation — clicking, filling forms, navigating sites)
2 = Chat only (purely reasoning, writing, planning — no web access needed at all)
3 = Hybrid (genuinely needs BOTH: e.g. check calendar THEN generate a plan based on it, scrape data THEN write a report, look up info online AND reason about it)

Prefer 1 or 2. Use 3 only when the skill truly can't work without both a browser step AND a reasoning/writing step.

Examples:
"add event to google calendar" → 1
"create a weekly diet plan" → 2
"check my calendar next week and build a diet plan around my schedule" → 3
"search for flights and write a travel itinerary" → 3
"send an email" → 1
"write a workout plan" → 2`
        },
        { role: 'user', content: description }
      ]
    })
    const v = res.choices[0].message.content?.trim()
    if (v === '1') return 'browser'
    if (v === '3') return 'hybrid'
    return 'chat'
  },

  async generateHybridPlan(
    description: string,
    answers: Record<string, string>
  ): Promise<HybridSkillPlan> {
    const answerContext = Object.entries(answers).map(([q, a]) => `Q: ${q}\nA: ${a}`).join('\n\n')

    const res = await _rt().fastClient.chat.completions.create({
      model: _rt().modelFor('medium'),
      temperature: 0.3,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are designing an automation plan for an AI agent that controls a REAL Chrome browser. You are NOT performing this task yourself — you are writing instructions the agent will follow.

This is a hybrid skill — a sequence of BROWSER steps (Chrome automation) and CHAT steps (AI reasoning/writing).

RULES:
- User is already logged in to all services. NEVER include login steps.
- Each step is "browser" (Chrome automation) or "chat" (pure AI reasoning/writing — no browser needed)
- "needs": 0-based indices of prior steps whose output this step must use

═══ BROWSER STEP AGENT ACTIONS — agentAction must be one of ═══
navigate_to       — go directly to a URL
perceive_and_read — read current page state
click_element     — click a button/link by Playwright locator
type_text         — type into an input field
read_article      — read long-form article content chunk by chunk
read_search_results — read Google SERP numbered results
go_back_to_results — go back to previous list/SERP
scroll_to_find    — scroll until target element visible
verify_state      — confirm action succeeded

═══ FRICTION — reference by name in frictionBefore ═══
eu_cookie_banner, google_consent_gate, soft_paywall, newsletter_popup, twitter_login_wall, captcha_block

═══ BROWSER STEP SCHEMA ═══
{
  "number": N, "type": "browser",
  "title": "Short label",
  "description": "Human-readable prose (1-2 sentences) — shown in the UI",
  "goal": "One sentence — what completing this step achieves",
  "url": "https://...",
  "selectors": ["getByRole('button', { name: 'Search' })"],
  "expected": "what the page should show after",
  "timeout": 10,
  "onError": "retry",
  "uncertain": false,
  "needs": [],
  "agentAction": "navigate_to",
  "agentDetail": "https://www.google.com/search?q={{query}}",
  "expectedPageType": "google_serp",
  "successCondition": "perceive_page returns google_serp with at least 3 results",
  "frictionBefore": ["eu_cookie_banner", "google_consent_gate"],
  "onFailureMode": {"type": "retry", "maxAttempts": 2}
}

Selectors: ONLY Playwright accessibility locators (getByRole, getByLabel, getByText, getByPlaceholder). Never CSS. Set uncertain:true if unsure.
onFailureMode options: {"type":"retry","maxAttempts":2} | {"type":"skipToStep","stepNumber":N,"reason":"..."} | {"type":"exitSkill","errorCode":"X","userMessage":"..."}

═══ CHAT STEP SCHEMA ═══
{
  "number": N, "type": "chat",
  "title": "Short label",
  "description": "Exactly what to reason/write/synthesise and which prior step outputs to use. Be specific — reference actual data from prior steps.",
  "needs": [0]
}

Return JSON:
{
  "steps": [...],
  "variables": [],
  "estimatedTime": "1-2 minutes",
  "runtimeVariables": [
    { "name": "query", "question": "What should I search for?", "type": "text" },
    { "name": "tone", "question": "Summary style?", "type": "choice", "options": ["Bullet points", "Short paragraph", "Detailed"] }
  ]
}

Include runtimeVariables for anything the user provides each run. If nothing varies, set "runtimeVariables": [].`
        },
        {
          role: 'user',
          content: `Skill: ${description}\n\nUser preferences:\n${answerContext}`
        }
      ]
    })

    const parsed = JSON.parse(res.choices[0].message.content || '{}')
    const userPreferences = Object.entries(answers)
      .filter(([, v]) => v)
      .map(([q, a]) => `${q}: ${a}`)
      .join('\n') || undefined
    const runtimeVariables: RuntimeVariable[] = parsed.runtimeVariables || []
    return {
      steps: parsed.steps || [],
      variables: runtimeVariables.length ? runtimeVariables.map((v: RuntimeVariable) => v.name) : (parsed.variables || []),
      estimatedTime: parsed.estimatedTime || '1-3 minutes',
      userPreferences,
      runtimeVariables
    }
  },

  async generateChatSkillTemplate(
    description: string,
    answers: Record<string, string>
  ): Promise<ChatSkillTemplate> {
    const answerContext = Object.entries(answers).map(([q, a]) => `Q: ${q}\nA: ${a}`).join('\n\n')

    const res = await _rt().fastClient.chat.completions.create({
      model: _rt().modelFor('medium'),
      temperature: 0.3,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are creating a reusable AI skill — a smart template the user can run any time.

The skill is a chat/reasoning skill (no browser needed). Design a system prompt that makes the AI do exactly what the user wants, every time, with their specific inputs.

Return JSON:
{
  "systemPrompt": "You are a ... [full detailed system prompt with {{ variable }} placeholders where the user provides specific values]",
  "variables": ["variable_name_1", "variable_name_2"],
  "outputDescription": "One sentence: what this skill produces each time it runs",
  "exampleOutput": "A brief example of what a response looks like",
  "runtimeVariables": [
    { "name": "variable_name_1", "question": "What should the question be for this input?", "type": "text" },
    { "name": "tone", "question": "What tone do you want?", "type": "choice", "options": ["Professional", "Casual", "Motivational"] }
  ]
}

Rules:
- systemPrompt should be thorough — it defines the AI's entire behavior for this skill
- Use {{ variable_name }} placeholders in systemPrompt for anything the user provides at run time
- variables must match exactly what appears in {{ }} in the systemPrompt
- runtimeVariables must match variables — give each a clear question the user will be asked at run time
- Use type "choice" with options when the input is a fixed set (e.g. tone, style, format)
- Make the skill reusable — it should work great every single time it's run`
        },
        {
          role: 'user',
          content: `Skill description: ${description}\n\nUser preferences:\n${answerContext}`
        }
      ]
    })

    const parsed = JSON.parse(res.choices[0].message.content || '{}')
    const runtimeVariables: RuntimeVariable[] = parsed.runtimeVariables || []
    return {
      systemPrompt: parsed.systemPrompt || description,
      variables: runtimeVariables.length ? runtimeVariables.map((v: RuntimeVariable) => v.name) : (parsed.variables || []),
      outputDescription: parsed.outputDescription || 'AI-generated output',
      exampleOutput: parsed.exampleOutput,
      runtimeVariables
    }
  },

  async improveSkillAfterRun(
    description: string,
    skillType: 'browser' | 'chat' | 'hybrid',
    currentPlan: ExecutionPlan | null,
    currentTemplate: ChatSkillTemplate | null,
    currentHybridPlan: HybridSkillPlan | null,
    stepLog: string[],
    output: string,
    success: boolean,
    learnedImprovements: string[]
  ): Promise<{
    summary: string
    issues: string[]
    suggestions: string[]
    stepUpdates: StepFieldUpdate[]
    updatedPlan: ExecutionPlan | null
    updatedTemplate: ChatSkillTemplate | null
    updatedHybridPlan: HybridSkillPlan | null
    newLearning: string
  }> {
    const priorLearning = learnedImprovements.length > 0
      ? `\nPrevious runs taught us:\n${learnedImprovements.map(l => `• ${l}`).join('\n')}`
      : ''

    const currentContent = skillType === 'browser'
      ? `Current plan:\n${JSON.stringify(currentPlan, null, 2)}`
      : skillType === 'chat'
        ? `Current template:\n${JSON.stringify(currentTemplate, null, 2)}`
        : `Current hybrid plan:\n${JSON.stringify(currentHybridPlan, null, 2)}`

    const browserStepUpdateInstruction = skillType === 'browser' || skillType === 'hybrid' ? `
STEP UPDATES (surgical field-level patches — safer than replacing the whole plan):
For browser steps, produce "stepUpdates" — an array of targeted field patches.
Valid fields: selectors, fallbackSelectors, frictionBefore, agentDetail, note, successCondition, expectedPageType

Examples:
- Agent typed into eN successfully → infer the Playwright locator and add it to selectors:
  { "stepNumber": 2, "field": "selectors", "newValue": ["getByRole('combobox', { name: 'Search' })"], "reason": "agent typed successfully into this element" }
- A friction type appeared that wasn't listed in frictionBefore → add it:
  { "stepNumber": 3, "field": "frictionBefore", "newValue": ["newsletter_popup"], "reason": "newsletter popup appeared before article content loaded" }
  NOTE: for frictionBefore, newValue is MERGED (not replaced) with the existing array.
- Agent used a wrong path then corrected → update agentDetail:
  { "stepNumber": 1, "field": "agentDetail", "newValue": "https://www.google.com/search?q={{query}}", "reason": "direct URL is faster than typing in search box" }

Only create stepUpdates where something concrete was learned from this run.
Leave "stepUpdates": [] if nothing specific was learned.
` : ''

    const updateInstruction = skillType === 'chat'
      ? 'If output was poor quality, improve the system prompt. Set updatedTemplate with the improved template, leave updatedPlan and updatedHybridPlan null.'
      : 'Set updatedPlan / updatedHybridPlan only as a LAST RESORT for structural changes that cannot be expressed as stepUpdates. Prefer stepUpdates for targeted fixes.'

    const res = await _rt().fastClient.chat.completions.create({
      model: _rt().modelFor('medium'),
      max_tokens: 3000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are analyzing a browser automation skill run and improving the skill for future runs.

ELEMENT HANDLE RULE: "Typing into eN", "Clicking eN", "Scrolled eN" in the execution log are internal accessibility-tree handles. The action succeeded on that element. Infer the Playwright locator from context (URL, step goal, value typed) and record it as a stepUpdate for that step's selectors field.
${browserStepUpdateInstruction}
Return JSON:
{
  "summary": "1-2 sentences what happened in the run",
  "issues": ["specific things that went wrong — flag eN element handle references"],
  "suggestions": [
    "if a simpler/faster path exists (direct URL vs menu navigation), suggest it",
    "if agent took a wrong path then corrected, suggest removing the wrong step"
  ],
  "stepUpdates": [],
  "updatedPlan": null,
  "updatedTemplate": null,
  "updatedHybridPlan": null,
  "newLearning": "One entry per line. Two types:\n1. '<element>: <locator> — <action>' e.g. 'Google search box: getByRole(\"combobox\", { name: \"Search\" }) — typed \"weather Athens\"'\n2. 'AVOID: <wrong path> — USE INSTEAD: <correct path>'\nLeave empty string if nothing to record."
}

${updateInstruction}${priorLearning}`
        },
        {
          role: 'user',
          content: `Skill goal: ${description}\nType: ${skillType}\nSuccess: ${success}\n\nExecution log:\n${stepLog.join('\n')}\n\nResult:\n${output}\n\n${currentContent}`
        }
      ]
    })

    const r = JSON.parse(res.choices[0].message.content || '{}')
    return {
      summary: r.summary || '',
      issues: r.issues || [],
      suggestions: r.suggestions || [],
      stepUpdates: Array.isArray(r.stepUpdates) ? r.stepUpdates : [],
      updatedPlan: r.updatedPlan || null,
      updatedTemplate: r.updatedTemplate || null,
      updatedHybridPlan: r.updatedHybridPlan || null,
      newLearning: r.newLearning || ''
    }
  },

  applyStepUpdates(plan: ExecutionPlan, updates: StepFieldUpdate[]): ExecutionPlan {
    if (!updates.length) return plan
    const updatedSteps = (plan.steps as any[]).map(step => {
      const patches = updates.filter(u => u.stepNumber === step.number)
      if (!patches.length) return step
      const patched = { ...step }
      for (const patch of patches) {
        if (patch.field === 'frictionBefore' && Array.isArray(patch.newValue)) {
          // Merge — never replace, only add new entries
          const existing: string[] = patched.frictionBefore ?? []
          patched.frictionBefore = [...new Set([...existing, ...patch.newValue])]
        } else if (patch.field === 'selectors' && Array.isArray(patch.newValue)) {
          // Prepend new (verified) selectors before existing ones so they're tried first
          const existing: string[] = patched.selectors ?? []
          patched.selectors = [...new Set([...patch.newValue, ...existing])]
        } else {
          patched[patch.field] = patch.newValue
        }
      }
      return patched
    })
    return { ...plan, steps: updatedSteps }
  },
}
