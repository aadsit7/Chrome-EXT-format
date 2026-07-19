// speech.js — Sharon's ears and voice, with real turn-taking.
//
// The rules of the conversation:
//   1. Sharon NEVER cuts you off. Recognition results accumulate upstream
//      (sidepanel.js) and only send after a genuine, adaptive silence — a
//      breath mid-thought never ends your turn.
//   2. You can cut HER off (barge-in): the mic stays live while she speaks,
//      but ONLY the instant-interrupt keywords ("Sharon…", "stop",
//      "stop stop") cut through — because while she's talking the mic is
//      almost certainly hearing her own voice, not yours (see rule 3), and
//      those keywords are the one thing an echo tail can't fake.
//   3. She never reacts to her own voice. The hard guarantee: while she is
//      speaking, and through a post-speech cooldown, NO recognized speech
//      becomes a command or an interim — the assist pipeline is simply
//      unreachable. Text-matching her words out of the transcript is too
//      fragile to rely on (the mic hears a garbled version through the
//      speakers that rarely matches word-for-word), so instead of trying to
//      tell echo from user we refuse all input in that window and let only
//      the rule-2 keywords act. The supporting layers:
//      (a) the mic stream requests echoCancellation / noiseSuppression /
//          autoGainControl,
//      (b) a rolling ~10s buffer of her own spoken words — a candidate
//          keyword that substantially overlaps it is treated as her own echo
//          and does NOT self-interrupt her,
//      (c) a Web Audio energy gate + (d) a novel-word threshold: these still
//          power the richer barge-in used for PLAYBACK (rule 7), where the
//          audio is the user's own recorded voice rather than Sharon's,
//      (e) the instant-interrupt words bypass (c)/(d),
//      (f) POST_SPEECH_COOLDOWN_MS keeps the echo window open after her audio
//          ends, since recognition of her voice lags the sound itself.
//   4. She never STARTS speaking while you're mid-sentence — a reply that
//      arrives while you're still talking waits for you to finish.
//   5. If the recognition engine stops itself (it does, periodically) it is
//      restarted instantly, and any words caught mid-flight are stitched in
//      so nothing you said is lost.
//   6. Recorder mode: the recorder owns the ears from the moment recording
//      starts until the whole flow (recording → uploading → organizing) is
//      idle again. While recording, every recognition result (interim,
//      final, and restart-stitched orphans) is rerouted into the recorder's
//      transcript; from stop until idle — plus a short grace period for
//      trailing audio — results are DISCARDED outright, so nothing said
//      during a recording can ever become a command or chat message.
//      Sharon stays silent the whole time (her voice would land in the
//      audio). Reaching idle restores rules 1-5 untouched.
//   7. Playback mode: while a saved recording plays in the panel, that audio
//      is real speech in the room — often the user's own voice — so nothing
//      heard while it plays (or in its short echo tail) may become a command
//      or an interim. Confident user speech PAUSES the playback instead,
//      under the same barge-in rules as when Sharon herself is talking.
//
// This module is UI-free: the orchestrator registers callbacks.

const synth = window.speechSynthesis;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */
const RECOGNITION_LANG = "en-US"; // the one place to change Sharon's listening language
const MAX_ALTERNATIVES = 3; // per final result, the best-confidence one wins

const MAX_CHUNK_CHARS = 220; // dodge Chrome's ~15s single-utterance cutoff
const QUIET_GAP_MS = 700; // how long after your last word Sharon may speak
const WAIT_TO_SPEAK_MAX_MS = 6000;

// Barge-in / echo protection
const SELF_SPEECH_WINDOW_MS = 10000; // (b) rolling buffer of her own words
const SELF_ECHO_OVERLAP = 0.6; // (b) ≥60% token overlap = her own echo
const MIN_INTERRUPT_WORDS = 3; // (d) novel words required to cut her off
const POST_SPEECH_COOLDOWN_MS = 1200; // (f) echo filter outlives her audio (recognition lags her voice)
const PLAYBACK_COOLDOWN_MS = 800; // rule 7: playback echo tails outlive the sound too
const ENERGY_SUSTAIN_MS = 300; // (c) energy must run hot at least this long
const ENERGY_RECENT_MS = 1200; // (c) a sustained burst opens the gate this long
const ENERGY_RATIO = 2.2; // (c) "hot" = this many times the ambient baseline
const CALIBRATION_MS = 2000; // (c) ambient sampled over the first idle seconds

// ASR self-recovery
const RESTART_DELAY_MS = 50; // instant restart after a routine engine stop
const ERROR_SURFACE_AFTER = 6; // consecutive hard errors before telling the user

let cb = {
  getSettings: () => ({ readAloud: true, voiceName: "", voiceRate: 0.95 }),
  onFinal: () => {},
  onInterim: () => {},
  onStateChange: () => {},
  onMicBlocked: () => {},
  onRecognitionTrouble: () => {},
  onVoicesChanged: () => {},
  onPlaybackBargeIn: () => {},
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
 * Speaking (TTS) — sentence-chunked queue, cancel-on-barge-in
 * ------------------------------------------------------------------ */
let speakSeq = 0;
let speaking = false;
let paused = false; // user said "pause" (explicit)
let speechEndedAt = 0; // when her audio last stopped (for the echo cooldown)
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

export function speak(text, { onDone } = {}) {
  const full = (text || "").trim();
  onDoneSpeaking = onDone || null;
  // Recorder non-idle: her voice must never land in the recording (or talk
  // over the upload), so nothing is spoken — replies still render, only
  // the audio is skipped. Dictation is the same deal: her voice would be
  // transcribed straight into the user's note.
  if (recorderState !== "idle" || dictationCb || !synth || !cb.getSettings().readAloud || !full) {
    // Nothing will be spoken — settle, then signal completion.
    const done = onDoneSpeaking;
    onDoneSpeaking = null;
    queueMicrotask(() => done && done());
    return;
  }

  const mySeq = ++speakSeq;
  synth.cancel();

  const chunks = chunkForSpeech(full);
  speaking = true;
  paused = false;
  cb.onStateChange();

  const finishAll = () => {
    if (mySeq !== speakSeq) return;
    speaking = false;
    paused = false;
    speechEndedAt = Date.now();
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
      const chunkText = chunks[i++];
      const utt = new SpeechSynthesisUtterance(chunkText);
      if (voice) {
        utt.voice = voice;
        utt.lang = voice.lang;
      } else {
        utt.lang = "en-US";
      }
      utt.rate = rate;
      utt.pitch = 1;
      utt.volume = 1;
      // (b) Only words that actually reach the speakers enter the
      // self-speech buffer — a barge-in cancels the unspoken rest.
      utt.onstart = () => noteSelfSpeech(chunkText);
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

  // Turn-taking rule 4: never START talking while the user is mid-sentence.
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

// Cancels the current reply for good — a bumped speakSeq means the queue and
// its onDone can never run, so an interrupted reply is never re-spoken.
export function stopSpeaking() {
  speakSeq++;
  if (synth) synth.cancel();
  if (speaking) speechEndedAt = Date.now();
  speaking = false;
  paused = false;
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
    cb.onStateChange();
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
    speaking = true;
    cb.onStateChange();
    utt.onstart = () => noteSelfSpeech(sample);
    const done = () => {
      speaking = false;
      paused = false;
      speechEndedAt = Date.now();
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
 * (b) Rolling self-speech buffer — the last ~10s of Sharon's own words.
 * Echo and recognition lag behind her audio, so filtering against only the
 * current sentence isn't enough; entries expire on their own.
 * ------------------------------------------------------------------ */
let selfSpeech = []; // [{ text: normalized, at: ms }]

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function noteSelfSpeech(text) {
  const t = normalize(text);
  if (t) selfSpeech.push({ text: t, at: Date.now() });
}

function selfSpeechTokens() {
  const cutoff = Date.now() - SELF_SPEECH_WINDOW_MS;
  selfSpeech = selfSpeech.filter((e) => e.at >= cutoff); // natural expiry
  const set = new Set();
  for (const e of selfSpeech) for (const w of e.text.split(" ")) set.add(w);
  return set;
}

// Fuzzy, case-insensitive, token-overlap echo test against everything she
// has said in the last SELF_SPEECH_WINDOW_MS.
function isSelfEcho(phrase) {
  const p = normalize(phrase);
  if (!p) return true;
  const tokens = selfSpeechTokens();
  if (!tokens.size) return false;
  const words = p.split(" ");
  let matched = 0;
  for (const w of words) if (tokens.has(w)) matched++;
  return matched / words.length >= SELF_ECHO_OVERLAP;
}

function countNovelWords(norm) {
  const tokens = selfSpeechTokens();
  let n = 0;
  for (const w of norm.split(" ")) if (w && !tokens.has(w)) n++;
  return n;
}

// (f) The filter stays on while she speaks and for a short cooldown after —
// echo tails outlive the audio. Non-matching speech always passes.
function echoFilterActive() {
  return speaking || Date.now() - speechEndedAt < POST_SPEECH_COOLDOWN_MS;
}

/* ------------------------------------------------------------------ *
 * (a)+(c) Mic analyser + voice-energy gate.
 * The mic stream is opened with echoCancellation/noiseSuppression/autoGain;
 * an analyser calibrates ambient level during the first idle seconds, then a
 * word-based interrupt is only allowed if input energy ran clearly above
 * that baseline for at least ENERGY_SUSTAIN_MS. If the analyser can't run,
 * the gate stays neutral — layers (b), (d), (e), (f) still protect.
 * ------------------------------------------------------------------ */
let analyserAttempted = false;
let micStream = null; // the one mic stream — shared with the recorder
let audioCtx = null;
let analyser = null;
let energyData = null;
let energyBaseline = null;
let calibrationSamples = [];
let calibrationStartedAt = 0;
let hotStreakStart = 0;
let lastSustainedAt = 0;

async function ensureMicAnalyser() {
  if (analyserAttempted) return;
  analyserAttempted = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micStream = stream; // kept for the recorder — one stream, one permission
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    try {
      await audioCtx.resume();
    } catch (_) {
      /* may need a user gesture; retried below */
    }
    document.addEventListener(
      "click",
      () => {
        try {
          if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
        } catch (_) {
          /* ignore */
        }
      },
      { once: true }
    );
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    energyData = new Uint8Array(analyser.fftSize);
    calibrationStartedAt = Date.now();
    calibrationSamples = [];
    setInterval(sampleEnergy, 50);
  } catch (_) {
    analyser = null;
  }
}

function sampleEnergy() {
  if (!analyser || !audioCtx || audioCtx.state !== "running") return;
  analyser.getByteTimeDomainData(energyData);
  let sum = 0;
  for (let i = 0; i < energyData.length; i++) {
    const d = energyData[i] - 128;
    sum += d * d;
  }
  const rms = Math.sqrt(sum / energyData.length);
  const now = Date.now();

  if (energyBaseline == null) {
    if (!speaking) {
      calibrationSamples.push(rms);
      if (now - calibrationStartedAt >= CALIBRATION_MS && calibrationSamples.length) {
        energyBaseline =
          calibrationSamples.reduce((a, b) => a + b, 0) / calibrationSamples.length;
      }
    } else {
      calibrationStartedAt = now; // never calibrate on her own voice
      calibrationSamples = [];
    }
    return;
  }

  const threshold = Math.max(energyBaseline * ENERGY_RATIO, energyBaseline + 4, 3);
  if (rms >= threshold) {
    if (!hotStreakStart) hotStreakStart = now;
    if (now - hotStreakStart >= ENERGY_SUSTAIN_MS) lastSustainedAt = now;
  } else {
    hotStreakStart = 0;
    // slow ambient re-tracking while everything is quiet
    if (!speaking) energyBaseline = energyBaseline * 0.995 + rms * 0.005;
  }
}

function energyGateOpen() {
  // Unmeasurable (no permission / suspended context / still calibrating):
  // stay neutral rather than dead — the other layers still apply.
  if (!analyser || !audioCtx || audioCtx.state !== "running" || energyBaseline == null) return true;
  return Date.now() - lastSustainedAt < ENERGY_RECENT_MS;
}

/* ------------------------------------------------------------------ *
 * Barge-in decision — all layers together
 * ------------------------------------------------------------------ */
// (e) These cut through instantly, whatever their length.
function isInstantInterrupt(norm) {
  return norm === "stop" || norm === "stop stop" || /^sharon\b/.test(norm);
}

function shouldBargeIn(text) {
  const norm = normalize(text);
  if (!norm) return false;
  if (isInstantInterrupt(norm)) return true; // (e)
  if (countNovelWords(norm) < MIN_INTERRUPT_WORDS) return false; // (d)
  return energyGateOpen(); // (c) — uncertain means do NOT interrupt
}

/* ------------------------------------------------------------------ *
 * Recorder mode — the recorder borrows the ears without touching them.
 * ONE authoritative state seals the whole flow:
 *   idle → recording → uploading → organizing → idle
 * While "recording", recognition keeps running exactly as before (same
 * engine, same restart stitching, so no words drop across its periodic
 * self-stops), but every result is rerouted into the recorder's callbacks;
 * the assist flow is unreachable. Leaving "recording" ABORTS the engine
 * (abort discards buffered results — stop() would flush them out as fresh
 * finals into whatever mode comes next). Through "uploading"/"organizing",
 * and for a short grace period after returning to "idle", every result is
 * discarded, so trailing audio can never become a command. Sharon's voice
 * is silenced whenever the state isn't idle (see speak()).
 * ------------------------------------------------------------------ */
const POST_RECORD_GRACE_MS = 1000; // trailing recording audio ≠ a command

let recorderState = "idle"; // idle | recording | uploading | organizing
let recorderGraceUntil = 0; // input stays sealed until this after idle
let recorderCb = { onFinal: () => {}, onInterim: () => {} };
let recorderPrevMuted = false;

// True only when the recorder flow is fully over AND the grace period for
// trailing recording audio has passed — the one test for "voice input may
// reach the assist flow again".
export function recorderSealOpen() {
  return recorderState === "idle" && Date.now() >= recorderGraceUntil;
}

// The recorder reuses the analyser's mic stream (one getUserMedia, one
// permission prompt); if the analyser never got one, open a stream with
// the exact constraints the analyser uses — echo layer (a).
export async function getMicStream() {
  if (micStream && micStream.getAudioTracks().some((t) => t.readyState === "live")) {
    return micStream;
  }
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return micStream;
}

// The orchestrator drives every transition through here, so this flag is
// the single gate — there is no second path recognition results can take.
export function setRecorderState(state, callbacks) {
  const prev = recorderState;
  if (state === prev) return;
  recorderState = state;

  if (state === "recording") {
    // The recorder outranks dictation: end it first, which also restores the
    // mic's true muted state before the recorder snapshots it below.
    stopDictation();
    recorderCb = { onFinal: () => {}, onInterim: () => {}, ...(callbacks || {}) };
    recorderPrevMuted = micMuted;
    stopSpeaking(); // she goes quiet the instant recording starts
    // Transcription needs the engine live even if the user had muted; a
    // granted recorder stream is proof any earlier block is stale.
    micBlocked = false;
    micMuted = false;
    startRecognition();
    return;
  }

  if (prev === "recording") {
    // The recording just ended. Anything the engine still owes us belongs
    // to the recording session — abort() discards it (stop() would flush
    // buffered speech out as fresh finals AFTER this flag flipped, which is
    // exactly the leak this gate exists to close).
    recorderCb = { onFinal: () => {}, onInterim: () => {} };
    abortRecognition();
  }

  if (state === "idle") {
    // Recognition may already be live again; trailing audio from the
    // recording session stays sealed for a moment longer.
    recorderGraceUntil = Date.now() + POST_RECORD_GRACE_MS;
    if (recorderPrevMuted) setMicMuted(true); // restore exactly what was there
    recorderPrevMuted = false;
  }
}

/* ------------------------------------------------------------------ *
 * Dictation mode — the Notes editor borrows the ears, the same contract as
 * the recorder: while active, EVERY recognition result is rerouted to the
 * dictation callback and the assist pipeline is unreachable, so dictated
 * words can never become commands. Sharon's voice stays quiet (see speak()),
 * the mic runs even if the user had muted it, and stopping restores the
 * mute state exactly as it was. A short grace window after stopping keeps
 * trailing dictation audio from leaking into the conversation. The recorder
 * always outranks dictation: it can't start while the recorder owns the
 * ears, and a recording that starts mid-dictation ends the dictation first.
 * ------------------------------------------------------------------ */
const POST_DICTATION_GRACE_MS = 1000; // trailing dictation audio ≠ a command

let dictationCb = null; // set = dictation owns every recognition result
let dictationPrevMuted = false;
let dictationEndedAt = 0;

export function dictationActive() {
  return !!dictationCb;
}

export function startDictation(onFinal) {
  if (recorderState !== "idle") return false; // the recorder owns the ears
  if (dictationCb) {
    dictationCb = typeof onFinal === "function" ? onFinal : dictationCb;
    return true;
  }
  dictationCb = typeof onFinal === "function" ? onFinal : function () {};
  dictationPrevMuted = micMuted;
  stopSpeaking(); // she goes quiet the instant dictation starts
  // Dictation needs the engine live even if the user had muted; the tap on
  // the dictate button is a fresh gesture, so a stale block is worth retrying.
  micBlocked = false;
  micMuted = false;
  startRecognition();
  return true;
}

export function stopDictation() {
  if (!dictationCb) return;
  dictationCb = null;
  dictationEndedAt = Date.now();
  // abort() discards anything the engine still owes us — a stop() would
  // flush buffered dictation out as fresh finals into the conversation.
  abortRecognition();
  if (dictationPrevMuted) setMicMuted(true); // restore exactly what was there
  dictationPrevMuted = false;
}

function dictationSealOpen() {
  return !dictationCb && Date.now() - dictationEndedAt >= POST_DICTATION_GRACE_MS;
}

/* ------------------------------------------------------------------ *
 * Playback mode (rule 7) — the orchestrator flips this while a saved
 * recording plays in the panel. The playback audio is real speech that the
 * mic will hear and the recognizer will happily transcribe (it isn't in the
 * self-speech buffer — it's not Sharon's voice), so while it's active every
 * recognition result is swallowed before it can become a command; the only
 * thing heard speech can do is barge in and pause the playback, exactly as
 * it would cut Sharon off. A short cooldown after playback stops catches
 * the recognition lag and echo tail.
 * ------------------------------------------------------------------ */
let playbackActive = false;
let playbackEndedAt = 0;

export function setPlaybackActive(on) {
  on = !!on;
  if (playbackActive && !on) playbackEndedAt = Date.now();
  playbackActive = on;
}

function playbackGuardActive() {
  return playbackActive || Date.now() - playbackEndedAt < PLAYBACK_COOLDOWN_MS;
}

/* ------------------------------------------------------------------ *
 * Listening (ASR) — continuous, self-healing, nothing dropped
 * ------------------------------------------------------------------ */
let recognition = null;
let recognizing = false;
let micMuted = false;
let micBlocked = false;
let lastHeardAt = 0; // last time we heard the USER (non-echo)
let lastInterimText = ""; // stitched in as final if the engine stops mid-word
let consecutiveAsrErrors = 0;
let troubleSurfaced = false;

export function speechRecognitionAvailable() {
  return !!SpeechRecognition;
}
export function isMicMuted() {
  return micMuted;
}
export function isMicBlocked() {
  return micBlocked;
}

function handleHeard(finalText, interimText, conf) {
  consecutiveAsrErrors = 0;
  troubleSurfaced = false;

  // The recorder seal. While recording, she isn't speaking (so echo and
  // barge-in are moot) — every word flows into the recording's transcript,
  // none into assist. From stop until the flow is idle again (uploading /
  // organizing / the post-idle grace window), results are DISCARDED: the
  // assist pipeline is unreachable for anything heard around a recording.
  if (recorderState === "recording") {
    if (interimText) recorderCb.onInterim(interimText);
    if (finalText) {
      lastHeardAt = Date.now();
      recorderCb.onFinal(finalText, conf);
    }
    return;
  }
  if (!recorderSealOpen()) return;

  // Dictation (the Notes editor): every result types into the note instead
  // of the conversation; from stop until the grace window closes, trailing
  // dictation audio is discarded so it can never become a command.
  if (dictationCb) {
    if (finalText) {
      lastHeardAt = Date.now();
      dictationCb(finalText, conf);
    }
    return;
  }
  if (!dictationSealOpen()) return;

  // Playback mode (rule 7): nothing heard while a recording plays — or in
  // its short echo tail — ever reaches the assist flow. Confident speech
  // pauses the playback instead (same barge-in contract as when she talks);
  // the triggering words are dropped too, since they may BE the playback.
  if (playbackGuardActive()) {
    if (playbackActive) {
      const candidate = ((finalText || "") + " " + (interimText || "")).trim();
      if (candidate && shouldBargeIn(candidate)) cb.onPlaybackBargeIn();
    }
    return;
  }

  // While Sharon is speaking — or in the post-speech cooldown, where the
  // recognizer is still catching up on her voice — the mic is almost
  // certainly hearing HER, not you. Text-matching her words out is fragile:
  // the mic hears a garbled version through the speakers that rarely matches
  // word-for-word, so echo leaks through as a "command" and she answers her
  // own voice on a loop. So in this window we refuse to turn ANY recognized
  // speech into a command or interim. The only thing heard speech may do is
  // barge in through the instant-interrupt keywords ("stop", "Sharon…") —
  // short, distinctive, and not something an echo tail fakes convincingly.
  // (Rich barge-in on novel words + the energy gate stays alive for playback,
  // rule 7 — see playbackGuardActive/shouldBargeIn.)
  if (echoFilterActive()) {
    if (speaking) {
      const candidate = ((finalText || "") + " " + (interimText || "")).trim();
      const norm = normalize(candidate);
      // Barge in only on a real keyword that isn't itself her own echo (if she
      // just said "stop" in a reply, the echo of it must not self-interrupt).
      if (norm && isInstantInterrupt(norm) && !isSelfEcho(candidate)) {
        stopSpeaking();
        cb.onStateChange();
        // A bare "stop" is also a command: forward it so the orchestrator can
        // cancel a pending action plan / agent step, not just silence her.
        // "Sharon…" phrases only stop her — the rest of the phrase this close
        // to her voice can't be trusted as a command, so the user re-asks.
        if (finalText && (norm === "stop" || norm === "stop stop")) {
          lastHeardAt = Date.now();
          cb.onFinal(finalText, conf);
        }
      }
    }
    return; // nothing heard while she speaks (or just after) becomes input
  }

  if (interimText) {
    lastHeardAt = Date.now();
    cb.onInterim(interimText);
  }
  if (finalText) {
    lastHeardAt = Date.now();
    cb.onFinal(finalText, conf);
  }
}

function ensureRecognition() {
  if (recognition) return recognition;
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.lang = RECOGNITION_LANG;
  rec.interimResults = true;
  rec.continuous = true;
  rec.maxAlternatives = MAX_ALTERNATIVES;

  rec.onstart = () => {
    recognizing = true;
    ensureMicAnalyser();
  };

  rec.onresult = (event) => {
    // New finals: keep the highest-confidence alternative of each.
    let finalText = "";
    let minConf = null;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (!res.isFinal) continue;
      let best = res[0];
      for (let j = 1; j < res.length; j++) {
        const alt = res[j];
        if (
          alt &&
          alt.transcript &&
          alt.confidence != null &&
          (best.confidence == null || alt.confidence > best.confidence)
        )
          best = alt;
      }
      finalText += best.transcript;
      if (best.confidence != null)
        minConf = minConf == null ? best.confidence : Math.min(minConf, best.confidence);
    }
    // The full in-flight interim (everything not yet finalized), so a sudden
    // engine stop can stitch it in rather than lose it.
    let interim = "";
    for (let i = 0; i < event.results.length; i++) {
      if (!event.results[i].isFinal) interim += event.results[i][0].transcript;
    }
    lastInterimText = interim;

    handleHeard(finalText.trim(), interim.trim(), minConf);
  };

  rec.onerror = (event) => {
    recognizing = false;
    const kind = event.error;
    if (kind === "not-allowed" || kind === "service-not-allowed") {
      micBlocked = true;
      micMuted = true;
      cb.onMicBlocked();
      cb.onStateChange();
      return;
    }
    // "no-speech" and "aborted" are routine — recover silently at full speed.
    // "network"/"audio-capture" also self-recover (with backoff), and only
    // reach the user after repeated consecutive failures.
    if (kind === "network" || kind === "audio-capture") {
      consecutiveAsrErrors++;
      if (consecutiveAsrErrors >= ERROR_SURFACE_AFTER && !troubleSurfaced) {
        troubleSurfaced = true;
        cb.onRecognitionTrouble();
      }
    }
  };

  rec.onend = () => {
    recognizing = false;
    // Stitch: words caught mid-flight when the engine stopped must not drop.
    const orphan = lastInterimText.trim();
    lastInterimText = "";
    if (orphan && !micMuted && !micBlocked) {
      if (recorderState === "recording") {
        lastHeardAt = Date.now();
        recorderCb.onFinal(orphan, null);
      } else if (dictationCb) {
        // Dictation: an orphan caught mid-dictation belongs in the note.
        lastHeardAt = Date.now();
        dictationCb(orphan, null);
      } else if (
        recorderSealOpen() &&
        dictationSealOpen() &&
        !playbackGuardActive() &&
        !echoFilterActive()
      ) {
        // Rule 6: an orphan around a recording belongs to the recording.
        // Rule 7: an orphan caught mid-playback may be the playback itself.
        // Echo window: an orphan caught while she speaks (or just after) is
        // almost certainly her own voice — dropped, never sent as a command.
        lastHeardAt = Date.now();
        cb.onFinal(orphan, null);
      }
    }
    if (!micMuted && !micBlocked) {
      const wait =
        consecutiveAsrErrors > 0
          ? Math.min(4000, 250 * Math.pow(2, consecutiveAsrErrors - 1))
          : RESTART_DELAY_MS;
      setTimeout(() => {
        if (!micMuted && !micBlocked) startRecognition();
      }, wait);
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
  lastInterimText = ""; // a deliberate stop drops in-flight words
  try {
    recognition.stop();
  } catch (_) {
    /* ignore */
  }
  recognizing = false;
}

// Unlike stop(), abort() DISCARDS everything the engine has buffered — no
// flush of pending finals. Used when leaving recorder mode, where a flush
// would deliver the recording's tail into whatever mode comes next. The
// engine restarts itself through the normal onend path.
function abortRecognition() {
  if (!recognition) return;
  lastInterimText = "";
  try {
    recognition.abort();
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
  if (!analyser) analyserAttempted = false; // permission may exist now
  startRecognition();
}
