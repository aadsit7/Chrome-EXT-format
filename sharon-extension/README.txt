Sharon — a voice assistant for your browser side panel
======================================================

Sharon reads the web page you're on out loud, all on her own, and listens for
your voice the whole time so you can talk to her hands-free. She works in both
Google Chrome and Microsoft Edge. There is no API key inside the extension —
Sharon sends the page text and your spoken instructions to a server that does
the AI part.


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
