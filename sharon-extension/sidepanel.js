// sidepanel.js — Sharon's brains: follow the active tab, read it aloud,
// and let the user talk to her at any time through one microphone.

import { PROXY_URL, MAX_PAGE_TEXT } from "./config.js";

/* ------------------------------------------------------------------ *
 * Element references
 * ------------------------------------------------------------------ */
const els = {
  html: document.documentElement,
  status: document.getElementById("status"),
  tabTitle: document.getElementById("tabTitle"),
  tabSite: document.getElementById("tabSite"),
  conversation: document.getElementById("conversation"),
  welcome: document.getElementById("welcome"),
  micBtn: document.getElementById("micBtn"),
  aloudBtn: document.getElementById("aloudBtn"),
  // Settings
  settingsBtn: document.getElementById("settingsBtn"),
  settings: document.getElementById("settings"),
  settingsBack: document.getElementById("settingsBack"),
  autoReadToggle: document.getElementById("autoReadToggle"),
  scrollToggle: document.getElementById("scrollToggle"),
  actionsToggle: document.getElementById("actionsToggle"),
  confirmToggle: document.getElementById("confirmToggle"),
  shortcutValue: document.getElementById("shortcutValue"),
  changeShortcut: document.getElementById("changeShortcut"),
};

// Grounding rules sent with EVERY request. Sharon is a read-only voice
// assistant for whatever is visible on the current tab right now: she uses only
// the extracted page text, never invents anything, and can't click or open
// things herself. (The networking is unchanged — this just shapes the
// instruction text we already send in the request body.)
const GROUNDING =
  "You are Sharon, a read-only voice assistant. The only thing you can see is " +
  "the text currently visible on the user's active browser tab, given to you " +
  "below as the page content. Follow these rules strictly:\n" +
  "1. Use ONLY that page content. Do not use outside knowledge to fill gaps.\n" +
  "2. Talk only about what is actually in the page content. Never invent, " +
  "guess, or assume anything that isn't there.\n" +
  "3. You cannot click, open, or navigate to other pages, and you only ever " +
  "see the text currently extracted from the tab. You CAN scroll this page " +
  "when the user asks — they can say \"scroll down\", \"scroll up\", \"go to " +
  "the top/bottom\", or \"read more\" and the app scrolls and then gives you " +
  "the newly visible text to read. If the user asks about something that isn't " +
  "in the page content — for example what's inside an email while only a list " +
  "of messages is visible — say plainly what you can see and offer to scroll " +
  "for more or ask them to open it themselves, for example: \"I can see your " +
  "list of messages but not what's inside them. Open the one you want, or ask " +
  "me to scroll, and I'll read it.\"\n" +
  "4. If the answer isn't in the page content, say so plainly instead of " +
  "making something up. Honesty over helpfulness.\n\n" +
  "Here is the task:\n";

// The default instruction Sharon sends when she starts reading on her own.
const DEFAULT_INSTRUCTION =
  "Here is the text currently visible on the active browser tab. First, give " +
  "me a one or two sentence overview of what's on screen. Then read the " +
  "important parts aloud in a natural, listenable way — skip navigation, ads, " +
  "boilerplate, and anything repetitive. If it's long, focus on the main " +
  "points rather than every word. Keep it conversational since I'm listening, " +
  "not reading.";

// When a page has almost nothing to read, ask for a short honest reply
// instead of letting the model invent content.
const SHORT_PAGE_CHARS = 200;
const SHORT_PAGE_INSTRUCTION =
  "There is very little readable text on this tab right now. In one or two " +
  "short, honest sentences, tell me what little is here. Do not invent, " +
  "expand, or pad with anything that isn't actually on the page.";

// After Sharon scrolls the page on the user's behalf, read the part that's now
// in view. Each request is sent without history, so we can't say "continue from
// where you left off" — instead we point her at the freshly-revealed part.
function scrollReadInstruction(direction) {
  if (direction === "up" || direction === "top") {
    return (
      "I've just scrolled back " +
      (direction === "top" ? "to the top of " : "up ") +
      "the page. Briefly and naturally read the content that's now visible " +
      "here. Skip menus, ads, and boilerplate."
    );
  }
  // down / bottom
  return (
    "I've just scrolled further down the page" +
    (direction === "bottom" ? " to the very bottom" : "") +
    ". Read the part that's now visible toward the lower portion of the page — " +
    "for a conversation or message thread, the newer messages now in view. " +
    "Read it naturally and conversationally. Focus on this newly revealed part " +
    "rather than re-summarizing the whole page from the top, and skip menus, " +
    "ads, and boilerplate. If there is genuinely nothing new beyond a heading " +
    "or whitespace, just say so in one short sentence."
  );
}

// Sent on every step when Sharon is allowed to act on the page. She is given
// the user's goal, the visible page text (as page content), and a numbered list
// of the interactive elements currently on the page, and must reply with ONE
// JSON action plan. The whole loop runs inside the extension; this just shapes
// the instruction text we put in the request body, which is otherwise unchanged.
const AGENT_GROUNDING =
  "You are Sharon, a hands-free voice assistant that can BOTH read the user's " +
  "active browser tab AND act on it for them — clicking, typing, selecting, and " +
  "scrolling — to carry out what they ask.\n\n" +
  "Each step you are given: the user's goal, the page content (visible text), " +
  "a numbered list of the interactive elements on the page right now, and a log " +
  "of actions you've already taken this task. Decide the SINGLE next step and " +
  "reply with ONE JSON object inside a ```json code block, and nothing else:\n" +
  "```json\n" +
  "{\n" +
  '  "say": "what to tell the user — one short sentence when you are acting; ' +
  'the full answer or reading when there are no actions",\n' +
  '  "actions": [\n' +
  '    {"type": "click", "id": 3},\n' +
  '    {"type": "type", "id": 5, "text": "hello", "append": false},\n' +
  '    {"type": "clear", "id": 5},\n' +
  '    {"type": "select", "id": 8, "option": "Option label"},\n' +
  '    {"type": "key", "key": "Enter"},\n' +
  '    {"type": "scroll", "direction": "down"}\n' +
  "  ],\n" +
  '  "done": false\n' +
  "}\n" +
  "```\n" +
  "Rules:\n" +
  "1. Use ONLY element ids that appear in the provided list. Never invent ids.\n" +
  "2. If the user only wants information or to have something read, set " +
  '"actions" to [] , put the answer/reading in "say", and set "done": true.\n' +
  "3. Take SMALL steps — usually one to three actions — then you'll get the " +
  'updated page to decide the next step. Set "done": false while more steps '+
  "remain.\n" +
  '4. When the goal is achieved, set "done": true with a brief confirmation in ' +
  '"say".\n' +
  "5. NEVER type or submit passwords, payment card numbers, security codes, or " +
  "other secret credentials. If the goal needs those, stop and say so plainly " +
  '("done": true).\n' +
  "6. Talk only about what is actually on the page; never invent content. If " +
  "you can't find a suitable element, say so plainly and set \"done\": true.\n\n";

// A tab is restricted only when its URL starts with one of these. Any normal
// http:// or https:// website is ALWAYS readable.
const RESTRICTED_PREFIXES = [
  "chrome://",
  "edge://",
  "about:",
  "chrome-extension://",
  "devtools://",
];

/* ------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------ */
let sessionId = null;
let busy = false; // a proxy request is in flight
let restricted = true; // no readable page in view yet
let lastReadKey = null; // tabId::url we last started reading
let lastUserInstruction = null; // the most recent spoken instruction (if any)
let abortController = null; // cancels an in-flight proxy request
let evalSeq = 0; // guards against out-of-order tab evaluations
let ready = false; // settings loaded — safe to auto-read

// Speech synthesis (reading aloud)
const synth = window.speechSynthesis;
let currentUtterance = null;
let currentSpokenText = ""; // what Sharon is reading right now (echo filter)
let speaking = false;
let paused = false;

// Speech recognition (listening)
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognizing = false;
let micMuted = false; // user toggled mute
let micBlocked = false; // browser denied mic access
let interimBubble = null;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Settings — persisted in chrome.storage.local so they survive reopening
 * ------------------------------------------------------------------ */
const SETTINGS_KEY = "sharon_settings";
const DEFAULT_SETTINGS = {
  autoRead: true, // read pages automatically on activation / tab change
  allowScroll: true, // may Sharon scroll the active tab when asked? (saved approval)
  readAloud: true, // speak answers out loud? (user can mute Sharon's voice)
  allowActions: false, // may Sharon click/type/act on the page? (opt-in, off by default)
  confirmActions: true, // ask for a spoken "yes" before each set of actions
};
let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const saved = stored && stored[SETTINGS_KEY];
    if (saved && typeof saved === "object") {
      settings = { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch (_) {
    // storage unavailable — keep the in-memory defaults
  }
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch (_) {
    /* ignore — the setting still applies for this session */
  }
}

/* ------------------------------------------------------------------ *
 * Status + state — single source of truth for the header + accent
 * ------------------------------------------------------------------ */
function setStatus(text) {
  els.status.textContent = text;
}

function updateStatus() {
  els.html.setAttribute("data-mic", micMuted ? "muted" : "live");
  els.micBtn.setAttribute("aria-pressed", String(!micMuted));
  els.micBtn.title = micMuted ? "Unmute microphone" : "Mute microphone";
  els.micBtn.setAttribute(
    "aria-label",
    micMuted ? "Unmute microphone" : "Mute microphone"
  );

  let state, text;
  if (restricted) {
    state = "idle";
    text = "Open a website and I'll start reading";
  } else if (paused) {
    state = "reading";
    text = "Paused";
  } else if (speaking) {
    state = "reading";
    text = "Reading…";
  } else if (micMuted) {
    state = "muted";
    text = "Muted";
  } else if (!settings.autoRead) {
    // Auto-read is off: stay calm and wait to be asked, mic still live.
    state = "listening";
    text = "Ask me to read this page";
  } else {
    state = "listening";
    text = "Listening…";
  }
  els.html.setAttribute("data-state", state);
  setStatus(text);
}

// Reflect the read-aloud (voice output) mute state on the speaker button.
function updateReadAloudUI() {
  const on = !!settings.readAloud;
  els.html.setAttribute("data-readaloud", on ? "on" : "off");
  if (els.aloudBtn) {
    els.aloudBtn.setAttribute("aria-pressed", String(!on));
    const label = on ? "Mute Sharon's voice" : "Unmute Sharon's voice";
    els.aloudBtn.title = label;
    els.aloudBtn.setAttribute("aria-label", label);
  }
}

/* ------------------------------------------------------------------ *
 * Session id — stable, random, reused for every request
 * ------------------------------------------------------------------ */
async function ensureSessionId() {
  if (sessionId) return sessionId;
  try {
    const { sharon_session_id } = await chrome.storage.local.get(
      "sharon_session_id"
    );
    if (sharon_session_id) {
      sessionId = sharon_session_id;
    } else {
      sessionId =
        (crypto.randomUUID && crypto.randomUUID()) ||
        "sess-" + Math.random().toString(36).slice(2) + Date.now();
      await chrome.storage.local.set({ sharon_session_id: sessionId });
    }
  } catch (e) {
    // storage unavailable for some reason — fall back to an in-memory id
    sessionId = "sess-" + Math.random().toString(36).slice(2) + Date.now();
  }
  return sessionId;
}

/* ------------------------------------------------------------------ *
 * Conversation rendering
 * ------------------------------------------------------------------ */
function clearWelcome() {
  if (els.welcome) {
    els.welcome.remove();
    els.welcome = null;
  }
}

function scrollToBottom() {
  els.conversation.scrollTop = els.conversation.scrollHeight;
}

function addBubble(role, text, { interim = false } = {}) {
  clearWelcome();
  const div = document.createElement("div");
  div.className =
    "bubble " +
    (role === "user" ? "user" : role === "error" ? "error" : "sharon");
  if (interim) div.classList.add("interim");
  div.textContent = text;
  els.conversation.appendChild(div);
  scrollToBottom();
  return div;
}

function addSources(bubble, sources) {
  if (!Array.isArray(sources) || sources.length === 0) return;
  const wrap = document.createElement("div");
  wrap.className = "sources";
  for (const url of sources) {
    if (!url) continue;
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    let label = url;
    try {
      label = new URL(url).hostname.replace(/^www\./, "") + " ↗";
    } catch (_) {
      /* keep raw url */
    }
    a.textContent = label;
    a.title = url;
    wrap.appendChild(a);
  }
  bubble.appendChild(wrap);
  scrollToBottom();
}

function showTyping() {
  clearWelcome();
  const div = document.createElement("div");
  div.className = "bubble sharon typing";
  div.innerHTML = "<span></span><span></span><span></span>";
  els.conversation.appendChild(div);
  scrollToBottom();
  return div;
}

// Split Sharon's reply into a short opening overview ("lead") and the body, so
// the summary can be shown at a glance above the rest.
function splitLead(text) {
  const t = (text || "").trim();
  if (!t) return { lead: "", body: "" };

  // Prefer an explicit paragraph break near the top.
  let idx = t.search(/\n\s*\n/);
  if (idx > 0 && idx < 400) {
    const body = t.slice(idx).trim();
    if (body) return { lead: t.slice(0, idx).trim(), body };
  }

  // Otherwise take the first sentence as the lead.
  const m = t.match(/^([\s\S]+?[.!?])\s+([\s\S]+)$/);
  if (m && m[1].length <= 300 && m[2].trim()) {
    return { lead: m[1].trim(), body: m[2].trim() };
  }

  // Otherwise split on the first line break.
  idx = t.indexOf("\n");
  if (idx > 0 && idx < 300) {
    const body = t.slice(idx).trim();
    if (body) return { lead: t.slice(0, idx).trim(), body };
  }

  // Nothing to split (e.g. a short page) — show it as a single line.
  return { lead: t, body: "" };
}

function addSharonBubble(text) {
  clearWelcome();
  const div = document.createElement("div");
  div.className = "bubble sharon";
  const { lead, body } = splitLead(text);
  if (lead && body) {
    const leadEl = document.createElement("p");
    leadEl.className = "lead";
    leadEl.textContent = lead;
    const bodyEl = document.createElement("p");
    bodyEl.className = "body-text";
    bodyEl.textContent = body;
    div.appendChild(leadEl);
    div.appendChild(bodyEl);
  } else {
    div.textContent = text;
  }
  els.conversation.appendChild(div);
  scrollToBottom();
  return div;
}

/* ------------------------------------------------------------------ *
 * Active tab + page text extraction
 * ------------------------------------------------------------------ */
async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab || null;
  } catch (_) {
    return null;
  }
}

// Get the active tab, but if its URL hasn't resolved yet (empty/undefined),
// wait briefly and re-check rather than assuming the page is protected. A real
// http/https page resolves quickly; a genuinely restricted page stays blank.
async function getActiveTabReady() {
  let tab = await getActiveTab();
  for (let i = 0; i < 6 && (!tab || !tab.url); i++) {
    await delay(180);
    tab = await getActiveTab();
  }
  return tab;
}

function isRestricted(url) {
  if (!url) return true; // only reached after we've waited and re-checked
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
  // The Chrome / Edge web store.
  if (host === "chromewebstore.google.com") return true;
  if (host === "chrome.google.com" && path.startsWith("/webstore")) return true;
  if (host === "microsoftedge.microsoft.com" && path.startsWith("/addons"))
    return true;
  return false;
}

// Injected into the page. Must be self-contained (no closures over outer scope).
function extractPageText() {
  function collapse(s) {
    return s
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n[ \t]*\n[ \t]*(\n[ \t]*)+/g, "\n\n")
      .replace(/[ \t]*\n[ \t]*/g, "\n")
      .trim();
  }

  // Tags whose text is almost never the page's main content.
  const EXCLUDE_TAGS = {
    NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1,
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1,
    SVG: 1, CANVAS: 1, FORM: 1, BUTTON: 1, INPUT: 1,
    SELECT: 1, TEXTAREA: 1, LABEL: 1, IFRAME: 1,
  };
  // Tags that should introduce a line break in the reading order.
  const BLOCK_TAGS = {
    P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, LI: 1, UL: 1, OL: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BLOCKQUOTE: 1, PRE: 1,
    TABLE: 1, TR: 1, FIGURE: 1, FIGCAPTION: 1, DD: 1, DT: 1, DL: 1, HR: 1,
  };
  // Class / id / aria-label tokens that mark obvious boilerplate.
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
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true")
      return true;
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

  // Walk the live DOM in document (top-to-bottom) order, collecting only the
  // text that survives the filters above.
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

  // Among a set of candidate regions, return the visible one whose filtered
  // text is longest, along with that text. Used to find the real content on web
  // apps, not just articles. (Returning the text avoids re-gathering it later.)
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

  // Pick the region to read. Works for web apps, not just articles: when a
  // clear message / document body is open, prefer it over the surrounding menus
  // and sidebars. Returns { el, text }.
  function pickMain() {
    // 1) A focused message / document body — the strongest signal that the user
    //    has an item open (an email, a doc, an article body, a single post).
    //    Require a substantial amount of text so a small incidental widget
    //    (e.g. a chat box) can't hijack a real article.
    const focused = bestRegion([
      '[itemprop="articleBody"]',
      '[role="document"]',
      ".a3s", // Gmail open-message body
      ".message-body",
      ".messageBody",
      ".email-body",
      ".mail-body",
    ]);
    if (focused.el && focused.text.length >= 200) return focused;

    // 2) A semantic main-content region.
    const region = bestRegion([
      "article",
      '[role="article"]',
      "main",
      '[role="main"]',
    ]);
    if (region.el && region.text.length >= 80) return region;

    // 3) A focused body that exists but was below the article threshold (e.g. a
    //    short opened email) still beats reading the whole app chrome.
    if (focused.el && focused.text.length >= 80) return focused;

    // 4) Nothing specific stood out — read the whole body.
    return { el: document.body, text: collapse(gather(document.body)) };
  }

  const picked = pickMain();
  const main = picked.el || document.body;

  // Capture the headline / title separately.
  const h1 =
    (main && main.querySelector && main.querySelector("h1")) ||
    document.querySelector("h1");
  const h1text = h1 ? (h1.innerText || h1.textContent || "").trim() : "";
  const title =
    h1text ||
    metaContent('meta[property="og:title"]') ||
    (document.title || "").trim();

  // If the user has selected text, honour that selection.
  const sel = window.getSelection ? window.getSelection().toString().trim() : "";
  if (sel) {
    return { text: collapse(sel), title: title, url: location.href };
  }

  let text = picked.text || "";

  // Safety fallback: if cleanup left almost nothing — e.g. an oddly-built page
  // where filtering removed the real content — fall back to the raw body text.
  // Only swap when the body has substantially more, so a clean short extraction
  // (a brief email/message) is kept as-is instead of being buried in chrome.
  if (text.length < 200) {
    const bodyText = collapse((document.body && document.body.innerText) || "");
    if (bodyText.length > text.length * 1.5) text = bodyText;
  }

  return { text: text, title: title, url: location.href };
}

async function readPageContext() {
  const tab = await getActiveTab();
  if (!tab || !tab.id || isRestricted(tab.url)) {
    return { restricted: true };
  }
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageText,
    });
    const result = (injection && injection.result) || {};
    let text = result.text || "";
    if (text.length > MAX_PAGE_TEXT) text = text.slice(0, MAX_PAGE_TEXT);
    return {
      text,
      title: result.title || tab.title || "",
      url: result.url || tab.url || "",
    };
  } catch (e) {
    // Couldn't inject (e.g. an unexpected internal page) — treat calmly.
    return { restricted: true };
  }
}

/* ------------------------------------------------------------------ *
 * Scrolling the active tab
 *
 * Sharon stays a reader: she never clicks or navigates. The one page action
 * she can take — when the user allows it — is to scroll, so she can reveal and
 * read more of a long article or message thread. This is gated by the saved
 * "Let Sharon scroll the page" setting (approval), handled client-side here;
 * after a scroll she simply re-reads whatever is now visible.
 * ------------------------------------------------------------------ */

// Injected into the page. Must be self-contained (no closures over outer scope).
// Scrolls the right thing — the document, or the largest scrollable container
// on app-style pages where the body itself doesn't scroll — and reports back
// whether it could actually move and where it landed.
function scrollPage(opts) {
  var dir = (opts && opts.direction) || "down";

  function docScrollMax() {
    var de = document.documentElement;
    return Math.max((de ? de.scrollHeight : 0) - window.innerHeight, 0);
  }

  // On web apps the <body> often doesn't scroll; the content lives in an inner
  // overflow:auto/scroll container. Find the tallest visible one.
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
  // Prefer the window when the document itself scrolls; otherwise hunt for the
  // inner scroll container.
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
  else target = before + step; // "down" is the default

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

// Speak + show a short note from Sharon without going to the server.
function sharonSay(text) {
  const bubble = addSharonBubble(text);
  speakText(text);
  return bubble;
}

// Scroll the active tab in the given direction, then read what's now visible.
async function handleScroll(direction) {
  if (!settings.allowScroll) {
    sharonSay(
      "Scrolling is turned off right now. You can switch on “Let Sharon " +
        "scroll the page for me” in Settings and I'll be glad to scroll for you."
    );
    return;
  }

  const tab = await getActiveTab();
  if (!tab || !tab.id || isRestricted(tab.url)) {
    sharonSay(
      "There's nothing here I can scroll. Open a website and I'll be able to " +
        "scroll through it for you."
    );
    return;
  }

  // Barge in: stop any reading before we move the page.
  stopSpeaking();

  let res = {};
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollPage,
      args: [{ direction }],
    });
    res = (injection && injection.result) || {};
  } catch (_) {
    sharonSay("I couldn't scroll this page just now. Try me again in a moment.");
    return;
  }

  if (!res.hasScroll) {
    sharonSay("This page doesn't scroll — it all fits on screen already.");
    return;
  }
  if (!res.moved) {
    if (direction === "up" || direction === "top") {
      sharonSay("We're already at the top of the page.");
    } else {
      sharonSay("That's the bottom — there's nothing more to scroll to.");
    }
    return;
  }

  // Give lazy-loaded threads and feeds a moment to render the new content
  // before we re-extract and read it.
  await delay(600);
  await sendInstruction(scrollReadInstruction(direction), {});
}

/* ------------------------------------------------------------------ *
 * Acting on the page — full assistant control (opt-in)
 *
 * When the user enables "Let Sharon act on the page", spoken instructions run
 * through an agentic loop that lives entirely inside the extension:
 *   perceive (map the interactive elements) → reason (ask the model for a JSON
 *   action plan) → act (inject clicks / typing / etc.) → observe → repeat.
 * The request body to the proxy is unchanged; the action protocol travels
 * inside the model's text reply, which we parse here.
 * ------------------------------------------------------------------ */

const MAX_AGENT_STEPS = 8; // stop runaway loops; the user can ask to continue
let agentTask = null; // { goal, log: [], steps } while a task is running
let pendingPlan = null; // an action plan awaiting the user's spoken "yes"

// Injected. Build a numbered map of the interactive elements on the page and
// tag each with data-sharon-id so we can act on it later. Self-contained.
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
    // Keep things on or near the screen (allow a generous below-the-fold band).
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

// Injected. Carry out an ordered list of actions on elements tagged by
// collectInteractive, and report back what happened. Self-contained.
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

// Show a status line while Sharon is acting, then fall back to normal status.
function setActing(on, text) {
  if (on) {
    els.html.setAttribute("data-state", "reading");
    setStatus(text || "Working…");
  } else {
    updateStatus();
  }
}

async function getActionTab() {
  const tab = await getActiveTab();
  if (!tab || !tab.id || isRestricted(tab.url)) return null;
  return tab;
}

async function extractElements(tab) {
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

function elementsToText(list) {
  if (!list.length) return "(no interactive elements detected)";
  return list
    .map(
      (e) =>
        "[" +
        e.id +
        "] " +
        e.kind +
        (e.name ? ' "' + e.name + '"' : "") +
        (e.value ? " (" + e.value + ")" : "")
    )
    .join("\n");
}

function buildAgentPrompt(goal, log, list) {
  let s = AGENT_GROUNDING + "User goal: " + goal + "\n\n";
  if (log.length) {
    s +=
      "Actions you have already taken this task:\n" +
      log.map((l, i) => i + 1 + ". " + l).join("\n") +
      "\n\n";
  }
  s += "Interactive elements on the page right now:\n" + elementsToText(list);
  return s;
}

// Pull the JSON action plan out of the model's reply. Returns
// { say, actions, done } or null when there's no parseable plan (in which case
// we treat the reply as an ordinary spoken answer).
function parseAgentReply(reply) {
  if (!reply) return null;
  let jsonStr = null;
  const fence = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonStr = fence[1];
  else {
    const a = reply.indexOf("{");
    const b = reply.lastIndexOf("}");
    if (a >= 0 && b > a) jsonStr = reply.slice(a, b + 1);
  }
  if (!jsonStr) return null;
  let o;
  try {
    o = JSON.parse(jsonStr);
  } catch (_) {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const actions = Array.isArray(o.actions) ? o.actions : [];
  return {
    say: (o.say || "").trim(),
    actions,
    done: o.done === true || actions.length === 0,
  };
}

// Describe an action plan in plain words, for the spoken confirmation prompt.
function describePlan(actions, list) {
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

function startAgentTask(goal) {
  agentTask = { goal, log: [], steps: 0 };
  agentStep();
}

function cancelAgentTask() {
  agentTask = null;
  pendingPlan = null;
}

async function agentStep() {
  if (!agentTask) return;
  if (agentTask.steps >= MAX_AGENT_STEPS) {
    sharonSay(
      "I've taken several steps, so I'll pause here rather than run away with " +
        "it. Tell me how you'd like to continue."
    );
    cancelAgentTask();
    setActing(false);
    return;
  }

  const tab = await getActionTab();
  if (!tab) {
    sharonSay("There's nothing here I can act on. Open a website and I'll help.");
    cancelAgentTask();
    return;
  }

  const ctx = await readPageContext();
  if (ctx.restricted) {
    sharonSay("I can't act on this page.");
    cancelAgentTask();
    return;
  }

  setActing(true, "Looking at the page…");
  const list = await extractElements(tab);
  const content = buildAgentPrompt(agentTask.goal, agentTask.log, list);

  const typing = showTyping();
  let data;
  try {
    data = await askSharon(content, ctx);
  } catch (err) {
    typing.remove();
    addBubble(
      "error",
      "Sharon hit a snag: " + ((err && err.message) || "I couldn't reach the server.")
    );
    cancelAgentTask();
    setActing(false);
    return;
  }
  typing.remove();

  if (!data || !data.ok) {
    addBubble("error", "Sharon hit a snag: " + ((data && data.error) || "something went wrong."));
    cancelAgentTask();
    setActing(false);
    return;
  }

  const plan = parseAgentReply(data.reply);
  if (!plan) {
    // Not an action reply — treat it as a normal spoken answer.
    const bubble = addSharonBubble(data.reply || "(no reply)");
    addSources(bubble, data.sources);
    if (data.reply) speakText(data.reply);
    cancelAgentTask();
    setActing(false);
    return;
  }

  if (plan.say) {
    addSharonBubble(plan.say);
    speakText(plan.say);
  }

  if (!plan.actions.length) {
    // Sharon answered / decided she's done — no page action needed.
    cancelAgentTask();
    setActing(false);
    return;
  }

  if (settings.confirmActions) {
    pendingPlan = { actions: plan.actions };
    const desc = describePlan(plan.actions, list);
    setActing(true, "Waiting for your okay…");
    sharonSay(
      "I'm about to " +
        (desc || "act on the page") +
        '. Say "yes" to go ahead, or "no" to stop.'
    );
    return;
  }

  await runPlan(plan.actions);
}

async function runPlan(actions) {
  if (!agentTask) return;
  const tab = await getActionTab();
  if (!tab) {
    sharonSay("The page went away before I could act.");
    cancelAgentTask();
    setActing(false);
    return;
  }

  setActing(true, "Working…");
  let res = {};
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: doActions,
      args: [{ actions }],
    });
    res = (inj && inj.result) || {};
  } catch (e) {
    res = { results: [{ ok: false, error: String((e && e.message) || e) }] };
  }

  const results = res.results || [];
  results.forEach((r, i) => {
    const a = actions[i] || {};
    agentTask.log.push(
      a.type +
        (a.id != null ? " #" + a.id : "") +
        (a.text ? ' "' + String(a.text).slice(0, 40) + '"' : "") +
        " → " +
        (r.ok ? "ok" : "failed" + (r.error ? " (" + r.error + ")" : ""))
    );
  });
  agentTask.steps++;

  // Let the page settle (navigation, re-render) before the next observation.
  await delay(800);
  agentStep();
}

/* ------------------------------------------------------------------ *
 * Tab card — keep it current
 * ------------------------------------------------------------------ */
function refreshTabCard(tab) {
  if (!tab) {
    els.tabTitle.textContent = "No active tab";
    els.tabSite.textContent = "—";
    return;
  }
  if (isRestricted(tab.url)) {
    els.tabTitle.textContent = tab.title || "A browser page";
    els.tabSite.textContent = "Open a website and I'll start reading";
    return;
  }
  els.tabTitle.textContent = tab.title || "This page";
  try {
    els.tabSite.textContent = new URL(tab.url).hostname.replace(/^www\./, "");
  } catch (_) {
    els.tabSite.textContent = tab.url || "—";
  }
}

/* ------------------------------------------------------------------ *
 * Talking to the proxy
 *
 * IMPORTANT: keep this networking EXACTLY as is — text/plain (no CORS
 * preflight that Apps Script can't answer), the same body shape, and no API
 * key anywhere. Do NOT switch to application/json or add headers.
 * ------------------------------------------------------------------ */
async function askSharon(question, ctx, signal) {
  const id = await ensureSessionId();
  const body = {
    action: "chat",
    messages: [{ role: "user", content: question }],
    page_text: ctx.text || "",
    page_title: ctx.title || "",
    page_url: ctx.url || "",
    session_id: id,
  };

  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(body),
    signal,
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error(
      "Sharon got an unexpected reply from the server. Please try again."
    );
  }
  return data;
}

/* ------------------------------------------------------------------ *
 * The send path — shared by auto-read and spoken instructions
 * ------------------------------------------------------------------ */
async function sendInstruction(
  instruction,
  { remember = false, defaultRead = false } = {}
) {
  instruction = (instruction || "").trim();
  if (!instruction) return;

  // Cancel anything already in flight — the newest request wins.
  if (abortController) {
    try {
      abortController.abort();
    } catch (_) {
      /* ignore */
    }
  }
  const ac = new AbortController();
  abortController = ac;
  busy = true;

  // Re-extract the current tab's text at this moment — never reuse stale text,
  // since the user clicks around the page themselves between requests.
  const ctx = await readPageContext();
  if (ac.signal.aborted) return;
  if (ctx.restricted) {
    // Not an error — just nothing to read here.
    restricted = true;
    busy = false;
    if (abortController === ac) abortController = null;
    updateStatus();
    return;
  }
  if (remember) lastUserInstruction = instruction;

  // Don't break short pages: when reading automatically and there's barely
  // anything to read, ask for a brief honest reply instead of the full read.
  let prompt = instruction;
  if (defaultRead && (ctx.text || "").trim().length < SHORT_PAGE_CHARS) {
    prompt = SHORT_PAGE_INSTRUCTION;
  }

  // Prepend the grounding rules so Sharon answers strictly from what's on the
  // current tab and never invents anything. (Body shape is unchanged.)
  const grounded = GROUNDING + prompt;

  const typing = showTyping();
  try {
    const data = await askSharon(grounded, ctx, ac.signal);
    if (ac.signal.aborted) {
      typing.remove();
      return;
    }
    typing.remove();

    if (data && data.ok) {
      const bubble = addSharonBubble(data.reply || "(no reply)");
      addSources(bubble, data.sources);
      if (data.reply) speakText(data.reply);
    } else {
      const msg =
        (data && data.error) || "something went wrong with that request.";
      addBubble("error", "Sharon hit a snag: " + msg);
    }
  } catch (err) {
    typing.remove();
    if (err && err.name === "AbortError") return;
    addBubble(
      "error",
      "Sharon hit a snag: " +
        (err && err.message
          ? err.message
          : "I couldn't reach the server. Check your connection and try again.")
    );
  } finally {
    if (abortController === ac) {
      busy = false;
      abortController = null;
    }
    updateStatus();
  }
}

/* ------------------------------------------------------------------ *
 * Auto-read: whenever a readable tab becomes active, start reading it.
 * ------------------------------------------------------------------ */
async function evaluateActiveTab() {
  const seq = ++evalSeq;
  const tab = await getActiveTabReady();
  if (seq !== evalSeq) return; // a newer evaluation superseded this one

  refreshTabCard(tab);

  if (!tab || isRestricted(tab.url)) {
    restricted = true;
    lastReadKey = null;
    stopSpeaking(); // we've left the page she was reading
    updateStatus();
    return;
  }

  restricted = false;
  updateStatus();

  // Wait until saved settings have loaded so a tab event during startup can't
  // auto-read before we know whether the user disabled it.
  if (!ready) return;

  // When auto-read is off, Sharon stays quiet: she never reads or sends page
  // text on her own. She'll only act when the user explicitly asks.
  if (!settings.autoRead) return;

  const key = tab.id + "::" + tab.url;
  if (key === lastReadKey) return; // already reading / read this exact page
  lastReadKey = key;
  autoRead();
}

async function autoRead() {
  stopSpeaking();
  // Use the user's last spoken instruction if there is one; otherwise default.
  const custom = lastUserInstruction;
  await sendInstruction(custom || DEFAULT_INSTRUCTION, { defaultRead: !custom });
}

/* ------------------------------------------------------------------ *
 * Speech synthesis (reading aloud)
 * ------------------------------------------------------------------ */
function pickEnglishVoice() {
  if (!synth) return null;
  const voices = synth.getVoices() || [];
  if (!voices.length) return null;
  return (
    voices.find(
      (v) =>
        /^en[-_]US/i.test(v.lang) && /female|Samantha|Google US/i.test(v.name)
    ) ||
    voices.find((v) => /^en[-_]US/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    voices[0]
  );
}

function speakText(text) {
  if (!synth) return; // no speech support — leave the answer on screen
  // The user has muted Sharon's voice — show the answer but don't read it aloud.
  if (!settings.readAloud) return;
  synth.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  const voice = pickEnglishVoice();
  if (voice) {
    utt.voice = voice;
    utt.lang = voice.lang;
  } else {
    utt.lang = "en-US";
  }
  utt.rate = 1;
  utt.pitch = 1;

  utt.onstart = () => {
    speaking = true;
    paused = false;
    updateStatus();
  };
  utt.onresume = () => {
    paused = false;
    updateStatus();
  };
  utt.onpause = () => {
    paused = true;
    updateStatus();
  };
  const finish = () => {
    speaking = false;
    paused = false;
    currentUtterance = null;
    currentSpokenText = "";
    updateStatus();
  };
  utt.onend = finish;
  utt.onerror = finish;

  currentUtterance = utt;
  currentSpokenText = text;
  speaking = true; // set now so the echo filter is active immediately
  paused = false;
  synth.speak(utt);
  updateStatus();
}

function stopSpeaking() {
  if (synth) synth.cancel();
  speaking = false;
  paused = false;
  currentUtterance = null;
  currentSpokenText = "";
}

function pauseSpeaking() {
  if (synth && synth.speaking && !synth.paused) {
    synth.pause();
    paused = true;
    updateStatus();
  }
}

function resumeSpeaking() {
  if (synth && synth.paused) {
    synth.resume();
    paused = false;
    updateStatus();
  }
}

// Voices can load asynchronously; warm them up.
if (synth) {
  synth.onvoiceschanged = () => pickEnglishVoice();
}

/* ------------------------------------------------------------------ *
 * Echo filter — ignore the mic transcribing Sharon's own voice
 * ------------------------------------------------------------------ */
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isEchoOfSpeech(phrase) {
  if (!speaking || !currentSpokenText) return false;
  const p = normalize(phrase);
  if (!p) return true;
  const full = normalize(currentSpokenText);
  if (!full) return false;
  if (full.includes(p)) return true; // a contiguous chunk of what she's saying
  // Otherwise, if most of the words are words she's currently reading, it's echo.
  const words = p.split(" ");
  const matched = words.filter((w) => full.includes(w)).length;
  return matched / words.length >= 0.6;
}

/* ------------------------------------------------------------------ *
 * Acting on what the user said
 * ------------------------------------------------------------------ */

// Work out whether a spoken command is asking Sharon to scroll the page, and
// which way. Returns { direction, explicit } or null.
//   - direction: "up" | "down" | "top" | "bottom"
//   - explicit:  true when the user literally said "scroll …" / "go up/down" /
//                "to the top/bottom" (an unmistakable scroll request); false for
//                looser reader phrasing like "read more" / "what else".
// The `explicit` flag lets us inform the user when scrolling is switched off
// only when they clearly asked for it, and otherwise let ambiguous words like
// "more" fall through to a normal question.
function parseScrollIntent(cmd) {
  if (
    /\b(top of (the )?page|to the (very )?top|back to the top)\b/.test(cmd) ||
    cmd === "top"
  ) {
    return { direction: "top", explicit: true };
  }
  if (
    /\b(bottom of (the )?page|to the (very )?bottom|all the way down|scroll to the end)\b/.test(
      cmd
    ) ||
    cmd === "bottom"
  ) {
    return { direction: "bottom", explicit: true };
  }
  if (
    /\bscroll (back )?up\b/.test(cmd) ||
    /\b(go|move|page) up\b/.test(cmd) ||
    /\bup a (bit|little|touch)\b/.test(cmd) ||
    cmd === "up"
  ) {
    return { direction: "up", explicit: true };
  }
  if (
    /\bscroll( down| further| some| more| a (bit|little))?\b/.test(cmd) ||
    /\b(go|move|page) down\b/.test(cmd) ||
    /\bdown a (bit|little|touch)\b/.test(cmd) ||
    cmd === "down"
  ) {
    return { direction: "down", explicit: true };
  }
  // Looser reader phrasing — treat as "scroll down and read on". Kept narrow on
  // purpose so a topical question like "tell me more about pricing" still goes
  // to the model: a bare "more"/"read more" scrolls, but "more about X" doesn't.
  if (
    /^(more|read more|show more|tell me more|read on|keep reading|continue reading|see more|what else|what else does it say|read the rest|the rest)$/.test(
      cmd
    ) ||
    /\b(more of (the|this) (thread|page|conversation|article|email|messages?)|rest of (the|this) (thread|page|conversation|article|email)|further down the (thread|page|conversation))\b/.test(
      cmd
    )
  ) {
    return { direction: "down", explicit: false };
  }
  return null;
}

function handleUserUtterance(text) {
  text = (text || "").trim();
  if (!text) return;
  // While Sharon is talking, ignore the mic echoing her own voice.
  if (speaking && isEchoOfSpeech(text)) return;

  const cmd = text
    .toLowerCase()
    .replace(/[.!?,]+$/g, "")
    .trim();

  // If an action plan is waiting for the user's okay, this utterance answers it.
  if (pendingPlan) {
    const yes = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|please do|confirm|go for it|sounds good)$/.test(
      cmd
    );
    const no = /^(no|nope|nah|stop|cancel|don'?t|do not|never ?mind|wait|hold on)$/.test(
      cmd
    );
    if (yes) {
      addBubble("user", text);
      const actions = pendingPlan.actions;
      pendingPlan = null;
      runPlan(actions);
      return;
    }
    if (no) {
      addBubble("user", text);
      cancelAgentTask();
      sharonSay("Okay, I'll leave it.");
      updateStatus();
      return;
    }
    // Neither yes nor no — treat it as a brand-new request; drop the plan.
    cancelAgentTask();
  }

  if (cmd === "stop" || cmd === "stop reading" || cmd === "be quiet" || cmd === "quiet") {
    addBubble("user", text);
    cancelAgentTask(); // abort any task in progress
    stopSpeaking();
    setActing(false);
    return;
  }
  if (cmd === "pause") {
    addBubble("user", text);
    pauseSpeaking();
    return;
  }
  // "resume" / "continue" / "keep going" resume the voice when it's paused. If
  // nothing is paused, the user is asking to hear more — scroll on and read.
  if (
    cmd === "resume" ||
    cmd === "continue" ||
    cmd === "keep going" ||
    cmd === "go on"
  ) {
    addBubble("user", text);
    if (paused) {
      resumeSpeaking();
    } else if (settings.allowScroll) {
      handleScroll("down");
    } else {
      resumeSpeaking();
    }
    return;
  }

  // Scrolling the page — Sharon's one page action, when the user allows it.
  const scrollIntent = parseScrollIntent(cmd);
  if (scrollIntent && (settings.allowScroll || scrollIntent.explicit)) {
    addBubble("user", text);
    handleScroll(scrollIntent.direction);
    return;
  }

  // Anything else is an instruction. When Sharon is allowed to act on the page,
  // it runs through the agentic loop (which still just answers/reads when no
  // page action is needed); otherwise it's a normal read/answer request.
  addBubble("user", text);
  if (speaking) stopSpeaking(); // barge-in: pause the reading first
  if (settings.allowActions) {
    startAgentTask(text);
  } else {
    sendInstruction(text, { remember: true });
  }
}

/* ------------------------------------------------------------------ *
 * Speech recognition (listening) — continuous while the mic is live
 * ------------------------------------------------------------------ */
function ensureRecognition() {
  if (recognition) return recognition;
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    recognizing = true;
  };

  rec.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += transcript;
      else interim += transcript;
    }

    const show = interim.trim();
    if (show && !(speaking && isEchoOfSpeech(show))) {
      if (!interimBubble) {
        interimBubble = addBubble("user", show, { interim: true });
      } else {
        interimBubble.textContent = show;
        scrollToBottom();
      }
    }

    if (final.trim()) {
      const text = final.trim();
      if (interimBubble) {
        interimBubble.remove();
        interimBubble = null;
      }
      handleUserUtterance(text);
    }
  };

  rec.onerror = (event) => {
    recognizing = false;
    if (interimBubble) {
      interimBubble.remove();
      interimBubble = null;
    }
    if (
      event.error === "not-allowed" ||
      event.error === "service-not-allowed"
    ) {
      micBlocked = true;
      micMuted = true;
      addBubble(
        "error",
        "I couldn't access the microphone. Check the browser's mic permission, then tap the mic to try again. I'll keep reading pages in the meantime."
      );
      updateStatus();
    }
    // Other errors (no-speech, network, aborted) are handled by onend's restart.
  };

  rec.onend = () => {
    recognizing = false;
    if (interimBubble) {
      interimBubble.remove();
      interimBubble = null;
    }
    // Keep recognition alive while the mic is live.
    if (!micMuted && !micBlocked) {
      setTimeout(() => {
        if (!micMuted && !micBlocked) startRecognition();
      }, 250);
    }
  };

  recognition = rec;
  return rec;
}

function startRecognition() {
  if (micMuted || micBlocked) return;
  const rec = ensureRecognition();
  if (!rec || recognizing) return;
  try {
    rec.start();
    recognizing = true;
  } catch (_) {
    // start() throws if it's already running; ignore.
  }
}

function stopRecognition() {
  if (!recognition) return;
  try {
    recognition.stop();
  } catch (_) {
    /* ignore */
  }
  recognizing = false;
  if (interimBubble) {
    interimBubble.remove();
    interimBubble = null;
  }
}

/* ------------------------------------------------------------------ *
 * The microphone button — the single control (mute / unmute)
 * ------------------------------------------------------------------ */
els.micBtn.addEventListener("click", () => {
  if (!SpeechRecognition) {
    addBubble(
      "error",
      "Voice input isn't available in this browser, but I'll still read pages aloud automatically."
    );
    return;
  }
  if (micBlocked) {
    // Let the user retry granting permission.
    micBlocked = false;
    micMuted = false;
    startRecognition();
    updateStatus();
    return;
  }
  micMuted = !micMuted;
  if (micMuted) stopRecognition();
  else startRecognition();
  updateStatus();
});

if (!SpeechRecognition) {
  els.micBtn.title = "Voice input not supported";
}

/* ------------------------------------------------------------------ *
 * The read-aloud button — mute / unmute Sharon's spoken voice
 * ------------------------------------------------------------------ */
if (els.aloudBtn) {
  els.aloudBtn.addEventListener("click", () => {
    settings.readAloud = !settings.readAloud;
    saveSettings();
    if (!settings.readAloud) stopSpeaking(); // silence her right away
    updateReadAloudUI();
    updateStatus();
  });
}

/* ------------------------------------------------------------------ *
 * Settings view — a clean sheet over the conversation
 * ------------------------------------------------------------------ */
function applySettingsToUI() {
  if (els.autoReadToggle) els.autoReadToggle.checked = !!settings.autoRead;
  if (els.scrollToggle) els.scrollToggle.checked = !!settings.allowScroll;
  if (els.actionsToggle) els.actionsToggle.checked = !!settings.allowActions;
  if (els.confirmToggle) els.confirmToggle.checked = !!settings.confirmActions;
  updateReadAloudUI();
}

// Read the current shortcut Chrome has assigned and show it (or "Not set").
async function refreshShortcut() {
  let label = "Not set";
  try {
    if (chrome.commands && chrome.commands.getAll) {
      const cmds = await chrome.commands.getAll();
      const cmd = (cmds || []).find((c) => c.name === "activate-sharon");
      if (cmd && cmd.shortcut) label = cmd.shortcut;
    }
  } catch (_) {
    /* leave "Not set" */
  }
  if (els.shortcutValue) els.shortcutValue.textContent = label;
}

// While the sheet is open, make the rest of the panel inert so keyboard and
// screen-reader users can't reach the controls hidden behind it.
const backgroundEls = [
  document.querySelector(".header"),
  document.querySelector(".tab-card"),
  document.querySelector(".conversation"),
  document.querySelector(".mic-bar"),
];
function setBackgroundInert(on) {
  for (const el of backgroundEls) {
    if (!el) continue;
    if (on) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }
}

function openSettings() {
  applySettingsToUI();
  refreshShortcut();
  els.settings.hidden = false;
  els.settings.setAttribute("aria-hidden", "false");
  els.settingsBtn.setAttribute("aria-expanded", "true");
  setBackgroundInert(true);
  els.settingsBack.focus();
}

function closeSettings() {
  els.settings.hidden = true;
  els.settings.setAttribute("aria-hidden", "true");
  els.settingsBtn.setAttribute("aria-expanded", "false");
  setBackgroundInert(false);
  els.settingsBtn.focus();
}

if (els.settingsBtn) els.settingsBtn.addEventListener("click", openSettings);
if (els.settingsBack) els.settingsBack.addEventListener("click", closeSettings);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.settings && !els.settings.hidden) {
    closeSettings();
  }
});

if (els.autoReadToggle) {
  els.autoReadToggle.addEventListener("change", () => {
    settings.autoRead = els.autoReadToggle.checked;
    saveSettings();
    if (settings.autoRead) {
      // Turned back on while on a readable page — let her start reading.
      lastReadKey = null;
      evaluateActiveTab();
    } else {
      // Turned off — stay quiet; just refresh the calm status line.
      updateStatus();
    }
  });
}

if (els.scrollToggle) {
  els.scrollToggle.addEventListener("change", () => {
    settings.allowScroll = els.scrollToggle.checked;
    saveSettings();
  });
}

if (els.actionsToggle) {
  els.actionsToggle.addEventListener("change", () => {
    settings.allowActions = els.actionsToggle.checked;
    saveSettings();
    if (!settings.allowActions) cancelAgentTask(); // stop any task in flight
    updateStatus();
  });
}

if (els.confirmToggle) {
  els.confirmToggle.addEventListener("change", () => {
    settings.confirmActions = els.confirmToggle.checked;
    saveSettings();
  });
}

if (els.changeShortcut) {
  els.changeShortcut.addEventListener("click", () => {
    try {
      chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    } catch (_) {
      /* fail quietly */
    }
  });
}

/* ------------------------------------------------------------------ *
 * Activation from the keyboard shortcut — wake the mic if already open
 * ------------------------------------------------------------------ */
if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "sharon-activate") {
      micMuted = false;
      micBlocked = false;
      startRecognition();
      updateStatus();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Follow the user as they switch tabs / pages
 * ------------------------------------------------------------------ */
if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(() => evaluateActiveTab());
}
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
    if (info.status === "complete" && tab && tab.active) evaluateActiveTab();
  });
}

/* ------------------------------------------------------------------ *
 * Boot — the panel is activated: mic goes LIVE and reading starts.
 * ------------------------------------------------------------------ */
(async function init() {
  micMuted = false;
  micBlocked = false;
  await ensureSessionId();
  await loadSettings(); // remembered settings survive closing & reopening
  ready = true; // settings are in — auto-read may now proceed
  applySettingsToUI();
  updateStatus();
  startRecognition(); // mic is live the moment the panel opens
  evaluateActiveTab(); // start reading if we're on a readable page (and allowed)
})();
