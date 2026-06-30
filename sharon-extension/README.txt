Sharon — a voice assistant for your browser side panel  (v6.0.0)
================================================================

Sharon reads the web page you're on out loud, all on her own, and listens for
your voice the whole time so you can talk to her hands-free. She works in both
Google Chrome and Microsoft Edge. The AI provider key is NEVER inside the
extension — Sharon sends the page text and your spoken instructions to your
Google Apps Script web app ("Speaking_Assistant"), which holds the secret key,
calls the model, and reads/writes her two-layer memory.

She now has memory. As you talk, Sharon logs the conversation, and when you ask
her to "make a note" or "remember" something she distills it into a notes/tasks
store. Later you can ask "what notes do I have about X" or open the Notes sheet
(the notebook icon in the bottom dock) to search everything she's saved.


Backend setup (one-time — you must do this before Sharon will work)
-------------------------------------------------------------------
Sharon talks to a Google Apps Script web app that fronts your "Speaking_Assistant"
Google Sheet. Open config.js and paste in your own values:

  PROXY_URL    — your Apps Script Web App /exec URL.  (ships as a placeholder)
  API_KEY      — must MATCH the Script Property named API_KEY in that Apps
                 Script project.                       (ships as a placeholder)
  USER_ID      — "usr_aaron"  (a real row in the Sheet's "users" tab)
  ASSISTANT_ID — "asst_sharon" (a real row in the Sheet's "assistants" tab)

USER_ID and ASSISTANT_ID are sent on every call so memory recall matches your
data — leave them as-is unless your Sheet uses different ids.

In the Apps Script project itself:
  - Set two Script Properties:  API_KEY  (same string as config.js) and
    ANTHROPIC_API_KEY  (your model provider key — never goes in the extension).
  - Deploy as a Web App with  "Execute as: me"  and  "Who has access: Anyone".
    (Apps Script web apps can't answer a CORS preflight, which is why Sharon
    always sends text/plain and never application/json.)

Until PROXY_URL and API_KEY are filled in, Sharon's panel loads and listens,
but every request comes back as "Sharon hit a snag…".

Sharon is a voice assistant for whatever is on your current tab. She only ever
works with the single active tab in the current window, and she only reads what
is actually visible there right now; she never touches your other tabs. By
default she's a reader and won't click or type anything. Two opt-in settings let
her do more on that one tab: "Let Sharon scroll the page" lets her scroll on
command ("scroll down", "go to the top/bottom", "read more") so you can work
through a long article or thread, and "Let Sharon act on the page" lets her
click, type, and select to actually carry out tasks you ask for — both are off
or limited until you turn them on. It isn't just for articles — if an email,
document, message, thread, or post is open on screen, she reads that too.
Because you click around the page yourself, every time you ask her something she
re-reads the tab fresh, so she's always answering about what's on screen at that
moment. She answers only from what's actually on the page: if something isn't
there — say you ask about an email while only your list of messages is showing —
she'll tell you what she can see and offer to scroll for more or ask you to open
it yourself rather than guess.


How to load Sharon (for first-timers)
-------------------------------------
1. Open your browser and go to the extensions page:
     - Chrome: type  chrome://extensions  in the address bar and press Enter.
     - Edge:   type  edge://extensions    in the address bar and press Enter.
2. Turn on "Developer mode" (a switch in the top-right corner on Chrome,
   or in the left sidebar on Edge).
3. Click "Load unpacked".
4. Choose THIS folder (the one named "sharon-extension" that contains
   manifest.json).
5. You'll see a coral Sharon icon appear in your toolbar. If you don't see
   it, click the little puzzle-piece icon and pin Sharon.


How to test her
---------------
1. Open a normal article or web page (not a browser settings page).
2. Click the Sharon icon in your toolbar — her panel slides out on the side.
   The first time, your browser may ask for microphone permission — click
   Allow. (If you don't, Sharon will still read pages; she just won't hear you.)
3. Sharon starts reading the page aloud on her own. You don't press anything.
   She opens with a quick one- or two-sentence overview of what the page is
   about (shown as an emphasized line at the top of her answer), then reads the
   important parts and skips menus, ads, and other boilerplate. On a nearly
   empty page she just says briefly what little is there.
4. Switch to another article tab — Sharon follows you and starts reading the
   new page automatically.
5. While she's reading, just talk:
     - Say "stop" to stop reading.
     - Say "pause" and "resume" to control the voice.
     - Say "scroll down", "scroll up", "go to the top", "go to the bottom", or
       "read more", and (when scrolling is allowed in Settings) she'll scroll
       the page and read what's now in view — great for reading further down a
       long article or message thread.
     - Say anything else, like "just give me the key points" or "what does it
       say about pricing?", and she'll pause, take your instruction, and read
       you the answer.
6. The bottom dock has four controls. The big coral microphone in the middle
   (and the large breathing orb up top) start/stop listening: tap to mute (the
   orb shows a slash and stops listening); tap again to go live. Tapping while
   she's reading simply stops her (a barge-in). The "Voice" button on the left
   mutes/unmutes Sharon's own spoken voice: tap to silence her reading aloud
   (her answers still appear on screen); tap again to let her speak. Your choice
   is remembered after you close and reopen. "Notes" opens your saved notes and
   "Settings" opens the settings sheet.
7. When you talk, Sharon writes down what she heard in an editable card. You can
   tap the text to fix anything before it's sent; otherwise it sends itself
   after a moment so you stay hands-free. Quick commands — "stop", "pause",
   "resume", "scroll down", and yes/no answers — still fire instantly and skip
   the card.
8. Saving and recalling notes:
     - Say "make a note that the proposal is due Friday" (or "remember…",
       "remind me to…") and Sharon saves it; a green "Saved to your notes" card
       confirms it.
     - Say "what notes do I have about the proposal" (or "look up…", "search my
       notes…") and she reads back what she finds and shows a blue results card.
     - Tap "Notes" in the dock to browse and search everything she's saved.
9. Open a protected page like  chrome://settings  — instead of breaking, she
   shows a calm "Open a website and I'll start reading" line and begins again
   the moment you switch to a real website.


Settings (the gear in the top-right)
------------------------------------
Click the small gear icon in Sharon's header to open Settings. A clean sheet
slides over the conversation; the back arrow returns you to it. Your settings
are remembered, so they stay the way you left them after you close and reopen
the panel.

- "Let Sharon read what's on my screen automatically." (on by default)
  When ON, Sharon reads each page on her own and follows you as you switch
  tabs — her usual behavior. When OFF, she stays quiet: she won't read or send
  any page text on her own. The mic stays live and the header says "Ask me to
  read this page" — just say "read this page" or ask a question about it and
  she'll read or answer then.

- "Let Sharon act on the page (click & type)." (OFF by default)
  This is the big one: with it on, Sharon can actually operate the page for you,
  not just read it. Ask her to do something — "reply and say I'll be there",
  "search for blue shoes", "open the first result", "tick the agree box" — and
  she works toward it one small step at a time: she looks at the buttons, links,
  and text boxes on the page, decides the next action, and clicks / types /
  scrolls to do it, then looks again and continues until it's done. Because this
  is powerful, it ships turned off; turn it on only when you want it. Sharon will
  never type or submit passwords, card numbers, or security codes. Say "stop" at
  any time to halt her.

    - "Ask me before each action." (on by default, shown under the setting above)
      When on, Sharon says what she's about to do and waits for you to say "yes"
      before she clicks or types; say "no" to cancel. Turn it off to let her act
      without asking each time. She still stops the moment you say "stop".

    Notes on acting: Sharon takes a limited number of steps per request before
    pausing so she can't run away with a task — just tell her to continue. She
    acts only on the one active tab, the same one she reads. This works best on
    ordinary pages; very complex web apps may not always expose a button or field
    in a way she can find, and she'll tell you when she can't.

- "Let Sharon scroll the page for me." (on by default)
  This is the slider that approves Sharon's one page action. When ON, you can
  say "scroll down", "scroll up", "go to the top/bottom", or "read more" and she
  scrolls the active tab and reads whatever comes into view — useful for moving
  further down a long article or message thread. When OFF, she never touches the
  page: she stays a pure reader and, if you ask her to scroll, she'll tell you
  it's switched off. Your choice is remembered after you close and reopen.

- Keyboard shortcut. Settings shows the current shortcut for launching Sharon
  (Ctrl+Shift+Y on Windows/Linux, Command+Shift+Y on Mac by default), or
  "Not set". The "Change shortcut" button opens Chrome's own shortcuts page —
  Chrome handles shortcut changes there, an extension can't assign its own key.
  Press the shortcut anywhere and Sharon's side panel opens with the mic live.


Notes
-----
- Sharon cleans the page before reading: she pulls out the main content
  (article / main region) and drops navigation, headers, footers, sidebars,
  cookie/consent banners, ads, comments, and other repetitive boilerplate.
- A normal http:// or https:// website is always readable. Only true browser
  pages (chrome://, edge://, about:, extension pages, devtools) and the web
  store are treated as "nothing to read".
- The microphone uses your browser's built-in speech recognition. While Sharon
  is talking she ignores her own voice, so only your interruptions count.
- If you ever see "Sharon hit a snag…", it just means the server reported a
  problem; switch tabs or speak again in a moment.
