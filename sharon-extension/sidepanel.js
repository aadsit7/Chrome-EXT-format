// sidepanel.js — Sharon's orchestrator. Wires the ears/voice (speech.js), the
// page engines (page.js), the backend brain (api.js), and the UI (ui.js) into
// one conversation loop:
//
//   listen → live transcript streams into the presence card → (instant
//   command? do it locally) → adaptive silence countdown (tap to edit) →
//   assist() one round trip: Claude answers AND/OR reads-writes the Google
//   Sheet database through tools AND/OR returns an on-page action plan →
//   answer cards in the thread (+ spoken-aloud line) → undo toast → listen.
//
// What makes this fast and conversational:
//   • Real multi-turn memory: the last HISTORY_TURNS exchanges ride along
//     with every request (and are restored from the Sheet when reopened).
//   • One HTTP round trip per turn — saving notes, searching, summarizing,
//     and answering all happen inside a single assist() call.
//   • Page snapshots are cached briefly so back-to-back questions about the
//     same page don't pay the extraction cost twice.
//   • Sharon never interrupts you — your words accumulate until a genuine,
//     adaptive silence — and you can interrupt HER: confident speech cancels
//     her reply instantly, while speech.js's six echo-protection layers keep
//     her from ever reacting to her own voice.

import { HISTORY_TURNS } from "./config.js";
import * as api from "./api.js";
import * as page from "./page.js";
import * as speech from "./speech.js";
import * as ui from "./ui.js";

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */
const SETTINGS_KEY = "sharon_settings";
const DEFAULT_SETTINGS = {
  autoRead: true, // read pages automatically on tab change
  allowScroll: true, // may Sharon scroll the active tab when asked?
  readAloud: true, // speak answers out loud?
  allowActions: false, // may Sharon click/type/act on the page? (opt-in)
  confirmActions: true, // ask for a spoken "yes" before each set of actions
  voiceName: "",
  voiceRate: 0.95,
};
let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const saved = stored && stored[SETTINGS_KEY];
    if (saved && typeof saved === "object") settings = { ...DEFAULT_SETTINGS, ...saved };
  } catch (_) {
    /* keep defaults */
  }
}
async function saveSettings() {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch (_) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * First-run setup — mic → connect memory → say hello.
 * Lives in the welcome view once ever, then as status rows in Settings.
 * ------------------------------------------------------------------ */
const SETUP_KEY = "sharon_setup";
let setup = { mic: false, memory: false, hello: false };

function setupComplete() {
  return setup.mic && setup.memory && setup.hello;
}
async function loadSetup() {
  try {
    const stored = await chrome.storage.local.get(SETUP_KEY);
    const saved = stored && stored[SETUP_KEY];
    if (saved && typeof saved === "object") setup = { ...setup, ...saved };
  } catch (_) {
    /* keep defaults */
  }
}
function markSetup(step) {
  if (setup[step]) return;
  setup[step] = true;
  try {
    chrome.storage.local.set({ [SETUP_KEY]: setup });
  } catch (_) {
    /* ignore */
  }
  refreshWelcomeSteps();
  refreshSetupRows();
  if (setupComplete() && ui.welcomeVisible()) ui.hideWelcome();
}

// Welcome step states: done steps get checks, the first open step is active.
function refreshWelcomeSteps() {
  const order = ["mic", "memory", "hello"];
  let activeGiven = false;
  for (const step of order) {
    if (setup[step]) {
      ui.setWelcomeStep(step, "done");
    } else if (!activeGiven) {
      activeGiven = true;
      ui.setWelcomeStep(step, "active");
    } else {
      ui.setWelcomeStep(step, "pending");
    }
  }
}

function refreshSetupRows() {
  ui.setSetupRow("mic", setup.mic, setup.mic ? "Allowed — Sharon can hear you" : "Not allowed yet");
  ui.setSetupRow(
    "memory",
    setup.memory,
    setup.memory ? "“Speaking Assistant” Sheet · connected" : "Not connected yet"
  );
  ui.setSetupRow("hello", setup.hello, setup.hello ? "Done — you two have met" : "You two haven't met yet");
}

// The mic step ticks only when permission is really granted (or when we
// actually hear the user — proof positive the mic works).
async function watchMicPermission() {
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    const check = () => {
      if (status.state === "granted") markSetup("mic");
      updateStatus();
    };
    status.addEventListener("change", check);
    check();
  } catch (_) {
    /* the "heard you" path still covers it */
  }
}

/* ------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------ */
let sessionId = null;
let busy = false; // a request is in flight
let restricted = true; // no readable page in view yet
let lastReadKey = null; // tabId::url we last auto-read
let evalSeq = 0;
let ready = false;
let skipFirstAutoRead = true; // panel opens LISTENING, never mid-monologue
let abortController = null;

// Conversation history — the panel's short-term memory.
let history = []; // [{role:"user"|"assistant", content}]
function remember(role, content) {
  const c = (content || "").trim();
  if (!c) return;
  history.push({ role, content: c.slice(0, 4000) });
  if (history.length > HISTORY_TURNS * 2) history = history.slice(-HISTORY_TURNS * 2);
}

// On-page agent task state.
const MAX_AGENT_STEPS = 8;
let agentTask = null; // { goal, log: [], steps }
let pendingPlan = null; // a plan awaiting the user's spoken "yes"

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function uuid() {
  return (
    (crypto.randomUUID && crypto.randomUUID()) ||
    "id-" + Math.random().toString(36).slice(2) + Date.now()
  );
}

async function ensureSessionId() {
  if (sessionId) return sessionId;
  try {
    const { sharon_session_id } = await chrome.storage.local.get("sharon_session_id");
    if (sharon_session_id) {
      sessionId = sharon_session_id;
    } else {
      sessionId = uuid();
      await chrome.storage.local.set({ sharon_session_id: sessionId });
    }
  } catch (_) {
    sessionId = "sess-" + Math.random().toString(36).slice(2) + Date.now();
  }
  return sessionId;
}

/* ------------------------------------------------------------------ *
 * Status line — single source of truth for the header
 * ------------------------------------------------------------------ */
let thinking = false;
let hearing = false; // interim speech is actively streaming

function updateStatus() {
  const micLive = !speech.isMicMuted() && !speech.isMicBlocked();
  ui.setMicIndicator(micLive);
  ui.setVoiceIndicator(!!settings.readAloud);

  if (thinking || busy) ui.setPhase("thinking");
  else if (speech.isSpeaking()) ui.setPhase("speaking");
  else if (hearing && micLive) ui.setPhase("hearing");
  else if (!micLive) ui.setPhase("muted");
  else ui.setPhase("listening");
}

// Speak + show a short local note from Sharon (no server round trip).
function sharonSay(text) {
  ui.addSharonBubble(text);
  speech.speak(text, { onDone: updateStatus });
}

// The redeploy walkthrough for a stale Apps Script deployment. Pasting new
// code into the editor is not enough — /exec serves the version pinned to
// the deployment, so backend/Code.gs changes only go live via "New version".
const REDEPLOY_STEPS =
  "Your PROXY_URL and API_KEY are fine — the deployment itself is just out of date. " +
  "Open your “Speaking Assistant” Sheet → Extensions → Apps Script, replace the project's code " +
  "with the latest backend/Code.gs from this folder, then choose Deploy → Manage deployments → " +
  "edit (✏️) → Version: “New version” → Deploy. The web-app URL stays the same, so nothing else changes.";

function nextStepFor(err) {
  if (err && err.backendOutdated) return REDEPLOY_STEPS;
  return (
    "Check your internet connection and try again. If it keeps happening, make sure PROXY_URL " +
    "and API_KEY in config.js still match your Apps Script deployment."
  );
}

// Every error says what happened AND what to do next. During first-run
// setup, problems surface as checklist guidance instead of thread noise.
function reportProblem(msg, nextStep) {
  if (!setupComplete() && ui.welcomeVisible()) {
    ui.setWelcomeStep("memory", "active", msg + " " + (nextStep || ""));
    return;
  }
  ui.addSharonBubble("I hit a snag: " + msg + (nextStep ? "\nWhat to do next: " + nextStep : ""));
}

/* ------------------------------------------------------------------ *
 * The capture pipeline — stream → adaptive silence → (edit) → send → undo
 * ------------------------------------------------------------------ */
// Adaptive end-of-speech: after your last words, the transcript is sent once
// the mic stays silent this long. Tune both windows here.
const SILENCE_COMPLETE_MS = 800; // what you said reads as a finished thought
const SILENCE_UNFINISHED_MS = 1400; // trailing "and…", "um…", a dangling clause
const HEARING_DECAY_MS = 1200;

// Trailing words that signal a thought still in flight (conjunctions,
// fillers, articles, possessives — kept conservative on purpose).
const UNFINISHED_TAIL = new Set([
  "and", "or", "but", "so", "because", "then", "also", "plus",
  "um", "uh", "er", "hmm", "like",
  "the", "a", "an", "my", "your", "his", "her", "their", "our", "its",
  "to", "if", "when", "while", "although", "though",
]);

function looksUnfinished(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (/[,\-–—:]$/.test(t)) return true; // a dangling clause
  const last = t.toLowerCase().replace(/[.!?]+$/g, "").split(/\s+/).pop();
  return UNFINISHED_TAIL.has(last);
}

let pendingText = ""; // committed finals awaiting send
let pendingConf = null;
let editing = false;
let hearingTimer = null;

function resetCapture() {
  pendingText = "";
  pendingConf = null;
  editing = false;
  hearing = false;
  if (hearingTimer) {
    clearTimeout(hearingTimer);
    hearingTimer = null;
  }
  ui.liveClear();
  ui.setCapture("idle");
  updateStatus();
}

function onInterimHeard(text) {
  markSetup("mic");
  hearing = true;
  if (hearingTimer) clearTimeout(hearingTimer);
  hearingTimer = setTimeout(() => {
    hearing = false;
    hearingTimer = null;
    // Words were heard but never finalized (interim that went quiet) — don't
    // let a captured message sit forever without its send countdown.
    if (pendingText && !editing && ui.els.html.getAttribute("data-capture") !== "counting") {
      startCountdown();
    }
    updateStatus();
  }, HEARING_DECAY_MS);
  if (editing) return; // the user took the keyboard — don't fight them
  ui.liveHideStrip();
  ui.setCapture("hearing");
  ui.liveTranscript(pendingText, text);
  updateStatus();
}

function startCountdown() {
  // Fast when the thought sounds complete, patient when it sounds unfinished.
  const wait = looksUnfinished(pendingText) ? SILENCE_UNFINISHED_MS : SILENCE_COMPLETE_MS;
  ui.setCapture("counting");
  ui.liveTranscript(pendingText, "");
  ui.liveShowStrip(wait, () => commitPending(true));
}

function openEditor() {
  editing = true;
  ui.setCapture("editing");
  ui.liveOpenEditor(pendingText);
  updateStatus();
}

function commitPending(auto) {
  const text = pendingText.trim();
  const conf = pendingConf;
  resetCapture();
  if (!text) return;
  const turnEl = ui.addUserTurn(text, { spoken: true });
  sendTurn(text, { raw: text, conf });
  if (auto) {
    ui.showUndoToast({
      label: "Sent what I heard",
      onUndo: () => undoTurn(turnEl, text),
    });
  }
}

// Undo cancels the pending answer and returns the text to the composer.
function undoTurn(turnEl, text) {
  if (abortController) {
    try {
      abortController.abort();
    } catch (_) {
      /* ignore */
    }
  }
  ui.removeCard(turnEl);
  if (ui.els.composerInput) {
    ui.els.composerInput.value = text;
    ui.setComposerHasText(true);
    ui.els.composerInput.focus();
  }
  updateStatus();
}

/* ------------------------------------------------------------------ *
 * Instant, hands-free commands — handled locally, zero latency
 * ------------------------------------------------------------------ */
function parseScrollIntent(cmd) {
  if (/\b(top of (the )?page|to the (very )?top|back to the top)\b/.test(cmd) || cmd === "top")
    return { direction: "top", explicit: true };
  if (
    /\b(bottom of (the )?page|to the (very )?bottom|all the way down|scroll to the end)\b/.test(cmd) ||
    cmd === "bottom"
  )
    return { direction: "bottom", explicit: true };
  if (
    /\bscroll (back )?up\b/.test(cmd) ||
    /\b(go|move|page) up\b/.test(cmd) ||
    /\bup a (bit|little|touch)\b/.test(cmd) ||
    cmd === "up"
  )
    return { direction: "up", explicit: true };
  if (
    /\bscroll( down| further| some| more| a (bit|little))?\b/.test(cmd) ||
    /\b(go|move|page) down\b/.test(cmd) ||
    /\bdown a (bit|little|touch)\b/.test(cmd) ||
    cmd === "down"
  )
    return { direction: "down", explicit: true };
  if (
    /^(more|read more|show more|tell me more|read on|keep reading|continue reading|see more|what else|what else does it say|read the rest|the rest)$/.test(
      cmd
    ) ||
    /\b(more of (the|this) (thread|page|conversation|article|email|messages?)|rest of (the|this) (thread|page|conversation|article|email)|further down the (thread|page|conversation))\b/.test(
      cmd
    )
  )
    return { direction: "down", explicit: false };
  return null;
}

async function handleScroll(direction) {
  if (!settings.allowScroll) {
    sharonSay(
      "Scrolling is turned off right now. You can switch on “Let Sharon scroll the page” in Settings and I'll be glad to scroll for you."
    );
    return;
  }
  speech.stopSpeaking();
  const res = await page.scrollActiveTab(direction);
  if (res.noTab) {
    sharonSay("There's nothing here I can scroll. Open a website and I'll be able to scroll through it for you.");
    return;
  }
  if (res.failed) {
    sharonSay("I couldn't scroll this page just now. Try me again in a moment.");
    return;
  }
  if (!res.hasScroll) {
    sharonSay("This page doesn't scroll — it all fits on screen already.");
    return;
  }
  if (!res.moved) {
    sharonSay(
      direction === "up" || direction === "top"
        ? "We're already at the top of the page."
        : "That's the bottom — there's nothing more to scroll to."
    );
    return;
  }
  await delay(600);
  const instruction =
    direction === "up" || direction === "top"
      ? "I've just scrolled back " +
        (direction === "top" ? "to the top of " : "up ") +
        "the page. Briefly and naturally read what's now visible. Skip menus, ads, and boilerplate."
      : "I've just scrolled further down the page" +
        (direction === "bottom" ? " to the very bottom" : "") +
        ". Read the newly revealed part naturally — don't re-summarize from the top. If there's genuinely nothing new, just say so in one short sentence.";
  await sendTurn(instruction, { showAsUser: false });
}

function tryImmediateCommand(text, cmd) {
  if (cmd === "stop" || cmd === "stop reading" || cmd === "be quiet" || cmd === "quiet") {
    cancelAgentTask();
    speech.stopSpeaking();
    thinking = false;
    updateStatus();
    return true;
  }
  if (cmd === "pause") {
    speech.pauseSpeaking();
    return true;
  }
  if (cmd === "resume" || cmd === "continue" || cmd === "keep going" || cmd === "go on") {
    if (speech.isPaused()) speech.resumeSpeaking();
    else if (settings.allowScroll) handleScroll("down");
    else speech.resumeSpeaking();
    return true;
  }
  const scrollIntent = parseScrollIntent(cmd);
  if (scrollIntent && (settings.allowScroll || scrollIntent.explicit)) {
    handleScroll(scrollIntent.direction);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Routing every final utterance
 * ------------------------------------------------------------------ */
function handleUserUtterance(text, conf, { typed = false } = {}) {
  text = (text || "").trim();
  if (!text) return;

  const cmd = text.toLowerCase().replace(/[.!?,]+$/g, "").trim();

  // An action plan waiting for the user's okay — yes / no answers it instantly.
  if (pendingPlan) {
    const yes = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|please do|confirm|go for it|sounds good)$/.test(cmd);
    const no = /^(no|nope|nah|stop|cancel|don'?t|do not|never ?mind|wait|hold on)$/.test(cmd);
    if (yes) {
      resetCapture();
      const plan = pendingPlan;
      pendingPlan = null;
      executePlan(plan);
      return;
    }
    if (no) {
      resetCapture();
      cancelAgentTask();
      sharonSay("Okay, I'll leave it.");
      updateStatus();
      return;
    }
    // Anything else = a brand-new request; drop the plan.
    cancelAgentTask();
  }

  // Instant commands fire immediately and never enter the transcript.
  if (tryImmediateCommand(text, cmd)) {
    if (!typed) resetCapture();
    return;
  }

  // Typed text was written deliberately — it sends straight away, through
  // the exact same pipeline as speech.
  if (typed) {
    ui.addUserTurn(text, { spoken: false });
    sendTurn(text, {});
    return;
  }

  // Spoken text: while the editor is open, new words join the draft.
  if (editing) {
    if (ui.els.lcEditArea) ui.els.lcEditArea.value = (ui.els.lcEditArea.value + " " + text).trim();
    return;
  }

  // Otherwise accumulate and (re)start the visible auto-send countdown.
  pendingText = pendingText ? pendingText + " " + text : text;
  // Overall confidence for the utterance = its weakest segment, so the
  // backend's asr_confidence flow keeps flagging shaky transcripts.
  if (conf != null && !Number.isNaN(conf))
    pendingConf = pendingConf == null ? conf : Math.min(pendingConf, conf);
  startCountdown();
  updateStatus();
}

/* ------------------------------------------------------------------ *
 * The main turn — one assist() round trip
 * ------------------------------------------------------------------ */
async function sendTurn(userText, { raw = "", conf = null, showAsUser = true } = {}) {
  userText = (userText || "").trim();
  if (!userText) return;

  if (speech.isSpeaking()) speech.stopSpeaking();
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
  thinking = true;
  updateStatus();

  const think = ui.addThinkingBubble();

  try {
    const id = await ensureSessionId();
    const ctx = await page.readPageContext();
    const pageRestricted = !!ctx.restricted;
    restricted = pageRestricted;

    // When Sharon may act, include what's clickable so the model can plan.
    let agent = null;
    if (settings.allowActions && !pageRestricted) {
      const elements = await page.extractElements();
      agent = {
        enabled: true,
        elements: page.elementsToText(elements),
        log: [],
        _elementList: elements, // local only, stripped before send
      };
    }

    const result = await api.assist(
      {
        sessionId: id,
        userText,
        history,
        page: pageRestricted
          ? {}
          : { url: ctx.url || "", title: ctx.title || "", excerpt: ctx.text || "" },
        agent: agent ? { enabled: true, elements: agent.elements, log: [] } : null,
        asrConfidence: conf,
        transcriptRaw: raw,
        clientMsgId: uuid(),
      },
      ac.signal
    );
    if (ac.signal.aborted) {
      ui.removeCard(think);
      return;
    }
    ui.removeCard(think);
    ui.dismissToast();

    markSetup("memory");
    if (showAsUser) markSetup("hello");

    if (showAsUser) remember("user", userText);
    else remember("user", userText.length > 200 ? userText.slice(0, 200) : userText);
    remember("assistant", result.reply || "");

    const webCard = renderEvents(userText, result.events || []);

    if (result.plan) {
      startAgentTask(userText, result.plan, agent ? agent._elementList : []);
      return;
    }

    renderAndSpeakReply(userText, result.reply, {
      pageCtx: pageRestricted ? null : ctx,
      question: showAsUser ? userText : "",
      webCard,
    });
  } catch (err) {
    ui.removeCard(think);
    if (err && err.name === "AbortError") return;
    reportProblem(err && err.message ? err.message : "I couldn't reach the server.", nextStepFor(err));
  } finally {
    if (abortController === ac) {
      busy = false;
      abortController = null;
    }
    // A just-started page task manages its own thinking state.
    if (!agentTask) thinking = false;
    updateStatus();
  }
}

/* --------- rendering Sharon's side of the turn --------- */
function isPageRecapIntent(text) {
  return /\b(sum(mar)?\w*\s+(up\s+)?(this|the)\s+(page|article|tab)|what'?s\s+(this|the)\s+(page|article)\s+about|recap\s+(this|the)\s+(page|article)|read\s+me\s+this\s+page|tl;?dr)\b/i.test(
    text || ""
  );
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function domainsIn(text) {
  const out = [];
  const re = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|gov|edu|co|dev|app|ai))\b/gi;
  let m;
  while ((m = re.exec(text || ""))) {
    const d = m[1].toLowerCase().replace(/^www\./, "");
    if (!out.includes(d)) out.push(d);
    if (out.length >= 3) break;
  }
  return out;
}

function splitSentences(text) {
  const out = (text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : [(text || "").trim()].filter(Boolean);
}

// Displayed layer: pick the card the reply deserves. Spoken layer: the quiet
// italic line under the card with what Sharon actually says aloud.
function renderAndSpeakReply(userText, reply, { pageCtx, question, webCard } = {}) {
  const text = (reply || "").trim();
  if (!text) return;

  let card = null;
  if (webCard) {
    // Web search already rendered the displayed layer (question → bullets →
    // clickable sources); Sharon's natural explanation attaches beneath it.
    card = webCard;
  } else if (pageCtx && isPageRecapIntent(userText)) {
    card = ui.addThisPageCard({
      domain: domainOf(pageCtx.url),
      question: question || "",
      title: pageCtx.title || "",
      bullets: splitSentences(text).slice(0, 5),
    });
  } else {
    const facts = ui.extractFacts(text);
    if (facts) {
      card = ui.addLookedUpCard({
        question: question || "",
        answer: facts.rest,
        tiles: facts.tiles,
        chips: domainsIn(text),
      });
    }
  }

  if (card) {
    // Two-layer rule: card = scannable; spoken line = what she says aloud.
    if (settings.readAloud) ui.attachSpokenLine(card, text);
  } else {
    ui.addSharonBubble(text);
  }
  speech.speak(text, { onDone: updateStatus });
}

// Turn the backend's tool events into thread cards. Returns the web results
// card when one was created, so the reply renderer can attach Sharon's
// spoken line to it instead of building a second card.
function renderEvents(userText, events) {
  let webCard = null;
  for (const e of events) {
    if (!e || !e.ok || !e.data) continue;
    const d = e.data;
    if (d.kind === "web_search") {
      webCard = ui.addWebSearchCard({
        question: d.question || userText,
        bullets: Array.isArray(d.bullets) ? d.bullets : [],
        sources: Array.isArray(d.sources) ? d.sources : [],
      });
    } else if (d.kind === "saved") {
      const isTask = d.entry_type === "task";
      const cap = ui.addQuietCapture({
        title: "Captured quietly — no reply needed",
        sub: "Filed under " + (isTask ? "tasks" : "notes") + " in your Sheet",
        onUndo: d.entry_id
          ? async () => {
              try {
                await api.updateMemory({ entryId: d.entry_id, deleted: true });
                cap.markRemoved();
                refreshMemoryCount();
              } catch (err) {
                reportProblem(
                  "I couldn't remove that from your Sheet.",
                  "Check your connection, then delete it from Sharon's memory (the book icon)."
                );
              }
            }
          : null,
      });
      refreshMemoryCount();
    } else if (d.kind === "found" && Array.isArray(d.hits) && d.hits.length) {
      const hits = d.hits;
      if (hits.every((h) => h.entry_type === "task")) {
        ui.addTasksCard({ hits, onToggle: toggleTaskFromCard });
      } else {
        ui.addNotesCard({
          question: userText,
          hits,
          onRowTap: () => {
            ui.openMemory();
            loadMemory(ui.els.memSearchInput ? ui.els.memSearchInput.value.trim() : "");
          },
        });
      }
    } else if (d.kind === "updated") {
      const p = d.patch || {};
      ui.addQuietCapture({
        title: p.deleted
          ? "Deleted from your Sheet"
          : p.status === "done"
          ? "Marked that task done"
          : "Updated in your Sheet",
        sub: "Synced with your Google Sheet",
      });
      refreshMemoryCount();
    }
    // "summarized" needs no card — the summary IS the spoken reply.
  }
  return webCard;
}

// Live checkboxes on the YOUR TASKS card — optimistic, then write back.
async function toggleTaskFromCard(h, row, check) {
  const wasDone = String(h.status) === "done";
  ui.setTaskRowDone(row, check, !wasDone);
  try {
    await api.updateMemory({ entryId: h.entry_id, status: wasDone ? "open" : "done" });
    h.status = wasDone ? "open" : "done";
    refreshMemoryCount();
  } catch (err) {
    ui.setTaskRowDone(row, check, wasDone);
    reportProblem("I couldn't update that task.", "Check your connection and tap the box again.");
  }
}

/* ------------------------------------------------------------------ *
 * The on-page acting agent — plan → (confirm) → do → look again → …
 * ------------------------------------------------------------------ */
function cancelAgentTask() {
  agentTask = null;
  pendingPlan = null;
}

function startAgentTask(goal, plan, elementList) {
  agentTask = { goal, log: [], steps: 0, acted: false };
  handlePlan(plan, elementList);
}

function handlePlan(plan, elementList) {
  if (!agentTask) return;

  if (plan.say) {
    ui.addSharonBubble(plan.say);
  }

  if (!plan.actions || !plan.actions.length) {
    // Nothing to do — she's answering / finishing.
    if (plan.say) {
      speech.speak(plan.say, { onDone: updateStatus });
    }
    cancelAgentTask();
    thinking = false;
    updateStatus();
    return;
  }

  if (settings.confirmActions) {
    pendingPlan = { ...plan, _elements: elementList || [] };
    updateStatus();
    const desc = page.describePlan(plan.actions, elementList || []);
    const ask =
      "I'm about to " + (desc || "act on the page") + '. Say "yes" to go ahead, or "no" to stop.';
    ui.addSharonBubble(ask);
    speech.speak(ask);
    return;
  }

  executePlan(plan);
}

async function executePlan(plan) {
  if (!agentTask) return;
  if (plan.say && !settings.confirmActions) speech.speak(plan.say);
  thinking = true;
  updateStatus();

  const res = await page.runActions(plan.actions);
  const results = (res && res.results) || [];
  results.forEach((r, i) => {
    const a = plan.actions[i] || {};
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

  if (plan.done) {
    const msg = plan.say || "Done.";
    ui.addSharonBubble(msg);
    cancelAgentTask();
    thinking = false;
    updateStatus();
    speech.speak(msg, { onDone: updateStatus });
    return;
  }

  if (agentTask.steps >= MAX_AGENT_STEPS) {
    cancelAgentTask();
    thinking = false;
    updateStatus();
    sharonSay(
      "I've taken several steps, so I'll pause here rather than run away with it. Tell me how you'd like to continue."
    );
    return;
  }

  // Look at the refreshed page and ask the brain for the next step.
  await delay(800);
  await agentStep();
}

async function agentStep() {
  if (!agentTask) return;
  const think = ui.addThinkingBubble();
  try {
    const id = await ensureSessionId();
    const ctx = await page.readPageContext({ fresh: true });
    if (ctx.restricted) {
      ui.removeCard(think);
      cancelAgentTask();
      thinking = false;
      updateStatus();
      sharonSay("The page went away before I could finish.");
      return;
    }
    const elements = await page.extractElements();
    const result = await api.assist({
      sessionId: id,
      userText: "Continue working toward the goal. Decide the next small step, or finish.",
      history,
      page: { url: ctx.url || "", title: ctx.title || "", excerpt: ctx.text || "" },
      agent: {
        enabled: true,
        elements: page.elementsToText(elements),
        log: agentTask.log.slice(-20),
        goal: agentTask.goal,
      },
      logTurns: false, // synthetic continuation — keep the transcript clean
    });
    ui.removeCard(think);

    if (result.plan) {
      handlePlan(result.plan, elements);
    } else {
      // She answered in prose — treat it as the finish.
      const msg = result.reply || "Done.";
      ui.addSharonBubble(msg);
      remember("assistant", msg);
      cancelAgentTask();
      thinking = false;
      updateStatus();
      speech.speak(msg, { onDone: updateStatus });
    }
  } catch (err) {
    ui.removeCard(think);
    cancelAgentTask();
    thinking = false;
    updateStatus();
    reportProblem(
      (err && err.message) || "I couldn't reach the server.",
      err && err.backendOutdated ? REDEPLOY_STEPS : "Check your internet connection, then ask me to try the task again."
    );
  }
}

/* ------------------------------------------------------------------ *
 * Auto-read — follow the user across tabs (opt-in via Preferences)
 * ------------------------------------------------------------------ */
const READ_PAGE_TEXT = "Read me this page.";

async function evaluateActiveTab() {
  const seq = ++evalSeq;
  const tab = await page.getActiveTabReady();
  if (seq !== evalSeq) return;

  if (!tab) ui.setTabTitle("no active tab");
  else if (page.isRestricted(tab.url)) ui.setTabTitle(tab.title || "a browser page");
  else ui.setTabTitle(tab.title || "this page");

  if (!tab || page.isRestricted(tab.url)) {
    restricted = true;
    lastReadKey = null;
    speech.stopSpeaking();
    updateStatus();
    return;
  }

  restricted = false;
  page.invalidatePageCache();
  updateStatus();

  if (!ready) return;

  const key = tab.id + "::" + tab.url;
  if (skipFirstAutoRead) {
    // The very first evaluation after opening WAITS and LISTENS.
    skipFirstAutoRead = false;
    lastReadKey = key;
    return;
  }
  if (!settings.autoRead) return;
  if (key === lastReadKey) return;
  lastReadKey = key;

  speech.stopSpeaking();
  await sendTurn(READ_PAGE_TEXT, { showAsUser: false });
}

/* ------------------------------------------------------------------ *
 * Memory view — the Sheet, browsable and editable
 * ------------------------------------------------------------------ */
let memReqSeq = 0;

// Blue badge on the book icon = open-task count, refreshed quietly.
async function refreshMemoryCount() {
  try {
    const hits = await api.searchMemory({ query: "", limit: 25, touch: false });
    if (!Array.isArray(hits)) return;
    markSetup("memory");
    const openTasks = hits.filter((h) => h.entry_type === "task" && String(h.status) !== "done").length;
    ui.setMemBadge(openTasks);
  } catch (_) {
    /* leave the badge as it was */
  }
}

async function loadMemory(query) {
  const seq = ++memReqSeq;
  ui.memLoading();
  try {
    const hits = await api.searchMemory({ query: query || "", limit: 25, touch: false });
    if (seq !== memReqSeq) return;
    markSetup("memory");
    const list = Array.isArray(hits) ? hits : [];
    if (!(query || "").trim()) {
      ui.setMemorySubtitle(list.length, list.length >= 25);
      const openTasks = list.filter((h) => h.entry_type === "task" && String(h.status) !== "done").length;
      ui.setMemBadge(openTasks);
    }
    ui.memorySyncedNow();
    ui.renderMemory(list, {
      onToggleDone: async (h) => {
        try {
          await api.updateMemory({
            entryId: h.entry_id,
            status: String(h.status) === "done" ? "open" : "done",
          });
          loadMemory(ui.els.memSearchInput ? ui.els.memSearchInput.value.trim() : "");
        } catch (e) {
          ui.memError(
            "Couldn't update that: " + ((e && e.message) || e) + " — check your connection and tap it again."
          );
        }
      },
      onDelete: async (h) => {
        try {
          await api.updateMemory({ entryId: h.entry_id, deleted: true });
          loadMemory(ui.els.memSearchInput ? ui.els.memSearchInput.value.trim() : "");
          refreshMemoryCount();
        } catch (e) {
          ui.memError(
            "Couldn't delete that: " + ((e && e.message) || e) + " — check your connection and try again."
          );
        }
      },
    });
  } catch (e) {
    if (seq !== memReqSeq) return;
    ui.memError("I couldn't load your Sheet — check your connection, then try the search again.");
  }
}

/* ------------------------------------------------------------------ *
 * Wiring: mic, composer, live card, header, memory, settings, welcome
 * ------------------------------------------------------------------ */
function toggleMic() {
  if (!speech.speechRecognitionAvailable()) {
    reportProblem(
      "Voice input isn't available in this browser.",
      "Type to me in the box below instead — everything works the same way, and I'll still read pages aloud."
    );
    return;
  }
  if (speech.isMicBlocked()) {
    speech.retryMic();
    updateStatus();
    return;
  }
  // While Sharon is reading, a tap is a natural "stop" (barge-in).
  if (speech.isSpeaking()) {
    speech.stopSpeaking();
    updateStatus();
    return;
  }
  speech.setMicMuted(!speech.isMicMuted());
  updateStatus();
}

function sendTyped(text) {
  const e = ui.els;
  const t = (text != null ? text : e.composerInput ? e.composerInput.value : "").trim();
  if (!t) return;
  if (text == null && e.composerInput) e.composerInput.value = "";
  ui.setComposerHasText(false);
  handleUserUtterance(t, null, { typed: true });
}

// The welcome "Connect" step and the Settings "Connect" pill both just try
// the Sheet for real and report honestly.
async function tryConnectMemory(onStatus) {
  onStatus && onStatus("Linking “Speaking Assistant”…");
  try {
    await api.searchMemory({ query: "", limit: 1, touch: false });
    markSetup("memory");
    onStatus && onStatus("“Speaking Assistant” Sheet · connected");
  } catch (err) {
    onStatus &&
      onStatus(
        "Couldn't reach your Sheet — open config.js, check PROXY_URL and API_KEY match your Apps Script deployment, then reload me."
      );
  }
}

function applySettingsToUI() {
  const e = ui.els;
  if (e.autoReadToggle) e.autoReadToggle.checked = !!settings.autoRead;
  if (e.scrollToggle) e.scrollToggle.checked = !!settings.allowScroll;
  if (e.actionsToggle) e.actionsToggle.checked = !!settings.allowActions;
  if (e.confirmToggle) e.confirmToggle.checked = !!settings.confirmActions;
  populateVoiceSelect();
  if (e.voiceSelect) e.voiceSelect.value = settings.voiceName || "";
  if (e.voiceSpeed)
    e.voiceSpeed.value = settings.voiceRate <= 0.92 ? "slow" : settings.voiceRate >= 1.0 ? "brisk" : "normal";
  ui.setVoiceIndicator(!!settings.readAloud);
}

function populateVoiceSelect() {
  const sel = ui.els.voiceSelect;
  if (!sel) return;
  const current = settings.voiceName || "";
  const sorted = speech.englishVoicesSorted();
  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Auto (best available)";
  sel.appendChild(auto);
  let hasCurrent = !current;
  for (const v of sorted) {
    const o = document.createElement("option");
    o.value = v.name;
    o.textContent = speech.friendlyVoiceName(v);
    if (v.name === current) hasCurrent = true;
    sel.appendChild(o);
  }
  if (current && !hasCurrent) {
    const o = document.createElement("option");
    o.value = current;
    o.textContent = current + " (unavailable)";
    sel.appendChild(o);
  }
  sel.value = current;
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
  if (ui.els.shortcutValue) ui.els.shortcutValue.textContent = label;
}

function wireControls() {
  const e = ui.els;

  // Composer: pill input + blue send circle (only with text) + the one mic.
  if (e.micBtn) e.micBtn.addEventListener("click", toggleMic);
  if (e.sendBtn) e.sendBtn.addEventListener("click", () => sendTyped());
  if (e.composerInput) {
    e.composerInput.addEventListener("input", () => {
      ui.setComposerHasText(!!e.composerInput.value.trim());
    });
    e.composerInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        sendTyped();
      }
    });
  }

  // Live-presence card: mute pill, tap-to-edit strip, editor buttons.
  if (e.lcMute) e.lcMute.addEventListener("click", toggleMic);
  if (e.lcStrip) e.lcStrip.addEventListener("click", openEditor);
  if (e.lcSend)
    e.lcSend.addEventListener("click", () => {
      const text = ui.liveEditorValue().trim();
      const conf = pendingConf;
      resetCapture();
      if (!text) return;
      ui.addUserTurn(text, { spoken: true });
      sendTurn(text, { raw: text, conf });
    });
  if (e.lcDiscard) e.lcDiscard.addEventListener("click", () => resetCapture());
  if (e.lcEditArea)
    e.lcEditArea.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        e.lcSend.click();
      }
    });

  // Header: status line stops TTS while speaking; voice / memory / settings.
  if (e.statusLine)
    e.statusLine.addEventListener("click", () => {
      if (speech.isSpeaking()) {
        speech.stopSpeaking();
        updateStatus();
      }
    });
  if (e.voiceBtn)
    e.voiceBtn.addEventListener("click", () => {
      settings.readAloud = !settings.readAloud;
      saveSettings();
      if (!settings.readAloud) speech.stopSpeaking();
      ui.setVoiceIndicator(settings.readAloud);
      updateStatus();
    });
  if (e.memoryBtn)
    e.memoryBtn.addEventListener("click", () => {
      ui.openMemory();
      loadMemory(e.memSearchInput ? e.memSearchInput.value.trim() : "");
    });
  if (e.memBack) e.memBack.addEventListener("click", ui.closeMemory);
  if (e.settingsBtn)
    e.settingsBtn.addEventListener("click", () => {
      applySettingsToUI();
      refreshSetupRows();
      refreshShortcut();
      ui.openSettings();
    });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", ui.closeSettings));
  if (e.scrim) e.scrim.addEventListener("click", ui.closeSettings);
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (ui.settingsOpen()) ui.closeSettings();
    else if (ui.memoryOpen()) ui.closeMemory();
  });

  // Memory search (debounced, live filtering via the backend).
  let memSearchTimer = null;
  if (e.memSearchInput)
    e.memSearchInput.addEventListener("input", () => {
      const q = e.memSearchInput.value.trim();
      if (memSearchTimer) clearTimeout(memSearchTimer);
      memSearchTimer = setTimeout(() => loadMemory(q), 320);
    });

  // Preferences.
  if (e.autoReadToggle)
    e.autoReadToggle.addEventListener("change", () => {
      settings.autoRead = e.autoReadToggle.checked;
      saveSettings();
      if (settings.autoRead) {
        lastReadKey = null;
        evaluateActiveTab();
      } else updateStatus();
    });
  if (e.scrollToggle)
    e.scrollToggle.addEventListener("change", () => {
      settings.allowScroll = e.scrollToggle.checked;
      saveSettings();
    });
  if (e.actionsToggle)
    e.actionsToggle.addEventListener("change", () => {
      settings.allowActions = e.actionsToggle.checked;
      saveSettings();
      if (!settings.allowActions) cancelAgentTask();
      updateStatus();
    });
  if (e.confirmToggle)
    e.confirmToggle.addEventListener("change", () => {
      settings.confirmActions = e.confirmToggle.checked;
      saveSettings();
    });
  if (e.voiceSelect)
    e.voiceSelect.addEventListener("change", () => {
      settings.voiceName = e.voiceSelect.value || "";
      saveSettings();
    });
  if (e.voiceSpeed)
    e.voiceSpeed.addEventListener("change", () => {
      settings.voiceRate = { slow: 0.9, normal: 0.95, brisk: 1.05 }[e.voiceSpeed.value] || 0.95;
      saveSettings();
    });
  if (e.voicePreview) e.voicePreview.addEventListener("click", () => speech.previewVoice());
  if (e.changeShortcut)
    e.changeShortcut.addEventListener("click", () => {
      try {
        chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
      } catch (_) {
        /* fail quietly */
      }
    });

  // Setup rows in Settings + the welcome steps share the same real actions.
  if (e.suMicBtn)
    e.suMicBtn.addEventListener("click", () => {
      speech.retryMic();
      updateStatus();
    });
  if (e.suMemoryBtn)
    e.suMemoryBtn.addEventListener("click", () =>
      tryConnectMemory((s) => ui.setSetupRow("memory", setup.memory, s))
    );
  if (e.suHelloBtn)
    e.suHelloBtn.addEventListener("click", () => {
      ui.closeSettings();
      sendTyped("Hello!");
    });
  if (e.replaySetup)
    e.replaySetup.addEventListener("click", () => {
      ui.closeSettings();
      refreshWelcomeSteps();
      ui.showWelcome();
    });

  // Welcome steps.
  if (e.wAllowBtn)
    e.wAllowBtn.addEventListener("click", () => {
      ui.setWelcomeStep("mic", "doing", "Waiting for Chrome's permission prompt — choose Allow.");
      speech.retryMic();
      updateStatus();
    });
  if (e.wConnectBtn)
    e.wConnectBtn.addEventListener("click", () => {
      ui.setWelcomeStep("memory", "doing", "Linking “Speaking Assistant”…");
      tryConnectMemory((s) => {
        if (!setup.memory) ui.setWelcomeStep("memory", "active", s);
      });
    });
  if (e.wHelloBtn)
    e.wHelloBtn.addEventListener("click", () => {
      ui.hideWelcome();
      sendTyped("Hello!");
    });

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "sharon-activate") {
        speech.retryMic();
        updateStatus();
      }
    });
  }
  if (chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(() => evaluateActiveTab());
  }
  if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
      if (info.status === "complete" && tab && tab.active) evaluateActiveTab();
    });
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
(async function init() {
  await ensureSessionId();
  await loadSettings();
  await loadSetup();

  ui.initUI();

  speech.initSpeech({
    getSettings: () => settings,
    onFinal: (text, conf) => {
      markSetup("mic");
      hearing = false;
      if (hearingTimer) {
        clearTimeout(hearingTimer);
        hearingTimer = null;
      }
      handleUserUtterance(text, conf);
    },
    onInterim: onInterimHeard,
    onStateChange: () => updateStatus(),
    onMicBlocked: () => {
      if (ui.welcomeVisible()) {
        ui.setWelcomeStep(
          "mic",
          "active",
          "I couldn't use the microphone. Click the lock icon by Chrome's address bar, allow the microphone, then tap Allow again."
        );
      } else {
        reportProblem(
          "I couldn't access the microphone.",
          "Click the lock icon by Chrome's address bar, allow the microphone, then tap the mic button to try again. You can type to me in the meantime."
        );
      }
      updateStatus();
    },
    onRecognitionTrouble: () => {
      reportProblem(
        "my hearing keeps cutting out.",
        "Voice recognition needs the internet — check your connection. I'll keep retrying quietly, and you can type to me in the meantime."
      );
    },
    onVoicesChanged: () => populateVoiceSelect(),
  });

  wireControls();
  ready = true;
  applySettingsToUI();
  refreshSetupRows();

  // First run only: the welcome walkthrough. After that, setup lives in
  // Settings as three quiet status rows and never blocks the panel again.
  if (!setupComplete()) {
    refreshWelcomeSteps();
    ui.showWelcome();
  }

  updateStatus();
  // Listening from launch — the mic starts live the moment the panel opens.
  speech.startRecognition();
  watchMicPermission();

  evaluateActiveTab();
  refreshMemoryCount();

  // Restore the conversation thread from the Sheet so a reopened panel
  // remembers what you were talking about (best-effort, non-blocking).
  try {
    const turns = await api.getRecentTurns(sessionId, HISTORY_TURNS);
    markSetup("memory");
    if (Array.isArray(turns) && !history.length) {
      for (const t of turns) {
        if (t && (t.role === "user" || t.role === "assistant")) remember(t.role, t.content);
      }
    }
  } catch (_) {
    /* fine — she just starts fresh; setup shows what to check */
  }
})();
