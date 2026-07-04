# Kyle — Alexa Voice Assistant Powered by Claude

Kyle is a custom Alexa skill backed by the Claude API (`claude-haiku-4-5`), with a companion single-file web chat page. Claude decides — via tool use — when to search the web, create an Alexa reminder, set an Alexa timer, or manage his own memory. Conversation history lives in Alexa session attributes during a session and (optionally) in a small DynamoDB table between sessions.

## What Kyle Can Do

- **Converse naturally, multi-turn** — early-2000s persona, truth and accuracy first, mic stays open every turn
- **Search the web** for current info (news, weather, scores, prices)
- **Reminders** — create, list, and cancel, with the voice-permission flow when the grant is missing
- **Timers** — create, list, pause, resume, cancel (one or all)
- **Remember between sessions** — auto-resumes conversations under 2 hours old ("picking up where we left off"), keeps long-term notes (preferences, durable facts), separate memory per household member via Alexa voice profiles
- **Voice control over memory** — "continue where we left off" / "what were we talking about" (recap), "start fresh" / "clear the slate" (wipe conversation, notes survive), "forget everything about me" (wipes notes too, after a spoken confirmation) — all understood in natural phrasing, not rigid commands
- **Echo Show** — animated talking Kyle with the spoken reply captioned underneath; plain speakers unaffected
- **Diagnostics** — say "diagnostics" for model, memory status, and Claude calls used today
- **Cost guardrail** — politely declines past a daily Claude-call cap (`DAILY_CALL_CAP`, default 300)

Kyle CANNOT (sandboxed skill limits): set native alarms (does a timer/reminder instead), control smart home devices, play Amazon Music, access shopping lists, or invoke other skills — and his prompt makes him say so gracefully while doing the nearest thing he can.

**Memory degrades gracefully:** without the DynamoDB table (or before you create it), Kyle works exactly like the session-only build — cross-session memory and the call cap simply stay off.

## Project layout

```
kyle-alexa-assistant/
  lambda/               Lambda source (Node.js 22.x, ES modules)
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

- **Node.js 22+**
- An **Amazon Developer account** (developer.amazon.com)
- An **AWS account**
- **ASK CLI** installed and configured: `npm i -g ask-cli && ask configure`
- **AWS CLI** installed and configured: `aws configure`
- An **Anthropic API key** (console.anthropic.com)

## ONE-TIME MANUAL AWS STEPS (complete list)

Every manual step you must perform yourself, in order. Steps 1–5 are required for basic operation; 6–8 enable memory, the cost cap, and error alerts.

1. **Create the Lambda** — name `kyle-alexa-assistant`, runtime Node.js 22.x, handler `index.handler`, timeout 10 s, memory 256 MB+.
2. **Environment variables on the Lambda:**
   - `ANTHROPIC_API_KEY` = your key *(required)*
   - `MEMORY_TABLE` = `kyle-memory` *(optional — defaults to this; only set to override)*
   - `DAILY_CALL_CAP` = `300` *(optional — defaults to 300)*
   - `DISABLE_APL` = unset *(set to `true` only to kill all display output while debugging)*
3. **Alexa Skills Kit trigger** on the Lambda, with your Skill ID (printed by `ask deploy`), skill-ID verification enabled.
4. **Function URL** (auth type NONE) for the web chat page.
5. **Upload the code** — `./scripts/deploy.sh` (or zip + upload).
6. **DynamoDB table for memory + call cap** *(skip = Kyle runs session-only)*:
   ```bash
   aws dynamodb create-table \
     --table-name kyle-memory \
     --attribute-definitions AttributeName=pk,AttributeType=S \
     --key-schema AttributeName=pk,KeyType=HASH \
     --billing-mode PAY_PER_REQUEST
   ```
7. **IAM permission** — attach this inline policy to the Lambda's execution role (Console → Lambda → Configuration → Permissions → execution role → Add inline policy → JSON), replacing `ACCOUNT_ID`:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
       "Resource": "arn:aws:dynamodb:us-east-1:ACCOUNT_ID:table/kyle-memory"
     }]
   }
   ```
8. **CloudWatch error alarm → SNS email** (>3 Lambda errors in 5 minutes):
   ```bash
   # a) SNS topic + your email subscription (confirm the email Amazon sends you!)
   aws sns create-topic --name kyle-alerts
   aws sns subscribe \
     --topic-arn arn:aws:sns:us-east-1:ACCOUNT_ID:kyle-alerts \
     --protocol email --notification-endpoint aadsit7@gmail.com

   # b) the alarm
   aws cloudwatch put-metric-alarm \
     --alarm-name kyle-lambda-errors \
     --namespace AWS/Lambda --metric-name Errors \
     --dimensions Name=FunctionName,Value=kyle-alexa-assistant \
     --statistic Sum --period 300 --evaluation-periods 1 \
     --threshold 3 --comparison-operator GreaterThanThreshold \
     --treat-missing-data notBreaching \
     --alarm-actions arn:aws:sns:us-east-1:ACCOUNT_ID:kyle-alerts
   ```
9. **Alexa app permission grant** — see "GRANT PERMISSIONS" below (Reminders toggle; without it reminder creation 403s).
10. *(Optional, for per-person memory)* each household member sets up an **Alexa voice profile** (Alexa app → Settings → Your Profile → Voice ID); without profiles all household members share the account-level memory.

## 2. One-time Lambda setup

1. Create a Lambda function named `kyle-alexa-assistant`:
   - Runtime: **Node.js 22.x**, architecture: arm64 or x86_64
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

The **Lambda ARN** is already set in `skill-package/skill.json` at `apis.custom.endpoint.uri` (`arn:aws:lambda:us-east-1:611491981154:function:kyle-alexa-assistant`) — update it there if you redeploy the function under a different name or region. `ask deploy` creates the skill and prints the Skill ID — use it for the Lambda trigger in step 2.3.

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

1. The **Function URL** is already set in the `FUNCTION_URL` constant at the top of the `<script>` in `web/index.html` — change it there if your Function URL ever rotates.
2. Open the file in a browser (or host it anywhere static). Chat history is kept client-side in a JS array.
3. On the web path Kyle knows he's not on an Echo — he'll tell you reminders/timers only work on the device.

## 7. Changing Kyle's personality

Edit `lambda/system-prompt.md` — persona, tone, tool judgment, and limits all live there — then redeploy:

```bash
./scripts/deploy.sh
```

## Privacy & Amazon policy compliance

How the solution maps to Amazon's skill policies — **review the [Alexa Skills Certification requirements](https://developer.amazon.com/en-US/docs/alexa/custom-skills/certification-requirements-for-custom-skills.html) and [Alexa privacy requirements](https://developer.amazon.com/en-US/docs/alexa/custom-skills/policy-requirements-for-an-alexa-skill.html) carefully before any public distribution.**

**1. No personal data stored or shared outside Amazon's ecosystem.**
- Storage stays inside **your own AWS account**: session history lives in Alexa session attributes, and cross-session memory (history + notes) lives in your own DynamoDB table — no third-party storage. Users can wipe their conversation ("start fresh") or all stored data about them ("forget everything about me", spoken confirmation required) by voice at any time.
- No Alexa identifiers ever leave Amazon: the `apiAccessToken`, `deviceId`, and `userId` are used exclusively to call Amazon's own REST APIs and are **never included** in requests to the Anthropic API (enforced in `claude.mjs` — see the privacy-boundary note on `runKyle`).
- No user content is written to CloudWatch logs — handlers log only error objects and session-end reasons, never utterances or history.
- **Disclosure required:** utterance *text* is transiently processed by the Anthropic API to generate replies (that is the skill's core function). Anthropic's API does not train on API data by default, but this is a third-party data processor — it must be disclosed in your privacy policy before certification, and users of a public skill must be able to find that disclosure.
- Kyle's system prompt instructs him not to solicit personal details and to actively deflect sensitive information (passwords, SSNs, payment, health/financial data).

**2. Official Reminder API only.**
Reminders use Amazon's official Alexa Reminders API (`POST/GET/DELETE {apiEndpoint}/v1/alerts/reminders`) with the Alexa-issued bearer token, gated behind the user-granted `alexa::alerts:reminders:skill:readwrite` permission and the voice-consent flow. Timers likewise use the official Alexa Timers API. No unofficial endpoints, no scraping, no workarounds.

**3. Third-party connection policy.**
The only third-party connection is the Anthropic API: HTTPS-only, authenticated with an API key held in a Lambda environment variable (never in the repo — `.env` is gitignored), with Alexa tokens never forwarded. The companion web page is a separate, non-Alexa surface and does not touch any Alexa API.

**Certification checklist before going public:**
- [ ] Set a real `privacyPolicyUrl` and `termsOfUseUrl` in `skill.json` — **mandatory** for skills that request permissions (reminders/timers)
- [ ] Disclose Anthropic as a data processor in that privacy policy
- [ ] Replace the one-word invocation name (`kyle` → e.g. `hey kyle`)
- [ ] Provide real 108px/512px skill icons
- [ ] Secure the web Function URL (auth) or exclude the web surface from the public offering
- [ ] Re-review the certification requirements linked above — they change over time

## Outstanding components (not blockers, but know about them)

- **Deploy-time TODO you must fill in:** `ANTHROPIC_API_KEY` on the Lambda. The Lambda ARN (`skill-package/skill.json`) and Function URL (`web/index.html`) are already configured.
- **Replace the placeholder art in `assets/`:** the skill icons and Kyle talk frames are generated placeholders served from this repo's raw GitHub URLs (this repo is public, so Amazon and browsers can fetch them). Overwrite `assets/*.png` with your real images — same filenames — and re-run `ask deploy` so Amazon re-fetches the icons. See `assets/README.md` for the file mapping.
- **Talking animation:** the web page swaps Kyle's open/closed mouth frames every 150 ms while a reply is in flight and while it's "speaking" on screen (falls back to a CSS mouth-cover if the closed frame is missing). Echo Show devices get an APL screen with the same frame-swap loop; regular speakers are untouched. The APL interface is declared in the manifest, so the next `ask deploy` picks it up.
- **Live-key verification:** the test suite has only been run with the Claude API mocked in this environment. Run `npm run test:local` with a real key in `lambda/.env` before first deploy.
- **Function URL is unauthenticated:** anyone with the URL can chat with Kyle on your API bill. Fine for personal use; add an auth header check or IAM auth before sharing the URL.
- **Not certifiable as-is:** the one-word invocation name and dev-mode manifest are for personal devices. Public certification would need a compliant invocation name, icons, and privacy policy URLs.
- **Reminder recurrence uses the legacy `freq` format** (`DAILY`/`WEEKLY`), which Alexa still accepts but has superseded with RRULE-based `recurrenceRules`. Upgrade if recurring reminders become important.
- **Timers voice-permission flow:** reminders use Alexa's voice-consent flow; timers fall back to a consent card in the Alexa app (Alexa has no voice flow for timers).

## Architecture notes

- **Memory.** During a session, conversation history rides in Alexa session attributes (capped at the last 10 turns). Between sessions, history + long-term notes persist to the `kyle-memory` DynamoDB table (inside your own AWS account), keyed per person (`personId` from Alexa voice profiles, falling back to `userId`). Auto-resume kicks in when the last turn is under 2 hours old. Without the table, Kyle silently degrades to session-only. The web page keeps its own history client-side and sends it with each request.
- **Observability.** Every request emits one structured JSON log line — `{kyle:1, type, intent, ms, tools, apl, memory, outcome, endSession}` — with no user content, so glitches self-identify in CloudWatch (`filter @message like /"kyle":1/`). `SessionEndedRequest` with reason `ERROR` now logs Alexa's full error object — the only place the platform explains a response rejection.
- **Optional cold-start warmer.** Cold starts measured ~400ms (usually not worth fixing). If first-question-after-idle ever becomes the glitch pattern, add an EventBridge ping every 5 minutes (the handler answers `{"warm": true}` events in ~1ms):
  ```bash
  aws events put-rule --name kyle-warm --schedule-expression 'rate(5 minutes)'
  aws lambda add-permission --function-name kyle-alexa-assistant --statement-id kyle-warm \
    --action lambda:InvokeFunction --principal events.amazonaws.com \
    --source-arn arn:aws:events:us-east-1:ACCOUNT_ID:rule/kyle-warm
  aws events put-targets --rule kyle-warm --targets \
    'Id=kyle-warm,Arn=arn:aws:lambda:us-east-1:ACCOUNT_ID:function:kyle-alexa-assistant,Input="{\"warm\": true}"'
  ```
- **Never-die errors.** A top-level try/catch around the whole handler returns a spoken "I hiccuped — say that again?" with the session open if anything escapes the skill's own error handler; the full error is logged to CloudWatch (pair with the error alarm in the one-time steps).
- **Latency budget.** The Lambda timeout is 10 seconds, but the binding constraint is Alexa's ~8-second voice-layer window — a reply that arrives later completes cleanly in CloudWatch while the device silently drops the session. The Claude loop therefore enforces a hard 7-second budget across all tool iterations (max 3), with 3-second timeouts on each Alexa REST call; on breach Kyle says "Still digging — ask me that again." and the session stays open. A progressive response ("One sec.") fires at the start of every chat turn so processing never sounds like a crash. Do NOT raise the Lambda timeout to 15s — replies after ~8s are dead on arrival at the voice layer; a longer timeout only spends money.
- **The mic stays open.** Every response sets `shouldEndSession: false` with a reprompt; only Stop/Cancel end the session. Bare "yes"/"no" answers route to AMAZON.YesIntent/NoIntent and are fed to Claude as ordinary conversation turns, and AMAZON.RepeatIntent re-speaks Kyle's last reply.
- **Permissions flow.** If Claude tries to create a reminder without the grant, the handler responds with the `AskFor` voice-permissions directive (`Connections.SendRequest`) — Alexa asks the user out loud, and the answer comes back as a `Connections.Response` request that Kyle handles gracefully. Devices without voice-permission support get a consent card in the Alexa app instead.
- **Dual path.** The same Lambda serves Alexa envelopes and plain JSON POSTs (`{ messages: [...] }` → `{ reply: "..." }`) from the Function URL, with CORS handled.
