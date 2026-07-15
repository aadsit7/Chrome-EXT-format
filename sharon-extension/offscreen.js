// offscreen.js — Sharon's BACKGROUND screen recorder.
//
// This runs inside a hidden offscreen document (created by background.js), NOT
// in the side panel. That's the whole point: the offscreen document lives
// independently of the side panel, so a recording keeps going even after the
// user collapses the panel — with only a red dot on the toolbar icon.
//
// It captures the CURRENT DESKTOP: the screen's video and its own system/
// desktop audio, via getDisplayMedia. It NEVER opens the microphone
// (no getUserMedia), so other apps keep full, undisrupted access to the mic.
// This is strictly a desktop video recording.
//
// It owns the recording state and reports it to the service worker + side
// panel over runtime messages (JSON only):
//   SW → here:   { t:"sr:off", cmd:"start"|"stop"|"query"|"clear" }
//   here → all:  { t:"sr:evt", event:"started"|"stopped"|"cancelled"|"error", … }
// On stop it builds one Blob and exposes it as a blob: URL; the side panel
// (same extension origin) fetches that URL to pull the clip back for review.

const RECORD_MAX_MS = 30 * 60 * 1000; // hard 30-minute cap — same as the voice recorder

let mediaRecorder = null;
let stream = null;
let chunks = [];
let capTimer = null;

// Pause bookkeeping. `pausedAccumMs` is recorded time banked before the current
// running segment; `segStart` is when the current running segment began (0
// while paused). This lets the recorded elapsed time exclude paused stretches,
// and lets `st.startAtEpoch` stay a "virtual start" (now − startAtEpoch ===
// recorded elapsed) so the side panel's timer needs no pause math.
let pausedAccumMs = 0;
let segStart = 0;

// The authoritative recording state (the side panel reconnects by querying it).
let st = freshState();
function freshState() {
  return { phase: "idle", startAtEpoch: 0, paused: false, blobUrl: "", size: 0, durationSeconds: 0, mime: "", error: "" };
}

// Recorded time so far, excluding any paused stretches.
function recordedElapsedMs() {
  if (st.phase !== "recording") return 0;
  return st.paused ? pausedAccumMs : pausedAccumMs + (Date.now() - segStart);
}

function pickMime() {
  if (!self.MediaRecorder) return "";
  for (const m of ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function emit(event, extra) {
  try {
    chrome.runtime.sendMessage(Object.assign({ t: "sr:evt", event }, extra || {}));
  } catch (_) {
    /* no receiver right now (panel closed) — the SW still hears it */
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.t !== "string" || msg.t !== "sr:off") return; // not for us
  if (msg.cmd === "query") {
    sendResponse(Object.assign({}, st, { recordedMs: recordedElapsedMs() }));
    return; // synchronous response
  }
  if (msg.cmd === "start") startRec();
  else if (msg.cmd === "stop") stopRec();
  else if (msg.cmd === "togglepause") togglePause();
  else if (msg.cmd === "clear") clearRec();
  // no response needed for start/stop/togglepause/clear
});

async function startRec() {
  if (st.phase === "recording" || st.phase === "starting") return;
  st = freshState();
  st.phase = "starting";

  const mime = pickMime();
  if (!mime) {
    st = freshState();
    st.phase = "error";
    st.error = "unsupported";
    emit("error", { error: "unsupported" });
    return;
  }

  // Screen video + its system/desktop audio. NO microphone: other apps keep it.
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) {
    const name = (e && e.name) || "";
    const cancelled = name === "NotAllowedError" || name === "AbortError";
    st = freshState();
    if (cancelled) {
      emit("cancelled", {});
    } else {
      st.phase = "error";
      st.error = name || "capture";
      emit("error", { error: name || String((e && e.message) || "capture") });
    }
    return;
  }

  chunks = [];
  try {
    mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
  } catch (e) {
    stopTracks();
    st = freshState();
    st.phase = "error";
    st.error = "recorder";
    emit("error", { error: "recorder" });
    return;
  }

  mediaRecorder.addEventListener("dataavailable", (ev) => {
    if (ev.data && ev.data.size) chunks.push(ev.data);
  });
  mediaRecorder.addEventListener("stop", onRecStop, { once: true });

  // Chrome's own "Stop sharing" bar ends the display video track — treat that
  // exactly like a Stop command.
  const vt = (stream.getVideoTracks() || [])[0];
  if (vt) vt.addEventListener("ended", () => stopRec(), { once: true });

  st.mime = mime;
  pausedAccumMs = 0;
  segStart = Date.now();
  st.startAtEpoch = segStart;
  st.paused = false;
  st.phase = "recording";
  mediaRecorder.start(1000); // 1s chunks — a crash loses at most a second
  emit("started", { startAtEpoch: st.startAtEpoch, mime });

  // 30-minute hard cap — on RECORDED time, so pausing doesn't burn the budget.
  capTimer = setInterval(() => {
    if (recordedElapsedMs() >= RECORD_MAX_MS) stopRec();
  }, 1000);
}

// Pause ↔ resume the recording. Keeps the MediaRecorder and our recorded-time
// bookkeeping in step; emits an event so the badge + panel reflect it.
function togglePause() {
  if (st.phase !== "recording") return;
  if (!st.paused) {
    try {
      if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.pause();
    } catch (_) {
      /* ignore */
    }
    pausedAccumMs += Date.now() - segStart;
    segStart = 0;
    st.paused = true;
    emit("paused", { recordedMs: pausedAccumMs });
  } else {
    try {
      if (mediaRecorder && mediaRecorder.state === "paused") mediaRecorder.resume();
    } catch (_) {
      /* ignore */
    }
    segStart = Date.now();
    st.paused = false;
    st.startAtEpoch = segStart - pausedAccumMs; // virtual start: now − this === recorded ms
    emit("resumed", { startAtEpoch: st.startAtEpoch });
  }
}

function stopRec() {
  if (capTimer) {
    clearInterval(capTimer);
    capTimer = null;
  }
  // Let the recorder's "stop" event assemble the blob (onRecStop).
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    else onRecStop();
  } catch (_) {
    onRecStop();
  }
}

function onRecStop() {
  if (st.phase !== "recording" && st.phase !== "starting") {
    // already finalized (double stop) — nothing to do
    return;
  }
  const durationSeconds = Math.min(
    Math.round(recordedElapsedMs() / 1000),
    Math.round(RECORD_MAX_MS / 1000)
  );
  const mime = st.mime || "video/webm";
  const blob = new Blob(chunks, { type: mime });
  chunks = [];
  stopTracks();

  if (!blob.size) {
    st = freshState();
    st.phase = "error";
    st.error = "empty";
    emit("error", { error: "empty" });
    return;
  }

  const url = URL.createObjectURL(blob);
  st.phase = "ready";
  st.blobUrl = url;
  st.size = blob.size;
  st.durationSeconds = durationSeconds;
  emit("stopped", { blobUrl: url, size: blob.size, durationSeconds, mime });
}

function stopTracks() {
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  } catch (_) {
    /* ignore */
  }
  stream = null;
  mediaRecorder = null;
}

// Release the finished clip and reset — the side panel calls this once it has
// pulled the clip back (or on discard/save). Safe to call twice.
function clearRec() {
  if (capTimer) {
    clearInterval(capTimer);
    capTimer = null;
  }
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch (_) {
    /* ignore */
  }
  stopTracks();
  chunks = [];
  pausedAccumMs = 0;
  segStart = 0;
  try {
    if (st.blobUrl) URL.revokeObjectURL(st.blobUrl);
  } catch (_) {
    /* ignore */
  }
  st = freshState();
}
