import Alexa from 'ask-sdk-core';
import { runKyle } from './claude.mjs';
import {
  loadMemory,
  saveConversation,
  clearConversation,
  clearAll,
  isRecent,
  bumpDailyCalls,
  getDailyCalls,
} from './memory.mjs';

const MAX_HISTORY_MESSAGES = 20; // last 10 user/assistant turn pairs
const REMINDERS_PERMISSION = 'alexa::alerts:reminders:skill:readwrite';
const TIMERS_PERMISSION = 'alexa::alerts:timers:skill:readwrite';

// Alexa wraps speech in an SSML <speak> envelope; unescaped &, <, > in the
// model's reply would make the SSML invalid and error on the device.
function escapeForSsml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// APL (Echo Show / display devices)
// ---------------------------------------------------------------------------

const ASSETS_BASE =
  'https://raw.githubusercontent.com/aadsit7/Chrome-EXT-format/refs/heads/claude/bookmarks-buddy-extension-cuwn8o/kyle-alexa-assistant/assets';

// APL document for the talking-Kyle screen. Notes on validity — a malformed
// document is rendered device-side, where a failure can drop the session with
// nothing in CloudWatch, so this must stay strictly to spec:
//   - Frame takes a SINGLE `item` child (an `items` array here is a spec
//     violation — the bug that broke real Echo Shows while the no-APL
//     simulator looked fine)
//   - two stacked Image frames; the open-mouth frame's opacity toggles every
//     150ms via an onMount loop for the talk cycle
//   - the caption Text is a sibling of the image stack, so a missing/failed
//     image just leaves blank space and the spoken text stays readable
const KYLE_APL_DOCUMENT = {
  type: 'APL',
  version: '1.8',
  mainTemplate: {
    parameters: ['payload'],
    items: [
      {
        type: 'Frame',
        width: '100vw',
        height: '100vh',
        backgroundColor: '#10141a',
        item: {
          type: 'Container',
          width: '100vw',
          height: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          onMount: [
            {
              type: 'Sequential',
              repeatCount: 40,
              commands: [
                { type: 'AnimateItem', componentId: 'kyleMouthOpen', duration: 150, value: [{ property: 'opacity', from: 1, to: 0 }] },
                { type: 'AnimateItem', componentId: 'kyleMouthOpen', duration: 150, value: [{ property: 'opacity', from: 0, to: 1 }] },
              ],
            },
          ],
          items: [
            {
              type: 'Container',
              width: '60vh',
              height: '60vh',
              items: [
                {
                  type: 'Image',
                  id: 'kyleMouthClosed',
                  source: '${payload.kyle.closedUrl}',
                  width: '100%',
                  height: '100%',
                  scale: 'best-fit',
                },
                {
                  type: 'Image',
                  id: 'kyleMouthOpen',
                  source: '${payload.kyle.openUrl}',
                  width: '100%',
                  height: '100%',
                  scale: 'best-fit',
                  position: 'absolute',
                },
              ],
            },
            {
              type: 'Text',
              id: 'kyleCaption',
              text: '${payload.kyle.caption}',
              width: '86vw',
              paddingTop: '3vh',
              textAlign: 'center',
              textAlignVertical: 'top',
              fontSize: '4.5vh',
              color: '#e8ecf1',
              maxLines: 4,
            },
          ],
        },
      },
    ],
  },
};

function supportsApl(handlerInput) {
  if (String(process.env.DISABLE_APL).toLowerCase() === 'true') return false; // kill switch
  const interfaces = Alexa.getSupportedInterfaces(handlerInput.requestEnvelope);
  return Boolean(interfaces['Alexa.Presentation.APL']);
}

// Basic structural validation against the APL 1.6+ / RenderDocument schema.
// Throws on any violation so withKyleScreen falls back to plain voice.
function validateAplDirective(directive) {
  if (directive.type !== 'Alexa.Presentation.APL.RenderDocument') {
    throw new Error(`bad directive type: ${directive.type}`);
  }
  if (typeof directive.token !== 'string' || directive.token.length === 0) {
    throw new Error('RenderDocument requires a non-empty token');
  }
  const doc = directive.document;
  if (!doc || doc.type !== 'APL') throw new Error('document.type must be "APL"');
  if (typeof doc.version !== 'string' || parseFloat(doc.version) < 1.6) {
    throw new Error(`document.version must be an APL 1.6+ string, got ${doc.version}`);
  }
  const mt = doc.mainTemplate;
  if (!mt || !Array.isArray(mt.parameters) || !Array.isArray(mt.items) || mt.items.length === 0) {
    throw new Error('mainTemplate must have parameters[] and items[]');
  }
}

function buildKyleAplDirective(caption) {
  const directive = {
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: 'kyleAvatar',
    document: KYLE_APL_DOCUMENT,
    datasources: {
      kyle: {
        openUrl: `${ASSETS_BASE}/kyle_talk_open_512.png`,
        closedUrl: `${ASSETS_BASE}/kyle_talk_closed_512.png`,
        caption: typeof caption === 'string' ? caption : '',
      },
    },
  };
  validateAplDirective(directive);
  return directive;
}

// Attach the Kyle avatar screen on display devices, with the spoken reply as
// a readable caption under the character; a no-op on speakers so voice-only
// behavior is completely unchanged. A display bug must NEVER kill the
// conversation: any failure building/validating/attaching the directive is
// logged and the plain voice response goes out instead.
function withKyleScreen(handlerInput, builder, caption = '') {
  try {
    if (supportsApl(handlerInput)) {
      builder.addDirective(buildKyleAplDirective(caption));
    }
  } catch (err) {
    console.error('APL disabled for this response (falling back to voice):', err);
  }
  return builder;
}

function getAlexaContext(handlerInput) {
  const system = handlerInput.requestEnvelope.context?.System ?? {};
  return {
    apiEndpoint: system.apiEndpoint,
    apiAccessToken: system.apiAccessToken,
    deviceId: system.device?.deviceId,
    permissions: system.user?.permissions,
  };
}

async function getTimeContext(handlerInput) {
  const attrs = handlerInput.attributesManager.getSessionAttributes();
  const { apiEndpoint, apiAccessToken, deviceId } = getAlexaContext(handlerInput);

  let timeZone = attrs.timeZone;
  if (!timeZone && apiEndpoint && apiAccessToken && deviceId) {
    try {
      const res = await fetch(
        `${apiEndpoint}/v2/devices/${encodeURIComponent(deviceId)}/settings/System.timeZone`,
        {
          headers: { Authorization: `Bearer ${apiAccessToken}` },
          signal: AbortSignal.timeout(1500),
        },
      );
      if (res.ok) {
        const tz = await res.json(); // should be a bare JSON string like "America/Chicago"
        // Never trust the shape: a non-string here would make toLocaleString
        // throw and kill the whole turn.
        if (typeof tz === 'string' && tz.length > 0) {
          timeZone = tz;
          attrs.timeZone = timeZone;
          handlerInput.attributesManager.setSessionAttributes(attrs);
        }
      }
    } catch {
      // Fall through to UTC — better a slightly-off clock than a failed response.
    }
  }
  if (typeof timeZone !== 'string' || timeZone.length === 0) timeZone = 'UTC';

  const format = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };
  let now;
  try {
    now = new Date().toLocaleString('en-US', { timeZone, ...format });
  } catch {
    // Unknown/invalid IANA id (bad cached value, API drift) — fall back hard.
    timeZone = 'UTC';
    now = new Date().toLocaleString('en-US', { timeZone, ...format });
  }
  return `Current local datetime: ${now}. Device timezone: ${timeZone}.`;
}

// Memory is keyed by personId when Alexa recognizes a voice profile, so each
// household member gets their own history and notes; falls back to userId.
function getMemoryId(handlerInput) {
  const system = handlerInput.requestEnvelope.context?.System ?? {};
  return system.person?.personId ?? system.user?.userId ?? 'anonymous';
}

// Load persistent memory into session attributes once per session. Returns
// the attrs object (already set on the attributes manager).
async function ensureMemoryLoaded(handlerInput) {
  const attrs = handlerInput.attributesManager.getSessionAttributes();
  if (attrs.memoryLoaded) return attrs;
  try {
    const stored = await loadMemory(getMemoryId(handlerInput));
    if (!Array.isArray(attrs.history) || attrs.history.length === 0) {
      attrs.history = stored.history;
    }
    attrs.notes = Array.isArray(attrs.notes) && attrs.notes.length > 0 ? attrs.notes : stored.notes;
    attrs.lastTurnAt = stored.lastTurnAt;
    attrs.memorySource = stored.history.length > 0 || stored.notes.length > 0 ? 'hit' : 'miss';
  } catch (err) {
    console.error('Memory load failed (continuing without):', err);
    attrs.history = Array.isArray(attrs.history) ? attrs.history : [];
    attrs.notes = Array.isArray(attrs.notes) ? attrs.notes : [];
    attrs.memorySource = 'off';
  }
  attrs.memoryLoaded = true;
  handlerInput.attributesManager.setSessionAttributes(attrs);
  return attrs;
}

function getHistory(handlerInput) {
  const attrs = handlerInput.attributesManager.getSessionAttributes();
  return Array.isArray(attrs.history) ? attrs.history : [];
}

function saveHistory(handlerInput, history) {
  const attrs = handlerInput.attributesManager.getSessionAttributes();
  attrs.history = history.slice(-MAX_HISTORY_MESSAGES);
  handlerInput.attributesManager.setSessionAttributes(attrs);
}

function askForRemindersPermissionDirective() {
  return {
    type: 'Connections.SendRequest',
    name: 'AskFor',
    payload: {
      '@type': 'AskForPermissionsConsentRequest',
      '@version': '2',
      permissionScopes: [
        { permissionScope: REMINDERS_PERMISSION, consentLevel: 'ACCOUNT' },
      ],
    },
    token: 'kyle-reminders-consent',
  };
}

// Progressive response: speak a short filler over the Progressive Response
// API while the Claude turn runs, so 2-5s of processing never reads as a
// crash. Best-effort fire-and-forget — failures are irrelevant to the turn.
function sendProgressiveResponse(handlerInput, speech) {
  try {
    const { apiEndpoint, apiAccessToken } = getAlexaContext(handlerInput);
    const requestId = handlerInput.requestEnvelope.request?.requestId;
    if (!apiEndpoint || !apiAccessToken || !requestId) return Promise.resolve();
    return fetch(`${apiEndpoint}/v1/directives`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        header: { requestId },
        directive: { type: 'VoicePlayer.Speak', speech },
      }),
      signal: AbortSignal.timeout(1500),
    }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

async function chatTurn(handlerInput, userText) {
  // Fill the silence immediately, and run the turn-start I/O (memory load,
  // daily-cap check, timezone fetch) concurrently instead of serially.
  const progressive = sendProgressiveResponse(handlerInput, 'One sec.');
  const [attrs, usage, timeContext] = await Promise.all([
    ensureMemoryLoaded(handlerInput),
    bumpDailyCalls(),
    getTimeContext(handlerInput),
  ]);
  const memoryId = getMemoryId(handlerInput);

  // Cost guardrail: past the daily cap Kyle politely declines until tomorrow.
  if (!usage.allowed) {
    return handlerInput.responseBuilder
      .speak("Dude, I've hit my daily limit — catch me tomorrow and we'll pick it right up.")
      .reprompt('Catch me tomorrow.')
      .withShouldEndSession(false)
      .getResponse();
  }

  const history = getHistory(handlerInput);
  history.push({ role: 'user', content: userText });

  const memoryActions = {
    async clearHistory(scope) {
      // Keep only the in-flight exchange so Kyle can confirm naturally.
      attrs.history = [];
      history.length = 0;
      history.push({ role: 'user', content: userText });
      if (scope === 'everything') {
        attrs.notes = [];
        await clearAll(memoryId);
      } else {
        await clearConversation(memoryId);
      }
      handlerInput.attributesManager.setSessionAttributes(attrs);
    },
    async rememberNote(note) {
      if (!note) throw new Error('empty note');
      attrs.notes = [...(attrs.notes ?? []), note];
      handlerInput.attributesManager.setSessionAttributes(attrs);
      await saveConversation(memoryId, getHistory(handlerInput), attrs.notes);
    },
  };

  const { reply, needsPermission, toolsUsed, outcome } = await runKyle(history, {
    alexaContext: getAlexaContext(handlerInput),
    timeContext,
    notes: attrs.notes ?? [],
    memoryActions,
  });

  // Structured-log fields for the LogInterceptor (never any user content).
  const reqAttrs = handlerInput.attributesManager.getRequestAttributes();
  reqAttrs.kyleTools = toolsUsed;
  reqAttrs.kyleOutcome = outcome;
  handlerInput.attributesManager.setRequestAttributes(reqAttrs);

  history.push({ role: 'assistant', content: reply });
  saveHistory(handlerInput, history);
  try {
    // Persist and let the progressive-response call settle together.
    await Promise.all([
      saveConversation(memoryId, getHistory(handlerInput), attrs.notes ?? []),
      progressive,
    ]);
  } catch (err) {
    console.error('Memory save failed (conversation continues):', err);
  }

  const builder = withKyleScreen(
    handlerInput,
    handlerInput.responseBuilder
      .speak(escapeForSsml(reply))
      .reprompt('Anything else?')
      .withShouldEndSession(false),
    reply,
  );

  if (needsPermission === 'reminders') {
    const supportsVoicePermissions =
      handlerInput.requestEnvelope.context?.System?.device?.supportedInterfaces != null;
    if (supportsVoicePermissions) {
      // Voice permissions flow — Alexa asks the user out loud; the answer comes
      // back as a Connections.Response request. Note: this directive ends the
      // current response, so we drop the reprompt.
      return handlerInput.responseBuilder
        .addDirective(askForRemindersPermissionDirective())
        .getResponse();
    }
    // Fallback: send a permissions consent card to the Alexa app.
    builder.withAskForPermissionsConsentCard([REMINDERS_PERMISSION]);
  } else if (needsPermission === 'timers') {
    // Timers have no voice-permission flow — send a consent card to the app.
    builder.withAskForPermissionsConsentCard([TIMERS_PERMISSION]);
  }

  return builder.getResponse();
}

// ---------------------------------------------------------------------------
// Alexa request handlers
// ---------------------------------------------------------------------------

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  async handle(handlerInput) {
    // Auto-resume: under 2 hours since the last turn, pick the thread back up
    // with a cue; otherwise greet fresh (long-term notes stay loaded either
    // way, and history stays available for an explicit "resume" request).
    const attrs = await ensureMemoryLoaded(handlerInput);
    const resumable = isRecent(attrs.lastTurnAt) && getHistory(handlerInput).length > 0;
    const greeting = resumable
      ? "Hey, Kyle here — picking up where we left off. What's next?"
      : "Hey, Kyle here. What's up?";
    return withKyleScreen(
      handlerInput,
      handlerInput.responseBuilder
        .speak(greeting)
        .reprompt('Ask me anything, or say help.')
        .withShouldEndSession(false),
      greeting,
    ).getResponse();
  },
};

const ChatIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'ChatIntent'
    );
  },
  async handle(handlerInput) {
    const query = Alexa.getSlotValue(handlerInput.requestEnvelope, 'query');
    if (!query) {
      return handlerInput.responseBuilder
        .speak("I didn't catch that — what would you like?")
        .reprompt('What would you like?')
        .withShouldEndSession(false)
        .getResponse();
    }
    // Operations voice command — answered locally, never consumes a Claude call.
    if (/^(run |kyle )?diagnostics?( report| check)?$/i.test(query.trim())) {
      return diagnosticsResponse(handlerInput);
    }
    return chatTurn(handlerInput, query);
  },
};

async function diagnosticsResponse(handlerInput) {
  const attrs = await ensureMemoryLoaded(handlerInput);
  const { count, cap } = await getDailyCalls();
  const turns = Math.floor(getHistory(handlerInput).length / 2);
  const notes = (attrs.notes ?? []).length;
  const report =
    `Diagnostics: model claude haiku four five. Memory: ${turns} turn${turns === 1 ? '' : 's'} of history ` +
    `and ${notes} saved note${notes === 1 ? '' : 's'}. Claude calls today: ${count} of ${cap}. All systems go.`;
  return handlerInput.responseBuilder
    .speak(report)
    .reprompt('Anything else?')
    .withShouldEndSession(false)
    .getResponse();
}

const ConnectionsResponseHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'Connections.Response';
  },
  async handle(handlerInput) {
    const status = handlerInput.requestEnvelope.request.payload?.status;
    if (status === 'ACCEPTED') {
      return chatTurn(
        handlerInput,
        'I just granted the reminders permission. Please retry creating the reminder I asked for.',
      );
    }
    const speech =
      status === 'DENIED'
        ? "No problem — I won't set reminders. You can always enable the permission later in the Alexa app. What else can I do?"
        : "Okay, we can sort out reminders later. What else can I do for you?";
    return handlerInput.responseBuilder
      .speak(speech)
      .reprompt('What else can I do?')
      .withShouldEndSession(false)
      .getResponse();
  },
};

// Yes/No must CONTINUE the conversation — Kyle often ends a reply with a
// follow-up hook, and a bare "yes"/"no" routes to these built-ins instead of
// ChatIntent. Feed them to Claude as ordinary turns; never end the session.
const YesNoIntentHandler = {
  canHandle(handlerInput) {
    if (Alexa.getRequestType(handlerInput.requestEnvelope) !== 'IntentRequest') return false;
    const intent = Alexa.getIntentName(handlerInput.requestEnvelope);
    return intent === 'AMAZON.YesIntent' || intent === 'AMAZON.NoIntent';
  },
  async handle(handlerInput) {
    const isYes = Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.YesIntent';
    return chatTurn(handlerInput, isYes ? 'yes' : 'no');
  },
};

const RepeatIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.RepeatIntent'
    );
  },
  handle(handlerInput) {
    const history = getHistory(handlerInput);
    const lastReply = [...history].reverse().find((m) => m.role === 'assistant')?.content;
    const speech = typeof lastReply === 'string' && lastReply
      ? lastReply
      : "I haven't said anything yet — ask me something.";
    return withKyleScreen(
      handlerInput,
      handlerInput.responseBuilder
        .speak(escapeForSsml(speech))
        .reprompt('Anything else?')
        .withShouldEndSession(false),
      speech,
    ).getResponse();
  },
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent'
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(
        "I'm Kyle. Ask me anything, have me look things up on the web, set reminders, or start timers. What'll it be?",
      )
      .reprompt("What'll it be?")
      .withShouldEndSession(false)
      .getResponse();
  },
};

const StopCancelIntentHandler = {
  canHandle(handlerInput) {
    if (Alexa.getRequestType(handlerInput.requestEnvelope) !== 'IntentRequest') return false;
    const intent = Alexa.getIntentName(handlerInput.requestEnvelope);
    return intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak('Catch you later.')
      .withShouldEndSession(true)
      .getResponse();
  },
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return (
      Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent'
    );
  },
  handle(handlerInput) {
    // Graceful recovery: never feels like a failure. Coach the carrier-phrase
    // trick exactly ONCE per session; after that, short varied nudges. Marked
    // distinctly in the structured log so routing improvements are measurable.
    const attrs = handlerInput.attributesManager.getSessionAttributes();
    const reqAttrs = handlerInput.attributesManager.getRequestAttributes();
    reqAttrs.kyleOutcome = 'fallback';
    handlerInput.attributesManager.setRequestAttributes(reqAttrs);

    const nudges = [
      "Didn't quite catch that — hit me again?",
      'That one slipped by me — one more time?',
      'My bad, say that once more?',
    ];
    let speech;
    if (!attrs.fallbackCoached) {
      attrs.fallbackCoached = true;
      speech = "Hmm, missed that one. Pro tip: starting with ask, tell me, or question always gets through — like, ask what's the weather.";
    } else {
      const n = attrs.fallbackCount = (attrs.fallbackCount ?? 0) + 1;
      speech = nudges[n % nudges.length];
    }
    handlerInput.attributesManager.setSessionAttributes(attrs);

    return handlerInput.responseBuilder
      .speak(speech)
      .reprompt("What'll it be?")
      .withShouldEndSession(false)
      .getResponse();
  },
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    const req = handlerInput.requestEnvelope.request;
    console.log(`Session ended: ${req.reason}`);
    if (req.reason === 'ERROR' && req.error) {
      // Alexa-side rejection (bad response/APL/etc). This is the only place
      // the platform tells us WHY — log it verbatim.
      console.error('Session ended by Alexa with error:', JSON.stringify(req.error));
    }
    return handlerInput.responseBuilder.getResponse();
  },
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error('Kyle error:', error);
    return handlerInput.responseBuilder
      .speak('Something went sideways on my end. Give it another shot.')
      .reprompt('Try me again.')
      .withShouldEndSession(false)
      .getResponse();
  },
};

// Defensive final safeguard: on real devices, a response missing a reprompt
// often closes the session even with shouldEndSession false — both are
// required. Force them on EVERY outgoing response except:
//   - Stop/Cancel (the only intents allowed to end the session)
//   - SessionEndedRequest (no speakable response permitted)
//   - responses carrying Connections.SendRequest (Alexa's voice-permission
//     flow owns the session and resumes it via Connections.Response)
const KeepSessionOpenInterceptor = {
  process(handlerInput, response) {
    if (!response) return;
    const req = handlerInput.requestEnvelope.request;
    const isStopOrCancel =
      req.type === 'IntentRequest' &&
      (req.intent?.name === 'AMAZON.StopIntent' || req.intent?.name === 'AMAZON.CancelIntent');
    const isSessionEnded = req.type === 'SessionEndedRequest';
    const handsOffToConnections = (response.directives ?? []).some(
      (d) => d.type === 'Connections.SendRequest',
    );
    if (isStopOrCancel || isSessionEnded || handsOffToConnections) return;

    response.shouldEndSession = false;
    if (!response.reprompt?.outputSpeech) {
      response.reprompt = {
        outputSpeech: { type: 'SSML', ssml: '<speak>Anything else?</speak>' },
      };
    }
  },
};

// One structured line per request so future glitches self-identify. Fields
// only — never user content (utterances/replies stay out of logs by design).
const RequestClockInterceptor = {
  process(handlerInput) {
    const reqAttrs = handlerInput.attributesManager.getRequestAttributes();
    reqAttrs.kyleT0 = Date.now();
    handlerInput.attributesManager.setRequestAttributes(reqAttrs);
  },
};

const StructuredLogInterceptor = {
  process(handlerInput, response) {
    try {
      const req = handlerInput.requestEnvelope.request;
      const reqAttrs = handlerInput.attributesManager.getRequestAttributes();
      const attrs = handlerInput.attributesManager.getSessionAttributes?.() ?? {};
      const line = {
        kyle: 1,
        type: req?.type ?? 'unknown',
        intent: req?.type === 'IntentRequest' ? req.intent?.name : undefined,
        ms: reqAttrs.kyleT0 ? Date.now() - reqAttrs.kyleT0 : undefined,
        tools: reqAttrs.kyleTools?.length ? reqAttrs.kyleTools : undefined,
        apl: (response?.directives ?? []).some((d) => String(d.type).startsWith('Alexa.Presentation.APL')),
        memory: attrs.memorySource ?? 'n/a',
        outcome: reqAttrs.kyleOutcome ?? 'ok',
        endSession: response?.shouldEndSession === true,
      };
      console.log(JSON.stringify(line));
    } catch {
      // Logging must never affect the response.
    }
  },
};

const skill = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    ChatIntentHandler,
    ConnectionsResponseHandler,
    YesNoIntentHandler,
    RepeatIntentHandler,
    HelpIntentHandler,
    StopCancelIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler,
  )
  .addErrorHandlers(ErrorHandler)
  .addRequestInterceptors(RequestClockInterceptor)
  .addResponseInterceptors(KeepSessionOpenInterceptor, StructuredLogInterceptor)
  .withCustomUserAgent('kyle-alexa-assistant/1.0')
  .create();

// ---------------------------------------------------------------------------
// Web path (Lambda Function URL)
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function webResponse(statusCode, bodyObject) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    body: JSON.stringify(bodyObject),
  };
}

async function handleWebRequest(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod;
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (method !== 'POST') {
    return webResponse(405, { error: 'Use POST with a JSON body: { "messages": [...] }' });
  }

  let payload;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    payload = JSON.parse(raw || '{}');
  } catch {
    return webResponse(400, { error: 'Invalid JSON body.' });
  }

  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages || messages.length === 0) {
    return webResponse(400, { error: 'Body must be { "messages": [{ "role": "user", "content": "..." }] }' });
  }

  const history = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY_MESSAGES);

  const now = new Date().toUTCString();
  try {
    const { reply } = await runKyle(history, {
      alexaContext: null,
      timeContext: `Current datetime (UTC): ${now}.`,
      isWeb: true,
    });
    return webResponse(200, { reply });
  } catch (err) {
    console.error('Web chat error:', err);
    return webResponse(500, { error: 'Kyle hit an internal error. Try again.' });
  }
}

// ---------------------------------------------------------------------------
// Entry point — routes Alexa envelopes to the skill, everything else to the web path
// ---------------------------------------------------------------------------

// Spoken fallback if anything escapes the skill's own error handling — an
// unexpected crash must never audibly kill the conversation.
const HICCUP_RESPONSE = {
  version: '1.0',
  response: {
    outputSpeech: { type: 'SSML', ssml: '<speak>I hiccuped — say that again?</speak>' },
    reprompt: { outputSpeech: { type: 'SSML', ssml: '<speak>Say that again?</speak>' } },
    shouldEndSession: false,
  },
};

export const handler = async (event, context) => {
  try {
    // EventBridge warming ping (optional; see README ops section) — return
    // immediately so warm invocations cost ~1ms.
    if (event?.warm === true) {
      return { statusCode: 200, body: 'warm' };
    }
    const isAlexaRequest = Boolean(event && event.request && event.version && event.context);
    if (isAlexaRequest) {
      return await skill.invoke(event, context);
    }
    return await handleWebRequest(event);
  } catch (err) {
    console.error('Kyle top-level crash (returning hiccup fallback):', err);
    if (event?.request) return HICCUP_RESPONSE;
    return webResponse(500, { error: 'Kyle hit an internal error. Try again.' });
  }
};
