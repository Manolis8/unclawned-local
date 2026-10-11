import type OpenAI from 'openai'

export const delegateTasksTool: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'delegate_tasks',
    description: `Spawn up to 3 independent sub-agents to work in parallel on different parts of a task. Use this when:
- A task has 2-3 clearly independent research or analysis steps that would be faster in parallel
- You need to process multiple similar items simultaneously (e.g. research 3 companies at once)
- A task has parallel drafting or writing steps with separate context

RULES:
- Maximum 3 tasks per call. If you need more, make two sequential calls.
- Sub-agents CANNOT use browser navigation tools (navigate, click, type, perceive_page). Any step requiring actual browser interaction must be done by YOU before or after delegation.
- Sub-agents CAN use: web_search, web_extract, and local file tools.
- For drafting or writing sub-tasks, set voiceContext: "user_voice" — the system will automatically inject the user's writing samples and identity so the output sounds like them.
- Do NOT delegate simple single-step tasks — the overhead is not worth it.
- Pass all necessary context explicitly in the context field. Sub-agents have no access to your conversation history.`,
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          maxItems: 3,
          description: 'The sub-tasks to run in parallel.',
          items: {
            type: 'object',
            properties: {
              goal: {
                type: 'string',
                description: 'Exactly what this sub-agent should accomplish. Be specific — this is its entire instruction.',
              },
              context: {
                type: 'string',
                description: 'Any data, content, or background this sub-agent needs. Sub-agents cannot see your conversation history — everything they need must be here.',
              },
              toolSet: {
                type: 'string',
                enum: ['browser', 'local', 'all'],
                description: '"browser" for web research (web_search + web_extract only). "local" for file/writing tasks. "all" for both. Default: "all".',
              },
              voiceContext: {
                type: 'string',
                enum: ['user_voice'],
                description: 'Set to "user_voice" for any drafting or writing sub-task. The system will inject the user\'s writing samples and identity automatically.',
              },
            },
            required: ['goal'],
          },
        },
      },
      required: ['tasks'],
    },
  },
}
