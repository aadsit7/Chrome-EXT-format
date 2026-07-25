// tabs.js — the bottom tab bar: five DESTINATIONS and nothing else.
//
//   Sharon  → data-view="chat"     the conversation
//   Library → data-view="library"  everything saved, in one list
//   Notes   → data-view="notes"    the notes screen
//   Audio   → data-view="audio"    voice recordings (record + past ones)
//   Video   → data-view="video"    screen recordings (record + past ones)
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: switching tabs is NAVIGATION ONLY.
// Nothing in here starts, stops, pauses or interrupts a recording, and nothing
// in here touches Sharon's mode — mode.js is never imported and enterMode() is
// never called. Tab state (which screen you're looking at) and mode state
// (what Sharon is doing) are two separate things, so a recording started on
// the Audio or Video tab keeps running while you browse any other tab.
//
// The panel has always switched screens with data-view on <html>; that stays
// exactly as it was. Other code paths still set data-view directly (the user
// speaking closes Notes, the first-run welcome takes over), so a
// MutationObserver mirrors whatever data-view says back onto the bar instead
// of the bar trying to be the source of truth.

import * as ui from "./ui.js";
import * as notes from "./notes.js";

const TABS = ["chat", "library", "notes", "audio", "video"];

const els = {
  html: document.documentElement,
  bar: document.getElementById("tabBar"),
  btns: {
    chat: document.getElementById("tabChat"),
    library: document.getElementById("tabLibrary"),
    notes: document.getElementById("tabNotes"),
    audio: document.getElementById("tabAudio"),
    video: document.getElementById("tabVideo"),
  },
  recPill: document.getElementById("recPill"),
};

// Per-tab "you just arrived here" hooks the orchestrator registers (loading
// the Library list, the recordings list, the local video list). They only ever
// fetch and render — never a mode change.
let openers = {};

export function initTabs({ onOpen } = {}) {
  openers = onOpen || {};
  for (const name of TABS) {
    const btn = els.btns[name];
    if (btn) btn.addEventListener("click", () => goTo(name));
  }
  // The recording pill in the header jumps to whichever screen owns the
  // recording that's running. Navigation only — the recording is untouched.
  if (els.recPill)
    els.recPill.addEventListener("click", () => {
      goTo(els.recPill.getAttribute("data-kind") === "video" ? "video" : "audio");
    });
  new MutationObserver(syncBar).observe(els.html, {
    attributes: true,
    attributeFilter: ["data-view"],
  });
  syncBar();
}

export function currentTab() {
  const v = els.html.getAttribute("data-view") || "chat";
  return TABS.includes(v) ? v : "chat";
}

// Go to a tab. This is the ONLY thing a tab tap does.
export function goTo(name) {
  if (!TABS.includes(name)) return;
  ui.exitMemSelect(); // never leave a half-finished Library selection behind
  if (name === "notes") {
    // Notes owns its own screen state (list vs editor) and loads its list on
    // open, so it sets data-view itself — same path as before.
    notes.openNotesView();
  } else {
    // Leaving Notes auto-saves an open, edited note: notes.js watches
    // data-view and runs that cleanup itself, whatever moved the view.
    ui.setView(name);
  }
  const open = openers[name];
  if (typeof open === "function") open();
}

function syncBar() {
  const view = els.html.getAttribute("data-view") || "chat";
  // The first-run welcome is a full-screen overlay, not a tab — the bar keeps
  // showing Sharon as the selected destination underneath it.
  const active = TABS.includes(view) ? view : "chat";
  for (const name of TABS) {
    const btn = els.btns[name];
    if (!btn) continue;
    const on = name === active;
    btn.setAttribute("aria-selected", on ? "true" : "false");
    btn.classList.toggle("on", on);
  }
}
