// ui.js — everything Sharon draws: the header status line (with the mute
// button and the persistent recording pill), the page-awareness pill, the
// live-presence card (streaming transcript → countdown → edit), the
// conversation thread (user bubbles, quiet captures, answer cards, the
// spoken-aloud layer, undo toast), the Library view, the Audio and Video
// screens' lists, the first-run welcome, and the settings bottom sheet. No
// business logic lives here; the orchestrator registers callbacks and drives
// state.
//
// Views are still switched the way they always were — one attribute on
// <html>: data-view="chat" | "library" | "notes" | "audio" | "video" |
// "welcome". tabs.js owns the bar that sets it; nothing here knows or cares
// about Sharon's mode.

export const els = {
  html: document.documentElement,
  statusLine: document.getElementById("statusLine"),
  statusText: document.getElementById("statusText"),
  voiceBtn: document.getElementById("voiceBtn"),
  memoryBtn: document.getElementById("memoryBtn"),
  memBadge: document.getElementById("memBadge"),
  settingsBtn: document.getElementById("settingsBtn"),
  recPill: document.getElementById("recPill"),
  recPillLabel: document.getElementById("recPillLabel"),
  recPillTimer: document.getElementById("recPillTimer"),
  tabPill: document.getElementById("tabPill"),
  tabSeeing: document.getElementById("tabSeeing"),
  tabTitle: document.getElementById("tabTitle"),
  liveCard: document.getElementById("liveCard"),
  lcLabel: document.getElementById("lcLabel"),
  lcMute: document.getElementById("lcMute"),
  lcTranscript: document.getElementById("lcTranscript"),
  lcText: document.getElementById("lcText"),
  lcStrip: document.getElementById("lcStrip"),
  lcBarFill: document.getElementById("lcBarFill"),
  lcEdit: document.getElementById("lcEdit"),
  lcEditArea: document.getElementById("lcEditArea"),
  lcSend: document.getElementById("lcSend"),
  lcDiscard: document.getElementById("lcDiscard"),
  thread: document.getElementById("thread"),
  emptyState: document.getElementById("emptyState"),
  libraryView: document.getElementById("libraryView"),
  memSubtitle: document.getElementById("memSubtitle"),
  memSearchInput: document.getElementById("memSearchInput"),
  memFilters: document.getElementById("memFilters"),
  memList: document.getElementById("memList"),
  memSynced: document.getElementById("memSynced"),
  memSelectBtn: document.getElementById("memSelectBtn"),
  memSelBar: document.getElementById("memSelBar"),
  selCancel: document.getElementById("selCancel"),
  selCount: document.getElementById("selCount"),
  selAllBtn: document.getElementById("selAllBtn"),
  memActBar: document.getElementById("memActBar"),
  selDoneBtn: document.getElementById("selDoneBtn"),
  selReopenBtn: document.getElementById("selReopenBtn"),
  selDeleteBtn: document.getElementById("selDeleteBtn"),
  composer: document.getElementById("composer"),
  composerInput: document.getElementById("composerInput"),
  sendBtn: document.getElementById("sendBtn"),
  micBtn: document.getElementById("micBtn"),
  // The Audio tab's one big Record button — the old #recordBtn's exact job.
  recordBtn: document.getElementById("recordBtn"),
  recordBtnLabel: document.getElementById("recordBtnLabel"),
  // "Look at this tab" now lives on the page-awareness pill.
  screenBtn: document.getElementById("tabPill"),
  // The Video tab's one big Record-screen button — the old #screenRecBtn's job.
  screenRecBtn: document.getElementById("screenRecBtn"),
  screenRecBtnLabel: document.getElementById("screenRecBtnLabel"),
  searchIcon: document.getElementById("searchIcon"),
  libraryTab: document.getElementById("tabLibrary"),
  libraryTabBadge: document.getElementById("tabLibraryBadge"),
  audioSubtitle: document.getElementById("audioSubtitle"),
  audioList: document.getElementById("audioList"),
  videoSubtitle: document.getElementById("videoSubtitle"),
  videoQuota: document.getElementById("videoQuota"),
  videoList: document.getElementById("videoList"),
  recCard: document.getElementById("recCard"),
  recLabel: document.getElementById("recLabel"),
  recTimer: document.getElementById("recTimer"),
  recStop: document.getElementById("recStop"),
  recTranscriptEl: document.getElementById("recTranscript"),
  recText: document.getElementById("recText"),
  recHint: document.getElementById("recHint"),
  screenRecCard: document.getElementById("screenRecCard"),
  screenRecLabel: document.getElementById("screenRecLabel"),
  screenRecTimer: document.getElementById("screenRecTimer"),
  screenRecStop: document.getElementById("screenRecStop"),
  playerBar: document.getElementById("playerBar"),
  plToggle: document.getElementById("plToggle"),
  plLabel: document.getElementById("plLabel"),
  plLoading: document.getElementById("plLoading"),
  plCur: document.getElementById("plCur"),
  plTotal: document.getElementById("plTotal"),
  plSeek: document.getElementById("plSeek"),
  plDrive: document.getElementById("plDrive"),
  plClose: document.getElementById("plClose"),
  undoToast: document.getElementById("undoToast"),
  toastLabel: document.getElementById("toastLabel"),
  toastUndo: document.getElementById("toastUndo"),
  welcomeView: document.getElementById("welcomeView"),
  wStepMic: document.getElementById("wStepMic"),
  wStepMemory: document.getElementById("wStepMemory"),
  wStepHello: document.getElementById("wStepHello"),
  wMicHint: document.getElementById("wMicHint"),
  wMemoryHint: document.getElementById("wMemoryHint"),
  wAllowBtn: document.getElementById("wAllowBtn"),
  wConnectBtn: document.getElementById("wConnectBtn"),
  wHelloBtn: document.getElementById("wHelloBtn"),
  scrim: document.getElementById("scrim"),
  settingsSheet: document.getElementById("settingsSheet"),
  suMic: document.getElementById("suMic"),
  suMemory: document.getElementById("suMemory"),
  suHello: document.getElementById("suHello"),
  suMicStatus: document.getElementById("suMicStatus"),
  suMemoryStatus: document.getElementById("suMemoryStatus"),
  suHelloStatus: document.getElementById("suHelloStatus"),
  suMicBtn: document.getElementById("suMicBtn"),
  suMemoryBtn: document.getElementById("suMemoryBtn"),
  suHelloBtn: document.getElementById("suHelloBtn"),
  replaySetup: document.getElementById("replaySetup"),
  autoReadToggle: document.getElementById("autoReadToggle"),
  scrollToggle: document.getElementById("scrollToggle"),
  actionsToggle: document.getElementById("actionsToggle"),
  confirmToggle: document.getElementById("confirmToggle"),
  voiceSelect: document.getElementById("voiceSelect"),
  voiceSpeed: document.getElementById("voiceSpeed"),
  voicePreview: document.getElementById("voicePreview"),
  shortcutValue: document.getElementById("shortcutValue"),
  changeShortcut: document.getElementById("changeShortcut"),
  screenRecShortcutValue: document.getElementById("screenRecShortcutValue"),
  changeScreenRecShortcut: document.getElementById("changeScreenRecShortcut"),
  screenPauseShortcutValue: document.getElementById("screenPauseShortcutValue"),
  changeScreenPauseShortcut: document.getElementById("changeScreenPauseShortcut"),
};

// The user lives in Lake Tapps, WA — every date and time on screen is shown
// in their Pacific clock, so displayed timestamps stay honest even if the
// device's own timezone differs. Exported so anything else that builds a
// user-facing timestamp (a saved video's title) uses the same clock.
export const DISPLAY_TZ = "America/Los_Angeles";

export function initUI() {
  wireMemoryFilters();
  wireMemorySelection();
}

/* ------------------------------------------------------------------ *
 * SVG helpers (Lucide-style, 24 grid, 2px stroke, round caps)
 * ------------------------------------------------------------------ */
function svgOf(inner, cls) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  svg.innerHTML = inner;
  return svg;
}
const I_CHECK = '<path d="M20 6 9 17l-5-5"/>';
const I_MIC = '<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4"/>';
const I_DOC = '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>';
const I_BOOK = '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>';
const I_TASKS = '<path d="m9 11 3 3 8-8"/><path d="M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"/>';
const I_GLOBE = '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>';
const I_VOLUME = '<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>';
const I_X = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>';
// One glyph, one meaning: the camcorder is video (screen recordings), the
// waveform is audio (voice recordings), the eye is "look at this tab", the mic
// means mute and nothing else.
const I_VIDEO = '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10.5 5.2-3.1a.5.5 0 0 1 .8.44v8.32a.5.5 0 0 1-.8.42L16 13.5z"/>';
const I_WAVE = '<path d="M2 10v4"/><path d="M6 6v12"/><path d="M10 3v18"/><path d="M14 7v10"/><path d="M18 5v14"/><path d="M22 10v4"/>';
const I_TRASH = '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>';
const I_DOWNLOAD = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>';
const I_PLAY = '<polygon points="6 3 20 12 6 21 6 3"/>';
const I_PAUSE = '<path d="M9 4v16"/><path d="M15 4v16"/>';

/* ------------------------------------------------------------------ *
 * Header: status line, indicators, page-awareness pill
 * ------------------------------------------------------------------ */
const STATUS_TEXT = {
  listening: "Listening — just talk",
  hearing: "Hearing you…",
  thinking: "Thinking…",
  speaking: "Speaking — tap to stop",
  muted: "Muted",
  recording: "Recording — I'll stay quiet",
  screen_rec: "Recording your screen — I'll stay quiet",
  screen_review: "Review your recording",
  screen_trim: "Trimming your clip…",
  screen: "Looking at your screen…",
  searching: "Searching the web…",
};

export function setPhase(phase) {
  els.html.setAttribute("data-phase", phase);
  if (els.statusText) els.statusText.textContent = STATUS_TEXT[phase] || phase;
  if (els.statusLine)
    els.statusLine.setAttribute(
      "aria-label",
      phase === "speaking" ? "Sharon is speaking — tap to stop her" : "Sharon's status"
    );
  updateLiveLabel();
}

export function setMicIndicator(live) {
  els.html.setAttribute("data-mic", live ? "live" : "muted");
  if (els.micBtn) {
    els.micBtn.setAttribute(
      "aria-label",
      live ? "Microphone is on — tap to mute" : "Microphone is off — tap to talk"
    );
    // The header button's job is "mute", so pressed = muted.
    els.micBtn.setAttribute("aria-pressed", live ? "false" : "true");
  }
  if (els.lcMute) {
    els.lcMute.textContent = live ? "Mute" : "Unmute";
    els.lcMute.setAttribute("aria-label", live ? "Mute the microphone" : "Unmute the microphone");
  }
  updateLiveLabel();
}

export function setVoiceIndicator(on) {
  els.html.setAttribute("data-voice", on ? "on" : "off");
  if (els.voiceBtn) els.voiceBtn.setAttribute("aria-label", on ? "Voice: on" : "Voice: off");
}

export function setTabTitle(title) {
  if (els.tabTitle) els.tabTitle.textContent = title || "open a website";
}

// The pill claims "Seeing this tab" ONLY when page context genuinely rides
// along (this turn, or with the next message under the opt-in rules);
// otherwise it says so plainly. The eye icon closes to match.
export function setTabAwareness(seeing) {
  if (els.tabPill) els.tabPill.setAttribute("data-seeing", seeing ? "on" : "off");
  if (els.tabSeeing) els.tabSeeing.textContent = seeing ? "Seeing this tab" : "Not reading this tab";
}

// The mode is reflected wherever its action button now lives — the Audio
// tab's Record button, the Video tab's Record-screen button, the "look at this
// tab" pill (the CSS keys off data-mode). aria-pressed follows on those
// buttons; the aria-live status line announces the mode change. NOTE: nothing
// about the tab bar is touched here — mode state and tab state are separate.
export function setMode(m) {
  els.html.setAttribute("data-mode", m);
  const pressed = {
    recording: els.recordBtn,
    screen_rec: els.screenRecBtn,
    screen: els.screenBtn,
  };
  for (const [name, btn] of Object.entries(pressed)) {
    if (btn) btn.setAttribute("aria-pressed", m === name ? "true" : "false");
  }
  if (els.screenBtn)
    els.screenBtn.setAttribute(
      "aria-label",
      m === "screen"
        ? "Looking at this tab — tap to stop"
        : "Look at this tab — I'll answer one question about it"
    );
  if (els.screenRecBtn)
    els.screenRecBtn.setAttribute(
      "aria-label",
      m === "screen_rec"
        ? "Recording your screen — tap to stop"
        : "Record your screen — up to 30 minutes"
    );
  if (els.searchIcon)
    els.searchIcon.setAttribute(
      "aria-label",
      m === "searching" ? "Searching the web" : "Web search indicator — lights up while I search"
    );
}

// Blue badge on the Library tab = open-task count.
export function setMemBadge(openTasks) {
  const n = Number(openTasks) || 0;
  const label = n > 0 ? "Library — " + n + " open task" + (n === 1 ? "" : "s") : "Library — everything saved";
  for (const badge of [els.memBadge, els.libraryTabBadge]) {
    if (!badge) continue;
    if (n > 0) {
      badge.textContent = n > 25 ? "25+" : String(n);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
  if (els.memoryBtn) els.memoryBtn.setAttribute("aria-label", label);
  if (els.libraryTab) els.libraryTab.setAttribute("aria-label", label);
}

export function setComposerHasText(hasText) {
  if (els.sendBtn) els.sendBtn.classList.toggle("hidden", !hasText);
}

/* ------------------------------------------------------------------ *
 * Live-presence card
 * ------------------------------------------------------------------ */
function capture() {
  return els.html.getAttribute("data-capture") || "idle";
}
export function setCapture(state) {
  els.html.setAttribute("data-capture", state);
  updateLiveLabel();
}

function updateLiveLabel() {
  if (!els.lcLabel) return;
  const micLive = els.html.getAttribute("data-mic") !== "muted";
  const phase = els.html.getAttribute("data-phase");
  if (!micLive) els.lcLabel.textContent = "Muted — tap the mic when you're ready";
  else if (phase === "hearing" || capture() !== "idle") els.lcLabel.textContent = "Hearing you";
  else els.lcLabel.textContent = "Listening — just talk";
}

export function liveTranscript(committed, interim) {
  if (!els.lcTranscript) return;
  const has = (committed || "").trim() || (interim || "").trim();
  els.lcTranscript.classList.toggle("hidden", !has);
  if (!has) return;
  els.lcText.innerHTML = "";
  if (committed) els.lcText.appendChild(document.createTextNode(committed + (interim ? " " : "")));
  if (interim) {
    const ghost = document.createElement("span");
    ghost.className = "interim";
    ghost.textContent = interim;
    els.lcText.appendChild(ghost);
  }
}

let stripTimer = null;
export function liveShowStrip(ms, onExpire) {
  if (!els.lcStrip) return;
  liveHideStrip();
  els.lcStrip.classList.remove("hidden");
  els.liveCard.style.setProperty("--countdown", ms + "ms");
  // restart the drain animation
  els.lcBarFill.classList.remove("run");
  void els.lcBarFill.offsetWidth;
  els.lcBarFill.classList.add("run");
  stripTimer = setTimeout(() => {
    stripTimer = null;
    onExpire && onExpire();
  }, ms);
}
export function liveHideStrip() {
  if (stripTimer) {
    clearTimeout(stripTimer);
    stripTimer = null;
  }
  if (els.lcStrip) els.lcStrip.classList.add("hidden");
  if (els.lcBarFill) els.lcBarFill.classList.remove("run");
}

export function liveOpenEditor(text) {
  liveHideStrip();
  if (els.lcTranscript) els.lcTranscript.classList.add("hidden");
  if (els.lcEdit) els.lcEdit.classList.remove("hidden");
  if (els.lcEditArea) {
    els.lcEditArea.value = text || "";
    els.lcEditArea.focus();
    try {
      els.lcEditArea.setSelectionRange(els.lcEditArea.value.length, els.lcEditArea.value.length);
    } catch (_) {
      /* ignore */
    }
  }
}
export function liveEditorValue() {
  return els.lcEditArea ? els.lcEditArea.value : "";
}
export function liveCloseEditor() {
  if (els.lcEdit) els.lcEdit.classList.add("hidden");
}

export function liveClear() {
  liveHideStrip();
  liveCloseEditor();
  if (els.lcTranscript) els.lcTranscript.classList.add("hidden");
  if (els.lcText) els.lcText.textContent = "";
}

/* ------------------------------------------------------------------ *
 * Recorder card — timer, live transcript, staged status
 * ------------------------------------------------------------------ */
const REC_LABEL = {
  recording: "Recording",
  uploading: "Uploading your recording…",
  organizing: "Organizing the notes…",
};
const REC_HINT = {
  recording: "Closing the panel ends the recording.",
  uploading: "A long recording can take a little while to upload.",
  organizing: "Distilling what mattered into your memory…",
};

// The big Record button on the Audio tab says what a tap will do right now.
const BIG_REC_LABEL = {
  recording: "Stop recording",
  uploading: "Saving…",
  organizing: "Organizing…",
};

export function showRecorder() {
  els.html.setAttribute("data-record", "on");
  if (els.recCard) els.recCard.classList.remove("hidden");
  if (els.recordBtn) els.recordBtn.setAttribute("aria-label", "Stop recording");
  showRecordingPill("audio");
}
export function hideRecorder() {
  els.html.removeAttribute("data-record");
  els.html.removeAttribute("data-recstage");
  if (els.recCard) els.recCard.classList.add("hidden");
  if (els.recordBtn)
    els.recordBtn.setAttribute("aria-label", "Record a voice memo — up to 30 minutes");
  if (els.recordBtnLabel) els.recordBtnLabel.textContent = "Record";
  hideRecordingPill("audio");
}

// stage: recording | uploading | organizing
export function setRecorderStage(stage) {
  els.html.setAttribute("data-recstage", stage);
  if (els.recordBtnLabel) els.recordBtnLabel.textContent = BIG_REC_LABEL[stage] || "Record";
  // The pill means "a recording is RUNNING" — it goes the moment the mic
  // stops, even though the upload/organize flow is still finishing.
  if (stage !== "recording") hideRecordingPill("audio");
  if (!els.recCard) return;
  els.recCard.setAttribute("data-stage", stage);
  if (els.recLabel) els.recLabel.textContent = REC_LABEL[stage] || stage;
  if (els.recHint) els.recHint.textContent = REC_HINT[stage] || "";
  if (els.recStop) els.recStop.classList.toggle("hidden", stage !== "recording");
}

export function setRecTimer(text) {
  if (els.recTimer) els.recTimer.textContent = text;
  setRecordingPillTime("audio", text);
}

// Same two-tone pattern as the listening flow: confirmed text normal,
// interim text lighter — kept scrolled to the newest words.
export function recTranscript(committed, interim) {
  if (!els.recTranscriptEl) return;
  const has = (committed || "").trim() || (interim || "").trim();
  els.recTranscriptEl.classList.toggle("hidden", !has);
  if (els.recText) els.recText.innerHTML = "";
  if (!has) return;
  if (committed) els.recText.appendChild(document.createTextNode(committed + (interim ? " " : "")));
  if (interim) {
    const ghost = document.createElement("span");
    ghost.className = "interim";
    ghost.textContent = interim;
    els.recText.appendChild(ghost);
  }
  els.recTranscriptEl.scrollTop = els.recTranscriptEl.scrollHeight;
}

/* ------------------------------------------------------------------ *
 * Screen-recorder card — a SEPARATE live card from the voice recorder
 * above, driven by the SCREEN_REC mode. It only ever shows a timer + Stop;
 * the finished video is offered as a download card in the thread below.
 * ------------------------------------------------------------------ */
export function showScreenRecorder() {
  els.html.setAttribute("data-screenrec", "on");
  if (els.screenRecCard) els.screenRecCard.classList.remove("hidden");
  if (els.screenRecBtn) els.screenRecBtn.setAttribute("aria-label", "Recording your screen — tap to stop");
  if (els.screenRecBtnLabel) els.screenRecBtnLabel.textContent = "Stop recording";
  showRecordingPill("video");
}
export function hideScreenRecorder() {
  els.html.removeAttribute("data-screenrec");
  if (els.screenRecCard) {
    els.screenRecCard.classList.add("hidden");
    els.screenRecCard.removeAttribute("data-paused");
  }
  if (els.screenRecLabel) els.screenRecLabel.textContent = "Recording your screen";
  if (els.screenRecBtn)
    els.screenRecBtn.setAttribute("aria-label", "Record your screen — up to 30 minutes");
  if (els.screenRecBtnLabel) els.screenRecBtnLabel.textContent = "Record screen";
  hideRecordingPill("video");
}
export function setScreenRecTimer(text) {
  if (els.screenRecTimer) els.screenRecTimer.textContent = text;
  setRecordingPillTime("video", text);
}
// Reflect the paused state on the live card (label + a data hook for the dot).
export function setScreenRecPaused(paused) {
  if (els.screenRecCard) els.screenRecCard.setAttribute("data-paused", paused ? "true" : "false");
  if (els.screenRecLabel) els.screenRecLabel.textContent = paused ? "Paused" : "Recording your screen";
  if (els.recPill && els.recPill.getAttribute("data-kind") === "video") {
    els.recPill.setAttribute("data-paused", paused ? "true" : "false");
    if (els.recPillLabel) els.recPillLabel.textContent = paused ? "Paused" : "Recording";
  }
}

/* ------------------------------------------------------------------ *
 * The persistent recording indicator (header) — a red dot, the word
 * "Recording", and the running timer, visible from EVERY tab because a
 * recording now keeps going while the user browses other screens. Tapping it
 * jumps to the tab that owns the recording (tabs.js wires that); it disappears
 * the moment recording stops. Purely an indicator: it never touches the
 * recorder or Sharon's mode.
 * ------------------------------------------------------------------ */
function showRecordingPill(kind) {
  if (!els.recPill) return;
  els.recPill.setAttribute("data-kind", kind);
  els.recPill.setAttribute("data-paused", "false");
  els.recPill.setAttribute(
    "aria-label",
    kind === "video" ? "Recording your screen — go to Video" : "Recording — go to Audio"
  );
  if (els.recPillLabel) els.recPillLabel.textContent = "Recording";
  els.recPill.classList.remove("hidden");
}

// Only the kind that owns the pill may take it down, so a stray call from the
// other recorder's idle path can't hide a live indicator.
function hideRecordingPill(kind) {
  if (!els.recPill) return;
  if (kind && els.recPill.getAttribute("data-kind") !== kind) return;
  els.recPill.classList.add("hidden");
}

// The cards' timers read "MM:SS / 30:00"; the pill shows just the elapsed part.
function setRecordingPillTime(kind, text) {
  if (!els.recPill || !els.recPillTimer) return;
  if (els.recPill.getAttribute("data-kind") !== kind) return;
  els.recPillTimer.textContent = String(text || "").split("/")[0].trim();
}

/* ------------------------------------------------------------------ *
 * Thread
 * ------------------------------------------------------------------ */
function scrollThread() {
  if (els.thread) els.thread.scrollTop = els.thread.scrollHeight;
}

function appendToThread(el) {
  if (els.emptyState) els.emptyState.classList.add("hidden");
  els.thread.appendChild(el);
  scrollThread();
  return el;
}

export function removeCard(el) {
  if (el && el.remove) el.remove();
  if (els.thread && els.emptyState && els.thread.querySelectorAll(".turn,.acard,.qcap").length === 0) {
    els.emptyState.classList.remove("hidden");
  }
}

function fmtTime(d) {
  try {
    return (d || new Date())
      .toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: DISPLAY_TZ })
      .toLowerCase()
      .replace(/\s+/g, " ");
  } catch (_) {
    return "";
  }
}

// "heard · 9:41 am" for spoken turns; typed turns show only the time.
export function addUserTurn(text, { spoken = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "turn turn-user";
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  wrap.appendChild(b);
  const cap = document.createElement("div");
  cap.className = "turn-cap";
  if (spoken) {
    cap.appendChild(svgOf(I_MIC));
    cap.appendChild(document.createTextNode("heard · " + fmtTime()));
  } else {
    cap.appendChild(document.createTextNode(fmtTime()));
  }
  wrap.appendChild(cap);
  return appendToThread(wrap);
}

export function addSharonBubble(text) {
  const wrap = document.createElement("div");
  wrap.className = "turn turn-sharon";
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  wrap.appendChild(b);
  return appendToThread(wrap);
}

export function addThinkingBubble() {
  const wrap = document.createElement("div");
  wrap.className = "turn turn-sharon turn-think";
  const b = document.createElement("div");
  b.className = "bubble";
  b.setAttribute("aria-label", "Sharon is thinking");
  b.innerHTML = '<span class="td"></span><span class="td"></span><span class="td"></span>';
  wrap.appendChild(b);
  return appendToThread(wrap);
}

/* --------- quiet capture (filed silently, with Undo) --------- */
export function addQuietCapture({ title, sub, onUndo } = {}) {
  const row = document.createElement("div");
  row.className = "qcap";
  const ic = document.createElement("span");
  ic.className = "qc-ic";
  ic.appendChild(svgOf(I_CHECK));
  row.appendChild(ic);
  const txt = document.createElement("div");
  txt.className = "qc-txt";
  const t = document.createElement("div");
  t.className = "qc-t";
  t.textContent = title || "Captured quietly — no reply needed";
  txt.appendChild(t);
  const s = document.createElement("div");
  s.className = "qc-s";
  s.textContent = sub || "Filed under notes in your Sheet";
  txt.appendChild(s);
  row.appendChild(txt);
  let undoBtn = null;
  if (onUndo) {
    undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.className = "qc-undo";
    undoBtn.textContent = "Undo";
    undoBtn.addEventListener("click", () => onUndo());
    row.appendChild(undoBtn);
  }
  appendToThread(row);
  return {
    el: row,
    markRemoved() {
      row.classList.add("removed");
      t.textContent = "Removed from your Sheet";
      s.remove();
      if (undoBtn) undoBtn.remove();
      const x = svgOf(I_X);
      ic.innerHTML = "";
      ic.appendChild(x);
    },
  };
}

/* --------- answer cards --------- */
function cardShell(iconInner, label, meta) {
  const card = document.createElement("div");
  card.className = "acard";
  const head = document.createElement("div");
  head.className = "ac-head";
  head.appendChild(svgOf(iconInner));
  const l = document.createElement("span");
  l.className = "ac-label";
  l.textContent = label;
  head.appendChild(l);
  if (meta) {
    const m = document.createElement("span");
    m.className = "ac-meta";
    m.textContent = meta;
    head.appendChild(m);
  }
  card.appendChild(head);
  return card;
}

function questionEcho(card, question) {
  if (!question) return;
  const q = document.createElement("p");
  q.className = "ac-q";
  q.textContent = "“" + question + "”";
  card.appendChild(q);
}

function cardFoot(card, text, { synced = false } = {}) {
  const f = document.createElement("div");
  f.className = "ac-foot" + (synced ? " synced" : "");
  f.appendChild(svgOf(synced ? I_CHECK : I_GLOBE));
  f.appendChild(document.createTextNode(text));
  card.appendChild(f);
  return f;
}

// THIS PAGE — recap card, only when the user asked for it.
export function addThisPageCard({ domain, question, title, bullets }) {
  const card = cardShell(I_DOC, "This page", domain || "");
  questionEcho(card, question);
  if (title) {
    const t = document.createElement("h3");
    t.className = "ac-title";
    t.textContent = title;
    card.appendChild(t);
  }
  const ul = document.createElement("ul");
  ul.className = "ac-bullets";
  for (const s of (bullets || []).slice(0, 5)) {
    const li = document.createElement("li");
    li.textContent = s;
    ul.appendChild(li);
  }
  card.appendChild(ul);
  const f = document.createElement("div");
  f.className = "ac-foot";
  f.appendChild(svgOf(I_DOC));
  f.appendChild(document.createTextNode("Source · this page" + (domain ? " — " + domain : "")));
  card.appendChild(f);
  return appendToThread(card);
}

// FROM YOUR NOTES — recall card; rows open the memory view. Recording hits
// play right in the panel instead, queued to the moment that matched.
export function addNotesCard({ question, hits, onRowTap, onListen }) {
  const n = hits.length;
  const card = cardShell(I_BOOK, "From your notes", n + (n === 1 ? " match" : " matches"));
  questionEcho(card, question);
  for (const h of hits) {
    const isRecording = h.entry_type === "recording";
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ac-note";
    const t = document.createElement("div");
    t.className = "n-t";
    t.textContent = h.title || h.content || "(untitled note)";
    row.appendChild(t);
    const when = metaTime(h.created_at);
    const meta =
      (when ? "Saved · " + when : "") +
      (isRecording && h.start_label ? (when ? " · " : "") + "the part at " + h.start_label : "");
    if (meta) {
      const m = document.createElement("div");
      m.className = "n-m";
      m.textContent = meta;
      row.appendChild(m);
    }
    row.addEventListener("click", () => {
      if (isRecording && onListen) onListen(h);
      else onRowTap && onRowTap(h);
    });
    card.appendChild(row);
  }
  cardFoot(card, "Synced with your Google Sheet", { synced: true });
  return appendToThread(card);
}

// YOUR TASKS — live checkboxes that write back to the Sheet.
export function addTasksCard({ hits, onToggle }) {
  const open = hits.filter((h) => String(h.status) !== "done").length;
  const card = cardShell(I_TASKS, "Your tasks", open + " open");
  for (const h of hits) {
    const row = document.createElement("div");
    row.className = "ac-task" + (String(h.status) === "done" ? " done" : "");
    const check = document.createElement("button");
    check.type = "button";
    check.className = "tk-check";
    check.setAttribute("role", "checkbox");
    const done = String(h.status) === "done";
    check.setAttribute("aria-checked", done ? "true" : "false");
    check.setAttribute("aria-label", done ? "Task done — tap to reopen" : "Open task — tap to mark done");
    check.appendChild(svgOf(I_CHECK));
    check.addEventListener("click", () => onToggle && onToggle(h, row, check));
    row.appendChild(check);
    const t = document.createElement("span");
    t.className = "t-t";
    t.textContent = h.title || h.content || "(untitled task)";
    row.appendChild(t);
    card.appendChild(row);
  }
  cardFoot(card, "Synced with your Google Sheet", { synced: true });
  return appendToThread(card);
}

// Flip one task row's visual state after a successful write-back.
export function setTaskRowDone(row, check, done) {
  row.classList.toggle("done", done);
  check.setAttribute("aria-checked", done ? "true" : "false");
  check.setAttribute("aria-label", done ? "Task done — tap to reopen" : "Open task — tap to mark done");
}

// LOOKED UP — answer sentence + optional fact tiles + source chips.
// Tiles/chips come from what is literally in the reply — nothing invented.
export function addLookedUpCard({ question, answer, tiles, chips }) {
  const card = cardShell(I_GLOBE, "Looked up", "");
  questionEcho(card, question);
  if (answer) {
    const p = document.createElement("p");
    p.className = "ac-body";
    p.textContent = answer;
    card.appendChild(p);
  }
  if (tiles && tiles.length) {
    const wrap = document.createElement("div");
    wrap.className = "ac-tiles";
    for (const t of tiles.slice(0, 3)) {
      const tile = document.createElement("div");
      tile.className = "ac-tile";
      const v = document.createElement("div");
      v.className = "tv";
      v.textContent = t.value;
      const l = document.createElement("div");
      l.className = "tl";
      l.textContent = t.label;
      tile.appendChild(v);
      tile.appendChild(l);
      wrap.appendChild(tile);
    }
    card.appendChild(wrap);
  }
  if (chips && chips.length) {
    const wrap = document.createElement("div");
    wrap.className = "ac-chips";
    for (const c of chips.slice(0, 3)) {
      const chip = document.createElement("span");
      chip.className = "ac-chip";
      chip.textContent = c;
      wrap.appendChild(chip);
    }
    card.appendChild(wrap);
  }
  return appendToThread(card);
}

// FROM THE WEB — live search results. Displayed layer: the question echoed,
// the bulleted answers exactly as verified, then clickable sources. The
// spoken layer (Sharon's natural explanation) attaches underneath.
export function addWebSearchCard({ question, bullets, sources }) {
  const card = cardShell(I_GLOBE, "From the web", "live search");
  questionEcho(card, question);

  if (bullets && bullets.length) {
    const ul = document.createElement("ul");
    ul.className = "ac-bullets";
    for (const s of bullets.slice(0, 6)) {
      const li = document.createElement("li");
      li.textContent = s;
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }

  if (sources && sources.length) {
    const wrap = document.createElement("div");
    wrap.className = "ac-srcs";
    for (const s of sources.slice(0, 5)) {
      if (!s || !s.url) continue;
      const a = document.createElement("a");
      a.className = "ac-src";
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.appendChild(svgOf(I_GLOBE));
      const t = document.createElement("span");
      t.className = "st";
      t.textContent = s.title || s.url;
      a.appendChild(t);
      const d = document.createElement("span");
      d.className = "sd";
      const m = String(s.url).match(/^[a-z]+:\/\/(?:www\.)?([^\/]+)/i);
      d.textContent = m ? m[1] : "";
      a.appendChild(d);
      wrap.appendChild(a);
    }
    card.appendChild(wrap);
  }

  const f = document.createElement("div");
  f.className = "ac-foot";
  f.appendChild(svgOf(I_GLOBE));
  f.appendChild(
    document.createTextNode(
      "Searched the live web · " + ((sources && sources.length) || 0) + " source" +
        ((sources && sources.length) === 1 ? "" : "s")
    )
  );
  card.appendChild(f);
  return appendToThread(card);
}

// RECORDING SAVED — the distilled notes from a voice recording. Each note
// is already in memory with the audio linked; the footer plays the source
// recording right in the panel (with the Drive link as the fallback).
export function addRecordingCard({ driveUrl, recordingId, durationLabel, notes, onListen }) {
  const card = cardShell(I_WAVE, "Recording saved", durationLabel || "");
  const list = Array.isArray(notes) ? notes : [];
  if (list.length) {
    const intro = document.createElement("p");
    intro.className = "ac-q";
    intro.textContent =
      list.length + (list.length === 1 ? " note" : " notes") +
      " saved to your memory — each links back to the audio.";
    card.appendChild(intro);
    for (const n of list) {
      const row = document.createElement("div");
      row.className = "ac-recnote";
      const chip = document.createElement("span");
      chip.className = "kind" + (n.entry_type === "task" ? " task" : "");
      chip.textContent = n.entry_type || "note";
      row.appendChild(chip);
      const txt = document.createElement("div");
      txt.className = "rn-txt";
      const t = document.createElement("div");
      t.className = "rn-t";
      t.textContent = n.title || n.content || "(untitled)";
      txt.appendChild(t);
      if (n.content && n.content !== n.title) {
        const c = document.createElement("div");
        c.className = "rn-c";
        c.textContent = n.content;
        txt.appendChild(c);
      }
      row.appendChild(txt);
      card.appendChild(row);
    }
  } else {
    const p = document.createElement("p");
    p.className = "ac-body";
    p.textContent =
      "Saved. I didn't find notes worth keeping this time — the full transcript is in your Sheet.";
    card.appendChild(p);
  }
  if (recordingId && onListen) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ac-foot ac-listen";
    btn.appendChild(svgOf(I_VOLUME));
    btn.appendChild(document.createTextNode("Listen to the recording · plays right here"));
    btn.addEventListener("click", () => onListen({ recordingId, driveUrl }));
    card.appendChild(btn);
  } else if (driveUrl) {
    const a = document.createElement("a");
    a.className = "ac-foot ac-listen";
    a.href = driveUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.appendChild(svgOf(I_VOLUME));
    a.appendChild(document.createTextNode("Listen to the recording · saved in your Drive"));
    card.appendChild(a);
  } else {
    cardFoot(card, "Synced with your Google Sheet", { synced: true });
  }
  return appendToThread(card);
}

// REVIEW YOUR RECORDING — shown after a screen recording stops, BEFORE it
// saves. A preview of the clip plus an iPhone-Photos-style two-handle trimmer:
// drag the start/end handles to keep only part of the clip, or leave them at
// the ends to keep the whole thing. This is pure UI — the orchestrator owns
// the Blob and the trim re-record; the chosen region comes back through
// onSave(startSeconds, endSeconds, durationSeconds) / onDiscard(). Returns a
// controller the orchestrator drives during trimming and teardown.
export function addScreenReviewCard({ url, onSave, onDiscard } = {}) {
  // The live timer card is done; hide it, and keep the panel in screen-record
  // context (data-screenrec on) so the live-presence card stays hidden while
  // the review card is up — including when reconnecting to a finished clip
  // after the panel was reopened (where the timer card was never shown).
  els.html.setAttribute("data-screenrec", "on");
  if (els.screenRecCard) els.screenRecCard.classList.add("hidden");
  // Recording has stopped — the persistent indicator goes, and the Video tab's
  // big button stops offering to stop something that already ended.
  hideRecordingPill("video");
  if (els.screenRecBtnLabel) els.screenRecBtnLabel.textContent = "Record screen";

  const card = cardShell(I_VIDEO, "Review your recording", "");
  const hint = document.createElement("p");
  hint.className = "ac-q";
  hint.textContent = "Drag the handles to trim, or just Save to keep the whole clip.";
  card.appendChild(hint);

  // --- preview video + centered play/pause overlay ---
  const stage = document.createElement("div");
  stage.className = "srv-stage";
  stage.setAttribute("data-playing", "false");
  const video = document.createElement("video");
  video.className = "srv-video";
  video.src = url;
  video.playsInline = true;
  video.preload = "auto";
  stage.appendChild(video);
  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "srv-play";
  playBtn.setAttribute("aria-label", "Play the recording");
  playBtn.appendChild(svgOf(I_PLAY, "i-play"));
  playBtn.appendChild(svgOf(I_PAUSE, "i-pause"));
  stage.appendChild(playBtn);
  card.appendChild(stage);

  // --- trim timeline: track, kept-region highlight, playhead, two handles ---
  const tl = document.createElement("div");
  tl.className = "srv-tl";
  const track = document.createElement("div");
  track.className = "srv-track";
  const range = document.createElement("div");
  range.className = "srv-range";
  const playhead = document.createElement("div");
  playhead.className = "srv-playhead";
  const hStart = document.createElement("button");
  hStart.type = "button";
  hStart.className = "srv-h srv-h-start";
  hStart.setAttribute("aria-label", "Trim start");
  const hEnd = document.createElement("button");
  hEnd.type = "button";
  hEnd.className = "srv-h srv-h-end";
  hEnd.setAttribute("aria-label", "Trim end");
  track.append(range, playhead, hStart, hEnd);
  tl.appendChild(track);
  card.appendChild(tl);

  // --- live labels ---
  const labels = document.createElement("div");
  labels.className = "srv-labels";
  labels.innerHTML =
    'Start <b class="srv-ls">0:00</b> · End <b class="srv-le">0:00</b> · Length <b class="srv-ll">…</b>';
  card.appendChild(labels);
  const lblStart = labels.querySelector(".srv-ls");
  const lblEnd = labels.querySelector(".srv-le");
  const lblLen = labels.querySelector(".srv-ll");

  // --- trimming progress (hidden until a real trim runs) ---
  const progress = document.createElement("div");
  progress.className = "srv-progress hidden";
  card.appendChild(progress);

  // --- actions ---
  const row = document.createElement("div");
  row.className = "src-actions";
  const playSelBtn = document.createElement("button");
  playSelBtn.type = "button";
  playSelBtn.className = "pill-btn";
  playSelBtn.textContent = "Play selection";
  const discardBtn = document.createElement("button");
  discardBtn.type = "button";
  discardBtn.className = "pill-btn";
  discardBtn.textContent = "Discard";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "pill-btn primary";
  saveBtn.appendChild(svgOf(I_DOWNLOAD));
  saveBtn.appendChild(document.createTextNode("Save"));
  saveBtn.disabled = true; // enabled once the duration resolves
  row.append(playSelBtn, discardBtn, saveBtn);
  card.appendChild(row);

  // ---- state + interaction ----
  let dur = 0;
  let startT = 0;
  let endT = 0;
  let ready = false; // duration resolved, slider live
  let busy = false; // trimming in progress — freeze the controls
  let playingSelection = false;

  const minGap = () => Math.min(0.3, dur * 0.05); // keep at least a sliver

  function layout() {
    const sP = dur > 0 ? startT / dur : 0;
    const eP = dur > 0 ? endT / dur : 1;
    hStart.style.left = sP * 100 + "%";
    hEnd.style.left = eP * 100 + "%";
    range.style.left = sP * 100 + "%";
    range.style.right = (1 - eP) * 100 + "%";
    lblStart.textContent = fmtSecs(startT);
    lblEnd.textContent = fmtSecs(endT);
    lblLen.textContent = fmtSecs(Math.max(0, endT - startT));
  }
  function setPlayhead(t) {
    const p = dur > 0 ? Math.max(0, Math.min(1, t / dur)) : 0;
    playhead.style.left = p * 100 + "%";
  }
  function seekPreview(t) {
    playingSelection = false;
    try {
      video.currentTime = t;
    } catch (_) {
      /* ignore */
    }
    setPlayhead(t);
  }
  function trackFrac(clientX) {
    const r = track.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  }
  function beginDrag(handle, downEv) {
    if (busy || !ready) return;
    downEv.preventDefault();
    try {
      handle.setPointerCapture(downEv.pointerId);
    } catch (_) {
      /* ignore */
    }
    handle.setAttribute("data-drag", "on");
    const gap = minGap();
    const onMove = (e) => {
      const t = trackFrac(e.clientX) * dur;
      if (handle === hStart) startT = Math.max(0, Math.min(t, endT - gap));
      else endT = Math.min(dur, Math.max(t, startT + gap));
      layout();
      seekPreview(handle === hStart ? startT : endT);
    };
    const onUp = () => {
      try {
        handle.releasePointerCapture(downEv.pointerId);
      } catch (_) {
        /* ignore */
      }
      handle.removeAttribute("data-drag");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }
  hStart.addEventListener("pointerdown", (e) => beginDrag(hStart, e));
  hEnd.addEventListener("pointerdown", (e) => beginDrag(hEnd, e));

  function togglePlay() {
    if (busy || !ready) return;
    if (video.paused) {
      playingSelection = false;
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }
  playBtn.addEventListener("click", togglePlay);
  video.addEventListener("click", togglePlay);
  video.addEventListener("play", () => stage.setAttribute("data-playing", "true"));
  video.addEventListener("pause", () => stage.setAttribute("data-playing", "false"));
  video.addEventListener("timeupdate", () => {
    setPlayhead(video.currentTime);
    // "Play selection" stops the moment it reaches the end handle.
    if (playingSelection && video.currentTime >= endT - 0.02) {
      video.pause();
      playingSelection = false;
    }
  });
  video.addEventListener("ended", () => {
    playingSelection = false;
  });

  playSelBtn.addEventListener("click", () => {
    if (busy || !ready) return;
    playingSelection = true;
    try {
      video.currentTime = startT;
    } catch (_) {
      /* ignore */
    }
    video.play().catch(() => {});
  });
  discardBtn.addEventListener("click", () => {
    if (!busy) onDiscard && onDiscard();
  });
  saveBtn.addEventListener("click", () => {
    if (!busy && ready) onSave && onSave(startT, endT, dur);
  });

  // ---- webm duration quirk: MediaRecorder .webm reports Infinity/NaN until
  // seeked. Force a real duration (seek far past the end → durationchange),
  // then reset to 0 and build the slider from that finite value. ----
  function onDurationReady(d) {
    if (ready) return;
    dur = d > 0 && isFinite(d) ? d : 0;
    startT = 0;
    endT = dur;
    ready = true;
    try {
      video.currentTime = 0;
    } catch (_) {
      /* ignore */
    }
    setPlayhead(0);
    layout();
    saveBtn.disabled = false;
  }
  video.addEventListener(
    "loadedmetadata",
    () => {
      if (isFinite(video.duration) && video.duration > 0) {
        onDurationReady(video.duration);
        return;
      }
      const onDur = () => {
        if (!isFinite(video.duration) || video.duration <= 0) return;
        video.removeEventListener("durationchange", onDur);
        onDurationReady(video.duration);
      };
      video.addEventListener("durationchange", onDur);
      try {
        video.currentTime = 1e7;
      } catch (_) {
        onDurationReady(0);
      }
    },
    { once: true }
  );

  appendToThread(card);

  return {
    el: card,
    video,
    // Freeze the controls and show real-time trim progress.
    setTrimming(text) {
      busy = true;
      try {
        video.pause();
      } catch (_) {
        /* ignore */
      }
      progress.classList.remove("hidden");
      progress.textContent = text || "Trimming…";
      saveBtn.disabled = true;
      discardBtn.disabled = true;
      playSelBtn.disabled = true;
    },
    updateTrimming(text) {
      progress.textContent = text;
    },
    // Release the preview video and remove the card (teardown / after save).
    remove() {
      try {
        video.pause();
      } catch (_) {
        /* ignore */
      }
      try {
        video.removeAttribute("src");
        video.load();
      } catch (_) {
        /* ignore */
      }
      removeCard(card);
    },
  };
}

// YOUR RECORDINGS — the browse-all list surfaced by voice ("show me my
// recordings"). Each row plays that recording right in the panel; when there
// are more than fit, the footer opens the full list in the memory view.
export function addRecordingsListCard({ recordings, onListen, onOpenAll } = {}) {
  const list = Array.isArray(recordings) ? recordings : [];
  const card = cardShell(
    I_WAVE,
    "Your recordings",
    list.length + (list.length === 1 ? " recording" : " recordings")
  );
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "ac-body";
    p.textContent =
      "You don't have any voice recordings yet — tap the round record button to make one.";
    card.appendChild(p);
    return appendToThread(card);
  }
  const SHOWN = 8;
  for (const h of list.slice(0, SHOWN)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ac-note";
    const t = document.createElement("div");
    t.className = "n-t";
    t.textContent = h.title || "Recording";
    row.appendChild(t);
    const when = metaTime(h.created_at);
    const notes = Number(h.notes_saved) || 0;
    const meta =
      (when ? "Saved · " + when : "") +
      (notes ? (when ? " · " : "") + notes + (notes === 1 ? " note" : " notes") : "");
    if (meta) {
      const m = document.createElement("div");
      m.className = "n-m";
      m.textContent = meta;
      row.appendChild(m);
    }
    row.addEventListener("click", () => onListen && onListen(h));
    card.appendChild(row);
  }
  if (list.length > SHOWN && onOpenAll) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ac-foot ac-listen";
    more.appendChild(svgOf(I_BOOK));
    more.appendChild(document.createTextNode("See all " + list.length + " recordings"));
    more.addEventListener("click", onOpenAll);
    card.appendChild(more);
  } else {
    cardFoot(card, "Tap any recording to play it here", { synced: true });
  }
  return appendToThread(card);
}

// Extract "Label: value" facts out of a reply for the LOOKED UP card.
export function extractFacts(text) {
  const lines = (text || "").split("\n");
  const tiles = [];
  const rest = [];
  for (const ln of lines) {
    const m = ln.trim().match(/^[-•*]?\s*([A-Za-z][^:\n]{1,32}):\s+(.{1,24})$/);
    if (m && !/^https?:/i.test(m[2].trim())) tiles.push({ label: m[1].trim(), value: m[2].trim() });
    else rest.push(ln);
  }
  if (tiles.length < 2) return null;
  return { tiles: tiles.slice(0, 3), rest: rest.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

// Spoken-aloud layer: the quiet italic line under a card Sharon reads.
export function attachSpokenLine(afterEl, text) {
  if (!text) return null;
  const line = document.createElement("div");
  line.className = "spoken-line";
  line.appendChild(svgOf(I_VOLUME));
  const s = document.createElement("span");
  s.textContent = text;
  line.appendChild(s);
  if (afterEl && afterEl.parentNode === els.thread) afterEl.after(line);
  else els.thread.appendChild(line);
  scrollThread();
  return line;
}

/* ------------------------------------------------------------------ *
 * In-panel audio player bar — pure DOM; the orchestrator owns the actual
 * Audio element and drives these. One bar, one recording at a time.
 * ------------------------------------------------------------------ */
function fmtSecs(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// Show the bar in its loading state (seek row hidden, toggle disabled).
export function playerShow({ label, driveUrl } = {}) {
  if (!els.playerBar) return;
  els.playerBar.classList.remove("hidden");
  els.playerBar.setAttribute("data-state", "loading");
  els.playerBar.setAttribute("data-playing", "false");
  if (els.plLabel) els.plLabel.textContent = label || "Recording";
  if (els.plCur) els.plCur.textContent = "0:00";
  if (els.plTotal) els.plTotal.textContent = "0:00";
  if (els.plSeek) els.plSeek.value = "0";
  if (els.plDrive) {
    if (driveUrl) {
      els.plDrive.href = driveUrl;
      els.plDrive.classList.remove("hidden");
    } else {
      els.plDrive.classList.add("hidden");
    }
  }
}

export function playerReady(durationSeconds) {
  if (!els.playerBar) return;
  els.playerBar.setAttribute("data-state", "ready");
  if (els.plSeek) els.plSeek.max = String(Math.max(1, Math.round(durationSeconds || 0)));
  if (els.plTotal) els.plTotal.textContent = fmtSecs(durationSeconds);
}

export function playerSetPlaying(playing) {
  if (!els.playerBar) return;
  els.playerBar.setAttribute("data-playing", playing ? "true" : "false");
  if (els.plToggle) els.plToggle.setAttribute("aria-label", playing ? "Pause" : "Play");
}

export function playerSetTime(current, duration) {
  if (els.plCur) els.plCur.textContent = fmtSecs(current);
  if (duration && els.plTotal) els.plTotal.textContent = fmtSecs(duration);
  // Don't fight the user's thumb mid-drag.
  if (els.plSeek && !els.plSeek.matches(":active")) {
    els.plSeek.value = String(Math.round(Number(current) || 0));
  }
}

export function playerHide() {
  if (els.playerBar) els.playerBar.classList.add("hidden");
}

/* --------- undo toast --------- */
let toastTimer = null;
export function showUndoToast({ label, onUndo, duration = 4000 } = {}) {
  dismissToast();
  if (!els.undoToast) return;
  els.toastLabel.textContent = label || "Sent what I heard";
  // A toast without an undo action is just a quiet confirmation line.
  if (els.toastUndo) els.toastUndo.classList.toggle("hidden", !onUndo);
  els.undoToast.classList.remove("hidden");
  const undoOnce = () => {
    dismissToast();
    onUndo && onUndo();
  };
  els.toastUndo.onclick = undoOnce;
  toastTimer = setTimeout(dismissToast, duration);
}
export function dismissToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (els.undoToast) {
    els.undoToast.classList.add("hidden");
    els.toastUndo.onclick = null;
  }
}

/* ------------------------------------------------------------------ *
 * Library view — everything saved, in one list (formerly "Sharon's memory")
 * ------------------------------------------------------------------ */
// The one door for switching screens: set data-view and nothing else. Called
// by tabs.js on a tab tap — navigation only, never a mode change.
export function setView(view) {
  if (view !== "library") exitMemSelect(); // no half-finished selection left behind
  els.html.setAttribute("data-view", view);
}
export function openLibrary() {
  els.html.setAttribute("data-view", "library");
}
export function closeLibrary() {
  exitMemSelect(); // never leave a half-finished selection behind
  els.html.setAttribute("data-view", "chat");
}
export function libraryOpen() {
  return els.html.getAttribute("data-view") === "library";
}

export function setMemorySubtitle(n, atLimit) {
  if (!els.memSubtitle) return;
  els.memSubtitle.textContent =
    (atLimit ? n + "+" : String(n)) +
    (n === 1 && !atLimit ? " thing saved" : " things saved") +
    " · your “Speaking Assistant” Sheet";
}

// A plain subtitle line for the Library's non-Sheet filters (local videos).
export function setMemorySubtitleText(text) {
  if (els.memSubtitle) els.memSubtitle.textContent = text;
}

// The Library footer, worded for whatever the list is actually showing.
export function setSyncedFooter(text) {
  if (els.memSynced) els.memSynced.textContent = text;
}

export function setRecordingsSubtitle(n) {
  if (!els.memSubtitle) return;
  els.memSubtitle.textContent =
    (n === 1 ? "1 voice recording" : n + " voice recordings") + " · tap any to play it here";
}

export function memorySyncedNow() {
  if (els.memSynced) els.memSynced.textContent = "Synced with your Google Sheet · just now";
}

export function memLoading() {
  if (els.memList) els.memList.innerHTML = '<div class="mem-loading">Looking through your Sheet…</div>';
  // Whatever the last filter left in the footer, a fresh load starts from the
  // honest default (the Video filter overwrites it again once it has loaded).
  setSyncedFooter("Synced with your Google Sheet");
}
export function memError(message) {
  if (!els.memList) return;
  els.memList.innerHTML = "";
  const err = document.createElement("div");
  err.className = "mem-empty";
  err.textContent = message;
  els.memList.appendChild(err);
}

export function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diff = Date.now() - then.getTime();
  if (diff < 60000) return "just now";
  const min = Math.floor(diff / 60000);
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return day + "d ago";
  try {
    return then.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: DISPLAY_TZ });
  } catch (_) {
    return day + "d ago";
  }
}

// "today 3:02 pm" / "yesterday 3:02 pm" / "Mon 2:14 pm" / "Jun 3"
export function metaTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  const t = fmtTime(d);
  try {
    if (days === 0) return "today " + t;
    if (days === 1) return "yesterday " + t;
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short", timeZone: DISPLAY_TZ }) + " " + t;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: DISPLAY_TZ });
  } catch (_) {
    return t;
  }
}

function groupLabel(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "Earlier";
  const now = new Date();
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Earlier this week";
  try {
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: DISPLAY_TZ });
  } catch (_) {
    return "Earlier";
  }
}

let memCache = { hits: [], cb: {} };
let memFilter = "all";
// The orchestrator registers this so it can fetch the right data when a
// filter needs its own source (Recordings live in a separate sheet, not in
// the loaded memory list). Returning true means "I've taken over loading and
// will re-render" — the pure client-side filters (all/notes/tasks/done) just
// re-slice the already-loaded list, so the handler returns falsy for those.
let onMemFilterChange = null;
export function setMemFilterHandler(fn) {
  onMemFilterChange = typeof fn === "function" ? fn : null;
}

function applyFilterPills(name) {
  // The active filter is a styling hook too: the Video filter shows locally
  // stored clips, which aren't Sheet rows and so can't be multi-selected.
  els.html.setAttribute("data-lib-filter", name || "all");
  if (!els.memFilters) return;
  els.memFilters.querySelectorAll(".m-pill").forEach((b) => {
    const on = (b.getAttribute("data-filter") || "all") === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

// Programmatically select a filter (used when a voice request or the search
// box needs to steer the memory view), mirroring a pill tap.
export function selectFilter(name) {
  memFilter = name || "all";
  applyFilterPills(memFilter);
}

function wireMemoryFilters() {
  if (!els.memFilters) return;
  els.memFilters.querySelectorAll(".m-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      memFilter = btn.getAttribute("data-filter") || "all";
      applyFilterPills(memFilter);
      // Let the orchestrator load a filter-specific source if it needs to;
      // otherwise this is a client-side re-slice of what's already loaded.
      if (onMemFilterChange && onMemFilterChange(memFilter)) return;
      renderMemList();
    });
  });
}

function passesFilter(h) {
  const isRecording = h.entry_type === "recording";
  // Video is backed by the local IndexedDB store, not the Sheet — the
  // orchestrator renders those rows itself (see renderLocalVideos).
  if (memFilter === "video") return false;
  // Voice recordings only ever appear under the Audio filter — never mixed
  // into All / Notes / Tasks / Done.
  if (memFilter === "audio") return isRecording;
  if (isRecording) return false;
  const isTask = h.entry_type === "task";
  const isDone = String(h.status) === "done";
  if (memFilter === "notes") return !isTask;
  if (memFilter === "tasks") return isTask;
  if (memFilter === "done") return isDone;
  return true;
}

/* --------- selection mode (multi-select bulk editing) --------- */
const LONG_PRESS_MS = 500;
let memSelect = false;
let selIds = new Set(); // entry_ids currently selected
let suppressClick = false; // swallow the click that trails a long-press
let delConfirmTimer = null;

function selectableHit_(h) {
  // Any saved row with an id can be selected for bulk delete — recordings
  // included (they support delete/undelete just like notes and tasks).
  return !!(h && h.entry_id);
}

function selectedHits() {
  return memCache.hits.filter((h) => selIds.has(String(h.entry_id || "")));
}

export function memSelectActive() {
  return memSelect;
}

export function enterMemSelect(seed) {
  if (memSelect) return;
  memSelect = true;
  els.html.setAttribute("data-mem-select", "on");
  if (seed && selectableHit_(seed)) selIds.add(String(seed.entry_id));
  renderMemList();
  updateSelUI();
}

export function exitMemSelect() {
  if (!memSelect) return;
  memSelect = false;
  selIds.clear();
  resetDeleteConfirm();
  els.html.removeAttribute("data-mem-select");
  renderMemList();
}

function toggleSelect(h, row) {
  const id = String(h.entry_id || "");
  if (!id || !selectableHit_(h)) return;
  if (selIds.has(id)) {
    selIds.delete(id);
    if (!selIds.size) {
      // Deselecting the last item leaves selection mode entirely.
      exitMemSelect();
      return;
    }
  } else {
    selIds.add(id);
  }
  if (row) row.setAttribute("aria-selected", selIds.has(id) ? "true" : "false");
  updateSelUI();
}

function updateSelUI() {
  if (!memSelect || !els.selCount) return;
  const n = selIds.size;
  els.selCount.textContent = n
    ? n + " selected"
    : "Select items";
  const sel = selectedHits();
  const openTasks = sel.filter((h) => h.entry_type === "task" && String(h.status) !== "done");
  const doneTasks = sel.filter((h) => h.entry_type === "task" && String(h.status) === "done");
  // Actions that don't apply to the selection are disabled (notes have no
  // status, so Mark complete needs at least one open task); Reopen only
  // shows up once a completed item is in the selection.
  if (els.selDoneBtn) els.selDoneBtn.disabled = !openTasks.length;
  if (els.selReopenBtn) els.selReopenBtn.classList.toggle("hidden", !doneTasks.length);
  if (els.selDeleteBtn) els.selDeleteBtn.disabled = !n;
  resetDeleteConfirm();
}

function resetDeleteConfirm() {
  if (delConfirmTimer) {
    clearTimeout(delConfirmTimer);
    delConfirmTimer = null;
  }
  if (els.selDeleteBtn && els.selDeleteBtn.hasAttribute("data-confirm")) {
    els.selDeleteBtn.removeAttribute("data-confirm");
    els.selDeleteBtn.textContent = "Delete";
  }
}

function wireMemorySelection() {
  if (els.memSelectBtn) els.memSelectBtn.addEventListener("click", () => enterMemSelect());
  if (els.selCancel) els.selCancel.addEventListener("click", () => exitMemSelect());
  if (els.selAllBtn)
    els.selAllBtn.addEventListener("click", () => {
      // Everything currently visible under the active filter (and search) —
      // never items the filter is hiding, never read-only recordings.
      memCache.hits.filter(passesFilter).forEach((h) => {
        if (selectableHit_(h)) selIds.add(String(h.entry_id));
      });
      renderMemList();
      updateSelUI();
    });
  if (els.selDoneBtn)
    els.selDoneBtn.addEventListener("click", () => {
      const targets = selectedHits().filter(
        (h) => h.entry_type === "task" && String(h.status) !== "done"
      );
      if (targets.length && memCache.cb.onBatchStatus) memCache.cb.onBatchStatus(targets, "done");
    });
  if (els.selReopenBtn)
    els.selReopenBtn.addEventListener("click", () => {
      const targets = selectedHits().filter(
        (h) => h.entry_type === "task" && String(h.status) === "done"
      );
      if (targets.length && memCache.cb.onBatchStatus) memCache.cb.onBatchStatus(targets, "open");
    });
  if (els.selDeleteBtn)
    els.selDeleteBtn.addEventListener("click", () => {
      const targets = selectedHits().filter(selectableHit_);
      if (!targets.length) return;
      // One in-place confirmation: the button itself asks "Delete 5 items?"
      // and a second tap (within a few seconds) goes through with it.
      if (!els.selDeleteBtn.hasAttribute("data-confirm")) {
        els.selDeleteBtn.setAttribute("data-confirm", "1");
        els.selDeleteBtn.textContent =
          "Delete " + targets.length + (targets.length === 1 ? " item?" : " items?");
        delConfirmTimer = setTimeout(resetDeleteConfirm, 4000);
        return;
      }
      resetDeleteConfirm();
      if (memCache.cb.onBatchDelete) memCache.cb.onBatchDelete(targets);
    });
}

export function renderMemory(hits, callbacks = {}) {
  memCache = { hits: Array.isArray(hits) ? hits : [], cb: callbacks };
  // Selection can only ever refer to entries that are actually loaded.
  if (selIds.size) {
    const live = new Set(memCache.hits.map((h) => String(h.entry_id || "")));
    for (const id of Array.from(selIds)) if (!live.has(id)) selIds.delete(id);
  }
  renderMemList();
  updateSelUI();
}

function emptyMessage() {
  if (memFilter === "tasks") return "No tasks here — say “remind me to…” and I'll save one.";
  if (memFilter === "done") return "Nothing marked done yet — tap a task's box when it's finished.";
  if (memFilter === "notes") return "No notes here — say “make a note…” and I'll save one.";
  if (memFilter === "audio")
    return "No voice recordings yet — tap Record on the Audio tab to make one.";
  if (memFilter === "video")
    return "No screen recordings kept here yet — tap Record screen on the Video tab.";
  return "Nothing saved yet — just talk, and what matters lands in your Sheet.";
}

function kindOf(h) {
  if (h.entry_type === "recording") return { cls: "recording", label: "recording" };
  if (String(h.status) === "done") return { cls: "done", label: "done" };
  if (h.entry_type === "task") return { cls: "task", label: "task" };
  return { cls: "", label: h.entry_type ? String(h.entry_type) : "note" };
}

function renderMemList() {
  if (!els.memList) return;
  // Under the Video filter the list belongs to the local video store, which
  // the orchestrator draws — never overwrite it from the Sheet-backed cache.
  if (memFilter === "video") return;
  els.memList.innerHTML = "";
  const shown = memCache.hits.filter(passesFilter);
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "mem-empty";
    empty.textContent = emptyMessage();
    els.memList.appendChild(empty);
    return;
  }

  const { onToggleDone, onDelete, onListen } = memCache.cb;
  let lastGroup = null;
  let groupCard = null;
  for (const h of shown) {
    const g = groupLabel(h.created_at);
    if (g !== lastGroup) {
      lastGroup = g;
      const head = document.createElement("div");
      head.className = "mg-head";
      head.textContent = g;
      els.memList.appendChild(head);
      groupCard = document.createElement("div");
      groupCard.className = "mg-card";
      els.memList.appendChild(groupCard);
    }

    const isDone = String(h.status) === "done";
    const canSelect = selectableHit_(h);
    const item = document.createElement("div");
    item.className = "mi" + (isDone ? " done" : "") + (memSelect && !canSelect ? " noselect" : "");

    const row = document.createElement("button");
    row.type = "button";
    row.className = "mi-row";
    if (memSelect) {
      // Rows are selection targets now — expose that instead of expansion.
      row.setAttribute(
        "aria-selected",
        canSelect && selIds.has(String(h.entry_id)) ? "true" : "false"
      );
      if (!canSelect) row.setAttribute("aria-disabled", "true");
      // The selection mark: a blue circle, deliberately round so it can't be
      // read as the square green task done-checkbox.
      const selMark = document.createElement("span");
      selMark.className = "mi-sel";
      selMark.appendChild(svgOf(I_CHECK));
      row.appendChild(selMark);
    } else {
      row.setAttribute("aria-expanded", "false");
    }
    const kind = kindOf(h);
    const chip = document.createElement("span");
    chip.className = "kind" + (kind.cls ? " " + kind.cls : "");
    chip.textContent = kind.label;
    row.appendChild(chip);
    const txt = document.createElement("div");
    txt.className = "mi-txt";
    const t = document.createElement("div");
    t.className = "mi-t";
    t.textContent = h.title || h.content || "(untitled)";
    txt.appendChild(t);
    const when = metaTime(h.created_at);
    const metaText = when ? "Saved · " + when : "";
    if (metaText) {
      const m = document.createElement("div");
      m.className = "mi-m";
      m.textContent = metaText;
      txt.appendChild(m);
    }
    row.appendChild(txt);
    row.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (memSelect) {
        if (canSelect) toggleSelect(h, row);
        return;
      }
      const open = item.classList.toggle("open");
      row.setAttribute("aria-expanded", open ? "true" : "false");
    });
    // Press-and-hold (~500ms) on any row enters selection mode directly.
    let lpTimer = null;
    row.addEventListener("pointerdown", (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      suppressClick = false;
      if (lpTimer) clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        lpTimer = null;
        suppressClick = true; // the release click IS the long-press, not a tap
        if (!memSelect) enterMemSelect(h);
        else if (canSelect && !selIds.has(String(h.entry_id))) toggleSelect(h, row);
      }, LONG_PRESS_MS);
    });
    const cancelPress = () => {
      if (lpTimer) {
        clearTimeout(lpTimer);
        lpTimer = null;
      }
    };
    row.addEventListener("pointerup", cancelPress);
    row.addEventListener("pointerleave", cancelPress);
    row.addEventListener("pointercancel", cancelPress);
    item.appendChild(row);

    // expanded action row — recordings are read-only: no edit/delete, just
    // Listen, which plays right in the panel (Drive stays the fallback).
    const actions = document.createElement("div");
    actions.className = "mi-actions";
    if (h.entry_type === "recording") {
      if (onListen) {
        const listen = document.createElement("button");
        listen.type = "button";
        listen.className = "pill-btn primary";
        listen.textContent = "Listen" + (h.start_label ? " from " + h.start_label : "");
        listen.addEventListener("click", () => onListen(h));
        actions.appendChild(listen);
      } else if (h.page_url) {
        const listen = document.createElement("a");
        listen.className = "pill-btn primary";
        listen.href = h.page_url;
        listen.target = "_blank";
        listen.rel = "noopener noreferrer";
        listen.textContent = "Listen";
        actions.appendChild(listen);
      }
      // Recordings are deletable now — same Delete affordance as notes/tasks.
      if (h.entry_id) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "pill-btn danger";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", () => onDelete && onDelete(h));
        actions.appendChild(delBtn);
      }
    } else {
      if (h.entry_type === "task" && h.entry_id) {
        const doneBtn = document.createElement("button");
        doneBtn.type = "button";
        doneBtn.className = "pill-btn primary";
        doneBtn.textContent = isDone ? "Reopen" : "Mark done";
        doneBtn.addEventListener("click", () => onToggleDone && onToggleDone(h));
        actions.appendChild(doneBtn);
      }
      if (h.entry_id) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "pill-btn danger";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", () => onDelete && onDelete(h));
        actions.appendChild(delBtn);
      }
    }
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    actions.appendChild(spacer);
    if (actions.querySelector("button,a")) item.appendChild(actions);

    groupCard.appendChild(item);
  }
}

/* ------------------------------------------------------------------ *
 * Audio tab — the list of past voice recordings under the Record button.
 * Same data the Library's Audio filter loads (the recordings sheet); tapping
 * a row plays it in the panel through the existing player bar.
 * ------------------------------------------------------------------ */
function listShell(container, message) {
  if (!container) return null;
  // Free any in-panel video player this list was holding before the rows go.
  container.querySelectorAll("[data-url]").forEach(releasePlayer);
  container.innerHTML = "";
  if (message) {
    const empty = document.createElement("div");
    empty.className = "mem-empty";
    empty.textContent = message;
    container.appendChild(empty);
    return null;
  }
  const card = document.createElement("div");
  card.className = "mg-card";
  container.appendChild(card);
  return card;
}

export function audioListLoading() {
  if (els.audioList)
    els.audioList.innerHTML = '<div class="mem-loading">Looking through your recordings…</div>';
}

export function setAudioSubtitle(text) {
  if (els.audioSubtitle) els.audioSubtitle.textContent = text;
}

export function renderAudioList(recordings, { onListen } = {}) {
  const list = Array.isArray(recordings) ? recordings : [];
  const card = listShell(
    els.audioList,
    list.length ? "" : "No voice recordings yet — tap Record above and start talking."
  );
  if (!card) return;
  for (const h of list) {
    const item = document.createElement("div");
    item.className = "mi";
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mi-row";
    const ic = document.createElement("span");
    ic.className = "av-ic";
    ic.appendChild(svgOf(I_WAVE));
    row.appendChild(ic);
    const txt = document.createElement("div");
    txt.className = "mi-txt";
    const t = document.createElement("div");
    t.className = "mi-t";
    t.textContent = h.title || "Recording";
    txt.appendChild(t);
    const when = metaTime(h.created_at);
    const notes = Number(h.notes_saved) || 0;
    const meta =
      (when ? when : "") + (notes ? (when ? " · " : "") + notes + (notes === 1 ? " note" : " notes") : "");
    if (meta) {
      const m = document.createElement("div");
      m.className = "mi-m";
      m.textContent = meta;
      txt.appendChild(m);
    }
    row.appendChild(txt);
    const play = document.createElement("span");
    play.className = "av-go";
    play.appendChild(svgOf(I_PLAY));
    row.appendChild(play);
    row.addEventListener("click", () => onListen && onListen(h));
    item.appendChild(row);
    card.appendChild(item);
  }
}

/* ------------------------------------------------------------------ *
 * Video tab (and the Library's Video filter) — the LOCAL clips: title, date,
 * length, file size, a still-frame thumbnail, in-panel playback, and a Delete
 * that removes ONLY this local copy. Nothing here uploads anything.
 * ------------------------------------------------------------------ */
export function videoListLoading() {
  if (els.videoList)
    els.videoList.innerHTML = '<div class="mem-loading">Looking through your screen recordings…</div>';
}

export function setVideoSubtitle(text) {
  if (els.videoSubtitle) els.videoSubtitle.textContent = text;
}

// The 2 GB local cap, stated plainly (and loudly when it's full).
export function setVideoQuota(text, full) {
  if (!els.videoQuota) return;
  els.videoQuota.textContent = text || "";
  els.videoQuota.classList.toggle("hidden", !text);
  els.videoQuota.setAttribute("data-full", full ? "true" : "false");
}

// Draw the local-video rows into any container (the Video tab's list, or the
// Library list when its Video filter is on).
export function renderVideoRows(container, videos, { onPlay, onDelete, fmtSize, fmtLen } = {}) {
  const list = Array.isArray(videos) ? videos : [];
  const card = listShell(
    container,
    list.length
      ? ""
      : "No screen recordings kept here yet. Recordings you save always download to your computer; a copy is kept here so you can play it back in the panel."
  );
  if (!card) return;
  for (const v of list) {
    const item = document.createElement("div");
    item.className = "mi";

    const row = document.createElement("button");
    row.type = "button";
    row.className = "mi-row";
    row.setAttribute("aria-expanded", "false");

    const thumb = document.createElement("span");
    thumb.className = "av-thumb";
    if (v.thumb) {
      const img = document.createElement("img");
      img.src = v.thumb;
      img.alt = "";
      thumb.appendChild(img);
    } else {
      thumb.appendChild(svgOf(I_VIDEO));
    }
    row.appendChild(thumb);

    const txt = document.createElement("div");
    txt.className = "mi-txt";
    const t = document.createElement("div");
    t.className = "mi-t";
    t.textContent = v.title || "Screen recording";
    txt.appendChild(t);
    const bits = [
      metaTime(v.createdAt),
      fmtLen ? fmtLen(v.durationSeconds) : "",
      fmtSize ? fmtSize(v.size) : "",
    ].filter(Boolean);
    if (bits.length) {
      const m = document.createElement("div");
      m.className = "mi-m";
      m.textContent = bits.join(" · ");
      txt.appendChild(m);
    }
    row.appendChild(txt);
    const go = document.createElement("span");
    go.className = "av-go";
    go.appendChild(svgOf(I_PLAY));
    row.appendChild(go);
    item.appendChild(row);

    // The player and the actions live in the row's expanded area, so a tap
    // never navigates away from the list.
    const body = document.createElement("div");
    body.className = "av-body";
    item.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "mi-actions av-actions";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "pill-btn danger";
    del.appendChild(svgOf(I_TRASH));
    del.appendChild(document.createTextNode("Delete"));
    const note = document.createElement("span");
    note.className = "av-note";
    note.textContent = "Removes Sharon's copy only — the file you saved on your computer stays put.";
    // One in-place confirmation, the same pattern as the Library's bulk delete.
    let armed = null;
    del.addEventListener("click", () => {
      if (!armed) {
        del.setAttribute("data-confirm", "1");
        del.lastChild.textContent = "Delete this copy?";
        armed = setTimeout(() => {
          armed = null;
          del.removeAttribute("data-confirm");
          del.lastChild.textContent = "Delete";
        }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      onDelete && onDelete(v);
    });
    actions.appendChild(del);
    actions.appendChild(note);
    item.appendChild(actions);

    row.addEventListener("click", () => {
      const open = item.classList.toggle("open");
      row.setAttribute("aria-expanded", open ? "true" : "false");
      if (!open) {
        releasePlayer(body);
        return;
      }
      onPlay && onPlay(v, body);
    });

    card.appendChild(item);
  }
}

// Drop an in-panel <video> into an expanded row. The orchestrator hands over
// the object URL it created; releasePlayer revokes it again.
export function mountVideoPlayer(body, url) {
  if (!body) return;
  releasePlayer(body);
  const v = document.createElement("video");
  v.className = "av-video";
  v.src = url;
  v.controls = true;
  v.playsInline = true;
  v.preload = "metadata";
  body.appendChild(v);
  body.setAttribute("data-url", url);
  v.play().catch(() => {
    /* the controls are right there if autoplay is refused */
  });
}

export function videoPlayerError(body, message) {
  if (!body) return;
  releasePlayer(body);
  const p = document.createElement("div");
  p.className = "av-err";
  p.textContent = message;
  body.appendChild(p);
}

export function releasePlayer(body) {
  if (!body) return;
  const v = body.querySelector("video");
  if (v) {
    try {
      v.pause();
      v.removeAttribute("src");
      v.load();
    } catch (_) {
      /* ignore */
    }
  }
  const url = body.getAttribute("data-url");
  if (url) {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {
      /* ignore */
    }
    body.removeAttribute("data-url");
  }
  body.innerHTML = "";
}

/* ------------------------------------------------------------------ *
 * First-run welcome
 * ------------------------------------------------------------------ */
export function showWelcome() {
  els.html.setAttribute("data-view", "welcome");
}
export function hideWelcome() {
  if (els.html.getAttribute("data-view") === "welcome") els.html.setAttribute("data-view", "chat");
}
export function welcomeVisible() {
  return els.html.getAttribute("data-view") === "welcome";
}

const W_STEPS = () => ({ mic: els.wStepMic, memory: els.wStepMemory, hello: els.wStepHello });
const W_HINTS = () => ({ mic: els.wMicHint, memory: els.wMemoryHint });

// state: pending | active | doing | done
export function setWelcomeStep(step, state, hint) {
  const el = W_STEPS()[step];
  if (!el) return;
  el.setAttribute("data-state", state);
  if (hint != null) {
    const h = W_HINTS()[step] || el.querySelector(".w-h");
    if (h) h.textContent = hint;
  }
}

/* ------------------------------------------------------------------ *
 * Settings bottom sheet
 * ------------------------------------------------------------------ */
export function openSettings() {
  if (els.scrim) els.scrim.classList.add("open");
  if (els.settingsSheet) els.settingsSheet.classList.add("open");
}
export function closeSettings() {
  if (els.scrim) els.scrim.classList.remove("open");
  if (els.settingsSheet) els.settingsSheet.classList.remove("open");
}
export function settingsOpen() {
  return !!(els.settingsSheet && els.settingsSheet.classList.contains("open"));
}

const SU_ROWS = () => ({
  mic: { row: els.suMic, status: els.suMicStatus },
  memory: { row: els.suMemory, status: els.suMemoryStatus },
  hello: { row: els.suHello, status: els.suHelloStatus },
});

export function setSetupRow(step, done, statusText) {
  const r = SU_ROWS()[step];
  if (!r || !r.row) return;
  r.row.setAttribute("data-done", done ? "true" : "false");
  if (statusText != null && r.status) r.status.textContent = statusText;
}
