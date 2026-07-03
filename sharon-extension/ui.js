// ui.js — everything Sharon draws: the card stack, the editable "You said"
// transcript, result cards, the Notes and Settings sheets, and the status
// hero. No business logic lives here; the orchestrator registers callbacks.

export const els = {
  html: document.documentElement,
  tabTitle: document.getElementById("tabTitle"),
  statusLine: document.getElementById("statusLine"),
  statusSub: document.getElementById("statusSub"),
  body: document.getElementById("body"),
  caps: document.getElementById("caps"),
  stack: document.getElementById("stack"),
  coach: document.getElementById("coach"),
  orb: document.getElementById("orb"),
  dockMic: document.getElementById("dockMic"),
  voiceBtn: document.getElementById("voiceBtn"),
  notesBtn: document.getElementById("notesBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsSheet: document.getElementById("settingsSheet"),
  notesSheet: document.getElementById("notesSheet"),
  noteSearchInput: document.getElementById("noteSearchInput"),
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
}

/* ------------------------------------------------------------------ *
 * Status hero
 * ------------------------------------------------------------------ */
export function setStatus(state, line, sub) {
  els.html.setAttribute("data-state", state);
  if (els.statusLine) els.statusLine.textContent = line;
  if (els.statusSub) els.statusSub.textContent = sub || "";
}

export function setMicIndicator(live) {
  els.html.setAttribute("data-mic", live ? "live" : "muted");
}

export function setVoiceIndicator(on) {
  els.html.setAttribute("data-voice", on ? "on" : "off");
  if (els.voiceBtn) {
    els.voiceBtn.classList.toggle("on", on);
    els.voiceBtn.setAttribute("aria-label", on ? "Sharon's voice: on" : "Sharon's voice: off");
  }
}

export function setTabTitle(text) {
  if (els.tabTitle) els.tabTitle.textContent = text;
}

export function hideCoach() {
  if (els.coach) els.coach.classList.add("hide");
}

/* ------------------------------------------------------------------ *
 * The card stack
 * ------------------------------------------------------------------ */
function scrollStackToBottom() {
  if (els.body) els.body.scrollTop = els.body.scrollHeight;
}

export function enterStack() {
  hideCoach();
  if (els.caps) els.caps.classList.add("hidden");
  if (els.stack) els.stack.classList.remove("hidden");
}

export function maybeShowCaps() {
  if (els.stack && els.stack.children.length === 0) {
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

export function addSharonReplyCard(text) {
  enterStack();
  const card = makeCard("result-card");
  card.appendChild(cardHead("Sharon"));
  const p = document.createElement("p");
  p.className = "reply";
  p.textContent = text;
  card.appendChild(p);
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

const ICON_CHECK =
  '<path d="M5 12l5 5L20 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_SEARCH =
  '<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m21 21-4.3-4.3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>';
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

export function addSavedCard(noteText, entryType, title) {
  enterStack();
  const card = makeCard("result-card");
  card.appendChild(cardHead("Sharon"));
  card.appendChild(
    chip("", ICON_CHECK, entryType === "task" ? "Saved as a task" : "Saved to your notes")
  );
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
  els.stack.appendChild(card);
  scrollStackToBottom();
  return card;
}

export function addFoundCard(hits) {
  enterStack();
  const card = makeCard("result-card");
  card.appendChild(cardHead("Sharon"));
  card.appendChild(chip("info", ICON_SEARCH, "Checked your notes — " + hits.length + " found"));
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

export function addErrorCard(msg) {
  enterStack();
  const card = makeCard("result-card error-card");
  card.appendChild(cardHead("Sharon"));
  const p = document.createElement("p");
  p.className = "reply";
  p.textContent = "Sharon hit a snag: " + msg;
  card.appendChild(p);
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
  scrollStackToBottom();
}

export function clearComposeInterim() {
  if (!composeEl) return;
  const ghost = composeEl.querySelector(".interim");
  if (ghost) ghost.remove();
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
  composeEl.style.cursor = "default";
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
 * Sheets (Settings / Notes)
 * ------------------------------------------------------------------ */
export function openSheet(sheet) {
  if (sheet) sheet.classList.add("open");
}
export function closeSheets() {
  document.querySelectorAll(".sheet").forEach((s) => s.classList.remove("open"));
}

/* ------------------------------------------------------------------ *
 * Notes list
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

export function renderNotes(hits, { onToggleDone, onDelete } = {}) {
  if (!els.notesList) return;
  els.notesList.innerHTML = "";
  if (!hits.length) {
    const empty = document.createElement("div");
    empty.className = "notes-empty";
    empty.textContent = "No notes yet — say “make a note…” and I'll save one.";
    els.notesList.appendChild(empty);
    return;
  }
  for (const h of hits) {
    const item = document.createElement("div");
    item.className = "note-item" + (String(h.status) === "done" ? " done" : "");
    const title = (h.title || "").trim();
    const content = (h.content || "").trim();
    if (title) {
      const t = document.createElement("div");
      t.className = "ni-title";
      t.textContent = title;
      item.appendChild(t);
    }
    if (content) {
      const b = document.createElement("div");
      b.className = "ni-body";
      b.textContent = content;
      item.appendChild(b);
    }
    const meta = document.createElement("div");
    meta.className = "ni-meta";
    const src = document.createElement("span");
    src.className = "src";
    src.textContent =
      (h.entry_type || "note") + (String(h.status) === "done" ? " · done" : "");
    meta.appendChild(src);
    const when = relativeTime(h.created_at);
    if (when) {
      meta.appendChild(document.createTextNode("·"));
      const t = document.createElement("span");
      t.textContent = when;
      meta.appendChild(t);
    }

    // Inline actions: complete a task / delete an entry, right from the list.
    const actions = document.createElement("span");
    actions.className = "ni-actions";
    if (h.entry_type === "task" && h.entry_id) {
      const doneBtn = document.createElement("button");
      doneBtn.type = "button";
      doneBtn.className = "ni-btn";
      doneBtn.textContent = String(h.status) === "done" ? "Reopen" : "Done";
      doneBtn.addEventListener("click", () => onToggleDone && onToggleDone(h));
      actions.appendChild(doneBtn);
    }
    if (h.entry_id) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "ni-btn danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => onDelete && onDelete(h));
      actions.appendChild(delBtn);
    }
    meta.appendChild(actions);
    item.appendChild(meta);
    els.notesList.appendChild(item);
  }
}
