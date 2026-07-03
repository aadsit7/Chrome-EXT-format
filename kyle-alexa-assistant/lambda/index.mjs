import Alexa from 'ask-sdk-core';
import { runKyle } from './claude.mjs';

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

// Two stacked frames; the open-mouth frame's opacity is toggled every 150ms
// by an onMount animation loop, giving a talk cycle while Kyle speaks.
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
        items: [
          {
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
        ],
      },
    ],
  },
};

function supportsApl(handlerInput) {
  const interfaces = Alexa.getSupportedInterfaces(handlerInput.requestEnvelope);
  return Boolean(interfaces['Alexa.Presentation.APL']);
}

// Attach the Kyle avatar screen on display devices, with the spoken reply as
// a readable caption under the character; a no-op on speakers so voice-only
// behavior is completely unchanged.
function withKyleScreen(handlerInput, builder, caption = '') {
  if (supportsApl(handlerInput)) {
    builder.addDirective({
      type: 'Alexa.Presentation.APL.RenderDocument',
      token: 'kyleAvatar',
      document: KYLE_APL_DOCUMENT,
      datasources: {
        kyle: {
          openUrl: `${ASSETS_BASE}/kyle_talk_open_512.png`,
          closedUrl: `${ASSETS_BASE}/kyle_talk_closed_512.png`,
          caption,
        },
      },
    });
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
        timeZone = await res.json(); // returns a bare JSON string like "America/Chicago"
        attrs.timeZone = timeZone;
        handlerInput.attributesManager.setSessionAttributes(attrs);
      }
    } catch {
      // Fall through to UTC — better a slightly-off clock than a failed response.
    }
  }
  timeZone = timeZone || 'UTC';

  const now = new Date().toLocaleString('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `Current local datetime: ${now}. Device timezone: ${timeZone}.`;
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

async function chatTurn(handlerInput, userText) {
  const history = getHistory(handlerInput);
  history.push({ role: 'user', content: userText });

  const timeContext = await getTimeContext(handlerInput);
  const { reply, needsPermission } = await runKyle(history, {
    alexaContext: getAlexaContext(handlerInput),
    timeContext,
  });

  history.push({ role: 'assistant', content: reply });
  saveHistory(handlerInput, history);

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
  handle(handlerInput) {
    const greeting = "Hey, Kyle here. What's up?";
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
    return chatTurn(handlerInput, query);
  },
};

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
    return handlerInput.responseBuilder
      .speak('Say ask, tell me, or question before your request.')
      .reprompt('Say ask, tell me, or question before your request.')
      .withShouldEndSession(false)
      .getResponse();
  },
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    const reason = handlerInput.requestEnvelope.request.reason;
    console.log(`Session ended: ${reason}`);
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
  .addResponseInterceptors(KeepSessionOpenInterceptor)
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

export const handler = async (event, context) => {
  const isAlexaRequest = Boolean(event && event.request && event.version && event.context);
  if (isAlexaRequest) {
    return skill.invoke(event, context);
  }
  return handleWebRequest(event);
};
