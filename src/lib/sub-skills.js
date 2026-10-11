export const SUB_SKILLS = [
    {
        name: 'google_search',
        description: 'Navigate to Google and get numbered search results for a query. Handles eu_cookie_banner and google_consent_gate automatically.',
        params: ['query'],
        steps: [
            {
                description: 'Navigate to Google with the query pre-filled in the URL to land directly on the results page.',
                goal: 'Land on Google SERP with results for the given query.',
                agentAction: 'navigate_to',
                agentDetail: 'https://www.google.com/search?q={{query}}',
                expectedPageType: 'any',
                successCondition: 'perceive_page returns google_serp with at least 3 results',
                frictionBefore: ['eu_cookie_banner', 'google_consent_gate'],
                onFailureMode: { type: 'retry', maxAttempts: 2 },
                note: 'Search via URL param is faster and more reliable than typing into the search box.',
            },
            {
                description: 'Read the numbered search results from the SERP to identify the best match.',
                goal: 'Get a numbered list of results so the agent can pick the most relevant one.',
                agentAction: 'read_search_results',
                agentDetail: 'call perceive_page — it returns numbered results [1]..[N] with title, URL, snippet',
                expectedPageType: 'google_serp',
                successCondition: 'at least 3 numbered results are visible in perceive_page output',
                frictionBefore: [],
                onFailureMode: { type: 'exitSkill', errorCode: 'NO_RESULTS', userMessage: 'Google returned no results for this query.' },
            },
        ],
    },
    {
        name: 'article_reader',
        description: 'Read a full article page in chunks using read_page_content + scroll_and_read. Handles soft_paywall and newsletter_popup automatically.',
        params: [],
        steps: [
            {
                description: 'Verify the current page is article content and check for friction before reading.',
                goal: 'Confirm the page is a readable article and resolve any popup or paywall blocking it.',
                agentAction: 'perceive_and_read',
                agentDetail: 'call perceive_page — verify pageType is article and content is non-empty',
                expectedPageType: 'article',
                successCondition: "perceive_page returns pageType 'article' with non-empty content",
                frictionBefore: ['soft_paywall', 'newsletter_popup'],
                onFailureMode: { type: 'frictionHandler', handlerName: 'soft_paywall' },
                note: 'If perceive_page returns paywall, go_back_to_results and try the next search result instead.',
            },
            {
                description: 'Read the article content in full, scrolling for additional chunks if needed.',
                goal: 'Extract the complete article text to satisfy the task.',
                agentAction: 'read_article',
                agentDetail: 'call read_page_content (chunk 0), then scroll_and_read for each additional chunk while moreContent is true',
                expectedPageType: 'article',
                successCondition: 'article text read until task information found or moreContent is false',
                frictionBefore: [],
                onFailureMode: { type: 'retry', maxAttempts: 1 },
            },
        ],
    },
    {
        name: 'cookie_dismiss',
        description: 'Dismiss a cookie consent banner on the current page, preferring Refuse/Reject over Accept All. Usually used in frictionBefore rather than as a step.',
        params: [],
        steps: [
            {
                description: 'Dismiss the cookie consent banner currently detected on the page.',
                goal: 'Clear the banner so the page content is fully accessible.',
                agentAction: 'dismiss_friction',
                agentDetail: 'call browser_dismiss_cookie — look for Refuse/Reject first, Accept All as fallback',
                expectedPageType: 'cookie_banner',
                successCondition: "perceive_page.pageType is no longer cookie_banner after dismiss",
                frictionBefore: [],
                onFailureMode: { type: 'retry', maxAttempts: 1 },
                note: 'If the banner cannot be dismissed after one retry, continue with the main task anyway.',
            },
        ],
    },
];
const SUB_SKILL_MAP = new Map(SUB_SKILLS.map(s => [s.name, s]));
export function getSubSkill(name) {
    return SUB_SKILL_MAP.get(name);
}
export const SUB_SKILL_NAMES = SUB_SKILLS.map(s => s.name);
export function subSkillLibraryForPrompt() {
    return SUB_SKILLS
        .map(s => `  ${s.name}(${s.params.join(', ') || ''}): ${s.description}`)
        .join('\n');
}
export function expandSubSkillInPrompt(stepNumber, subSkillName, subSkillParams, resolveVars) {
    const subSkill = SUB_SKILL_MAP.get(subSkillName);
    if (!subSkill) {
        return `Step ${stepNumber}: [unknown sub-skill: ${subSkillName}]`;
    }
    function resolveAll(text) {
        let out = text;
        // Replace sub-skill param placeholders first
        for (const [paramName, paramValue] of Object.entries(subSkillParams)) {
            out = out.replace(new RegExp(`\\{\\{\\s*${paramName}\\s*\\}\\}`, 'g'), paramValue);
        }
        // Then resolve any parent-skill variable placeholders
        return resolveVars(out);
    }
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    return subSkill.steps.map((subStep, i) => {
        const label = `${stepNumber}.${letters[i]}`;
        let line = `Step ${label}: ${resolveAll(subStep.description)} [${subStep.agentAction}]`;
        if (subStep.goal)
            line += `\n   Goal: ${subStep.goal}`;
        if (subStep.agentAction && subStep.agentDetail) {
            line += `\n   Agent tool: ${subStep.agentAction} — ${resolveAll(subStep.agentDetail)}`;
        }
        if (subStep.expectedPageType)
            line += `\n   Page before: ${subStep.expectedPageType}`;
        if (subStep.successCondition)
            line += `\n   Success when: ${subStep.successCondition}`;
        if (subStep.frictionBefore?.length)
            line += `\n   Auto-handle first: ${subStep.frictionBefore.join(', ')}`;
        if (subStep.onFailureMode) {
            const ofm = subStep.onFailureMode;
            if (ofm.type === 'retry')
                line += `\n   On failure: retry up to ${ofm.maxAttempts ?? 2} times`;
            else if (ofm.type === 'exitSkill')
                line += `\n   On failure: stop skill — ${ofm.userMessage || ofm.errorCode}`;
            else if (ofm.type === 'frictionHandler')
                line += `\n   On failure: treat as ${ofm.handlerName} and resolve`;
            else if (ofm.type === 'skipToStep')
                line += `\n   On failure: continue to next step`;
        }
        if (subStep.note)
            line += `\n   Note: ${subStep.note}`;
        return line;
    }).join('\n\n');
}
