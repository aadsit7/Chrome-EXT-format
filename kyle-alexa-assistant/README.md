# Kyle — Alexa Voice Assistant Powered by Claude

Kyle is a custom Alexa skill backed by the Claude API (`claude-haiku-4-5`), with a companion single-file web chat page. Claude decides — via tool use — when to search the web, create an Alexa reminder, or set an Alexa timer. Conversation history lives entirely in Alexa session attributes; there is no database.

## What Kyle CAN and CANNOT do

Custom Alexa skills run sandboxed, so set expectations accordingly:

| Kyle CAN ✅ | Kyle CANNOT ❌ |
|---|---|
| Hold natural multi-turn conversations | Set native alarms (offers a timer instead) |
| Search the web for current info | Control smart home devices |
| Create reminders (and list/delete ones he created) | Play Amazon Music |
| Create, pause, and cancel timers | Access shopping lists (Lists API is deprecated) |
| Explain his own limits gracefully | Invoke or hand off to other skills |

Kyle's system prompt makes him explain these limits when asked (e.g. *"I can't set alarms, but I can set a timer for that instead — want me to?"*).

## Project layout

```
kyle-alexa-assistant/
  lambda/               Lambda source (Node.js 20.x, ES modules)
    index.mjs           Handler: Alexa skill + web POST dual path
    claude.mjs          Claude API client with agentic tool loop
    alexa-tools.mjs     Reminders + Timers REST executors
    system-prompt.md    Kyle's persona — edit this to change him
  skill-package/        Alexa skill manifest + interaction model
  web/index.html        Self-contained web chat page
  scripts/
    deploy.sh           Build zip → update Lambda → ask deploy
    test-local.mjs      Local test harness with mocked Alexa API
```

## 1. Prerequisites

- **Node.js 20+**
- An **Amazon Developer account** (developer.amazon.com)
- An **AWS account**
- **ASK CLI** installed and configured: `npm i -g ask-cli && ask configure`
- **AWS CLI** installed and configured: `aws configure`
- An **Anthropic API key** (console.anthropic.com)

## 2. One-time Lambda setup

1. Create a Lambda function named `kyle-alexa-assistant`:
   - Runtime: **Node.js 20.x**, architecture: arm64 or x86_64
   - Handler: `index.handler`
   - Timeout: **10 seconds**, memory: 256 MB+
2. Add the environment variable **`ANTHROPIC_API_KEY`** with your key.
3. Add an **Alexa Skills Kit trigger** (paste your Skill ID after step 3 below; enable skill ID verification).
4. Create a **Function URL** (Configuration → Function URL → auth type **NONE**) — this powers the web chat page. Copy the URL.
5. Upload the first build: `cd lambda && npm install --omit=dev && npm run build`, then upload `lambda.zip` (or run `./scripts/deploy.sh` after step 3).

## 3. Deploy the skill

```bash
cd kyle-alexa-assistant     # ask deploy must run from inside this folder
ask deploy
```

Before deploying, paste your **Lambda ARN** into `skill-package/skill.json` at `apis.custom.endpoint.uri` (marked TODO). `ask deploy` creates the skill and prints the Skill ID — use it for the Lambda trigger in step 2.3.

> **Invocation name note:** the model uses the one-word invocation `"kyle"`. One-word invocation names are **not certifiable for public skills**, but they work fine in development mode on your own devices. If your device won't open the skill, change `invocationName` in `skill-package/interactionModels/custom/en-US.json` to `"hey kyle"` and redeploy.

For subsequent deploys, just run:

```bash
./scripts/deploy.sh          # zip → aws lambda update-function-code → ask deploy
```

## 4. GRANT PERMISSIONS (critical!)

Reminders require an explicit user grant. **Without this, reminder creation returns 403** (Kyle will trigger the voice permission flow, but you can grant it up front):

1. Open the **Alexa app** on your phone
2. **More → Skills & Games → Your Skills → Dev → Kyle**
3. **Settings → Manage Permissions**
4. Toggle **Reminders** (and **Timers**, if listed) **ON**

## 5. Testing sequence

1. **Local:** `cd lambda && npm run test:local`
   - Needs `ANTHROPIC_API_KEY` in `lambda/.env` (or exported). The Alexa API is always mocked — no real reminders are created locally.
   - Fully offline run (Claude mocked too): `MOCK_CLAUDE=1 npm run test:local`
2. **Alexa Developer Console simulator** (Test tab): type "open kyle", then chat.
   ⚠️ Reminders and timers do **not** fire in the simulator — test those on a real Echo.
3. **Real Echo device** (same Amazon account): *"Alexa, open kyle"* → *"remind me to stretch at five"*.

## 6. Web chat page

1. Open `web/index.html` and paste your **Function URL** into the `FUNCTION_URL` constant at the top of the `<script>`.
2. Open the file in a browser (or host it anywhere static). Chat history is kept client-side in a JS array.
3. On the web path Kyle knows he's not on an Echo — he'll tell you reminders/timers only work on the device.

## 7. Changing Kyle's personality

Edit `lambda/system-prompt.md` — persona, tone, tool judgment, and limits all live there — then redeploy:

```bash
./scripts/deploy.sh
```

## Architecture notes

- **No database.** Conversation history is stored in Alexa session attributes (capped at the last 10 turns) and vanishes when the session ends. The web page keeps its own history client-side and sends it with each request.
- **Latency budget.** Alexa requires a response within ~8 seconds. The Claude loop enforces a hard 6.5-second budget across all tool iterations (max 3), with 3-second timeouts on each Alexa REST call; on breach Kyle says "That's taking me a moment — ask me again."
- **Permissions flow.** If Claude tries to create a reminder without the grant, the handler responds with the `AskFor` voice-permissions directive (`Connections.SendRequest`) — Alexa asks the user out loud, and the answer comes back as a `Connections.Response` request that Kyle handles gracefully. Devices without voice-permission support get a consent card in the Alexa app instead.
- **Dual path.** The same Lambda serves Alexa envelopes and plain JSON POSTs (`{ messages: [...] }` → `{ reply: "..." }`) from the Function URL, with CORS handled.
