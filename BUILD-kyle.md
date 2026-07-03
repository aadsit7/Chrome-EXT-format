# Build Instructions v2: "Kyle" — Alexa Voice Assistant Powered by Claude

Commit this file to the repo root as BUILD-kyle.md and tell Claude Code: "Read BUILD-kyle.md and execute it end to end." (Or paste everything below directly into Claude Code.)

---

## Project Goal

Build a complete, deployable Amazon Alexa custom skill named **Kyle**, backed by the Claude API, with a companion web chat page. Kyle can: hold natural conversations, search the web, **create Alexa reminders**, and **set Alexa timers** — all decided by Claude via tool use. No database — conversation history lives in Alexa session attributes only.

## CRITICAL: Repository Scope

This repository contains multiple unrelated projects (Chrome extensions) in their own folders.

- Build EVERYTHING inside a new folder at the repo root: `kyle-alexa-assistant/`
- Do NOT modify, move, reorganize, or delete any file outside `kyle-alexa-assistant/`
- Do NOT edit the repo root `.gitignore`; create a `.gitignore` inside `kyle-alexa-assistant/` instead
- All paths below are relative to `kyle-alexa-assistant/`

## Honest Scope (document this in the README)

Custom Alexa skills run sandboxed. Kyle CAN: converse, web-search, create/list/delete reminders it created, and create/pause/cancel timers. Kyle CANNOT: set native alarms, control smart home devices, play Amazon Music, access shopping lists (Lists API is deprecated), or invoke other skills. The README must include this capability table so expectations are clear, and Kyle's system prompt must make him gracefully explain these limits when asked (e.g., "I can't set alarms, but I can set a timer for that instead — want me to?").

## Folder Structure

```
kyle-alexa-assistant/
  lambda/
    index.mjs              — Lambda handler (Node.js 20.x, ES modules)
    claude.mjs             — Claude API client with agentic tool loop
    alexa-tools.mjs        — Executors for Alexa Reminders + Timers REST APIs
    system-prompt.md       — Kyle's persona + instructions (editable text file)
    package.json
  skill-package/
    skill.json             — Alexa skill manifest (with reminders + timers permissions)
    interactionModels/custom/en-US.json — Interaction model
  web/
    index.html             — Single-file chat page (HTML + CSS + JS inline)
  scripts/
    deploy.sh              — Deploy script using ASK CLI + AWS CLI
    test-local.mjs         — Local test harness with mocked Alexa request JSON
  README.md
  .gitignore
```

## Functional Requirements

### 1. Lambda handler (lambda/index.mjs)
- Use `ask-sdk-core`. Handle: `LaunchRequest`, `IntentRequest` (ChatIntent + AMAZON.StopIntent, AMAZON.CancelIntent, AMAZON.HelpIntent, AMAZON.FallbackIntent), `SessionEndedRequest`, and the `Connections.Response` request type (returned after Alexa's voice-permission flow for reminders).
- On `LaunchRequest`: Kyle greets briefly in character and keeps the session open.
- On `ChatIntent`: extract the `query` slot utterance, append to history, run the Claude agentic loop (below), speak the final reply, keep the session open.
- Conversation history in **Alexa session attributes** as `[{role, content}]`, capped at the last 10 turns. No DynamoDB, no external storage.
- Pass `handlerInput` context (apiEndpoint, apiAccessToken, permissions) through to the tool executors.
- Reminders permission handling: if Claude tries to create a reminder and the user hasn't granted the reminders permission, respond with the `AskFor` Connections.SendRequest directive (voice permissions flow) or, as fallback, a permissions card for the Alexa app — then tell the user what to do. Handle the `Connections.Response` to resume gracefully.
- DUAL PATH: the same Lambda also accepts a plain HTTPS JSON POST from the web page via a Function URL (detect: no Alexa request envelope). Body `{ messages: [...] }` → `{ reply: "..." }`, CORS `Access-Control-Allow-Origin: *`, OPTIONS preflight handled. On the web path, the Alexa tools are unavailable — pass Claude a flag so Kyle says reminders/timers only work on the Echo.

### 2. Claude integration with agentic tool loop (lambda/claude.mjs)
- Use `@anthropic-ai/sdk` against `https://api.anthropic.com/v1/messages`.
- Model `claude-haiku-4-5`, `max_tokens: 400`.
- System prompt loaded from `system-prompt.md` at cold start.
- Tools passed on every call:
  1. Server tool: `{ "type": "web_search_20250305", "name": "web_search" }`
  2. Custom tool `create_reminder` — input schema: `{ text: string, when: string (ISO 8601 local datetime, no timezone suffix), recurrence?: string }`
  3. Custom tool `set_timer` — input schema: `{ duration_minutes: number, label: string }`
- Implement the standard agentic loop: call Claude → if `stop_reason` is `tool_use`, execute the tool via alexa-tools.mjs → append a `tool_result` block → call Claude again → repeat until a text-only response. Cap at 3 loop iterations.
- Strip markdown from the final text before returning (spoken output).
- Timeout budget: overall hard cap of 6.5 seconds across the whole loop; on breach, return a spoken fallback like "That's taking me a moment — ask me again."

### 3. Alexa tool executors (lambda/alexa-tools.mjs)
- `create_reminder`: POST to `{apiEndpoint}/v1/alerts/reminders` with `Authorization: Bearer {apiAccessToken}`. Body uses `requestTime`, a `SCHEDULED_ABSOLUTE` trigger with `scheduledTime`, and `alertInfo.spokenInfo.content` with the reminder text. If the API returns 401/403 (permission not granted), return a structured error so the handler triggers the permissions flow instead of failing.
- `set_timer`: POST to `{apiEndpoint}/v1/alerts/timers` with the same auth header. Body: ISO 8601 `duration` (e.g., PT10M), `timerLabel`, `creationBehavior.displayExperience.visibility: "VISIBLE"`, and `triggeringBehavior` with `operation.type: "ANNOUNCE"` and `notificationConfig.playAudible: true`, announcing the label.
- Both executors: 3-second per-call fetch timeout, informative error strings returned as tool_result content so Claude can explain failures conversationally.

### 4. Kyle's system prompt (lambda/system-prompt.md)
Write a starter prompt establishing:
- Name and persona: Kyle — friendly, capable, lightly witty, never long-winded.
- Voice-first style: 1–3 spoken sentences, no formatting, no lists, no URLs.
- Tool judgment: use web_search for current-info questions; use create_reminder when the user asks to be reminded of something at a time; use set_timer for countdowns ("set a timer for 10 minutes"). Confirm actions naturally after tools succeed ("Done — I'll remind you at 5.").
- Capability honesty: if asked for alarms, music, smart home, or shopping lists, explain briefly that those aren't available to him and offer the nearest alternative (timer instead of alarm).
- Time handling: the current date/time and device timezone will be injected by the Lambda at the top of each conversation turn — rely on it when computing reminder times.
  (Lambda requirement: fetch the device timezone once per session via the Alexa Settings API `/v2/devices/{deviceId}/settings/System.timeZone` and inject current local datetime into the system prompt or first user message.)

### 5. Interaction model (skill-package/interactionModels/custom/en-US.json)
- Invocation name: `"kyle"`. NOTE in README: one-word invocation names are not certifiable for public skills but work in development mode on the developer's own devices; include a commented alternative `"hey kyle"` to switch to if the device won't open it.
- `ChatIntent` with slot `query` of type `AMAZON.SearchQuery` and broad sample utterances.
- Built-ins: AMAZON.StopIntent, AMAZON.CancelIntent, AMAZON.HelpIntent, AMAZON.FallbackIntent.

### 6. Skill manifest (skill-package/skill.json)
- Custom skill, en-US, name "Kyle".
- Declare permissions: `alexa::alerts:reminders:skill:readwrite` and `alexa::alerts:timers:skill:readwrite`.
- `apis.custom.endpoint` Lambda ARN placeholder marked TODO.

### 7. Web chat page (web/index.html)
- Single self-contained file, minimal chat UI, no frameworks. POSTs `{ messages: [...] }` to the Function URL constant (TODO placeholder at top). Client-side history in a JS array. Show "Kyle" as the assistant name in the UI.

### 8. Local testing (scripts/test-local.mjs)
- Invokes the handler with mocked Alexa `IntentRequest` fixtures, including one that triggers a reminder tool call with a mocked Alexa API (stub fetch for api.amazonalexa.com so no real reminder is created locally). Reads `ANTHROPIC_API_KEY` from `.env` via `dotenv` (dev dependency).
- npm scripts: `test:local`, `build` (zip lambda contents).

### 9. Deploy script (scripts/deploy.sh)
- Location-independent (resolves its own directory, cds to `kyle-alexa-assistant/`). Steps: build zip → `aws lambda update-function-code` → `ask deploy`. `set -euo pipefail`, clear echoes.

### 10. README.md
Cover, in order:
1. The capability table (CAN vs CANNOT, from Honest Scope above).
2. Prerequisites: Node 20+, Amazon Developer account, AWS account, ASK CLI configured, AWS CLI configured.
3. One-time Lambda setup: Node 20.x runtime, `ANTHROPIC_API_KEY` env var, Alexa Skills Kit trigger, Function URL (auth NONE) for the web page.
4. Skill deploy: `cd kyle-alexa-assistant && ask deploy` (must run from inside the folder), paste Lambda ARN.
5. GRANTING PERMISSIONS (critical new step): after enabling the skill, open the Alexa app → More → Skills & Games → Your Skills → Dev → Kyle → Settings → Manage Permissions → toggle Reminders (and Timers if listed) ON. Without this, reminder creation returns 403.
6. Testing sequence: `npm run test:local` → Alexa Developer Console simulator (note: reminders/timers do NOT fire in the simulator; test those on a real Echo) → real device.
7. Changing Kyle's personality: edit `system-prompt.md`, redeploy.

### 11. .gitignore (inside kyle-alexa-assistant/)
- `node_modules/`, `.env`, `*.zip`, `.ask/`

## Constraints
- No database of any kind.
- No secrets in the repo — `.env` local-only; Lambda uses environment variables.
- Spoken path must stay under Alexa's 8-second limit including tool loops.
- Dependencies: `ask-sdk-core`, `@anthropic-ai/sdk`, `dotenv` (dev only). Use native `fetch` for Alexa REST APIs.
- Never touch files outside `kyle-alexa-assistant/`.

## Build Order
1. Scaffold folder structure and package.json.
2. Build `claude.mjs` (agentic loop) + `system-prompt.md`.
3. Build `alexa-tools.mjs`.
4. Build the Lambda handler (Alexa + web POST + permissions flow).
5. Build `test-local.mjs`; confirm both a plain-chat fixture and a reminder-tool fixture pass before continuing.
6. Build interaction model + skill manifest.
7. Build the web page.
8. Deploy script + README.
9. Commit after each major step, messages prefixed `kyle:`.

Start with step 1 now.
