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
  composer: document.getElementById("composer"),
  composerInput: document.getElementById("composerInput"),
  sendBtn: document.getElementById("sendBtn"),
  micBtn: document.getElementById("micBtn"),
  recordBtn: document.getElementById("recordBtn"),
  recCard: document.getElementById("recCard"),
  recLabel: document.getElementById("recLabel"),
  recTimer: document.getElementById("recTimer"),
  recStop: document.getElementById("recStop"),
  recTranscriptEl: document.getElementById("recTranscript"),
  recText: document.getElementById("recText"),
  recHint: document.getElementById("recHint"),
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

export function initUI() {
  wireMemoryFilters();
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

// Blue badge on the memory (book) button = open-task count.
export function setMemBadge(openTasks) {
  if (!els.memBadge) return;
  const n = Number(openTasks) || 0;
  if (n > 0) {
    els.memBadge.textContent = n > 25 ? "25+" : String(n);
    els.memBadge.classList.remove("hidden");
  } else {
    els.memBadge.classList.add("hidden");
  }
  if (els.memoryBtn)
    els.memoryBtn.setAttribute(
      "aria-label",
      n > 0 ? "Sharon's memory — " + n + " open task" + (n === 1 ? "" : "s") : "Sharon's memory"
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
      .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
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

// FROM YOUR NOTES — recall card; rows open the memory view.
export function addNotesCard({ question, hits, onRowTap }) {
  const n = hits.length;
  const card = cardShell(I_BOOK, "From your notes", n + (n === 1 ? " match" : " matches"));
  questionEcho(card, question);
  for (const h of hits) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "ac-note";
    const t = document.createElement("div");
    t.className = "n-t";
    t.textContent = h.title || h.content || "(untitled note)";
    row.appendChild(t);
    const when = metaTime(h.created_at);
    if (when) {
      const m = document.createElement("div");
      m.className = "n-m";
      m.textContent = "Saved · " + when;
      row.appendChild(m);
    }
    row.addEventListener("click", () => onRowTap && onRowTap(h));
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
// is already in memory with the audio linked; the footer link plays the
// source recording from Drive.
export function addRecordingCard({ driveUrl, durationLabel, notes }) {
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
  if (driveUrl) {
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

/* --------- undo toast --------- */
let toastTimer = null;
export function showUndoToast({ label, onUndo, duration = 4000 } = {}) {
  dismissToast();
  if (!els.undoToast) return;
  els.toastLabel.textContent = label || "Sent what I heard";
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
}
export function closeMemory() {
  els.html.setAttribute("data-view", "chat");
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
    return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" }) + " " + t;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  } catch (_) {
    return "Earlier";
  }
}

let memCache = { hits: [], cb: {} };
let memFilter = "all";

function wireMemoryFilters() {
  if (!els.memFilters) return;
  els.memFilters.querySelectorAll(".m-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      memFilter = btn.getAttribute("data-filter") || "all";
      els.memFilters.querySelectorAll(".m-pill").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      renderMemList();
    });
  });
}

function passesFilter(h) {
  const isTask = h.entry_type === "task";
  const isDone = String(h.status) === "done";
  if (memFilter === "notes") return !isTask;
  if (memFilter === "tasks") return isTask;
  if (memFilter === "done") return isDone;
  return true;
}

export function renderMemory(hits, callbacks = {}) {
  memCache = { hits: Array.isArray(hits) ? hits : [], cb: callbacks };
  renderMemList();
}

function emptyMessage() {
  if (memFilter === "tasks") return "No tasks here — say “remind me to…” and I'll save one.";
  if (memFilter === "done") return "Nothing marked done yet — tap a task's box when it's finished.";
  if (memFilter === "notes") return "No notes here — say “make a note…” and I'll save one.";
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

  const { onToggleDone, onDelete } = memCache.cb;
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
    const item = document.createElement("div");
    item.className = "mi" + (isDone ? " done" : "");

    const row = document.createElement("button");
    row.type = "button";
    row.className = "mi-row";
    row.setAttribute("aria-expanded", "false");
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
    if (when) {
      const m = document.createElement("div");
      m.className = "mi-m";
      m.textContent = "Saved · " + when;
      txt.appendChild(m);
    }
    row.appendChild(txt);
    row.addEventListener("click", () => {
      const open = item.classList.toggle("open");
      row.setAttribute("aria-expanded", open ? "true" : "false");
    });
    item.appendChild(row);

    // expanded action row — recordings are read-only: no edit/delete, just
    // a link to play the audio from Drive.
    const actions = document.createElement("div");
    actions.className = "mi-actions";
    if (h.entry_type === "recording") {
      if (h.page_url) {
        const listen = document.createElement("a");
        listen.className = "pill-btn primary";
        listen.href = h.page_url;
        listen.target = "_blank";
        listen.rel = "noopener noreferrer";
        listen.textContent = "Listen";
        actions.appendChild(listen);
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
