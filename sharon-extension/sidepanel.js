// sidepanel.js — Sharon's brains: read the page, talk, listen, speak.

import { PROXY_URL, MAX_PAGE_TEXT } from "./config.js";

/* ------------------------------------------------------------------ *
 * Element references
 * ------------------------------------------------------------------ */
const els = {
  html: document.documentElement,
  status: document.getElementById("status"),
  tabTitle: document.getElementById("tabTitle"),
  tabSite: document.getElementById("tabSite"),
  readPageBtn: document.getElementById("readPageBtn"),
  conversation: document.getElementById("conversation"),
  welcome: document.getElementById("welcome"),
  dock: document.getElementById("dock"),
  playBtn: document.getElementById("playBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  stopBtn: document.getElementById("stopBtn"),
  dockLabel: document.getElementById("dockLabel"),
  composer: document.getElementById("composer"),
  textInput: document.getElementById("textInput"),
  sendBtn: document.getElementById("sendBtn"),
  micBtn: document.getElementById("micBtn"),
};

const RESTRICTED_PREFIXES = [
  "chrome://",
  "edge://",
  "about:",
  "chrome-extension://",
  "moz-extension://",
  "devtools://",
  "view-source:",
];
const RESTRICTED_HOSTS = [
  "chromewebstore.google.com",
  "chrome.google.com", // legacy web store host
  "microsoftedge.microsoft.com",
];

let sessionId = null;
let busy = false; // a request is in flight

/* ------------------------------------------------------------------ *
 * State management — drives the accent colour and chips
 * ------------------------------------------------------------------ */
function setState(state) {
  // state: "idle" | "listening" | "reading"
  els.html.setAttribute("data-state", state);
}
function setStatus(text) {
  els.status.textContent = text;
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
    "bubble " + (role === "user" ? "user" : role === "error" ? "error" : "sharon");
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

/* ------------------------------------------------------------------ *
 * Active tab + page text extraction
 * ------------------------------------------------------------------ */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tab || null;
}

function isRestricted(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  if (RESTRICTED_PREFIXES.some((p) => lower.startsWith(p))) return true;
  try {
    const host = new URL(url).hostname;
    if (RESTRICTED_HOSTS.includes(host)) return true;
  } catch (_) {
    return true;
  }
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
  let text = "";
  const sel = window.getSelection ? window.getSelection().toString().trim() : "";
  if (sel) {
    text = sel;
  } else {
    text = (document.body && document.body.innerText) || "";
  }
  return {
    text: collapse(text),
    title: document.title || "",
    url: location.href,
  };
}

async function readPageContext() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    return { error: "I can't find an active tab right now." };
  }
  if (isRestricted(tab.url)) {
    return {
      restricted: true,
      error:
        "I can't read this kind of page — open me on a normal website and I'll read it for you.",
    };
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
    return {
      restricted: true,
      error:
        "I can't read this kind of page — open me on a normal website and I'll read it for you.",
    };
  }
}

/* ------------------------------------------------------------------ *
 * Tab card — keep it current
 * ------------------------------------------------------------------ */
async function refreshTabCard() {
  const tab = await getActiveTab();
  if (!tab) {
    els.tabTitle.textContent = "No active tab";
    els.tabSite.textContent = "—";
    return;
  }
  els.tabTitle.textContent = tab.title || "Untitled page";
  if (isRestricted(tab.url)) {
    els.tabSite.textContent = "A protected browser page";
    return;
  }
  try {
    els.tabSite.textContent = new URL(tab.url).hostname.replace(/^www\./, "");
  } catch (_) {
    els.tabSite.textContent = tab.url || "—";
  }
}

/* ------------------------------------------------------------------ *
 * Talking to the proxy
 * ------------------------------------------------------------------ */
async function askSharon(question, ctx) {
  const id = await ensureSessionId();
  const body = {
    action: "chat",
    messages: [{ role: "user", content: question }],
    page_text: ctx.text || "",
    page_title: ctx.title || "",
    page_url: ctx.url || "",
    session_id: id,
  };

  // IMPORTANT: text/plain avoids the CORS preflight that Apps Script can't
  // answer. Do NOT switch this to application/json and add no other headers.
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(body),
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
 * The main send path — shared by Read-page, voice, and typed input
 * ------------------------------------------------------------------ */
async function handleQuestion(question, { speak = true } = {}) {
  if (busy) return;
  question = (question || "").trim();
  if (!question) return;

  busy = true;
  setBusyUI(true);
  setStatus("Reading the page…");

  const ctx = await readPageContext();
  if (ctx.restricted || (ctx.error && !ctx.text)) {
    addBubble("error", ctx.error);
    setStatus("Ready when you are.");
    setState("idle");
    busy = false;
    setBusyUI(false);
    return;
  }

  setStatus("Sharon is thinking…");
  const typing = showTyping();

  try {
    const data = await askSharon(question, ctx);
    typing.remove();

    if (data && data.ok) {
      const bubble = addBubble("sharon", data.reply || "(no reply)");
      addSources(bubble, data.sources);
      setStatus("Here's what I found.");
      if (speak && data.reply) speakText(data.reply);
      else setState("idle");
    } else {
      const msg =
        (data && data.error) || "something went wrong with that request.";
      addBubble("error", "Sharon hit a snag: " + msg);
      setStatus("Ready when you are.");
      setState("idle");
    }
  } catch (err) {
    typing.remove();
    addBubble(
      "error",
      "Sharon hit a snag: " +
        (err && err.message
          ? err.message
          : "I couldn't reach the server. Check your connection and try again.")
    );
    setStatus("Ready when you are.");
    setState("idle");
  } finally {
    busy = false;
    setBusyUI(false);
  }
}

function setBusyUI(isBusy) {
  els.readPageBtn.disabled = isBusy;
  els.sendBtn.disabled = isBusy;
}

/* ------------------------------------------------------------------ *
 * Speech synthesis (reading aloud) with play / pause / stop
 * ------------------------------------------------------------------ */
const synth = window.speechSynthesis;
let currentUtterance = null;

function pickEnglishVoice() {
  if (!synth) return null;
  const voices = synth.getVoices() || [];
  if (!voices.length) return null;
  return (
    voices.find((v) => /^en[-_]US/i.test(v.lang) && /female|Samantha|Google US/i.test(v.name)) ||
    voices.find((v) => /^en[-_]US/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    voices[0]
  );
}

function showDock(label) {
  els.dock.hidden = false;
  els.dockLabel.textContent = label;
}
function hideDock() {
  els.dock.hidden = true;
}

function speakText(text) {
  if (!synth) {
    // No speech support — just leave the answer on screen.
    setState("idle");
    return;
  }
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
    setState("reading");
    showDock("Reading aloud…");
  };
  utt.onresume = () => {
    setState("reading");
    showDock("Reading aloud…");
  };
  utt.onpause = () => {
    showDock("Paused");
  };
  const finish = () => {
    setState("idle");
    setStatus("Ready when you are.");
    hideDock();
    currentUtterance = null;
  };
  utt.onend = finish;
  utt.onerror = finish;

  currentUtterance = utt;
  synth.speak(utt);
}

// Voices can load asynchronously; warm them up.
if (synth) {
  synth.onvoiceschanged = () => pickEnglishVoice();
}

els.playBtn.addEventListener("click", () => {
  if (!synth) return;
  if (synth.paused) {
    synth.resume();
  } else if (!synth.speaking && currentUtterance) {
    // Re-speak the last answer from the top.
    speakText(currentUtterance.text);
  }
});
els.pauseBtn.addEventListener("click", () => {
  if (synth && synth.speaking && !synth.paused) synth.pause();
});
els.stopBtn.addEventListener("click", () => {
  if (synth) synth.cancel();
  setState("idle");
  setStatus("Ready when you are.");
  hideDock();
});

/* ------------------------------------------------------------------ *
 * Speech recognition (listening)
 * ------------------------------------------------------------------ */
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;
let interimBubble = null;

function initRecognition() {
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    listening = true;
    setState("listening");
    setStatus("Listening… speak now.");
    els.micBtn.classList.add("active");
    interimBubble = null;
  };

  rec.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += transcript;
      else interim += transcript;
    }
    const shown = (final || interim).trim();
    if (shown) {
      if (!interimBubble) {
        interimBubble = addBubble("user", shown, { interim: true });
      } else {
        interimBubble.textContent = shown;
        scrollToBottom();
      }
    }
    if (final.trim()) {
      const text = final.trim();
      if (interimBubble) {
        interimBubble.textContent = text;
        interimBubble.classList.remove("interim");
        interimBubble = null;
      }
      // Finalised: ask Sharon.
      stopListening();
      handleQuestion(text, { speak: true });
    }
  };

  rec.onerror = (event) => {
    listening = false;
    els.micBtn.classList.remove("active");
    if (interimBubble) {
      interimBubble.remove();
      interimBubble = null;
    }
    setState("idle");
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      addBubble(
        "error",
        "I couldn't access the microphone. Check the browser's mic permission, or just type your question below."
      );
      setStatus("Mic blocked — type instead.");
    } else if (event.error === "no-speech") {
      setStatus("I didn't catch that. Try again.");
    } else {
      setStatus("Ready when you are.");
    }
  };

  rec.onend = () => {
    listening = false;
    els.micBtn.classList.remove("active");
    if (els.html.getAttribute("data-state") === "listening") setState("idle");
  };

  return rec;
}

function startListening() {
  if (!SpeechRecognition) {
    addBubble(
      "error",
      "Voice input isn't available in this browser. You can type your question below instead."
    );
    return;
  }
  if (busy) return;
  if (synth) synth.cancel(); // don't talk over the user
  hideDock();
  if (!recognition) recognition = initRecognition();
  try {
    recognition.start();
  } catch (_) {
    // start() throws if already started; ignore.
  }
}

function stopListening() {
  if (recognition && listening) {
    try {
      recognition.stop();
    } catch (_) {
      /* ignore */
    }
  }
}

els.micBtn.addEventListener("click", () => {
  if (listening) stopListening();
  else startListening();
});

if (!SpeechRecognition) {
  els.micBtn.title = "Voice input not supported — type instead";
}

/* ------------------------------------------------------------------ *
 * Buttons & form wiring
 * ------------------------------------------------------------------ */
els.readPageBtn.addEventListener("click", () => {
  handleQuestion("Please read and summarize this page for me.", { speak: true });
});

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.textInput.value.trim();
  if (!text) return;
  els.textInput.value = "";
  addBubble("user", text);
  handleQuestion(text, { speak: true });
});

/* ------------------------------------------------------------------ *
 * Keep the tab card fresh as the user moves around
 * ------------------------------------------------------------------ */
if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(refreshTabCard);
}
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === "complete" || info.title) refreshTabCard();
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
(async function init() {
  setState("idle");
  await ensureSessionId();
  await refreshTabCard();
})();
