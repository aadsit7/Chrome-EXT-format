Sharon — a voice assistant for your browser side panel
======================================================

Sharon reads the page you're on, listens to your questions, answers them,
and reads the answers back to you out loud. She works in both Google Chrome
and Microsoft Edge. There is no API key inside the extension — Sharon sends
your question and the page text to a server that does the AI part.


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
3. Click "Read this page". Sharon summarizes the page and reads it aloud.
4. Click the round coral microphone button and ask, out loud,
   "What is this page about?" Your words appear in the conversation and
   Sharon answers and reads the answer aloud.
5. Or just type a question in the box at the bottom and press the send arrow.
6. While she's reading, use the play / pause / stop buttons to control the
   voice.
7. Try her on a protected page like  chrome://settings  — she'll politely
   tell you she can't read that kind of page instead of breaking.


Notes
-----
- Sharon only reads a page after you click. Nothing is sent before that.
- The microphone uses your browser's built-in speech recognition. The first
  time, your browser may ask for microphone permission — click Allow.
  If voice isn't available, just type your question instead.
- If you ever see "Sharon hit a snag…", it just means the server reported a
  problem; try again in a moment.
