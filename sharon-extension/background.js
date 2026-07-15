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
  // Ask an already-open panel to wake the mic. A freshly-opened panel wakes the
  // mic itself on boot, so a missing receiver here is fine — swallow the error.
  try {
    await chrome.runtime.sendMessage({ type: "sharon-activate" });
  } catch (_) {
    /* no panel listening yet — it will go live on its own */
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
        reasons: ["DISPLAY_MEDIA"],
        justification:
          "Record the current screen in the background so the recording keeps going when the side panel is closed.",
      })
      .catch(() => {});
  }
  await creatingOffscreen;
  creatingOffscreen = null;
  return true;
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
    const ok = await ensureOffscreen();
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
          const ok = await ensureOffscreen();
          if (ok) chrome.runtime.sendMessage({ t: "sr:off", cmd: "start" }).catch(() => {});
          sendResponse({ ok });
        } else if (msg.cmd === "stop") {
          chrome.runtime.sendMessage({ t: "sr:off", cmd: "stop" }).catch(() => {});
          sendResponse({ ok: true });
        } else if (msg.cmd === "clear") {
          chrome.runtime.sendMessage({ t: "sr:off", cmd: "clear" }).catch(() => {});
          setRecBadge(false);
          await closeOffscreen();
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
