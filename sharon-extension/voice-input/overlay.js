// voice-input/overlay.js — the Voice Input Overlay's content script.
//
// It runs inside every ordinary web page (see manifest.json → content_scripts)
// and does exactly one thing: when you focus a text field, a small microphone
// button appears just inside that field's right edge. Tap it, speak, and your
// words are typed into the field at the cursor.
//
// Everything visible lives in a SHADOW ROOT, so the page's CSS cannot restyle
// the button and the button's CSS cannot leak into the page. Every global and
// class name here is prefixed "sharon-vi" / "__sharonVoiceInput" so nothing can
// collide with page.js, which Sharon injects into pages separately.
//
// It owns no speech engine of its own. The recognizer lives in Sharon's one
// hidden offscreen document (voice-input/recognizer.js); this script only talks
// to the service worker, and every message it sends or receives is prefixed
// "vi:" so it can never be confused with Sharon's own traffic:
//
//   here → SW:  { t:"vi:start" } → { ok, reason? }   { t:"vi:stop" }
//               { t:"vi:open-panel" }
//   SW → here:  { t:"vi:started" } { t:"vi:result", text } { t:"vi:ended" }
//               { t:"vi:error", error }
//
// It fails quietly by design: a refusal, a missing microphone or an unavailable
// engine shows two words on the button for two seconds and stops. It never
// spams the host page's console.

(function () {
  "use strict";

  // One instance per frame, ever. A second injection just returns.
  if (window.__sharonVoiceInputReady) return;
  window.__sharonVoiceInputReady = true;

  const BTN_SIZE = 22; // px — the button's box
  const EDGE_GAP = 6; // px — how far inside the field's right edge it sits
  const MSG_MS = 2000; // how long a short message stays on the button
  const MIN_W = 60; // don't decorate fields too small to hold the button
  const MIN_H = 18;
  const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel"]); // never "password"
  // The only events that hand the insertion point back to the user: they
  // clicked, typed, selected, or pasted. (Our own writes fire "input" too, but
  // by then the live cursor already IS our caret, so the sync is a no-op.)
  const CARET_EVENTS = ["pointerup", "keyup", "select", "input"];

  let host = null; // the shadow host that carries the button
  let shadow = null;
  let btn = null;
  let msgEl = null;
  let msgTimer = null;

  let field = null; // the editable element the button currently belongs to
  let kind = ""; // "input" (input/textarea) | "rich" (contenteditable)
  let live = false; // dictation running right now
  let placing = false; // rAF throttle for repositioning
  let watchTimer = null; // catches fields that are removed or moved silently
  let ro = null; // ResizeObserver on the current field

  /* ---------------------------------------------------------------- *
   * Talking to the service worker
   * ---------------------------------------------------------------- */
  // Every send is best-effort: an extension reload invalidates this context and
  // sendMessage throws. Quietly resolving to null keeps the page clean.
  function send(msg) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return Promise.resolve(null);
      const p = chrome.runtime.sendMessage(msg);
      return p && typeof p.catch === "function" ? p.catch(() => null) : Promise.resolve(null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg.t !== "string" || msg.t.lastIndexOf("vi:", 0) !== 0) return;
      if (msg.t === "vi:started") setLive(true);
      else if (msg.t === "vi:result") insertText(msg.text || "");
      else if (msg.t === "vi:ended") setLive(false);
      else if (msg.t === "vi:error") onError(msg.error);
    });
  } catch (_) {
    /* no messaging in this context — the button simply never appears */
  }

  // Every failure ends the same way: stop, say two words, stay quiet.
  function onError(code) {
    setLive(false);
    if (code === "not-allowed" || code === "service-not-allowed") {
      flash("Allow mic in Sharon");
      send({ t: "vi:open-panel" }); // Sharon asks for the mic — we never do
    } else if (code === "no-speech" || code === "aborted") {
      flash("Didn't catch that");
    } else {
      flash("Voice input unavailable");
    }
  }

  /* ---------------------------------------------------------------- *
   * What counts as an editable field
   * ---------------------------------------------------------------- */
  function editableKind(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.disabled || el.readOnly) return "";
    const tag = el.tagName;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "password") return ""; // never, under any circumstances
      return TEXT_TYPES.has(type) ? "input" : "";
    }
    if (tag === "TEXTAREA") return "input";
    // Rich text: the element itself, or the contenteditable="true" host it sits in.
    if (el.isContentEditable && el.closest && el.closest('[contenteditable="true"]')) return "rich";
    return "";
  }

  /* ---------------------------------------------------------------- *
   * The button (inside a shadow root)
   * ---------------------------------------------------------------- */
  const MIC_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/>' +
    '<path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>';

  function buildHost() {
    if (host) return true;
    try {
      host = document.createElement("div");
      host.setAttribute("data-sharon-vi", "host");
      // The host itself carries only placement; everything else is shadowed.
      host.style.cssText =
        "position:fixed;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;" +
        "z-index:2147483647;pointer-events:none;";
      shadow = host.attachShadow({ mode: "closed" });

      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("voice-input/overlay.css");
      shadow.appendChild(link);

      const wrap = document.createElement("div");
      wrap.className = "sharon-vi-wrap";

      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sharon-vi-btn";
      btn.setAttribute("aria-label", "Start voice input");
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML = MIC_SVG;

      msgEl = document.createElement("span");
      msgEl.className = "sharon-vi-msg";
      msgEl.setAttribute("role", "status");

      wrap.appendChild(msgEl);
      wrap.appendChild(btn);
      shadow.appendChild(wrap);

      // Pressing the button must NOT move focus out of the field — otherwise
      // the field blurs, we detach, and the tap dictates into nothing.
      btn.addEventListener("pointerdown", (e) => e.preventDefault());
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", onButtonClick);

      (document.documentElement || document.body).appendChild(host);
      return true;
    } catch (_) {
      host = null;
      shadow = null;
      btn = null;
      return false;
    }
  }

  function setLive(on) {
    live = !!on;
    if (!btn) return;
    btn.classList.toggle("is-live", live);
    btn.setAttribute("aria-pressed", live ? "true" : "false");
    btn.setAttribute("aria-label", live ? "Stop voice input" : "Start voice input");
    if (live) flash(""); // a live mic replaces whatever the last message was
  }

  function flash(text) {
    if (!msgEl) return;
    if (msgTimer) {
      clearTimeout(msgTimer);
      msgTimer = null;
    }
    msgEl.textContent = text || "";
    msgEl.classList.toggle("is-on", !!text);
    if (text) {
      msgTimer = setTimeout(() => {
        msgTimer = null;
        if (!msgEl) return;
        msgEl.textContent = "";
        msgEl.classList.remove("is-on");
      }, MSG_MS);
    }
  }

  async function onButtonClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!field || !field.isConnected) return;
    if (live) {
      setLive(false);
      send({ t: "vi:stop" });
      return;
    }
    syncCaret(); // dictation begins exactly where the cursor is sitting now
    const res = await send({ t: "vi:start" });
    if (!res || !res.ok) {
      const reason = res && res.reason;
      // Sharon is mid-recording: refuse, say so for two seconds, do nothing else.
      if (reason === "busy") flash("Busy recording");
      else if (reason === "mic") {
        flash("Allow mic in Sharon");
        send({ t: "vi:open-panel" });
      } else if (reason !== "silent") {
        // "silent" means a vi:error already put a message on the button.
        flash("Voice input unavailable");
      }
      return;
    }
    setLive(true); // the recognizer confirms with vi:started; this is instant feedback
  }

  /* ---------------------------------------------------------------- *
   * Attach / place / detach
   * ---------------------------------------------------------------- */
  function attach(el, k) {
    if (field === el) return;
    detach();
    if (!buildHost()) return;
    field = el;
    kind = k;
    setLive(false);
    flash("");
    host.style.display = "block";
    place();
    syncCaret(); // start from wherever the user's cursor actually is

    // The only things allowed to move the insertion point are the user's own
    // hands. Everything else — re-renders, editor housekeeping — is ignored.
    for (const ev of CARET_EVENTS) field.addEventListener(ev, onUserCaret, true);

    try {
      if (window.ResizeObserver) {
        ro = new ResizeObserver(() => place());
        ro.observe(field);
      }
    } catch (_) {
      ro = null;
    }
    // Fields can be removed, hidden or moved with no event of their own.
    watchTimer = setInterval(() => {
      if (!field || !field.isConnected) detach();
      else place();
    }, 600);
  }

  function detach() {
    if (live) {
      setLive(false);
      send({ t: "vi:stop" });
    }
    if (field) {
      for (const ev of CARET_EVENTS) {
        try {
          field.removeEventListener(ev, onUserCaret, true);
        } catch (_) {
          /* ignore */
        }
      }
    }
    caret = null;
    caretRange = null;
    field = null;
    kind = "";
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    if (ro) {
      try {
        ro.disconnect();
      } catch (_) {
        /* ignore */
      }
      ro = null;
    }
    if (host) host.style.display = "none";
    flash("");
  }

  function place() {
    if (!field || !host) return;
    let r;
    try {
      r = field.getBoundingClientRect();
    } catch (_) {
      return;
    }
    // Too small to decorate, or scrolled out of sight → hide, don't detach.
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const offscreen =
      r.width < MIN_W || r.height < MIN_H || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw;
    host.style.visibility = offscreen ? "hidden" : "visible";
    if (offscreen) return;

    const left = Math.round(r.right - BTN_SIZE - EDGE_GAP);
    // Tall fields (a textarea, a Gmail body) get the button near the top edge;
    // single-line fields get it centred.
    const top = Math.round(r.height > 60 ? r.top + EDGE_GAP : r.top + (r.height - BTN_SIZE) / 2);
    host.style.transform = "translate(" + left + "px," + top + "px)";
  }

  function schedulePlace() {
    if (placing || !field) return;
    placing = true;
    requestAnimationFrame(() => {
      placing = false;
      place();
    });
  }

  /* ---------------------------------------------------------------- *
   * The insertion point — the caret THIS MODULE owns
   *
   * Dictation has to read left to right, every time. The page's own caret
   * cannot be trusted to stay where the last phrase finished: a React
   * re-render puts it back at 0, an unfocused <input> reports 0, and rich
   * editors move it whenever they normalize their markup. Reading it fresh
   * for each phrase is what makes words land out of order.
   *
   * So the insertion point belongs to this module for the length of a
   * dictation: it starts wherever the user's cursor was, advances by exactly
   * the characters we typed, and is re-synced ONLY when the user themselves
   * moves it — a click, a key, a selection. Nothing the page does in between
   * can shuffle the words.
   * ---------------------------------------------------------------- */
  let caret = null; // { start, end } — for input / textarea
  let caretRange = null; // a collapsed Range — for contenteditable

  // The user moved the cursor themselves → that is the new insertion point.
  // Our own writes are ignored: after a write the live selection already IS
  // our caret, so this sees nothing to change.
  function onUserCaret() {
    if (!field) return;
    try {
      if (kind === "input") {
        const len = (field.value || "").length;
        let s = typeof field.selectionStart === "number" ? field.selectionStart : len;
        let e = typeof field.selectionEnd === "number" ? field.selectionEnd : s;
        if (s > e) {
          const t = s;
          s = e;
          e = t;
        }
        if (caret && caret.start === s && caret.end === e) return; // where we left it
        caret = { start: s, end: e };
      } else {
        const r = liveRange();
        if (r) caretRange = r;
      }
    } catch (_) {
      /* keep the caret we have */
    }
  }

  // The page's live selection, but only if it is genuinely inside our field.
  function liveRange() {
    try {
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        if (field.contains(r.commonAncestorContainer)) return r.cloneRange();
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function endRange() {
    const r = document.createRange();
    r.selectNodeContents(field);
    r.collapse(false); // the very end of the field
    return r;
  }

  function usableRange(r) {
    try {
      return !!(r && r.startContainer && r.startContainer.isConnected && field.contains(r.startContainer));
    } catch (_) {
      return false;
    }
  }

  // Dictation types into the field the user is looking at, so keep the focus
  // there: it is what makes React restore the caret correctly, and what makes
  // editors treat the text as typed rather than pasted from nowhere.
  function refocus() {
    try {
      if (document.activeElement !== field) field.focus({ preventScroll: true });
    } catch (_) {
      /* some fields refuse focus — the insertion still works */
    }
  }

  /* ---------------------------------------------------------------- *
   * Spacing — the difference between dictation and a ransom note
   * ---------------------------------------------------------------- */
  // Email and URL boxes hold one unbroken token: no sentence case there.
  function plainToken() {
    if (kind !== "input" || field.tagName !== "INPUT") return false;
    const type = (field.getAttribute("type") || "text").toLowerCase();
    return type === "email" || type === "url";
  }

  // Join one spoken phrase to the words already around it, the way a person
  // typing would: exactly one space between words, never a space before
  // punctuation or after an opening bracket, a capital at the start of a
  // sentence, and one space kept in front of whatever follows the cursor.
  function join(before, after, raw) {
    let t = String(raw == null ? "" : raw)
      .replace(/\s+/g, " ")
      .trim();
    if (!t) return "";

    const tail = before.slice(-1);
    const tightAfter = /[([{“‘"'\/@#$\-–—_]/.test(tail); // "(" — no space after
    const tightBefore = /^[.,!?;:%)\]}…"'’”]/.test(t); // "," — no space before
    const lead = before && !/\s/.test(tail) && !tightAfter && !tightBefore ? " " : "";

    // Sentence case: the first words in the field, and every phrase that
    // follows a finished sentence.
    if (!plainToken() && (!before.trim() || /[.!?…]["'’”)\]]?\s*$/.test(before))) {
      t = t.charAt(0).toUpperCase() + t.slice(1);
    }

    // Dictating into the middle of a line keeps a space in front of the rest.
    const next = after.charAt(0);
    const trail = next && !/\s/.test(next) && !/[.,!?;:%)\]}…]/.test(next) ? " " : "";

    return lead + t + trail;
  }

  /* ---------------------------------------------------------------- *
   * Typing the words in
   * ---------------------------------------------------------------- */
  // React keeps its own copy of an input's value; assigning through the native
  // setter is what makes it notice the change. Falls back to a plain assignment.
  function setNativeValue(el, value) {
    try {
      const proto =
        el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) {
        desc.set.call(el, value);
        return;
      }
    } catch (_) {
      /* fall through */
    }
    el.value = value;
  }

  function insertText(text) {
    if (!field || !field.isConnected || !text) return;
    try {
      if (kind === "input") insertIntoInput(text);
      else insertIntoRich(text);
    } catch (_) {
      return; // fail quietly — never a console full of stack traces
    }
    // React, Vue and Gmail ignore text that arrives without these. Both, always.
    try {
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (_) {
      /* ignore */
    }
  }

  function insertIntoInput(text) {
    refocus();
    const value = field.value || "";
    if (!caret) syncCaret();
    const start = Math.max(0, Math.min(caret ? caret.start : value.length, value.length));
    const end = Math.max(start, Math.min(caret ? caret.end : start, value.length));
    const before = value.slice(0, start);
    const after = value.slice(end);
    const chunk = join(before, after, text);
    if (!chunk) return;

    // Select what we're replacing first, so a framework that snapshots the
    // selection around its own update sees the same edit a typist would make.
    try {
      field.setSelectionRange(start, end);
    } catch (_) {
      /* some input types don't support selection ranges */
    }
    setNativeValue(field, before + chunk + after);

    const at = start + chunk.length;
    caret = { start: at, end: at }; // ours — the next phrase continues from here
    try {
      field.setSelectionRange(at, at);
    } catch (_) {
      /* ignore */
    }
  }

  function insertIntoRich(text) {
    refocus();
    if (!usableRange(caretRange)) caretRange = liveRange() || endRange();
    const range = caretRange;
    const before = textBefore(range);
    const after = textAfter(range);
    const chunk = join(before, after, text);
    if (!chunk) return;

    range.deleteContents();
    const node = document.createTextNode(chunk);
    range.insertNode(node);

    // Park the caret immediately after what we just typed — both ours and the
    // page's, so the two never disagree about where the next phrase goes.
    const out = document.createRange();
    out.setStartAfter(node);
    out.collapse(true);
    caretRange = out.cloneRange();
    try {
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(out);
      }
    } catch (_) {
      /* the editor manages its own selection — our own copy still holds */
    }
  }

  // The text on either side of the insertion point, for the spacing rules.
  // Only the nearest few hundred characters matter, and rich fields can be
  // enormous, so both are clipped.
  function textBefore(range) {
    try {
      const r = document.createRange();
      r.selectNodeContents(field);
      r.setEnd(range.startContainer, range.startOffset);
      return r.toString().slice(-400);
    } catch (_) {
      return "";
    }
  }

  function textAfter(range) {
    try {
      const r = document.createRange();
      r.selectNodeContents(field);
      r.setStart(range.endContainer, range.endOffset);
      return r.toString().slice(0, 40);
    } catch (_) {
      return "";
    }
  }

  // Take the cursor as it stands right now (on attach, and when dictation
  // starts) — from there on it is ours.
  function syncCaret() {
    caret = null;
    caretRange = null;
    if (!field) return;
    if (kind === "input") {
      const len = (field.value || "").length;
      let s = typeof field.selectionStart === "number" ? field.selectionStart : len;
      let e = typeof field.selectionEnd === "number" ? field.selectionEnd : s;
      if (s > e) {
        const t = s;
        s = e;
        e = t;
      }
      caret = { start: Math.min(s, len), end: Math.min(e, len) };
    } else {
      caretRange = liveRange() || endRange();
    }
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */
  function onFocusIn(e) {
    const el = e && e.target;
    const k = editableKind(el);
    if (k) attach(el, k);
    else if (field) detach(); // focus moved to something that isn't editable
  }

  function onFocusOut(e) {
    if (!field) return;
    if (e && e.target !== field) return;
    detach();
  }

  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  window.addEventListener("scroll", schedulePlace, true);
  window.addEventListener("resize", schedulePlace, true);
  window.addEventListener("pagehide", () => detach());

  // The page may already have a field focused when this script loads.
  try {
    const active = document.activeElement;
    const k = editableKind(active);
    if (k) attach(active, k);
  } catch (_) {
    /* nothing focused yet — the first focusin will do it */
  }
})();
