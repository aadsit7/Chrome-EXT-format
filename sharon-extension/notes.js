// notes.js — the Notes view: a simple notes app inside the side panel.
//
// The pencil button in the mode bar swaps the conversation for Notes exactly
// the way the book button swaps in the memory view — and Notes is also the
// view the panel opens on (the boot sequence calls openNotesView(), keeping
// the mic MUTED until the user switches to the conversation — reading notes
// is not talking to Sharon). Two screens live inside the one view:
//
//   LIST   — every saved note (entry_type "note" in the Sheet, up to 500),
//            newest first, via the same search_memory call the memory view
//            uses, grouped into COLLAPSIBLE SECTIONS. A note's section is the
//            "project" column of its memory_log row; notes without one land
//            in "Unsorted", always last. Tapping a section header folds it
//            open or closed (remembered in chrome.storage.local); "+ New
//            section" creates a named section, which is stored locally until
//            a note is saved into it (only then does it reach the Sheet).
//            Each row shows the title, a human date, and a copy button that
//            puts the FULL note on the clipboard without opening it. Up top:
//            a "+ New note" button (opens a blank editor) and a
//            paste-friendly box that saves whatever is typed or pasted as a
//            new note — first line becomes the title, the rest becomes the
//            body — with an always-visible dictation mic and a section
//            picker, so a spoken or pasted note saves straight into place.
//   EDITOR — opens when a row is tapped: editable title + body, a copy
//            button, a section picker (moving a note between sections saves
//            like any other edit), a Save button (backing out also
//            auto-saves), and a mic that dictates into the body at the
//            cursor through speech.js's dictation mode.
//
// BOTH mics run through the same dictation plumbing, but speech.js holds
// exactly ONE dictation callback — so starting one mic always shuts the
// other off first, and a single module-level variable tracks which target
// ("compose" or "editor") owns dictation. While dictating, Sharon's normal
// conversation listening is sealed off and her voice stays quiet; stopping
// (or leaving the screen) restores the mic to exactly the state it was in.
//
// Creating a note needs the backend's "save_memory" action; an older Apps
// Script deployment answers "unknown action", which api.js flags as
// backendOutdated so the error here can say "redeploy Code.gs" instead of
// blaming the connection. Sections need a deployment new enough to return
// the "project" column — when notes load without it, a dismissible notice
// above the list says sections won't save until Code.gs is redeployed, and
// everything else keeps working. Reading and editing notes work against any
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
  newSectionBtn: document.getElementById("noteNewSectionBtn"),
  composeArea: document.getElementById("noteComposeArea"),
  composeRow: document.getElementById("noteComposeRow"),
  composeSave: document.getElementById("noteComposeSave"),
  composeMic: document.getElementById("noteComposeMic"),
  composeHint: document.getElementById("noteComposeHint"),
  composeSection: document.getElementById("noteComposeSection"),
  stale: document.getElementById("notesStale"),
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
  edSection: document.getElementById("noteEdSection"),
};

const TITLE_MAX = 60; // first line → title, kept to a scannable length
const COPIED_FLASH_MS = 1400;
const NOTES_LIMIT = 500; // how many notes the list loads (the backend's cap)
const UNSORTED = "Unsorted"; // the built-in group for notes with no section

// Sections live in chrome.storage.local (the same pattern sidepanel.js uses
// for settings): the names the user created — kept even while empty, since
// a section only reaches the Sheet once a note is saved into it — and which
// sections are folded open or closed (missing = open).
const SECTIONS_KEY = "sharon_note_sections";
const SECTIONS_OPEN_KEY = "sharon_note_sections_open";

let opts = {
  redeploySteps: "", // the orchestrator's REDEPLOY_STEPS walkthrough
  canDictate: () => true, // false while a voice/screen recording owns the ears
};

let hits = []; // the loaded notes, newest first
let reqSeq = 0; // stale-response guard for loadNotes
let composeBusy = false;
let saving = false;
// The note the editor is holding: entryId is null until a brand-new note's
// first save comes back with its entry_id; savedTitle/savedContent/
// savedProject are the last persisted values, so "dirty" is a plain
// comparison (moving a note between sections alone counts).
let editing = null;
// Which target owns dictation — "compose" (the list's quick-note box),
// "editor" (the note body), or null. speech.js holds exactly ONE dictation
// callback, so only one target may ever be live (see toggleDictation).
let dictating = null;
let dictWatch = null; // polls speech.dictationActive() so the mic button can't lie
let userSections = []; // section names the user created (persisted locally)
let openSections = {}; // section name → open?; missing names default to open
let sectionStateLoaded = null; // resolves once chrome.storage delivered both
let staleDismissed = false; // the redeploy notice stays away once dismissed

export function initNotes(options) {
  opts = { ...opts, ...(options || {}) };
  sectionStateLoaded = loadSectionState();
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

// The boot sequence opens Notes as the panel's home view (unless the
// first-run welcome is showing) — same path as tapping the pencil.
export function openNotesView() {
  openNotes();
}

// The orchestrator calls this when the user actually addresses Sharon while
// Notes is on screen: the notes view hides the thread, the presence card and
// the composer, so the conversation must come back before her reply renders.
// Runs the normal closeNotes path (dictation stops, an open edited note
// auto-saves). A no-op unless Notes is open.
export function closeNotesView() {
  if (notesOpen()) closeNotes();
}

// Lets the orchestrator ask whether Notes is on screen — the boot sequence
// keeps the mic muted while it is (reading notes is not talking to Sharon).
export function notesViewOpen() {
  return notesOpen();
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
    if (sectionStateLoaded) await sectionStateLoaded; // sections before first paint
    const found = await api.searchMemory({ query: "", entryType: "note", limit: NOTES_LIMIT, touch: false });
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
    (n >= NOTES_LIMIT ? NOTES_LIMIT + "+" : String(n)) +
    (n === 1 ? " note" : " notes") +
    " · your “Speaking Assistant” Sheet";
}

/* ------------------------------------------------------------------ *
 * Sections — named groups over the "project" column, folded open/closed
 * ------------------------------------------------------------------ */
async function loadSectionState() {
  try {
    const stored = await chrome.storage.local.get([SECTIONS_KEY, SECTIONS_OPEN_KEY]);
    if (Array.isArray(stored[SECTIONS_KEY]))
      userSections = stored[SECTIONS_KEY].map((s) => String(s || "").trim()).filter(Boolean);
    if (stored[SECTIONS_OPEN_KEY] && typeof stored[SECTIONS_OPEN_KEY] === "object")
      openSections = stored[SECTIONS_OPEN_KEY];
  } catch (_) {
    /* defaults are fine — everything just starts open */
  }
}

function saveUserSections() {
  try {
    chrome.storage.local.set({ [SECTIONS_KEY]: userSections });
  } catch (_) {
    /* ignore */
  }
}

function saveOpenSections() {
  try {
    chrome.storage.local.set({ [SECTIONS_OPEN_KEY]: openSections });
  } catch (_) {
    /* ignore */
  }
}

// The distinct non-empty project values across the loaded notes, PLUS the
// user-created sections that are still empty — alphabetical, case-insensitive
// (first spelling seen wins the display form). "Unsorted" is not in here; it
// is the fallback group, always rendered last.
function sectionNames() {
  const seen = new Map(); // lower-cased name → display name
  for (const name of userSections) {
    const t = String(name || "").trim();
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  for (const h of hits) {
    const t = String((h && h.project) || "").trim();
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

function isSectionOpen(name) {
  const v = openSections[name];
  return v == null ? true : !!v; // no saved state = open
}

// "+ New section": name it, keep it locally, show it expanded and empty.
// Nothing touches the Sheet — a section first reaches the Sheet when a note
// is saved into it. Empty and duplicate names (and "Unsorted", which always
// exists) are quietly ignored.
function createSection() {
  const raw = window.prompt("Name the new section:", "");
  if (raw == null) return;
  const name = String(raw).trim();
  if (!name) return;
  const lower = name.toLowerCase();
  if (lower === UNSORTED.toLowerCase()) return;
  if (sectionNames().some((s) => s.toLowerCase() === lower)) return;
  userSections.push(name);
  saveUserSections();
  openSections[name] = true;
  saveOpenSections();
  renderList();
}

// Both pickers (the quick composer's and the editor's) carry the same list:
// "Unsorted" (value "" = no project) first, then every section by name.
function populateSectionPickers() {
  const names = sectionNames();
  fillPicker(els.composeSection, names);
  fillPicker(els.edSection, names);
}

function fillPicker(sel, names) {
  if (!sel) return;
  const prev = sel.value; // keep the user's choice across re-renders
  sel.innerHTML = "";
  const un = document.createElement("option");
  un.value = "";
  un.textContent = UNSORTED;
  sel.appendChild(un);
  for (const n of names) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n;
    sel.appendChild(o);
  }
  if (prev && names.indexOf(prev) >= 0) sel.value = prev;
}

// Point a picker at a section by name, tolerating case differences against
// the canonical display spelling; anything unknown lands on "Unsorted".
function setPickerValue(sel, name) {
  if (!sel) return;
  const want = String(name || "").trim().toLowerCase();
  let value = "";
  for (const o of sel.options) {
    if (o.value && o.value.toLowerCase() === want) {
      value = o.value;
      break;
    }
  }
  sel.value = value;
}

// STALE BACKEND: notes loaded fine but not one entry carries a "project"
// property — the deployed Apps Script predates sections. Say so once,
// dismissibly, in the existing error styling; the list itself keeps working.
function renderStaleNotice() {
  if (!els.stale) return;
  const stale =
    hits.length > 0 &&
    !hits.some((h) => h && typeof h === "object" && "project" in h);
  if (!stale || staleDismissed) {
    els.stale.classList.add("hidden");
    return;
  }
  els.stale.innerHTML = "";
  const msg = document.createElement("span");
  msg.textContent =
    "Sections won't save yet — the deployed Apps Script is an older version that doesn't " +
    "know the “project” column. Notes still work; to get sections saving: " +
    (opts.redeploySteps || "redeploy backend/Code.gs.");
  els.stale.appendChild(msg);
  const x = document.createElement("button");
  x.type = "button";
  x.className = "nerr-x";
  x.setAttribute("aria-label", "Dismiss this notice");
  x.appendChild(svgOf(I_X, ""));
  x.addEventListener("click", () => {
    staleDismissed = true;
    els.stale.classList.add("hidden");
  });
  els.stale.appendChild(x);
  els.stale.classList.remove("hidden");
}

function renderList() {
  setSubtitle();
  populateSectionPickers();
  renderStaleNotice();
  if (!els.list) return;
  els.list.innerHTML = "";
  const names = sectionNames();
  if (!hits.length && !names.length) {
    const empty = document.createElement("div");
    empty.className = "mem-empty";
    empty.textContent = "No notes yet — tap “+ New note”, or paste something above and save it.";
    els.list.appendChild(empty);
    return;
  }
  // One collapsible group per section (already sorted), then Unsorted last.
  const byLower = new Map();
  const groups = new Map(); // display name → its notes, newest first
  for (const name of names) {
    groups.set(name, []);
    byLower.set(name.toLowerCase(), name);
  }
  const unsorted = [];
  for (const h of hits) {
    const t = String((h && h.project) || "").trim();
    const key = t ? byLower.get(t.toLowerCase()) : null;
    if (key) groups.get(key).push(h);
    else unsorted.push(h);
  }
  for (const [name, rows] of groups) els.list.appendChild(sectionGroup(name, rows));
  if (unsorted.length) els.list.appendChild(sectionGroup(UNSORTED, unsorted));
}

// One section: a tappable .mg-head header (title, count, rotating chevron —
// aria-expanded carries the state, no <details>) over a .mg-card of the
// section's rows, built with the same noteRow() as always.
function sectionGroup(name, rows) {
  const wrap = document.createElement("div");
  wrap.className = "nsec";
  const open = isSectionOpen(name);

  const head = document.createElement("button");
  head.type = "button";
  head.className = "mg-head nsec-head";
  head.setAttribute("aria-expanded", open ? "true" : "false");
  head.setAttribute(
    "aria-label",
    "Section “" + name + "” — " + rows.length + (rows.length === 1 ? " note" : " notes")
  );
  const label = document.createElement("span");
  label.className = "nsec-t";
  label.textContent = name;
  head.appendChild(label);
  const count = document.createElement("span");
  count.className = "nsec-n";
  count.textContent = rows.length === 1 ? "1 note" : rows.length + " notes";
  head.appendChild(count);
  head.appendChild(svgOf(I_CHEVRON, "nsec-chev"));
  wrap.appendChild(head);

  const card = document.createElement("div");
  card.className = "mg-card";
  card.classList.toggle("hidden", !open);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "nsec-empty";
    empty.textContent = "Nothing in this section yet — pick it when you save a note.";
    card.appendChild(empty);
  } else {
    for (const h of rows) card.appendChild(noteRow(h));
  }
  wrap.appendChild(card);

  head.addEventListener("click", () => {
    const nowOpen = head.getAttribute("aria-expanded") !== "true";
    head.setAttribute("aria-expanded", nowOpen ? "true" : "false");
    card.classList.toggle("hidden", !nowOpen);
    openSections[name] = nowOpen;
    saveOpenSections();
  });
  return wrap;
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
  const project = els.composeSection ? els.composeSection.value : ""; // "" = Unsorted
  composeBusy = true;
  hideErr(els.listErr);
  if (els.composeSave) {
    els.composeSave.disabled = true;
    els.composeSave.textContent = "Saving…";
  }
  try {
    const created = await api.saveMemory({ title, content, project });
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
  // The list's quick-note mic must not keep listening under the editor —
  // and speech.js only holds one dictation callback anyway.
  stopDictationUI("compose");
  editing = {
    entryId: h ? h.entry_id : null,
    hit: h || null,
    savedTitle: h ? String(h.title || "") : "",
    savedContent: h ? String(h.content || "") : "",
    savedProject: h ? String(h.project || "").trim() : "",
  };
  if (els.edTitle) els.edTitle.value = editing.savedTitle;
  if (els.edBody) els.edBody.value = editing.savedContent;
  populateSectionPickers(); // fresh options before pointing the picker
  if (els.edSection) setPickerValue(els.edSection, editing.savedProject);
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
  const project = els.edSection ? els.edSection.value : editing.savedProject;
  return (
    title !== editing.savedTitle.trim() ||
    content !== editing.savedContent.trim() ||
    project !== editing.savedProject // moving sections alone is a real edit
  );
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
  const project = els.edSection ? els.edSection.value : editing.savedProject;
  saving = true;
  if (!quiet && els.edSave) {
    els.edSave.disabled = true;
    els.edSave.textContent = "Saving…";
  }
  try {
    if (!editing.entryId) {
      const created = await api.saveMemory({ title, content, project });
      const hit =
        created && created.entry_id ? created : { entry_id: null, title, content, project };
      editing.entryId = hit.entry_id;
      editing.hit = hit;
      hits.unshift(hit);
      if (els.edMeta) els.edMeta.textContent = "Saved · just now";
    } else {
      await api.updateMemory({ entryId: editing.entryId, title, content, project });
      if (editing.hit) {
        editing.hit.title = title;
        editing.hit.content = content;
        editing.hit.project = project;
      }
    }
    editing.savedTitle = title;
    editing.savedContent = content;
    editing.savedProject = project;
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
 * Dictation — speech.js's dictation mode, typing into whichever target
 * owns it: "compose" (the list's quick-note box) or "editor" (the note
 * body). One target at a time, tracked in the module-level `dictating`.
 * ------------------------------------------------------------------ */
function dictMic(target) {
  return target === "compose" ? els.composeMic : els.edMic;
}
function dictHint(target) {
  return target === "compose" ? els.composeHint : els.edHint;
}
function dictErr(target) {
  return target === "compose" ? els.listErr : els.edErr;
}
function dictArea(target) {
  return target === "compose" ? els.composeArea : els.edBody;
}
function dictIdleLabel(target) {
  return target === "compose" ? "Dictate a new note" : "Dictate into this note";
}

function setDictatingUI(target, on) {
  if (on) dictating = target;
  else if (dictating === target) dictating = null;
  const mic = dictMic(target);
  if (mic) {
    mic.setAttribute("aria-pressed", on ? "true" : "false");
    mic.setAttribute("aria-label", on ? "Stop dictating" : dictIdleLabel(target));
  }
  const hint = dictHint(target);
  if (hint) hint.classList.toggle("hidden", !on);
  if (on && !dictWatch) {
    // If anything else claims the ears (the recorder always wins in
    // speech.js), the owning mic button must not keep glowing.
    dictWatch = setInterval(() => {
      if (dictating && !speech.dictationActive()) setDictatingUI(dictating, false);
    }, 500);
  } else if (!dictating && dictWatch) {
    clearInterval(dictWatch);
    dictWatch = null;
  }
}

// Stop dictation if `target` owns it; with no target, stop whichever mic is
// live. Safe to call when nothing is dictating.
function stopDictationUI(target) {
  const owner = target || dictating;
  if (!owner || dictating !== owner) return;
  speech.stopDictation();
  setDictatingUI(owner, false);
}

function toggleDictation(target) {
  if (dictating === target) {
    stopDictationUI(target);
    return;
  }
  // speech.js holds exactly ONE dictation callback — calling startDictation
  // while dictation runs silently SWAPS it and returns true, leaving the
  // first button glowing over a dead wire. Turn the other target fully off
  // first: only one mic may ever show as active.
  if (dictating) stopDictationUI(dictating);
  const err = dictErr(target);
  if (!speech.speechRecognitionAvailable()) {
    showErr(err, "Voice input isn't available in this browser — type or paste instead.");
    return;
  }
  if (!opts.canDictate()) {
    showErr(err, "I'm recording right now — stop the recording first, then dictate.");
    return;
  }
  if (!speech.startDictation((text) => insertDictated(target, text))) {
    showErr(err, "I couldn't start dictating just now — try again in a moment.");
    return;
  }
  hideErr(err);
  setDictatingUI(target, true);
}

// Recognized speech lands at the CURSOR, not the end — so you can click into
// the middle of a note and speak the missing sentence.
function insertDictated(target, text) {
  const ta = dictArea(target);
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
  // Dictated words are input like any typing: reveal the "Save note" button.
  if (target === "compose") syncComposeRow();
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
const I_CHEVRON = '<path d="m9 18 6-6-6-6"/>'; // points right; CSS rotates it open
const I_X = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>';

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function wire() {
  if (els.navBtn)
    els.navBtn.addEventListener("click", () => (notesOpen() ? closeNotes() : openNotes()));
  if (els.back) els.back.addEventListener("click", closeNotes);
  if (els.newBtn) els.newBtn.addEventListener("click", () => openEditor(null));
  if (els.newSectionBtn) els.newSectionBtn.addEventListener("click", createSection);
  if (els.composeArea) els.composeArea.addEventListener("input", syncComposeRow);
  if (els.composeSave) els.composeSave.addEventListener("click", saveCompose);
  if (els.composeMic) els.composeMic.addEventListener("click", () => toggleDictation("compose"));
  if (els.edBack) els.edBack.addEventListener("click", backFromEditor);
  if (els.edSave) els.edSave.addEventListener("click", () => saveEditor());
  if (els.edMic) els.edMic.addEventListener("click", () => toggleDictation("editor"));
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
