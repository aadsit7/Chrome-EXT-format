// page.js — everything Sharon knows about, and does to, the active tab:
// reading what's on screen, scrolling, and the injected click/type engine.
// The injected functions (extractPageText, scrollPage, collectInteractive,
// doActions) are self-contained — they run inside the page, never here.

import { PAGE_EXCERPT_CHARS } from "./config.js";

// A tab is restricted only when its URL starts with one of these. Any normal
// http:// or https:// website is ALWAYS readable.
const RESTRICTED_PREFIXES = [
  "chrome://",
  "edge://",
  "about:",
  "chrome-extension://",
  "devtools://",
];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (_) {
    return null;
  }
}

export async function getActiveTabReady() {
  let tab = await getActiveTab();
  for (let i = 0; i < 6 && (!tab || !tab.url); i++) {
    await delay(180);
    tab = await getActiveTab();
  }
  return tab;
}

export function isRestricted(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  if (RESTRICTED_PREFIXES.some((p) => lower.startsWith(p))) return true;
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return true;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  if (host === "chromewebstore.google.com") return true;
  if (host === "chrome.google.com" && path.startsWith("/webstore")) return true;
  if (host === "microsoftedge.microsoft.com" && path.startsWith("/addons")) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Injected: extract the readable text of the page
 * ------------------------------------------------------------------ */
function extractPageText() {
  function collapse(s) {
    return s
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n[ \t]*\n[ \t]*(\n[ \t]*)+/g, "\n\n")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .trim();
  }

  const EXCLUDE_TAGS = {
    NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1,
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1,
    SVG: 1, CANVAS: 1, FORM: 1, BUTTON: 1, INPUT: 1,
    SELECT: 1, TEXTAREA: 1, LABEL: 1, IFRAME: 1,
  };
  const BLOCK_TAGS = {
    P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, LI: 1, UL: 1, OL: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BLOCKQUOTE: 1, PRE: 1,
    TABLE: 1, TR: 1, FIGURE: 1, FIGCAPTION: 1, DD: 1, DT: 1, DL: 1, HR: 1,
  };
  const BOILERPLATE =
    /(^|[-_ ])(ads?|advert|advertisement|advertising|doubleclick|dfp|cookie|consent|gdpr|newsletter|subscribe|signup|sign-up|paywall|sponsored|promo|promotion|banner|related|recirc|recommended|recommendation|comments?|disqus|livefyre|share|sharing|social|breadcrumb|breadcrumbs|pagination|sidebar|popup|modal|overlay|cta|read-more|more-stories|trending|outbrain|taboola|navbar|navigation|menu|submenu|masthead|footer|topbar|skip-link|skip-to|widget|toolbar)([-_ ]|$)/i;
  const SKIP_ROLES =
    /^(navigation|banner|complementary|contentinfo|search|menu|menubar|tablist|dialog|alertdialog|toolbar)$/i;

  function isHidden(el) {
    let style;
    try {
      style = window.getComputedStyle(el);
    } catch (_) {
      return false;
    }
    if (!style) return false;
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return true;
    if (parseFloat(style.opacity) === 0) return true;
    if (el.hidden) return true;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return true;
    return false;
  }

  function shouldSkip(el) {
    if (EXCLUDE_TAGS[el.tagName]) return true;
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    if (role && SKIP_ROLES.test(role)) return true;
    const id = el.id || "";
    const cls = (el.getAttribute && el.getAttribute("class")) || "";
    const aria = (el.getAttribute && el.getAttribute("aria-label")) || "";
    if (BOILERPLATE.test(id + " " + cls + " " + aria)) return true;
    if (isHidden(el)) return true;
    return false;
  }

  function roleOf(el) {
    return ((el.getAttribute && el.getAttribute("role")) || "").toLowerCase();
  }

  function headingLevel(el) {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) return +tag[1];
    if (roleOf(el) === "heading") {
      const lv = parseInt(el.getAttribute("aria-level") || "2", 10);
      return Number.isNaN(lv) ? 2 : Math.min(6, Math.max(1, lv));
    }
    return 0;
  }

  function isTable(el) {
    const r = roleOf(el);
    return el.tagName === "TABLE" || r === "table" || r === "grid";
  }

  function flatten(node) {
    let out = "";
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === 3) {
        out += c.nodeValue;
      } else if (c.nodeType === 1) {
        if (c.tagName === "BR") {
          out += " ";
          continue;
        }
        if (shouldSkip(c)) continue;
        out += " " + flatten(c) + " ";
      }
    }
    return out;
  }
  function inline(node) {
    return flatten(node).replace(/\s+/g, " ").trim();
  }

  function serializeTable(table) {
    const rows = [];
    const trs = table.querySelectorAll('tr, [role="row"]');
    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i];
      if (shouldSkip(tr)) continue;
      const cells = tr.querySelectorAll(
        'th, td, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]'
      );
      const vals = [];
      for (let j = 0; j < cells.length; j++) {
        if (shouldSkip(cells[j])) continue;
        vals.push(inline(cells[j]));
      }
      if (vals.length) rows.push(vals.join(" | "));
      else {
        const t = inline(tr);
        if (t) rows.push(t);
      }
    }
    return rows.length ? "\n" + rows.join("\n") + "\n" : "";
  }

  function gather(node) {
    let out = "";
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child.nodeType === 3) {
        out += child.nodeValue;
      } else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (tag === "BR") {
          out += "\n";
          continue;
        }
        if (shouldSkip(child)) continue;

        const hl = headingLevel(child);
        if (hl) {
          const h = inline(child);
          if (h) out += "\n\n" + "######".slice(0, hl) + " " + h + "\n";
          continue;
        }
        if (isTable(child)) {
          out += serializeTable(child);
          continue;
        }
        if (tag === "LI" || roleOf(child) === "listitem") {
          const li = inline(child);
          if (li) out += "\n- " + li;
          continue;
        }

        const inner = gather(child);
        if (BLOCK_TAGS[tag]) out += "\n" + inner + "\n";
        else out += inner;
      }
    }
    return out;
  }

  function metaContent(sel) {
    const m = document.querySelector(sel);
    const c = m && m.getAttribute && m.getAttribute("content");
    return c ? c.trim() : "";
  }

  function bestRegion(selectors) {
    let bestEl = null;
    let bestText = "";
    for (let s = 0; s < selectors.length; s++) {
      const nodes = document.querySelectorAll(selectors[s]);
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (isHidden(el)) continue;
        const t = collapse(gather(el));
        if (t.length > bestText.length) {
          bestEl = el;
          bestText = t;
        }
      }
    }
    return { el: bestEl, text: bestText };
  }

  function pickMain() {
    const focused = bestRegion([
      '[itemprop="articleBody"]',
      '[role="document"]',
      ".a3s",
      ".message-body",
      ".messageBody",
      ".email-body",
      ".mail-body",
    ]);
    if (focused.el && focused.text.length >= 200) return focused;

    const region = bestRegion([
      "article",
      '[role="article"]',
      "main",
      '[role="main"]',
    ]);
    if (region.el && region.text.length >= 80) return region;

    if (focused.el && focused.text.length >= 80) return focused;

    return { el: document.body, text: collapse(gather(document.body)) };
  }

  const picked = pickMain();
  const main = picked.el || document.body;

  const h1 =
    (main && main.querySelector && main.querySelector("h1")) ||
    document.querySelector("h1");
  const h1text = h1 ? (h1.innerText || h1.textContent || "").trim() : "";
  const title =
    h1text ||
    metaContent('meta[property="og:title"]') ||
    (document.title || "").trim();

  const sel = window.getSelection ? window.getSelection().toString().trim() : "";
  if (sel) {
    return { text: collapse(sel), title: title, url: location.href };
  }

  let text = picked.text || "";

  if (text.length < 200) {
    const bodyText = collapse((document.body && document.body.innerText) || "");
    if (bodyText.length > text.length * 1.5) text = bodyText;
  }

  return { text: text, title: title, url: location.href };
}

/* ------------------------------------------------------------------ *
 * Injected: scroll the page (main document or the dominant inner pane)
 * ------------------------------------------------------------------ */
function scrollPage(opts) {
  var dir = (opts && opts.direction) || "down";

  function docScrollMax() {
    var de = document.documentElement;
    return Math.max((de ? de.scrollHeight : 0) - window.innerHeight, 0);
  }

  function findScroller() {
    var best = null;
    var bestAmt = 0;
    var all = document.querySelectorAll("div, main, section, ul, ol");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var style;
      try {
        style = window.getComputedStyle(el);
      } catch (_) {
        continue;
      }
      var oy = style.overflowY;
      if (oy !== "auto" && oy !== "scroll") continue;
      if (el.clientHeight < 120) continue;
      var amt = el.scrollHeight - el.clientHeight;
      if (amt <= 40) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (amt > bestAmt) {
        best = el;
        bestAmt = amt;
      }
    }
    return best;
  }

  var docMax = docScrollMax();
  var scroller = docMax > 40 ? null : findScroller();

  function curTop() {
    if (scroller) return scroller.scrollTop;
    return window.scrollY || document.documentElement.scrollTop || 0;
  }
  function maxTop() {
    if (scroller) return scroller.scrollHeight - scroller.clientHeight;
    return docMax;
  }
  function viewport() {
    return scroller ? scroller.clientHeight : window.innerHeight;
  }

  var max = maxTop();
  var before = curTop();
  var step = Math.max(Math.round(viewport() * 0.85), 200);

  var target = before;
  if (dir === "top") target = 0;
  else if (dir === "bottom") target = max;
  else if (dir === "up") target = before - step;
  else target = before + step;

  if (target < 0) target = 0;
  if (target > max) target = max;

  if (scroller) scroller.scrollTo({ top: target, behavior: "smooth" });
  else window.scrollTo({ top: target, behavior: "smooth" });

  return {
    hasScroll: max > 40,
    moved: Math.abs(target - before) > 2,
    atTop: target <= 1,
    atBottom: target >= max - 1,
  };
}

/* ------------------------------------------------------------------ *
 * Injected: collect the interactive elements (for the acting agent)
 * ------------------------------------------------------------------ */
function collectInteractive(opts) {
  var MAX = (opts && opts.max) || 120;

  function visible(el) {
    var s;
    try {
      s = window.getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (!s || s.display === "none" || s.visibility === "hidden") return false;
    if (parseFloat(s.opacity) === 0) return false;
    if (el.disabled) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    if (r.bottom < -200 || r.top > (window.innerHeight || 0) + 3000) return false;
    return true;
  }

  function esc(id) {
    try {
      return window.CSS && CSS.escape ? CSS.escape(id) : id;
    } catch (e) {
      return id;
    }
  }

  function nameOf(el) {
    var n = (el.getAttribute && el.getAttribute("aria-label")) || "";
    if (!n && el.getAttribute) {
      var lb = el.getAttribute("aria-labelledby");
      if (lb) {
        n = lb
          .split(/\s+/)
          .map(function (id) {
            var e = document.getElementById(id);
            return e ? e.innerText || e.textContent || "" : "";
          })
          .join(" ");
      }
    }
    if (!n && el.id) {
      var lab = document.querySelector('label[for="' + esc(el.id) + '"]');
      if (lab) n = lab.innerText || lab.textContent || "";
    }
    if (!n && el.closest) {
      var pl = el.closest("label");
      if (pl) n = pl.innerText || pl.textContent || "";
    }
    if (!n && el.getAttribute) n = el.getAttribute("placeholder") || "";
    if (!n && el.getAttribute) n = el.getAttribute("title") || "";
    if (!n && el.getAttribute) n = el.getAttribute("alt") || "";
    if (!n && typeof el.value === "string") n = el.value;
    if (!n) n = el.innerText || el.textContent || "";
    return (n || "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  var sel =
    'a[href], button, input, textarea, select, [role="button"], [role="link"], ' +
    '[role="textbox"], [role="checkbox"], [role="radio"], [role="tab"], ' +
    '[role="menuitem"], [contenteditable=""], [contenteditable="true"]';
  var nodes = document.querySelectorAll(sel);
  var out = [];
  var idx = 0;

  for (var i = 0; i < nodes.length && out.length < MAX; i++) {
    var el = nodes[i];
    var tag = el.tagName;
    var inputType =
      tag === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : "";
    if (inputType === "hidden") continue;
    if (!visible(el)) continue;

    idx++;
    el.setAttribute("data-sharon-id", String(idx));

    var role = ((el.getAttribute && el.getAttribute("role")) || "").toLowerCase();
    var kind = "other";
    var value = "";
    if (tag === "A" || role === "link") kind = "link";
    else if (tag === "BUTTON" || role === "button" || role === "tab" || role === "menuitem")
      kind = "button";
    else if (tag === "TEXTAREA" || el.isContentEditable || role === "textbox")
      kind = "textbox";
    else if (tag === "SELECT") kind = "select";
    else if (tag === "INPUT") {
      if (inputType === "checkbox") {
        kind = "checkbox";
        value = el.checked ? "checked" : "unchecked";
      } else if (inputType === "radio") {
        kind = "radio";
        value = el.checked ? "selected" : "not selected";
      } else if (inputType === "submit" || inputType === "button") {
        kind = "button";
      } else if (inputType === "password") {
        kind = "password";
      } else {
        kind = "textbox";
      }
    }
    if (kind === "textbox" && !value) {
      var v = el.isContentEditable ? el.innerText || "" : el.value || "";
      value = v ? "has text" : "empty";
    }

    out.push({ id: idx, kind: kind, name: nameOf(el), value: value });
  }

  return { elements: out };
}

/* ------------------------------------------------------------------ *
 * Injected: perform a batch of actions (click / type / select / …)
 * ------------------------------------------------------------------ */
function doActions(opts) {
  var actions = (opts && opts.actions) || [];

  function byId(id) {
    return document.querySelector('[data-sharon-id="' + id + '"]');
  }
  function ev(type, init) {
    if (type.indexOf("key") === 0) return new KeyboardEvent(type, init);
    if (type === "click" || type.indexOf("mouse") === 0)
      return new MouseEvent(type, init);
    return new Event(type, init);
  }
  function fire(el, type, init) {
    el.dispatchEvent(ev(type, Object.assign({ bubbles: true, cancelable: true }, init || {})));
  }
  function setValue(el, val) {
    var proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, val);
    else el.value = val;
  }

  var results = [];
  for (var i = 0; i < actions.length; i++) {
    var a = actions[i] || {};
    var r = { type: a.type, ok: false };
    try {
      if (a.type === "scroll") {
        var amt = Math.round((window.innerHeight || 600) * 0.85);
        if (a.direction === "up") window.scrollBy({ top: -amt, behavior: "smooth" });
        else if (a.direction === "top") window.scrollTo({ top: 0, behavior: "smooth" });
        else if (a.direction === "bottom")
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
        else window.scrollBy({ top: amt, behavior: "smooth" });
        r.ok = true;
        results.push(r);
        continue;
      }
      if (a.type === "key") {
        var tgt = document.activeElement || document.body;
        var k = a.key || "Enter";
        fire(tgt, "keydown", { key: k });
        fire(tgt, "keypress", { key: k });
        fire(tgt, "keyup", { key: k });
        r.ok = true;
        results.push(r);
        continue;
      }

      var el = a.id != null ? byId(a.id) : null;
      if (!el) {
        r.error = "no element " + a.id;
        results.push(r);
        continue;
      }
      try {
        el.scrollIntoView({ block: "center" });
      } catch (e) {
        /* ignore */
      }

      if (a.type === "click") {
        fire(el, "mousedown");
        fire(el, "mouseup");
        if (typeof el.click === "function") el.click();
        else fire(el, "click");
        r.ok = true;
      } else if (a.type === "type") {
        var text = a.text || "";
        el.focus();
        if (el.isContentEditable) {
          if (!a.append) el.textContent = "";
          var ok = false;
          try {
            ok = document.execCommand && document.execCommand("insertText", false, text);
          } catch (e) {
            ok = false;
          }
          if (!ok && el.textContent.indexOf(text) < 0)
            el.textContent = (a.append ? el.textContent : "") + text;
          fire(el, "input");
          r.value = el.textContent;
        } else {
          setValue(el, (a.append ? el.value || "" : "") + text);
          fire(el, "input");
          fire(el, "change");
          r.value = el.value;
        }
        r.ok = true;
      } else if (a.type === "clear") {
        if (el.isContentEditable) el.textContent = "";
        else setValue(el, "");
        fire(el, "input");
        fire(el, "change");
        r.ok = true;
      } else if (a.type === "select") {
        var want = (a.option || a.text || "").toLowerCase();
        var done = false;
        if (el.options) {
          for (var j = 0; j < el.options.length; j++) {
            var o = el.options[j];
            var ot = (o.textContent || "").trim().toLowerCase();
            if (ot === want || (o.value || "").toLowerCase() === want) {
              el.selectedIndex = j;
              done = true;
              break;
            }
          }
          if (!done) {
            for (var m = 0; m < el.options.length; m++) {
              if ((el.options[m].textContent || "").toLowerCase().indexOf(want) >= 0) {
                el.selectedIndex = m;
                done = true;
                break;
              }
            }
          }
        }
        fire(el, "input");
        fire(el, "change");
        r.ok = done;
        if (!done) r.error = "no matching option";
      } else {
        r.error = "unknown action";
      }
    } catch (e) {
      r.error = String((e && e.message) || e);
    }
    results.push(r);
  }
  return { results: results };
}

/* ------------------------------------------------------------------ *
 * Public API — with a short-lived snapshot cache so back-to-back turns
 * about the same unchanged page don't pay the extraction cost twice.
 * ------------------------------------------------------------------ */
let snapshot = null; // { key, at, ctx }
const SNAPSHOT_TTL_MS = 4000;

export function invalidatePageCache() {
  snapshot = null;
}

export async function readPageContext({ fresh = false } = {}) {
  const tab = await getActiveTab();
  if (!tab || !tab.id || isRestricted(tab.url)) {
    return { restricted: true };
  }
  const key = tab.id + "::" + tab.url;
  if (!fresh && snapshot && snapshot.key === key && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) {
    return snapshot.ctx;
  }
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageText,
    });
    const result = (injection && injection.result) || {};
    let text = result.text || "";
    if (text.length > PAGE_EXCERPT_CHARS) text = text.slice(0, PAGE_EXCERPT_CHARS);
    const ctx = {
      text,
      title: result.title || tab.title || "",
      url: result.url || tab.url || "",
    };
    snapshot = { key, at: Date.now(), ctx };
    return ctx;
  } catch (_) {
    return { restricted: true };
  }
}

export async function scrollActiveTab(direction) {
  const tab = await getActiveTab();
  if (!tab || !tab.id || isRestricted(tab.url)) return { noTab: true };
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollPage,
      args: [{ direction }],
    });
    invalidatePageCache();
    return (injection && injection.result) || {};
  } catch (_) {
    return { failed: true };
  }
}

export async function extractElements() {
  const tab = await getActiveTab();
  if (!tab || !tab.id || isRestricted(tab.url)) return [];
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectInteractive,
      args: [{ max: 120 }],
    });
    return (inj && inj.result && inj.result.elements) || [];
  } catch (_) {
    return [];
  }
}

export function elementsToText(list) {
  if (!list.length) return "(no interactive elements detected)";
  return list
    .map(
      (e) =>
        "[" + e.id + "] " + e.kind +
        (e.name ? ' "' + e.name + '"' : "") +
        (e.value ? " (" + e.value + ")" : "")
    )
    .join("\n");
}

export async function runActions(actions) {
  const tab = await getActiveTab();
  if (!tab || !tab.id || isRestricted(tab.url)) {
    return { results: [{ ok: false, error: "no actionable tab" }], noTab: true };
  }
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: doActions,
      args: [{ actions }],
    });
    invalidatePageCache();
    return (inj && inj.result) || { results: [] };
  } catch (e) {
    return { results: [{ ok: false, error: String((e && e.message) || e) }] };
  }
}

export function describePlan(actions, list) {
  const nameById = {};
  for (const e of list) nameById[e.id] = e.name;
  const parts = [];
  for (const a of actions) {
    const who = a.id != null && nameById[a.id] ? ' "' + nameById[a.id] + '"' : "";
    if (a.type === "click") parts.push("click" + who);
    else if (a.type === "type") parts.push("type into" + who);
    else if (a.type === "clear") parts.push("clear" + who);
    else if (a.type === "select") parts.push("choose " + (a.option || a.text || "") + who);
    else if (a.type === "key") parts.push("press " + (a.key || "Enter"));
    else if (a.type === "scroll") parts.push("scroll " + (a.direction || "down"));
  }
  return parts.join(", then ");
}
