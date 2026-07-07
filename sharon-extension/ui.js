// ui.js — everything Sharon draws: the header status line, the page-awareness
// pill, the live-presence card (streaming transcript → countdown → edit), the
// conversation thread (user bubbles, quiet captures, answer cards, the
// spoken-aloud layer, undo toast), the memory view, the first-run welcome,
// and the settings bottom sheet. No business logic lives here; the
// orchestrator registers callbacks and drives state.

export const els = {
  html: document.documentElement,
  statusLine: document.getElementById("statusLine"),
  statusText: document.getElementById("statusText"),
  voiceBtn: document.getElementById("voiceBtn"),
  memoryBtn: document.getElementById("memoryBtn"),
  memBadge: document.getElementById("memBadge"),
  settingsBtn: document.getElementById("settingsBtn"),
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
  memoryView: document.getElementById("memoryView"),
  memBack: document.getElementById("memBack"),
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
  recordBtn: document.getElementById("recordBtn"),
  screenBtn: document.getElementById("screenBtn"),
  searchIcon: document.getElementById("searchIcon"),
  memNavBtn: document.getElementById("memNavBtn"),
  memNavBadge: document.getElementById("memNavBadge"),
  recCard: document.getElementById("recCard"),
  recLabel: document.getElementById("recLabel"),
  recTimer: document.getElementById("recTimer"),
  recStop: document.getElementById("recStop"),
  recTranscriptEl: document.getElementById("recTranscript"),
  recText: document.getElementById("recText"),
  recHint: document.getElementById("recHint"),
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
};

// The user lives in Lake Tapps, WA — every date and time on screen is shown
// in their Pacific clock, so displayed timestamps stay honest even if the
// device's own timezone differs.
const DISPLAY_TZ = "America/Los_Angeles";

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
  if (els.micBtn)
    els.micBtn.setAttribute(
      "aria-label",
      live ? "Microphone is on — tap to mute" : "Microphone is off — tap to talk"
    );
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

// The mode bar reflects the manager's word: exactly one icon is lit, in the
// mode's color (the CSS keys off data-mode). aria-pressed follows on the
// tappable icons; the aria-live status line announces the mode change.
export function setMode(m) {
  els.html.setAttribute("data-mode", m);
  const pressed = { listening: els.micBtn, recording: els.recordBtn, screen: els.screenBtn };
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
  if (els.searchIcon)
    els.searchIcon.setAttribute(
      "aria-label",
      m === "searching" ? "Searching the web" : "Web search indicator — lights up while I search"
    );
}

// Blue badge on the memory (book) buttons = open-task count. The same count
// rides both the header button and the bottom-bar toggle so they stay in step.
export function setMemBadge(openTasks) {
  const n = Number(openTasks) || 0;
  const label = n > 0 ? "Sharon's memory — " + n + " open task" + (n === 1 ? "" : "s") : "Sharon's memory";
  for (const badge of [els.memBadge, els.memNavBadge]) {
    if (!badge) continue;
    if (n > 0) {
      badge.textContent = n > 25 ? "25+" : String(n);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
  if (els.memoryBtn) els.memoryBtn.setAttribute("aria-label", label);
  if (els.memNavBtn)
    els.memNavBtn.setAttribute(
      "aria-label",
      n > 0 ? label + " (notes, tasks and recordings)" : "Sharon's memory — notes, tasks and recordings"
    );
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

export function showRecorder() {
  els.html.setAttribute("data-record", "on");
  if (els.recCard) els.recCard.classList.remove("hidden");
  if (els.recordBtn) els.recordBtn.setAttribute("aria-label", "Stop recording");
}
export function hideRecorder() {
  els.html.removeAttribute("data-record");
  if (els.recCard) els.recCard.classList.add("hidden");
  if (els.recordBtn)
    els.recordBtn.setAttribute("aria-label", "Record a voice memo — up to 30 minutes");
}

// stage: recording | uploading | organizing
export function setRecorderStage(stage) {
  if (!els.recCard) return;
  els.recCard.setAttribute("data-stage", stage);
  if (els.recLabel) els.recLabel.textContent = REC_LABEL[stage] || stage;
  if (els.recHint) els.recHint.textContent = REC_HINT[stage] || "";
  if (els.recStop) els.recStop.classList.toggle("hidden", stage !== "recording");
}

export function setRecTimer(text) {
  if (els.recTimer) els.recTimer.textContent = text;
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
  const card = cardShell(I_MIC, "Recording saved", durationLabel || "");
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

// YOUR RECORDINGS — the browse-all list surfaced by voice ("show me my
// recordings"). Each row plays that recording right in the panel; when there
// are more than fit, the footer opens the full list in the memory view.
export function addRecordingsListCard({ recordings, onListen, onOpenAll } = {}) {
  const list = Array.isArray(recordings) ? recordings : [];
  const card = cardShell(
    I_MIC,
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
 * Memory view — "Sharon's memory"
 * ------------------------------------------------------------------ */
export function openMemory() {
  els.html.setAttribute("data-view", "memory");
  if (els.memNavBtn) els.memNavBtn.setAttribute("aria-pressed", "true");
}
export function closeMemory() {
  exitMemSelect(); // never leave a half-finished selection behind
  els.html.setAttribute("data-view", "chat");
  if (els.memNavBtn) els.memNavBtn.setAttribute("aria-pressed", "false");
}
export function memoryOpen() {
  return els.html.getAttribute("data-view") === "memory";
}

export function setMemorySubtitle(n, atLimit) {
  if (!els.memSubtitle) return;
  els.memSubtitle.textContent =
    (atLimit ? n + "+" : String(n)) +
    (n === 1 && !atLimit ? " thing saved" : " things saved") +
    " · your “Speaking Assistant” Sheet";
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
  // Recordings only ever appear under their own filter — never mixed into
  // All / Notes / Tasks / Done.
  if (memFilter === "recordings") return isRecording;
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
  if (memFilter === "recordings")
    return "No voice recordings yet — tap the round record button to make one.";
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
