// speech.js — Sharon's ears and voice, with real turn-taking.
//
// The rules of the conversation:
//   1. Sharon NEVER talks over you. If you start speaking while she's
//      reading, she immediately holds (pauses) her voice. If it turns out to
//      be a real utterance she stops entirely and listens; if it was just a
//      cough / her own echo, she resumes on her own.
//   2. She never STARTS speaking while you're mid-sentence — a reply that
//      arrives while you're still talking waits for you to finish.
//   3. While she is speaking, her own voice picked up by the mic (the echo)
//      is filtered out so only YOUR interruptions count.
//
// This module is UI-free: the orchestrator registers callbacks.

const synth = window.speechSynthesis;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const MAX_CHUNK_CHARS = 220; // dodge Chrome's ~15s single-utterance cutoff
const HOLD_RESUME_MS = 1400; // resume if an interruption never becomes final
const QUIET_GAP_MS = 700; // how long after your last word Sharon may speak
const WAIT_TO_SPEAK_MAX_MS = 6000;

let cb = {
  getSettings: () => ({ readAloud: true, voiceName: "", voiceRate: 0.95 }),
  onFinal: () => {},
  onInterim: () => {},
  onStateChange: () => {},
  onMicBlocked: () => {},
  onVoicesChanged: () => {},
};

export function initSpeech(callbacks) {
  cb = { ...cb, ...callbacks };
  if (synth) {
    synth.addEventListener("voiceschanged", loadVoices);
    loadVoices();
  }
}

/* ------------------------------------------------------------------ *
 * Voices — ranked chooser (natural > neural > online > google > known)
 * ------------------------------------------------------------------ */
let availableVoices = [];
let voicesReadyWaiters = [];

function getVoices() {
  if (!synth) return [];
  try {
    return synth.getVoices() || [];
  } catch (_) {
    return [];
  }
}

function loadVoices() {
  availableVoices = getVoices();
  cb.onVoicesChanged();
  if (availableVoices.length && voicesReadyWaiters.length) {
    const waiters = voicesReadyWaiters;
    voicesReadyWaiters = [];
    waiters.forEach((fn) => {
      try {
        fn();
      } catch (_) {
        /* ignore */
      }
    });
  }
}

function whenVoicesReady(fn) {
  if (getVoices().length) {
    fn();
    return;
  }
  voicesReadyWaiters.push(fn);
  setTimeout(() => {
    const i = voicesReadyWaiters.indexOf(fn);
    if (i >= 0) {
      voicesReadyWaiters.splice(i, 1);
      fn();
    }
  }, 1200);
}

function isFemaleVoice(name) {
  return /female|woman|samantha|aria|jenny|libby|sonia|emma|zira|susan|allison|ava|joanna|salli|kendra|kimberly|fiona|tessa|karen|moira|serena|catherine|hazel/i.test(
    name
  );
}
function isMaleVoice(name) {
  return /\bmale\b|\bman\b|david|guy|mark|george|james|ryan|brandon|fred|daniel|oliver|thomas|william|alex|aaron/i.test(
    name
  );
}

export function scoreVoice(v) {
  const name = v.name || "";
  const n = name.toLowerCase();
  let score;
  if (n.includes("natural")) score = 100;
  else if (n.includes("neural")) score = 90;
  else if (n.includes("online")) score = 80;
  else if (n.includes("google")) score = 70;
  else if (/\b(samantha|aria|jenny|libby|sonia|emma)\b/.test(n)) score = 60;
  else if (/^en[-_]us/i.test(v.lang)) score = 30;
  else score = 10;

  if (/^en[-_]us/i.test(v.lang)) score += 5;
  else if (/^en[-_]gb/i.test(v.lang)) score += 3;

  if (isFemaleVoice(name)) score += 2;
  if (isMaleVoice(name)) score -= 2;
  return score;
}

export function englishVoicesSorted() {
  const voices = availableVoices.length ? availableVoices : getVoices();
  return voices
    .filter((v) => /^en/i.test(v.lang))
    .slice()
    .sort((a, b) => scoreVoice(b) - scoreVoice(a));
}

export function friendlyVoiceName(v) {
  let label = (v.name || "Voice").replace(/^Microsoft\s+/i, "");
  const loc = /^en[-_]gb/i.test(v.lang) ? " · UK" : /^en[-_]us/i.test(v.lang) ? " · US" : "";
  return label + loc;
}

function resolveVoice() {
  const voices = availableVoices.length ? availableVoices : getVoices();
  if (!voices.length) return null;
  const want = (cb.getSettings().voiceName || "").trim();
  if (want) {
    const exact = voices.find((v) => v.name === want);
    if (exact) return exact;
  }
  const sorted = englishVoicesSorted();
  return sorted.length ? sorted[0] : null;
}

function clampRate(r) {
  const n = typeof r === "number" && !Number.isNaN(r) ? r : 0.95;
  return Math.min(1.2, Math.max(0.7, n));
}

/* ------------------------------------------------------------------ *
 * Speaking (TTS) — sentence-chunked queue with hold/resume turn-taking
 * ------------------------------------------------------------------ */
let speakSeq = 0;
let speaking = false;
let paused = false; // user said "pause" (explicit)
let holding = false; // auto-held because the user started talking
let holdTimer = null;
let currentSpokenText = "";
let onDoneSpeaking = null; // one-shot callback when the current reply ends

function splitSentences(text) {
  const out = (text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : [(text || "").trim()].filter(Boolean);
}

function chunkForSpeech(text) {
  const chunks = [];
  let buf = "";
  for (let s of splitSentences(text)) {
    while (s.length > MAX_CHUNK_CHARS) {
      let cut = s.lastIndexOf(" ", MAX_CHUNK_CHARS);
      if (cut < MAX_CHUNK_CHARS * 0.6) cut = MAX_CHUNK_CHARS;
      chunks.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (!s) continue;
    if (!buf) buf = s;
    else if ((buf + " " + s).length <= MAX_CHUNK_CHARS) buf += " " + s;
    else {
      chunks.push(buf);
      buf = s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [(text || "").trim()].filter(Boolean);
}

export function isSpeaking() {
  return speaking;
}
export function isPaused() {
  return paused;
}

function clearHold() {
  holding = false;
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
}

export function speak(text, { onDone } = {}) {
  const full = (text || "").trim();
  onDoneSpeaking = onDone || null;
  if (!synth || !cb.getSettings().readAloud || !full) {
    // Nothing will be spoken — settle, then signal completion.
    const done = onDoneSpeaking;
    onDoneSpeaking = null;
    queueMicrotask(() => done && done());
    return;
  }

  const mySeq = ++speakSeq;
  synth.cancel();
  clearHold();

  const chunks = chunkForSpeech(full);
  currentSpokenText = full;
  speaking = true;
  paused = false;
  cb.onStateChange();

  const finishAll = () => {
    if (mySeq !== speakSeq) return;
    speaking = false;
    paused = false;
    clearHold();
    currentSpokenText = "";
    cb.onStateChange();
    const done = onDoneSpeaking;
    onDoneSpeaking = null;
    if (done) done();
  };

  const startQueue = () => {
    if (mySeq !== speakSeq) return;
    const voice = resolveVoice();
    const rate = clampRate(cb.getSettings().voiceRate);
    let i = 0;
    const speakNext = () => {
      if (mySeq !== speakSeq) return;
      if (i >= chunks.length) {
        finishAll();
        return;
      }
      const utt = new SpeechSynthesisUtterance(chunks[i++]);
      if (voice) {
        utt.voice = voice;
        utt.lang = voice.lang;
      } else {
        utt.lang = "en-US";
      }
      utt.rate = rate;
      utt.pitch = 1;
      utt.volume = 1;
      utt.onend = () => {
        if (mySeq !== speakSeq) return;
        speakNext();
      };
      utt.onerror = () => {
        if (mySeq !== speakSeq) return;
        speakNext();
      };
      synth.speak(utt);
    };
    speakNext();
  };

  // Turn-taking rule 2: never START talking while the user is mid-sentence.
  const begin = () => {
    if (mySeq !== speakSeq) return;
    const waitedSince = Date.now();
    const tryStart = () => {
      if (mySeq !== speakSeq) return;
      const quiet = Date.now() - lastHeardAt > QUIET_GAP_MS;
      if (quiet || Date.now() - waitedSince > WAIT_TO_SPEAK_MAX_MS) {
        startQueue();
      } else {
        setTimeout(tryStart, 200);
      }
    };
    tryStart();
  };

  if (getVoices().length) begin();
  else whenVoicesReady(begin);
}

export function stopSpeaking() {
  speakSeq++;
  if (synth) synth.cancel();
  speaking = false;
  paused = false;
  clearHold();
  currentSpokenText = "";
  onDoneSpeaking = null;
}

export function pauseSpeaking() {
  if (synth && synth.speaking && !synth.paused) {
    synth.pause();
    paused = true;
    cb.onStateChange();
  }
}

export function resumeSpeaking() {
  if (synth && synth.paused) {
    synth.resume();
    paused = false;
    holding = false;
    cb.onStateChange();
  }
}

// Turn-taking rule 1: the user started talking while Sharon speaks — hold her
// voice instantly. If no real (final) utterance follows, resume quietly.
function holdForUser() {
  if (!speaking || paused || holding) {
    if (holding && holdTimer) {
      // keep extending the hold while interim results keep arriving
      clearTimeout(holdTimer);
      holdTimer = setTimeout(resumeFromHold, HOLD_RESUME_MS);
    }
    return;
  }
  holding = true;
  try {
    synth.pause();
  } catch (_) {
    /* ignore */
  }
  holdTimer = setTimeout(resumeFromHold, HOLD_RESUME_MS);
}

function resumeFromHold() {
  holdTimer = null;
  if (!holding) return;
  holding = false;
  if (speaking && !paused && synth && synth.paused) {
    try {
      synth.resume();
    } catch (_) {
      /* ignore */
    }
  }
}

export function previewVoice() {
  if (!synth) return;
  stopSpeaking();
  const sample = "Hi, I'm Sharon. This is how I'll sound when I read your pages aloud.";
  const go = () => {
    const utt = new SpeechSynthesisUtterance(sample);
    const voice = resolveVoice();
    if (voice) {
      utt.voice = voice;
      utt.lang = voice.lang;
    } else {
      utt.lang = "en-US";
    }
    utt.rate = clampRate(cb.getSettings().voiceRate);
    currentSpokenText = sample;
    speaking = true;
    cb.onStateChange();
    const done = () => {
      speaking = false;
      paused = false;
      currentSpokenText = "";
      cb.onStateChange();
    };
    utt.onend = done;
    utt.onerror = done;
    synth.speak(utt);
  };
  if (getVoices().length) go();
  else whenVoicesReady(go);
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
  if (!currentSpokenText) return false;
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
 * Listening (ASR) — continuous while the mic is live
 * ------------------------------------------------------------------ */
let recognition = null;
let recognizing = false;
let micMuted = false;
let micBlocked = false;
let lastHeardAt = 0; // last time we heard the USER (non-echo)

export function speechRecognitionAvailable() {
  return !!SpeechRecognition;
}
export function isMicMuted() {
  return micMuted;
}
export function isMicBlocked() {
  return micBlocked;
}

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
      lastHeardAt = Date.now();
      if (speaking) holdForUser(); // yield the floor immediately
      cb.onInterim(show);
    }

    if (final.trim()) {
      const text = final.trim();
      if (speaking && isEchoOfSpeech(text)) return; // her own voice — ignore
      lastHeardAt = Date.now();
      clearHold();
      cb.onFinal(text, finalConf);
    }
  };

  rec.onerror = (event) => {
    recognizing = false;
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      micBlocked = true;
      micMuted = true;
      cb.onMicBlocked();
      cb.onStateChange();
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

export function startRecognition() {
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

export function stopRecognition() {
  if (!recognition) return;
  try {
    recognition.stop();
  } catch (_) {
    /* ignore */
  }
  recognizing = false;
}

export function setMicMuted(muted) {
  micMuted = !!muted;
  if (micMuted) stopRecognition();
  else startRecognition();
}

export function retryMic() {
  micBlocked = false;
  micMuted = false;
  startRecognition();
}
