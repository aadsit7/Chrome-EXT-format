// sidepanel.js — Sharon's orchestrator. Wires the ears/voice (speech.js), the
// page engines (page.js), the backend brain (api.js), and the UI (ui.js) into
// one conversation loop:
//
//   listen → (instant command? do it locally) → editable transcript →
//   assist() one round trip: Claude answers AND/OR reads-writes the Google
//   Sheet database through tools AND/OR returns an on-page action plan →
//   render cards → speak → listen again.
//
// What makes this fast and conversational:
//   • Real multi-turn memory: the last HISTORY_TURNS exchanges ride along
//     with every request (and are restored from the Sheet when reopened).
//   • One HTTP round trip per turn — saving notes, searching, summarizing,
//     and answering all happen inside a single assist() call.
//   • Page snapshots are cached briefly so back-to-back questions about the
//     same page don't pay the extraction cost twice.
//   • Sharon never interrupts: speech.js holds her voice the instant you
//     start talking and only resumes if it was noise or her own echo.

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
 * Status — single source of truth for the hero
 * ------------------------------------------------------------------ */
let thinking = false;

function updateStatus() {
  ui.setMicIndicator(!speech.isMicMuted() && !speech.isMicBlocked());
  ui.setVoiceIndicator(!!settings.readAloud);

  if (thinking || busy) {
    ui.setStatus("thinking", "Thinking…", "Working on your request");
  } else if (pendingPlan) {
    ui.setStatus("listening", "Waiting for your okay", "Say “yes” to go ahead, or “no” to stop");
  } else if (restricted) {
    ui.setStatus("idle", "Open a website", "and I'll start reading");
  } else if (speech.isPaused()) {
    ui.setStatus("idle", "Paused", "Say “resume” to continue");
  } else if (speech.isSpeaking()) {
    ui.setStatus("idle", "Reading…", "Just start talking — I'll stop and listen");
  } else if (speech.isMicMuted() || speech.isMicBlocked()) {
    ui.setStatus("idle", "Muted", "Tap the mic to turn me back on");
  } else {
    ui.setStatus("listening", "Listening…", "I'm ready — what can I help with?");
  }
}

function returnToListening() {
  if (speech.isMicBlocked()) return;
  if (agentTask || pendingPlan) return;
  if (busy || thinking) return;
  if (speech.isSpeaking()) return;
  if (ui.hasCompose()) return;
  ui.ensureComposeCard();
  updateStatus();
}

// Speak + show a short local note from Sharon (no server round trip).
function sharonSay(text) {
  ui.addSharonReplyCard(text);
  speech.speak(text, { onDone: returnToListening });
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
    returnToListening();
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
function handleUserUtterance(text, conf) {
  text = (text || "").trim();
  if (!text) return;

  const cmd = text.toLowerCase().replace(/[.!?,]+$/g, "").trim();

  // An action plan waiting for the user's okay — yes / no answers it instantly.
  if (pendingPlan) {
    const yes = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|please do|confirm|go for it|sounds good)$/.test(cmd);
    const no = /^(no|nope|nah|stop|cancel|don'?t|do not|never ?mind|wait|hold on)$/.test(cmd);
    if (yes) {
      ui.discardCompose();
      const plan = pendingPlan;
      pendingPlan = null;
      executePlan(plan);
      return;
    }
    if (no) {
      ui.discardCompose();
      cancelAgentTask();
      sharonSay("Okay, I'll leave it.");
      updateStatus();
      return;
    }
    // Anything else = a brand-new request; drop the plan.
    cancelAgentTask();
  }

  // Instant commands fire immediately and never go through the transcript.
  if (tryImmediateCommand(text, cmd)) {
    ui.discardCompose();
    return;
  }

  // Everything else becomes editable transcript content with an auto-send.
  ui.composeAppend(text, conf);
  ui.setStatus("listening", "Got it", "Edit anything, then send");
}

/* ------------------------------------------------------------------ *
 * The main turn — one assist() round trip
 * ------------------------------------------------------------------ */
async function sendTurn(userText, { raw = "", conf = null, showAsUser = true, thinkLabel } = {}) {
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

  const think = ui.showThinkingCard(thinkLabel || "Thinking…");

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

    if (showAsUser) remember("user", userText);
    else remember("user", userText.length > 200 ? userText.slice(0, 200) : userText);
    remember("assistant", result.reply || "");

    renderEvents(result.events || []);

    if (result.plan) {
      startAgentTask(userText, result.plan, agent ? agent._elementList : []);
      return;
    }

    speakReply(result.reply);
  } catch (err) {
    ui.removeCard(think);
    if (err && err.name === "AbortError") return;
    ui.addErrorCard(
      err && err.message ? err.message : "I couldn't reach the server. Check your connection and try again."
    );
  } finally {
    if (abortController === ac) {
      busy = false;
      abortController = null;
    }
    // A just-started page task manages its own thinking state.
    if (!agentTask) thinking = false;
    updateStatus();
    if (!agentTask && !pendingPlan) returnToListening();
  }
}

function speakReply(reply) {
  const text = (reply || "").trim();
  if (!text) return;
  const { lead, body } = ui.splitLead(text);
  if (lead && body) {
    ui.addGistCard(lead);
    ui.addSharonReplyCard(body);
  } else {
    ui.addSharonReplyCard(text);
  }
  speech.speak(text, { onDone: returnToListening });
}

// Turn the backend's tool events into result cards.
function renderEvents(events) {
  for (const e of events) {
    if (!e || !e.ok || !e.data) continue;
    const d = e.data;
    if (d.kind === "saved") {
      ui.addSavedCard(d.content || "", d.entry_type || "note", d.title || "");
    } else if (d.kind === "found" && Array.isArray(d.hits) && d.hits.length) {
      ui.addFoundCard(d.hits);
    } else if (d.kind === "updated") {
      const p = d.patch || {};
      ui.addUpdatedCard(
        p.deleted
          ? "Deleted from your notes"
          : p.status === "done"
          ? "Marked that task done"
          : "Updated your notes"
      );
    }
    // "summarized" needs no card — the summary IS the spoken reply.
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
    ui.addSharonReplyCard(plan.say);
  }

  if (!plan.actions || !plan.actions.length) {
    // Nothing to do — she's answering / finishing.
    if (plan.say) {
      if (agentTask.acted) ui.addActionCard(plan.say);
      speech.speak(plan.say, { onDone: returnToListening });
    }
    cancelAgentTask();
    thinking = false;
    updateStatus();
    return;
  }

  if (settings.confirmActions) {
    pendingPlan = { ...plan, _elements: elementList || [] };
    const desc = page.describePlan(plan.actions, elementList || []);
    updateStatus();
    const ask =
      "I'm about to " + (desc || "act on the page") + '. Say "yes" to go ahead, or "no" to stop.';
    ui.addSharonReplyCard(ask);
    speech.speak(ask);
    return;
  }

  executePlan(plan);
}

async function executePlan(plan) {
  if (!agentTask) return;
  if (plan.say && !settings.confirmActions) speech.speak(plan.say);
  thinking = true;
  ui.setStatus("thinking", "Working…", "On the page");

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
    ui.addActionCard(msg);
    cancelAgentTask();
    thinking = false;
    updateStatus();
    speech.speak(msg, { onDone: returnToListening });
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
  const think = ui.showThinkingCard("Looking at the page…");
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
      if (agentTask.acted) ui.addActionCard(msg);
      else ui.addSharonReplyCard(msg);
      remember("assistant", msg);
      cancelAgentTask();
      thinking = false;
      updateStatus();
      speech.speak(msg, { onDone: returnToListening });
    }
  } catch (err) {
    ui.removeCard(think);
    cancelAgentTask();
    thinking = false;
    updateStatus();
    ui.addErrorCard((err && err.message) || "I couldn't reach the server.");
  }
}

/* ------------------------------------------------------------------ *
 * Auto-read — follow the user across tabs
 * ------------------------------------------------------------------ */
const READ_PAGE_TEXT = "Read me this page.";

async function evaluateActiveTab() {
  const seq = ++evalSeq;
  const tab = await page.getActiveTabReady();
  if (seq !== evalSeq) return;

  if (!tab) ui.setTabTitle("No active tab");
  else if (page.isRestricted(tab.url)) ui.setTabTitle(tab.title || "A browser page");
  else ui.setTabTitle(tab.title || "This page");

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
  await sendTurn(READ_PAGE_TEXT, { showAsUser: false, thinkLabel: "Reading the page…" });
}

/* ------------------------------------------------------------------ *
 * Notes sheet — the database, browsable and editable
 * ------------------------------------------------------------------ */
let notesReqSeq = 0;
async function loadNotes(query) {
  const seq = ++notesReqSeq;
  ui.notesLoading();
  try {
    const hits = await api.searchMemory({ query: query || "", limit: 25, touch: false });
    if (seq !== notesReqSeq) return;
    ui.renderNotes(Array.isArray(hits) ? hits : [], {
      onToggleDone: async (h) => {
        try {
          await api.updateMemory({
            entryId: h.entry_id,
            status: String(h.status) === "done" ? "open" : "done",
          });
          loadNotes(ui.els.noteSearchInput ? ui.els.noteSearchInput.value.trim() : "");
        } catch (e) {
          ui.notesError("Couldn't update that: " + ((e && e.message) || e));
        }
      },
      onDelete: async (h) => {
        try {
          await api.updateMemory({ entryId: h.entry_id, deleted: true });
          loadNotes(ui.els.noteSearchInput ? ui.els.noteSearchInput.value.trim() : "");
        } catch (e) {
          ui.notesError("Couldn't delete that: " + ((e && e.message) || e));
        }
      },
    });
  } catch (e) {
    if (seq !== notesReqSeq) return;
    ui.notesError("I couldn't load your notes — check your connection and try again.");
  }
}

/* ------------------------------------------------------------------ *
 * Wiring: mic buttons, dock, settings, sheets, tabs, shortcut
 * ------------------------------------------------------------------ */
function toggleMic() {
  if (!speech.speechRecognitionAvailable()) {
    ui.addErrorCard("Voice input isn't available in this browser, but I'll still read pages aloud.");
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
    returnToListening();
    return;
  }
  speech.setMicMuted(!speech.isMicMuted());
  updateStatus();
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
  if (e.orb) e.orb.addEventListener("click", toggleMic);
  if (e.dockMic) e.dockMic.addEventListener("click", toggleMic);

  if (e.voiceBtn)
    e.voiceBtn.addEventListener("click", () => {
      settings.readAloud = !settings.readAloud;
      saveSettings();
      if (!settings.readAloud) speech.stopSpeaking();
      ui.setVoiceIndicator(settings.readAloud);
      updateStatus();
    });

  if (e.settingsBtn)
    e.settingsBtn.addEventListener("click", () => {
      applySettingsToUI();
      refreshShortcut();
      ui.openSheet(e.settingsSheet);
    });
  if (e.notesBtn)
    e.notesBtn.addEventListener("click", () => {
      ui.openSheet(e.notesSheet);
      loadNotes("");
    });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", ui.closeSheets));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && document.querySelector(".sheet.open")) ui.closeSheets();
  });

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

  let notesSearchTimer = null;
  if (e.noteSearchInput)
    e.noteSearchInput.addEventListener("input", () => {
      const q = e.noteSearchInput.value.trim();
      if (notesSearchTimer) clearTimeout(notesSearchTimer);
      notesSearchTimer = setTimeout(() => loadNotes(q), 320);
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

  setTimeout(() => ui.hideCoach(), 6000);
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
(async function init() {
  await ensureSessionId();
  await loadSettings();

  ui.initUI({
    onCommit: (content, raw, conf) => {
      sendTurn(content, { raw, conf });
    },
    onDiscard: () => updateStatus(),
  });

  speech.initSpeech({
    getSettings: () => settings,
    onFinal: (text, conf) => {
      ui.clearComposeInterim();
      handleUserUtterance(text, conf);
    },
    onInterim: (text) => {
      ui.showComposeInterim(text);
    },
    onStateChange: () => updateStatus(),
    onMicBlocked: () => {
      ui.addErrorCard(
        "I couldn't access the microphone. Check the browser's mic permission, then tap the mic to try again. I'll keep reading pages in the meantime."
      );
    },
    onVoicesChanged: () => populateVoiceSelect(),
  });

  wireControls();
  ready = true;
  applySettingsToUI();
  updateStatus();
  speech.startRecognition();

  // Open straight into LISTENING: waiting transcript card, no greeting.
  returnToListening();
  evaluateActiveTab();

  // Restore the conversation thread from the Sheet so a reopened panel
  // remembers what you were talking about (best-effort, non-blocking).
  try {
    const turns = await api.getRecentTurns(sessionId, HISTORY_TURNS);
    if (Array.isArray(turns) && !history.length) {
      for (const t of turns) {
        if (t && (t.role === "user" || t.role === "assistant")) remember(t.role, t.content);
      }
    }
  } catch (_) {
    /* fine — she just starts fresh */
  }
})();
