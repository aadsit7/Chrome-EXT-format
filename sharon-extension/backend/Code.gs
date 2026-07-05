/**
 * Speaking_Assistant — Sharon's backend (Google Apps Script web app).
 *
 * Paste this whole file into your Apps Script project (bound to the
 * "Speaking Assistant" Google Sheet or standalone with SPREADSHEET_ID set),
 * set the Script Properties below, and deploy as a Web App
 * ("Execute as: me", "Who has access: Anyone").
 *
 * Script Properties (File > Project Settings > Script Properties):
 *   API_KEY            — shared secret; must match config.js in the extension
 *   ANTHROPIC_API_KEY  — your Anthropic key (never ships in the extension)
 *   MODEL              — optional; defaults to "claude-opus-4-8"
 *   SPREADSHEET_ID     — optional; only needed if the script is NOT bound
 *                        to the Speaking Assistant spreadsheet
 *
 * Request envelope (always POSTed as text/plain to dodge CORS preflight):
 *   { "api_key": "...", "action": "...", "payload": { ... } }
 *
 * Response envelope:
 *   { "ok": true,  "result": ... }
 *   { "ok": false, "error": "human readable message" }
 *
 * Actions:
 *   assist            — the brain. One round trip: Claude decides whether to
 *                       just answer, search the live web (web_search — run by
 *                       Anthropic's servers, billed to your Anthropic key,
 *                       ~1¢ per search), or call tools that read/write the
 *                       Sheet (save_memory, update_memory, search_memory,
 *                       summarize_memory) or act on the page (act_on_page —
 *                       returned to the extension, never executed here).
 *                       Logs both turns and returns
 *                       { reply, plan?, events, sources? }.
 *   ask               — legacy conversational call (no tools). Kept for
 *                       compatibility; logs both turns.
 *   append_turn       — log one row to conversation_turns.
 *   distill_to_memory — write one row to memory_log.
 *   search_memory     — keyword search over memory_log AND the transcripts
 *                       in the recordings tab (recording hits are read-only,
 *                       entry_id "rec:<recording_id>").
 *   update_memory     — patch a memory_log row (status/done/deleted/edits).
 *   save_recording    — save a voice recording: audio to the Drive folder
 *                       "Sharon Recordings", one row to the recordings tab
 *                       (transcript + timestamped "segments" JSON), then
 *                       distill the transcript into memory_log notes that
 *                       each link back to the audio.
 *   get_recording_audio — return one recording's audio as base64 so the
 *                       panel can play it in place. The Drive file's
 *                       sharing settings are never touched — the bytes
 *                       flow through here, so recordings stay private.
 *                       Files past AUDIO_MAX_BYTES return
 *                       { too_large: true, drive_file_url } instead.
 *   summarize_memory  — fetch matching memory rows and have the model
 *                       compose a short spoken summary.
 *   get_recent_turns  — recent conversation_turns for a session (lets the
 *                       panel restore context after a reopen).
 */

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */
var DEFAULT_MODEL = "claude-opus-4-8";
var ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
var ANTHROPIC_VERSION = "2023-06-01";
var MAX_TOOL_ROUNDS = 4;
var REPLY_MAX_TOKENS = 1500; // a little extra room for web-search answers with sources
var HISTORY_FALLBACK_TURNS = 12;
var WEB_SEARCH_MAX_USES = 3; // max live web searches per question (cost guard, ~1¢ each)

var SHEETS = {
  turns: "conversation_turns",
  memory: "memory_log",
  sessions: "sessions",
  recordings: "recordings",
};

// Voice recordings
var RECORDINGS_FOLDER = "Sharon Recordings"; // Drive folder (created if missing)
var RECORDING_HEADERS = [
  "recording_id", "created_at", "duration_seconds", "drive_file_url",
  "transcript", "session_id", "notes_saved", "segments",
];
var TRANSCRIPT_CELL_MAX = 45000; // Sheets caps a cell at 50,000 chars — stay clear
var DISTILL_MAX_TOKENS = 4000; // room for a long recording's worth of notes
var AUDIO_MAX_BYTES = 25 * 1024 * 1024; // bigger files play from Drive instead

function props_() {
  return PropertiesService.getScriptProperties();
}

function ss_() {
  var id = props_().getProperty("SPREADSHEET_ID");
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error("Set the SPREADSHEET_ID script property.");
  return active;
}

function model_() {
  return props_().getProperty("MODEL") || DEFAULT_MODEL;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */
function doPost(e) {
  var out;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var expected = props_().getProperty("API_KEY");
    if (!expected || body.api_key !== expected) {
      out = { ok: false, error: "unauthorized" };
    } else {
      var payload = body.payload || {};
      switch (body.action) {
        case "assist":            out = { ok: true, result: actionAssist_(payload) }; break;
        case "ask":               out = { ok: true, result: actionAsk_(payload) }; break;
        case "append_turn":       out = { ok: true, result: actionAppendTurn_(payload) }; break;
        case "distill_to_memory": out = { ok: true, result: actionDistill_(payload) }; break;
        case "search_memory":     out = { ok: true, result: searchMemory_(payload) }; break;
        case "update_memory":     out = { ok: true, result: updateMemory_(payload) }; break;
        case "save_recording":    out = { ok: true, result: actionSaveRecording_(payload) }; break;
        case "get_recording_audio": out = { ok: true, result: actionGetRecordingAudio_(payload) }; break;
        case "summarize_memory":  out = { ok: true, result: actionSummarize_(payload) }; break;
        case "get_recent_turns":  out = { ok: true, result: recentTurns_(payload) }; break;
        default: out = { ok: false, error: "unknown action: " + body.action };
      }
    }
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/* ------------------------------------------------------------------ *
 * The system prompt (stable — first so prompt caching can key on it)
 * ------------------------------------------------------------------ */
var SYSTEM_CORE =
  "You are Sharon, a warm, fast, hands-free voice assistant that lives in the " +
  "user's browser side panel. The user is LISTENING, not reading, so keep " +
  "spoken replies short, natural, and conversational — a few sentences unless " +
  "they asked you to read something long. Never use markdown, headings, " +
  "bullets, or emoji: plain spoken prose only.\n\n" +
  "What you can see: each user message may include a PAGE CONTEXT block with " +
  "the text currently visible on their active browser tab. Treat it as the " +
  "only thing on their screen. When answering questions about the page, use " +
  "ONLY that content — never invent or pad with outside knowledge, and say " +
  "plainly when the answer isn't on the page. General conversation that is " +
  "not about the page (greetings, questions about your notes, planning) is " +
  "normal conversation — answer helpfully.\n\n" +
  "Your database: you have a persistent memory store (the user's notes, " +
  "tasks, decisions, and preferences) that you read and write through tools:\n" +
  "- save_memory: when the user asks you to remember, note, or track " +
  "something, save it with a clean short title and content that faithfully " +
  "reflects the user's own words (see the HARD SAVE RULES below). Choose " +
  "entry_type task for to-dos/reminders, note otherwise.\n" +
  "- search_memory: when they ask what they saved, or a question your memory " +
  "might answer, search first, then answer from the results. It also searches " +
  "the transcripts of their saved voice recordings — those come back as " +
  "read-only 'recording' entries with the audio linked, and notes tagged " +
  "'recording' were distilled from one. A recording result may include the " +
  "start time of the moment that matched (like 12:40). When you answer from " +
  "either, mention the recording's date naturally; the panel queues the " +
  "audio right there, ready to play, so you can offer it in passing — " +
  "something like 'I've got that recording ready — it's from the part " +
  "around twelve forty'. Say any time in natural words and never read URLs " +
  "aloud.\n" +
  "- update_memory: when they say a task is done, or want a note changed or " +
  "deleted, find it (search first if you don't have its id) and update it.\n" +
  "- summarize_memory: when they want an overview — 'summarize my notes', " +
  "'what are my open tasks', 'recap what we discussed' — call this and then " +
  "relay the summary conversationally.\n" +
  "Use tools decisively whenever the request maps to one; don't ask " +
  "permission for a simple save or search. After a tool result, always give " +
  "a short spoken confirmation or answer.\n\n" +
  "HARD SAVE RULES — these outrank everything else about saving:\n" +
  "1. Grounding: anything you pass to save_memory must come ONLY from what " +
  "the user actually said in this conversation, or from what they " +
  "explicitly asked you to save. NEVER compose note content from the PAGE " +
  "CONTEXT block, from your own replies, or from your general knowledge. " +
  "The single exception is an explicit request to save something from the " +
  "page ('save this page's address', 'note down what this article says " +
  "about pricing') — only then may page content go into a note. If you " +
  "cannot point to the user's own words behind a save, do NOT save — ask " +
  "what they'd like saved instead.\n" +
  "2. A bare affirmation or negation ('yes', 'yes I do', 'sure', 'okay', " +
  "'please', 'no thanks') is NEVER a save request by itself and is NEVER " +
  "note content. Treat it strictly as the user answering your immediately " +
  "previous reply: do the thing you just offered or asked about — if you " +
  "offered to play a recording back, surface or play that recording — and " +
  "never start a new, unrelated action from it.\n" +
  "3. Safety net: if what you are about to save does not closely reflect " +
  "the user's own words from this conversation, don't save silently — " +
  "confirm aloud first, like 'Want me to save that as a note?'. Silently " +
  "saving the wrong thing is the worst outcome; a one-line check is " +
  "cheap.\n\n" +
  "Live web search: you can search the internet with the web_search tool. " +
  "Use it whenever the answer likely depends on current or recent " +
  "information — news, prices, scores, weather, releases, 'latest', " +
  "anything that may have changed recently, or anything you're not sure is " +
  "still true. Do NOT search for timeless facts, math, or questions about " +
  "the user's page or saved notes.\n\n" +
  "Search methodology — follow this every time you use web results:\n" +
  "1. Intent first: before searching, decide what the user actually NEEDS, " +
  "not just what they literally asked, and search for that. If there's a " +
  "gap between the two, briefly say what you looked up and why.\n" +
  "2. Verify, don't assume: prefer original, reputable sources — official " +
  "sites, major news outlets, established review sites — over random blogs " +
  "or forums. When results conflict or look thin, search again with better " +
  "terms rather than guessing.\n" +
  "3. Grade your confidence out loud, in plain words: state a fact plainly " +
  "only when solid sources confirm it; say 'it looks like' or 'reports " +
  "suggest' when it's probable but unconfirmed; say 'my best guess' when " +
  "you're reading between the lines; and say clearly when the results " +
  "simply don't answer the question. Never dress a guess up as a fact, and " +
  "if your overall answer is shaky, say so up front.\n" +
  "4. Recommendations must be real and actionable: never recommend a " +
  "product, place, or service you didn't actually find in the search " +
  "results, and every claim you speak must trace back to a source you saw. " +
  "The cited pages travel back with your reply automatically as sources.\n" +
  "5. Surface what matters for the decision, briefly: the one or two " +
  "biggest caveats or unknowns ('one thing I couldn't confirm is...'), and " +
  "when the right answer genuinely depends on the user's situation or on a " +
  "short-term versus long-term trade-off, name that in one short sentence " +
  "instead of pretending there's a single answer.\n" +
  "6. Foresee harm on consequential topics: for money, health, safety, or " +
  "legal questions, mention the main way the advice could go wrong and " +
  "suggest verifying with the source or a professional before acting.\n" +
  "7. Easy to understand always: you're speaking to a LISTENER. Lead with " +
  "the answer, round numbers, keep comparisons concrete, group related " +
  "findings, and keep it short — a few sentences unless they asked for " +
  "depth. Mention sources naturally by name — like 'according to Reuters' " +
  "— and never read URLs aloud.\n" +
  "8. Two-layer output — REQUIRED every time you used web search: your " +
  "reply has a spoken layer and a display layer. The spoken layer is " +
  "everything you write normally: natural conversational prose in your own " +
  "voice, explaining the results so a listener understands them. Then, at " +
  "the VERY END of your reply, append the display layer as one line in " +
  "exactly this format:\n" +
  '[[DISPLAY]]{"bullets":["first key finding","second key finding"]}[[/DISPLAY]]\n' +
  "The bullets are what appears on screen: 3 to 6 short, self-contained, " +
  "scannable answer points that are 100% faithful to what the search " +
  "results actually said — exact names, numbers, and dates, no rounding " +
  "and no personality in the bullets. The display block is stripped out " +
  "before you're heard, so never mention it aloud and never put it " +
  "anywhere except the very end. If you did NOT use web search, do not " +
  "include a display block at all.\n\n" +
  "If the transcript may be misheard (a low confidence flag appears), " +
  "confirm before saving/updating anything, but answer questions normally.\n\n" +
  "Honesty over helpfulness: never claim you saved, found, or did something " +
  "unless the tool result confirms it.";

var AGENT_ADDON =
  "\n\nActing on the page: the user has allowed you to operate their current " +
  "tab. When the message includes an INTERACTIVE ELEMENTS list and the user " +
  "wants something DONE on the page (click, type, reply, search, select…), " +
  "call act_on_page with the next SMALL step (1-3 actions), using ONLY " +
  "element ids from the list. You'll be shown the refreshed page after the " +
  "actions run, and can continue step by step. Set done=true when finished " +
  "or when you're only answering. NEVER type or submit passwords, payment " +
  "card numbers, or security codes — refuse plainly instead. If the request " +
  "is only to read or answer, don't call act_on_page at all — just answer.";

/* ------------------------------------------------------------------ *
 * Tool definitions
 * ------------------------------------------------------------------ */
function memoryTools_() {
  return [
    {
      name: "save_memory",
      description:
        "Save a note, task, decision, or preference to the user's persistent memory store. Use when the user asks to remember, note, save, or track something.",
      input_schema: {
        type: "object",
        properties: {
          entry_type: { type: "string", enum: ["note", "task", "decision", "preference"] },
          title: { type: "string", description: "Short clean title, under 80 chars" },
          content: { type: "string", description: "The full thing to remember, clearly worded" },
          tags: { type: "array", items: { type: "string" } },
          importance: { type: "integer", description: "1 (trivial) to 5 (critical)" },
        },
        required: ["entry_type", "title", "content"],
      },
    },
    {
      name: "search_memory",
      description:
        "Keyword-search the user's saved notes/tasks/decisions. Returns matching entries with their entry_id, title, content, type, status, and created date.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keywords to search for; empty returns the most recent entries" },
          entry_type: { type: "string", enum: ["note", "task", "decision", "preference"] },
          limit: { type: "integer" },
        },
        required: ["query"],
      },
    },
    {
      name: "update_memory",
      description:
        "Update one saved entry: mark a task done, change its title/content, or delete it. Requires the entry_id (search_memory returns it).",
      input_schema: {
        type: "object",
        properties: {
          entry_id: { type: "string" },
          status: { type: "string", enum: ["open", "done", "dropped"] },
          title: { type: "string" },
          content: { type: "string" },
          deleted: { type: "boolean", description: "true to remove the entry" },
        },
        required: ["entry_id"],
      },
    },
    {
      name: "summarize_memory",
      description:
        "Fetch the user's saved entries (optionally filtered) so you can summarize them. Returns the matching entries; compose the spoken summary yourself from what comes back.",
      input_schema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["notes", "tasks", "open_tasks", "all"] },
          query: { type: "string", description: "Optional topic filter" },
          days: { type: "integer", description: "Only entries from the last N days" },
        },
        required: ["scope"],
      },
    },
  ];
}

// Anthropic's built-in web search: the SEARCHES RUN ON ANTHROPIC'S SERVERS
// during the model call. Nothing in this script executes them — they never
// appear in the tool-round loop below. Billed to your Anthropic key (~1¢
// per search); WEB_SEARCH_MAX_USES caps how many can run per question.
function webSearchTool_() {
  return {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: WEB_SEARCH_MAX_USES,
  };
}

function actOnPageTool_() {
  return {
    name: "act_on_page",
    description:
      "Perform the next small batch of actions on the user's current tab. Only available when an INTERACTIVE ELEMENTS list is present. Use element ids from that list only.",
    input_schema: {
      type: "object",
      properties: {
        say: { type: "string", description: "One short spoken sentence about what you're doing" },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["click", "type", "clear", "select", "key", "scroll"] },
              id: { type: "integer" },
              text: { type: "string" },
              append: { type: "boolean" },
              option: { type: "string" },
              key: { type: "string" },
              direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
            },
            required: ["type"],
          },
        },
        done: { type: "boolean", description: "true when the goal is complete after these actions (or no actions needed)" },
      },
      required: ["say", "actions", "done"],
    },
  };
}

/* ------------------------------------------------------------------ *
 * assist — the brain
 * ------------------------------------------------------------------ */
function actionAssist_(p) {
  var userText = String(p.user_text || "").trim();
  if (!userText) throw new Error("user_text is required");
  var sessionId = String(p.session_id || "");
  var userId = String(p.user_id || "");
  var assistantId = String(p.assistant_id || "");
  var agentMode = !!(p.agent && p.agent.enabled);
  var page = p.page || {};

  // System: stable core (+ agent addon when the page is operable).
  var systemText = SYSTEM_CORE + (agentMode ? AGENT_ADDON : "");
  var system = [
    { type: "text", text: systemText, cache_control: { type: "ephemeral" } },
  ];

  // Conversation history: client-provided, else rebuilt from the sheet.
  var history = sanitizeHistory_(p.history);
  if (!history.length && sessionId) {
    history = historyFromSheet_(sessionId, HISTORY_FALLBACK_TURNS);
  }

  // The user turn: volatile context blocks + what they said.
  var userBlock = buildUserBlock_(userText, page, p, agentMode);
  var messages = history.concat([{ role: "user", content: userBlock }]);

  var tools = memoryTools_();
  tools.push(webSearchTool_());
  if (agentMode) tools.push(actOnPageTool_());

  var events = [];
  var plan = null;
  var replyParts = [];
  var response = null;
  var sources = []; // [{title, url}] gathered from web search citations
  var seenUrls = {};

  for (var round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    response = callClaude_({ system: system, messages: messages, tools: tools });

    var toolUses = [];
    for (var i = 0; i < response.content.length; i++) {
      var block = response.content[i];
      if (block.type === "text" && block.text) {
        replyParts.push(block.text);
        // Web-search answers arrive with citations attached to text blocks.
        // Harvest each cited page once (by URL) so we can show sources.
        if (Array.isArray(block.citations)) {
          for (var c = 0; c < block.citations.length; c++) {
            var cite = block.citations[c];
            if (cite && cite.url && !seenUrls[cite.url]) {
              seenUrls[cite.url] = true;
              sources.push({ title: String(cite.title || cite.url), url: String(cite.url) });
            }
          }
        }
      } else if (block.type === "tool_use") {
        toolUses.push(block);
      }
      // server_tool_use / web_search_tool_result blocks are Anthropic's own
      // bookkeeping for searches it already ran — nothing for us to execute.
    }

    // Long web-search turns can pause mid-answer; hand the partial turn back
    // and let the model finish. Reply text collected so far is kept.
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    if (response.stop_reason !== "tool_use" || !toolUses.length) break;

    // act_on_page is executed by the EXTENSION — return it as the plan.
    var pageCall = toolUses.filter(function (t) { return t.name === "act_on_page"; })[0];
    if (pageCall) {
      plan = {
        say: String(pageCall.input.say || ""),
        actions: Array.isArray(pageCall.input.actions) ? pageCall.input.actions : [],
        done: pageCall.input.done === true,
      };
      break;
    }

    // Execute memory tools against the Sheet, feed results back.
    messages.push({ role: "assistant", content: response.content });
    var results = [];
    for (var t = 0; t < toolUses.length; t++) {
      var call = toolUses[t];
      var result;
      try {
        result = runMemoryTool_(call.name, call.input || {}, {
          user_id: userId,
          assistant_id: assistantId,
          session_id: sessionId,
          page_url: page.url || "",
          bare_ack: isBareAcknowledgement_(userText),
        });
        events.push({ tool: call.name, ok: true, data: result.event || null });
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(result.forModel),
        });
      } catch (toolErr) {
        events.push({ tool: call.name, ok: false, error: String(toolErr) });
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: "Error: " + String((toolErr && toolErr.message) || toolErr),
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: results });
    replyParts = []; // the final answer comes after the tool results
  }

  var reply = replyParts.join(" ").trim();

  // Two-layer split: pull the [[DISPLAY]]{...}[[/DISPLAY]] block (the
  // on-screen bullets) out of the reply so the spoken layer stays natural.
  var displayBullets = [];
  var dm = reply.match(/\[\[DISPLAY\]\]([\s\S]*?)\[\[\/DISPLAY\]\]/);
  if (dm) {
    try {
      var dj = JSON.parse(dm[1]);
      if (dj && Array.isArray(dj.bullets)) {
        displayBullets = dj.bullets
          .map(function (b) { return String(b || "").trim(); })
          .filter(function (b) { return b; })
          .slice(0, 6);
      }
    } catch (_) {
      // Malformed block: just strip it; the card falls back to sources only.
    }
    reply = reply.replace(dm[0], "").trim();
  }

  if (!reply && plan) reply = plan.say;
  if (!reply && displayBullets.length) reply = "Here's what I found — it's on your screen.";
  if (!reply) reply = "I'm not sure what to say to that — try me again?";

  // The on-screen web results card: question, bulleted answers, clickable
  // sources. The side panel renders this; the spoken reply above is what
  // Sharon says out loud in her own voice.
  if (sources.length || displayBullets.length) {
    events.push({
      tool: "web_search",
      ok: true,
      data: {
        kind: "web_search",
        question: userText,
        bullets: displayBullets,
        count: sources.length,
        sources: sources,
      },
    });
  }

  // Log both turns in one batched write. Agent continuation steps set
  // log:false so synthetic "(continue)" turns don't pollute the transcript.
  if (p.log !== false) logTurns_(p, userText, reply, page);

  return { reply: reply, plan: plan, events: events, sources: sources, model: model_() };
}

function buildUserBlock_(userText, page, p, agentMode) {
  var parts = [];
  var excerpt = String(page.excerpt || "").trim();
  if (excerpt) {
    parts.push(
      "PAGE CONTEXT (the user's active tab right now)\nTitle: " +
        (page.title || "(untitled)") +
        "\nURL: " +
        (page.url || "") +
        "\n---\n" +
        excerpt +
        "\n---"
    );
  }
  if (agentMode && p.agent) {
    if (p.agent.elements) {
      parts.push("INTERACTIVE ELEMENTS on the page right now:\n" + p.agent.elements);
    }
    if (p.agent.log && p.agent.log.length) {
      parts.push("ACTIONS ALREADY TAKEN this task:\n" + p.agent.log.join("\n"));
    }
    if (p.agent.goal) {
      parts.push("ONGOING GOAL: " + p.agent.goal);
    }
  }
  var conf = p.asr_confidence;
  if (conf != null && conf !== "" && Number(conf) < 0.6) {
    parts.push("(Note: the speech transcript below is LOW CONFIDENCE — confirm before saving or acting.)");
  }
  parts.push("USER SAYS: " + userText);
  return parts.join("\n\n");
}

function sanitizeHistory_(history) {
  var out = [];
  if (!Array.isArray(history)) return out;
  for (var i = 0; i < history.length; i++) {
    var h = history[i] || {};
    var role = h.role === "assistant" ? "assistant" : h.role === "user" ? "user" : null;
    var content = String(h.content || "").trim();
    if (role && content) pushMergedTurn_(out, role, content);
  }
  // API requires the first message to be from the user.
  while (out.length && out[0].role !== "user") out.shift();
  return out.slice(-2 * HISTORY_FALLBACK_TURNS);
}

// Consecutive same-role turns (local notices, agent-step speech) collapse
// into one message, so "Sharon's immediately previous reply" — what a bare
// "yes" answers — is always a single unambiguous message in the prompt.
function pushMergedTurn_(out, role, content) {
  var c = content.slice(0, 4000);
  if (out.length && out[out.length - 1].role === role) {
    out[out.length - 1].content = (out[out.length - 1].content + "\n" + c).slice(0, 4000);
  } else {
    out.push({ role: role, content: c });
  }
}

function historyFromSheet_(sessionId, limit) {
  try {
    var rows = recentTurns_({ session_id: sessionId, limit: limit });
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var role = rows[i].role === "assistant" ? "assistant" : "user";
      var content = String(rows[i].content || "").trim();
      if (content) pushMergedTurn_(out, role, content);
    }
    while (out.length && out[0].role !== "user") out.shift();
    return out;
  } catch (_) {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Bare affirmations — "yes", "yes I do", "sure", "no thanks"…
 * These answer Sharon's previous reply; they are never a save request.
 * ------------------------------------------------------------------ */
var ACK_OPENERS_ = {
  yes: 1, yeah: 1, yep: 1, yup: 1, sure: 1, ok: 1, okay: 1, alright: 1,
  absolutely: 1, definitely: 1, certainly: 1, please: 1, of: 1,
  no: 1, nope: 1, nah: 1,
};
var ACK_FILLERS_ = {
  i: 1, do: 1, did: 1, would: 1, will: 1, am: 1, please: 1, thanks: 1,
  thank: 1, you: 1, it: 1, that: 1, now: 1, go: 1, ahead: 1, sounds: 1,
  good: 1, course: 1, not: 1, dont: 1, sharon: 1,
};
function isBareAcknowledgement_(text) {
  var words = String(text || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z ]+/g, " ")
    .split(/\s+/)
    .filter(function (w) { return w; });
  if (!words.length || words.length > 4) return false;
  if (!ACK_OPENERS_[words[0]]) return false;
  for (var i = 1; i < words.length; i++) {
    if (!ACK_FILLERS_[words[i]]) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Legacy ask — single conversational call, no tools
 * ------------------------------------------------------------------ */
function actionAsk_(p) {
  var userText = String(p.user_text || "").trim();
  if (!userText) throw new Error("user_text is required");
  var system = [{ type: "text", text: String(p.system || SYSTEM_CORE) }];
  var messages = sanitizeHistory_(p.history);
  messages.push({ role: "user", content: userText });
  var response = callClaude_({ system: system, messages: messages, tools: null });
  var reply = "";
  for (var i = 0; i < response.content.length; i++) {
    if (response.content[i].type === "text") reply += response.content[i].text;
  }
  logTurns_(p, userText, reply, p.page || {});
  return { reply: reply.trim(), model: model_() };
}

/* ------------------------------------------------------------------ *
 * Anthropic transport
 * ------------------------------------------------------------------ */
function callClaude_(opts) {
  var key = props_().getProperty("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY script property is not set");

  var body = {
    model: model_(),
    max_tokens: opts.maxTokens || REPLY_MAX_TOKENS,
    system: opts.system,
    messages: opts.messages,
  };
  if (opts.tools && opts.tools.length) body.tools = opts.tools;

  var res = UrlFetchApp.fetch(ANTHROPIC_URL, {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  var code = res.getResponseCode();
  var data = JSON.parse(res.getContentText());
  if (code >= 300) {
    var msg = (data && data.error && data.error.message) || "model call failed (" + code + ")";
    throw new Error(msg);
  }
  if (data.stop_reason === "refusal") {
    return {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "I can't help with that request." }],
    };
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * Memory tools — executed against the Sheet
 * ------------------------------------------------------------------ */
function runMemoryTool_(name, input, ctx) {
  if (name === "save_memory") {
    // Deterministic backstop for the HARD SAVE RULES: a short "yes"/"no"
    // answers Sharon's previous reply and can never justify writing to the
    // Sheet, no matter what content the model composed.
    if (ctx.bare_ack) {
      return {
        forModel: {
          saved: false,
          refused: true,
          reason:
            "Save refused: the user's message is only a short affirmation or " +
            "negation answering your previous reply. Do the thing you last " +
            "offered or asked about instead. Only save when the user provides " +
            "the content themselves or explicitly asks you to save something.",
        },
        event: null,
      };
    }
    var saved = actionDistill_({
      entry_type: input.entry_type || "note",
      title: input.title || "",
      content: input.content || "",
      tags: input.tags || [],
      importance: input.importance || 3,
      user_id: ctx.user_id,
      assistant_id: ctx.assistant_id,
      session_id: ctx.session_id,
      page_url: ctx.page_url,
      source_turn_ids: [],
    });
    return {
      forModel: { saved: true, entry_id: saved.entry_id, title: input.title },
      event: {
        kind: "saved",
        entry_id: saved.entry_id,
        entry_type: input.entry_type || "note",
        title: input.title || "",
        content: input.content || "",
      },
    };
  }
  if (name === "search_memory") {
    var hits = searchMemory_({
      query: input.query || "",
      entry_type: input.entry_type || "",
      limit: input.limit || 6,
      user_id: ctx.user_id,
      assistant_id: ctx.assistant_id,
      touch: true,
    });
    return {
      forModel: { count: hits.length, results: hits },
      event: { kind: "found", count: hits.length, hits: hits },
    };
  }
  if (name === "update_memory") {
    var updated = updateMemory_({
      entry_id: input.entry_id,
      status: input.status,
      title: input.title,
      content: input.content,
      deleted: input.deleted,
    });
    return {
      forModel: updated,
      event: { kind: "updated", entry_id: input.entry_id, patch: input },
    };
  }
  if (name === "summarize_memory") {
    var rows = memoryForScope_({
      scope: input.scope || "all",
      query: input.query || "",
      days: input.days || 0,
      user_id: ctx.user_id,
      assistant_id: ctx.assistant_id,
      limit: 40,
    });
    return {
      forModel: { count: rows.length, entries: rows },
      event: { kind: "summarized", count: rows.length },
    };
  }
  throw new Error("unknown tool: " + name);
}

/* ------------------------------------------------------------------ *
 * Sheet helpers
 * ------------------------------------------------------------------ */
function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error("missing sheet tab: " + name);
  return sh;
}

function headers_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function rowFromObject_(headers, obj) {
  return headers.map(function (h) {
    var v = obj[h];
    return v == null ? "" : v;
  });
}

function readAll_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return { sh: sh, headers: headers_(sh), rows: [] };
  var headers = headers_(sh);
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  return { sh: sh, headers: headers, rows: values };
}

function uuid_() {
  return Utilities.getUuid();
}

function nowIso_() {
  return new Date().toISOString();
}

function domainOf_(url) {
  var m = String(url || "").match(/^[a-z]+:\/\/(?:www\.)?([^\/]+)/i);
  return m ? m[1] : "";
}

/* ------------------------------------------------------------------ *
 * conversation_turns
 * ------------------------------------------------------------------ */
function turnRow_(headers, p, role, content, extra) {
  var obj = {
    turn_id: uuid_(),
    session_id: p.session_id || "",
    user_id: p.user_id || "",
    assistant_id: p.assistant_id || "",
    created_at: nowIso_(),
    seq: extra.seq || "",
    role: role,
    modality: p.modality || "voice",
    content: content,
    transcript_raw: role === "user" ? p.transcript_raw || "" : "",
    asr_confidence: role === "user" && p.asr_confidence != null ? p.asr_confidence : "",
    language: p.language || "en-US",
    model: role === "assistant" ? model_() : "",
    page_url: (p.page && p.page.url) || p.page_url || "",
    page_title: (p.page && p.page.title) || p.page_title || "",
    page_domain: domainOf_((p.page && p.page.url) || p.page_url || ""),
    screen_excerpt: role === "user" ? String((p.page && p.page.excerpt) || p.screen_excerpt || "").slice(0, 2000) : "",
    sensitive: "",
    client_msg_id: role === "user" ? p.client_msg_id || "" : "",
    embedding: "",
  };
  return { id: obj.turn_id, values: rowFromObject_(headers, obj) };
}

// Batched: user + assistant rows in one appendRows-equivalent write.
function logTurns_(p, userText, reply, page) {
  try {
    var sh = sheet_(SHEETS.turns);
    var headers = headers_(sh);
    var seqBase = sh.getLastRow(); // cheap monotonic-ish sequence
    var q = Object.create(null);
    for (var k in p) q[k] = p[k];
    q.page = page;
    var u = turnRow_(headers, q, "user", userText, { seq: seqBase });
    var a = turnRow_(headers, q, "assistant", reply, { seq: seqBase + 1 });
    sh.getRange(sh.getLastRow() + 1, 1, 2, headers.length).setValues([u.values, a.values]);
    touchSession_(p, page);
    return { user_turn_id: u.id, assistant_turn_id: a.id };
  } catch (err) {
    // Logging must never break the conversation.
    return { error: String(err) };
  }
}

function actionAppendTurn_(p) {
  var sh = sheet_(SHEETS.turns);
  var headers = headers_(sh);
  var row = turnRow_(headers, p, p.role === "assistant" ? "assistant" : "user", String(p.content || ""), {
    seq: sh.getLastRow(),
  });
  sh.appendRow(row.values);
  return { turn_id: row.id };
}

function recentTurns_(p) {
  var sessionId = String(p.session_id || "");
  var limit = Math.max(1, Math.min(50, Number(p.limit) || HISTORY_FALLBACK_TURNS));
  var data = readAll_(SHEETS.turns);
  var idx = indexMap_(data.headers);
  var out = [];
  for (var i = data.rows.length - 1; i >= 0 && out.length < limit; i--) {
    var r = data.rows[i];
    if (sessionId && String(r[idx.session_id]) !== sessionId) continue;
    out.push({
      turn_id: r[idx.turn_id],
      role: r[idx.role],
      content: r[idx.content],
      created_at: isoOf_(r[idx.created_at]),
    });
  }
  return out.reverse();
}

/* ------------------------------------------------------------------ *
 * sessions — cheap upsert, cached so we don't re-scan every call
 * ------------------------------------------------------------------ */
function touchSession_(p, page) {
  var sessionId = String(p.session_id || "");
  if (!sessionId) return;
  var cache = CacheService.getScriptCache();
  if (cache.get("sess:" + sessionId)) return; // already registered recently
  var sh = sheet_(SHEETS.sessions);
  var found = sh.createTextFinder(sessionId).matchEntireCell(true).findNext();
  if (!found) {
    var headers = headers_(sh);
    sh.appendRow(
      rowFromObject_(headers, {
        session_id: sessionId,
        user_id: p.user_id || "",
        assistant_id: p.assistant_id || "",
        started_at: nowIso_(),
        browser: p.browser || "chrome",
        extension_version: p.extension_version || "",
        primary_url: (page && page.url) || "",
        primary_domain: domainOf_((page && page.url) || ""),
        status: "active",
      })
    );
  }
  cache.put("sess:" + sessionId, "1", 21600);
}

/* ------------------------------------------------------------------ *
 * memory_log
 * ------------------------------------------------------------------ */
function actionDistill_(p) {
  var sh = sheet_(SHEETS.memory);
  var headers = headers_(sh);
  var entryId = uuid_();
  sh.appendRow(
    rowFromObject_(headers, {
      entry_id: entryId,
      user_id: p.user_id || "",
      assistant_id: p.assistant_id || "",
      session_id: p.session_id || "",
      source_turn_ids: JSON.stringify(p.source_turn_ids || []),
      created_at: nowIso_(),
      updated_at: nowIso_(),
      entry_type: p.entry_type || "note",
      title: String(p.title || "").slice(0, 120),
      content: String(p.content || ""),
      tags: JSON.stringify(p.tags || []),
      project: p.project || "",
      status: p.entry_type === "task" ? "open" : "",
      importance: p.importance || 3,
      access_count: 0,
      linked_ids: "",
      page_url: p.page_url || "",
      deleted: "",
      embedding: "",
    })
  );
  return { entry_id: entryId };
}

function indexMap_(headers) {
  var m = {};
  for (var i = 0; i < headers.length; i++) m[headers[i]] = i;
  return m;
}

function isoOf_(v) {
  if (v instanceof Date) return v.toISOString();
  return String(v || "");
}

function memoryRowToObj_(r, idx) {
  return {
    entry_id: r[idx.entry_id],
    entry_type: r[idx.entry_type],
    title: r[idx.title],
    content: r[idx.content],
    tags: r[idx.tags],
    status: r[idx.status],
    importance: r[idx.importance],
    created_at: isoOf_(r[idx.created_at]),
    page_url: r[idx.page_url],
  };
}

function searchMemory_(p) {
  var query = String(p.query || "").toLowerCase().trim();
  var limit = Math.max(1, Math.min(25, Number(p.limit) || 5));
  var wantType = String(p.entry_type || "");
  var userId = String(p.user_id || "");

  var data = readAll_(SHEETS.memory);
  var idx = indexMap_(data.headers);
  var terms = query ? query.split(/\s+/).filter(function (t) { return t.length > 1; }) : [];

  var scored = [];
  for (var i = 0; i < data.rows.length; i++) {
    var r = data.rows[i];
    if (String(r[idx.deleted]).toLowerCase() === "true") continue;
    if (userId && String(r[idx.user_id]) && String(r[idx.user_id]) !== userId) continue;
    if (wantType && String(r[idx.entry_type]) !== wantType) continue;
    var hay = (String(r[idx.title]) + " " + String(r[idx.content]) + " " + String(r[idx.tags])).toLowerCase();
    var score = 0;
    for (var t = 0; t < terms.length; t++) {
      if (hay.indexOf(terms[t]) >= 0) score += 2;
    }
    if (terms.length && score === 0) continue;
    scored.push({ score: score, rowIndex: i + 2, obj: memoryRowToObj_(r, idx) });
  }

  // Keyword searches also scan the recordings tab transcripts. Hits come
  // back in the SAME shape the panel already renders — read-only, with
  // entry_id "rec:<recording_id>" and the Drive audio link as page_url.
  if (terms.length && !wantType) {
    var recHits = searchRecordings_(terms);
    for (var rh = 0; rh < recHits.length; rh++) {
      scored.push({ score: recHits[rh].score, recording: true, obj: recHits[rh].obj });
    }
  }

  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.obj.created_at).localeCompare(String(a.obj.created_at));
  });
  var hits = scored.slice(0, limit);

  if (p.touch && hits.length && idx.access_count != null) {
    var sh = sheet_(SHEETS.memory);
    for (var h = 0; h < hits.length; h++) {
      if (hits[h].recording) continue; // recordings have no access_count
      var cell = sh.getRange(hits[h].rowIndex, idx.access_count + 1);
      cell.setValue((Number(cell.getValue()) || 0) + 1);
    }
  }
  return hits.map(function (h) { return h.obj; });
}

function searchRecordings_(terms) {
  var sh = ss_().getSheetByName(SHEETS.recordings);
  if (!sh || sh.getLastRow() < 2) return [];
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var idx = indexMap_(headers);
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var transcript = String(r[idx.transcript] || "");
    var hay = transcript.toLowerCase();
    var score = 0;
    for (var t = 0; t < terms.length; t++) {
      if (hay.indexOf(terms[t]) >= 0) score += 2;
    }
    if (!score) continue;
    var createdAt = isoOf_(r[idx.created_at]);
    var durationSec = Number(r[idx.duration_seconds]) || 0;
    var min = Math.max(1, Math.round(durationSec / 60));
    var title = "Recording (" + min + " min)";
    try {
      title =
        "Recording — " +
        Utilities.formatDate(new Date(createdAt), Session.getScriptTimeZone(), "MMM d") +
        " (" + min + " min)";
    } catch (_) {
      // date unparsable: the duration-only title still reads fine
    }
    var obj = {
      entry_id: "rec:" + r[idx.recording_id],
      recording_id: String(r[idx.recording_id] || ""),
      entry_type: "recording",
      title: title,
      content: transcriptExcerpt_(transcript, terms),
      tags: "",
      status: "",
      importance: "",
      created_at: createdAt,
      page_url: String(r[idx.drive_file_url] || ""),
      duration_seconds: durationSec,
    };
    // The moment that matched (new recordings only): the same keyword
    // scoring, applied per timestamped segment. Old rows without a
    // segments column — or with an empty cell — simply omit it, and the
    // panel plays those from 0:00.
    if (idx.segments != null) {
      var best = bestSegment_(segmentsFromCell_(r[idx.segments]), terms);
      if (best) {
        obj.start_seconds = best.t;
        obj.start_label = clockLabel_(best.t);
      }
    }
    out.push({ score: score, obj: obj });
  }
  return out;
}

// Pick the segment whose text best matches the query — the exact scoring
// searchMemory_ uses (+2 per matched term), earliest segment wins a tie.
function bestSegment_(segments, terms) {
  var best = null;
  var bestScore = 0;
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i] || {};
    var hay = String(seg.text || "").toLowerCase();
    var score = 0;
    for (var t = 0; t < terms.length; t++) {
      if (hay.indexOf(terms[t]) >= 0) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = seg;
    }
  }
  return best ? { t: Math.max(0, Math.round(Number(best.t) || 0)) } : null;
}

// A segments cell holds either the JSON array itself or (when it was too
// long for a cell) the link to the companion .json file in Drive.
function segmentsFromCell_(v) {
  var s = String(v || "").trim();
  if (!s) return [];
  if (s.charAt(0) === "[") {
    try {
      var arr = JSON.parse(s);
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }
  var id = driveFileIdFromUrl_(s);
  if (!id) return [];
  try {
    var arr2 = JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString());
    return Array.isArray(arr2) ? arr2 : [];
  } catch (_) {
    return [];
  }
}

// "12:40"-style label for a start time in seconds.
function clockLabel_(secs) {
  var s = Math.max(0, Math.round(Number(secs) || 0));
  var r = s % 60;
  return Math.floor(s / 60) + ":" + (r < 10 ? "0" : "") + r;
}

function updateMemory_(p) {
  var entryId = String(p.entry_id || "");
  if (!entryId) throw new Error("entry_id is required");
  // Recordings are read-only — decline politely instead of erroring, so a
  // stray edit/delete attempt from any flow never breaks the panel.
  if (entryId.indexOf("rec:") === 0) {
    return { updated: false, readonly: true, entry_id: entryId };
  }
  var data = readAll_(SHEETS.memory);
  var idx = indexMap_(data.headers);
  for (var i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idx.entry_id]) !== entryId) continue;
    var sh = data.sh;
    var rowNum = i + 2;
    var set = function (col, val) {
      if (idx[col] != null) sh.getRange(rowNum, idx[col] + 1).setValue(val);
    };
    if (p.status != null) set("status", p.status);
    if (p.title != null) set("title", p.title);
    if (p.content != null) set("content", p.content);
    if (p.deleted != null) set("deleted", p.deleted ? "TRUE" : "");
    set("updated_at", nowIso_());
    return { updated: true, entry_id: entryId };
  }
  throw new Error("entry not found: " + entryId);
}

function memoryForScope_(p) {
  var scope = p.scope || "all";
  var days = Number(p.days) || 0;
  var cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
  var wantType = scope === "notes" ? "note" : scope === "tasks" || scope === "open_tasks" ? "task" : "";
  var hits = searchMemory_({
    query: p.query || "",
    entry_type: wantType,
    limit: p.limit || 40,
    user_id: p.user_id || "",
    touch: false,
  });
  return hits.filter(function (h) {
    if (scope === "open_tasks" && String(h.status) === "done") return false;
    if (cutoff && new Date(h.created_at).getTime() < cutoff) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * save_recording — audio to Drive, transcript to the Sheet, and the
 * important bits distilled into memory_log (each note linking the audio).
 * The Drive file and the recordings row are the non-negotiables; the
 * distillation is best-effort — a model hiccup never fails the save.
 * ------------------------------------------------------------------ */
function actionSaveRecording_(p) {
  var b64 = String(p.audio_base64 || "");
  if (!b64) throw new Error("audio_base64 is required");
  var mime = String(p.mime_type || "audio/webm");
  var duration = Math.max(0, Math.round(Number(p.duration_seconds) || 0));
  var transcript = String(p.transcript || "");
  var when = p.timestamp ? new Date(p.timestamp) : new Date();
  if (isNaN(when.getTime())) when = new Date();

  // 1) The audio lands in Drive first — everything else can degrade.
  var folder = recordingsFolder_();
  var minutes = Math.max(1, Math.round(duration / 60));
  var stamp = Utilities.formatDate(when, Session.getScriptTimeZone(), "yyyy-MM-dd HH.mm");
  var name = "Sharon " + stamp + " (" + minutes + " min).webm";
  var file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), mime, name));
  var fileUrl = file.getUrl();

  // 2) Cell guard: a Sheets cell holds at most 50,000 chars. An over-long
  // transcript goes to a companion .txt in the same folder; the cell keeps
  // the first chunk plus the link, so the save NEVER fails on length.
  var cellText = transcript;
  if (transcript.length > TRANSCRIPT_CELL_MAX) {
    var txtFile = folder.createFile(
      Utilities.newBlob(transcript, "text/plain", name.replace(/\.webm$/, "") + " transcript.txt")
    );
    cellText =
      transcript.slice(0, TRANSCRIPT_CELL_MAX) +
      "\n\n[Full transcript: " + txtFile.getUrl() + "]";
  }

  // 2b) Timestamped segments ([{t, text}], new recordings only) — the same
  // cell guard: over-long segments JSON becomes a companion .json file in
  // the folder, and the cell holds just its link.
  var segments = sanitizeSegments_(p.segments);
  var segCell = "";
  if (segments.length) {
    segCell = JSON.stringify(segments);
    if (segCell.length > TRANSCRIPT_CELL_MAX) {
      var segFile = folder.createFile(
        Utilities.newBlob(segCell, "application/json", name.replace(/\.webm$/, "") + " segments.json")
      );
      segCell = segFile.getUrl();
    }
  }

  // 3) One row in the recordings tab. Columns are looked up by header name,
  // so the sheet's own column order — old tab or new — is always respected.
  var sh = recordingsSheet_();
  var headers = headers_(sh);
  var recordingId = uuid_();
  var rowNum = sh.getLastRow() + 1;
  sh.getRange(rowNum, 1, 1, headers.length).setValues([
    rowFromObject_(headers, {
      recording_id: recordingId,
      created_at: nowIso_(),
      duration_seconds: duration,
      drive_file_url: fileUrl,
      transcript: cellText,
      session_id: String(p.session_id || ""),
      notes_saved: 0,
      segments: segCell,
    }),
  ]);

  // 4) Distill the transcript into memory notes — best effort, and the
  // page_url on every note is the Drive audio link ("listen to the source").
  var notes = [];
  try {
    notes = distillRecording_(transcript, {
      user_id: String(p.user_id || ""),
      assistant_id: String(p.assistant_id || ""),
      session_id: String(p.session_id || ""),
      page_url: fileUrl,
    });
    if (notes.length && headers.indexOf("notes_saved") >= 0)
      sh.getRange(rowNum, headers.indexOf("notes_saved") + 1).setValue(notes.length);
  } catch (_) {
    // The recording is saved either way; the panel just shows zero notes.
  }

  return { recording_id: recordingId, drive_file_url: fileUrl, notes: notes };
}

function recordingsFolder_() {
  var it = DriveApp.getFoldersByName(RECORDINGS_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(RECORDINGS_FOLDER);
}

// Unlike sheet_(), this creates the tab (with headers) if it's missing,
// and appends any header a newer version added (e.g. "segments") at the
// END of the header row — existing columns and rows are never disturbed.
function recordingsSheet_() {
  var ss = ss_();
  var sh = ss.getSheetByName(SHEETS.recordings);
  if (!sh) {
    sh = ss.insertSheet(SHEETS.recordings);
    sh.appendRow(RECORDING_HEADERS);
    return sh;
  }
  var have = headers_(sh);
  for (var i = 0; i < RECORDING_HEADERS.length; i++) {
    if (have.indexOf(RECORDING_HEADERS[i]) < 0) {
      sh.getRange(1, have.length + 1).setValue(RECORDING_HEADERS[i]);
      have.push(RECORDING_HEADERS[i]);
    }
  }
  return sh;
}

// [{t, text}] in, [{t, text}] out — anything malformed is dropped, so a
// bad client payload can never poison the sheet or fail the save.
function sanitizeSegments_(raw) {
  if (!Array.isArray(raw)) return [];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var s = raw[i] || {};
    var text = String(s.text || "").trim();
    if (!text) continue;
    out.push({ t: Math.max(0, Math.round(Number(s.t) || 0)), text: text });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * get_recording_audio — the audio flows back through here (base64) so
 * the panel can play it in place. The Drive file's sharing settings are
 * NEVER changed: recordings stay private to the account running this
 * script. Oversized files come back as { too_large } and the panel falls
 * back to its Drive link.
 * ------------------------------------------------------------------ */
function actionGetRecordingAudio_(p) {
  var recId = String(p.recording_id || "").replace(/^rec:/, "").trim();
  if (!recId) throw new Error("recording_id is required");
  var sh = ss_().getSheetByName(SHEETS.recordings);
  if (!sh || sh.getLastRow() < 2) throw new Error("recording not found: " + recId);
  var headers = headers_(sh);
  var idx = indexMap_(headers);
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idx.recording_id]) !== recId) continue;
    var url = String(rows[i][idx.drive_file_url] || "");
    var fileId = driveFileIdFromUrl_(url);
    if (!fileId) throw new Error("that recording has no Drive audio file linked");
    var file = DriveApp.getFileById(fileId);
    var duration = Number(rows[i][idx.duration_seconds]) || 0;
    if (file.getSize() > AUDIO_MAX_BYTES) {
      return { too_large: true, drive_file_url: url, duration_seconds: duration };
    }
    var blob = file.getBlob();
    return {
      audio_base64: Utilities.base64Encode(blob.getBytes()),
      mime_type: blob.getContentType() || "audio/webm",
      duration_seconds: duration,
      drive_file_url: url,
    };
  }
  throw new Error("recording not found: " + recId);
}

// The file id out of any Drive URL shape (/d/<id>/, ?id=<id>, or bare).
function driveFileIdFromUrl_(url) {
  var s = String(url || "");
  var m = s.match(/\/d\/([-\w]{20,})/) || s.match(/[?&]id=([-\w]{20,})/) || s.match(/([-\w]{25,})/);
  return m ? m[1] : "";
}

var DISTILL_SYSTEM =
  "You organize a recorded conversation's transcript into the important notes " +
  "worth remembering. Reply with STRICT JSON only — a bare array, no prose, no " +
  'code fences: [{"entry_type":"note"|"task"|"decision","title":"short clean ' +
  'title","content":"the thing to remember, clearly worded","importance":1-5}]. ' +
  "Capture EVERYTHING important: decisions made, action items and who owns " +
  "them, key facts and numbers, commitments, and open questions. Skip filler " +
  "and small talk. If nothing is worth remembering, reply [].";

function distillRecording_(transcript, ctx) {
  var trimmed = String(transcript || "").trim();
  if (!trimmed) return [];
  var ask = "TRANSCRIPT OF THE RECORDING:\n" + trimmed.slice(0, 120000);

  // Parse robustly: strip fences, find the array; one retry, then give up
  // gracefully — the audio and transcript are already saved regardless.
  var entries = null;
  for (var attempt = 0; attempt < 2 && !entries; attempt++) {
    var response = callClaude_({
      system: [{ type: "text", text: DISTILL_SYSTEM }],
      messages: [{
        role: "user",
        content: attempt === 0
          ? ask
          : ask + "\n\nReply with ONLY the JSON array — no prose, no code fences.",
      }],
      tools: null,
      maxTokens: DISTILL_MAX_TOKENS,
    });
    var text = "";
    for (var i = 0; i < response.content.length; i++) {
      if (response.content[i].type === "text") text += response.content[i].text;
    }
    entries = parseDistillJson_(text);
  }
  if (!entries) return [];

  // Each entry lands in memory_log through the exact same path as Sharon's
  // normal notes — tagged "recording", audio link in page_url.
  var saved = [];
  for (var e = 0; e < entries.length && e < 30; e++) {
    var entry = entries[e] || {};
    var type = entry.entry_type === "task" || entry.entry_type === "decision" ? entry.entry_type : "note";
    var title = String(entry.title || "").trim();
    var content = String(entry.content || "").trim();
    if (!title && !content) continue;
    if (!title) title = content.slice(0, 80);
    if (!content) content = title;
    var importance = Math.max(1, Math.min(5, Math.round(Number(entry.importance) || 3)));
    var row = actionDistill_({
      entry_type: type,
      title: title,
      content: content,
      tags: ["recording"],
      importance: importance,
      user_id: ctx.user_id,
      assistant_id: ctx.assistant_id,
      session_id: ctx.session_id,
      page_url: ctx.page_url,
      source_turn_ids: [],
    });
    saved.push({
      entry_id: row.entry_id,
      entry_type: type,
      title: title,
      content: content,
      importance: importance,
    });
  }
  return saved;
}

function parseDistillJson_(text) {
  var t = String(text || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  var start = t.indexOf("[");
  var end = t.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    var arr = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
}

// The most relevant slice of a transcript for a search hit — a window
// around the first matched term, never the whole thing.
function transcriptExcerpt_(transcript, terms) {
  var lower = transcript.toLowerCase();
  var at = -1;
  for (var i = 0; i < terms.length; i++) {
    var j = lower.indexOf(terms[i]);
    if (j >= 0 && (at < 0 || j < at)) at = j;
  }
  if (at < 0) at = 0;
  var start = Math.max(0, at - 80);
  var end = Math.min(transcript.length, at + 220);
  return (
    (start > 0 ? "…" : "") + transcript.slice(start, end).trim() + (end < transcript.length ? "…" : "")
  );
}

/* ------------------------------------------------------------------ *
 * summarize_memory as a direct action (also reachable via assist tool)
 * ------------------------------------------------------------------ */
function actionSummarize_(p) {
  var rows = memoryForScope_(p);
  if (!rows.length) {
    return { summary: "There's nothing saved that matches that yet.", count: 0 };
  }
  var listing = rows
    .map(function (r) {
      return (
        "- [" + r.entry_type + (r.status ? "/" + r.status : "") + "] " +
        r.title + ": " + String(r.content).slice(0, 300) +
        " (" + String(r.created_at).slice(0, 10) + ")"
      );
    })
    .join("\n");
  var response = callClaude_({
    system: [
      {
        type: "text",
        text:
          "You summarize a user's saved notes and tasks for a VOICE assistant. " +
          "Reply with a short, natural spoken summary — plain prose, no markdown, " +
          "no lists — grouping related items and calling out anything urgent or due.",
      },
    ],
    messages: [{ role: "user", content: "Summarize these saved entries:\n" + listing }],
    tools: null,
  });
  var text = "";
  for (var i = 0; i < response.content.length; i++) {
    if (response.content[i].type === "text") text += response.content[i].text;
  }
  return { summary: text.trim(), count: rows.length };
}
