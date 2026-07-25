// notes.js — the Notes view: a simple notes app inside the side panel.
//
// The Notes TAB in the bottom bar swaps the conversation for Notes exactly the
// way the Library tab swaps in the Library view (the voice assistant stays
// MUTED until the user explicitly turns it on — the orchestrator owns that
// rule). Two screens live inside the one view:
//
//   LIST   — every saved note (entry_type "note" in the Sheet, up to 500),
//            newest first, via the same search_memory call the memory view
//            uses, grouped into COLLAPSIBLE SECTIONS drawn as an iOS inset
//            grouped list: one rounded white card per section, three lines
//            per row (title, a preview of the body, the date) and a chevron
//            saying the row opens. A note's section is the "project" column
//            of its memory_log row; notes without one land in "Unsorted",
//            always last. Tapping a section header folds it open or closed
//            (remembered in chrome.storage.local). Up top: a "+ New note"
//            button (opens a blank editor), an "Edit" button (see SECTIONS
//            below) and a paste-friendly box that saves whatever is typed or
//            pasted as a new note — first line becomes the title, the rest
//            becomes the body — with a section picker and, right beside it,
//            a dictation mic, so a spoken or pasted note saves into place.
//            Swiping a row left reveals Move and Delete; a "…" on each row
//            offers Copy, Move to section and Delete for keyboard and mouse.
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
// SECTIONS ARE NOT A DATABASE OBJECT. A section is exactly two things: the
// value of the "project" column on each individual note row in the Sheet, and
// a list of names in chrome.storage.local (SECTIONS_KEY) that exists ONLY so
// a brand-new, still-empty section can be shown before any note is in it.
// Everything in the "Section management" block below follows from that:
//
//   • Renaming a section, or emptying one into Unsorted, means WRITING THE
//     PROJECT COLUMN ON EVERY ONE OF ITS NOTES — one api.updateMemory() call
//     per note. api.batchUpdateMemory() must never be used for this: it drops
//     the project field on the way out (see api.js) and the backend's
//     batchUpdateMemory_() only ever writes status / deleted / updated_at, so
//     it would answer ok:true for every note and change nothing at all.
//     batchUpdateMemory IS used for deleting notes, where "deleted" is a
//     column it genuinely writes.
//   • A section is removed from chrome.storage.local only AFTER every one of
//     its notes came back confirmed from the server. A partial result keeps
//     the section, restores the list, and says exactly what happened
//     ("Renamed 6 of 8 notes — 2 failed, try again.").
//   • A user-created section with zero notes lives only in local storage, so
//     renaming or deleting THAT one is instant and touches no network.
//
// Creating a note needs the backend's "save_memory" action; an older Apps
// Script deployment answers "unknown action", which api.js flags as
// backendOutdated so the error here can say "redeploy Code.gs" instead of
// blaming the connection. Sections need a deployment new enough to return
// the "project" column — when notes load without it, a dismissible notice
// above the list says sections won't save until Code.gs is redeployed, and
// everything else keeps working (that one notice is also what disables
// Rename and the "keep the notes" delete option; there is no second warning).
// Reading and editing notes work against any existing deployment.

import * as api from "./api.js";
import * as speech from "./speech.js";
import * as ui from "./ui.js";
import * as nsheet from "./nsheet.js";

const els = {
  html: document.documentElement,
  view: document.getElementById("notesView"),
  subtitle: document.getElementById("notesSubtitle"),
  newBtn: document.getElementById("noteNewBtn"),
  editBtn: document.getElementById("noteEditBtn"),
  editBar: document.getElementById("notesEditBar"),
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
const UNDO_MS = 6000; // how long an undo toast stays up after a delete
// Swipe-to-reveal: how far a row slides left, and how far a drag must travel
// before it counts as a swipe rather than a tap.
const SWIPE_W = 152;
const SWIPE_SLOP = 8;

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
let editMode = false; // iOS-style list editing: Rename/Delete on every header
let sectionBusy = false; // a section rename/empty/delete loop is in flight
let openSwipeRow = null; // the one row currently swiped open, if any

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
 * View toggling — mirrors ui.openLibrary / ui.closeLibrary
 * ------------------------------------------------------------------ */
function notesOpen() {
  return els.html.getAttribute("data-view") === "notes";
}
function editorOpen() {
  return els.view && els.view.getAttribute("data-screen") === "editor";
}

function openNotes() {
  // Never leave a half-finished Library selection behind underneath.
  ui.exitMemSelect();
  showList();
  els.html.setAttribute("data-view", "notes");
  loadNotes();
}

function closeNotes() {
  stopDictationUI();
  nsheet.close(); // never leave a Rename or Delete sheet hanging over another tab
  closeSwipe();
  setEditMode(false); // edit mode is per-visit, like an iOS list
  // Auto-save on the way out (same contract as the editor's back button);
  // fire-and-forget — the row updates next time the list loads.
  if (editorOpen() && editorDirty()) saveEditor({ quiet: true });
  els.html.setAttribute("data-view", "chat");
}

// The Notes tab opens this view — the list, freshly loaded.
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

function onViewChanged() {
  if (notesOpen()) return;
  // The view left Notes through a path that isn't ours (a tab tap, the user
  // addressing Sharon, the welcome replay): same cleanup as closeNotes.
  stopDictationUI();
  nsheet.close();
  closeSwipe();
  setEditMode(false);
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

function setSectionOpen(name, open) {
  openSections[name] = open;
  saveOpenSections();
}

// The loaded notes that currently sit in a section, compared the same
// case-insensitive way sectionNames() folds them together.
function notesIn(name) {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower) return [];
  return hits.filter((h) => String((h && h.project) || "").trim().toLowerCase() === lower);
}

// Rule for every rename: names are compared case-insensitively, so two
// sections can never differ only by case. Returns the clash message, or "".
// `except` is the name being renamed, which is allowed to keep its own spot.
function nameClash(name, except) {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower) return "Give the section a name.";
  const skip = String(except || "").trim().toLowerCase();
  if (lower === UNSORTED.toLowerCase())
    return "“" + UNSORTED + "” is where notes with no section already live.";
  if (lower === skip) return ""; // same name, different spelling — fine
  const existing = sectionNames().find((s) => s.toLowerCase() === lower);
  if (existing) return "A section called " + existing + " already exists.";
  return "";
}

/* --- the local list of names: the ONLY place an empty section exists --- */
function ensureLocalSection(name) {
  const lower = String(name || "").trim().toLowerCase();
  if (!lower) return;
  if (!userSections.some((s) => s.toLowerCase() === lower)) userSections.push(name);
}

function removeLocalSection(name) {
  const lower = String(name || "").trim().toLowerCase();
  userSections = userSections.filter((s) => s.toLowerCase() !== lower);
  delete openSections[name];
}

// Rename in local storage: the name moves, and so does its open/closed state.
function renameLocalSection(from, to) {
  const wasOpen = isSectionOpen(from);
  removeLocalSection(from);
  ensureLocalSection(to);
  openSections[to] = wasOpen;
  saveUserSections();
  saveOpenSections();
}

// "+ New section": name it, keep it locally, show it expanded and empty.
// Nothing touches the Sheet — a section first reaches the Sheet when a note
// is saved into it. The in-panel sheet below replaces the window.prompt() that
// used to live here; a duplicate name is refused out loud rather than
// silently dropped, and the sheet stays open so the name can be fixed.
async function createSection() {
  const raw = await nsheet.textSheet({
    title: "New section",
    message: "It stays on this computer until you save a note into it.",
    value: "",
    placeholder: "Section name",
    confirmLabel: "Create",
    validate: (v) => nameClash(v, ""),
  });
  if (raw == null) return;
  const name = String(raw).trim();
  if (!name || nameClash(name, "")) return;
  ensureLocalSection(name);
  saveUserSections();
  setSectionOpen(name, true);
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
// property — the deployed Apps Script predates sections. This ONE check is
// also what disables Rename and the "keep the notes" delete option, so a
// section change can never quietly fail against an old deployment.
function backendStale() {
  return hits.length > 0 && !hits.some((h) => h && typeof h === "object" && "project" in h);
}

// Bring the existing notice back and scroll it into view — what a blocked
// Rename or "keep the notes" points at. Deliberately NOT a second warning.
function showStaleNotice() {
  staleDismissed = false;
  renderStaleNotice();
  if (els.stale) els.stale.scrollIntoView({ block: "nearest" });
}

// Say so once, dismissibly, in the existing error styling; the list itself
// keeps working.
function renderStaleNotice() {
  if (!els.stale) return;
  const stale = backendStale();
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
  openSwipeRow = null; // the rows it referred to are about to be replaced
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

// One section, drawn as an inset grouped list: a header sitting directly
// above ONE continuous rounded card of rows. The header carries the section's
// name in sentence case exactly as it was typed, its count, a collapse
// chevron, and a "…" that offers Rename / Delete / Collapse without entering
// edit mode. In edit mode it also grows visible Rename and Delete buttons.
// Every control in it is a 44x44 hit area, whatever size the glyph inside is.
function sectionGroup(name, rows) {
  const wrap = document.createElement("div");
  wrap.className = "nsec";
  const open = isSectionOpen(name);
  const isUnsorted = name === UNSORTED;
  const countText = rows.length === 1 ? "1 note" : rows.length + " notes";

  const head = document.createElement("div");
  head.className = "nsec-head";

  // The name and count are themselves the collapse target — the whole left
  // side of the header, not just the little chevron.
  const main = document.createElement("button");
  main.type = "button";
  main.className = "nsec-main";
  main.setAttribute("aria-expanded", open ? "true" : "false");
  main.setAttribute("aria-label", "Section “" + name + "” — " + countText);
  const label = document.createElement("span");
  label.className = "nsec-t";
  label.textContent = name;
  main.appendChild(label);
  const count = document.createElement("span");
  count.className = "nsec-n";
  count.textContent = countText;
  main.appendChild(count);
  head.appendChild(main);

  // Edit mode: the two actions, spelled out. "Unsorted" isn't a section the
  // user made — it's where sectionless notes land — so it has neither.
  if (!isUnsorted) {
    const acts = document.createElement("div");
    acts.className = "nsec-acts";
    const ren = document.createElement("button");
    ren.type = "button";
    ren.className = "nsec-act";
    ren.textContent = "Rename";
    ren.setAttribute("aria-label", "Rename the section “" + name + "”");
    ren.addEventListener("click", () => renameSection(name));
    acts.appendChild(ren);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "nsec-act danger";
    del.textContent = "Delete";
    del.setAttribute("aria-label", "Delete the section “" + name + "”");
    del.addEventListener("click", () => deleteSection(name));
    acts.appendChild(del);
    head.appendChild(acts);
  }

  const chev = document.createElement("button");
  chev.type = "button";
  chev.className = "nsec-icon nsec-chevbtn";
  chev.setAttribute("aria-expanded", open ? "true" : "false");
  chev.setAttribute("aria-label", (open ? "Collapse" : "Expand") + " “" + name + "”");
  chev.appendChild(svgOf(I_CHEVRON, "nsec-chev"));
  head.appendChild(chev);

  // The "…" is available WITHOUT edit mode — the fast path to the same things.
  const more = document.createElement("button");
  more.type = "button";
  more.className = "nsec-icon nsec-more";
  more.setAttribute("aria-label", "More for the section “" + name + "”");
  more.setAttribute("aria-haspopup", "menu");
  more.appendChild(svgOf(I_MORE, ""));
  more.addEventListener("click", () => sectionMenu(more, name, rows.length));
  head.appendChild(more);

  wrap.appendChild(head);

  const card = document.createElement("div");
  card.className = "mg-card nsec-card";
  card.classList.toggle("hidden", !open);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "nsec-empty";
    empty.textContent = "Nothing in this section yet — pick it when you save a note.";
    card.appendChild(empty);
  } else {
    for (const h of rows) card.appendChild(noteRow(h, name));
  }
  wrap.appendChild(card);

  const toggle = () => {
    const nowOpen = main.getAttribute("aria-expanded") !== "true";
    main.setAttribute("aria-expanded", nowOpen ? "true" : "false");
    chev.setAttribute("aria-expanded", nowOpen ? "true" : "false");
    chev.setAttribute("aria-label", (nowOpen ? "Collapse" : "Expand") + " “" + name + "”");
    card.classList.toggle("hidden", !nowOpen);
    setSectionOpen(name, nowOpen); // still saved under sharon_note_sections_open
  };
  main.addEventListener("click", toggle);
  chev.addEventListener("click", toggle);
  return wrap;
}

// The section "…" menu — the same three things the header offers, reachable
// without entering edit mode. "Unsorted" can only be collapsed.
async function sectionMenu(anchor, name, count) {
  const isUnsorted = name === UNSORTED;
  const open = isSectionOpen(name);
  const items = [];
  if (!isUnsorted) {
    items.push({ key: "rename", label: "Rename" });
    items.push({ key: "delete", label: "Delete", tone: "danger" });
  }
  items.push({ key: "collapse", label: open ? "Collapse" : "Expand" });
  const choice = await nsheet.menu(anchor, items);
  if (choice === "rename") renameSection(name);
  else if (choice === "delete") deleteSection(name, count);
  else if (choice === "collapse") {
    setSectionOpen(name, !open);
    renderList();
  }
}

/* ------------------------------------------------------------------ *
 * The row — title, a preview of the body, the date, and a chevron.
 * Swiping it left reveals Move and Delete; the "…" carries the same
 * actions (plus Copy) for anyone not using a touchpad.
 * ------------------------------------------------------------------ */
// Lines 1 and 2 are worked out exactly the way the Library works them out —
// one definition, both screens. Line 1 is the title, falling back to the
// first line of the body (notes saved from a single line keep the whole text
// in `content`). Line 2 is whatever the body says BEYOND that, on one line,
// and is empty — so the line is left out rather than drawn blank — when the
// note is only a title.
const rowTitle = ui.rowTitle;
const rowPreview = ui.rowPreview;

function noteRow(h, section) {
  const row = document.createElement("div");
  row.className = "nrow";

  // The actions the swipe reveals, sitting UNDER the sliding face.
  const behind = document.createElement("div");
  behind.className = "nrow-swipe";
  const moveBtn = document.createElement("button");
  moveBtn.type = "button";
  moveBtn.className = "nrow-swipe-btn move";
  moveBtn.textContent = "Move";
  moveBtn.setAttribute("aria-label", "Move this note to another section");
  moveBtn.addEventListener("click", () => {
    closeSwipe();
    moveNote(h);
  });
  behind.appendChild(moveBtn);
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "nrow-swipe-btn del";
  delBtn.textContent = "Delete";
  delBtn.setAttribute("aria-label", "Delete this note");
  delBtn.addEventListener("click", () => {
    closeSwipe();
    deleteNote(h, section);
  });
  behind.appendChild(delBtn);
  row.appendChild(behind);

  const face = document.createElement("div");
  face.className = "nrow-face";

  const main = document.createElement("button");
  main.type = "button";
  main.className = "nrow-main";
  main.setAttribute("aria-label", "Open the note “" + rowTitle(h) + "”");
  const t = document.createElement("div");
  t.className = "nrow-t";
  t.textContent = rowTitle(h);
  main.appendChild(t);
  const preview = rowPreview(h);
  if (preview) {
    const p = document.createElement("div");
    p.className = "nrow-p";
    p.textContent = preview;
    main.appendChild(p);
  }
  const when = ui.metaTime(h.created_at);
  if (when) {
    const m = document.createElement("div");
    m.className = "nrow-d";
    m.textContent = when;
    main.appendChild(m);
  }
  main.addEventListener("click", () => {
    // A swipe that ended on this row is not a tap, and an open row's next tap
    // just puts it back rather than opening the editor.
    if (row.getAttribute("data-swiped") === "true") {
      closeSwipe();
      return;
    }
    openEditor(h);
  });
  face.appendChild(main);

  // The row's own "…": Copy (unchanged, checkmark and all), Move, Delete.
  const more = document.createElement("button");
  more.type = "button";
  more.className = "nrow-more";
  more.setAttribute("aria-label", "More for the note “" + rowTitle(h) + "”");
  more.setAttribute("aria-haspopup", "menu");
  more.appendChild(svgOf(I_MORE, ""));
  more.appendChild(svgOf(I_CHECK, "i-check"));
  more.addEventListener("click", (ev) => {
    ev.stopPropagation();
    rowMenu(more, h, section);
  });
  face.appendChild(more);

  face.appendChild(svgOf(I_CHEVRON, "nrow-chev"));
  row.appendChild(face);

  wireSwipe(row, face);
  return row;
}

async function rowMenu(anchor, h, section) {
  const choice = await nsheet.menu(anchor, [
    { key: "copy", label: "Copy" },
    { key: "move", label: "Move to section" },
    { key: "delete", label: "Delete", tone: "danger" },
  ]);
  if (choice === "copy") copyToClipboard(fullNoteText(h), () => flashCopied(anchor));
  else if (choice === "move") moveNote(h);
  else if (choice === "delete") deleteNote(h, section);
}

/* --- swipe-to-reveal --- */
function closeSwipe() {
  if (!openSwipeRow) return;
  const row = openSwipeRow;
  openSwipeRow = null;
  row.removeAttribute("data-swiped");
  const face = row.querySelector(".nrow-face");
  if (face) face.style.transform = "";
}

function wireSwipe(row, face) {
  let startX = 0;
  let startY = 0;
  let base = 0;
  let dragging = false;
  let decided = false; // horizontal (swipe) or vertical (the list scrolls)

  row.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    startX = ev.clientX;
    startY = ev.clientY;
    base = row.getAttribute("data-swiped") === "true" ? -SWIPE_W : 0;
    dragging = true;
    decided = false;
  });

  row.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return;
      // A mostly-vertical drag belongs to the scrolling list, not to us.
      if (Math.abs(dy) > Math.abs(dx)) {
        dragging = false;
        return;
      }
      decided = true;
      closeSwipeElsewhere(row);
      face.style.transition = "none";
      try {
        row.setPointerCapture(ev.pointerId);
      } catch (_) {
        /* capture is an optimization — the drag still tracks without it */
      }
    }
    const at = Math.max(-SWIPE_W, Math.min(0, base + dx));
    face.style.transform = "translateX(" + at + "px)";
  });

  const end = (ev) => {
    if (!dragging) return;
    dragging = false;
    if (!decided) return;
    face.style.transition = "";
    const dx = ev && ev.clientX != null ? ev.clientX - startX : 0;
    const at = Math.max(-SWIPE_W, Math.min(0, base + dx));
    const openIt = at < -SWIPE_W / 2;
    face.style.transform = openIt ? "translateX(" + -SWIPE_W + "px)" : "";
    if (openIt) {
      row.setAttribute("data-swiped", "true");
      openSwipeRow = row;
    } else {
      row.removeAttribute("data-swiped");
      if (openSwipeRow === row) openSwipeRow = null;
    }
  };
  row.addEventListener("pointerup", end);
  row.addEventListener("pointercancel", end);
  row.addEventListener("pointerleave", (ev) => {
    if (dragging && decided) end(ev);
  });
}

function closeSwipeElsewhere(row) {
  if (openSwipeRow && openSwipeRow !== row) closeSwipe();
}

/* ------------------------------------------------------------------ *
 * SECTION MANAGEMENT
 *
 * Read the rules at the top of this file before touching anything here.
 * The short version, restated where it matters most:
 *
 *   A section change means writing the "project" column on every one of its
 *   notes. That is api.updateMemory(), ONE NOTE PER CALL. api.batchUpdateMemory()
 *   cannot do it — it drops the project field and the backend never writes
 *   that column in a batch — so it appears here exactly once, for DELETING
 *   notes, where "deleted" is a column the batch genuinely writes.
 * ------------------------------------------------------------------ */

// Whether the list is in edit mode — the header's Edit/Done button.
function setEditMode(on) {
  editMode = !!on;
  if (els.view) els.view.setAttribute("data-edit", editMode ? "on" : "off");
  if (els.editBtn) {
    els.editBtn.textContent = editMode ? "Done" : "Edit";
    els.editBtn.setAttribute("aria-pressed", editMode ? "true" : "false");
    els.editBtn.setAttribute(
      "aria-label",
      editMode ? "Finish editing your sections" : "Edit your sections"
    );
  }
  closeSwipe();
}

/**
 * Write `project` onto every note in `rows`, one api.updateMemory() call at a
 * time, reporting "<verb> 3 of 8…" into the open sheet as it goes.
 *
 * Returns { ok, failed } where ok is [{ h, was }] — `was` being the project
 * the note held BEFORE the write, which is what undo re-sends. Nothing here
 * is optimistic: a note's in-memory project only changes once its own call
 * came back, so a partial failure leaves the list telling the truth.
 */
async function applyProject(rows, project, verb) {
  const ok = [];
  const failed = [];
  const total = rows.length;
  for (let i = 0; i < total; i++) {
    const h = rows[i];
    nsheet.progress(verb + " " + (i + 1) + " of " + total + "…");
    if (!h || !h.entry_id) {
      failed.push(h);
      continue;
    }
    const was = String(h.project || "");
    try {
      await api.updateMemory({ entryId: h.entry_id, project }); // ONE note, one call
      h.project = project;
      ok.push({ h, was });
    } catch (_) {
      failed.push(h);
    }
  }
  nsheet.progress("");
  return { ok, failed };
}

// The same loop with no sheet on screen — how undo puts sections back.
async function applyProjectQuiet(pairs) {
  let restored = 0;
  for (const { h, was } of pairs) {
    if (!h || !h.entry_id) continue;
    try {
      await api.updateMemory({ entryId: h.entry_id, project: was });
      h.project = was;
      restored++;
    } catch (_) {
      /* the toast below reports the shortfall */
    }
  }
  return restored;
}

function noteWord(n) {
  return n === 1 ? "note" : "notes";
}

/* --------------------------- RENAME --------------------------- */
async function renameSection(name) {
  if (sectionBusy || name === UNSORTED) return;
  // The deployed Apps Script doesn't know the project column: renaming would
  // report success and write nothing. Point at the notice that already says
  // so — never invent a second warning.
  //
  // This check comes BEFORE the zero-notes shortcut on purpose. While the
  // backend is stale no note reports a project at all, so "this section has
  // no notes" is not a fact — it's the absence of one. Renaming it locally
  // could quietly strand notes that really are in it on the server.
  if (backendStale()) {
    showStaleNotice();
    return;
  }
  const raw = await nsheet.textSheet({
    title: "Rename section",
    message: "Every note in it moves to the new name.",
    value: name,
    placeholder: "Section name",
    confirmLabel: "Save",
    validate: (v) => nameClash(v, name), // refuses a collision, keeps the sheet open
  });
  if (raw == null) return;
  const next = String(raw).trim();
  if (!next || next === name || nameClash(next, name)) return;

  const rows = notesIn(name);
  // A section the user created that still has zero notes exists ONLY in local
  // storage — no network call at all.
  if (!rows.length) {
    renameLocalSection(name, next);
    nsheet.close();
    renderList();
    return;
  }

  sectionBusy = true;
  nsheet.workSheet({
    title: "Renaming to “" + next + "”",
    message: "Each note moves on its own — this takes a moment.",
  });
  try {
    const { ok, failed } = await applyProject(rows, next, "Moving");
    if (failed.length) {
      // Some notes are still under the old name, so the old section is still
      // real: keep it, restore the list, and say exactly what happened.
      ensureLocalSection(name);
      if (ok.length) ensureLocalSection(next);
      saveUserSections();
      renderList();
      ui.showUndoToast({
        label:
          "Renamed " + ok.length + " of " + rows.length + " notes — " +
          failed.length + " failed, try again.",
        duration: 7000,
      });
      return;
    }
    // Every note confirmed — only NOW does the old name leave local storage.
    renameLocalSection(name, next);
    renderList();
    ui.showUndoToast({ label: "Renamed to “" + next + "”", duration: 4000 });
  } finally {
    sectionBusy = false;
    nsheet.close();
  }
}

/* --------------------------- DELETE --------------------------- */
async function deleteSection(name) {
  if (sectionBusy || name === UNSORTED) return;
  const rows = notesIn(name);

  // Empty and local-only: nothing to ask about, nothing to send.
  if (!rows.length) {
    removeLocalSection(name);
    saveUserSections();
    saveOpenSections();
    renderList();
    return;
  }

  // If "keep the notes" is about to be unavailable, put the existing notice
  // back on screen first, so the reason is visible behind the sheet.
  const stale = backendStale();
  if (stale) showStaleNotice();
  const n = rows.length;
  const choice = await nsheet.choiceSheet({
    title: "Delete “" + name + "”?",
    message:
      "This section has " + n + " " + noteWord(n) +
      ". Deleting the notes marks them deleted in your Sheet rather than erasing them, " +
      "so you can still recover them there.",
    choices: [
      {
        key: "keep",
        label: "Keep the notes, move them to Unsorted",
        detail: stale
          ? "Needs a newer Apps Script — see the notice above the list."
          : "The section goes; its " + n + " " + noteWord(n) + " stay.",
        disabled: stale, // same single stale check as Rename
      },
      {
        key: "purge",
        label: "Delete the section and its " + n + " " + noteWord(n),
        tone: "danger",
      },
      { key: "cancel", label: "Cancel", tone: "cancel" },
    ],
  });
  if (!choice || choice === "cancel") {
    nsheet.close();
    return;
  }
  if (choice === "keep") await emptySectionToUnsorted(name, rows);
  else if (choice === "purge") await deleteSectionAndNotes(name, rows);
}

// Option 1 — the notes survive: project := "" on each of them, one call each.
async function emptySectionToUnsorted(name, rows) {
  sectionBusy = true;
  nsheet.workSheet({
    title: "Moving to " + UNSORTED,
    message: "Each note moves on its own — this takes a moment.",
  });
  try {
    const { ok, failed } = await applyProject(rows, "", "Moving");
    if (failed.length) {
      ensureLocalSection(name); // the section still holds notes — it stays
      saveUserSections();
      renderList();
      ui.showUndoToast({
        label:
          "Moved " + ok.length + " of " + rows.length + " notes to Unsorted — " +
          failed.length + " failed, try again.",
        duration: 7000,
      });
      return;
    }
    // Every note confirmed on the server — now the section may go.
    removeLocalSection(name);
    saveUserSections();
    saveOpenSections();
    renderList();
    ui.showUndoToast({
      label: "Moved " + ok.length + " " + noteWord(ok.length) + " to Unsorted",
      duration: UNDO_MS,
      onUndo: () => undoEmptySection(name, ok),
    });
  } finally {
    sectionBusy = false;
    nsheet.close();
  }
}

// Undo for option 1: re-send each note's ORIGINAL section name, one at a time.
async function undoEmptySection(name, pairs) {
  ensureLocalSection(name);
  saveUserSections();
  renderList();
  const restored = await applyProjectQuiet(pairs);
  renderList();
  if (restored < pairs.length) {
    ui.showUndoToast({
      label:
        "Put back " + restored + " of " + pairs.length + " notes — " +
        (pairs.length - restored) + " failed, try again.",
      duration: 7000,
    });
  }
}

// Option 2 — the notes go too. "deleted" IS a column batch_update_memory
// writes, so this is one round trip and it genuinely works.
async function deleteSectionAndNotes(name, rows) {
  const targets = rows.filter((h) => h && h.entry_id);
  if (!targets.length) return;
  sectionBusy = true;
  nsheet.workSheet({ title: "Deleting “" + name + "”" });
  nsheet.progress("Deleting " + targets.length + " " + noteWord(targets.length) + "…");
  try {
    const res = await api.batchUpdateMemory(
      targets.map((h) => ({ entryId: h.entry_id, deleted: true }))
    );
    const results = (res && res.results) || [];
    const okIds = new Set(results.filter((r) => r && r.ok).map((r) => String(r.entry_id)));
    const ok = targets.filter((h) => okIds.has(String(h.entry_id)));
    const failed = targets.filter((h) => !okIds.has(String(h.entry_id)));
    const okSet = new Set(ok.map((h) => String(h.entry_id)));
    hits = hits.filter((h) => !okSet.has(String((h && h.entry_id) || "")));

    if (failed.length) {
      ensureLocalSection(name); // notes are still in it — the section stays
      saveUserSections();
      renderList();
      ui.showUndoToast({
        label:
          "Deleted " + ok.length + " of " + targets.length + " notes — " +
          failed.length + " failed, try again.",
        duration: 7000,
      });
      return;
    }
    removeLocalSection(name);
    saveUserSections();
    saveOpenSections();
    renderList();
    ui.showUndoToast({
      label: "Deleted “" + name + "” and " + ok.length + " " + noteWord(ok.length),
      duration: UNDO_MS,
      onUndo: () => undoDeleteSection(name, ok),
    });
  } catch (_) {
    renderList();
    ui.showUndoToast({ label: "Couldn't delete — check your connection and try again." });
  } finally {
    sectionBusy = false;
    nsheet.close();
  }
}

// Undo for option 2: the same batch again with deleted:false.
async function undoDeleteSection(name, rows) {
  ensureLocalSection(name);
  saveUserSections();
  try {
    const res = await api.batchUpdateMemory(
      rows.map((h) => ({ entryId: h.entry_id, deleted: false }))
    );
    const results = (res && res.results) || [];
    const okIds = new Set(results.filter((r) => r && r.ok).map((r) => String(r.entry_id)));
    const back = rows.filter((h) => okIds.has(String(h.entry_id)));
    hits = back.concat(hits);
    sortHits();
    renderList();
    if (back.length < rows.length) {
      ui.showUndoToast({
        label:
          "Restored " + back.length + " of " + rows.length + " notes — " +
          (rows.length - back.length) + " failed, try again.",
        duration: 7000,
      });
    }
  } catch (_) {
    renderList();
    ui.showUndoToast({ label: "Couldn't restore those — check your connection." });
  }
}

/* ----------------- one note: move, and delete ----------------- */
async function moveNote(h) {
  if (!h || !h.entry_id) return;
  const here = String(h.project || "").trim();
  const choices = [{ key: "", label: UNSORTED, detail: here ? "" : "Where it is now" }];
  for (const s of sectionNames())
    choices.push({
      key: s,
      label: s,
      detail: s.toLowerCase() === here.toLowerCase() ? "Where it is now" : "",
    });
  // Cancel resolves null, exactly the same as dismissing the sheet, so no
  // sentinel key is needed (and none can ever collide with a section name).
  choices.push({ key: null, label: "Cancel", tone: "cancel" });
  const choice = await nsheet.choiceSheet({
    title: "Move “" + rowTitle(h) + "”",
    message: "Pick the section it should live in.",
    choices,
  });
  if (choice == null) {
    nsheet.close();
    return;
  }
  if (choice.toLowerCase() === here.toLowerCase()) {
    nsheet.close();
    return;
  }
  nsheet.workSheet({ title: "Moving “" + rowTitle(h) + "”" });
  try {
    await api.updateMemory({ entryId: h.entry_id, project: choice }); // one note, one call
    h.project = choice;
    renderList();
    ui.showUndoToast({ label: "Moved to " + (choice || UNSORTED), duration: 4000 });
  } catch (err) {
    showErr(els.listErr, problemText(err, "I couldn't move that note."));
  } finally {
    nsheet.close();
  }
}

async function deleteNote(h, section) {
  if (!h || !h.entry_id) return;
  const at = hits.indexOf(h);
  if (at >= 0) hits.splice(at, 1);
  renderList();
  try {
    await api.updateMemory({ entryId: h.entry_id, deleted: true });
    ui.showUndoToast({
      label: "Deleted “" + rowTitle(h) + "”",
      duration: UNDO_MS,
      onUndo: () => undoDeleteNote(h, at, section),
    });
  } catch (err) {
    if (at >= 0) hits.splice(Math.min(at, hits.length), 0, h);
    renderList();
    showErr(els.listErr, problemText(err, "I couldn't delete that note."));
  }
}

async function undoDeleteNote(h, at, section) {
  hits.splice(Math.min(Math.max(at, 0), hits.length), 0, h);
  // A note put back into a section the delete emptied needs its name shown
  // again, even before the next load.
  if (section && section !== UNSORTED) {
    ensureLocalSection(section);
    saveUserSections();
  }
  renderList();
  try {
    await api.updateMemory({ entryId: h.entry_id, deleted: false });
  } catch (_) {
    const back = hits.indexOf(h);
    if (back >= 0) hits.splice(back, 1);
    renderList();
    ui.showUndoToast({ label: "Couldn't restore that note — check your connection." });
  }
}

// Newest first, the order search_memory hands the list back in.
function sortHits() {
  hits.sort((a, b) => {
    const at = new Date((a && a.created_at) || 0).getTime() || 0;
    const bt = new Date((b && b.created_at) || 0).getTime() || 0;
    return bt - at;
  });
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
  closeSwipe();
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
const I_CHECK = '<path d="M20 6 9 17l-5-5"/>';
const I_CHEVRON = '<path d="m9 18 6-6-6-6"/>'; // points right; CSS rotates it open
const I_X = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>';
// The "…" glyph: three solid dots, so it reads at 16px (svgOf strokes by
// default, which would turn small circles into blobs).
const I_MORE =
  '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/>' +
  '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>' +
  '<circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>';

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function wire() {
  // The Notes TAB opens this view (tabs.js) — there is no in-view back arrow
  // on the list any more, because the tab bar is the way out. The editor keeps
  // its own back arrow below: that one is a real back, editor → list.
  if (els.newBtn) els.newBtn.addEventListener("click", () => openEditor(null));
  // "Edit" / "Done" — iOS list editing. "+ New section" lives inside it, so
  // only ONE filled button ever competes with the title.
  if (els.editBtn) els.editBtn.addEventListener("click", () => setEditMode(!editMode));
  if (els.newSectionBtn) els.newSectionBtn.addEventListener("click", createSection);
  // A tap anywhere else in the list puts an open swipe back, the way iOS does.
  if (els.list)
    els.list.addEventListener("pointerdown", (ev) => {
      if (openSwipeRow && !openSwipeRow.contains(ev.target)) closeSwipe();
    });
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
