// voice-input/recognizer.js — the FALLBACK speech engine.
//
// It runs inside Sharon's ONE existing hidden offscreen document (offscreen.html
// — created by background.js, shared with the screen recorder). Chrome allows a
// single offscreen document per extension, so this module is a guest: it adds a
// second <script> tag to that page and nothing else. It never reads, writes,
// touches or imports anything in offscreen.js, and the two share no state.
//
// It is the SECOND choice, not the first. Chrome publishes no offscreen reason
// for speech recognition — USER_MEDIA covers getUserMedia() and nothing covers
// the Web Speech API — so recognition here is undocumented and does not work on
// every Chrome build. The overlay therefore tries the in-page extension iframe
// first (recognizer-frame.js) and only asks for this one if that is blocked,
// for instance by a site whose Permissions-Policy refuses to delegate the
// microphone. Between the two, dictation has a working engine everywhere.
//
// The recognition behaviour itself lives in engine.js, shared with the frame
// recognizer, so both paths behave identically.
//
// Protocol (every message prefixed "vi:" so it cannot collide with Sharon's):
//   SW → here:  { t:"vi:off", cmd:"start" | "stop" | "query" }
//   here → SW:  { t:"vi:evt", event:"started" | "result" | "ended" | "error" }

import { createEngine } from "./engine.js";

function emit(event, extra) {
  try {
    chrome.runtime.sendMessage(Object.assign({ t: "vi:evt", event }, extra || {}));
  } catch (_) {
    /* no receiver right now — nothing to do, and nothing to log */
  }
}

const engine = createEngine({
  started: () => emit("started"),
  result: (text) => emit("result", { text }),
  ended: () => emit("ended"),
  error: (error) => emit("error", { error }),
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Not ours (Sharon's screen recorder uses "sr:off") — leave it completely alone.
  if (!msg || typeof msg.t !== "string" || msg.t !== "vi:off") return;
  if (msg.cmd === "query") {
    sendResponse({ live: engine.isLive() });
    return; // synchronous response
  }
  if (msg.cmd === "start") engine.start();
  else if (msg.cmd === "stop") engine.stop();
});
