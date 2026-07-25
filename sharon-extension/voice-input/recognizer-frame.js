// voice-input/recognizer-frame.js — the PRIMARY speech engine, running inside
// the hidden extension iframe that overlay.js puts in the page.
//
// Why here rather than only in Sharon's offscreen document: Chrome has no
// offscreen "reason" for speech recognition (USER_MEDIA covers getUserMedia,
// nothing covers the Web Speech API), so recognition there is undocumented and
// unreliable. An iframe on the extension's own origin is the settled way to do
// this: it holds the microphone permission Sharon was already granted, the
// website it sits in is never prompted and never receives the audio, and the
// API behaves exactly as it does on any ordinary page. The offscreen recognizer
// stays as an automatic fallback (recognizer.js).
//
// Two channels, on purpose:
//
//   CONTROL — postMessage with overlay.js, both ways: ready / start / stop /
//             started / ended / error. Local to the tab, so it works instantly
//             and without waking the service worker. Guarded by a one-time
//             token: any window can postMessage to this frame, so commands
//             without the exact token the overlay sent are ignored. That is
//             what stops a website turning the microphone on by itself.
//
//   WORDS   — chrome.runtime.sendMessage to the service worker, which routes
//             them to the overlay. Extension messaging is invisible to the host
//             page, so what the user dictates is never readable by the website
//             through this channel.

import { createEngine } from "./engine.js";

let token = ""; // set by the overlay's first message; nothing runs without it
let parentOrigin = "*"; // narrowed to the real page origin as soon as we know it

function post(msg) {
  try {
    parent.postMessage(Object.assign({ t: "vi:frame" }, msg), parentOrigin);
  } catch (_) {
    /* the overlay is gone — nothing to say and nowhere to say it */
  }
}

// Transcribed words go the private way, and reuse exactly the route the
// offscreen recognizer uses, so the service worker needs no new cases.
function sendWords(text) {
  try {
    chrome.runtime.sendMessage({ t: "vi:evt", event: "result", text });
  } catch (_) {
    /* the worker is restarting — the next phrase will land */
  }
}

const engine = createEngine({
  started: () => post({ event: "started" }),
  result: (text) => sendWords(text),
  ended: () => post({ event: "ended" }),
  error: (error) => post({ event: "error", error }),
});

window.addEventListener("message", (ev) => {
  const msg = ev && ev.data;
  if (!msg || msg.t !== "vi:frame" || ev.source !== parent) return;

  // The handshake: the overlay introduces itself, hands over the token for
  // this page, and tells us where to send replies.
  if (msg.cmd === "hello") {
    if (typeof msg.token !== "string" || !msg.token) return;
    token = msg.token;
    if (typeof msg.origin === "string" && msg.origin && msg.origin !== "null") parentOrigin = msg.origin;
    post({ event: "ready", token });
    return;
  }

  if (!token || msg.token !== token) return; // not from our overlay — ignore
  if (msg.cmd === "start") engine.start();
  else if (msg.cmd === "stop") engine.stop();
});

// Announce ourselves in case the overlay was listening before this loaded.
// Carries nothing but the fact that the frame is alive.
post({ event: "ready" });
