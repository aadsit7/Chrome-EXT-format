Sharon — a voice assistant for your browser side panel  (v7.5.0)
================================================================

Sharon is a hands-free voice assistant that lives in Chrome/Edge's side panel.
She listens the whole time, holds a real back-and-forth conversation (she
remembers what you both just said), reads whatever is on your current tab,
and — when you allow it — clicks, types, and acts on the page for you.

Her long-term memory is your "Speaking Assistant" Google Sheet. She doesn't
just write notes to it: she reads it, updates it, and summarizes it, all by
voice, because the AI itself decides when to use the database:

  "Make a note that the proposal is due Friday."     → saved to the Sheet
  "Remind me to send the invoice tomorrow."          → saved as a task
  "What notes do I have about the Johnson account?"  → searches the Sheet
  "I finished the invoice task."                     → marks it done
  "Summarize my open tasks."                         → reads + summarizes
  "What did we talk about earlier?"                  → real conversation memory

She never interrupts you: the moment you start talking while she's reading,
she holds her voice and listens. If it was just a cough or her own echo she
quietly resumes; if you actually said something, she stops and answers.

The AI provider key is NEVER inside the extension. Sharon sends each turn to
your Google Apps Script web app (backend/Code.gs in this folder), which holds
the secret key, calls the model WITH TOOLS (save/search/update/summarize
memory, act on page), executes the database tools against the Sheet, and
returns one combined answer. One round trip per turn keeps her fast.


What's new in v7.5.0 — sections, a quick-note mic, Notes up front
-----------------------------------------------------------------
- Notes opens first: the pencil button now sits at the far LEFT of the mode
  bar, and the panel opens straight into the Notes list (the first-run
  welcome still wins on a brand-new install). The moment you actually talk
  or type to Sharon, the panel flips back to the conversation on its own —
  her replies are never hidden behind the notes.
- Named, collapsible sections: tap "+ New section" to create one, pick a
  section from the dropdown when you save a note (next to the quick-note
  mic, and inside the editor to move an existing note), and the list shows
  one fold-open group per section — tap a header to collapse or expand it,
  and Sharon remembers which ones you keep closed. Notes without a section
  live under "Unsorted", always at the bottom. Sections are stored in the
  "project" column your memory_log tab already has, and the list now loads
  up to 500 notes (it used to stop at 25).
- A second dictation mic on the LIST screen, right under the quick-note box:
  tap it and speak, and the words type into the box at your cursor — same
  dictation engine as the editor's mic, so Sharon stays quiet and her normal
  listening picks back up exactly where it was when you stop.

  *** REQUIRED STEP — RE-DEPLOY THE BACKEND, or sections will NOT save ***
  1. Open your "Speaking Assistant" Sheet → Extensions → Apps Script.
  2. Paste the new backend/Code.gs from this folder over the project's code.
  3. Deploy → Manage deployments → edit (pencil) → Version: "New version"
     → Deploy. (Pasting alone is not enough — /exec serves the version
     pinned to the deployment. The URL does not change.)
  4. Confirm the memory_log tab has a "project" column in its header row
     (row 1). It's part of the standard Speaking Assistant sheet; if yours
     is missing it, add a header cell named exactly  project .
  Until then the panel shows a dismissible notice in Notes and everything
  except saving sections keeps working.


What's new in v7.4.0 — the Notes tab
------------------------------------
- A new pencil button in the bottom mode bar opens Notes: a simple notes app
  right in the side panel. Browse every saved note newest-first, copy any
  note with one tap, and paste or type a new note up top (the first line
  becomes its title). Tap a row to edit the title and body, copy the note,
  or hit the mic and dictate straight into it — Sharon's normal listening
  pauses while you dictate and picks back up exactly where it was.
- REMINDER: redeploy backend/Code.gs once (Sheet → Extensions → Apps Script,
  paste the latest Code.gs, then Deploy → Manage deployments → edit →
  Version: "New version" → Deploy) so the panel can CREATE notes directly.
  Browsing, copying, and editing notes work against your existing deployment.


What's new in v7 (the big overhaul)
-----------------------------------
- Real conversation: the last dozen exchanges ride along with every request,
  and the thread is restored from the Sheet when you reopen the panel. Ask
  follow-ups, use "it/that", correct her — she keeps up.
- Turn-taking: Sharon yields the instant you speak and never starts talking
  while you're mid-sentence. Interrupting her is natural, not a fight.
- The model drives the database. No more brittle "magic phrases" — she
  understands "jot that down", "actually mark that finished", "what's still
  open from this week?", "give me a rundown of my notes about pricing".
- Update & complete: tasks can be marked done / reopened / deleted by voice
  or with the new buttons in the Notes sheet.
- Summaries on demand: "summarize my notes / my open tasks / what we
  discussed" produces a short spoken rundown composed from the Sheet.
- Faster: one HTTP round trip per turn (it used to take up to three), a
  trimmed page excerpt, a short-lived page-snapshot cache, and both turns
  logged to the Sheet in a single batched write.
- The backend now ships IN THIS REPO (backend/Code.gs) so you can upgrade or
  audit it any time.
- The code is split into clean modules: api.js (server), page.js (the tab),
  speech.js (ears + voice), ui.js (cards), sidepanel.js (the conductor).


Backend setup (one-time — do this before Sharon will work)
-----------------------------------------------------------
1. Open your "Speaking Assistant" Google Sheet → Extensions → Apps Script.
2. Replace the project's code with the contents of  backend/Code.gs .
3. In Project Settings → Script Properties, set:
     API_KEY            — any secret string (must match config.js)
     ANTHROPIC_API_KEY  — your Anthropic API key
     MODEL              — optional (defaults to claude-opus-4-8)
     SPREADSHEET_ID     — only if the script is NOT bound to the Sheet
4. Deploy → New deployment → Web app:
     "Execute as: me"   and   "Who has access: Anyone".
   (Apps Script web apps can't answer a CORS preflight, which is why Sharon
   always sends text/plain and never application/json.)
5. Copy the /exec URL into PROXY_URL in config.js, and put the same secret
   into API_KEY there. USER_ID / ASSISTANT_ID should match real rows in the
   Sheet's "users" and "assistants" tabs.

The Sheet needs these tabs (they already exist in Speaking Assistant):
  users, assistants, sessions, conversation_turns, memory_log


How to load Sharon (for first-timers)
-------------------------------------
1. Go to  chrome://extensions  (or  edge://extensions ).
2. Turn on "Developer mode".
3. Click "Load unpacked" and choose THIS folder (sharon-extension).
4. Pin the coral Sharon icon from the puzzle-piece menu, click it, and the
   panel slides out. Allow the microphone the first time.


How to talk to her
------------------
Open any normal website and just speak. What you say lands in an editable
"You said" card — tap it to fix anything, or let it send itself after a
moment so you stay hands-free.

Instant commands (handled locally, zero delay):
  "stop" / "be quiet"      stop her voice
  "pause" / "resume"       control the reading
  "scroll down/up", "go to the top/bottom", "read more"

Everything else goes to the brain, which decides on its own whether to:
  answer about the page  ·  hold a conversation  ·  save a note or task  ·
  search your notes  ·  mark something done  ·  summarize the database  ·
  act on the page (only when allowed in Settings)

While she reads a page or answer aloud, just start talking — she'll stop.


Settings (the gear in the dock)
-------------------------------
- "Read pages to me automatically" (on) — she reads each page as you switch
  tabs. Turn off and she stays quiet until you ask.
- "Sharon's voice" + speed — pick the read-aloud voice; Auto picks the most
  natural one your browser offers. Preview button included.
- "Let Sharon scroll the page" (on) — approves the scroll commands.
- "Let Sharon act on the page" (OFF) — the big one: with it on she can click,
  type, and select to carry out tasks ("reply and say I'll be there",
  "search for blue shoes"). She works in small confirmed steps, never types
  passwords or payment details, and "stop" halts her instantly.
    - "Ask me before each action" (on) — she describes what she's about to do
      and waits for your spoken "yes".
- Keyboard shortcut — Ctrl+Shift+Y (Cmd+Shift+Y on Mac) opens Sharon with the
  mic live; change it from Chrome's own shortcuts page.


Notes (the notebook in the dock)
--------------------------------
Browse and search everything she's saved. Tasks show a Done/Reopen button,
and anything can be deleted. It's the same memory_log tab in your Sheet —
edits here write straight back to the database.


Record your screen (the monitor button in the mode bar)
-------------------------------------------------------
Tap the "Record your screen" button, pick a screen/window/tab in Chrome's own
picker, and Sharon records the current desktop — the screen video and its own
system/desktop audio, up to 30 minutes. It records STRICTLY the desktop: it
never opens your microphone, so other apps keep full, undisrupted mic access
while you record. When you stop, the finished .webm downloads straight to your
computer — screen recordings stay on your device and are NOT sent to Drive or
your Sheet.

The recording runs in the background, so you can collapse the side panel and it
keeps going — a red dot appears on Sharon's toolbar icon while it records (amber
while paused). Click the icon to reopen the panel and stop it whenever you like.

Keyboard shortcuts control it without opening the panel at all:
  - Start / stop screen recording  — Ctrl+Shift+9 (Cmd+Shift+9 on Mac)
  - Pause / resume screen recording — Ctrl+Shift+8 (Cmd+Shift+8 on Mac)
Both are listed in Settings, next to the "Launch Sharon" shortcut, and you can
rebind any of them from Chrome's own shortcuts page.

After a screen recording stops, Sharon shows a preview with an iPhone-Photos-
style trim slider: drag the start and end handles to keep just part of the
clip, then Save — or Save without moving them to keep the whole clip. Trimming
is optional, and either way the video downloads to your computer.


Troubleshooting
---------------
- "unknown action: assist" — your Apps Script DEPLOYMENT is older than the
  code. Pasting new code into the editor is not enough: the /exec URL serves
  the version pinned to the deployment. Open the Sheet → Extensions → Apps
  Script, paste the latest backend/Code.gs, then Deploy → Manage deployments
  → edit (pencil) → Version: "New version" → Deploy. The URL doesn't change.
- "Sharon hit a snag…" — the server reported a problem. Check that PROXY_URL
  and API_KEY in config.js match the deployment, and that the Script
  Properties are set. Redeploy the web app after any Code.gs change.
- She loads but never hears you — check the browser's microphone permission
  for the extension, then tap the mic.
- Only true browser pages (chrome://, edge://, the web store, extension
  pages) are unreadable; every http/https website works.
