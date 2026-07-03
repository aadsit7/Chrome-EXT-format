#!/usr/bin/env node
/**
 * Local test harness for the Kyle Lambda.
 *
 * Invokes the handler with mocked Alexa request envelopes. Calls to
 * api.amazonalexa.com are ALWAYS stubbed (no real reminders/timers are ever
 * created locally). Claude API calls are real and need ANTHROPIC_API_KEY in
 * the environment or in a .env file (lambda/.env or kyle-alexa-assistant/.env).
 *
 * Run fully offline with MOCK_CLAUDE=1 — the Claude API is then stubbed with
 * scripted responses, which exercises the whole pipeline without a key.
 *
 * Usage:  cd kyle-alexa-assistant/lambda && npm run test:local
 *         MOCK_CLAUDE=1 npm run test:local
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
// dotenv lives in lambda/node_modules — resolve from there.
const requireFromLambda = createRequire(path.join(here, '..', 'lambda', 'package.json'));
const dotenv = requireFromLambda('dotenv');
dotenv.config({ path: path.join(here, '..', 'lambda', '.env') });
dotenv.config({ path: path.join(here, '..', '.env') });

const MOCK_CLAUDE = process.env.MOCK_CLAUDE === '1' || !process.env.ANTHROPIC_API_KEY;
if (MOCK_CLAUDE) {
  process.env.ANTHROPIC_API_KEY ||= 'mock-key';
  console.log('▶ Claude API: MOCKED (set ANTHROPIC_API_KEY in .env for live calls)\n');
} else {
  console.log('▶ Claude API: LIVE (calls will be billed)\n');
}

// ---------------------------------------------------------------------------
// fetch stubbing
// ---------------------------------------------------------------------------

const alexaApiCalls = [];
const realFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockClaudeResponse(requestBody) {
  const { messages } = requestBody;
  const last = messages[messages.length - 1];
  const lastContent = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];

  // After a tool_result, Claude confirms.
  if (lastContent.some((b) => b.type === 'tool_result')) {
    return {
      id: 'msg_mock_2', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done deal, dude.' }],
      usage: { input_tokens: 100, output_tokens: 15 },
    };
  }

  const userText = lastContent.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  if (/cancel.*timer/i.test(userText)) {
    return {
      id: 'msg_mock_t1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'toolu_mock_t1', name: 'manage_timers', input: { operation: 'cancel_all' } },
      ],
      usage: { input_tokens: 100, output_tokens: 30 },
    };
  }
  if (/ampersand/i.test(userText)) {
    return {
      id: 'msg_mock_a1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Tom & Jerry is a classic, dude — cats < dogs though.' }],
      usage: { input_tokens: 50, output_tokens: 15 },
    };
  }
  if (/remind/i.test(userText)) {
    return {
      id: 'msg_mock_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use', id: 'toolu_mock_1', name: 'create_reminder',
          input: { text: 'stretch', when: '2026-07-03T17:00:00' },
        },
      ],
      usage: { input_tokens: 100, output_tokens: 40 },
    };
  }

  return {
    id: 'msg_mock_0', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Hey there — Kyle here, ready when you are.' }],
    usage: { input_tokens: 50, output_tokens: 12 },
  };
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;

  // Alexa REST APIs — always mocked so nothing real is created.
  if (url.includes('api.amazonalexa.com') || url.includes('/v1/alerts/') || url.includes('/v2/devices/')) {
    alexaApiCalls.push({ url, method: init.method ?? 'GET' });
    const method = init.method ?? 'GET';
    if (url.includes('System.timeZone')) return jsonResponse('America/Chicago');
    if (url.includes('/v1/alerts/reminders')) {
      if (method === 'GET') {
        return jsonResponse({
          totalCount: '1',
          alerts: [{
            alertToken: 'tok-1', status: 'ON',
            trigger: { scheduledTime: '2026-07-03T17:00:00' },
            alertInfo: { spokenInfo: { content: [{ text: 'stretch' }] } },
          }],
        });
      }
      if (method === 'DELETE') return jsonResponse({}, 200);
      return jsonResponse({ alertToken: 'mock-alert-token', status: 'ON' }, 201);
    }
    if (url.includes('/v1/alerts/timers')) {
      if (method === 'GET') {
        return jsonResponse({ totalCount: 1, timers: [{ id: 'timer-1', timerLabel: 'pasta', status: 'ON' }] });
      }
      if (method === 'DELETE') return jsonResponse({}, 200);
      return jsonResponse({ id: 'mock-timer-id', status: 'ON' }, 200);
    }
    return jsonResponse({}, 200);
  }

  // Claude API — mocked only in MOCK_CLAUDE mode.
  if (MOCK_CLAUDE && url.includes('api.anthropic.com')) {
    return jsonResponse(mockClaudeResponse(JSON.parse(init.body)));
  }

  return realFetch(input, init);
};

// Import AFTER stubbing so module init picks up the environment.
const { handler } = await import(path.join(here, '..', 'lambda', 'index.mjs'));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function alexaEnvelope(request, sessionAttributes = {}) {
  return {
    version: '1.0',
    session: {
      new: true,
      sessionId: 'amzn1.echo-api.session.test',
      application: { applicationId: 'amzn1.ask.skill.test' },
      attributes: sessionAttributes,
      user: { userId: 'amzn1.ask.account.test' },
    },
    context: {
      System: {
        application: { applicationId: 'amzn1.ask.skill.test' },
        user: { userId: 'amzn1.ask.account.test' },
        device: { deviceId: 'amzn1.ask.device.test', supportedInterfaces: {} },
        apiEndpoint: 'https://api.amazonalexa.com',
        apiAccessToken: 'mock-api-access-token',
      },
    },
    request,
  };
}

function intentRequest(intentName, slots = {}) {
  return {
    type: 'IntentRequest',
    requestId: `amzn1.echo-api.request.${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    locale: 'en-US',
    intent: { name: intentName, confirmationStatus: 'NONE', slots },
  };
}

function chatIntent(query) {
  return intentRequest('ChatIntent', {
    query: { name: 'query', value: query, confirmationStatus: 'NONE' },
  });
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✘ ${name}\n    ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function speechOf(response) {
  return response?.response?.outputSpeech?.ssml ?? response?.response?.outputSpeech?.text ?? '';
}

console.log('Kyle local tests\n');

await test('LaunchRequest greets and keeps session open', async () => {
  const res = await handler(
    alexaEnvelope({ type: 'LaunchRequest', requestId: 'r1', timestamp: new Date().toISOString(), locale: 'en-US' }),
    {},
  );
  assert(speechOf(res).length > 0, 'expected output speech');
  assert(res.response.shouldEndSession === false, 'expected session to stay open');
});

await test('ChatIntent plain chat returns a spoken reply and saves history', async () => {
  const res = await handler(alexaEnvelope(chatIntent('say hello to me in one short sentence')), {});
  const speech = speechOf(res);
  assert(speech.length > 0, 'expected output speech');
  assert(!/[*#`\[\]]/.test(speech), `expected no markdown in speech, got: ${speech}`);
  assert(res.response.shouldEndSession === false, 'expected session to stay open');
  assert(Array.isArray(res.sessionAttributes?.history) && res.sessionAttributes.history.length >= 2,
    'expected history in session attributes');
});

await test('ChatIntent reminder triggers create_reminder against the mocked Alexa API', async () => {
  alexaApiCalls.length = 0;
  const res = await handler(alexaEnvelope(chatIntent('remind me to stretch today at 5 pm')), {});
  assert(speechOf(res).length > 0, 'expected output speech');
  const reminderCall = alexaApiCalls.find((c) => c.url.includes('/v1/alerts/reminders') && c.method === 'POST');
  assert(reminderCall, `expected a POST to /v1/alerts/reminders; saw: ${JSON.stringify(alexaApiCalls)}`);
});

await test('ChatIntent "cancel my timers" drives manage_timers cancel_all against the mocked Alexa API', async () => {
  alexaApiCalls.length = 0;
  const res = await handler(alexaEnvelope(chatIntent('cancel my timers')), {});
  assert(speechOf(res).length > 0, 'expected output speech');
  const cancelCall = alexaApiCalls.find((c) => c.url.endsWith('/v1/alerts/timers') && c.method === 'DELETE');
  assert(cancelCall, `expected a DELETE to /v1/alerts/timers; saw: ${JSON.stringify(alexaApiCalls)}`);
});

await test('Spoken replies are SSML-escaped (& < > cannot break the <speak> envelope)', async () => {
  const res = await handler(alexaEnvelope(chatIntent('tell me about the ampersand show')), {});
  const ssml = res.response.outputSpeech.ssml ?? '';
  assert(ssml.includes('&amp;'), `expected & to be escaped as &amp; in: ${ssml}`);
  assert(ssml.includes('&lt;'), `expected < to be escaped as &lt; in: ${ssml}`);
  assert(!/& /.test(ssml), `expected no raw ampersand in: ${ssml}`);
});

await test('AMAZON.HelpIntent responds', async () => {
  const res = await handler(alexaEnvelope(intentRequest('AMAZON.HelpIntent')), {});
  assert(speechOf(res).toLowerCase().includes('kyle'), 'expected help speech mentioning Kyle');
});

await test('AMAZON.StopIntent ends the session', async () => {
  const res = await handler(alexaEnvelope(intentRequest('AMAZON.StopIntent')), {});
  assert(res.response.shouldEndSession === true, 'expected session to end');
});

await test('SessionEndedRequest is handled quietly', async () => {
  const res = await handler(
    alexaEnvelope({ type: 'SessionEndedRequest', requestId: 'r9', timestamp: new Date().toISOString(), locale: 'en-US', reason: 'USER_INITIATED' }),
    {},
  );
  assert(res.response !== undefined, 'expected a response envelope');
});

await test('Web POST path returns { reply } with CORS headers', async () => {
  const res = await handler({
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello kyle' }] }),
  });
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  assert(res.headers['Access-Control-Allow-Origin'] === '*', 'expected CORS header');
  const body = JSON.parse(res.body);
  assert(typeof body.reply === 'string' && body.reply.length > 0, 'expected a reply string');
});

await test('Web OPTIONS preflight returns 204', async () => {
  const res = await handler({ requestContext: { http: { method: 'OPTIONS' } } });
  assert(res.statusCode === 204, `expected 204, got ${res.statusCode}`);
  assert(res.headers['Access-Control-Allow-Origin'] === '*', 'expected CORS header');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
