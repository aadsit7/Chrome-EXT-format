// ui.js — everything Sharon draws: the status chip, the tab pill, the card
// stack, the editable "You said" transcript, result cards, the welcome
// checklist, the Notes screen, and the Settings sheet. No business logic
// lives here; the orchestrator registers callbacks.

export const els = {
  html: document.documentElement,
  tabPill: document.getElementById("tabPill"),
  tabPrefix: document.getElementById("tabPrefix"),
  tabTitle: document.getElementById("tabTitle"),
  statusChip: document.getElementById("statusChip"),
  statusText: document.getElementById("statusText"),
  body: document.getElementById("body"),
  welcome: document.getElementById("welcome"),
  stepMic: document.getElementById("stepMic"),
  stepMemory: document.getElementById("stepMemory"),
  stepHello: document.getElementById("stepHello"),
  caps: document.getElementById("caps"),
  stack: document.getElementById("stack"),
  composer: document.getElementById("composer"),
  composerInput: document.getElementById("composerInput"),
  micBtn: document.getElementById("micBtn"),
  soundBtn: document.getElementById("soundBtn"),
  notesBtn: document.getElementById("notesBtn"),
  notesBadge: document.getElementById("notesBadge"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsSheet: document.getElementById("settingsSheet"),
  notesView: document.getElementById("notesView"),
  notesClose: document.getElementById("notesClose"),
  noteSearchInput: document.getElementById("noteSearchInput"),
  filterRow: document.getElementById("filterRow"),
  notesList: document.getElementById("notesList"),
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

let cb = {
  onCommit: () => {},
  onDiscard: () => {},
};

export function initUI(callbacks) {
  cb = { ...cb, ...callbacks };
  wireNotesFilters();
}

/* ------------------------------------------------------------------ *
 * Status chip + indicators
 * ------------------------------------------------------------------ */
export function setStatus(state, text) {
  els.html.setAttribute("data-state", state);
  if (els.statusText) els.statusText.textContent = text;
}

export function setMicIndicator(live) {
  els.html.setAttribute("data-mic", live ? "live" : "muted");
  if (els.micBtn && !els.composer.classList.contains("has-text")) {
    els.micBtn.setAttribute(
      "aria-label",
      live ? "Microphone is on — tap to mute" : "Microphone is off — tap to talk"
    );
  }
}

export function setVoiceIndicator(on) {
  els.html.setAttribute("data-voice", on ? "on" : "off");
  if (els.soundBtn) {
    els.soundBtn.classList.toggle("on", on);
    els.soundBtn.setAttribute("aria-label", on ? "Sound: on" : "Sound: off");
  }
}

// The always-on tab pill: green eye + "Reading this tab · [title]".
export function setTabContext(reading, title) {
  if (els.tabPill) els.tabPill.classList.toggle("reading", !!reading);
  if (els.tabPrefix)
    els.tabPrefix.textContent = title
      ? reading
        ? "Reading this tab ·"
        : "Can't read this tab ·"
      : "";
  if (els.tabTitle) els.tabTitle.textContent = title || "Open me on a website";
}

// Count badge on the Notes button. The backend returns at most 25 entries.
export function setNotesBadge(count, atLimit) {
  if (!els.notesBadge) return;
  const n = Number(count) || 0;
  if (n > 0) {
    els.notesBadge.textContent = atLimit ? n + "+" : String(n);
    els.notesBadge.classList.remove("hidden");
  } else {
    els.notesBadge.classList.add("hidden");
  }
  if (els.notesBtn)
    els.notesBtn.setAttribute("aria-label", n > 0 ? "Your notes — " + n + (atLimit ? " or more" : "") + " saved" : "Your notes");
}

// The round composer button flips between mic and send while typing.
export function setComposerTyping(hasText) {
  if (!els.composer) return;
  els.composer.classList.toggle("has-text", !!hasText);
  if (els.micBtn) {
    if (hasText) els.micBtn.setAttribute("aria-label", "Send your message");
    else
      els.micBtn.setAttribute(
        "aria-label",
        els.html.getAttribute("data-mic") === "live"
          ? "Microphone is on — tap to mute"
          : "Microphone is off — tap to talk"
      );
  }
}

/* ------------------------------------------------------------------ *
 * Welcome checklist (first open, before setup is done)
 * ------------------------------------------------------------------ */
const WELCOME_STEPS = () => ({ mic: els.stepMic, memory: els.stepMemory, hello: els.stepHello });

export function showWelcome(state) {
  if (!els.welcome) return;
  els.welcome.classList.remove("hidden");
  if (els.caps) els.caps.classList.add("hidden");
  const steps = WELCOME_STEPS();
  for (const key of Object.keys(steps)) {
    if (steps[key]) steps[key].setAttribute("data-done", state && state[key] ? "true" : "false");
  }
}

export function hideWelcome() {
  if (!els.welcome) return;
  els.welcome.classList.add("hidden");
  maybeShowCaps();
}

export function welcomeVisible() {
  return !!(els.welcome && !els.welcome.classList.contains("hidden"));
}

export function setWelcomeStep(step, { done, hint } = {}) {
  const el = WELCOME_STEPS()[step];
  if (!el) return;
  if (done != null) el.setAttribute("data-done", done ? "true" : "false");
  if (hint != null) {
    const h = el.querySelector(".whint");
    if (h) h.textContent = hint;
  }
}

/* ------------------------------------------------------------------ *
 * The card stack
 * ------------------------------------------------------------------ */
function scrollStackToBottom() {
  if (els.body) els.body.scrollTop = els.body.scrollHeight;
}

export function enterStack() {
  if (els.caps) els.caps.classList.add("hidden");
  if (els.stack) els.stack.classList.remove("hidden");
}

export function maybeShowCaps() {
  if (els.stack && els.stack.children.length === 0 && !welcomeVisible()) {
    els.stack.classList.add("hidden");
    if (els.caps) els.caps.classList.remove("hidden");
  }
}

function makeCard(extraClass) {
  const card = document.createElement("div");
  card.className = "card" + (extraClass ? " " + extraClass : "");
  return card;
}

function cardHead(eyebrowLabel) {
  const head = document.createElement("div");
  head.className = "card-head";
  const eyebrow = document.createElement("span");
  eyebrow.className = "card-eyebrow";
  const pin = document.createElement("span");
  pin.className = "pin";
  eyebrow.appendChild(pin);
  eyebrow.appendChild(document.createTextNode(eyebrowLabel));
  head.appendChild(eyebrow);
  return head;
}

// Split a reply into a short opening overview ("lead") and the body.
export function splitLead(text) {
  const t = (text || "").trim();
  if (!t) return { lead: "", body: "" };

  let idx = t.search(/\n\s*\n/);
  if (idx > 0 && idx < 400) {
    const body = t.slice(idx).trim();
    if (body) return { lead: t.slice(0, idx).trim(), body };
  }
  const m = t.match(/^([\s\S]+?[.!?])\s+([\s\S]+)$/);
  if (m && m[1].length <= 300 && m[2].trim()) {
    return { lead: m[1].trim(), body: m[2].trim() };
  }
  idx = t.indexOf("\n");
  if (idx > 0 && idx < 300) {
    const body = t.slice(idx).trim();
    if (body) return { lead: t.slice(0, idx).trim(), body };
  }
  return { lead: t, body: "" };
}

function splitSentences(text) {
  const out = (text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out : [(text || "").trim()].filter(Boolean);
}

export function addGistCard(leadText) {
  enterStack();
  const card = makeCard();
  card.appendChild(cardHead("The gist"));
  const ul = document.createElement("ul");
  ul.className = "summary-list";
  for (const s of splitSentences(leadText).slice(0, 4)) {
    const li = document.createElement("li");
    li.textContent = s;
    ul.appendChild(li);
  }
  card.appendChild(ul);
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

/* --------- Easy-to-view answers: pull "Label: value" facts out of a
 * reply into a result block (one big headline, small rows). Only content
 * that is literally in Sharon's reply is shown — nothing is invented. */
function extractFactBlock(text) {
  const lines = (text || "").split("\n");
  const pairs = [];
  const rest = [];
  for (const ln of lines) {
    const m = ln.trim().match(/^[-•*]?\s*([A-Za-z][^:\n]{1,39}):\s+(.{1,80})$/);
    if (m && !/^https?:/i.test(m[2].trim())) {
      pairs.push({ label: m[1].trim(), value: m[2].trim() });
    } else {
      rest.push(ln);
    }
  }
  if (pairs.length < 2) return null;
  let hi = pairs.findIndex((p) => /\d/.test(p.value) && p.value.length <= 40);
  if (hi < 0) hi = 0;
  const headline = pairs.splice(hi, 1)[0];
  return {
    headline,
    rows: pairs.slice(0, 3),
    rest: rest.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

function buildFactBlock({ headline, rows, footer }) {
  const block = document.createElement("div");
  block.className = "fact-block";
  const v = document.createElement("div");
  v.className = "fb-value";
  v.textContent = headline.value;
  const l = document.createElement("div");
  l.className = "fb-label";
  l.textContent = headline.label;
  block.appendChild(v);
  block.appendChild(l);
  if (rows && rows.length) {
    const wrap = document.createElement("div");
    wrap.className = "fb-rows";
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "fb-row";
      const k = document.createElement("span");
      k.className = "fb-k";
      k.textContent = r.label;
      const val = document.createElement("span");
      val.className = "fb-v";
      val.textContent = r.value;
      row.appendChild(k);
      row.appendChild(val);
      wrap.appendChild(row);
    }
    block.appendChild(wrap);
  }
  if (footer) {
    const f = document.createElement("div");
    f.className = "fb-foot";
    f.textContent = footer;
    block.appendChild(f);
  }
  return block;
}

export function addSharonReplyCard(text) {
  enterStack();
  const card = makeCard("result-card");
  card.appendChild(cardHead("Sharon"));
  const facts = extractFactBlock(text);
  if (facts) {
    card.appendChild(buildFactBlock(facts));
    if (facts.rest) {
      const p = document.createElement("p");
      p.className = "reply";
      p.textContent = facts.rest;
      card.appendChild(p);
    }
  } else {
    const p = document.createElement("p");
    p.className = "reply";
    p.textContent = text;
    card.appendChild(p);
  }
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

// A committed "You said" card for typed or chip-sent messages.
export function addUserCard(text) {
  enterStack();
  const card = makeCard();
  card.appendChild(cardHead("You said"));
  const p = document.createElement("div");
  p.className = "transcript committed";
  p.textContent = text;
  card.appendChild(p);
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

const ICON_CHECK =
  '<path d="M5 12l5 5L20 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_ACT =
  '<path d="m9 11 3 3 8-8" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 12a9 9 0 1 1-6.2-8.5" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>';

function chip(clsExtra, iconSvg, label) {
  const c = document.createElement("div");
  c.className = "action-chip" + (clsExtra ? " " + clsExtra : "");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.innerHTML = iconSvg;
  c.appendChild(svg);
  c.appendChild(document.createTextNode(label));
  return c;
}

// Green "Saved to your Sheet · [category]" confirmation line.
function savedLine(category) {
  const line = document.createElement("div");
  line.className = "saved-line";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.innerHTML = ICON_CHECK;
  line.appendChild(svg);
  line.appendChild(document.createTextNode("Saved to your Sheet"));
  if (category) {
    line.appendChild(document.createTextNode(" · "));
    const cat = document.createElement("span");
    cat.className = "sl-cat";
    cat.textContent = category;
    line.appendChild(cat);
  }
  return line;
}

export function addSavedCard(noteText, entryType, title) {
  enterStack();
  const card = makeCard("result-card");
  card.appendChild(cardHead("Sharon"));
  const prev = document.createElement("div");
  prev.className = "note-preview";
  const label = document.createElement("div");
  label.className = "np-label";
  label.textContent = title || (entryType === "task" ? "Task saved" : "Note saved");
  const body = document.createElement("div");
  body.className = "np-body";
  body.textContent = noteText;
  prev.appendChild(label);
  prev.appendChild(body);
  card.appendChild(prev);
  card.appendChild(savedLine(entryType || ""));
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

export function addFoundCard(hits) {
  enterStack();
  const card = makeCard("result-card");
  card.appendChild(cardHead("Sharon"));
  card.appendChild(
    buildFactBlock({
      headline: {
        value: String(hits.length),
        label: hits.length === 1 ? "matching note in your Sheet" : "matching notes in your Sheet",
      },
      rows: [],
      footer: "From your Google Sheet · " + hits.length + (hits.length === 1 ? " entry" : " entries"),
    })
  );
  for (const h of hits) {
    const row = document.createElement("div");
    row.className = "found-row";
    const dot = document.createElement("span");
    dot.className = "found-dot";
    const main = document.createElement("div");
    main.className = "fr-main";
    const t = document.createElement("div");
    t.className = "fr-t";
    t.textContent = h.title || "(untitled note)";
    main.appendChild(t);
    const snippet = (h.content || "").trim();
    if (snippet) {
      const s = document.createElement("div");
      s.className = "fr-s";
      s.textContent = snippet.length > 110 ? snippet.slice(0, 110) + "…" : snippet;
      main.appendChild(s);
    }
    const d = document.createElement("span");
    d.className = "fr-d";
    d.textContent = relativeTime(h.created_at);
    row.appendChild(dot);
    row.appendChild(main);
    row.appendChild(d);
    card.appendChild(row);
  }
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

export function addUpdatedCard(label) {
  enterStack();
  const card = makeCard("result-card");
  card.appendChild(cardHead("Sharon"));
  card.appendChild(chip("", ICON_CHECK, label || "Updated your notes"));
  card.appendChild(savedLine(""));
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

export function addActionCard(text) {
  enterStack();
  const card = makeCard("result-card");
  card.appendChild(cardHead("Sharon"));
  card.appendChild(chip("page", ICON_ACT, "Done on this page"));
  const p = document.createElement("p");
  p.className = "reply";
  p.textContent = text;
  card.appendChild(p);
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

// Every error says what happened AND what to do next.
export function addErrorCard(msg, nextStep) {
  enterStack();
  const card = makeCard("result-card error-card");
  card.appendChild(cardHead("Sharon"));
  const p = document.createElement("p");
  p.className = "reply";
  p.textContent = "Sharon hit a snag: " + msg;
  card.appendChild(p);
  const next = document.createElement("div");
  next.className = "error-next";
  const b = document.createElement("b");
  b.textContent = "What to do next: ";
  next.appendChild(b);
  next.appendChild(
    document.createTextNode(nextStep || "Wait a moment and try again — say it or type it below.")
  );
  card.appendChild(next);
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

export function showThinkingCard(label) {
  enterStack();
  const card = makeCard("thinking-card");
  const row = document.createElement("div");
  row.className = "think-row";
  row.innerHTML = '<span class="td"></span><span class="td"></span><span class="td"></span>';
  const lbl = document.createElement("span");
  lbl.className = "think-label";
  lbl.textContent = label || "Working on it…";
  row.appendChild(lbl);
  card.appendChild(row);
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

export function removeCard(card) {
  if (card && card.remove) card.remove();
}

/* ------------------------------------------------------------------ *
 * The editable transcript card ("You said")
 * ------------------------------------------------------------------ */
const AUTO_SEND_MS = 1600;

let composeCard = null;
let composeEl = null;
let composeRaw = "";
let composeConf = null;
let composeEdited = false;
let autoSendTimer = null;

export function hasCompose() {
  return !!composeCard;
}

function cancelAutoSend() {
  if (autoSendTimer) {
    clearTimeout(autoSendTimer);
    autoSendTimer = null;
  }
}

function placeCaretEnd(el) {
  try {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  } catch (_) {
    /* ignore */
  }
}

function resetComposeState() {
  cancelAutoSend();
  composeCard = null;
  composeEl = null;
  composeRaw = "";
  composeConf = null;
  composeEdited = false;
}

export function ensureComposeCard() {
  enterStack();
  if (composeCard) return composeCard;
  const card = makeCard();
  card.innerHTML =
    '<div class="card-head">' +
    '<span class="card-eyebrow"><span class="pin"></span>You said</span>' +
    '<button class="edit-btn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>Edit</button>' +
    "</div>" +
    '<div class="transcript" contenteditable="true" role="textbox" aria-label="Your words — tap to edit" data-placeholder="Your words appear here…"></div>' +
    '<div class="edit-hint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>Tap the text to fix anything before sending</div>' +
    '<div class="send-row">' +
    '<button class="btn-send" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z"/></svg>Send to Sharon</button>' +
    '<button class="btn-ghost" type="button" aria-label="Start over">Redo</button>' +
    "</div>";
  els.stack.appendChild(card);
  composeCard = card;
  composeEl = card.querySelector(".transcript");

  card.querySelector(".edit-btn").addEventListener("click", () => {
    composeEdited = true;
    cancelAutoSend();
    composeEl.focus();
    placeCaretEnd(composeEl);
  });
  card.querySelector(".btn-send").addEventListener("click", () => commitCompose());
  card.querySelector(".btn-ghost").addEventListener("click", () => discardCompose());
  composeEl.addEventListener("input", () => {
    composeEdited = true;
    cancelAutoSend();
  });
  composeEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitCompose();
    }
  });
  scrollStackToBottom();
  return card;
}

function typingDots() {
  const t = document.createElement("span");
  t.className = "typing-dots";
  t.setAttribute("aria-hidden", "true");
  t.innerHTML = "<span></span><span></span><span></span>";
  return t;
}

export function showComposeInterim(interimText) {
  ensureComposeCard();
  if (composeEdited) return;
  const committed = composeRaw ? composeRaw + " " : "";
  composeEl.innerHTML = "";
  if (committed) composeEl.appendChild(document.createTextNode(committed));
  const ghost = document.createElement("span");
  ghost.className = "interim";
  ghost.textContent = interimText;
  composeEl.appendChild(ghost);
  composeEl.appendChild(typingDots());
  scrollStackToBottom();
}

export function clearComposeInterim() {
  if (!composeEl) return;
  const ghost = composeEl.querySelector(".interim");
  if (ghost) ghost.remove();
  const dots = composeEl.querySelector(".typing-dots");
  if (dots) dots.remove();
}

export function composeAppend(text, conf) {
  ensureComposeCard();
  composeRaw = composeRaw ? composeRaw + " " + text : text;
  if (conf != null && !Number.isNaN(conf)) composeConf = conf;
  if (!composeEdited) {
    composeEl.textContent = composeRaw;
  } else {
    composeEl.textContent = (composeEl.textContent + " " + text).trim();
  }
  markComposeConfidence(composeConf);
  startAutoSend();
  scrollStackToBottom();
}

function markComposeConfidence(conf) {
  if (!composeCard) return;
  const eyebrow = composeCard.querySelector(".card-head .card-eyebrow");
  if (!eyebrow) return;
  let tag = eyebrow.querySelector(".conf-tag");
  const low = conf != null && !Number.isNaN(conf) && conf < 0.6;
  if (low) {
    if (!tag) {
      tag = document.createElement("span");
      tag.className = "conf-tag";
      const dot = document.createElement("span");
      dot.className = "conf-dot";
      tag.appendChild(dot);
      tag.appendChild(document.createTextNode("Not sure I heard that"));
      eyebrow.appendChild(tag);
    }
  } else if (tag) {
    tag.remove();
  }
}

function startAutoSend() {
  cancelAutoSend();
  if (composeEdited) return;
  autoSendTimer = setTimeout(() => {
    autoSendTimer = null;
    commitCompose();
  }, AUTO_SEND_MS);
}

export function commitCompose() {
  cancelAutoSend();
  if (!composeCard) return;
  const content = (composeEl.textContent || "").trim();
  if (!content) {
    composeEl.focus();
    return;
  }
  const raw = composeRaw || content;
  const conf = composeConf;

  composeEl.setAttribute("contenteditable", "false");
  composeEl.classList.add("committed");
  const editBtn = composeCard.querySelector(".card-head .edit-btn");
  if (editBtn) editBtn.remove();
  const hint = composeCard.querySelector(".edit-hint");
  if (hint) hint.remove();
  const row = composeCard.querySelector(".send-row");
  if (row) row.remove();

  resetComposeState();
  cb.onCommit(content, raw, conf);
}

export function discardCompose() {
  cancelAutoSend();
  if (composeCard) composeCard.remove();
  resetComposeState();
  maybeShowCaps();
  cb.onDiscard();
}

// Quietly drop the empty waiting card (used when a typed message goes out).
export function discardComposeIfEmpty() {
  if (composeCard && !(composeEl.textContent || "").trim()) discardCompose();
}

export function reopenComposeForEdit(text) {
  resetComposeState();
  enterStack();
  ensureComposeCard();
  composeRaw = (text || "").trim();
  composeEl.textContent = composeRaw;
  composeEdited = true;
  composeEl.focus();
  placeCaretEnd(composeEl);
}

/* ------------------------------------------------------------------ *
 * Sheets (Settings) + the Notes screen
 * ------------------------------------------------------------------ */
export function openSheet(sheet) {
  if (sheet) sheet.classList.add("open");
}
export function closeSheets() {
  document.querySelectorAll(".sheet").forEach((s) => s.classList.remove("open"));
}

export function openNotes() {
  els.html.setAttribute("data-view", "notes");
}
export function closeNotes() {
  els.html.setAttribute("data-view", "chat");
}
export function notesOpen() {
  return els.html.getAttribute("data-view") === "notes";
}

/* ------------------------------------------------------------------ *
 * Notes screen — "Everything she remembers"
 * ------------------------------------------------------------------ */
export function relativeTime(iso) {
  if (!iso) return "";
  const then = new Date(iso);
  const ms = then.getTime();
  if (Number.isNaN(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
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

export function notesLoading() {
  if (!els.notesList) return;
  els.notesList.innerHTML = '<div class="notes-loading">Looking through your notes…</div>';
}

export function notesError(message) {
  if (!els.notesList) return;
  els.notesList.innerHTML = "";
  const err = document.createElement("div");
  err.className = "notes-empty";
  err.textContent = message;
  els.notesList.appendChild(err);
}

let notesCache = { hits: [], cb: {} };
let notesFilter = "all";

function wireNotesFilters() {
  if (!els.filterRow) return;
  els.filterRow.querySelectorAll(".f-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      notesFilter = btn.getAttribute("data-filter") || "all";
      els.filterRow.querySelectorAll(".f-pill").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      renderNotesList();
    });
  });
}

function passesFilter(h) {
  const isTask = h.entry_type === "task";
  const isDone = String(h.status) === "done";
  if (notesFilter === "notes") return !isTask;
  if (notesFilter === "tasks") return isTask;
  if (notesFilter === "done") return isDone;
  return true;
}

// Date group for one entry: Today, Earlier this week, then month by month.
function groupLabel(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "Earlier";
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (d >= todayStart) return "Today";
  if (todayStart - d < 7 * 86400000) return "Earlier this week";
  try {
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  } catch (_) {
    return "Earlier";
  }
}

// The category pill shows the entry's first tag, else its type — real Sheet
// data only; nothing is made up.
function categoryOf(h) {
  let tags = h.tags;
  if (typeof tags === "string") {
    try {
      tags = JSON.parse(tags);
    } catch (_) {
      tags = [];
    }
  }
  if (Array.isArray(tags) && tags.length && String(tags[0]).trim()) return String(tags[0]).trim();
  return h.entry_type ? String(h.entry_type).trim() : "";
}

const ICON_PLUS =
  '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>';
const ICON_X =
  '<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';

function svgOf(inner) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.innerHTML = inner;
  return svg;
}

export function renderNotes(hits, callbacks = {}) {
  notesCache = { hits: Array.isArray(hits) ? hits : [], cb: callbacks };
  renderNotesList();
}

function emptyMessage() {
  if (notesFilter === "tasks") return "No tasks here — say “remind me to…” and I'll save one.";
  if (notesFilter === "done") return "Nothing marked done yet — tap a task's box when it's finished.";
  if (notesFilter === "notes") return "No notes here — say “make a note…” and I'll save one.";
  return "Nothing saved yet — say “make a note…” and I'll remember it in your Sheet.";
}

function renderNotesList() {
  if (!els.notesList) return;
  els.notesList.innerHTML = "";
  const shown = notesCache.hits.filter(passesFilter);
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "notes-empty";
    empty.textContent = emptyMessage();
    els.notesList.appendChild(empty);
    return;
  }

  const { onToggleDone, onDelete } = notesCache.cb;
  let lastGroup = null;
  for (const h of shown) {
    const g = groupLabel(h.created_at);
    if (g !== lastGroup) {
      lastGroup = g;
      const head = document.createElement("div");
      head.className = "ng-head";
      head.textContent = g;
      els.notesList.appendChild(head);
    }

    const isTask = h.entry_type === "task";
    const isDone = String(h.status) === "done";
    const item = document.createElement("div");
    item.className = "note-item" + (isDone ? " done" : "");

    // Lead icon: tap-to-check box on tasks, a small plus on everything else.
    const lead = document.createElement("span");
    lead.className = "ni-lead";
    if (isTask && h.entry_id) {
      const check = document.createElement("button");
      check.type = "button";
      check.className = "t-check";
      check.setAttribute("role", "checkbox");
      check.setAttribute("aria-checked", isDone ? "true" : "false");
      check.setAttribute(
        "aria-label",
        isDone ? "Task done — tap to reopen" : "Open task — tap to mark done"
      );
      check.appendChild(svgOf(ICON_CHECK));
      check.addEventListener("click", () => onToggleDone && onToggleDone(h));
      lead.appendChild(check);
    } else {
      const plus = document.createElement("span");
      plus.className = "n-plus";
      plus.setAttribute("aria-hidden", "true");
      plus.appendChild(svgOf(ICON_PLUS));
      lead.appendChild(plus);
    }
    item.appendChild(lead);

    const main = document.createElement("div");
    main.className = "ni-main";
    const title = (h.title || "").trim();
    const content = (h.content || "").trim();
    if (title) {
      const t = document.createElement("div");
      t.className = "ni-title";
      t.textContent = title;
      main.appendChild(t);
    }
    if (content && content !== title) {
      const b = document.createElement("div");
      b.className = "ni-body";
      b.textContent = content;
      main.appendChild(b);
    }

    // Pills: category + time — shown only when that data exists.
    const pills = document.createElement("div");
    pills.className = "ni-pills";
    const cat = categoryOf(h);
    if (cat) {
      const p = document.createElement("span");
      p.className = "ni-pill";
      p.textContent = cat;
      pills.appendChild(p);
    }
    const when = relativeTime(h.created_at);
    if (when) {
      const p = document.createElement("span");
      p.className = "ni-pill time";
      p.textContent = when;
      pills.appendChild(p);
    }
    if (pills.children.length) main.appendChild(pills);
    item.appendChild(main);

    if (h.entry_id) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ni-del";
      del.setAttribute("aria-label", "Delete this from your Sheet");
      del.appendChild(svgOf(ICON_X));
      del.addEventListener("click", () => onDelete && onDelete(h));
      item.appendChild(del);
    }

    els.notesList.appendChild(item);
  }
}
