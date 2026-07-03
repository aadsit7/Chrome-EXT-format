import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { executeAlexaTool } from './alexa-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(path.join(here, 'system-prompt.md'), 'utf8');

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 400;
const MAX_TOOL_ITERATIONS = 3;
const OVERALL_TIMEOUT_MS = 6500;
const TIMEOUT_FALLBACK = "That's taking me a moment — ask me again.";

// Late-bound wrapper: uses Node 20's native fetch and lets the local test
// harness stub globalThis.fetch to intercept API calls.
const client = new Anthropic({ fetch: (...args) => globalThis.fetch(...args) });

const TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
  {
    name: 'create_reminder',
    description:
      'Create an Alexa reminder that will announce the given text at the given time on the user’s Echo device. Use when the user asks to be reminded of something at a specific time or date.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to remind the user about, phrased naturally (e.g. "call mom").' },
        when: {
          type: 'string',
          description: 'ISO 8601 local datetime with NO timezone suffix, e.g. 2026-07-03T17:00:00. Compute from the current local time provided in the conversation.',
        },
        recurrence: { type: 'string', description: 'Optional recurrence like DAILY or WEEKLY. Omit for one-time reminders.' },
      },
      required: ['text', 'when'],
    },
  },
  {
    name: 'set_timer',
    description:
      'Start a countdown timer on the user’s Echo device. Use for requests like "set a timer for 10 minutes".',
    input_schema: {
      type: 'object',
      properties: {
        duration_minutes: { type: 'number', description: 'Timer length in minutes.' },
        label: { type: 'string', description: 'Short label for the timer, e.g. "pasta".' },
      },
      required: ['duration_minutes', 'label'],
    },
  },
];

/**
 * Strip markdown so the returned text is safe to speak via Alexa SSML/plain output.
 */
export function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Run the Claude agentic loop over the conversation history.
 *
 * @param {Array<{role: string, content: any}>} history - conversation turns, last one the new user message
 * @param {object} options
 * @param {object|null} options.alexaContext - { apiEndpoint, apiAccessToken } for tool execution; null on the web path
 * @param {string} options.timeContext - "Current local datetime: ... Timezone: ..." string injected per turn
 * @param {boolean} options.isWeb - true when serving the web chat page (Alexa tools unavailable)
 * @returns {Promise<{reply: string, needsReminderPermission: boolean}>}
 */
export async function runKyle(history, { alexaContext = null, timeContext = '', isWeb = false } = {}) {
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  let needsReminderPermission = false;

  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];
  const contextNote = [
    timeContext,
    isWeb ? 'This conversation is happening on the web chat page, not an Echo device.' : '',
  ].filter(Boolean).join(' ');
  if (contextNote) {
    systemBlocks.push({ type: 'text', text: contextNote });
  }

  const messages = history.map((m) => ({ role: m.role, content: m.content }));

  for (let iteration = 0; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
    const remaining = deadline - Date.now();
    if (remaining <= 300) {
      return { reply: TIMEOUT_FALLBACK, needsReminderPermission };
    }

    let response;
    try {
      response = await client.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: systemBlocks,
          tools: TOOLS,
          messages,
        },
        { timeout: remaining, maxRetries: 0 },
      );
    } catch (err) {
      if (err instanceof Anthropic.APIConnectionError || err?.name === 'APIConnectionTimeoutError') {
        return { reply: TIMEOUT_FALLBACK, needsReminderPermission };
      }
      throw err;
    }

    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ');
      return { reply: stripMarkdown(text) || "Hmm, I came up empty on that one.", needsReminderPermission };
    }

    // Claude wants tools: echo the assistant turn, execute each custom tool,
    // and return all results in a single user message.
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];
    for (const toolUse of toolUses) {
      const result = await executeAlexaTool(toolUse.name, toolUse.input, alexaContext, { isWeb });
      if (result.needsPermission) needsReminderPermission = true;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.content,
        is_error: Boolean(result.isError),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { reply: "I got a little tangled up there — could you ask me that again?", needsReminderPermission };
}
