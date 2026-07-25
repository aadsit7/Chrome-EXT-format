// nsheet.js — the in-panel sheets and menus the Notes list asks questions with.
//
// Manifest V3 forbids inline script, and a side panel has no business calling
// window.prompt()/confirm() (they're modal to the whole browser and can't say
// anything useful). Everything here renders INSIDE the panel, over its own
// scrim, and resolves a promise:
//
//   textSheet()   — a labelled text field, Cancel and a confirm button. The
//                   validate() hook keeps the sheet OPEN and shows a message,
//                   so "a section called X already exists" can be answered
//                   without retyping.
//   choiceSheet() — a titled question with a stack of choices, each of which
//                   may be destructive (red) or disabled with a reason.
//   menu()        — a small popover anchored to the button that opened it
//                   (a section's "…", a row's "…").
//   workSheet()   — a buttonless, undismissable sheet that stays up while the
//                   writes actually run; progress() writes "Moving 3 of 8…"
//                   into it, so a one-note-at-a-time loop looks patient
//                   instead of frozen.
//
// One sheet or menu at a time: opening either closes whatever was open, and
// the closed one's promise resolves to null (the same as Cancel).

const els = {
  panel: null,
  scrim: null,
  sheet: null,
  menu: null,
};

let active = null; // { kind, resolve, settled } for whatever is on screen
let lastFocus = null; // the control that opened it, so focus goes back

function ready() {
  if (els.scrim) return true;
  els.panel = document.querySelector(".panel");
  els.scrim = document.getElementById("nsScrim");
  els.sheet = document.getElementById("nsSheet");
  els.menu = document.getElementById("nsMenu");
  if (!els.scrim || !els.sheet || !els.menu) return false;
  // A work sheet is not dismissible: writes are already in flight behind it,
  // and letting the scrim or Escape hide them would hide the truth.
  els.scrim.addEventListener("click", () => {
    if (active && active.kind !== "work") settle(null);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && active && active.kind !== "work") {
      ev.stopPropagation();
      settle(null);
    }
  });
  return true;
}

// Resolve the open sheet/menu exactly once and take it off screen.
function settle(value) {
  if (!active) return;
  const { resolve } = active;
  active = null;
  els.scrim.classList.remove("open");
  els.sheet.classList.remove("open");
  els.sheet.classList.remove("busy");
  els.sheet.innerHTML = "";
  els.menu.classList.add("hidden");
  els.menu.innerHTML = "";
  if (lastFocus && document.contains(lastFocus)) {
    try {
      lastFocus.focus({ preventScroll: true });
    } catch (_) {
      /* the opener may have been re-rendered away — never block on focus */
    }
  }
  lastFocus = null;
  resolve(value);
}

/** Close whatever is open (as if Cancel had been tapped). Safe when nothing is. */
export function close() {
  settle(null);
}

export function isOpen() {
  return !!active;
}

/* ------------------------------------------------------------------ *
 * Small builders
 * ------------------------------------------------------------------ */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function sheetShell(title, message) {
  els.sheet.innerHTML = "";
  els.sheet.appendChild(el("div", "ns-title", title || ""));
  if (message) els.sheet.appendChild(el("div", "ns-msg", message));
  const progress = el("div", "ns-progress hidden");
  progress.setAttribute("aria-live", "polite");
  els.sheet.appendChild(progress);
  return progress;
}

function openShell(kind, resolve) {
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  active = { kind, resolve };
  els.scrim.classList.add("open");
  els.sheet.classList.add("open");
}

// Focus WITHOUT letting the browser scroll an ancestor to "reveal" the
// control. The panel is overflow:hidden but still programmatically
// scrollable (the settings sheet is parked below the fold with a transform),
// so a plain focus() slides the whole panel — scrim, sheet and all — up out
// of place. Every focus in this module goes through here.
function focusQuietly(node) {
  if (!node) return;
  try {
    node.focus({ preventScroll: true });
  } catch (_) {
    node.focus();
  }
  if (els.panel) els.panel.scrollTop = 0;
}

/* ------------------------------------------------------------------ *
 * textSheet — the replacement for window.prompt()
 * ------------------------------------------------------------------ */
/**
 * Resolves the typed (untrimmed) string, or null if cancelled.
 * validate(value) may return an error string to keep the sheet open.
 */
export function textSheet({
  title = "",
  message = "",
  value = "",
  placeholder = "",
  confirmLabel = "Save",
  validate = null,
} = {}) {
  if (!ready()) return Promise.resolve(null);
  settle(null);
  return new Promise((resolve) => {
    openShell("text", resolve);
    sheetShell(title, message);

    const field = document.createElement("input");
    field.type = "text";
    field.className = "ns-field";
    field.value = value;
    field.placeholder = placeholder;
    field.setAttribute("aria-label", title || "Value");
    els.sheet.appendChild(field);

    const err = el("div", "ns-err hidden");
    err.setAttribute("aria-live", "polite");
    els.sheet.appendChild(err);

    const row = el("div", "ns-row");
    const cancel = el("button", "ns-btn", "Cancel");
    cancel.type = "button";
    const save = el("button", "ns-btn primary", confirmLabel);
    save.type = "button";
    row.appendChild(cancel);
    row.appendChild(save);
    els.sheet.appendChild(row);

    const submit = () => {
      const problem = validate ? validate(field.value) : "";
      if (problem) {
        err.textContent = problem;
        err.classList.remove("hidden");
        focusQuietly(field);
        field.select();
        return;
      }
      settle(field.value);
    };
    cancel.addEventListener("click", () => settle(null));
    save.addEventListener("click", submit);
    field.addEventListener("input", () => err.classList.add("hidden"));
    field.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submit();
      }
    });
    focusQuietly(field);
    field.select();
  });
}

/* ------------------------------------------------------------------ *
 * choiceSheet — a question with a stack of answers
 * ------------------------------------------------------------------ */
/**
 * choices: [{ key, label, detail?, tone?: "danger"|"cancel", disabled? }]
 * Resolves the chosen key, or null when cancelled / dismissed.
 */
export function choiceSheet({ title = "", message = "", choices = [] } = {}) {
  if (!ready()) return Promise.resolve(null);
  settle(null);
  return new Promise((resolve) => {
    openShell("choice", resolve);
    sheetShell(title, message);

    const stack = el("div", "ns-choices");
    for (const c of choices) {
      if (!c) continue;
      const btn = el("button", "ns-choice" + (c.tone ? " " + c.tone : ""));
      btn.type = "button";
      btn.appendChild(el("span", "ns-choice-l", c.label || ""));
      if (c.detail) btn.appendChild(el("span", "ns-choice-d", c.detail));
      if (c.disabled) {
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
      } else {
        btn.addEventListener("click", () => settle(c.key));
      }
      stack.appendChild(btn);
    }
    els.sheet.appendChild(stack);
    focusQuietly(stack.querySelector("button:not([disabled])"));
  });
}

/* ------------------------------------------------------------------ *
 * menu — a popover anchored to the button that opened it
 * ------------------------------------------------------------------ */
/**
 * items: [{ key, label, tone?: "danger", disabled? }]
 * Resolves the chosen key, or null when dismissed.
 */
export function menu(anchor, items = []) {
  if (!ready()) return Promise.resolve(null);
  settle(null);
  return new Promise((resolve) => {
    lastFocus = anchor instanceof HTMLElement ? anchor : null;
    active = { kind: "menu", resolve };
    els.menu.innerHTML = "";
    for (const it of items) {
      if (!it) continue;
      const btn = el("button", "ns-menu-item" + (it.tone ? " " + it.tone : ""), it.label || "");
      btn.type = "button";
      btn.setAttribute("role", "menuitem");
      if (it.disabled) {
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
      } else {
        btn.addEventListener("click", () => settle(it.key));
      }
      els.menu.appendChild(btn);
    }
    els.scrim.classList.add("open");
    els.menu.classList.remove("hidden");

    // Anchor it under the button, then pull it back inside the panel.
    const panelBox = (els.panel || document.body).getBoundingClientRect();
    const box = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    const menuBox = els.menu.getBoundingClientRect();
    const gap = 6;
    let left = box ? box.right - menuBox.width : panelBox.right - menuBox.width - 16;
    let top = box ? box.bottom + gap : panelBox.top + 60;
    const minL = panelBox.left + 8;
    const maxL = panelBox.right - menuBox.width - 8;
    left = Math.max(minL, Math.min(left, Math.max(minL, maxL)));
    // No room below? Flip it above the button rather than off the bottom.
    if (top + menuBox.height > panelBox.bottom - 8 && box)
      top = Math.max(panelBox.top + 8, box.top - gap - menuBox.height);
    els.menu.style.left = Math.round(left) + "px";
    els.menu.style.top = Math.round(top) + "px";

    focusQuietly(els.menu.querySelector("button:not([disabled])"));
  });
}

/* ------------------------------------------------------------------ *
 * workSheet — what stays on screen while the writes actually run
 *
 * A rename or an empty-into-Unsorted is one network round trip PER NOTE, so
 * "Moving 3 of 8…" is the difference between patient and broken. This sheet
 * has no buttons and can't be dismissed: the work is already in flight, and
 * whoever started it closes this when the last note comes back.
 * ------------------------------------------------------------------ */
export function workSheet({ title = "", message = "" } = {}) {
  if (!ready()) return;
  settle(null);
  openShell("work", () => {});
  sheetShell(title, message);
  els.sheet.classList.add("busy");
  progress("Starting…");
}

/** Write (or with "", clear) the open sheet's progress line. */
export function progress(text) {
  if (!active || active.kind === "menu") return;
  const line = els.sheet.querySelector(".ns-progress");
  if (!line) return;
  line.textContent = text || "";
  line.classList.toggle("hidden", !text);
}
