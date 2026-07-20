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
import * as notes from "./notes.js";
import { MODES, initModes, enterMode, inMode } from "./mode.js";

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */
const SETTINGS_KEY = "sharon_settings";
const DEFAULT_SETTINGS = {
  autoRead: false, // read pages automatically on tab change (opt-in only)
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

// The mode-bar buttons (mic / record / screen) can kick off async work
// (opening the mic stream, reading the page) BEFORE the mode actually
// changes. Without a lock, a second tap — the same button again, or a
// different one — slips through that async gap and overlaps the first,
// which is exactly what made switching between them feel flaky. Every
// mode-button action runs through runModeAction(), so only one is ever in
// flight and taps never interleave.
let modeActionBusy = false;
async function runModeAction(fn) {
  if (modeActionBusy) return; // a transition is already settling — ignore the tap
  modeActionBusy = true;
  try {
    await fn();
  } catch (_) {
    // A thrown action must never wedge the lock; the mode manager already
    // lands in a clean LISTENING state on any enter/exit failure.
  } finally {
    modeActionBusy = false;
    updateStatus();
  }
}

// A quiet, non-spoken confirmation line — used to answer a tap that can't do
// what it normally would right now, so a button never feels dead.
function hint(label) {
  ui.showUndoToast({ label });
}

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

// Screen access is OPT-IN. The page excerpt rides along with a turn only
// when the user explicitly asked about the page, entered SCREEN mode (the
// screen icon in the mode bar), or agent mode (an explicit settings toggle)
// needs the page to act. Nothing about it is persisted across sessions.
let turnUsingPage = false; // true while a page-carrying turn is in flight

/* ------------------------------------------------------------------ *
 * Mode-owned state — the manager (mode.js) is the single source of truth
 * for WHICH mode Sharon is in; these hold what each mode carries with it.
 * ------------------------------------------------------------------ */
let screenCtx = null; // SCREEN: the one tab snapshot captured at entry
let stagedScreenCtx = null; // handoff from toggleScreenMode into the enter routine
let searchAc = null; // SEARCHING: the in-flight call the mode may cancel
let preparedRec = null; // RECORDING: MediaRecorder staged for the enter routine

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

// Deferred listening: when the panel boots into the Notes view, the mic
// stays MUTED — reading your notes is not talking to Sharon. The deferral
// ends, and listening starts, the first time the conversation view is
// actually on screen; an explicit tap on the mic button ends it early
// instead, in whichever direction the user chose (see toggleMic). Dictation
// is unaffected — it forces the engine on and restores the mute after.
let listenDeferred = false;

function undeferListening() {
  if (!listenDeferred) return;
  listenDeferred = false;
  speech.setMicMuted(false); // unmuting starts recognition
  updateStatus();
}

function updateStatus() {
  const micLive = !speech.isMicMuted() && !speech.isMicBlocked();
  ui.setMicIndicator(micLive);
  ui.setVoiceIndicator(!!settings.readAloud);

  // The header follows the mode manager first — the status text and the
  // mode bar must never disagree about what Sharon is doing.
  if (recActive()) ui.setPhase("recording");
  else if (screenRecActive())
    ui.setPhase(
      screenRecPhase === "trimming"
        ? "screen_trim"
        : screenRecPhase === "reviewing"
        ? "screen_review"
        : "screen_rec"
    );
  else if (inMode(MODES.SEARCHING)) ui.setPhase("searching");
  else if (thinking || busy) ui.setPhase("thinking");
  else if (inMode(MODES.SCREEN)) ui.setPhase("screen");
  else if (speech.isSpeaking()) ui.setPhase("speaking");
  else if (hearing && micLive) ui.setPhase("hearing");
  else if (!micLive) ui.setPhase("muted");
  else ui.setPhase("listening");

  updateTabPill();

  // Sharon's voice and a playing recording never overlap — every state
  // change re-checks the pair (see syncPlaybackWithSpeech).
  syncPlaybackWithSpeech();
}

// The tab pill only ever tells the truth: "Seeing this tab" when page
// context is riding along right now (a page-carrying turn in flight) or
// will ride along with the next message (SCREEN mode holding its snapshot,
// or agent mode on with a readable page, recorder idle); "Not reading this
// tab" otherwise.
function updateTabPill() {
  ui.setTabAwareness(
    turnUsingPage ||
      (inMode(MODES.SCREEN) && !!screenCtx) ||
      (!recActive() && !restricted && settings.allowActions)
  );
}

// Speak + show a short local note from Sharon (no server round trip).
// Remembered like any reply: if the user answers "yes" to something Sharon
// said locally, the model must see what it was — a missing last turn is
// exactly what makes it grasp at page context.
function sharonSay(text) {
  ui.addSharonBubble(text);
  remember("assistant", text);
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
  const text = "I hit a snag: " + msg + (nextStep ? "\nWhat to do next: " + nextStep : "");
  ui.addSharonBubble(text);
  remember("assistant", text);
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
  // Voice captured around a recording is DROPPED, never queued — the seal
  // in speech.js keeps new words out; this drops anything already pending.
  if (recActive() || !speech.recorderSealOpen()) {
    resetCapture();
    return;
  }
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
  // The user explicitly asked to move through the page — reading what the
  // scroll revealed is that same request, so the page rides along.
  await sendTurn(instruction, { showAsUser: false, withPage: true });
}

function tryImmediateCommand(text, cmd) {
  if (cmd === "stop" || cmd === "stop reading" || cmd === "be quiet" || cmd === "quiet") {
    cancelAgentTask();
    speech.stopSpeaking();
    // Interrupting a live web search cancels the in-flight call — the
    // turn's finally block then lands the mode back in LISTENING.
    if (inMode(MODES.SEARCHING) && abortController) {
      try {
        abortController.abort();
      } catch (_) {
        /* ignore */
      }
    }
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

  // The recorder seal, end to end: while the recorder is anything but idle
  // (or trailing recording audio is still in its grace window), voice can
  // never become a message. Screen recording drops spoken input the same way,
  // so Sharon stays quiet and never captures her own reply into the video.
  // speech.js already swallows recognition results; this guards every other
  // way in. Typed composer messages still work — they're deliberate keyboard
  // input, not leaked audio.
  if (!typed && (recActive() || screenRecActive() || !speech.recorderSealOpen())) {
    resetCapture();
    return;
  }

  // The user is addressing Sharon. If the Notes view is covering the thread
  // (it hides the presence card and composer too), close it back to the
  // conversation first — the same path as its back button, so an open edited
  // note still auto-saves — because a reply must never render invisibly.
  notes.closeNotesView();

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
async function sendTurn(userText, { raw = "", conf = null, showAsUser = true, withPage = null } = {}) {
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

  // The mode manager settles this turn's mode up front. A SCREEN turn grabs
  // the snapshot captured when the mode began, then SCREEN ends — one look,
  // one answered question. Search-intent phrasing lights SEARCHING until
  // the reply arrives. A typed message during RECORDING never touches the
  // mode: the recorder keeps the ears until its whole flow is done.
  const screenSnap = inMode(MODES.SCREEN) ? screenCtx : null;
  const screenTurn = !!(screenSnap && !screenSnap.restricted);
  const searchIntent = isSearchIntent(userText);
  // A turn never changes the mode while a recorder owns it: the voice recorder
  // keeps the ears until its flow is done, and the screen recorder keeps the
  // capture running until the user stops it. (A typed message during either
  // still works — it just doesn't disturb the recording.)
  if (!recActive() && !screenRecActive()) {
    enterMode(searchIntent ? MODES.SEARCHING : MODES.LISTENING);
    if (searchIntent) searchAc = ac;
  }

  busy = true;
  thinking = true;
  updateStatus();

  const think = ui.addThinkingBubble();

  try {
    const id = await ensureSessionId();

    // Screen access is opt-in: the page rides along ONLY when this turn is
    // an explicit page request (withPage — auto-read/scroll follow-ups — or
    // the words ask about the page), SCREEN mode is answering its one
    // question with the snapshot it captured, or agent mode (an explicit
    // settings toggle) needs the page to act. Never while the recorder is
    // anything but idle, whatever the toggles say.
    const includePage =
      !recActive() &&
      !screenRecActive() &&
      (withPage === true || screenTurn || settings.allowActions || isPageIntent(userText));

    let ctx = { restricted: true };
    let pageRestricted = true;
    if (includePage) {
      ctx = screenTurn ? screenSnap : await page.readPageContext();
      pageRestricted = !!ctx.restricted;
      restricted = pageRestricted;
    }
    turnUsingPage = includePage && !pageRestricted;
    updateTabPill();

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
      turnUsingPage = false; // the pill goes back to telling the steady truth
      // The search settled (reply, error, or abort) — null searchAc FIRST so
      // SEARCHING's exit routine doesn't try to cancel a finished call.
      if (searchAc === ac) searchAc = null;
      if (inMode(MODES.SEARCHING)) enterMode(MODES.LISTENING);
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

// The broader page-intent test behind opt-in screen access: does this
// message explicitly ask about the page/tab/screen? Only then (or via the
// "Use this tab" chip / agent mode) does the page excerpt ride along.
function isPageIntent(text) {
  const t = (text || "").toLowerCase();
  return (
    isPageRecapIntent(text) ||
    /\b(this|that|the|current|active|open)\s+(web\s*)?(page|tab|article|site|website|screen|post|email|thread|doc|document)\b/.test(t) ||
    /\b(on|about|reading)\s+(my|the)\s+screen\b/.test(t) ||
    /\bmy\s+(open\s+|current\s+)?tab\b/.test(t) ||
    /\bread\s+(this|it|that|me\s+this)\b/.test(t) ||
    /\bwhat\s+am\s+i\s+(looking\s+at|reading|seeing)\b/.test(t) ||
    /\b(look|looking)\s+at\s+(this|my\s+screen|the\s+screen)\b/.test(t)
  );
}

// SEARCHING is automatic, never tapped: this heuristic lights the globe the
// moment a search-shaped request goes out, and the backend's web_search
// event (the "From the web" card with sources) is the ground truth that a
// search really ran. Kept conservative — "search my notes" is memory work,
// not the web.
function isSearchIntent(text) {
  const t = (text || "").toLowerCase();
  if (/\b(my|your)\s+(notes?|memory|memories|tasks?|sheet|recordings?)\b/.test(t)) return false;
  return (
    /\b(search|google|look\s+(it\s+)?up)\b/.test(t) ||
    /\b(what'?s|find|get|check)\s+the\s+latest\b/.test(t) ||
    /\blatest\s+(on|news|about)\b/.test(t) ||
    /\b(news|headlines)\s+(about|on|of|for)\b/.test(t) ||
    /\bon\s+the\s+(web|internet)\b/.test(t)
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
          onListen: (h) => playRecordingFromHit(h),
        });
      }
    } else if (d.kind === "recordings_list") {
      ui.addRecordingsListCard({
        recordings: Array.isArray(d.recordings) ? d.recordings : [],
        onListen: (h) => playRecordingFromHit(h),
        onOpenAll: () => {
          memShowingRecordings = true;
          ui.selectFilter("recordings");
          ui.openMemory();
          loadRecordings();
        },
      });
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
    remember("assistant", plan.say);
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
    remember("assistant", ask);
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
    if (!plan.say) remember("assistant", msg); // plan.say was remembered in handlePlan
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

  // SCREEN is one look at one page: navigating away or losing the tab ends
  // the mode through the manager, so the banner never claims a page Sharon
  // no longer has in front of her.
  if (
    inMode(MODES.SCREEN) &&
    (!tab || !screenCtx || (tab.url && screenCtx.url && tab.url !== screenCtx.url))
  ) {
    enterMode(MODES.LISTENING);
  }

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
  if (recActive() || screenRecActive()) return; // never read aloud over any recording
  if (key === lastReadKey) return;
  lastReadKey = key;

  speech.stopSpeaking();
  // Auto-read runs only when its settings toggle is explicitly on (checked
  // above) — that turn is a page read by definition.
  await sendTurn(READ_PAGE_TEXT, { showAsUser: false, withPage: true });
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

// What the memory view is showing right now — the batch actions edit this
// list optimistically and re-render, instead of re-fetching the Sheet.
let memHits = [];
let memAtLimit = false;
let memHadQuery = false;

function memCallbacks() {
  return {
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
        const res = await api.updateMemory({ entryId: h.entry_id, deleted: true });
        // A current backend deletes and returns updated:true. An older
        // deployment that predates recording deletes accepts the call but
        // returns updated:false / readonly — surface that honestly instead
        // of silently leaving the recording in place.
        if (res && res.updated === false) {
          warnRecordingDeleteUnsupported();
          return;
        }
        reloadMemoryView(); // recordings and notes each reload their own list
        refreshMemoryCount();
      } catch (e) {
        ui.memError(
          "Couldn't delete that: " + ((e && e.message) || e) + " — check your connection and try again."
        );
      }
    },
    onListen: (h) => playRecordingFromHit(h),
    onBatchStatus: (hits, status) => batchStatusSelected(hits, status),
    onBatchDelete: (hits) => batchDeleteSelected(hits),
  };
}

async function loadMemory(query) {
  const seq = ++memReqSeq;
  ui.memLoading();
  try {
    const hits = await api.searchMemory({ query: query || "", limit: 25, touch: false });
    if (seq !== memReqSeq) return;
    markSetup("memory");
    const list = Array.isArray(hits) ? hits : [];
    memHits = list;
    memHadQuery = !!(query || "").trim();
    memAtLimit = list.length >= 25;
    if (!memHadQuery) {
      ui.setMemorySubtitle(list.length, memAtLimit);
      const openTasks = list.filter((h) => h.entry_type === "task" && String(h.status) !== "done").length;
      ui.setMemBadge(openTasks);
    }
    ui.memorySyncedNow();
    ui.renderMemory(memHits, memCallbacks());
  } catch (e) {
    if (seq !== memReqSeq) return;
    ui.memError("I couldn't load your Sheet — check your connection, then try the search again.");
  }
}

// True while the memory view is showing the Recordings filter — the one
// filter whose data comes from the recordings sheet, not the memory list, so
// leaving it (or searching) needs a reload of the normal memory entries.
let memShowingRecordings = false;

// Load every saved recording into the memory view (newest first). Shares
// memReqSeq with loadMemory so switching filters quickly never renders a
// stale response over a newer one.
async function loadRecordings() {
  const seq = ++memReqSeq;
  ui.memLoading();
  try {
    const recs = await api.listRecordings({ limit: 100 });
    if (seq !== memReqSeq) return;
    markSetup("memory");
    const list = Array.isArray(recs) ? recs : [];
    memHits = list;
    memHadQuery = false;
    memAtLimit = false;
    ui.setRecordingsSubtitle(list.length);
    ui.memorySyncedNow();
    ui.renderMemory(memHits, memCallbacks());
  } catch (e) {
    if (seq !== memReqSeq) return;
    ui.memError("I couldn't load your recordings — check your connection, then try again.");
  }
}

// The memory view's filter pills. Recordings needs its own source; every
// other filter is a client-side re-slice of the already-loaded list. Return
// true when we take over loading so ui.js doesn't also re-render.
function onMemFilterChange(filter) {
  if (filter === "recordings") {
    memShowingRecordings = true;
    loadRecordings();
    return true;
  }
  if (memShowingRecordings) {
    // Coming back from Recordings — reload the normal memory entries.
    memShowingRecordings = false;
    loadMemory(ui.els.memSearchInput ? ui.els.memSearchInput.value.trim() : "");
    return true;
  }
  return false; // pure client-side filter — let ui.js re-slice
}

// Reload whichever list the memory view is currently showing — recordings
// have their own source, so a single delete/edit must refresh the right one.
function reloadMemoryView() {
  if (memShowingRecordings) loadRecordings();
  else loadMemory(ui.els.memSearchInput ? ui.els.memSearchInput.value.trim() : "");
}

// Keep the "N things saved" subtitle and the open-task badge honest after an
// optimistic batch edit — no extra round trip unless a search is filtering
// the list (then the local list can't stand in for the whole Sheet).
function updateMemMeta() {
  if (memShowingRecordings) {
    ui.setRecordingsSubtitle(memHits.length);
    return;
  }
  if (memHadQuery) {
    refreshMemoryCount();
    return;
  }
  ui.setMemorySubtitle(memHits.length, memAtLimit && memHits.length >= 25);
  const openTasks = memHits.filter((h) => h.entry_type === "task" && String(h.status) !== "done").length;
  ui.setMemBadge(openTasks);
}

/* --------- bulk actions from selection mode --------- */
// Mark complete / Reopen — optimistic: every selected task flips at once,
// the whole batch goes up in ONE round trip, and anything the backend
// couldn't update flips back.
async function batchStatusSelected(hits, status) {
  const targets = hits.filter((h) => h.entry_id);
  if (!targets.length) return;
  const prev = new Map(targets.map((h) => [h, h.status]));
  targets.forEach((h) => {
    h.status = status;
  });
  ui.exitMemSelect();
  ui.renderMemory(memHits, memCallbacks());
  updateMemMeta();
  try {
    const res = await api.batchUpdateMemory(targets.map((h) => ({ entryId: h.entry_id, status })));
    const results = (res && res.results) || [];
    const failedIds = new Set(results.filter((r) => r && !r.ok).map((r) => String(r.entry_id)));
    const failed = targets.filter((h) => failedIds.has(String(h.entry_id)));
    if (failed.length) {
      failed.forEach((h) => {
        h.status = prev.get(h);
      });
      ui.renderMemory(memHits, memCallbacks());
    }
    updateMemMeta();
    ui.memorySyncedNow();
    const okCount = targets.length - failed.length;
    ui.showUndoToast({
      label: failed.length
        ? okCount + " updated, " + failed.length + " skipped"
        : status === "done"
        ? "Marked " + okCount + " complete"
        : "Reopened " + okCount,
    });
  } catch (err) {
    targets.forEach((h) => {
      h.status = prev.get(h);
    });
    ui.renderMemory(memHits, memCallbacks());
    updateMemMeta();
    ui.showUndoToast({ label: "Couldn't update — check your connection." });
  }
}

// The one message for "this backend can't delete recordings yet": a visible
// toast over the memory view plus the full redeploy steps in the thread.
// Deleting is a server operation, so the only fix is updating the Apps
// Script deployment to the latest backend/Code.gs.
function warnRecordingDeleteUnsupported() {
  ui.showUndoToast({
    label: "Deleting recordings needs the latest backend — update your Apps Script.",
    duration: 7000,
  });
  reportProblem(
    "I can't delete recordings yet — your Google Apps Script backend is an older version that doesn't support it.",
    REDEPLOY_STEPS
  );
}

// Bulk delete with one Undo for the whole batch. The Sheet's delete is a
// soft flag (deleted = TRUE) for notes/tasks and recordings alike, so Undo
// simply re-sends the same batch with deleted:false and every row comes back
// (a deleted recording's audio is trashed and restored the same way).
async function batchDeleteSelected(hits) {
  const targets = hits.filter((h) => h.entry_id);
  if (!targets.length) return;
  const removed = targets
    .map((h) => ({ h, index: memHits.indexOf(h) }))
    .filter((x) => x.index >= 0)
    .sort((a, b) => a.index - b.index);
  for (let i = removed.length - 1; i >= 0; i--) memHits.splice(removed[i].index, 1);
  ui.exitMemSelect();
  ui.renderMemory(memHits, memCallbacks());
  updateMemMeta();
  try {
    const res = await api.batchUpdateMemory(
      removed.map((x) => ({ entryId: x.h.entry_id, deleted: true }))
    );
    const results = (res && res.results) || [];
    const okIds = new Set(results.filter((r) => r && r.ok).map((r) => String(r.entry_id)));
    const okRows = removed.filter((x) => okIds.has(String(x.h.entry_id)));
    const failedRows = removed.filter((x) => !okIds.has(String(x.h.entry_id)));
    if (failedRows.length) {
      restoreMemRows(failedRows);
      ui.renderMemory(memHits, memCallbacks());
      updateMemMeta();
    }
    if (!okRows.length) {
      // Everything came back skipped. If the backend rejected the recordings
      // as read-only / unsupported, it's an older deployment — say so and how
      // to fix it, rather than blaming the connection.
      const reason = (results.find((r) => r && r.error) || {}).error || "";
      if (/read-only|unknown action|support delete only|older version/i.test(reason)) {
        warnRecordingDeleteUnsupported();
      } else {
        ui.showUndoToast({
          label: reason ? "Couldn't delete — " + reason : "Couldn't delete — check your connection.",
        });
      }
      return;
    }
    ui.memorySyncedNow();
    ui.showUndoToast({
      label: failedRows.length
        ? okRows.length + " deleted, " + failedRows.length + " skipped"
        : "Deleted " + okRows.length + (okRows.length === 1 ? " item" : " items"),
      duration: 6000,
      onUndo: () => undoBatchDelete(okRows),
    });
  } catch (err) {
    restoreMemRows(removed);
    ui.renderMemory(memHits, memCallbacks());
    updateMemMeta();
    ui.showUndoToast({ label: "Couldn't delete — check your connection." });
  }
}

// Put deleted rows back where they were (rows arrive sorted by original
// index, so inserting in order rebuilds the exact list).
function restoreMemRows(rows) {
  for (const x of rows) memHits.splice(Math.min(x.index, memHits.length), 0, x.h);
}

async function undoBatchDelete(rows) {
  restoreMemRows(rows);
  ui.renderMemory(memHits, memCallbacks());
  updateMemMeta();
  try {
    const res = await api.batchUpdateMemory(
      rows.map((x) => ({ entryId: x.h.entry_id, deleted: false }))
    );
    const results = (res && res.results) || [];
    const failedIds = new Set(results.filter((r) => r && !r.ok).map((r) => String(r.entry_id)));
    if (failedIds.size) {
      for (const x of rows) {
        if (!failedIds.has(String(x.h.entry_id))) continue;
        const at = memHits.indexOf(x.h);
        if (at >= 0) memHits.splice(at, 1);
      }
      ui.renderMemory(memHits, memCallbacks());
      ui.showUndoToast({
        label: "Couldn't restore " + failedIds.size + (failedIds.size === 1 ? " item" : " items"),
      });
    }
    updateMemMeta();
    ui.memorySyncedNow();
  } catch (err) {
    for (const x of rows) {
      const at = memHits.indexOf(x.h);
      if (at >= 0) memHits.splice(at, 1);
    }
    ui.renderMemory(memHits, memCallbacks());
    updateMemMeta();
    ui.showUndoToast({ label: "Couldn't restore those — check your connection." });
  }
}

/* ------------------------------------------------------------------ *
 * Voice recorder — press record, talk up to 30 minutes; the audio lands
 * in Drive, the transcript in the Sheet, and the distilled notes in
 * memory (each linking back to the audio). While recording, speech.js's
 * recorder mode keeps Sharon silent: recognition keeps running with its
 * restart stitching (so no words drop), but every result flows into the
 * transcript accumulator here instead of the assist pipeline.
 * ------------------------------------------------------------------ */
const RECORD_MAX_MS = 30 * 60 * 1000; // hard cap — auto-stops at exactly 30:00
const REC_TIMER_TICK_MS = 250;
// Compact voice bitrate — speech is fine at 32 kbps, and a full 30-minute
// recording stays well under the backend's play-in-panel size cap.
const RECORD_AUDIO_BPS = 32000;

let recState = "idle"; // the stage WITHIN the RECORDING mode: idle | recording | uploading | organizing
let mediaRecorder = null;
let recChunks = [];
let recStartAt = 0;
let recTimerInt = null;
let recStageTimer = null;
let recFinalText = ""; // confirmed words
let recInterimText = ""; // in-flight words (shown lighter)
let recSegments = []; // [{ t: seconds, text }] — one per finalized segment

// The one test for "the recorder flow is live": the mode manager's word.
// recState is the recorder's internal stage label; the MODE says whether
// the flow (recording → uploading → organizing) is active at all.
function recActive() {
  return inMode(MODES.RECORDING);
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

function pickRecorderMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ["audio/webm;codecs=opus", "audio/webm"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      resolve(s.slice(s.indexOf(",") + 1)); // strip the data: URL prefix
    };
    r.onerror = () => reject(new Error("I couldn't read the recorded audio."));
    r.readAsDataURL(blob);
  });
}

async function startRecording() {
  if (recActive()) return;
  const mime = pickRecorderMime();
  if (!mime) {
    reportProblem(
      "recording isn't supported in this browser.",
      "Chrome should support it — try updating Chrome, then reload me."
    );
    return;
  }

  // Reuse speech.js's mic stream (one permission, same constraints).
  let stream;
  try {
    stream = await speech.getMicStream();
  } catch (_) {
    reportProblem(
      "I couldn't use the microphone to record.",
      "Click the lock icon by Chrome's address bar, allow the microphone, then tap record again."
    );
    return;
  }

  // Build the MediaRecorder BEFORE any mode change, so a failure here
  // leaves Sharon exactly where she was.
  try {
    preparedRec = new MediaRecorder(stream, {
      mimeType: mime,
      audioBitsPerSecond: RECORD_AUDIO_BPS,
    });
  } catch (_) {
    preparedRec = null;
    reportProblem("I couldn't start the recorder.", "Give it a second and tap record again.");
    return;
  }

  // The manager exits whatever came before (SCREEN clears its snapshot,
  // SEARCHING aborts its call), then runs enterRecordingMode below.
  enterMode(MODES.RECORDING);
}

// RECORDING's enter routine — runs inside the manager AFTER the previous
// mode's exit. From here until finishRecording hands back to LISTENING,
// the recorder owns the ears (speech.js's seal) and Sharon stays silent.
function enterRecordingMode() {
  const recorder = preparedRec;
  preparedRec = null;
  if (!recorder) throw new Error("record entered with nothing prepared");

  // Playback is sound in the room — it must never land in the recording.
  // Pause it cleanly (no auto-resume; the user can tap play afterwards).
  pausePlaybackForUser();
  // "Record mid-anything": abandon the in-flight assist (and any page task
  // mid-step or awaiting a spoken yes) cleanly — its finally tidies the UI.
  cancelAgentTask();
  if (abortController) {
    try {
      abortController.abort();
    } catch (_) {
      /* ignore */
    }
  }
  resetCapture(); // drop any half-captured utterance cleanly

  recFinalText = "";
  recInterimText = "";
  recSegments = [];
  recStartAt = Date.now(); // set before recorder mode so segment stamps are right
  speech.setRecorderState("recording", {
    onFinal: (text) => {
      // Stamp each finalized segment with its elapsed recording time so
      // search can later queue playback to the matching moment.
      recSegments.push({
        t: Math.max(0, Math.round((Date.now() - recStartAt) / 1000)),
        text,
      });
      recFinalText = recFinalText ? recFinalText + " " + text : text;
      recInterimText = "";
      ui.recTranscript(recFinalText, "");
    },
    onInterim: (text) => {
      recInterimText = text;
      ui.recTranscript(recFinalText, text);
    },
  });

  recChunks = [];
  mediaRecorder = recorder;
  mediaRecorder.addEventListener("dataavailable", (ev) => {
    if (ev.data && ev.data.size) recChunks.push(ev.data);
  });
  recState = "recording"; // set before start() so a throw is cleaned up fully
  mediaRecorder.start(1000); // 1s chunks — a crash loses at most a second

  ui.recTranscript("", "");
  ui.setRecorderStage("recording");
  ui.setRecTimer("00:00 / " + fmtClock(RECORD_MAX_MS));
  ui.showRecorder();
  recTimerInt = setInterval(() => {
    const elapsed = Date.now() - recStartAt;
    ui.setRecTimer(fmtClock(Math.min(elapsed, RECORD_MAX_MS)) + " / " + fmtClock(RECORD_MAX_MS));
    if (elapsed >= RECORD_MAX_MS) stopRecording(); // auto-stop at 30:00
  }, REC_TIMER_TICK_MS);
  updateStatus();
}

// RECORDING's exit routine — idempotent. The normal path (finishRecording)
// has already wound everything down, so this is a no-op there; on any other
// path out it force-stops the hardware, timers, and the speech.js seal so
// a failed transition can never leave a half-live recorder behind.
function forceRecorderIdle() {
  if (recTimerInt) {
    clearInterval(recTimerInt);
    recTimerInt = null;
  }
  if (recStageTimer) {
    clearTimeout(recStageTimer);
    recStageTimer = null;
  }
  if (mediaRecorder) {
    try {
      if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    } catch (_) {
      /* ignore */
    }
    mediaRecorder = null;
    recChunks = [];
  }
  if (recState !== "idle") {
    recState = "idle";
    ui.hideRecorder();
  }
  speech.setRecorderState("idle"); // no-op when the seal is already open
}

function stopRecording() {
  if (recState !== "recording") return;
  recState = "uploading";
  if (recTimerInt) {
    clearInterval(recTimerInt);
    recTimerInt = null;
  }
  const durationSeconds = Math.min(
    Math.round((Date.now() - recStartAt) / 1000),
    Math.round(RECORD_MAX_MS / 1000)
  );

  // Fold any in-flight interim into the transcript (and its own timestamped
  // segment) FIRST — then hand the seal to speech.js, which aborts the
  // engine (discarding everything it still owes for the recorded audio) and
  // keeps discarding results until the whole flow is idle again. Nothing
  // said during the recording can resurface in the assist flow afterward.
  if (recInterimText.trim()) {
    recSegments.push({
      t: Math.max(0, Math.round((Date.now() - recStartAt) / 1000)),
      text: recInterimText.trim(),
    });
    recFinalText = (recFinalText + " " + recInterimText).trim();
    recInterimText = "";
  }
  speech.setRecorderState("uploading");

  const transcript = recFinalText.trim();
  const segments = recSegments.slice();
  recSegments = [];
  ui.recTranscript(transcript, "");
  ui.setRecorderStage("uploading");
  updateStatus();

  const rec = mediaRecorder;
  mediaRecorder = null;
  const finish = () =>
    finishRecording((rec && rec.mimeType) || "audio/webm", durationSeconds, transcript, segments);
  if (rec && rec.state !== "inactive") {
    rec.addEventListener("stop", finish, { once: true });
    try {
      rec.stop();
    } catch (_) {
      finish();
    }
  } else {
    finish();
  }
}

async function finishRecording(mimeType, durationSeconds, transcript, segments) {
  const blob = new Blob(recChunks, { type: mimeType || "audio/webm" });
  recChunks = [];
  if (!blob.size) {
    recState = "idle";
    speech.setRecorderState("idle");
    ui.hideRecorder();
    enterMode(MODES.LISTENING); // the flow is over — hand the mode back
    reportProblem(
      "the recording came out empty, so there was nothing to save.",
      "Tap record and try again."
    );
    updateStatus();
    return;
  }

  // One round trip does everything server-side (Drive, Sheet, notes). We
  // can't observe upload progress, so flip the label to "organizing" once
  // the upload has plausibly finished — a size-based estimate.
  const estUploadMs = Math.min(45000, Math.max(2500, blob.size / 150));
  recStageTimer = setTimeout(() => {
    recState = "organizing";
    speech.setRecorderState("organizing");
    ui.setRecorderStage("organizing");
  }, estUploadMs);

  try {
    const audioBase64 = await blobToBase64(blob);
    const id = await ensureSessionId();
    const result = await api.saveRecording({
      sessionId: id,
      audioBase64,
      mimeType: blob.type || "audio/webm",
      durationSeconds,
      transcript,
      segments: Array.isArray(segments) ? segments : [],
      timestamp: new Date().toISOString(),
    });
    ui.hideRecorder();
    const minutes = Math.max(1, Math.round(durationSeconds / 60));
    ui.addRecordingCard({
      driveUrl: result.drive_file_url,
      recordingId: result.recording_id,
      durationLabel: minutes + " min",
      notes: Array.isArray(result.notes) ? result.notes : [],
      onListen: ({ recordingId, driveUrl }) =>
        playRecording({
          recordingId,
          driveUrl,
          startSeconds: 0,
          label: "Recording — just now (" + minutes + " min)",
        }),
    });
    // The recording card is Sharon's side of this turn — put it in history
    // too, so a follow-up like "yes I do" binds to the recording that was
    // just saved instead of leaving the model to guess from page context.
    const noteCount = Array.isArray(result.notes) ? result.notes.length : 0;
    remember(
      "assistant",
      "I saved your " + minutes + "-minute voice recording" +
        (noteCount
          ? " and distilled " + noteCount + (noteCount === 1 ? " note" : " notes") + " from it"
          : "") +
        ". The audio is linked on its card if you want to listen back to it."
    );
    refreshMemoryCount();
  } catch (err) {
    ui.hideRecorder();
    reportProblem(
      "I couldn't save that recording — " + ((err && err.message) || "the upload failed."),
      nextStepFor(err)
    );
  } finally {
    if (recStageTimer) {
      clearTimeout(recStageTimer);
      recStageTimer = null;
    }
    recState = "idle";
    speech.setRecorderState("idle"); // the seal lifts after its grace period
    enterMode(MODES.LISTENING); // upload + organizing done — RECORDING ends here
    updateStatus();
  }
}

/* ------------------------------------------------------------------ *
 * Screen recorder — records the CURRENT DESKTOP (screen video + its system/
 * desktop audio, NEVER the microphone, so other apps keep full mic access) up
 * to 30 minutes, then lets the user trim and download the clip.
 *
 * The recording itself runs in a BACKGROUND offscreen document (background.js
 * + offscreen.js), NOT here — so the user can collapse the side panel and the
 * recording keeps going, with only a red dot on Sharon's toolbar icon. This
 * side-panel code is the CONTROLLER: it starts/stops the background recorder,
 * mirrors its live state, reconnects to an in-progress recording when the
 * panel is reopened, and — once a recording is finished — pulls the clip back
 * (a same-extension blob: URL) for the review/trim step and the download. It
 * lives in its own SCREEN_REC mode so Sharon stays quiet (mic input dropped)
 * while a recording or its review owns the panel; the mode manager keeps that
 * exclusive with the voice recorder.
 *
 * Messages (JSON only) — see background.js + offscreen.js:
 *   panel → SW:  { t:"sr:cmd", cmd:"start"|"stop"|"query"|"clear" }
 *   SW  → panel: { t:"sr:evt", event:"started"|"stopped"|"cancelled"|"error", … }
 * ------------------------------------------------------------------ */
let screenRecPhase = "idle"; // panel-local: idle | recording | reviewing | trimming
let screenRecPaused = false; // whether the in-progress recording is paused
let screenRecStartAtEpoch = 0; // virtual start (now − this === recorded ms), from the SW
let screenRecTimerInt = null; // the local MM:SS display timer

// Review/trim step — inserted BETWEEN "recording finished" and "download".
// The finished clip is pulled back from the background recorder as a Blob;
// then we stay in SCREEN_REC and show a preview + trimmer until the user saves
// or discards.
let screenReviewBlob = null; // the recorded blob (trim source + untouched save)
let screenReviewUrl = null; // preview object URL — revoked on review teardown
let screenReviewCard = null; // the ui controller for the review card
let screenReviewFilename = ""; // the filename both save paths use
let screenTrimVideo = null; // off-screen <video> replaying the kept region
let screenTrimStream = null; // the captureStream() feeding the trim recorder
let screenTrimRecorder = null; // MediaRecorder re-recording the kept region in real time
let screenTrimTimer = null; // drives the stop check + progress label while trimming
let screenTrimStartWall = 0; // wall clock — a stall fallback so trimming always ends

// The one test for "the screen recorder flow owns the panel": the mode word.
function screenRecActive() {
  return inMode(MODES.SCREEN_REC);
}

// Video codecs in order of preference — vp9 is best, vp8 the fallback, plain
// webm the floor. Used by the trim re-record here; the background recorder
// picks from the same list in offscreen.js.
function pickScreenRecorderMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

// Stop every track on a stream (idempotent — stop() is safe to call twice).
function stopStreamTracks(stream) {
  if (!stream || !stream.getTracks) return;
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch (_) {
      /* ignore */
    }
  }
}

// "sharon-screen-YYYY-MM-DD-HHMM.webm" in the user's local clock.
function screenRecFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes());
  return "sharon-screen-" + stamp + ".webm";
}

// Save the finished video to the computer. Preferred: chrome.downloads (the
// only new permission), which offers a Save-As dialog. If it's unavailable,
// fall back to a temporary <a download> click — no permission needed.
//
// The caller hands ownership of `url` to this function: it revokes the object
// URL once the download has SETTLED (Chrome has read the blob, or the user
// cancelled the Save dialog), never before — revoking a blob: URL mid-download
// would break it. Callers therefore create a dedicated URL per download and
// never revoke it themselves.
function downloadScreenRecording(url, filename) {
  const revoke = () => {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {
      /* ignore */
    }
  };
  try {
    if (chrome.downloads && chrome.downloads.download) {
      chrome.downloads.download({ url, filename, saveAs: true }, () => {
        // Reading lastError suppresses the "unchecked runtime.lastError" log
        // when the user cancels the Save dialog; either way it's now safe.
        void chrome.runtime.lastError;
        revoke();
      });
      return;
    }
  } catch (_) {
    /* fall through to the anchor fallback */
  }
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (_) {
    /* nothing more we can do */
  }
  // The anchor read the blob synchronously on click; revoke after a grace
  // window so a slow save still has the data.
  setTimeout(revoke, 30000);
}

// --- talking to the background recorder (background.js) ---
function srSend(cmd) {
  try {
    return chrome.runtime.sendMessage({ t: "sr:cmd", cmd });
  } catch (_) {
    return Promise.resolve(null);
  }
}
// Tell the background recorder to release its copy of the finished clip and
// close the offscreen document. Called once the panel is done with it.
function srClear() {
  srSend("clear");
}

// The screen-record button: start the BACKGROUND recorder. Its getDisplayMedia
// opens Chrome's own screen picker. We enter SCREEN_REC + show the live card
// only once the "started" event confirms a real recording — so a cancelled
// picker leaves Sharon exactly where she was.
async function startScreenRecordingCmd() {
  if (screenRecActive() || screenRecPhase !== "idle") return;
  if (recActive()) {
    // The voice recorder owns the mic until it's done.
    hint("I'm recording your voice right now — tap the round button to stop.");
    return;
  }
  if (!(chrome.runtime && chrome.runtime.sendMessage)) {
    reportProblem(
      "screen recording isn't available in this browser.",
      "Try updating Chrome, then reload me."
    );
    return;
  }
  try {
    await srSend("start");
  } catch (_) {
    reportProblem(
      "I couldn't start the screen recorder.",
      "Give it a second and tap the screen-record button again."
    );
  }
}

// Stop the background recording (also fired by the live card's Stop button and
// by Chrome's own "Stop sharing" bar, via the offscreen document). The
// "stopped" event then drives the review step.
function stopScreenRecordingCmd() {
  if (screenRecPhase !== "recording") return;
  srSend("stop");
}

/* --- events from the background recorder (routed from offscreen.js via SW) --- */

// A recording actually started — enter SCREEN_REC, show the live card, and run
// a local MM:SS display timer off the shared start time. The 30-minute cap and
// the real auto-stop live in the offscreen document; this is display only.
// Run the local MM:SS display timer off the shared (virtual) start time.
function startScreenRecDisplayTimer() {
  if (screenRecTimerInt) clearInterval(screenRecTimerInt);
  screenRecTimerInt = setInterval(() => {
    const elapsed = Date.now() - screenRecStartAtEpoch;
    ui.setScreenRecTimer(fmtClock(Math.min(elapsed, RECORD_MAX_MS)) + " / " + fmtClock(RECORD_MAX_MS));
  }, REC_TIMER_TICK_MS);
}

function onScreenStarted(startAtEpoch) {
  if (recActive()) return; // the voice recorder owns everything
  if (screenRecPhase !== "idle") return; // already recording/reviewing (live event + reconnect race)
  if (!screenRecActive()) enterMode(MODES.SCREEN_REC);
  screenRecPhase = "recording";
  screenRecPaused = false;
  screenRecStartAtEpoch = Number(startAtEpoch) || Date.now();
  ui.setScreenRecTimer("00:00 / " + fmtClock(RECORD_MAX_MS));
  ui.showScreenRecorder();
  ui.setScreenRecPaused(false);
  startScreenRecDisplayTimer();
  updateStatus();
}

// Paused via the keyboard shortcut — freeze the display timer at the recorded
// time and show the paused state. (The 30-minute budget is frozen too.)
function onScreenPaused(recordedMs) {
  if (screenRecPhase !== "recording") return;
  screenRecPaused = true;
  if (screenRecTimerInt) {
    clearInterval(screenRecTimerInt);
    screenRecTimerInt = null;
  }
  const ms = Math.max(0, Number(recordedMs) || 0);
  ui.setScreenRecTimer(fmtClock(Math.min(ms, RECORD_MAX_MS)) + " / " + fmtClock(RECORD_MAX_MS));
  ui.setScreenRecPaused(true);
  updateStatus();
}

// Resumed via the keyboard shortcut — restart the display timer off the new
// virtual start time.
function onScreenResumed(startAtEpoch) {
  if (screenRecPhase !== "recording") return;
  screenRecPaused = false;
  screenRecStartAtEpoch = Number(startAtEpoch) || Date.now();
  ui.setScreenRecPaused(false);
  startScreenRecDisplayTimer();
  updateStatus();
}

// A recording finished (Stop, Chrome's Stop-sharing, or the 30-min cap). Pull
// the clip back from the offscreen recorder as a Blob — a same-extension blob:
// URL, so fetch() reads it with no copy through messaging — then show the
// review/trim card. Also runs on reopen when a finished recording is waiting.
async function onScreenStopped(info) {
  if (screenRecPhase === "reviewing" || screenRecPhase === "trimming") return; // already handled
  if (screenRecTimerInt) {
    clearInterval(screenRecTimerInt);
    screenRecTimerInt = null;
  }
  let blob = null;
  try {
    if (info && info.blobUrl) {
      const resp = await fetch(info.blobUrl);
      blob = await resp.blob();
    }
  } catch (_) {
    blob = null;
  }
  if (!blob || !blob.size) {
    srClear();
    if (screenRecActive()) enterMode(MODES.LISTENING);
    reportProblem(
      "the screen recording couldn't be retrieved.",
      "Tap the screen-record button and try again."
    );
    updateStatus();
    return;
  }
  if (!screenRecActive()) enterMode(MODES.SCREEN_REC); // reconnecting after a reopen
  screenReviewBlob = blob;
  screenReviewFilename = screenRecFilename();
  screenReviewUrl = URL.createObjectURL(blob);
  screenRecPhase = "reviewing";
  screenReviewCard = ui.addScreenReviewCard({
    url: screenReviewUrl,
    onSave: (start, end, dur) => saveScreenReview(start, end, dur),
    onDiscard: () => discardScreenReview(),
  });
  updateStatus();
}

// The user dismissed Chrome's screen picker — nothing to do.
function onScreenCancelled() {
  /* stay in LISTENING; the button is ready to try again */
}

// The background recorder hit a real problem (not a cancel).
function onScreenError(info) {
  if (screenRecTimerInt) {
    clearInterval(screenRecTimerInt);
    screenRecTimerInt = null;
  }
  if (screenRecActive() && screenRecPhase === "recording") enterMode(MODES.LISTENING);
  const why = (info && info.error) || "";
  reportProblem(
    "the screen recording ran into a problem" + (why ? " (" + why + ")" : "") + ".",
    "Tap the screen-record button to try again."
  );
  updateStatus();
}

// On panel open, reconnect to whatever the background recorder is doing: a
// recording in progress (show the live card), or a finished clip waiting to be
// reviewed (pull it back and show the review card).
async function reconnectScreenRec() {
  if (recActive()) return; // the voice recorder owns the panel this session
  let st = null;
  try {
    st = await srSend("query");
  } catch (_) {
    st = null;
  }
  if (!st || !st.phase) return;
  if (st.phase === "recording") {
    onScreenStarted(st.startAtEpoch);
    if (st.paused) onScreenPaused(st.recordedMs); // reconnect to a paused recording
  } else if (st.phase === "ready") {
    onScreenStopped({
      blobUrl: st.blobUrl,
      size: st.size,
      durationSeconds: st.durationSeconds,
      mime: st.mime,
    });
  }
}

// SCREEN_REC's enter routine — the recording lives in the background offscreen
// document now, so entering the mode just makes Sharon go quiet (drop mic
// input, pause any playback, abandon an in-flight turn) while a recording or
// its review owns the panel. The live/review UI is set by the callers above.
function enterScreenRecMode() {
  pausePlaybackForUser();
  cancelAgentTask();
  if (abortController) {
    try {
      abortController.abort();
    } catch (_) {
      /* ignore */
    }
  }
  resetCapture();
  updateStatus();
}

// Release the REVIEW/TRIM resources — the trim re-record, the off-screen
// video, the preview object URL, and the review card. Idempotent and safe to
// call twice; the download's own dedicated URL is revoked by the download
// path, never here.
function teardownScreenReview() {
  if (screenTrimTimer) {
    clearInterval(screenTrimTimer);
    screenTrimTimer = null;
  }
  if (screenTrimRecorder) {
    try {
      if (screenTrimRecorder.state !== "inactive") screenTrimRecorder.stop();
    } catch (_) {
      /* ignore */
    }
    screenTrimRecorder = null;
  }
  stopStreamTracks(screenTrimStream);
  screenTrimStream = null;
  if (screenTrimVideo) {
    try {
      screenTrimVideo.pause();
    } catch (_) {
      /* ignore */
    }
    try {
      screenTrimVideo.removeAttribute("src");
      screenTrimVideo.load();
    } catch (_) {
      /* ignore */
    }
    try {
      if (screenTrimVideo.parentNode) screenTrimVideo.parentNode.removeChild(screenTrimVideo);
    } catch (_) {
      /* ignore */
    }
    screenTrimVideo = null;
  }
  if (screenReviewCard) {
    try {
      screenReviewCard.remove();
    } catch (_) {
      /* ignore */
    }
    screenReviewCard = null;
  }
  if (screenReviewUrl) {
    try {
      URL.revokeObjectURL(screenReviewUrl);
    } catch (_) {
      /* ignore */
    }
    screenReviewUrl = null;
  }
  screenReviewBlob = null;
  screenReviewFilename = "";
  screenTrimStartWall = 0;
}

// SCREEN_REC's exit routine — idempotent and safe to call twice. Tears down
// this panel's LOCAL review/trim resources and the display timer, then clears
// the live card. It deliberately does NOT stop the background recording — that
// lives in the offscreen document and is managed by explicit start/stop/clear
// commands, so it survives the panel closing.
function forceScreenRecIdle() {
  if (screenRecTimerInt) {
    clearInterval(screenRecTimerInt);
    screenRecTimerInt = null;
  }
  screenRecPaused = false;
  teardownScreenReview();
  if (screenRecPhase !== "idle") {
    screenRecPhase = "idle";
    ui.hideScreenRecorder();
  }
}

// Discard — nothing is saved. Release the background recorder's copy, then
// leave the mode (forceScreenRecIdle revokes the preview URL and removes the
// card).
function discardScreenReview() {
  if (!screenRecActive()) return;
  srClear();
  enterMode(MODES.LISTENING);
  updateStatus();
}

// Save the chosen region. If the handles are effectively untouched (start ≈ 0
// AND end ≈ full duration, within ~0.3s), skip re-encoding and download the
// ORIGINAL blob as-is — instant and lossless. Otherwise trim for real.
function saveScreenReview(startSec, endSec, durationSec) {
  if (screenRecPhase !== "reviewing") return;
  const TOL = 0.3;
  const untouched =
    !isFinite(durationSec) ||
    durationSec <= 0 ||
    (startSec <= TOL && endSec >= durationSec - TOL);

  const filename = screenReviewFilename || screenRecFilename();
  if (untouched) {
    // A dedicated download URL (the download path revokes it when it settles);
    // the preview URL is revoked separately by the mode-exit teardown.
    if (screenReviewBlob) {
      downloadScreenRecording(URL.createObjectURL(screenReviewBlob), filename);
    }
    srClear(); // release the background recorder's copy
    enterMode(MODES.LISTENING);
    updateStatus();
    return;
  }
  trimAndDownload(startSec, endSec, filename);
}

// A real trim: replay ONLY the kept region into a fresh MediaRecorder via
// video.captureStream() (which carries the audio track), in real time, then
// download the result. Runs inside SCREEN_REC; the card shows progress and its
// buttons stay disabled until it finishes.
async function trimAndDownload(startSec, endSec, filename) {
  const mime = pickScreenRecorderMime();
  const sourceBlob = screenReviewBlob;

  // Save the whole clip instead of losing it if we can't trim here.
  const saveWholeInstead = () => {
    if (sourceBlob) downloadScreenRecording(URL.createObjectURL(sourceBlob), filename);
    srClear();
    enterMode(MODES.LISTENING);
    updateStatus();
  };
  if (!mime || !sourceBlob) {
    saveWholeInstead();
    return;
  }

  screenRecPhase = "trimming";
  const total = Math.max(0, endSec - startSec);
  if (screenReviewCard)
    screenReviewCard.setTrimming(
      "Trimming… this takes about as long as the kept clip — " + fmtClock(total * 1000) + " left"
    );
  updateStatus();

  // Off-screen but RENDERED video (display:none stops frame output to
  // captureStream, so it's positioned off-screen instead). Muted so it makes
  // no sound in the room; captureStream still carries the audio track.
  const v = document.createElement("video");
  v.className = "srv-offscreen";
  v.src = screenReviewUrl; // same blob as the preview
  v.muted = true;
  v.playsInline = true;
  document.body.appendChild(v);
  screenTrimVideo = v;

  try {
    await new Promise((res, rej) => {
      v.addEventListener("loadedmetadata", () => res(), { once: true });
      v.addEventListener("error", () => rej(new Error("load")), { once: true });
    });
  } catch (_) {
    saveWholeInstead();
    return;
  }
  if (screenRecPhase !== "trimming") return; // torn down while we waited

  // Seek to the start point before we start capturing.
  try {
    await new Promise((res) => {
      v.addEventListener("seeked", () => res(), { once: true });
      try {
        v.currentTime = startSec;
      } catch (_) {
        res();
      }
    });
  } catch (_) {
    /* proceed from wherever it landed */
  }
  if (screenRecPhase !== "trimming") return;

  const capture = v.captureStream
    ? v.captureStream.bind(v)
    : v.mozCaptureStream
    ? v.mozCaptureStream.bind(v)
    : null;
  if (!capture) {
    saveWholeInstead();
    return;
  }
  let stream;
  let recorder;
  try {
    stream = capture();
    recorder = new MediaRecorder(stream, { mimeType: mime });
  } catch (_) {
    saveWholeInstead();
    return;
  }
  screenTrimStream = stream;
  screenTrimRecorder = recorder;
  const chunks = [];
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  });

  let stopped = false;
  const stopTrim = () => {
    if (stopped) return;
    stopped = true;
    if (screenTrimTimer) {
      clearInterval(screenTrimTimer);
      screenTrimTimer = null;
    }
    try {
      v.pause();
    } catch (_) {
      /* ignore */
    }
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch (_) {
      /* ignore */
    }
  };

  recorder.addEventListener(
    "stop",
    () => {
      const trimmed = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
      // Hand a dedicated URL to the download path (it revokes on settle); the
      // preview URL + off-screen video are freed by the mode-exit teardown.
      if (trimmed.size) {
        downloadScreenRecording(URL.createObjectURL(trimmed), filename);
      } else if (sourceBlob) {
        downloadScreenRecording(URL.createObjectURL(sourceBlob), filename);
      }
      srClear(); // release the background recorder's copy
      enterMode(MODES.LISTENING);
      updateStatus();
    },
    { once: true }
  );

  screenTrimStartWall = Date.now();
  try {
    recorder.start(1000);
  } catch (_) {
    saveWholeInstead();
    return;
  }
  try {
    await v.play();
  } catch (_) {
    /* play() may reject; the timer below still drives the stop */
  }

  // Stop when playback reaches the end handle (or the clip ends), with a
  // wall-clock stall fallback so trimming can never hang forever.
  screenTrimTimer = setInterval(() => {
    const cur = v.currentTime;
    const left = Math.max(0, endSec - cur);
    if (screenReviewCard) screenReviewCard.updateTrimming("Trimming… " + fmtClock(left * 1000) + " left");
    const elapsedWall = Date.now() - screenTrimStartWall;
    if (cur >= endSec - 0.03 || v.ended || elapsedWall > total * 1000 + 4000) {
      stopTrim();
    }
  }, 100);
}

/* ------------------------------------------------------------------ *
 * The mode lifecycle — the remaining enter/exit routines the manager
 * (mode.js) runs. RECORDING's live above with the recorder it drives.
 * ------------------------------------------------------------------ */
// LISTENING is the safe landing: every mode returns here, including any
// failed transition the manager rescues. Everything here is idempotent —
// on a normal transition the leaving mode's exit already did this work.
function enterListeningMode() {
  forceRecorderIdle();
  screenCtx = null;
  stagedScreenCtx = null;
  updateStatus();
}

// The screen icon: one tap = one look. Entering captures the tab ONCE and
// Sharon asks her one question; the next message is answered with that
// snapshot attached (sendTurn), then the mode ends itself. Tapping the icon
// again while in SCREEN exits immediately without sending anything.
async function toggleScreenMode() {
  if (recActive()) {
    // The recorder owns everything until it's done.
    hint("I'm recording right now — tap the round button to stop.");
    return;
  }
  if (screenRecActive()) {
    hint("I'm recording your screen right now — tap the screen-record button to stop.");
    return;
  }
  if (inMode(MODES.SCREEN)) {
    speech.stopSpeaking(); // she may still be mid-question
    enterMode(MODES.LISTENING);
    return;
  }
  let ctx;
  try {
    ctx = await page.readPageContext({ fresh: true });
  } catch (_) {
    ctx = { restricted: true };
  }
  if (recActive() || inMode(MODES.SCREEN)) return; // the world moved on while we read
  if (!ctx || ctx.restricted) {
    sharonSay(
      "I can't see this page — Chrome doesn't let me read it. Open a regular website and tap the screen button again."
    );
    return;
  }
  stagedScreenCtx = ctx;
  enterMode(MODES.SCREEN);
}

function enterScreenMode() {
  screenCtx = stagedScreenCtx;
  stagedScreenCtx = null;
  if (!screenCtx) throw new Error("screen mode entered without a snapshot");
  updateTabPill(); // the banner turns on — truthfully; the snapshot is real
  sharonSay("I'm looking at your screen — what do you want to know?");
}

function exitScreenMode() {
  screenCtx = null;
  updateTabPill(); // the banner clears the moment the mode ends
}

// SEARCHING's exit routine: leaving the mode for ANY reason other than the
// reply itself (barge-in, a record tap, a new message) cancels the
// in-flight call. Normal completion nulls searchAc first (sendTurn's
// finally), so a finished call is never aborted.
function exitSearchingMode() {
  const pending = searchAc;
  searchAc = null;
  if (pending) {
    try {
      pending.abort();
    } catch (_) {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * In-panel audio player — plays a saved recording right here, queued to
 * the moment that matched the user's question. The audio arrives base64
 * through the backend (the Drive file stays private; no sharing changes),
 * becomes a Blob URL, and drives one <audio> element. One player at a
 * time: starting another recording replaces (and revokes) the last one.
 * Coordination with the ears/voice:
 *   • while playing, speech.js's playback mode (rule 7) keeps the sound
 *     from becoming commands — confident user speech pauses it instead;
 *   • Sharon speaking pauses playback and it resumes when she's done;
 *   • starting a recording pauses playback for good (no auto-resume);
 *   • any failure or a too_large file falls back to the Drive link.
 * ------------------------------------------------------------------ */
let plAudio = null; // the one <audio>
let plBlobUrl = null; // revoked whenever replaced
let plRecordingId = null; // what's loaded
let plLoadingId = null; // what's being fetched
let plDriveUrl = ""; // the always-available fallback
let plDuration = 0; // seconds (sheet value until the element knows better)
let plPausedForSpeech = false; // paused by Sharon's own voice → auto-resume
let plLoadSeq = 0; // stale-fetch guard

function playerPlaying() {
  return !!(plAudio && !plAudio.paused && !plAudio.ended);
}

// A deliberate pause (user barge-in, recorder start): never auto-resumes.
function pausePlaybackForUser() {
  if (!plAudio) return;
  plPausedForSpeech = false;
  try {
    plAudio.pause();
  } catch (_) {
    /* ignore */
  }
}

// Sharon's voice and the player never talk at once: her reply (or a live
// recording) pauses playback; a speech-pause resumes once the panel is
// genuinely idle again — not while the user is mid-sentence or a turn is
// in flight.
function syncPlaybackWithSpeech() {
  if (!plAudio) return;
  if (speech.isSpeaking() || recActive()) {
    if (playerPlaying()) {
      if (speech.isSpeaking()) plPausedForSpeech = true; // resume after her reply
      try {
        plAudio.pause();
      } catch (_) {
        /* ignore */
      }
    }
    return;
  }
  if (plPausedForSpeech && !thinking && !busy && !hearing && !pendingText) {
    plPausedForSpeech = false;
    plAudio.play().catch(() => {});
  }
}

function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "audio/webm" });
}

// Release the current audio + Blob URL (the "one player at a time" rule).
function stopPlayback() {
  const a = plAudio;
  plAudio = null;
  plRecordingId = null;
  plPausedForSpeech = false;
  plDuration = 0;
  if (a) {
    try {
      a.pause();
    } catch (_) {
      /* ignore */
    }
    try {
      a.removeAttribute("src");
      a.load();
    } catch (_) {
      /* ignore */
    }
  }
  if (plBlobUrl) {
    try {
      URL.revokeObjectURL(plBlobUrl);
    } catch (_) {
      /* ignore */
    }
    plBlobUrl = null;
  }
  speech.setPlaybackActive(false);
  ui.playerSetPlaying(false);
}

function closePlayer() {
  plLoadSeq++; // discard any fetch still in flight
  plLoadingId = null;
  stopPlayback();
  ui.playerHide();
}

// Never a dead click: any failure (or a too_large file) becomes the exact
// old behavior — the recording opens in Drive — plus a plain message.
function playbackFallback(url, msg) {
  stopPlayback();
  ui.playerHide();
  ui.addSharonBubble(
    msg +
      (url ? "" : " I couldn't find its Drive link either — it's in your “Sharon Recordings” folder.")
  );
  if (url) {
    try {
      chrome.tabs.create({ url });
    } catch (_) {
      try {
        window.open(url, "_blank", "noopener");
      } catch (_) {
        /* the message above still tells them where it lives */
      }
    }
  }
}

// A recording hit (search card or memory row) → play at its matched moment.
// Old recordings without segments simply have no start_seconds → 0:00.
function playRecordingFromHit(h) {
  const recordingId =
    String(h.recording_id || "").trim() || String(h.entry_id || "").replace(/^rec:/, "").trim();
  playRecording({
    recordingId,
    driveUrl: h.page_url || "",
    startSeconds: Math.max(0, Math.round(Number(h.start_seconds) || 0)),
    label: h.title || "Recording",
  });
}

async function playRecording({ recordingId, driveUrl, startSeconds = 0, label = "Recording" }) {
  recordingId = String(recordingId || "").trim();
  if (!recordingId) {
    playbackFallback(
      driveUrl,
      "I couldn't work out which recording that was, so I've opened it in your Drive instead."
    );
    return;
  }

  // Same recording already loaded — just jump to the moment and play.
  if (plAudio && plRecordingId === recordingId) {
    if (speech.isSpeaking()) speech.stopSpeaking();
    plPausedForSpeech = false;
    const at = plDuration
      ? Math.min(Math.max(0, startSeconds), Math.max(0, plDuration - 1))
      : Math.max(0, startSeconds);
    try {
      plAudio.currentTime = at;
    } catch (_) {
      /* ignore */
    }
    ui.playerSetTime(at, plDuration);
    plAudio.play().catch(() => {});
    return;
  }
  if (plLoadingId && plLoadingId === recordingId) return; // already fetching it

  const seq = ++plLoadSeq;
  stopPlayback();
  plLoadingId = recordingId;
  plDriveUrl = driveUrl || "";
  ui.playerShow({ label, driveUrl: plDriveUrl });

  let result;
  try {
    // No abort timeout on purpose — a long file legitimately takes a while;
    // the bar shows a loading state the whole time.
    result = await api.getRecordingAudio(recordingId);
  } catch (err) {
    if (seq !== plLoadSeq) return;
    plLoadingId = null;
    playbackFallback(
      plDriveUrl,
      "I couldn't fetch that recording's audio just now, so I've opened it in your Drive instead."
    );
    return;
  }
  if (seq !== plLoadSeq) return; // replaced or closed while fetching
  plLoadingId = null;

  if (result && result.too_large) {
    playbackFallback(
      result.drive_file_url || plDriveUrl,
      "That recording's file is too big for me to play here, so I've opened it in your Drive instead."
    );
    return;
  }
  if (!result || !result.audio_base64) {
    playbackFallback(
      plDriveUrl,
      "I couldn't load that recording's audio, so I've opened it in your Drive instead."
    );
    return;
  }

  let blob;
  try {
    blob = base64ToBlob(result.audio_base64, result.mime_type);
  } catch (_) {
    playbackFallback(
      result.drive_file_url || plDriveUrl,
      "That recording's audio wouldn't decode here, so I've opened it in your Drive instead."
    );
    return;
  }

  plRecordingId = recordingId;
  plDriveUrl = result.drive_file_url || plDriveUrl;
  plDuration = Math.max(0, Number(result.duration_seconds) || 0);
  plBlobUrl = URL.createObjectURL(blob);
  const audio = new Audio();
  plAudio = audio;
  const start = Math.max(0, Math.round(Number(startSeconds) || 0));

  const beginAt = () => {
    if (plAudio !== audio) return;
    if (isFinite(audio.duration) && audio.duration > 0) plDuration = audio.duration;
    ui.playerReady(plDuration);
    const at = plDuration ? Math.min(start, Math.max(0, plDuration - 1)) : start;
    try {
      audio.currentTime = at;
    } catch (_) {
      /* plays from wherever it can */
    }
    ui.playerSetTime(at, plDuration);
    if (speech.isSpeaking()) speech.stopSpeaking(); // never both at once
    plPausedForSpeech = false;
    audio.play().catch(() => {
      // Autoplay refused (shouldn't happen after a click) — the bar is
      // ready; the user just taps play.
    });
  };

  audio.addEventListener("loadedmetadata", () => {
    if (plAudio !== audio) return;
    if (isFinite(audio.duration) && audio.duration > 0) {
      beginAt();
      return;
    }
    // MediaRecorder webm quirk: the blob reports Infinity until the engine
    // is pushed past the end once; then the real duration appears and
    // seeking works. The sheet's duration_seconds covers the display.
    const onDur = () => {
      if (plAudio !== audio) return;
      if (!isFinite(audio.duration) || audio.duration <= 0) return;
      audio.removeEventListener("durationchange", onDur);
      beginAt();
    };
    audio.addEventListener("durationchange", onDur);
    try {
      audio.currentTime = 1e7;
    } catch (_) {
      beginAt();
    }
  });
  audio.addEventListener("error", () => {
    if (plAudio !== audio) return;
    playbackFallback(
      plDriveUrl,
      "I couldn't play that recording here, so I've opened it in your Drive instead."
    );
  });
  audio.addEventListener("play", () => {
    if (plAudio !== audio) return;
    speech.setPlaybackActive(true); // rule 7: the room is not quiet now
    ui.playerSetPlaying(true);
  });
  audio.addEventListener("pause", () => {
    if (plAudio !== audio) return;
    speech.setPlaybackActive(false);
    ui.playerSetPlaying(false);
  });
  audio.addEventListener("ended", () => {
    if (plAudio !== audio) return;
    plPausedForSpeech = false;
    speech.setPlaybackActive(false);
    ui.playerSetPlaying(false);
  });
  audio.addEventListener("timeupdate", () => {
    if (plAudio !== audio) return;
    ui.playerSetTime(audio.currentTime, plDuration);
  });
  audio.src = plBlobUrl;
}

/* ------------------------------------------------------------------ *
 * Wiring: mic, composer, live card, header, memory, settings, welcome
 * ------------------------------------------------------------------ */
function toggleMic() {
  if (modeActionBusy) return; // a mode transition is settling — let it finish
  if (recActive()) {
    // The recorder owns the ears — muting would cut the transcript.
    hint("I'm recording right now — tap the round button to stop.");
    return;
  }
  if (screenRecActive()) {
    hint("I'm recording your screen right now — tap the screen-record button to stop.");
    return;
  }
  if (!speech.speechRecognitionAvailable()) {
    reportProblem(
      "Voice input isn't available in this browser.",
      "Type to me in the box below instead — everything works the same way, and I'll still read pages aloud."
    );
    return;
  }
  if (speech.isMicBlocked()) {
    listenDeferred = false; // an explicit tap outranks the boot deferral
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
  listenDeferred = false; // an explicit tap outranks the boot deferral
  speech.setMicMuted(!speech.isMicMuted());
  updateStatus();
}

function sendTyped(text) {
  const e = ui.els;
  const t = (text != null ? text : e.composerInput ? e.composerInput.value : "").trim();
  if (!t) return;
  if (text == null && e.composerInput) e.composerInput.value = "";
  ui.setComposerHasText(false);
  // Typed messages must land in a visible thread too — leave Notes first
  // (a no-op when it isn't open; handleUserUtterance guards this as well).
  notes.closeNotesView();
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
  const byName = {};
  try {
    if (chrome.commands && chrome.commands.getAll) {
      const cmds = await chrome.commands.getAll();
      for (const c of cmds || []) byName[c.name] = c.shortcut || "";
    }
  } catch (_) {
    /* leave everything "Not set" */
  }
  const set = (el, name) => {
    if (el) el.textContent = byName[name] || "Not set";
  };
  set(ui.els.shortcutValue, "activate-sharon");
  set(ui.els.screenRecShortcutValue, "toggle-screen-recording");
  set(ui.els.screenPauseShortcutValue, "pause-screen-recording");
}

function wireControls() {
  const e = ui.els;

  // Composer: pill input + blue send circle (only with text).
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

  // Mode bar — the three tappable icons. Mic toggles mute (mute stays
  // independent of the mode); record starts/stops the recorder; screen
  // enters/exits the one-look SCREEN mode. The globe is an indicator only.
  if (e.micBtn) e.micBtn.addEventListener("click", toggleMic);
  if (e.recordBtn)
    e.recordBtn.addEventListener("click", () =>
      runModeAction(async () => {
        if (screenRecActive()) {
          // The screen recorder owns the capture until the user stops it.
          hint("I'm recording your screen right now — tap the screen-record button to stop.");
          return;
        }
        if (recState === "recording") {
          stopRecording();
        } else if (recActive()) {
          // The mode is RECORDING but the mic has stopped — we're mid
          // upload/organize. Starting again now would race the save.
          hint("Still saving your last recording — one moment.");
        } else {
          await startRecording();
        }
      })
    );
  if (e.screenBtn)
    e.screenBtn.addEventListener("click", () => runModeAction(toggleScreenMode));
  // Screen record: start/stop the BACKGROUND recorder, mirroring the voice
  // record button. Recording continues if the panel is collapsed.
  if (e.screenRecBtn)
    e.screenRecBtn.addEventListener("click", () =>
      runModeAction(async () => {
        if (screenRecPhase === "recording") {
          stopScreenRecordingCmd();
        } else if (screenRecPhase === "reviewing") {
          hint("Choose Save or Discard on your recording below.");
        } else if (screenRecPhase === "trimming") {
          hint("Trimming your clip — one moment.");
        } else {
          await startScreenRecordingCmd();
        }
      })
    );
  if (e.recStop) e.recStop.addEventListener("click", () => runModeAction(async () => stopRecording()));
  if (e.screenRecStop)
    e.screenRecStop.addEventListener("click", () => runModeAction(async () => stopScreenRecordingCmd()));
  // Closing the panel ends the VOICE recording (its state is in-memory). But
  // the SCREEN recording lives in the background offscreen document, so
  // collapsing the panel must NOT stop it — only release this panel's own
  // review/trim resources. The recording keeps going with a red dot on the
  // icon, and the panel reconnects to it on reopen.
  window.addEventListener("pagehide", () => {
    if (recState === "recording" && mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch (_) {
        /* ignore */
      }
    }
    if (screenRecTimerInt) {
      clearInterval(screenRecTimerInt);
      screenRecTimerInt = null;
    }
    teardownScreenReview();
  });

  // In-panel player: play/pause, seek, close. (The Drive link is a plain <a>.)
  if (e.plToggle)
    e.plToggle.addEventListener("click", () => {
      if (!plAudio) return;
      if (playerPlaying()) {
        pausePlaybackForUser();
      } else {
        if (speech.isSpeaking()) speech.stopSpeaking(); // never both at once
        plPausedForSpeech = false;
        plAudio.play().catch(() => {});
      }
    });
  if (e.plSeek)
    e.plSeek.addEventListener("input", () => {
      if (!plAudio) return;
      const v = Math.max(0, Number(e.plSeek.value) || 0);
      try {
        plAudio.currentTime = v;
      } catch (_) {
        /* ignore */
      }
      ui.playerSetTime(v, plDuration);
    });
  if (e.plClose) e.plClose.addEventListener("click", closePlayer);

  // Live-presence card: mute pill, tap-to-edit strip, editor buttons.
  if (e.lcMute) e.lcMute.addEventListener("click", toggleMic);
  if (e.lcStrip) e.lcStrip.addEventListener("click", openEditor);
  if (e.lcSend)
    e.lcSend.addEventListener("click", () => {
      if (recActive()) {
        resetCapture(); // voice drafts never survive into a recording
        return;
      }
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
  const openMemoryView = () => {
    // Always open on the full memory list, never a stale Recordings filter.
    memShowingRecordings = false;
    ui.selectFilter("all");
    ui.openMemory();
    loadMemory(e.memSearchInput ? e.memSearchInput.value.trim() : "");
  };
  if (e.memoryBtn) e.memoryBtn.addEventListener("click", openMemoryView);
  // Bottom-bar toggle: flip between the conversation and the memory view from
  // a fixed spot, so you can bounce back and forth without hunting the header.
  if (e.memNavBtn)
    e.memNavBtn.addEventListener("click", () => {
      if (ui.memoryOpen()) ui.closeMemory();
      else openMemoryView();
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
    else if (ui.memoryOpen()) {
      // Escape backs out one layer at a time: selection first, then the view.
      if (ui.memSelectActive()) ui.exitMemSelect();
      else ui.closeMemory();
    }
  });

  // Memory search (debounced, live filtering via the backend).
  let memSearchTimer = null;
  if (e.memSearchInput)
    e.memSearchInput.addEventListener("input", () => {
      const q = e.memSearchInput.value.trim();
      // Searching always works against the full memory list (a keyword search
      // also surfaces recording transcripts), so drop the Recordings filter.
      if (memShowingRecordings) {
        memShowingRecordings = false;
        ui.selectFilter("all");
      }
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
  // All three shortcut keycaps open Chrome's own shortcuts page, where the user
  // rebinds any of Sharon's commands (Chrome doesn't let extensions set keys).
  const openShortcuts = () => {
    try {
      chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    } catch (_) {
      /* fail quietly */
    }
  };
  if (e.changeShortcut) e.changeShortcut.addEventListener("click", openShortcuts);
  if (e.changeScreenRecShortcut) e.changeScreenRecShortcut.addEventListener("click", openShortcuts);
  if (e.changeScreenPauseShortcut) e.changeScreenPauseShortcut.addEventListener("click", openShortcuts);

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
      if (!msg) return;
      if (msg.type === "sharon-activate") {
        speech.retryMic();
        updateStatus();
        return;
      }
      // Background screen-recorder events (from offscreen.js via the SW).
      if (msg.t === "sr:evt") {
        if (msg.event === "started") onScreenStarted(msg.startAtEpoch);
        else if (msg.event === "stopped") onScreenStopped(msg);
        else if (msg.event === "paused") onScreenPaused(msg.recordedMs);
        else if (msg.event === "resumed") onScreenResumed(msg.startAtEpoch);
        else if (msg.event === "cancelled") onScreenCancelled();
        else if (msg.event === "error") onScreenError(msg);
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
  ui.setMemFilterHandler(onMemFilterChange);

  // The Notes view wires its own controls; it only needs the redeploy
  // walkthrough for a stale backend, and a guard so dictation can never
  // start while a voice or screen recording owns the ears.
  notes.initNotes({
    redeploySteps: REDEPLOY_STEPS,
    canDictate: () => !recActive() && !screenRecActive(),
  });

  // The mode manager — Sharon is in exactly one mode; every feature routes
  // its entries and exits through here. Opens in LISTENING (the default),
  // so a reopened panel never resumes a stuck mode: recorder and screen
  // state are in-memory only, and this registration starts them clean.
  initModes({
    routines: {
      [MODES.LISTENING]: { enter: enterListeningMode },
      [MODES.RECORDING]: { enter: enterRecordingMode, exit: forceRecorderIdle },
      [MODES.SCREEN_REC]: { enter: enterScreenRecMode, exit: forceScreenRecIdle },
      [MODES.SCREEN]: { enter: enterScreenMode, exit: exitScreenMode },
      [MODES.SEARCHING]: { enter: updateStatus, exit: exitSearchingMode },
    },
    onChange: (m) => {
      ui.setMode(m);
      updateStatus();
    },
  });

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
    // The user spoke over a playing recording — pause it, exactly like
    // barging in on Sharon. Their words are dropped by speech.js (they may
    // BE the playback), so they can speak again into clean silence.
    onPlaybackBargeIn: () => {
      pausePlaybackForUser();
      updateStatus();
    },
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

  // Notes is the panel's home view — open it unless the welcome walkthrough
  // is on screen (first run always wins). The moment the user actually
  // addresses Sharon, handleUserUtterance/sendTyped close Notes back to the
  // conversation, so her replies are never hidden behind it.
  if (!ui.welcomeVisible()) notes.openNotesView();

  updateStatus();
  // Ends the boot deferral the moment the conversation view is actually on
  // screen — the same data-view attribute every view swap already writes.
  new MutationObserver(() => {
    if (listenDeferred && document.documentElement.getAttribute("data-view") === "chat")
      undeferListening();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-view"] });

  // Listening from launch — the mic goes live the moment the panel opens —
  // EXCEPT when the panel opened on Notes: reading your notes is not talking
  // to Sharon, so she starts MUTED and begins listening only when you switch
  // to the conversation (or tap the mic button yourself). The welcome
  // walkthrough keeps the original live-from-launch behavior — its first
  // step is allowing the mic.
  if (notes.notesViewOpen()) {
    listenDeferred = true;
    speech.setMicMuted(true);
    updateStatus();
  } else {
    speech.startRecognition();
  }
  watchMicPermission();

  // If a screen recording is already running in the background (the panel was
  // collapsed and reopened) — or a finished clip is waiting to be reviewed —
  // reconnect to it now.
  reconnectScreenRec();

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
