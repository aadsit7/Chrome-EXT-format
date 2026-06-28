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
  // Settings
  settingsBtn: document.getElementById("settingsBtn"),
  settings: document.getElementById("settings"),
  settingsBack: document.getElementById("settingsBack"),
  autoReadToggle: document.getElementById("autoReadToggle"),
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
  "3. You cannot click, scroll, open, or navigate anything. If the user asks " +
  "for something that isn't in the page content — for example what's inside an " +
  "email while only a list of messages is visible — say plainly what you can " +
  "see and ask them to open it themselves, for example: \"I can see your list " +
  "of messages but not what's inside them. Open the one you want and I'll read " +
  "and summarize it.\"\n" +
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
function handleUserUtterance(text) {
  text = (text || "").trim();
  if (!text) return;
  // While Sharon is talking, ignore the mic echoing her own voice.
  if (speaking && isEchoOfSpeech(text)) return;

  const cmd = text
    .toLowerCase()
    .replace(/[.!?,]+$/g, "")
    .trim();

  if (cmd === "stop" || cmd === "stop reading" || cmd === "be quiet" || cmd === "quiet") {
    addBubble("user", text);
    stopSpeaking();
    updateStatus();
    return;
  }
  if (cmd === "pause") {
    addBubble("user", text);
    pauseSpeaking();
    return;
  }
  if (cmd === "resume" || cmd === "continue" || cmd === "keep going") {
    addBubble("user", text);
    resumeSpeaking();
    return;
  }

  // Anything else is an instruction about what to read or focus on.
  addBubble("user", text);
  if (speaking) stopSpeaking(); // barge-in: pause the reading first
  sendInstruction(text, { remember: true });
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
 * Settings view — a clean sheet over the conversation
 * ------------------------------------------------------------------ */
function applySettingsToUI() {
  if (els.autoReadToggle) els.autoReadToggle.checked = !!settings.autoRead;
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
