// voice-input/recognizer.js — the Voice Input Overlay's speech engine.
//
// It runs inside Sharon's ONE existing hidden offscreen document (offscreen.html
// — created by background.js, shared with the screen recorder). Chrome allows a
// single offscreen document per extension, so this module is a guest: it adds a
// second <script> tag to that page and nothing else. It never reads, writes,
// touches or imports anything in offscreen.js, and the two share no state.
//
// Why it lives here at all: a content script cannot open the microphone on an
// arbitrary page without asking that page's own permission. The extension
// already holds the microphone permission (Sharon asks for it during first-run
// setup), and an offscreen document runs on the extension's origin — so
// recognition started here just works, on any site, with no second prompt.
//
// Protocol (every message prefixed "vi:" so it cannot collide with Sharon's):
//   SW → here:  { t:"vi:off", cmd:"start" | "stop" | "query" }
//   here → SW:  { t:"vi:evt", event:"started" | "result" | "ended" | "error" }
//
// continuous = false and interimResults = false: one settled phrase at a time,
// no half-heard words ever typed into the page. The button is a toggle, so
// while a session is live this module restarts the engine after each phrase;
// the session ends only when the user taps the button again (or something
// fails). That keeps every result final while still letting you dictate more
// than one sentence per tap.

const SR = self.webkitSpeechRecognition || self.SpeechRecognition;
const RESTART_MS = 120; // breath between phrases — short, so no words fall in the gap
const RETRY_MS = 350; // the engine wasn't ready yet; come back once

let rec = null;
let live = false; // is a dictation session open?
let starting = false; // start() is asynchronous — don't double-start
let restartTimer = null;

function emit(event, extra) {
  try {
    chrome.runtime.sendMessage(Object.assign({ t: "vi:evt", event }, extra || {}));
  } catch (_) {
    /* no receiver right now — nothing to do, and nothing to log */
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Not ours (Sharon's screen recorder uses "sr:off") — leave it completely alone.
  if (!msg || typeof msg.t !== "string" || msg.t !== "vi:off") return;
  if (msg.cmd === "query") {
    sendResponse({ live });
    return; // synchronous response
  }
  if (msg.cmd === "start") startRec();
  else if (msg.cmd === "stop") stopRec();
});

function build() {
  const r = new SR();
  r.continuous = false;
  r.interimResults = false;
  r.maxAlternatives = 1;
  try {
    r.lang = navigator.language || "en-US";
  } catch (_) {
    r.lang = "en-US";
  }

  r.onstart = () => {
    starting = false;
  };

  r.onresult = (ev) => {
    let text = "";
    try {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res && res.isFinal && res[0]) text += res[0].transcript;
      }
    } catch (_) {
      text = "";
    }
    text = text.trim();
    if (text) emit("result", { text });
  };

  r.onerror = (ev) => {
    const code = (ev && ev.error) || "unknown";
    starting = false;
    // "no-speech" is ordinary silence and "aborted" is our own stop — neither
    // ends the session; onend restarts. Everything else is fatal for this run.
    if (code === "no-speech" || code === "aborted") return;
    live = false;
    emit("error", { error: code });
  };

  r.onend = () => {
    starting = false;
    if (!live) {
      emit("ended");
      return;
    }
    // continuous = false means the engine stops after every phrase. Bring it
    // straight back so one tap dictates as long as the user wants.
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (live) begin();
    }, RESTART_MS);
  };

  return r;
}

function begin(retried) {
  if (starting) return;
  try {
    if (!rec) rec = build();
    starting = true;
    rec.start();
  } catch (_) {
    // start() throws while the engine is still winding down from the last
    // phrase. One more try, a moment later, keeps a long dictation from
    // stopping mid-sentence.
    starting = false;
    if (live && !retried) {
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (live) begin(true);
      }, RETRY_MS);
    }
  }
}

function startRec() {
  if (!SR) {
    live = false;
    emit("error", { error: "unsupported" });
    return;
  }
  if (live) return;
  live = true;
  emit("started");
  begin();
}

function stopRec() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const wasLive = live;
  live = false;
  starting = false;
  try {
    if (rec) rec.abort(); // abort, not stop: drop anything half-heard
  } catch (_) {
    /* ignore */
  }
  if (wasLive) emit("ended");
}
