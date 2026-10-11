import { scoreConfidence } from './confidence-scorer.js';
import { generateClarifyingQuestions } from './question-generator.js';
import { chatAgent } from './chat-agent.js';
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function classifyTaskType(userMessage) {
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 5,
        temperature: 0,
        messages: [
            {
                role: 'system',
                content: `Classify this task. Reply with ONLY the number:
1 = Browser task — requires visiting a live website, navigating, clicking, reading web pages, posting on social media, booking, searching online.
2 = Chat task — no execution needed. Pure reasoning, writing help, answering questions, brainstorming.
3 = Hybrid task — requires BOTH a substantial browser phase (getting live data from a website) AND a substantial separate local/writing phase. Use sparingly.
4 = Local task — purely local computer work: read/write/edit/delete files and folders, run shell commands, clipboard operations. No web browser needed at all.

RULES:
- Use 4 for anything that only touches the local filesystem or shell.
- Use 1 for anything that needs a live website (even if it also saves a file at the end).
- Use 3 only for tasks with a clear browser-research phase THEN a separate heavy writing/saving phase.
- Use 2 only when the user just wants an answer or help writing — no execution.
- If in doubt between 1 and 4, ask: does this need a website? Yes → 1, No → 4.

Examples:
"What's the weather in London?" → 1
"Book me a flight to Paris" → 1
"Post 'Hello world' on LinkedIn" → 1
"Look up the score of last night's game" → 1
"Search for restaurants near me" → 1
"Go to GitHub and star that repo" → 1
"Search LinkedIn for 5 posts about AI and save them to a file" → 3
"Check my calendar tomorrow and write me a daily plan around it" → 3
"Get my emails and draft replies to the urgent ones" → 3
"Create a folder on my Desktop called test" → 4
"Create a folder, write a file with these 5 lines, then delete it" → 4
"Make a directory, put 3 files in it with specific content, verify they exist" → 4
"Read my notes.txt and add a line at the bottom" → 4
"Run a shell command and save its output to a file" → 4
"Read my contacts CSV file" → 4
"Find my leads file and tell me what's in it" → 4
"List the files in my Documents folder" → 4
"What files do I have on my desktop?" → 4
"Create a todo list, write a python file, fix a bug in it, run python --version" → 4
"TodoWrite a plan, create a file, edit it, search it with regex, run a command" → 4
"Create 3 js files on my Desktop with specific content, search for a pattern, replace it" → 4
"Write a file, get its info, edit a specific line, run python to test it" → 4
"Any sequence of: write/read/edit/delete files + run commands + todo list operations" → 4
"How do I code in Python?" → 2
"Help me think through this decision" → 2
"Write me a LinkedIn post about AI" → 2
"Draft a tweet about my product launch" → 2`
            },
            {
                role: 'user',
                content: userMessage
            }
        ]
    });
    const result = response.choices[0].message.content?.trim() || '2';
    if (result === '1')
        return 'browser';
    if (result === '3')
        return 'hybrid';
    if (result === '4')
        return 'local';
    return 'chat';
}
export async function orchestrateTask(userMessage, userId, clarificationAnswers) {
    const hasAnswers = clarificationAnswers && clarificationAnswers.length > 0;
    let fullContext = userMessage;
    if (hasAnswers) {
        const qaBlock = clarificationAnswers.map((a, i) => `[${i + 1}] ${a}`).join('\n\n');
        fullContext = `${userMessage}\n\n--- User clarifications ---\n${qaBlock}\n--- End clarifications ---`;
    }
    // If the user already answered clarifying questions, skip confidence re-check and execute
    if (!hasAnswers) {
        console.log(`[orchestrator] Scoring confidence for: "${userMessage.slice(0, 50)}..."`);
        const confidence = await scoreConfidence(fullContext);
        console.log(`[orchestrator] Confidence: ${confidence.overall}% (intent:${confidence.intent} scope:${confidence.scope} target:${confidence.target} action:${confidence.action})`);
        if (confidence.overall <= 70) {
            console.log(`[orchestrator] LOW confidence (${confidence.overall}%) → asking questions`);
            const questions = await generateClarifyingQuestions(userMessage, confidence);
            return {
                type: 'clarify',
                questions,
                message: `I need a bit more info to help you better:`
            };
        }
        console.log(`[orchestrator] Confidence ${confidence.overall}% → executing`);
    }
    else {
        console.log(`[orchestrator] Answers provided → executing directly`);
    }
    const taskType = await classifyTaskType(fullContext);
    if (taskType === 'chat') {
        console.log(`[orchestrator] Classified as CHAT`);
        const chatResponse = await chatAgent(fullContext);
        return { type: 'chat', response: chatResponse.response };
    }
    if (taskType === 'hybrid') {
        console.log(`[orchestrator] Classified as HYBRID`);
        return { type: 'hybrid', task: fullContext };
    }
    if (taskType === 'local') {
        console.log(`[orchestrator] Classified as LOCAL`);
        return { type: 'local', task: userMessage, context: fullContext };
    }
    console.log(`[orchestrator] Classified as BROWSER`);
    return { type: 'browser', task: userMessage, context: fullContext };
}
