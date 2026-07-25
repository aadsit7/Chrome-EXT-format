// background.js — service worker for Sharon (Manifest V3).
//
// Its jobs:
//   1. Make clicking the toolbar icon open Sharon's side panel.
//   2. Open Sharon's side panel (and wake her mic) from the keyboard shortcut.
//   3. Coordinate the BACKGROUND screen recorder: own the offscreen document
//      (offscreen.js) that keeps a screen recording running even when the side
//      panel is collapsed, and show a red dot on the toolbar icon while it
//      records. The side panel sends commands; the offscreen document reports
//      events; this worker routes between them and drives the badge.

function enableOpenOnClick() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.warn("Sharon: setPanelBehavior failed", err));
  }
}

chrome.runtime.onInstalled.addListener(enableOpenOnClick);
chrome.runtime.onStartup.addListener(enableOpenOnClick);

// Keyboard shortcut → open Sharon for the current window and set her mic live.
// If anything goes wrong we fail quietly; the toolbar icon still works.
async function activateSharon() {
  try {
    const win = await chrome.windows.getCurrent();
    const windowId = win && win.id;
    if (chrome.sidePanel && chrome.sidePanel.open && windowId != null) {
      await chrome.sidePanel.open({ windowId });
    }
  } catch (_) {
    // Couldn't open the panel — nothing more to do, the toolbar icon still works.
    return;
  }
  // Ask an already-open panel to wake the mic. A freshly-opened panel boots
  // with the mic MUTED (the voice assistant is opt-in), so a missing receiver
  // just means the panel opens quiet and the next press — or a tap on the mic
  // button — turns her on. Swallow the error.
  try {
    await chrome.runtime.sendMessage({ type: "sharon-activate" });
  } catch (_) {
    /* no panel listening yet — it opens muted; the user unmutes with a tap */
  }
}

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === "activate-sharon") activateSharon();
    else if (command === "toggle-screen-recording") toggleScreenRecFromCommand();
    else if (command === "pause-screen-recording") pauseScreenRecFromCommand();
  });
}

/* ------------------------------------------------------------------ *
 * Background screen recorder — offscreen document + red-dot badge
 *
 * The recording itself lives in a hidden offscreen document (offscreen.js) so
 * it survives the side panel being collapsed. This worker just:
 *   • creates / closes that offscreen document,
 *   • relays the side panel's commands to it and its state back,
 *   • lights a red dot on the toolbar icon while a recording is in progress.
 * The badge is browser state, so it stays lit even if this worker is
 * suspended mid-recording; the offscreen's next event wakes the worker to
 * update it.
 * ------------------------------------------------------------------ */
const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreen = null;

// Chrome allows exactly ONE offscreen document per extension, and Sharon now
// has two features living inside it: the screen recorder (offscreen.js) and the
// voice-input recognizer (voice-input/recognizer.js). This is the only place
// that document is ever created — a second createDocument() call would throw
// and silently kill whichever feature made it.
async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  try {
    if (await chrome.offscreen.hasDocument()) return true;
  } catch (_) {
    /* fall through to create */
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["DISPLAY_MEDIA", "USER_MEDIA"],
        justification:
          "Record the current screen in the background so the recording keeps going when the side panel is closed, and run speech-to-text for voice input into page text fields.",
      })
      .catch(() => {});
  }
  await creatingOffscreen;
  creatingOffscreen = null;
  return true;
}

// Who currently needs the shared document: "screenrec", "dictation". It is
// closed only when the last user lets go, so ending a screen recording can
// never pull the page out from under a dictation in progress (or the reverse).
const offscreenUsers = new Set();

async function acquireOffscreen(user) {
  offscreenUsers.add(user);
  const ok = await ensureOffscreen();
  if (!ok) offscreenUsers.delete(user);
  return ok;
}

async function releaseOffscreen(user) {
  offscreenUsers.delete(user);
  if (offscreenUsers.size) return; // someone else is still using it
  // This worker can be suspended and restarted mid-session, which empties the
  // set above. So don't trust the count alone: ask the two features inside the
  // document whether they are actually busy. Either one still working wins.
  if (await dictationLive()) return;
  if (await screenRecBusy()) return;
  await closeOffscreen();
}

// Is the screen recorder mid-flow (recording, or holding a finished clip)?
async function screenRecBusy() {
  try {
    if (!chrome.offscreen || !(await chrome.offscreen.hasDocument())) return false;
    const st = await chrome.runtime.sendMessage({ t: "sr:off", cmd: "query" });
    return !!(st && st.phase && st.phase !== "idle");
  } catch (_) {
    return false;
  }
}

async function closeOffscreen() {
  try {
    if (chrome.offscreen && (await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.closeDocument();
    }
  } catch (_) {
    /* ignore */
  }
}

// The recording dot on the toolbar icon: red "●" while recording, amber "❚❚"
// while paused, cleared when idle. (true is accepted as "recording" for the
// existing call sites.)
function setRecBadge(state) {
  if (!chrome.action) return;
  if (state === true) state = "recording";
  try {
    if (state === "recording") {
      chrome.action.setBadgeBackgroundColor({ color: "#E5484D" });
      if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
      chrome.action.setBadgeText({ text: "●" });
      chrome.action.setTitle({ title: "Sharon — recording your screen" });
    } else if (state === "paused") {
      chrome.action.setBadgeBackgroundColor({ color: "#B7791F" });
      if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
      chrome.action.setBadgeText({ text: "❚❚" });
      chrome.action.setTitle({ title: "Sharon — screen recording paused" });
    } else {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: "Sharon" });
    }
  } catch (_) {
    /* ignore */
  }
}

// Query the offscreen recorder's current state (for the keyboard commands,
// which run with no side panel open).
async function queryOffscreenState() {
  try {
    if (chrome.offscreen && (await chrome.offscreen.hasDocument())) {
      const st = await chrome.runtime.sendMessage({ t: "sr:off", cmd: "query" });
      if (st && st.phase) return st;
    }
  } catch (_) {
    /* no offscreen / no response */
  }
  return { phase: "idle" };
}

// Keyboard shortcut: start (if idle) or stop (if recording), even with the
// side panel closed. If a finished clip is waiting (phase "ready") or the
// picker is open ("starting"), do nothing — the pending clip is protected.
async function toggleScreenRecFromCommand() {
  const st = await queryOffscreenState();
  if (st.phase === "recording") {
    chrome.runtime.sendMessage({ t: "sr:off", cmd: "stop" }).catch(() => {});
  } else if (st.phase === "idle") {
    const ok = await acquireOffscreen("screenrec");
    if (ok) chrome.runtime.sendMessage({ t: "sr:off", cmd: "start" }).catch(() => {});
  }
}

// Keyboard shortcut: pause ↔ resume the current recording, with the side panel
// closed. Only meaningful while recording.
async function pauseScreenRecFromCommand() {
  const st = await queryOffscreenState();
  if (st.phase === "recording") {
    chrome.runtime.sendMessage({ t: "sr:off", cmd: "togglepause" }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== "string") return; // not a screen-recorder message

  // Commands from the side panel → drive the offscreen recorder.
  if (msg.t === "sr:cmd") {
    (async () => {
      try {
        if (msg.cmd === "start") {
          const ok = await acquireOffscreen("screenrec");
          if (ok) chrome.runtime.sendMessage({ t: "sr:off", cmd: "start" }).catch(() => {});
          sendResponse({ ok });
        } else if (msg.cmd === "stop") {
          chrome.runtime.sendMessage({ t: "sr:off", cmd: "stop" }).catch(() => {});
          sendResponse({ ok: true });
        } else if (msg.cmd === "clear") {
          chrome.runtime.sendMessage({ t: "sr:off", cmd: "clear" }).catch(() => {});
          setRecBadge(false);
          await releaseOffscreen("screenrec"); // closes ONLY if nothing else needs it
          sendResponse({ ok: true });
        } else if (msg.cmd === "query") {
          let state = { phase: "idle" };
          try {
            if (chrome.offscreen && (await chrome.offscreen.hasDocument())) {
              const st = await chrome.runtime.sendMessage({ t: "sr:off", cmd: "query" });
              if (st && st.phase) state = st;
            }
          } catch (_) {
            /* no offscreen / no response — treat as idle */
          }
          sendResponse(state);
        } else {
          sendResponse({ ok: false });
        }
      } catch (_) {
        sendResponse({ ok: false });
      }
    })();
    return true; // async sendResponse
  }

  // Events from the offscreen recorder → keep the badge in step. (The side
  // panel listens for these too, for its own UI.)
  if (msg.t === "sr:evt") {
    if (msg.event === "started" || msg.event === "resumed") setRecBadge("recording");
    else if (msg.event === "paused") setRecBadge("paused");
    else if (msg.event === "stopped" || msg.event === "error" || msg.event === "cancelled") {
      setRecBadge(false);
    }
    return; // no response
  }
});

/* ------------------------------------------------------------------ *
 * Voice Input Overlay — the mic button inside page text fields
 *
 * A separate listener with its own "vi:" message namespace: nothing above is
 * renamed, rerouted or shared. This worker is the switchboard between three
 * places that cannot talk to each other directly:
 *
 *   the page      voice-input/overlay.js  (content script, per tab/frame)
 *   the engine    voice-input/recognizer.js (inside the ONE offscreen document)
 *   Sharon        sidepanel.js            (her mode manager)
 *
 * Before any dictation starts, Sharon gets a say: if her side panel is open she
 * enters DICTATING (her ears and voice go quiet), and if she is mid-recording
 * she refuses outright. If the panel is closed there is nothing to coordinate
 * and dictation simply proceeds.
 * ------------------------------------------------------------------ */
let dictating = null; // { tabId, frameId } — at most one dictation at a time

// Is the recognizer actually running right now? (Survives this worker being
// suspended and restarted, which in-memory flags do not.)
async function dictationLive() {
  try {
    if (!chrome.offscreen || !(await chrome.offscreen.hasDocument())) return false;
    const st = await chrome.runtime.sendMessage({ t: "vi:off", cmd: "query" });
    return !!(st && st.live);
  } catch (_) {
    return false;
  }
}

// Ask Sharon's side panel to enter/leave DICTATING. Three outcomes:
//   { ok:true }               she stood down — go ahead
//   { ok:false, reason }      she is busy recording — refuse
//   null                      no panel open — nothing to coordinate, go ahead
async function tellSharon(cmd) {
  try {
    const res = await chrome.runtime.sendMessage({ t: "vi:mode", cmd });
    return res && typeof res === "object" ? res : null;
  } catch (_) {
    return null; // panel closed
  }
}

// Send one message to the exact frame that owns the mic button.
function toOverlay(msg) {
  if (!dictating || !chrome.tabs) return;
  try {
    chrome.tabs.sendMessage(dictating.tabId, msg, { frameId: dictating.frameId }).catch(() => {});
  } catch (_) {
    /* the tab or frame is gone — the next stop tidies up */
  }
}

async function startDictation(tabId, frameId) {
  if (dictating) await stopDictation(); // one at a time, always
  const sharon = await tellSharon("begin");
  if (sharon && sharon.ok === false) return { ok: false, reason: sharon.reason || "busy" };

  const ok = await acquireOffscreen("dictation");
  if (!ok) {
    await tellSharon("end");
    return { ok: false, reason: "unavailable" };
  }
  dictating = { tabId, frameId };
  // A freshly created offscreen document may not have run its module scripts
  // yet, so the first command can land before anyone is listening. Confirm the
  // recognizer really started, and try once more if it didn't.
  const started = await startRecognizer();
  if (!started) {
    // If the recognizer failed outright (no microphone, say) it already sent
    // the page a vi:error and cleared the session — don't talk over that
    // message with a second, vaguer one.
    const alreadyReported = !dictating;
    await stopDictation();
    return { ok: false, reason: alreadyReported ? "silent" : "unavailable" };
  }
  return { ok: true };
}

async function startRecognizer() {
  for (let attempt = 0; attempt < 2; attempt++) {
    chrome.runtime.sendMessage({ t: "vi:off", cmd: "start" }).catch(() => {});
    await new Promise((r) => setTimeout(r, attempt ? 300 : 150));
    if (!dictating) return false; // an error ended the session while we waited
    if (await dictationLive()) return true;
  }
  return false;
}

// Always does the full tidy-up, even if this worker restarted and forgot which
// tab was dictating: silence the recognizer, hand Sharon her ears back, let go
// of the shared document. Safe to call when nothing is running.
async function stopDictation() {
  dictating = null;
  chrome.runtime.sendMessage({ t: "vi:off", cmd: "stop" }).catch(() => {});
  await tellSharon("end"); // Sharon goes back to LISTENING and resumes normally
  await releaseOffscreen("dictation");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== "string" || msg.t.lastIndexOf("vi:", 0) !== 0) return;

  // From the page: start / stop / "open Sharon so I can allow the mic".
  if (msg.t === "vi:start") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ ok: false, reason: "unavailable" });
      return; // not from a page
    }
    startDictation(tabId, sender.frameId || 0).then(sendResponse, () =>
      sendResponse({ ok: false, reason: "unavailable" })
    );
    return true; // async sendResponse
  }

  if (msg.t === "vi:stop") {
    stopDictation().then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: true })
    );
    return true;
  }

  if (msg.t === "vi:open-panel") {
    // Sharon already asks for the microphone in her first-run setup and in
    // Settings — this feature never asks on its own, it just opens her.
    (async () => {
      try {
        const windowId = sender && sender.tab && sender.tab.windowId;
        if (chrome.sidePanel && chrome.sidePanel.open && windowId != null) {
          await chrome.sidePanel.open({ windowId });
        }
      } catch (_) {
        /* fail quietly — the toolbar icon still opens her */
      }
    })();
    return; // no response
  }

  // From the recognizer in the offscreen document → back to the page.
  if (msg.t === "vi:evt") {
    if (msg.event === "started") toOverlay({ t: "vi:started" });
    else if (msg.event === "result") toOverlay({ t: "vi:result", text: msg.text || "" });
    else if (msg.event === "ended") toOverlay({ t: "vi:ended" });
    else if (msg.event === "error") {
      toOverlay({ t: "vi:error", error: msg.error || "unknown" });
      stopDictation(); // a failed session releases Sharon and the document
    }
    return; // no response
  }
});

// The page holding the mic button went away — end the session and let Sharon
// start listening again.
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (dictating && dictating.tabId === tabId) stopDictation();
  });
}
