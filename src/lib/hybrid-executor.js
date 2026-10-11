import OpenAI from 'openai';
import { runAgentWithExtension } from './agent-extension.js';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MAX_STEPS_PER_BATCH = 5;
const MAX_TOTAL_STEPS = 15;
async function decomposeIntoSteps(originalTask, completed) {
    const doneContext = completed.length > 0
        ? `\n\nAlready completed:\n${completed.map(r => `Step ${r.index + 1} [${r.type}]: ${r.description} → ${r.summary}`).join('\n')}`
        : '';
    const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 600,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: `Break the user's task into sequential steps. Each step is one of:
- "browser": needs a live website (navigate, read web page, click, fill forms)
- "local": needs local computer access (read/write/edit files, run shell commands, TodoWrite/TodoRead, clipboard — NO browser needed)
- "chat": ONLY for pure text synthesis/writing using output already collected from prior steps — NO tools needed at all

Rules:
- Max ${MAX_STEPS_PER_BATCH} steps per plan
- Use "local" for ANY step that touches files, directories, shell, or uses tools (TodoWrite, TodoRead, write_file, edit_file, search_in_file, run_command, get_file_info, etc.)
- NEVER use "chat" if the step involves calling any tool — "chat" means GPT directly with no tools
- "chat" is ONLY for: "combine these results into a report", "summarize what we found", "write a draft based on collected data"
- Step descriptions MUST include specific file names, paths, exact content, and parameter values from the original task — never vague like "the file" or "the specified content"
- "needs": array of 0-based indices of prior steps whose output this step requires
- Plan only the next ${MAX_STEPS_PER_BATCH} steps; don't over-decompose${doneContext}

Return JSON: { "steps": [{ "type": "browser"|"local"|"chat", "description": "...", "needs": [] }] }`,
            },
            { role: 'user', content: originalTask }
        ]
    });
    try {
        const parsed = JSON.parse(res.choices[0].message.content || '{}');
        return (parsed.steps || []).slice(0, MAX_STEPS_PER_BATCH);
    }
    catch {
        return [];
    }
}
async function summarize(output, description) {
    if (output.length <= 300)
        return output;
    const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        temperature: 0,
        messages: [
            { role: 'system', content: 'Summarize in 1-3 sentences. Keep all specific data: names, times, numbers, URLs.' },
            { role: 'user', content: `Task: ${description}\nResult: ${output}` }
        ]
    });
    return res.choices[0].message.content?.trim() || output.slice(0, 300);
}
async function runChatStep(description, contextSummaries, originalTask) {
    const res = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 1500,
        messages: [
            {
                role: 'system',
                content: `You are completing one step of a larger task. The user's full request was: "${originalTask}"${contextSummaries ? `\n\nContext from previous steps:\n${contextSummaries}` : ''}`
            },
            { role: 'user', content: description }
        ]
    });
    return res.choices[0].message.content?.trim() || '';
}
async function isComplete(originalTask, completed) {
    const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 150,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: 'Has the original task been fully completed? Return JSON: { "complete": true/false, "remaining": "what still needs doing (empty if complete)" }'
            },
            {
                role: 'user',
                content: `Original task: ${originalTask}\n\nCompleted:\n${completed.map(s => `- ${s.description}: ${s.summary}`).join('\n')}`
            }
        ]
    });
    try {
        const parsed = JSON.parse(res.choices[0].message.content || '{}');
        return { complete: Boolean(parsed.complete), remaining: parsed.remaining || '' };
    }
    catch {
        return { complete: true, remaining: '' };
    }
}
async function synthesize(originalTask, results) {
    if (results.length === 1)
        return results[0].summary;
    const res = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 2000,
        messages: [
            {
                role: 'system',
                content: `Combine these results into a single coherent response to the user's request. Be natural and direct — don't reference "steps" or the process, just deliver the answer.`
            },
            {
                role: 'user',
                content: `Request: ${originalTask}\n\nResults:\n${results.map((r, i) => `[${i + 1}] ${r.description} (${r.type}):\n${r.summary}`).join('\n\n')}`
            }
        ]
    });
    return res.choices[0].message.content?.trim() || results.map(r => r.summary).join('\n\n');
}
export async function executeHybridTask(originalTask, userId, onProgress, onConfirmationRequest) {
    const allResults = [];
    let totalStepsRun = 0;
    let remainingTask = originalTask;
    while (totalStepsRun < MAX_TOTAL_STEPS) {
        await onProgress?.(`Planning steps...`);
        const steps = await decomposeIntoSteps(remainingTask, allResults);
        if (steps.length === 0)
            break;
        for (const step of steps) {
            if (totalStepsRun >= MAX_TOTAL_STEPS)
                break;
            const globalIndex = allResults.length;
            await onProgress?.(`[Step ${globalIndex + 1}] ${step.description}`);
            const contextSummaries = step.needs
                .filter(i => i < allResults.length)
                .map(i => `${allResults[i].description}: ${allResults[i].summary}`)
                .join('\n');
            let rawOutput;
            try {
                if (step.type === 'browser' || step.type === 'local') {
                    const taskWithContext = [
                        `ORIGINAL FULL TASK:\n${originalTask}`,
                        contextSummaries ? `CONTEXT FROM COMPLETED STEPS:\n${contextSummaries}` : '',
                        `YOUR SPECIFIC STEP TO EXECUTE NOW:\n${step.description}`,
                    ].filter(Boolean).join('\n\n---\n\n');
                    // local steps skip browser tab setup (no CDP connection, no "debugging" banner)
                    const localOnly = step.type === 'local';
                    rawOutput = await runAgentWithExtension(taskWithContext, userId, onProgress ?? (async () => { }), undefined, false, undefined, undefined, false, false, undefined, onConfirmationRequest, localOnly);
                }
                else {
                    rawOutput = await runChatStep(step.description, contextSummaries, originalTask);
                }
            }
            catch (err) {
                rawOutput = `Step failed: ${err instanceof Error ? err.message : String(err)}`;
            }
            const summary = await summarize(rawOutput, step.description);
            allResults.push({ index: globalIndex, type: step.type, description: step.description, summary });
            totalStepsRun++;
        }
        if (totalStepsRun >= MAX_TOTAL_STEPS)
            break;
        const { complete, remaining } = await isComplete(originalTask, allResults);
        if (complete)
            break;
        remainingTask = remaining || originalTask;
    }
    await onProgress?.(`Combining results...`);
    return synthesize(originalTask, allResults);
}
