Sharon — a voice assistant for your browser side panel
======================================================

Sharon reads the web page you're on out loud, all on her own, and listens for
your voice the whole time so you can talk to her hands-free. She works in both
Google Chrome and Microsoft Edge. There is no API key inside the extension —
Sharon sends the page text and your spoken instructions to a server that does
the AI part.

Sharon is a read-only voice reader for whatever is on your current tab. She
only ever works with the single active tab in the current window, and she only
reads what is actually visible there right now. She never reads other tabs,
never navigates, and never clicks or opens anything. It isn't just for
articles — if an email, document, message, thread, or post is open on screen,
she reads that too. Because you click around the page yourself, every time you
ask her something she re-reads the tab fresh, so she's always answering about
what's on screen at that moment. She answers only from what's actually on the
page: if something isn't there — say you ask about an email while only your
list of messages is showing — she'll tell you what she can see and ask you to
open it yourself rather than guess.


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
     - Say anything else, like "just give me the key points" or "what does it
       say about pricing?", and she'll pause, take your instruction, and read
       you the answer.
6. The big microphone at the bottom is the only control. Tap it to mute
   (it turns grey with a slash and stops listening); tap again to go live
   (coral with a soft pulse). When muted, Sharon just reads and ignores you.
7. Open a protected page like  chrome://settings  — instead of breaking, she
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
