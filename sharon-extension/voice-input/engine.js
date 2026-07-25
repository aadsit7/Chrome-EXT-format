// voice-input/engine.js — the speech engine, and the ONE place recognition
// behaviour is defined. Both recognizers import it:
//
//   recognizer-frame.js   inside the hidden extension iframe in the page  (primary)
//   recognizer.js         inside Sharon's offscreen document              (fallback)
//
// Everything that makes dictation feel reliable lives here:
//
//   • continuous = true. The engine stays open across pauses instead of
//     stopping after every phrase. Restarting between phrases is what loses
//     words — the microphone is deaf for the whole restart, so anything said
//     in that gap is gone. One long session has no gaps.
//   • interimResults = false. Only settled words are ever handed back, so
//     nothing half-heard is typed into a page.
//   • Errors are sorted into fatal and recoverable. Only a refused microphone
//     is fatal. Silence ("no-speech"), a dropped connection ("network"), a
//     device hiccup ("audio-capture") and our own aborts all recover, with a
//     backoff so a genuinely broken connection doesn't spin.
//   • A watchdog. Chrome's recognizer can die without firing "end" — every two
//     seconds this notices a session that should be running and isn't, and
//     starts it again. This is what makes a long dictation survive.

export function createEngine(handlers) {
  const SR = self.webkitSpeechRecognition || self.SpeechRecognition;

  // A refused microphone is the only thing the user must act on; a language
  // the engine can't serve is equally pointless to retry.
  const FATAL = new Set(["not-allowed", "service-not-allowed", "language-not-supported"]);
  const MAX_NET_ERRORS = 5; // consecutive dropped connections before giving up
  const WATCHDOG_MS = 2000;

  let rec = null;
  let live = false; // is a dictation session open?
  let running = false; // is the engine actually listening right now?
  let starting = false; // start() called, waiting for onstart
  let announced = false; // "started" is emitted once per session
  let netErrors = 0;
  let backoff = 100;
  let timer = null;
  let watchdog = null;

  function emit(name, arg) {
    try {
      const fn = handlers && handlers[name];
      if (typeof fn === "function") fn(arg);
    } catch (_) {
      /* a handler that throws must never take the engine down */
    }
  }

  function build() {
    const r = new SR();
    r.continuous = true; // stay open across pauses — no words lost in a restart
    r.interimResults = false; // only settled words leave this module
    r.maxAlternatives = 1;
    try {
      r.lang = navigator.language || "en-US";
    } catch (_) {
      r.lang = "en-US";
    }

    r.onstart = () => {
      starting = false;
      running = true;
      backoff = 100;
      if (!announced) {
        announced = true;
        emit("started"); // the mic is genuinely open — now the button may go red
      }
    };

    r.onresult = (ev) => {
      if (!live) return; // a stale recognizer from a finished session
      netErrors = 0; // words are arriving; whatever went wrong before is over
      backoff = 100;
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
      if (text) emit("result", text);
    };

    r.onerror = (ev) => {
      if (!live) return; // the session is already over — say nothing twice
      const code = (ev && ev.error) || "unknown";
      starting = false;
      // An error means this run is finished, whether or not "end" ever comes.
      // Clearing `running` here is what lets the watchdog revive a session that
      // dies silently — Chrome does not always follow an error with an end.
      running = false;
      if (FATAL.has(code)) {
        live = false;
        emit("error", code);
        return;
      }
      if (code === "network") {
        netErrors++;
        if (netErrors >= MAX_NET_ERRORS) {
          live = false;
          emit("error", "network"); // genuinely offline — say so and stop
          return;
        }
        backoff = Math.min(400 * netErrors, 2500);
        return;
      }
      // "no-speech" is just a quiet room and "aborted" is usually our own stop.
      backoff = code === "no-speech" ? 100 : 400;
    };

    r.onend = () => {
      starting = false;
      running = false;
      if (!live) {
        emit("ended");
        return;
      }
      schedule(); // the session is still open — get straight back to listening
    };

    return r;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      begin();
    }, backoff);
  }

  function begin() {
    if (!live || starting || running) return;
    try {
      if (!rec) rec = build();
      starting = true;
      rec.start();
    } catch (_) {
      // start() throws while the previous run is still winding down. Back off
      // and come again — the watchdog is the final safety net.
      starting = false;
      backoff = Math.min(backoff * 2, 2000);
      schedule();
    }
  }

  return {
    start() {
      if (!SR) {
        emit("error", "unsupported");
        return false;
      }
      if (live) return true;
      live = true;
      announced = false;
      netErrors = 0;
      backoff = 100;
      begin();
      if (!watchdog) {
        watchdog = setInterval(() => {
          if (!live) return;
          if (!running && !starting && !timer) begin(); // it died without a word
        }, WATCHDOG_MS);
      }
      return true;
    },

    stop() {
      const was = live;
      live = false;
      starting = false;
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (watchdog) {
        clearInterval(watchdog);
        watchdog = null;
      }
      try {
        if (rec) rec.abort(); // abort, not stop: drop anything half-heard
      } catch (_) {
        /* ignore */
      }
      if (was) emit("ended");
    },

    isLive() {
      return live;
    },
  };
}
