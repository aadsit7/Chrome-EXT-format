// notes.js — the Notes view: a simple notes app inside the side panel.
//
// The pencil button in the mode bar swaps the conversation for Notes exactly
// the way the book button swaps in the memory view. Two screens live inside
// the one view:
//
//   LIST   — every saved note (entry_type "note" in the Sheet), newest first,
//            via the same search_memory call the memory view uses. Each row
//            shows the title, a human date, and a copy button that puts the
//            FULL note on the clipboard without opening it. Up top: a
//            "+ New note" button (opens a blank editor) and a paste-friendly
//            box that saves whatever is typed or pasted as a new note —
//            first line becomes the title, the rest becomes the body.
//   EDITOR — opens when a row is tapped: editable title + body, a copy
//            button, a Save button (backing out also auto-saves), and a mic
//            that dictates into the body at the cursor through speech.js's
//            dictation mode. While dictating, Sharon's normal conversation
//            listening is sealed off and her voice stays quiet; stopping (or
//            leaving the editor) restores the mic to exactly the state it
//            was in before.
//
// Creating a note needs the backend's "save_memory" action; an older Apps
// Script deployment answers "unknown action", which api.js flags as
// backendOutdated so the error here can say "redeploy Code.gs" instead of
// blaming the connection. Reading and editing notes work against any
// existing deployment.

import * as api from "./api.js";
import * as speech from "./speech.js";
import * as ui from "./ui.js";

const els = {
  html: document.documentElement,
  navBtn: document.getElementById("notesNavBtn"),
  view: document.getElementById("notesView"),
  back: document.getElementById("notesBack"),
  subtitle: document.getElementById("notesSubtitle"),
  newBtn: document.getElementById("noteNewBtn"),
  composeArea: document.getElementById("noteComposeArea"),
  composeRow: document.getElementById("noteComposeRow"),
  composeSave: document.getElementById("noteComposeSave"),
  listErr: document.getElementById("notesErr"),
  list: document.getElementById("notesList"),
  edBack: document.getElementById("noteEdBack"),
  edMeta: document.getElementById("noteEdMeta"),
  edSave: document.getElementById("noteEdSave"),
  edTitle: document.getElementById("noteEdTitle"),
  edBody: document.getElementById("noteEdBody"),
  edMic: document.getElementById("noteEdMic"),
  edHint: document.getElementById("noteEdHint"),
  edErr: document.getElementById("noteEdErr"),
  edCopy: document.getElementById("noteEdCopy"),
};

const TITLE_MAX = 60; // first line → title, kept to a scannable length
const COPIED_FLASH_MS = 1400;

let opts = {
  redeploySteps: "", // the orchestrator's REDEPLOY_STEPS walkthrough
  canDictate: () => true, // false while a voice/screen recording owns the ears
};

let hits = []; // the loaded notes, newest first
let reqSeq = 0; // stale-response guard for loadNotes
let composeBusy = false;
let saving = false;
// The note the editor is holding: entryId is null until a brand-new note's
// first save comes back with its entry_id; savedTitle/savedContent are the
// last persisted values, so "dirty" is a plain comparison.
let editing = null;
let dictating = false;
let dictWatch = null; // polls speech.dictationActive() so the mic button can't lie

export function initNotes(options) {
  opts = { ...opts, ...(options || {}) };
  wire();
  // Anything that swaps the view away from Notes — the memory button, the
  // welcome replay — must stop dictation and keep an edited note from being
  // lost, even though none of those code paths know Notes exists.
  new MutationObserver(onViewChanged).observe(els.html, {
    attributes: true,
    attributeFilter: ["data-view"],
  });
}

/* ------------------------------------------------------------------ *
 * View toggling — mirrors ui.openMemory / ui.closeMemory
 * ------------------------------------------------------------------ */
function notesOpen() {
  return els.html.getAttribute("data-view") === "notes";
}
function editorOpen() {
  return els.view && els.view.getAttribute("data-screen") === "editor";
}

function openNotes() {
  // Never leave the memory view half-open underneath (selection state, the
  // lit book button) — close it properly first.
  if (ui.memoryOpen()) ui.closeMemory();
  showList();
  els.html.setAttribute("data-view", "notes");
  loadNotes();
}

function closeNotes() {
  stopDictationUI();
  // Auto-save on the way out (same contract as the editor's back button);
  // fire-and-forget — the row updates next time the list loads.
  if (editorOpen() && editorDirty()) saveEditor({ quiet: true });
  els.html.setAttribute("data-view", "chat");
}

function onViewChanged() {
  const open = notesOpen();
  if (els.navBtn) els.navBtn.setAttribute("aria-pressed", open ? "true" : "false");
  if (open) return;
  // The view left Notes through a path that isn't ours (memory button,
  // welcome replay): same cleanup as closeNotes.
  stopDictationUI();
  if (editorOpen() && editorDirty()) saveEditor({ quiet: true });
}

function showList() {
  if (els.view) els.view.setAttribute("data-screen", "list");
}

/* ------------------------------------------------------------------ *
 * The list — all notes, newest first, via the existing search_memory
 * ------------------------------------------------------------------ */
async function loadNotes() {
  const seq = ++reqSeq;
  hideErr(els.listErr);
  if (els.list) els.list.innerHTML = '<div class="mem-loading">Looking through your Sheet…</div>';
  try {
    const found = await api.searchMemory({ query: "", entryType: "note", limit: 25, touch: false });
    if (seq !== reqSeq) return;
    hits = Array.isArray(found) ? found : [];
    renderList();
  } catch (err) {
    if (seq !== reqSeq) return;
    if (els.list) els.list.innerHTML = "";
    showErr(els.listErr, problemText(err, "I couldn't load your notes."));
  }
}

function setSubtitle() {
  if (!els.subtitle) return;
  const n = hits.length;
  els.subtitle.textContent =
    (n >= 25 ? "25+" : String(n)) +
    (n === 1 ? " note" : " notes") +
    " · your “Speaking Assistant” Sheet";
}

function renderList() {
  setSubtitle();
  if (!els.list) return;
  els.list.innerHTML = "";
  if (!hits.length) {
    const empty = document.createElement("div");
    empty.className = "mem-empty";
    empty.textContent = "No notes yet — tap “+ New note”, or paste something above and save it.";
    els.list.appendChild(empty);
    return;
  }
  const card = document.createElement("div");
  card.className = "mg-card";
  for (const h of hits) card.appendChild(noteRow(h));
  els.list.appendChild(card);
}

function noteRow(h) {
  const row = document.createElement("div");
  row.className = "nrow";

  const main = document.createElement("button");
  main.type = "button";
  main.className = "nrow-main";
  main.setAttribute("aria-label", "Open the note “" + (h.title || "untitled") + "”");
  const t = document.createElement("div");
  t.className = "nrow-t";
  t.textContent = h.title || h.content || "(untitled note)";
  main.appendChild(t);
  const when = ui.metaTime(h.created_at);
  if (when) {
    const m = document.createElement("div");
    m.className = "nrow-m";
    m.textContent = when;
    main.appendChild(m);
  }
  main.addEventListener("click", () => openEditor(h));
  row.appendChild(main);

  // Copy is its own button so copying never opens the note.
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "nrow-copy";
  copy.setAttribute("aria-label", "Copy this note");
  copy.appendChild(svgOf(I_COPY, "i-copy"));
  copy.appendChild(svgOf(I_CHECK, "i-check"));
  copy.addEventListener("click", (ev) => {
    ev.stopPropagation();
    copyToClipboard(fullNoteText(h), () => flashCopied(copy));
  });
  row.appendChild(copy);
  return row;
}

/* ------------------------------------------------------------------ *
 * The paste-friendly quick composer — first line becomes the title
 * ------------------------------------------------------------------ */
function syncComposeRow() {
  if (els.composeRow)
    els.composeRow.classList.toggle("hidden", !(els.composeArea && els.composeArea.value.trim()));
}

// Title = first line (trimmed, max TITLE_MAX chars); body = the rest, or the
// whole text when it's a single line. If the first line was longer than the
// title cap, the body keeps the WHOLE text so nothing is ever cut off.
function splitNoteText(text) {
  const t = String(text || "").replace(/\r\n?/g, "\n").trim();
  const nl = t.indexOf("\n");
  if (nl < 0) return { title: t.slice(0, TITLE_MAX).trim(), content: t };
  const first = t.slice(0, nl).trim();
  return {
    title: first.slice(0, TITLE_MAX).trim(),
    content: first.length > TITLE_MAX ? t : t.slice(nl + 1).trim(),
  };
}

async function saveCompose() {
  if (composeBusy || !els.composeArea) return;
  const text = els.composeArea.value.trim();
  if (!text) return;
  const { title, content } = splitNoteText(text);
  composeBusy = true;
  hideErr(els.listErr);
  if (els.composeSave) {
    els.composeSave.disabled = true;
    els.composeSave.textContent = "Saving…";
  }
  try {
    const created = await api.saveMemory({ title, content });
    els.composeArea.value = "";
    syncComposeRow();
    if (created && created.entry_id) {
      hits.unshift(created);
      renderList();
    } else {
      loadNotes();
    }
  } catch (err) {
    showErr(els.listErr, problemText(err, "I couldn't save that note."));
  } finally {
    composeBusy = false;
    if (els.composeSave) {
      els.composeSave.disabled = false;
      els.composeSave.textContent = "Save note";
    }
  }
}

/* ------------------------------------------------------------------ *
 * The editor — title + body, copy, dictation, save (and save-on-back)
 * ------------------------------------------------------------------ */
function openEditor(h) {
  editing = {
    entryId: h ? h.entry_id : null,
    hit: h || null,
    savedTitle: h ? String(h.title || "") : "",
    savedContent: h ? String(h.content || "") : "",
  };
  if (els.edTitle) els.edTitle.value = editing.savedTitle;
  if (els.edBody) els.edBody.value = editing.savedContent;
  if (els.edMeta)
    els.edMeta.textContent =
      h && h.created_at ? "Saved · " + ui.metaTime(h.created_at) : "New note";
  hideErr(els.edErr);
  resetSaveBtn();
  if (els.view) els.view.setAttribute("data-screen", "editor");
  const focusEl = editing.savedTitle ? els.edBody : els.edTitle;
  if (focusEl) focusEl.focus();
}

function editorDirty() {
  if (!editing) return false;
  const title = els.edTitle ? els.edTitle.value.trim() : "";
  const content = els.edBody ? els.edBody.value.trim() : "";
  if (!editing.entryId) return !!(title || content); // a new note with anything in it
  return title !== editing.savedTitle.trim() || content !== editing.savedContent.trim();
}

function resetSaveBtn() {
  if (els.edSave) {
    els.edSave.disabled = false;
    els.edSave.textContent = "Save";
  }
}

async function saveEditor({ quiet = false } = {}) {
  if (!editing || saving) return false;
  let title = els.edTitle ? els.edTitle.value.trim() : "";
  const content = els.edBody ? els.edBody.value.trim() : "";
  if (!title && !content) return true; // an empty new note saves nothing
  if (!title) title = splitNoteText(content).title;
  saving = true;
  if (!quiet && els.edSave) {
    els.edSave.disabled = true;
    els.edSave.textContent = "Saving…";
  }
  try {
    if (!editing.entryId) {
      const created = await api.saveMemory({ title, content });
      const hit =
        created && created.entry_id ? created : { entry_id: null, title, content };
      editing.entryId = hit.entry_id;
      editing.hit = hit;
      hits.unshift(hit);
      if (els.edMeta) els.edMeta.textContent = "Saved · just now";
    } else {
      await api.updateMemory({ entryId: editing.entryId, title, content });
      if (editing.hit) {
        editing.hit.title = title;
        editing.hit.content = content;
      }
    }
    editing.savedTitle = title;
    editing.savedContent = content;
    hideErr(els.edErr);
    if (!quiet && els.edSave) {
      els.edSave.disabled = false;
      els.edSave.textContent = "Saved";
      setTimeout(resetSaveBtn, COPIED_FLASH_MS);
    }
    return true;
  } catch (err) {
    showErr(els.edErr, problemText(err, "I couldn't save this note."));
    if (els.edSave) {
      els.edSave.disabled = false;
      els.edSave.textContent = "Save";
    }
    return false;
  } finally {
    saving = false;
  }
}

async function backFromEditor() {
  stopDictationUI();
  if (editorDirty()) {
    const ok = await saveEditor({ quiet: true });
    if (!ok) return; // the error is showing — don't silently drop the edits
  }
  editing = null;
  showList();
  renderList(); // reflect any title/content change in the row
}

/* ------------------------------------------------------------------ *
 * Dictation — speech.js's dictation mode types into the body at the cursor
 * ------------------------------------------------------------------ */
function setDictatingUI(on) {
  dictating = on;
  if (els.edMic) {
    els.edMic.setAttribute("aria-pressed", on ? "true" : "false");
    els.edMic.setAttribute("aria-label", on ? "Stop dictating" : "Dictate into this note");
  }
  if (els.edHint) els.edHint.classList.toggle("hidden", !on);
  if (on && !dictWatch) {
    // If anything else claims the ears (the recorder always wins in
    // speech.js), the mic button must not keep glowing.
    dictWatch = setInterval(() => {
      if (!speech.dictationActive()) setDictatingUI(false);
    }, 500);
  } else if (!on && dictWatch) {
    clearInterval(dictWatch);
    dictWatch = null;
  }
}

function stopDictationUI() {
  if (!dictating) return;
  speech.stopDictation();
  setDictatingUI(false);
}

function toggleDictation() {
  if (dictating) {
    stopDictationUI();
    return;
  }
  if (!speech.speechRecognitionAvailable()) {
    showErr(els.edErr, "Voice input isn't available in this browser — type or paste instead.");
    return;
  }
  if (!opts.canDictate()) {
    showErr(els.edErr, "I'm recording right now — stop the recording first, then dictate.");
    return;
  }
  if (!speech.startDictation(insertDictated)) {
    showErr(els.edErr, "I couldn't start dictating just now — try again in a moment.");
    return;
  }
  hideErr(els.edErr);
  setDictatingUI(true);
}

// Recognized speech lands at the CURSOR, not the end — so you can click into
// the middle of a note and speak the missing sentence.
function insertDictated(text) {
  const ta = els.edBody;
  if (!ta || !text) return;
  const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
  const end = ta.selectionEnd != null ? ta.selectionEnd : start;
  const before = ta.value.slice(0, start);
  const insert = (before && !/\s$/.test(before) ? " " : "") + text;
  ta.value = before + insert + ta.value.slice(end);
  const at = start + insert.length;
  try {
    ta.setSelectionRange(at, at);
  } catch (_) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * Copy — full note content to the clipboard, with "Copied" feedback
 * ------------------------------------------------------------------ */
// The full note is the title line plus the body (the two halves of the
// original text) — unless the body already carries the whole thing.
function fullNoteText(h) {
  const title = String((h && h.title) || "").trim();
  const content = String((h && h.content) || "").trim();
  if (title && content && content !== title && content.indexOf(title) !== 0)
    return title + "\n" + content;
  return content || title;
}

function copyToClipboard(text, onDone) {
  if (!text) return;
  navigator.clipboard
    .writeText(text)
    .then(() => onDone && onDone())
    .catch(() => {
      /* a user-gesture copy in the panel shouldn't fail; nothing to add */
    });
}

function flashCopied(btn) {
  btn.setAttribute("data-copied", "true");
  setTimeout(() => btn.removeAttribute("data-copied"), COPIED_FLASH_MS);
}

/* ------------------------------------------------------------------ *
 * Errors — say what happened and what to do next, right in the view
 * ------------------------------------------------------------------ */
function problemText(err, lead) {
  const detail = err && err.message ? String(err.message) : "";
  if (err && err.backendOutdated)
    return lead + " " + detail + " What to do next: " + (opts.redeploySteps || "redeploy backend/Code.gs.");
  return lead + (detail ? " " + detail : "") + " Check your connection and try again.";
}

function showErr(el, text) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden");
}
function hideErr(el) {
  if (el) el.classList.add("hidden");
}

/* ------------------------------------------------------------------ *
 * SVG helpers (same Lucide conventions as ui.js)
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
const I_COPY =
  '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>';
const I_CHECK = '<path d="M20 6 9 17l-5-5"/>';

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function wire() {
  if (els.navBtn)
    els.navBtn.addEventListener("click", () => (notesOpen() ? closeNotes() : openNotes()));
  if (els.back) els.back.addEventListener("click", closeNotes);
  if (els.newBtn) els.newBtn.addEventListener("click", () => openEditor(null));
  if (els.composeArea) els.composeArea.addEventListener("input", syncComposeRow);
  if (els.composeSave) els.composeSave.addEventListener("click", saveCompose);
  if (els.edBack) els.edBack.addEventListener("click", backFromEditor);
  if (els.edSave) els.edSave.addEventListener("click", () => saveEditor());
  if (els.edMic) els.edMic.addEventListener("click", toggleDictation);
  if (els.edCopy)
    els.edCopy.addEventListener("click", () => {
      const text = fullNoteText({
        title: els.edTitle ? els.edTitle.value : "",
        content: els.edBody ? els.edBody.value : "",
      });
      copyToClipboard(text, () => {
        if (!els.edCopy) return;
        els.edCopy.setAttribute("data-copied", "true");
        els.edCopy.textContent = "Copied";
        setTimeout(() => {
          els.edCopy.removeAttribute("data-copied");
          els.edCopy.textContent = "Copy";
        }, COPIED_FLASH_MS);
      });
    });
}
