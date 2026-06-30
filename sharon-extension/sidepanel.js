// sidepanel.js — Sharon's brains: follow the active tab, read it aloud, let the
// user talk to her through one microphone, and route what she hears to the
// Speaking_Assistant backend (action-based API + two-layer memory tables).
//
// The working engine (continuous Web Speech recognition, speechSynthesis
// read-aloud, live page-text extraction, voice scrolling, the on-page "act"
// agent, settings storage, the stored session id, and the echo filter) is the
// same as before — it has only been re-wired to the new card-based UI and the
// new { api_key, action, payload } envelope.

import {
  PROXY_URL,
  API_KEY,
  USER_ID,
  ASSISTANT_ID,
  MAX_PAGE_TEXT,
} from "./config.js";

/* ------------------------------------------------------------------ *
 * Element references (the redesigned side panel)
 * ------------------------------------------------------------------ */
const els = {
  html: document.documentElement,
  tabTitle: document.getElementById("tabTitle"),
  statusLine: document.getElementById("statusLine"),
  statusSub: document.getElementById("statusSub"),
  body: document.getElementById("body"),
  caps: document.getElementById("caps"),
  stack: document.getElementById("stack"),
  coach: document.getElementById("coach"),
  orb: document.getElementById("orb"),
  dockMic: document.getElementById("dockMic"),
  voiceBtn: document.getElementById("voiceBtn"),
  notesBtn: document.getElementById("notesBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsSheet: document.getElementById("settingsSheet"),
  notesSheet: document.getElementById("notesSheet"),
  noteSearchInput: document.getElementById("noteSearchInput"),
  notesList: document.getElementById("notesList"),
  autoReadToggle: document.getElementById("autoReadToggle"),
  scrollToggle: document.getElementById("scrollToggle"),
  actionsToggle: document.getElementById("actionsToggle"),
  confirmToggle: document.getElementById("confirmToggle"),
  shortcutValue: document.getElementById("shortcutValue"),
  changeShortcut: document.getElementById("changeShortcut"),
};

// Grounding rules sent (inside "system") with every "ask" call. Sharon is a
// read-only voice assistant for whatever is visible on the current tab right
// now: she uses only the extracted page text, never invents anything, and can't
// click or open things herself (except scroll, when allowed). The page text is
// appended after these rules so it reaches the model through "system".
const GROUNDING =
  "You are Sharon, a read-only voice assistant. The only thing you can see is " +
  "the text currently visible on the user's active browser tab, given to you " +
  "below as the page content. Follow these rules strictly:\n" +
  "1. Use ONLY that page content. Do not use outside knowledge to fill gaps.\n" +
  "2. Talk only about what is actually in the page content. Never invent, " +
  "guess, or assume anything that isn't there.\n" +
  "3. You cannot click, open, or navigate to other pages, and you only ever " +
  "see the text currently extracted from the tab. You CAN scroll this page " +
  "when the user asks — they can say \"scroll down\", \"scroll up\", \"go to " +
  "the top/bottom\", or \"read more\" and the app scrolls and then gives you " +
  "the newly visible text to read. If the user asks about something that isn't " +
  "in the page content — for example what's inside an email while only a list " +
  "of messages is visible — say plainly what you can see and offer to scroll " +
  "for more or ask them to open it themselves, for example: \"I can see your " +
  "list of messages but not what's inside them. Open the one you want, or ask " +
  "me to scroll, and I'll read it.\"\n" +
  "4. If the answer isn't in the page content, say so plainly instead of " +
  "making something up. Honesty over helpfulness.";

// The default instruction Sharon sends when she starts reading on her own.
const DEFAULT_INSTRUCTION =
  "Here is the text currently visible on the active browser tab. First, give " +
  "me a one or two sentence overview of what's on screen. Then read the " +
  "important parts aloud in a natural, listenable way — skip navigation, ads, " +
  "boilerplate, and anything repetitive. If it's long, focus on the main " +
  "points rather than every word. Keep it conversational since I'm listening, " +
  "not reading.";

// When a page has almost nothing to read, ask for a short honest reply
// instead of letting the model invent content.
const SHORT_PAGE_CHARS = 200;
const SHORT_PAGE_INSTRUCTION =
  "There is very little readable text on this tab right now. In one or two " +
  "short, honest sentences, tell me what little is here. Do not invent, " +
  "expand, or pad with anything that isn't actually on the page.";

// After Sharon scrolls the page on the user's behalf, read the part that's now
// in view. Each request is sent without history, so we can't say "continue from
// where you left off" — instead we point her at the freshly-revealed part.
function scrollReadInstruction(direction) {
  if (direction === "up" || direction === "top") {
    return (
      "I've just scrolled back " +
      (direction === "top" ? "to the top of " : "up ") +
      "the page. Briefly and naturally read the content that's now visible " +
      "here. Skip menus, ads, and boilerplate."
    );
  }
  // down / bottom
  return (
    "I've just scrolled further down the page" +
    (direction === "bottom" ? " to the very bottom" : "") +
    ". Read the part that's now visible toward the lower portion of the page — " +
    "for a conversation or message thread, the newer messages now in view. " +
    "Read it naturally and conversationally. Focus on this newly revealed part " +
    "rather than re-summarizing the whole page from the top, and skip menus, " +
    "ads, and boilerplate. If there is genuinely nothing new beyond a heading " +
    "or whitespace, just say so in one short sentence."
  );
}

// Sent (inside "system") on every step when Sharon is allowed to act on the
// page. She is given the user's goal, the visible page text (as page content),
// and a numbered list of the interactive elements, and must reply with ONE JSON
// action plan. The whole loop runs inside the extension.
const AGENT_GROUNDING =
  "You are Sharon, a hands-free voice assistant that can BOTH read the user's " +
  "active browser tab AND act on it for them — clicking, typing, selecting, and " +
  "scrolling — to carry out what they ask.\n\n" +
  "Each step you are given: the user's goal, the page content (visible text), " +
  "a numbered list of the interactive elements on the page right now, and a log " +
  "of actions you've already taken this task. Decide the SINGLE next step and " +
  "reply with ONE JSON object inside a ```json code block, and nothing else:\n" +
  "```json\n" +
  "{\n" +
  '  "say": "what to tell the user — one short sentence when you are acting; ' +
  'the full answer or reading when there are no actions",\n' +
  '  "actions": [\n' +
  '    {"type": "click", "id": 3},\n' +
  '    {"type": "type", "id": 5, "text": "hello", "append": false},\n' +
  '    {"type": "clear", "id": 5},\n' +
  '    {"type": "select", "id": 8, "option": "Option label"},\n' +
  '    {"type": "key", "key": "Enter"},\n' +
  '    {"type": "scroll", "direction": "down"}\n' +
  "  ],\n" +
  '  "done": false\n' +
  "}\n" +
  "```\n" +
  "Rules:\n" +
  "1. Use ONLY element ids that appear in the provided list. Never invent ids.\n" +
  "2. If the user only wants information or to have something read, set " +
  '"actions" to [] , put the answer/reading in "say", and set "done": true.\n' +
  "3. Take SMALL steps — usually one to three actions — then you'll get the " +
  'updated page to decide the next step. Set "done": false while more steps ' +
  "remain.\n" +
  '4. When the goal is achieved, set "done": true with a brief confirmation in ' +
  '"say".\n' +
  "5. NEVER type or submit passwords, payment card numbers, security codes, or " +
  "other secret credentials. If the goal needs those, stop and say so plainly " +
  '("done": true).\n' +
  "6. Talk only about what is actually on the page; never invent content. If " +
  "you can't find a suitable element, say so plainly and set \"done\": true.";

// A tab is restricted only when its URL starts with one of these. Any normal
// http:// or https:// website is ALWAYS readable.
const RESTRICTED_PREFIXES = [
  "chrome://",
  "edge://",
  "about:",
  "chrome-extension://",
  "devtools://",
];

/* ------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------ */
let sessionId = null;
let busy = false; // a proxy request is in flight
let thinking = false; // drive the "thinking" orb / status while a call runs
let restricted = true; // no readable page in view yet
let lastReadKey = null; // tabId::url we last started reading
let lastUserInstruction = null; // the most recent spoken instruction (if any)
let abortController = null; // cancels an in-flight "ask" request
let evalSeq = 0; // guards against out-of-order tab evaluations
let ready = false; // settings loaded — safe to auto-read

// Speech synthesis (reading aloud)
const synth = window.speechSynthesis;
let currentUtterance = null;
let currentSpokenText = ""; // what Sharon is reading right now (echo filter)
let speaking = false;
let paused = false;

// Speech recognition (listening)
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognizing = false;
let micMuted = false; // user toggled mute
let micBlocked = false; // browser denied mic access

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function uuid() {
  return (
    (crypto.randomUUID && crypto.randomUUID()) ||
    "id-" + Math.random().toString(36).slice(2) + Date.now()
  );
}

/* ------------------------------------------------------------------ *
 * Settings — persisted in chrome.storage.local so they survive reopening
 * ------------------------------------------------------------------ */
const SETTINGS_KEY = "sharon_settings";
const DEFAULT_SETTINGS = {
  autoRead: true, // read pages automatically on activation / tab change
  allowScroll: true, // may Sharon scroll the active tab when asked? (saved approval)
  readAloud: true, // speak answers out loud? (user can mute Sharon's voice)
  allowActions: false, // may Sharon click/type/act on the page? (opt-in, off by default)
  confirmActions: true, // ask for a spoken "yes" before each set of actions
};
let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const saved = stored && stored[SETTINGS_KEY];
    if (saved && typeof saved === "object") {
      settings = { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch (_) {
    // storage unavailable — keep the in-memory defaults
  }
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch (_) {
    /* ignore — the setting still applies for this session */
  }
}

/* ------------------------------------------------------------------ *
 * Status + state — single source of truth for the hero + accent.
 * Drives data-state (idle | listening | thinking) on <html>, plus the
 * status line and subtitle.
 * ------------------------------------------------------------------ */
function setStatusText(line, sub) {
  if (els.statusLine) els.statusLine.textContent = line;
  if (els.statusSub) els.statusSub.textContent = sub || "";
}

function updateStatus() {
  els.html.setAttribute("data-mic", micMuted || micBlocked ? "muted" : "live");
  els.html.setAttribute("data-voice", settings.readAloud ? "on" : "off");

  let state, line, sub;
  if (thinking) {
    state = "thinking";
    line = "Thinking…";
    sub = "Reading the page and your request";
  } else if (restricted) {
    state = "idle";
    line = "Open a website";
    sub = "and I'll start reading";
  } else if (paused) {
    state = "idle";
    line = "Paused";
    sub = "Say “resume” to continue";
  } else if (speaking) {
    state = "idle";
    line = "Reading…";
    sub = "Say “stop” to stop me";
  } else if (micMuted || micBlocked) {
    state = "idle";
    line = "Muted";
    sub = "Tap the mic to turn me back on";
  } else if (!settings.autoRead) {
    state = "listening";
    line = "Ask me to read this page";
    sub = "I'm listening";
  } else {
    state = "listening";
    line = "Listening…";
    sub = "I'm ready when you are";
  }
  els.html.setAttribute("data-state", state);
  setStatusText(line, sub);
}

// Reflect the read-aloud (voice output) mute state on the dock Voice button.
function updateReadAloudUI() {
  const on = !!settings.readAloud;
  els.html.setAttribute("data-voice", on ? "on" : "off");
  if (els.voiceBtn) {
    els.voiceBtn.classList.toggle("on", on);
    els.voiceBtn.setAttribute(
      "aria-label",
      on ? "Sharon's voice: on" : "Sharon's voice: off"
    );
  }
}

/* ------------------------------------------------------------------ *
 * Session id — stable, random, reused for every request
 * ------------------------------------------------------------------ */
async function ensureSessionId() {
  if (sessionId) return sessionId;
  try {
    const { sharon_session_id } = await chrome.storage.local.get(
      "sharon_session_id"
    );
    if (sharon_session_id) {
      sessionId = sharon_session_id;
    } else {
      sessionId =
        (crypto.randomUUID && crypto.randomUUID()) ||
        "sess-" + Math.random().toString(36).slice(2) + Date.now();
      await chrome.storage.local.set({ sharon_session_id: sessionId });
    }
  } catch (e) {
    // storage unavailable for some reason — fall back to an in-memory id
    sessionId = "sess-" + Math.random().toString(36).slice(2) + Date.now();
  }
  return sessionId;
}

/* ------------------------------------------------------------------ *
 * The card stack — the redesigned conversation surface
 * ------------------------------------------------------------------ */
function scrollStackToBottom() {
  if (els.body) els.body.scrollTop = els.body.scrollHeight;
}

// Switch from the idle "capability list" to the live card stack.
function enterStack() {
  if (els.coach) els.coach.classList.add("hide");
  if (els.caps) els.caps.classList.add("hidden");
  if (els.stack) els.stack.classList.remove("hidden");
}

// If the stack has emptied (e.g. after Redo), bring the capability list back.
function maybeShowCaps() {
  if (els.stack && els.stack.children.length === 0) {
    els.stack.classList.add("hidden");
    if (els.caps) els.caps.classList.remove("hidden");
  }
}

function makeCard(extraClass) {
  const card = document.createElement("div");
  card.className = "card" + (extraClass ? " " + extraClass : "");
  return card;
}

function cardHead(eyebrowLabel) {
  const head = document.createElement("div");
  head.className = "card-head";
  const eyebrow = document.createElement("span");
  eyebrow.className = "card-eyebrow";
  const pin = document.createElement("span");
  pin.className = "pin";
  eyebrow.appendChild(pin);
  eyebrow.appendChild(document.createTextNode(eyebrowLabel));
  head.appendChild(eyebrow);
  return head;
}

// Split Sharon's reply into a short opening overview ("lead") and the body, so
// the gist can be shown at a glance above the rest.
function splitLead(text) {
  const t = (text || "").trim();
  if (!t) return { lead: "", body: "" };

  let idx = t.search(/\n\s*\n/);
  if (idx > 0 && idx < 400) {
    const body = t.slice(idx).trim();
    if (body) return { lead: t.slice(0, idx).trim(), body };
  }
  const m = t.match(/^([\s\S]+?[.!?])\s+([\s\S]+)$/);
  if (m && m[1].length <= 300 && m[2].trim()) {
    return { lead: m[1].trim(), body: m[2].trim() };
  }
  idx = t.indexOf("\n");
  if (idx > 0 && idx < 300) {
    const body = t.slice(idx).trim();
    if (body) return { lead: t.slice(0, idx).trim(), body };
  }
  return { lead: t, body: "" };
}

function splitSentences(text) {
  const out = (text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : [(text || "").trim()].filter(Boolean);
}

// "The gist" summary card — the opening sentence(s) as bullets.
function addGistCard(leadText) {
  enterStack();
  const card = makeCard();
  card.appendChild(cardHead("The gist"));
  const ul = document.createElement("ul");
  ul.className = "summary-list";
  for (const s of splitSentences(leadText).slice(0, 4)) {
    const li = document.createElement("li");
    li.textContent = s;
    ul.appendChild(li);
  }
  card.appendChild(ul);
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

// A plain spoken-answer card from Sharon.
function addSharonReplyCard(text) {
  enterStack();
  const card = makeCard("result-card");
  card.appendChild(cardHead("Sharon"));
  const p = document.createElement("p");
  p.className = "reply";
  p.textContent = text;
  card.appendChild(p);
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

// SVG icons used inside chips (static markup, no user data).
const ICON_CHECK =
  '<path d="M5 12l5 5L20 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_SEARCH =
  '<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m21 21-4.3-4.3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>';
const ICON_ACT =
  '<path d="m9 11 3 3 8-8" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 12a9 9 0 1 1-6.2-8.5" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>';

function chip(clsExtra, iconSvg, label) {
  const c = document.createElement("div");
  c.className = "action-chip" + (clsExtra ? " " + clsExtra : "");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.innerHTML = iconSvg;
  c.appendChild(svg);
  c.appendChild(document.createTextNode(label));
  return c;
}

// Green "Saved to your notes" card with a preview of the saved entry.
function addSavedCard(noteText, entryType) {
  enterStack();
  const card = makeCard("result-card");
  card.appendChild(cardHead("Sharon"));
  card.appendChild(
    chip("", ICON_CHECK, entryType === "task" ? "Saved as a task" : "Saved to your notes")
  );
  const prev = document.createElement("div");
  prev.className = "note-preview";
  const label = document.createElement("div");
  label.className = "np-label";
  label.textContent = entryType === "task" ? "Task saved" : "Note saved";
  const body = document.createElement("div");
  body.className = "np-body";
  body.textContent = noteText;
  prev.appendChild(label);
  prev.appendChild(body);
  card.appendChild(prev);
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

// Blue "Checked your notes — N found" card listing the hits.
function addFoundCard(summaryText, hits) {
  enterStack();
  const card = makeCard("result-card");
  card.appendChild(cardHead("Sharon"));
  const n = hits.length;
  card.appendChild(chip("info", ICON_SEARCH, "Checked your notes — " + n + " found"));
  const p = document.createElement("p");
  p.className = "reply";
  p.textContent = summaryText;
  card.appendChild(p);
  for (const h of hits) {
    const row = document.createElement("div");
    row.className = "found-row";
    const dot = document.createElement("span");
    dot.className = "found-dot";
    const main = document.createElement("div");
    main.className = "fr-main";
    const t = document.createElement("div");
    t.className = "fr-t";
    t.textContent = h.title || "(untitled note)";
    main.appendChild(t);
    const snippet = (h.content || "").trim();
    if (snippet) {
      const s = document.createElement("div");
      s.className = "fr-s";
      s.textContent = snippet.length > 110 ? snippet.slice(0, 110) + "…" : snippet;
      main.appendChild(s);
    }
    const d = document.createElement("span");
    d.className = "fr-d";
    d.textContent = relativeTime(h.created_at);
    row.appendChild(dot);
    row.appendChild(main);
    row.appendChild(d);
    card.appendChild(row);
  }
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

// Coral "Done on this page" card for completed on-page actions.
function addActionCard(text) {
  enterStack();
  const card = makeCard("result-card");
  card.appendChild(cardHead("Sharon"));
  card.appendChild(chip("page", ICON_ACT, "Done on this page"));
  const p = document.createElement("p");
  p.className = "reply";
  p.textContent = text;
  card.appendChild(p);
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

function addErrorCard(msg) {
  enterStack();
  const card = makeCard("result-card error-card");
  card.appendChild(cardHead("Sharon"));
  const p = document.createElement("p");
  p.className = "reply";
  p.textContent = "Sharon hit a snag: " + msg;
  card.appendChild(p);
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

// The "Working on it…" thinking card. Sets the thinking state; remove it and
// call updateStatus() (via clearThinking) when the call resolves.
function showThinkingCard(label) {
  enterStack();
  thinking = true;
  updateStatus();
  const card = makeCard("thinking-card");
  const row = document.createElement("div");
  row.className = "think-row";
  row.innerHTML =
    '<span class="td"></span><span class="td"></span><span class="td"></span>';
  const lbl = document.createElement("span");
  lbl.className = "think-label";
  lbl.textContent = label || "Working on it…";
  row.appendChild(lbl);
  card.appendChild(row);
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

function clearThinking(card) {
  if (card && card.remove) card.remove();
  thinking = false;
  updateStatus();
}

/* ------------------------------------------------------------------ *
 * The editable transcript card (the headline feature)
 * ------------------------------------------------------------------ */
const AUTO_SEND_MS = 1600;
let composeCard = null; // the current "You said" card element
let composeEl = null; // its contenteditable .transcript
let composeRaw = ""; // the original, un-edited ASR text (-> transcript_raw)
let composeConf = null; // ASR confidence for the current utterance
let composeEdited = false; // did the user touch the field? (cancels auto-send)
let autoSendTimer = null;

function cancelAutoSend() {
  if (autoSendTimer) {
    clearTimeout(autoSendTimer);
    autoSendTimer = null;
  }
}

function placeCaretEnd(el) {
  try {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  } catch (_) {
    /* ignore */
  }
}

function resetComposeState() {
  cancelAutoSend();
  composeCard = null;
  composeEl = null;
  composeRaw = "";
  composeConf = null;
  composeEdited = false;
}

// Build the editable "You said" card and wire its controls.
function ensureComposeCard() {
  enterStack();
  if (composeCard) return composeCard;
  const card = makeCard();
  card.innerHTML =
    '<div class="card-head">' +
    '<span class="card-eyebrow"><span class="pin"></span>You said</span>' +
    '<button class="edit-btn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>Edit</button>' +
    "</div>" +
    '<div class="transcript" contenteditable="true" role="textbox" aria-label="Your words — tap to edit" data-placeholder="Your words appear here…"></div>' +
    '<div class="edit-hint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>Tap the text to fix anything before sending</div>' +
    '<div class="send-row">' +
    '<button class="btn-send" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z"/></svg>Send to Sharon</button>' +
    '<button class="btn-ghost" type="button" aria-label="Start over">Redo</button>' +
    "</div>";
  els.stack.appendChild(card);
  composeCard = card;
  composeEl = card.querySelector(".transcript");

  card.querySelector(".edit-btn").addEventListener("click", () => {
    composeEdited = true;
    cancelAutoSend();
    composeEl.focus();
    placeCaretEnd(composeEl);
  });
  card.querySelector(".btn-send").addEventListener("click", () => commitCompose());
  card.querySelector(".btn-ghost").addEventListener("click", () => discardCompose());
  composeEl.addEventListener("input", () => {
    composeEdited = true;
    cancelAutoSend();
  });
  composeEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitCompose();
    }
  });
  scrollStackToBottom();
  return card;
}

// Show interim (ghost) words in the transcript field while the user speaks.
function showComposeInterim(interimText) {
  ensureComposeCard();
  if (composeEdited) return; // never overwrite the user's edits with ghost text
  const committed = composeRaw ? composeRaw + " " : "";
  composeEl.innerHTML = "";
  if (committed) composeEl.appendChild(document.createTextNode(committed));
  const ghost = document.createElement("span");
  ghost.className = "interim";
  ghost.textContent = interimText;
  composeEl.appendChild(ghost);
  scrollStackToBottom();
}

function clearComposeInterim() {
  if (!composeEl) return;
  const ghost = composeEl.querySelector(".interim");
  if (ghost) ghost.remove();
}

// A final (non-command) utterance becomes transcript content. Appended so the
// user can dictate across several phrases; auto-send (re)starts unless edited.
function composeAppend(text, conf) {
  ensureComposeCard();
  composeRaw = composeRaw ? composeRaw + " " + text : text;
  if (conf != null && !Number.isNaN(conf)) composeConf = conf;
  if (!composeEdited) {
    composeEl.textContent = composeRaw;
  } else {
    composeEl.textContent = (composeEl.textContent + " " + text).trim();
  }
  setStatusText("Got it", "Edit anything, then send");
  startAutoSend();
  scrollStackToBottom();
}

function startAutoSend() {
  cancelAutoSend();
  if (composeEdited) return; // the user is editing — they'll tap Send
  autoSendTimer = setTimeout(() => {
    autoSendTimer = null;
    commitCompose();
  }, AUTO_SEND_MS);
}

// Lock the current "You said" card so it stays visible as a record, then route.
function commitCompose() {
  cancelAutoSend();
  if (!composeCard) return;
  const content = (composeEl.textContent || "").trim();
  if (!content) {
    composeEl.focus();
    return;
  }
  const raw = composeRaw || content;
  const conf = composeConf;

  // Lock the card: drop the editing affordances, leave it as a "You said" note.
  composeEl.setAttribute("contenteditable", "false");
  composeEl.style.cursor = "default";
  const editBtn = composeCard.querySelector(".card-head .edit-btn");
  if (editBtn) editBtn.remove();
  const hint = composeCard.querySelector(".edit-hint");
  if (hint) hint.remove();
  const row = composeCard.querySelector(".send-row");
  if (row) row.remove();

  resetComposeState();
  routeUtterance(content, raw, conf);
}

function discardCompose() {
  cancelAutoSend();
  if (composeCard) composeCard.remove();
  resetComposeState();
  maybeShowCaps();
  updateStatus();
}

/* ------------------------------------------------------------------ *
 * Active tab + page text extraction (unchanged engine)
 * ------------------------------------------------------------------ */
async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab || null;
  } catch (_) {
    return null;
  }
}

async function getActiveTabReady() {
  let tab = await getActiveTab();
  for (let i = 0; i < 6 && (!tab || !tab.url); i++) {
    await delay(180);
    tab = await getActiveTab();
  }
  return tab;
}

function isRestricted(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  if (RESTRICTED_PREFIXES.some((p) => lower.startsWith(p))) return true;
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return true;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  if (host === "chromewebstore.google.com") return true;
  if (host === "chrome.google.com" && path.startsWith("/webstore")) return true;
  if (host === "microsoftedge.microsoft.com" && path.startsWith("/addons"))
    return true;
  return false;
}

function pageDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

// Injected into the page. Must be self-contained (no closures over outer scope).
function extractPageText() {
  function collapse(s) {
    return s
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n[ \t]*\n[ \t]*(\n[ \t]*)+/g, "\n\n")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .trim();
  }

  const EXCLUDE_TAGS = {
    NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1,
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1,
    SVG: 1, CANVAS: 1, FORM: 1, BUTTON: 1, INPUT: 1,
    SELECT: 1, TEXTAREA: 1, LABEL: 1, IFRAME: 1,
  };
  const BLOCK_TAGS = {
    P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, LI: 1, UL: 1, OL: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BLOCKQUOTE: 1, PRE: 1,
    TABLE: 1, TR: 1, FIGURE: 1, FIGCAPTION: 1, DD: 1, DT: 1, DL: 1, HR: 1,
  };
  const BOILERPLATE =
    /(^|[-_ ])(ads?|advert|advertisement|advertising|doubleclick|dfp|cookie|consent|gdpr|newsletter|subscribe|signup|sign-up|paywall|sponsored|promo|promotion|banner|related|recirc|recommended|recommendation|comments?|disqus|livefyre|share|sharing|social|breadcrumb|breadcrumbs|pagination|sidebar|popup|modal|overlay|cta|read-more|more-stories|trending|outbrain|taboola|navbar|navigation|menu|submenu|masthead|footer|topbar|skip-link|skip-to|widget|toolbar)([-_ ]|$)/i;
  const SKIP_ROLES =
    /^(navigation|banner|complementary|contentinfo|search|menu|menubar|tablist|dialog|alertdialog|toolbar)$/i;

  function isHidden(el) {
    let style;
    try {
      style = window.getComputedStyle(el);
    } catch (_) {
      return false;
    }
    if (!style) return false;
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return true;
    if (parseFloat(style.opacity) === 0) return true;
    if (el.hidden) return true;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true")
      return true;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return true;
    return false;
  }

  function shouldSkip(el) {
    if (EXCLUDE_TAGS[el.tagName]) return true;
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    if (role && SKIP_ROLES.test(role)) return true;
    const id = el.id || "";
    const cls = (el.getAttribute && el.getAttribute("class")) || "";
    const aria = (el.getAttribute && el.getAttribute("aria-label")) || "";
    if (BOILERPLATE.test(id + " " + cls + " " + aria)) return true;
    if (isHidden(el)) return true;
    return false;
  }

  function gather(node) {
    let out = "";
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child.nodeType === 3) {
        out += child.nodeValue;
      } else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (tag === "BR") {
          out += "\n";
          continue;
        }
        if (shouldSkip(child)) continue;
        const inner = gather(child);
        if (BLOCK_TAGS[tag]) out += "\n" + inner + "\n";
        else out += inner;
      }
    }
    return out;
  }

  function metaContent(sel) {
    const m = document.querySelector(sel);
    const c = m && m.getAttribute && m.getAttribute("content");
    return c ? c.trim() : "";
  }

  function bestRegion(selectors) {
    let bestEl = null;
    let bestText = "";
    for (let s = 0; s < selectors.length; s++) {
      const nodes = document.querySelectorAll(selectors[s]);
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (isHidden(el)) continue;
        const t = collapse(gather(el));
        if (t.length > bestText.length) {
          bestEl = el;
          bestText = t;
        }
      }
    }
    return { el: bestEl, text: bestText };
  }

  function pickMain() {
    const focused = bestRegion([
      '[itemprop="articleBody"]',
      '[role="document"]',
      ".a3s",
      ".message-body",
      ".messageBody",
      ".email-body",
      ".mail-body",
    ]);
    if (focused.el && focused.text.length >= 200) return focused;

    const region = bestRegion([
      "article",
      '[role="article"]',
      "main",
      '[role="main"]',
    ]);
    if (region.el && region.text.length >= 80) return region;

    if (focused.el && focused.text.length >= 80) return focused;

    return { el: document.body, text: collapse(gather(document.body)) };
  }

  const picked = pickMain();
  const main = picked.el || document.body;

  const h1 =
    (main && main.querySelector && main.querySelector("h1")) ||
    document.querySelector("h1");
  const h1text = h1 ? (h1.innerText || h1.textContent || "").trim() : "";
  const title =
    h1text ||
    metaContent('meta[property="og:title"]') ||
    (document.title || "").trim();

  const sel = window.getSelection ? window.getSelection().toString().trim() : "";
  if (sel) {
    return { text: collapse(sel), title: title, url: location.href };
  }

  let text = picked.text || "";

  if (text.length < 200) {
    const bodyText = collapse((document.body && document.body.innerText) || "");
    if (bodyText.length > text.length * 1.5) text = bodyText;
  }

  return { text: text, title: title, url: location.href };
}

async function readPageContext() {
  const tab = await getActiveTab();
  if (!tab || !tab.id || isRestricted(tab.url)) {
    return { restricted: true };
  }
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageText,
    });
    const result = (injection && injection.result) || {};
    let text = result.text || "";
    if (text.length > MAX_PAGE_TEXT) text = text.slice(0, MAX_PAGE_TEXT);
    return {
      text,
      title: result.title || tab.title || "",
      url: result.url || tab.url || "",
    };
  } catch (e) {
    return { restricted: true };
  }
}

/* ------------------------------------------------------------------ *
 * Scrolling the active tab (unchanged engine)
 * ------------------------------------------------------------------ */
function scrollPage(opts) {
  var dir = (opts && opts.direction) || "down";

  function docScrollMax() {
    var de = document.documentElement;
    return Math.max((de ? de.scrollHeight : 0) - window.innerHeight, 0);
  }

  function findScroller() {
    var best = null;
    var bestAmt = 0;
    var all = document.querySelectorAll("div, main, section, ul, ol");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var style;
      try {
        style = window.getComputedStyle(el);
      } catch (_) {
        continue;
      }
      var oy = style.overflowY;
      if (oy !== "auto" && oy !== "scroll") continue;
      if (el.clientHeight < 120) continue;
      var amt = el.scrollHeight - el.clientHeight;
      if (amt <= 40) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (amt > bestAmt) {
        best = el;
        bestAmt = amt;
      }
    }
    return best;
  }

  var docMax = docScrollMax();
  var scroller = docMax > 40 ? null : findScroller();

  function curTop() {
    if (scroller) return scroller.scrollTop;
    return window.scrollY || document.documentElement.scrollTop || 0;
  }
  function maxTop() {
    if (scroller) return scroller.scrollHeight - scroller.clientHeight;
    return docMax;
  }
  function viewport() {
    return scroller ? scroller.clientHeight : window.innerHeight;
  }

  var max = maxTop();
  var before = curTop();
  var step = Math.max(Math.round(viewport() * 0.85), 200);

  var target = before;
  if (dir === "top") target = 0;
  else if (dir === "bottom") target = max;
  else if (dir === "up") target = before - step;
  else target = before + step;

  if (target < 0) target = 0;
  if (target > max) target = max;

  if (scroller) scroller.scrollTo({ top: target, behavior: "smooth" });
  else window.scrollTo({ top: target, behavior: "smooth" });

  return {
    hasScroll: max > 40,
    moved: Math.abs(target - before) > 2,
    atTop: target <= 1,
    atBottom: target >= max - 1,
  };
}

// Speak + show a short note from Sharon without going to the server.
function sharonSay(text) {
  const bubble = addSharonReplyCard(text);
  speakText(text);
  return bubble;
}

async function handleScroll(direction) {
  if (!settings.allowScroll) {
    sharonSay(
      "Scrolling is turned off right now. You can switch on “Let Sharon " +
        "scroll the page” in Settings and I'll be glad to scroll for you."
    );
    return;
  }

  const tab = await getActiveTab();
  if (!tab || !tab.id || isRestricted(tab.url)) {
    sharonSay(
      "There's nothing here I can scroll. Open a website and I'll be able to " +
        "scroll through it for you."
    );
    return;
  }

  stopSpeaking();

  let res = {};
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollPage,
      args: [{ direction }],
    });
    res = (injection && injection.result) || {};
  } catch (_) {
    sharonSay("I couldn't scroll this page just now. Try me again in a moment.");
    return;
  }

  if (!res.hasScroll) {
    sharonSay("This page doesn't scroll — it all fits on screen already.");
    return;
  }
  if (!res.moved) {
    if (direction === "up" || direction === "top") {
      sharonSay("We're already at the top of the page.");
    } else {
      sharonSay("That's the bottom — there's nothing more to scroll to.");
    }
    return;
  }

  await delay(600);
  await runAskLane(scrollReadInstruction(direction), {});
}

/* ------------------------------------------------------------------ *
 * Talking to the backend
 *
 * IMPORTANT: text/plain (no CORS preflight that Apps Script can't answer), the
 * new { api_key, action, payload } envelope, no extra headers. Read success
 * data from data.result.*, and show data.error on { ok:false }.
 * ------------------------------------------------------------------ */
// Has the user pasted real values into config.js? The extension ships with
// "<…>" placeholders; until they're replaced (with a real https /exec URL and
// a non-placeholder key) every fetch fails at the network layer with the
// cryptic "Failed to fetch", so we catch that here and explain what to do.
function configReady() {
  const url = (PROXY_URL || "").trim();
  const key = (API_KEY || "").trim();
  const isPlaceholder = (s) => !s || /^<.*>$/.test(s);
  if (isPlaceholder(url) || isPlaceholder(key)) return false;
  return /^https?:\/\//i.test(url);
}

async function callApi(action, payload, signal) {
  if (!configReady()) {
    throw new Error(
      "I'm not connected to your backend yet. Open config.js and paste your " +
        "Apps Script /exec URL into PROXY_URL and your key into API_KEY (it must " +
        "match the API_KEY Script Property), then reload Sharon at " +
        "chrome://extensions."
    );
  }
  const body = { api_key: API_KEY, action, payload };
  let res;
  try {
    res = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    // "Failed to fetch" when the URL is set but unreachable — most often a
    // wrong /exec URL, a web app not deployed for "Anyone", or no connection.
    throw new Error(
      "I couldn't reach the server. Check that PROXY_URL is your correct " +
        "Apps Script /exec URL and that the web app is deployed with " +
        "“Who has access: Anyone”."
    );
  }
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error(
      "Sharon got an unexpected reply from the server. Please try again."
    );
  }
  return data;
}

// Build the "ask" system string with the page text folded in (the action does
// NOT feed page.excerpt to the model, so the text must ride here in "system").
function askSystem(groundingText, pageText) {
  return (
    groundingText +
    "\n\nPage content (the only thing you can currently see):\n" +
    (pageText || "").slice(0, MAX_PAGE_TEXT)
  );
}

// LANE 3 transport — the default conversational "ask" action. It auto-logs both
// the user and assistant turns and folds in memory, so we NEVER pair it with an
// append_turn for the same exchange.
async function askConversation(userText, ctx, asrConf, signal) {
  const id = await ensureSessionId();
  const pageText = ctx.text || "";
  const payload = {
    session_id: id,
    user_text: userText,
    system: askSystem(GROUNDING, pageText),
    page: {
      url: ctx.url || "",
      title: ctx.title || "",
      excerpt: pageText.slice(0, MAX_PAGE_TEXT),
    },
    user_id: USER_ID,
    assistant_id: ASSISTANT_ID,
    asr_confidence: asrConf != null && !Number.isNaN(asrConf) ? asrConf : null,
  };
  return callApi("ask", payload, signal);
}

/* ------------------------------------------------------------------ *
 * Acting on the page — full assistant control (opt-in, unchanged loop)
 * ------------------------------------------------------------------ */
const MAX_AGENT_STEPS = 8;
let agentTask = null; // { goal, log, steps, acted } while a task runs
let pendingPlan = null; // an action plan awaiting the user's spoken "yes"

function collectInteractive(opts) {
  var MAX = (opts && opts.max) || 120;

  function visible(el) {
    var s;
    try {
      s = window.getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (!s || s.display === "none" || s.visibility === "hidden") return false;
    if (parseFloat(s.opacity) === 0) return false;
    if (el.disabled) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    if (r.bottom < -200 || r.top > (window.innerHeight || 0) + 3000) return false;
    return true;
  }

  function esc(id) {
    try {
      return window.CSS && CSS.escape ? CSS.escape(id) : id;
    } catch (e) {
      return id;
    }
  }

  function nameOf(el) {
    var n = (el.getAttribute && el.getAttribute("aria-label")) || "";
    if (!n && el.getAttribute) {
      var lb = el.getAttribute("aria-labelledby");
      if (lb) {
        n = lb
          .split(/\s+/)
          .map(function (id) {
            var e = document.getElementById(id);
            return e ? e.innerText || e.textContent || "" : "";
          })
          .join(" ");
      }
    }
    if (!n && el.id) {
      var lab = document.querySelector('label[for="' + esc(el.id) + '"]');
      if (lab) n = lab.innerText || lab.textContent || "";
    }
    if (!n && el.closest) {
      var pl = el.closest("label");
      if (pl) n = pl.innerText || pl.textContent || "";
    }
    if (!n && el.getAttribute) n = el.getAttribute("placeholder") || "";
    if (!n && el.getAttribute) n = el.getAttribute("title") || "";
    if (!n && el.getAttribute) n = el.getAttribute("alt") || "";
    if (!n && typeof el.value === "string") n = el.value;
    if (!n) n = el.innerText || el.textContent || "";
    return (n || "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  var sel =
    'a[href], button, input, textarea, select, [role="button"], [role="link"], ' +
    '[role="textbox"], [role="checkbox"], [role="radio"], [role="tab"], ' +
    '[role="menuitem"], [contenteditable=""], [contenteditable="true"]';
  var nodes = document.querySelectorAll(sel);
  var out = [];
  var idx = 0;

  for (var i = 0; i < nodes.length && out.length < MAX; i++) {
    var el = nodes[i];
    var tag = el.tagName;
    var inputType =
      tag === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : "";
    if (inputType === "hidden") continue;
    if (!visible(el)) continue;

    idx++;
    el.setAttribute("data-sharon-id", String(idx));

    var role = ((el.getAttribute && el.getAttribute("role")) || "").toLowerCase();
    var kind = "other";
    var value = "";
    if (tag === "A" || role === "link") kind = "link";
    else if (tag === "BUTTON" || role === "button" || role === "tab" || role === "menuitem")
      kind = "button";
    else if (tag === "TEXTAREA" || el.isContentEditable || role === "textbox")
      kind = "textbox";
    else if (tag === "SELECT") kind = "select";
    else if (tag === "INPUT") {
      if (inputType === "checkbox") {
        kind = "checkbox";
        value = el.checked ? "checked" : "unchecked";
      } else if (inputType === "radio") {
        kind = "radio";
        value = el.checked ? "selected" : "not selected";
      } else if (inputType === "submit" || inputType === "button") {
        kind = "button";
      } else if (inputType === "password") {
        kind = "password";
      } else {
        kind = "textbox";
      }
    }
    if (kind === "textbox" && !value) {
      var v = el.isContentEditable ? el.innerText || "" : el.value || "";
      value = v ? "has text" : "empty";
    }

    out.push({ id: idx, kind: kind, name: nameOf(el), value: value });
  }

  return { elements: out };
}

function doActions(opts) {
  var actions = (opts && opts.actions) || [];

  function byId(id) {
    return document.querySelector('[data-sharon-id="' + id + '"]');
  }
  function ev(type, init) {
    if (type.indexOf("key") === 0) return new KeyboardEvent(type, init);
    if (type === "click" || type.indexOf("mouse") === 0)
      return new MouseEvent(type, init);
    return new Event(type, init);
  }
  function fire(el, type, init) {
    el.dispatchEvent(ev(type, Object.assign({ bubbles: true, cancelable: true }, init || {})));
  }
  function setValue(el, val) {
    var proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, val);
    else el.value = val;
  }

  var results = [];
  for (var i = 0; i < actions.length; i++) {
    var a = actions[i] || {};
    var r = { type: a.type, ok: false };
    try {
      if (a.type === "scroll") {
        var amt = Math.round((window.innerHeight || 600) * 0.85);
        if (a.direction === "up") window.scrollBy({ top: -amt, behavior: "smooth" });
        else if (a.direction === "top") window.scrollTo({ top: 0, behavior: "smooth" });
        else if (a.direction === "bottom")
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
        else window.scrollBy({ top: amt, behavior: "smooth" });
        r.ok = true;
        results.push(r);
        continue;
      }
      if (a.type === "key") {
        var tgt = document.activeElement || document.body;
        var k = a.key || "Enter";
        fire(tgt, "keydown", { key: k });
        fire(tgt, "keypress", { key: k });
        fire(tgt, "keyup", { key: k });
        r.ok = true;
        results.push(r);
        continue;
      }

      var el = a.id != null ? byId(a.id) : null;
      if (!el) {
        r.error = "no element " + a.id;
        results.push(r);
        continue;
      }
      try {
        el.scrollIntoView({ block: "center" });
      } catch (e) {
        /* ignore */
      }

      if (a.type === "click") {
        fire(el, "mousedown");
        fire(el, "mouseup");
        if (typeof el.click === "function") el.click();
        else fire(el, "click");
        r.ok = true;
      } else if (a.type === "type") {
        var text = a.text || "";
        el.focus();
        if (el.isContentEditable) {
          if (!a.append) el.textContent = "";
          var ok = false;
          try {
            ok = document.execCommand && document.execCommand("insertText", false, text);
          } catch (e) {
            ok = false;
          }
          if (!ok && el.textContent.indexOf(text) < 0)
            el.textContent = (a.append ? el.textContent : "") + text;
          fire(el, "input");
          r.value = el.textContent;
        } else {
          setValue(el, (a.append ? el.value || "" : "") + text);
          fire(el, "input");
          fire(el, "change");
          r.value = el.value;
        }
        r.ok = true;
      } else if (a.type === "clear") {
        if (el.isContentEditable) el.textContent = "";
        else setValue(el, "");
        fire(el, "input");
        fire(el, "change");
        r.ok = true;
      } else if (a.type === "select") {
        var want = (a.option || a.text || "").toLowerCase();
        var done = false;
        if (el.options) {
          for (var j = 0; j < el.options.length; j++) {
            var o = el.options[j];
            var ot = (o.textContent || "").trim().toLowerCase();
            if (ot === want || (o.value || "").toLowerCase() === want) {
              el.selectedIndex = j;
              done = true;
              break;
            }
          }
          if (!done) {
            for (var m = 0; m < el.options.length; m++) {
              if ((el.options[m].textContent || "").toLowerCase().indexOf(want) >= 0) {
                el.selectedIndex = m;
                done = true;
                break;
              }
            }
          }
        }
        fire(el, "input");
        fire(el, "change");
        r.ok = done;
        if (!done) r.error = "no matching option";
      } else {
        r.error = "unknown action";
      }
    } catch (e) {
      r.error = String((e && e.message) || e);
    }
    results.push(r);
  }
  return { results: results };
}

function setActing(on, text) {
  if (on) {
    thinking = true;
    els.html.setAttribute("data-state", "thinking");
    setStatusText(text || "Working…", "On the page");
  } else {
    thinking = false;
    updateStatus();
  }
}

async function getActionTab() {
  const tab = await getActiveTab();
  if (!tab || !tab.id || isRestricted(tab.url)) return null;
  return tab;
}

async function extractElements(tab) {
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectInteractive,
      args: [{ max: 120 }],
    });
    return (inj && inj.result && inj.result.elements) || [];
  } catch (_) {
    return [];
  }
}

function elementsToText(list) {
  if (!list.length) return "(no interactive elements detected)";
  return list
    .map(
      (e) =>
        "[" +
        e.id +
        "] " +
        e.kind +
        (e.name ? ' "' + e.name + '"' : "") +
        (e.value ? " (" + e.value + ")" : "")
    )
    .join("\n");
}

// The agent grounding now lives in "system" (alongside the page text), so this
// returns only the goal / action log / element list, sent as user_text.
function buildAgentPrompt(goal, log, list) {
  let s = "User goal: " + goal + "\n\n";
  if (log.length) {
    s +=
      "Actions you have already taken this task:\n" +
      log.map((l, i) => i + 1 + ". " + l).join("\n") +
      "\n\n";
  }
  s += "Interactive elements on the page right now:\n" + elementsToText(list);
  return s;
}

async function askAgent(promptBody, ctx, signal) {
  const id = await ensureSessionId();
  const pageText = ctx.text || "";
  const payload = {
    session_id: id,
    user_text: promptBody,
    system: askSystem(AGENT_GROUNDING, pageText),
    page: {
      url: ctx.url || "",
      title: ctx.title || "",
      excerpt: pageText.slice(0, MAX_PAGE_TEXT),
    },
    user_id: USER_ID,
    assistant_id: ASSISTANT_ID,
    asr_confidence: null,
  };
  return callApi("ask", payload, signal);
}

function parseAgentReply(reply) {
  if (!reply) return null;
  let jsonStr = null;
  const fence = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonStr = fence[1];
  else {
    const a = reply.indexOf("{");
    const b = reply.lastIndexOf("}");
    if (a >= 0 && b > a) jsonStr = reply.slice(a, b + 1);
  }
  if (!jsonStr) return null;
  let o;
  try {
    o = JSON.parse(jsonStr);
  } catch (_) {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const actions = Array.isArray(o.actions) ? o.actions : [];
  return {
    say: (o.say || "").trim(),
    actions,
    done: o.done === true || actions.length === 0,
  };
}

function describePlan(actions, list) {
  const nameById = {};
  for (const e of list) nameById[e.id] = e.name;
  const parts = [];
  for (const a of actions) {
    const who = a.id != null && nameById[a.id] ? ' "' + nameById[a.id] + '"' : "";
    if (a.type === "click") parts.push("click" + who);
    else if (a.type === "type") parts.push("type into" + who);
    else if (a.type === "clear") parts.push("clear" + who);
    else if (a.type === "select") parts.push("choose " + (a.option || a.text || "") + who);
    else if (a.type === "key") parts.push("press " + (a.key || "Enter"));
    else if (a.type === "scroll") parts.push("scroll " + (a.direction || "down"));
  }
  return parts.join(", then ");
}

function startAgentTask(goal) {
  agentTask = { goal, log: [], steps: 0, acted: false };
  agentStep();
}

function cancelAgentTask() {
  agentTask = null;
  pendingPlan = null;
}

async function agentStep() {
  if (!agentTask) return;
  if (agentTask.steps >= MAX_AGENT_STEPS) {
    sharonSay(
      "I've taken several steps, so I'll pause here rather than run away with " +
        "it. Tell me how you'd like to continue."
    );
    cancelAgentTask();
    setActing(false);
    return;
  }

  const tab = await getActionTab();
  if (!tab) {
    sharonSay("There's nothing here I can act on. Open a website and I'll help.");
    cancelAgentTask();
    return;
  }

  const ctx = await readPageContext();
  if (ctx.restricted) {
    sharonSay("I can't act on this page.");
    cancelAgentTask();
    return;
  }

  setActing(true, "Looking at the page…");
  const list = await extractElements(tab);
  const promptBody = buildAgentPrompt(agentTask.goal, agentTask.log, list);

  const think = showThinkingCard("Looking at the page…");
  let data;
  try {
    data = await askAgent(promptBody, ctx);
  } catch (err) {
    clearThinking(think);
    addErrorCard((err && err.message) || "I couldn't reach the server.");
    cancelAgentTask();
    setActing(false);
    return;
  }
  clearThinking(think);

  if (!data || !data.ok) {
    addErrorCard((data && data.error) || "something went wrong.");
    cancelAgentTask();
    setActing(false);
    return;
  }

  const reply = data.result && data.result.reply;
  const plan = parseAgentReply(reply);
  if (!plan) {
    addSharonReplyCard(reply || "(no reply)");
    if (reply) speakText(reply);
    cancelAgentTask();
    setActing(false);
    return;
  }

  if (!plan.actions.length) {
    // Sharon answered / decided she's done. Show a coral "done on this page"
    // card if she actually acted during this task; otherwise a plain answer.
    if (plan.say) {
      if (agentTask.acted) addActionCard(plan.say);
      else addSharonReplyCard(plan.say);
      speakText(plan.say);
    }
    cancelAgentTask();
    setActing(false);
    return;
  }

  if (plan.say) {
    addSharonReplyCard(plan.say);
    speakText(plan.say);
  }

  if (settings.confirmActions) {
    pendingPlan = { actions: plan.actions };
    const desc = describePlan(plan.actions, list);
    setActing(true, "Waiting for your okay…");
    sharonSay(
      "I'm about to " +
        (desc || "act on the page") +
        '. Say "yes" to go ahead, or "no" to stop.'
    );
    return;
  }

  await runPlan(plan.actions);
}

async function runPlan(actions) {
  if (!agentTask) return;
  const tab = await getActionTab();
  if (!tab) {
    sharonSay("The page went away before I could act.");
    cancelAgentTask();
    setActing(false);
    return;
  }

  setActing(true, "Working…");
  let res = {};
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: doActions,
      args: [{ actions }],
    });
    res = (inj && inj.result) || {};
  } catch (e) {
    res = { results: [{ ok: false, error: String((e && e.message) || e) }] };
  }

  const results = res.results || [];
  results.forEach((r, i) => {
    const a = actions[i] || {};
    if (r.ok) agentTask.acted = true;
    agentTask.log.push(
      a.type +
        (a.id != null ? " #" + a.id : "") +
        (a.text ? ' "' + String(a.text).slice(0, 40) + '"' : "") +
        " → " +
        (r.ok ? "ok" : "failed" + (r.error ? " (" + r.error + ")" : ""))
    );
  });
  agentTask.steps++;

  await delay(800);
  agentStep();
}

/* ------------------------------------------------------------------ *
 * Tab card — keep it current
 * ------------------------------------------------------------------ */
function refreshTabCard(tab) {
  if (!els.tabTitle) return;
  if (!tab) {
    els.tabTitle.textContent = "No active tab";
    return;
  }
  if (isRestricted(tab.url)) {
    els.tabTitle.textContent = tab.title || "A browser page";
    return;
  }
  els.tabTitle.textContent = tab.title || "This page";
}

/* ------------------------------------------------------------------ *
 * LANE 3 — Read / answer (the default). Uses the "ask" action, which logs
 * both turns and folds in memory. Renders the gist + reply cards.
 * ------------------------------------------------------------------ */
async function runAskLane(
  instruction,
  { remember = false, defaultRead = false, asrConf = null } = {}
) {
  instruction = (instruction || "").trim();
  if (!instruction) return;

  if (abortController) {
    try {
      abortController.abort();
    } catch (_) {
      /* ignore */
    }
  }
  const ac = new AbortController();
  abortController = ac;
  busy = true;

  const ctx = await readPageContext();
  if (ac.signal.aborted) return;
  if (ctx.restricted) {
    restricted = true;
    busy = false;
    if (abortController === ac) abortController = null;
    updateStatus();
    return;
  }
  if (remember) lastUserInstruction = instruction;

  let prompt = instruction;
  if (defaultRead && (ctx.text || "").trim().length < SHORT_PAGE_CHARS) {
    prompt = SHORT_PAGE_INSTRUCTION;
  }

  const think = showThinkingCard("Reading the page…");
  try {
    const data = await askConversation(prompt, ctx, asrConf, ac.signal);
    if (ac.signal.aborted) {
      clearThinking(think);
      return;
    }
    clearThinking(think);

    if (data && data.ok && data.result) {
      const reply = data.result.reply || "(no reply)";
      const { lead, body } = splitLead(reply);
      if (lead && body) {
        addGistCard(lead);
        addSharonReplyCard(body);
      } else {
        addSharonReplyCard(reply);
      }
      if (reply) speakText(reply);
    } else {
      addErrorCard((data && data.error) || "something went wrong with that request.");
    }
  } catch (err) {
    clearThinking(think);
    if (err && err.name === "AbortError") return;
    addErrorCard(
      err && err.message
        ? err.message
        : "I couldn't reach the server. Check your connection and try again."
    );
  } finally {
    if (abortController === ac) {
      busy = false;
      abortController = null;
    }
    updateStatus();
  }
}

/* ------------------------------------------------------------------ *
 * Memory lanes — page fields shared by append_turn / distill_to_memory
 * ------------------------------------------------------------------ */
async function pageFields() {
  const ctx = await readPageContext();
  if (ctx.restricted) {
    return { page_url: "", page_title: "", page_domain: "", screen_excerpt: "" };
  }
  const text = ctx.text || "";
  return {
    page_url: ctx.url || "",
    page_title: ctx.title || "",
    page_domain: pageDomain(ctx.url || ""),
    screen_excerpt: text.slice(0, MAX_PAGE_TEXT),
  };
}

// Log a single turn to conversation_turns. Returns the server's turn_id (or null).
async function appendTurn({ role, content, transcriptRaw, asrConf, page }) {
  const id = await ensureSessionId();
  const payload = {
    session_id: id,
    role,
    content,
    client_msg_id: uuid(),
    user_id: USER_ID,
    assistant_id: ASSISTANT_ID,
    modality: "voice",
    transcript_raw: transcriptRaw || "",
    asr_confidence: asrConf != null && !Number.isNaN(asrConf) ? asrConf : null,
    language: "en-US",
    model: "",
    page_url: page.page_url,
    page_title: page.page_title,
    page_domain: page.page_domain,
    screen_excerpt: role === "assistant" ? "" : page.screen_excerpt,
  };
  const data = await callApi("append_turn", payload);
  if (data && data.ok && data.result) return data.result.turn_id || null;
  if (data && !data.ok) throw new Error(data.error || "couldn't log that turn.");
  return null;
}

/* ------------------------------------------------------------------ *
 * LANE 1 — Save (note / task / decision)
 * ------------------------------------------------------------------ */
function stripSaveCommand(s) {
  const out = (s || "")
    .replace(
      /^(?:please\s+|hey\s+|ok(?:ay)?\s+|sharon[,\s]+)*(?:make\s+a\s+(?:note|task|reminder|to-?do|to\s+do)|take\s+a\s+note|add\s+a\s+(?:note|task|reminder|to-?do|to\s+do)|note|remember|save\s+(?:this|that)|remind\s+me)\b[\s:,.\-]*(?:that|to|about|of|for)?\b[\s:,.\-]*/i,
      ""
    )
    .trim();
  return out || (s || "").trim();
}

async function saveLane(content, transcriptRaw, asrConf) {
  enterStack();
  const think = showThinkingCard("Saving your note…");
  const page = await pageFields();

  // 1) log the user's turn
  let userTurnId = null;
  try {
    userTurnId = await appendTurn({
      role: "user",
      content,
      transcriptRaw,
      asrConf,
      page,
    });
  } catch (e) {
    clearThinking(think);
    addErrorCard((e && e.message) || "I couldn't save that.");
    return;
  }

  // 2) distill it into memory_log
  const entryType =
    /\b(remind|reminder|to-?do|to\s+do|task)\b/i.test(content) ? "task" : "note";
  const cleaned = stripSaveCommand(content);
  const title = cleaned.slice(0, 80);
  try {
    const id = await ensureSessionId();
    const data = await callApi("distill_to_memory", {
      entry_type: entryType,
      title,
      content: cleaned,
      user_id: USER_ID,
      assistant_id: ASSISTANT_ID,
      session_id: id,
      source_turn_ids: userTurnId ? [userTurnId] : [],
      tags: [],
      importance: 3,
      page_url: page.page_url,
    });
    if (data && !data.ok) {
      clearThinking(think);
      addErrorCard(data.error || "I couldn't save that note.");
      return;
    }
  } catch (e) {
    clearThinking(think);
    addErrorCard((e && e.message) || "I couldn't save that note.");
    return;
  }

  clearThinking(think);

  // 3) local confirmation (no model call), spoken + logged as an assistant turn
  const confirm =
    entryType === "task"
      ? "Done — I saved that task: “" + title + "”."
      : "Done — I saved that note: “" + title + "”.";
  addSavedCard(cleaned, entryType);
  speakText(confirm);
  try {
    await appendTurn({
      role: "assistant",
      content: confirm,
      transcriptRaw: "",
      asrConf: null,
      page,
    });
  } catch (_) {
    /* the note is saved; logging the confirmation is best-effort */
  }
}

/* ------------------------------------------------------------------ *
 * LANE 2 — Recall (look something up)
 * ------------------------------------------------------------------ */
function stripRecallCommand(s) {
  const out = (s || "")
    .replace(
      /^(?:please\s+|hey\s+|ok(?:ay)?\s+|sharon[,\s]+)*(?:what\s+notes(?:\s+do\s+i\s+have)?|do\s+i\s+have\s+(?:any\s+)?notes|look\s+up|search\s+(?:my\s+)?(?:notes|memory)(?:\s+for)?|find\s+(?:my\s+)?notes|what\s+did\s+(?:we|i)\s+(?:say|decide)|remind\s+me\s+what|pull\s+up)\b[\s:,.\-]*(?:about|on|for|regarding|the|do\s+i\s+have)?\b[\s:,.\-]*/i,
      ""
    )
    .trim();
  return out || (s || "").trim();
}

function shortTopic(query) {
  const q = (query || "").trim();
  if (!q) return "that";
  return q.length > 60 ? q.slice(0, 60) + "…" : q;
}

async function recallLane(content, transcriptRaw, asrConf) {
  enterStack();

  // log the user's turn
  const page = await pageFields();
  try {
    await appendTurn({ role: "user", content, transcriptRaw, asrConf, page });
  } catch (e) {
    addErrorCard((e && e.message) || "I couldn't reach the server.");
    return;
  }

  const query = stripRecallCommand(content);
  const think = showThinkingCard("Checking your notes…");
  let hits = [];
  try {
    const data = await callApi("search_memory", {
      query,
      user_id: USER_ID,
      assistant_id: ASSISTANT_ID,
      limit: 5,
      touch: true,
    });
    if (data && data.ok) hits = Array.isArray(data.result) ? data.result : [];
    else if (data && !data.ok) {
      clearThinking(think);
      addErrorCard(data.error || "I couldn't search your notes.");
      return;
    }
  } catch (e) {
    clearThinking(think);
    addErrorCard((e && e.message) || "I couldn't search your notes.");
    return;
  }
  clearThinking(think);

  const n = hits.length;
  let summary;
  if (n === 0) {
    summary = "I couldn't find any notes about " + shortTopic(query) + ".";
  } else {
    const titles = hits
      .slice(0, 3)
      .map((h) => (h.title || (h.content || "").slice(0, 60) || "").trim())
      .filter(Boolean);
    summary =
      "Found " +
      n +
      (n === 1 ? " note" : " notes") +
      (query ? " about " + shortTopic(query) : "") +
      ": " +
      titles.join("; ") +
      ".";
  }
  addFoundCard(summary, hits);
  speakText(summary);

  try {
    await appendTurn({
      role: "assistant",
      content: summary,
      transcriptRaw: "",
      asrConf: null,
      page,
    });
  } catch (_) {
    /* best-effort logging */
  }
}

/* ------------------------------------------------------------------ *
 * Lane routing — classify a sent transcript and send it down a lane
 * ------------------------------------------------------------------ */
function classifyLane(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return "ask";
  // Recall first, so "remind me what …" beats the "remind me …" save trigger.
  if (
    /^(?:please\s+|hey\s+|ok(?:ay)?\s+|sharon[,\s]+)*(what\s+notes|do\s+i\s+have\s+(?:any\s+)?notes|look\s+up|search\s+(?:my\s+)?(?:notes|memory)|find\s+(?:my\s+)?notes|what\s+did\s+(?:we|i)\s+(?:say|decide)\s+about|remind\s+me\s+what|pull\s+up)\b/.test(
      t
    )
  ) {
    return "recall";
  }
  if (
    /^(?:please\s+|hey\s+|ok(?:ay)?\s+|sharon[,\s]+)*(make\s+a\s+(?:note|task|reminder|to-?do|to\s+do)|note\s+that|take\s+a\s+note|remember\b|save\s+(?:this|that)|add\s+a\s+(?:note|task|reminder|to-?do|to\s+do)|remind\s+me)\b/.test(
      t
    )
  ) {
    return "save";
  }
  return "ask";
}

function routeUtterance(content, raw, conf) {
  const lane = classifyLane(content);
  if (speaking) stopSpeaking();
  if (lane === "save") {
    saveLane(content, raw, conf);
    return;
  }
  if (lane === "recall") {
    recallLane(content, raw, conf);
    return;
  }
  // Default lane: read / answer — or run the on-page agent when enabled.
  if (settings.allowActions) {
    startAgentTask(content);
  } else {
    runAskLane(content, { remember: true, asrConf: conf });
  }
}

/* ------------------------------------------------------------------ *
 * Auto-read: whenever a readable tab becomes active, start reading it.
 * ------------------------------------------------------------------ */
async function evaluateActiveTab() {
  const seq = ++evalSeq;
  const tab = await getActiveTabReady();
  if (seq !== evalSeq) return;

  refreshTabCard(tab);

  if (!tab || isRestricted(tab.url)) {
    restricted = true;
    lastReadKey = null;
    stopSpeaking();
    updateStatus();
    return;
  }

  restricted = false;
  updateStatus();

  if (!ready) return;
  if (!settings.autoRead) return;

  const key = tab.id + "::" + tab.url;
  if (key === lastReadKey) return;
  lastReadKey = key;
  autoRead();
}

async function autoRead() {
  stopSpeaking();
  const custom = lastUserInstruction;
  // Auto-read goes through LANE 3 (ask) using the default reading instruction.
  await runAskLane(custom || DEFAULT_INSTRUCTION, { defaultRead: !custom });
}

/* ------------------------------------------------------------------ *
 * Speech synthesis (reading aloud) — unchanged engine
 * ------------------------------------------------------------------ */
function pickEnglishVoice() {
  if (!synth) return null;
  const voices = synth.getVoices() || [];
  if (!voices.length) return null;
  return (
    voices.find(
      (v) =>
        /^en[-_]US/i.test(v.lang) && /female|Samantha|Google US/i.test(v.name)
    ) ||
    voices.find((v) => /^en[-_]US/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    voices[0]
  );
}

function speakText(text) {
  if (!synth) return;
  if (!settings.readAloud) return;
  synth.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  const voice = pickEnglishVoice();
  if (voice) {
    utt.voice = voice;
    utt.lang = voice.lang;
  } else {
    utt.lang = "en-US";
  }
  utt.rate = 1;
  utt.pitch = 1;

  utt.onstart = () => {
    speaking = true;
    paused = false;
    updateStatus();
  };
  utt.onresume = () => {
    paused = false;
    updateStatus();
  };
  utt.onpause = () => {
    paused = true;
    updateStatus();
  };
  const finish = () => {
    speaking = false;
    paused = false;
    currentUtterance = null;
    currentSpokenText = "";
    updateStatus();
  };
  utt.onend = finish;
  utt.onerror = finish;

  currentUtterance = utt;
  currentSpokenText = text;
  speaking = true;
  paused = false;
  synth.speak(utt);
  updateStatus();
}

function stopSpeaking() {
  if (synth) synth.cancel();
  speaking = false;
  paused = false;
  currentUtterance = null;
  currentSpokenText = "";
}

function pauseSpeaking() {
  if (synth && synth.speaking && !synth.paused) {
    synth.pause();
    paused = true;
    updateStatus();
  }
}

function resumeSpeaking() {
  if (synth && synth.paused) {
    synth.resume();
    paused = false;
    updateStatus();
  }
}

if (synth) {
  synth.onvoiceschanged = () => pickEnglishVoice();
}

/* ------------------------------------------------------------------ *
 * Echo filter — ignore the mic transcribing Sharon's own voice
 * ------------------------------------------------------------------ */
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isEchoOfSpeech(phrase) {
  if (!speaking || !currentSpokenText) return false;
  const p = normalize(phrase);
  if (!p) return true;
  const full = normalize(currentSpokenText);
  if (!full) return false;
  if (full.includes(p)) return true;
  const words = p.split(" ");
  const matched = words.filter((w) => full.includes(w)).length;
  return matched / words.length >= 0.6;
}

/* ------------------------------------------------------------------ *
 * Acting on what the user said — immediate commands vs. transcript content
 * ------------------------------------------------------------------ */
function parseScrollIntent(cmd) {
  if (
    /\b(top of (the )?page|to the (very )?top|back to the top)\b/.test(cmd) ||
    cmd === "top"
  ) {
    return { direction: "top", explicit: true };
  }
  if (
    /\b(bottom of (the )?page|to the (very )?bottom|all the way down|scroll to the end)\b/.test(
      cmd
    ) ||
    cmd === "bottom"
  ) {
    return { direction: "bottom", explicit: true };
  }
  if (
    /\bscroll (back )?up\b/.test(cmd) ||
    /\b(go|move|page) up\b/.test(cmd) ||
    /\bup a (bit|little|touch)\b/.test(cmd) ||
    cmd === "up"
  ) {
    return { direction: "up", explicit: true };
  }
  if (
    /\bscroll( down| further| some| more| a (bit|little))?\b/.test(cmd) ||
    /\b(go|move|page) down\b/.test(cmd) ||
    /\bdown a (bit|little|touch)\b/.test(cmd) ||
    cmd === "down"
  ) {
    return { direction: "down", explicit: true };
  }
  if (
    /^(more|read more|show more|tell me more|read on|keep reading|continue reading|see more|what else|what else does it say|read the rest|the rest)$/.test(
      cmd
    ) ||
    /\b(more of (the|this) (thread|page|conversation|article|email|messages?)|rest of (the|this) (thread|page|conversation|article|email)|further down the (thread|page|conversation))\b/.test(
      cmd
    )
  ) {
    return { direction: "down", explicit: false };
  }
  return null;
}

// Try to consume the utterance as an instant, hands-free command. Returns true
// when handled (so it must NOT be routed through the transcript / Send).
function tryImmediateCommand(text, cmd) {
  if (cmd === "stop" || cmd === "stop reading" || cmd === "be quiet" || cmd === "quiet") {
    cancelAgentTask();
    stopSpeaking();
    setActing(false);
    updateStatus();
    return true;
  }
  if (cmd === "pause") {
    pauseSpeaking();
    return true;
  }
  if (
    cmd === "resume" ||
    cmd === "continue" ||
    cmd === "keep going" ||
    cmd === "go on"
  ) {
    if (paused) resumeSpeaking();
    else if (settings.allowScroll) handleScroll("down");
    else resumeSpeaking();
    return true;
  }
  const scrollIntent = parseScrollIntent(cmd);
  if (scrollIntent && (settings.allowScroll || scrollIntent.explicit)) {
    handleScroll(scrollIntent.direction);
    return true;
  }
  return false;
}

// Every final utterance flows through here.
function handleUserUtterance(text, conf) {
  text = (text || "").trim();
  if (!text) return;
  if (speaking && isEchoOfSpeech(text)) return;

  const cmd = text
    .toLowerCase()
    .replace(/[.!?,]+$/g, "")
    .trim();

  // An action plan waiting for the user's okay — yes / no answers it instantly.
  if (pendingPlan) {
    const yes = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|please do|confirm|go for it|sounds good)$/.test(
      cmd
    );
    const no = /^(no|nope|nah|stop|cancel|don'?t|do not|never ?mind|wait|hold on)$/.test(
      cmd
    );
    if (yes) {
      discardCompose();
      const actions = pendingPlan.actions;
      pendingPlan = null;
      runPlan(actions);
      return;
    }
    if (no) {
      discardCompose();
      cancelAgentTask();
      sharonSay("Okay, I'll leave it.");
      updateStatus();
      return;
    }
    // Neither yes nor no — treat as a brand-new request; drop the plan.
    cancelAgentTask();
  }

  // Immediate commands fire instantly and never go through the transcript.
  if (tryImmediateCommand(text, cmd)) {
    discardCompose();
    return;
  }

  // Everything else becomes editable transcript content with an auto-send.
  composeAppend(text, conf);
}

/* ------------------------------------------------------------------ *
 * Speech recognition (listening) — continuous while the mic is live
 * ------------------------------------------------------------------ */
function ensureRecognition() {
  if (recognition) return recognition;
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    recognizing = true;
  };

  rec.onresult = (event) => {
    let interim = "";
    let final = "";
    let finalConf = null;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const alt = event.results[i][0];
      if (event.results[i].isFinal) {
        final += alt.transcript;
        if (alt.confidence != null) finalConf = alt.confidence;
      } else {
        interim += alt.transcript;
      }
    }

    const show = interim.trim();
    if (show && !(speaking && isEchoOfSpeech(show))) {
      showComposeInterim(show);
    }

    if (final.trim()) {
      const text = final.trim();
      clearComposeInterim();
      handleUserUtterance(text, finalConf);
    }
  };

  rec.onerror = (event) => {
    recognizing = false;
    if (
      event.error === "not-allowed" ||
      event.error === "service-not-allowed"
    ) {
      micBlocked = true;
      micMuted = true;
      addErrorCard(
        "I couldn't access the microphone. Check the browser's mic permission, then tap the mic to try again. I'll keep reading pages in the meantime."
      );
      updateStatus();
    }
  };

  rec.onend = () => {
    recognizing = false;
    if (!micMuted && !micBlocked) {
      setTimeout(() => {
        if (!micMuted && !micBlocked) startRecognition();
      }, 250);
    }
  };

  recognition = rec;
  return rec;
}

function startRecognition() {
  if (micMuted || micBlocked) return;
  const rec = ensureRecognition();
  if (!rec || recognizing) return;
  try {
    rec.start();
    recognizing = true;
  } catch (_) {
    /* start() throws if already running; ignore. */
  }
}

function stopRecognition() {
  if (!recognition) return;
  try {
    recognition.stop();
  } catch (_) {
    /* ignore */
  }
  recognizing = false;
}

/* ------------------------------------------------------------------ *
 * The mic controls — orb hero + dock mic both start/stop listening
 * ------------------------------------------------------------------ */
function toggleMic() {
  if (!SpeechRecognition) {
    addErrorCard(
      "Voice input isn't available in this browser, but I'll still read pages aloud automatically."
    );
    return;
  }
  if (micBlocked) {
    micBlocked = false;
    micMuted = false;
    startRecognition();
    updateStatus();
    return;
  }
  // While Sharon is reading, a tap is a natural "stop" (barge-in) and keeps the
  // mic state as-is, rather than muting her ear.
  if (speaking) {
    stopSpeaking();
    updateStatus();
    return;
  }
  micMuted = !micMuted;
  if (micMuted) stopRecognition();
  else startRecognition();
  updateStatus();
}

if (els.orb) els.orb.addEventListener("click", toggleMic);
if (els.dockMic) els.dockMic.addEventListener("click", toggleMic);

/* ------------------------------------------------------------------ *
 * The Voice dock button — mute / unmute Sharon's spoken voice
 * ------------------------------------------------------------------ */
if (els.voiceBtn) {
  els.voiceBtn.addEventListener("click", () => {
    settings.readAloud = !settings.readAloud;
    saveSettings();
    if (!settings.readAloud) stopSpeaking();
    updateReadAloudUI();
    updateStatus();
  });
}

/* ------------------------------------------------------------------ *
 * Slide-up sheets (Settings / Notes)
 * ------------------------------------------------------------------ */
function openSheet(sheet) {
  if (sheet) sheet.classList.add("open");
}
function closeSheets() {
  document.querySelectorAll(".sheet").forEach((s) => s.classList.remove("open"));
}

if (els.settingsBtn)
  els.settingsBtn.addEventListener("click", () => {
    applySettingsToUI();
    refreshShortcut();
    openSheet(els.settingsSheet);
  });
if (els.notesBtn)
  els.notesBtn.addEventListener("click", () => {
    openSheet(els.notesSheet);
    loadNotes("", { limit: 20, touch: false });
  });
document
  .querySelectorAll("[data-close]")
  .forEach((b) => b.addEventListener("click", closeSheets));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const open = document.querySelector(".sheet.open");
    if (open) closeSheets();
  }
});

/* ------------------------------------------------------------------ *
 * Settings sheet — toggles map to the existing storage keys
 * ------------------------------------------------------------------ */
function applySettingsToUI() {
  if (els.autoReadToggle) els.autoReadToggle.checked = !!settings.autoRead;
  if (els.scrollToggle) els.scrollToggle.checked = !!settings.allowScroll;
  if (els.actionsToggle) els.actionsToggle.checked = !!settings.allowActions;
  if (els.confirmToggle) els.confirmToggle.checked = !!settings.confirmActions;
  updateReadAloudUI();
}

async function refreshShortcut() {
  let label = "Not set";
  try {
    if (chrome.commands && chrome.commands.getAll) {
      const cmds = await chrome.commands.getAll();
      const cmd = (cmds || []).find((c) => c.name === "activate-sharon");
      if (cmd && cmd.shortcut) label = cmd.shortcut;
    }
  } catch (_) {
    /* leave "Not set" */
  }
  if (els.shortcutValue) els.shortcutValue.textContent = label;
}

if (els.autoReadToggle) {
  els.autoReadToggle.addEventListener("change", () => {
    settings.autoRead = els.autoReadToggle.checked;
    saveSettings();
    if (settings.autoRead) {
      lastReadKey = null;
      evaluateActiveTab();
    } else {
      updateStatus();
    }
  });
}

if (els.scrollToggle) {
  els.scrollToggle.addEventListener("change", () => {
    settings.allowScroll = els.scrollToggle.checked;
    saveSettings();
  });
}

if (els.actionsToggle) {
  els.actionsToggle.addEventListener("change", () => {
    settings.allowActions = els.actionsToggle.checked;
    saveSettings();
    if (!settings.allowActions) cancelAgentTask();
    updateStatus();
  });
}

if (els.confirmToggle) {
  els.confirmToggle.addEventListener("change", () => {
    settings.confirmActions = els.confirmToggle.checked;
    saveSettings();
  });
}

if (els.changeShortcut) {
  els.changeShortcut.addEventListener("click", () => {
    try {
      chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    } catch (_) {
      /* fail quietly */
    }
  });
}

/* ------------------------------------------------------------------ *
 * Notes sheet — real memory, backed by search_memory
 * ------------------------------------------------------------------ */
function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso);
  const ms = then.getTime();
  if (Number.isNaN(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return day + "d ago";
  try {
    return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch (_) {
    return day + "d ago";
  }
}

function renderNotes(hits) {
  els.notesList.innerHTML = "";
  if (!hits.length) {
    const empty = document.createElement("div");
    empty.className = "notes-empty";
    empty.textContent = "No notes yet — say “make a note…” and I'll save one.";
    els.notesList.appendChild(empty);
    return;
  }
  for (const h of hits) {
    const item = document.createElement("div");
    item.className = "note-item";
    const title = (h.title || "").trim();
    const content = (h.content || "").trim();
    if (title) {
      const t = document.createElement("div");
      t.className = "ni-title";
      t.textContent = title;
      item.appendChild(t);
    }
    if (content) {
      const b = document.createElement("div");
      b.className = "ni-body";
      b.textContent = content;
      item.appendChild(b);
    }
    const meta = document.createElement("div");
    meta.className = "ni-meta";
    const src = document.createElement("span");
    src.className = "src";
    src.textContent = h.entry_type || "note";
    meta.appendChild(src);
    const when = relativeTime(h.created_at);
    if (when) {
      meta.appendChild(document.createTextNode("·"));
      const t = document.createElement("span");
      t.textContent = when;
      meta.appendChild(t);
    }
    item.appendChild(meta);
    els.notesList.appendChild(item);
  }
}

let notesReqSeq = 0;
async function loadNotes(query, { limit = 20, touch = false } = {}) {
  if (!els.notesList) return;
  const seq = ++notesReqSeq;
  els.notesList.innerHTML =
    '<div class="notes-loading">Looking through your notes…</div>';
  try {
    const data = await callApi("search_memory", {
      query: query || "",
      user_id: USER_ID,
      assistant_id: ASSISTANT_ID,
      limit,
      touch,
    });
    if (seq !== notesReqSeq) return; // a newer search superseded this one
    if (data && data.ok) {
      renderNotes(Array.isArray(data.result) ? data.result : []);
    } else {
      els.notesList.innerHTML = "";
      const err = document.createElement("div");
      err.className = "notes-empty";
      err.textContent =
        "I couldn't load your notes: " + ((data && data.error) || "unknown error");
      els.notesList.appendChild(err);
    }
  } catch (e) {
    if (seq !== notesReqSeq) return;
    els.notesList.innerHTML = "";
    const err = document.createElement("div");
    err.className = "notes-empty";
    err.textContent =
      "I couldn't load your notes — check your connection and try again.";
    els.notesList.appendChild(err);
  }
}

let notesSearchTimer = null;
if (els.noteSearchInput) {
  els.noteSearchInput.addEventListener("input", () => {
    const q = els.noteSearchInput.value.trim();
    if (notesSearchTimer) clearTimeout(notesSearchTimer);
    notesSearchTimer = setTimeout(() => {
      loadNotes(q, { limit: 20, touch: false });
    }, 320);
  });
}

/* ------------------------------------------------------------------ *
 * Activation from the keyboard shortcut — wake the mic if already open
 * ------------------------------------------------------------------ */
if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "sharon-activate") {
      micMuted = false;
      micBlocked = false;
      startRecognition();
      updateStatus();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Follow the user as they switch tabs / pages
 * ------------------------------------------------------------------ */
if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(() => evaluateActiveTab());
}
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
    if (info.status === "complete" && tab && tab.active) evaluateActiveTab();
  });
}

// Hide the coachmark after a short while if the user hasn't interacted.
setTimeout(() => {
  if (els.coach) els.coach.classList.add("hide");
}, 6000);

/* ------------------------------------------------------------------ *
 * Boot — the panel is activated: mic goes LIVE and reading starts.
 * ------------------------------------------------------------------ */
(async function init() {
  micMuted = false;
  micBlocked = false;
  await ensureSessionId();
  await loadSettings();
  ready = true;
  applySettingsToUI();
  updateReadAloudUI();
  updateStatus();
  startRecognition();
  evaluateActiveTab();
})();
