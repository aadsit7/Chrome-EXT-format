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

  // A spoken phrase joins what's already there like a human would type it.
  function spaced(before, text) {
    const t = String(text || "").trim();
    if (!t) return "";
    if (!before) return t;
    const last = before.slice(-1);
    if (/\s/.test(last)) return t;
    if (/^[.,!?;:)\]]/.test(t)) return t;
    return " " + t;
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
    const value = field.value || "";
    let start = typeof field.selectionStart === "number" ? field.selectionStart : value.length;
    let end = typeof field.selectionEnd === "number" ? field.selectionEnd : start;
    if (start > end) {
      const s = start;
      start = end;
      end = s;
    }
    const before = value.slice(0, start);
    const after = value.slice(end);
    const chunk = spaced(before, text);
    setNativeValue(field, before + chunk + after);
    const caret = start + chunk.length;
    try {
      field.setSelectionRange(caret, caret);
    } catch (_) {
      /* some input types don't support selection ranges */
    }
  }

  function insertIntoRich(text) {
    const sel = window.getSelection ? window.getSelection() : null;
    let range = null;
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (field.contains(r.commonAncestorContainer)) range = r;
    }
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(field);
      range.collapse(false); // no live cursor → append at the end
    }
    const before = (range.startContainer.textContent || "").slice(0, range.startOffset);
    const chunk = spaced(before, text);
    range.deleteContents();
    const node = document.createTextNode(chunk);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
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
