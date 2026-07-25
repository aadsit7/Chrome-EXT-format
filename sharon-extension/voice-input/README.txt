Voice Input Overlay — a microphone button inside any text field
===============================================================

What this module does
---------------------
Click into any ordinary text box on any website and a small microphone button
appears just inside the box's right edge. Tap it, say what you want to write,
and your words are typed into that box at the cursor. Tap it again to stop.
The button turns red while it is listening.

It works in:

  <input> boxes of type text, search, email, url and tel
  <textarea> boxes
  anything marked contenteditable="true" (Gmail's message body, most editors)

It deliberately NEVER appears on a password field.

Four quiet details that make it actually work on real websites:

  • Your words always come out left to right, in the order you said them.
    The module keeps its own cursor for the length of a dictation: it starts
    where your cursor was, moves along by exactly what it typed, and hands
    control back only when YOU move the cursor (a click, a key, a selection).
    Websites move the cursor constantly — a React re-render puts it back at
    the start, an unfocused box reports position zero, rich editors reset it
    whenever they tidy their markup — and any of those will scramble phrases
    into reverse order if you trust the page. This one doesn't.
  • Spacing is written the way a person types: one space between phrases and
    never two, no space before a comma or a full stop, no space after an
    opening bracket, a capital letter to start the field and to start each new
    sentence, and a space kept in front of whatever the cursor sat before.
    Email and web-address boxes are left exactly as spoken.
  • The button lives inside a shadow DOM, so the website's own CSS cannot
    restyle it and its CSS cannot leak into the website.
  • After typing your words in, it fires both an "input" event and a "change"
    event. React, Vue and Gmail throw away text that arrives without them.

It follows the field as you scroll and resize, and disappears the moment you
click away or the field is removed from the page.


Site access — "On all sites" is the default
--------------------------------------------
Right-click the extension icon → "This can read and change site data" offers
three choices: "When you click the extension", "On <this site>", and "On all
sites". Sharon installs with ON ALL SITES already selected, and nothing needs
to be turned on by hand.

That default is not a setting stored anywhere — Chrome decides it from the
manifest, and two things there produce it:

  "host_permissions": ["http://*/*", "https://*/*"]   ← REQUIRED, not optional
  "content_scripts": [{ "matches": ["http://*/*", "https://*/*"], … }]

Because the host permissions are required rather than optional, Chrome grants
them at install time and the toggle lands on "On all sites". (Had they been
listed under "optional_host_permissions", or had the extension relied on
"activeTab" alone, the default would be "When you click the extension" and
the microphone button would only appear after clicking the icon on each site.)

The content script also carries:

  "all_frames": true              every frame on the page, not just the top one
  "match_about_blank": true       text boxes inside about:blank / srcdoc frames
  "match_origin_as_fallback": true  …and the other frame types editors use

Those three are what make the button show up inside rich-text editors that
build their editing area in an iframe (TinyMCE, CKEditor, a lot of webmail and
ticketing tools) instead of only in plain page text boxes.

If someone has since narrowed the access by hand, put it back the same way:
right-click Sharon's icon → This can read and change site data → On all sites.
Chrome remembers that per extension; reloading the unpacked folder does not
reset it.

A note on what is NOT requested: "<all_urls>" is deliberately absent.
"http://*/*" plus "https://*/*" already covers every ordinary website, and
adding "<all_urls>" would only widen the install warning. Chrome pages
(chrome://…, the Web Store) are off limits to every extension, so the button
will never appear there — that is Chrome's rule, not a setting.

It fails quietly. If speech recognition is unavailable, or the microphone has
not been allowed, the button shows two words for two seconds and stops. It
never fills the website's console with errors.


How it fits into Sharon
-----------------------
This module owns no microphone and no background page of its own. It borrows
three things Sharon already has:

  • her ONE hidden offscreen document (offscreen.html) — the speech engine
    (recognizer.js) is added to it as a second script;
  • her background service worker (background.js) — it relays messages;
  • her microphone permission — Sharon asks for it in her first-run setup and
    in Settings, so this module never asks for anything.

Sharon does exactly one thing at a time (mode.js). So:

  • While you dictate into a web page, Sharon stops listening and stops
    speaking (she enters a new DICTATING mode) and her status line reads
    "Dictating on the page". When you stop, she goes back to listening exactly
    as she was.
  • If her side panel is closed there is nothing to coordinate — dictation
    just happens.
  • If she is in the middle of a voice recording or a screen recording, the
    request is REFUSED: the button says "Busy recording" for two seconds and
    nothing else happens. A recording in progress is never interrupted.

Every message this module sends is prefixed "vi:" so it can never be confused
with Sharon's own messages ("sr:" for the screen recorder).


Files in this folder
--------------------
  overlay.js      the content script that runs inside web pages: finds the
                  focused field, draws the button, inserts the text
  overlay.css     the button's styles (loaded into the shadow root)
  recognizer.js   the speech engine, running inside Sharon's hidden page
  README.txt      this file


==================================================================
Repeating this in a different extension
==================================================================
Copy the whole voice-input/ folder in, then make these five edits.


1. manifest.json — exactly these two new top-level keys were added
------------------------------------------------------------------
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": ["voice-input/overlay.js"],
      "run_at": "document_idle",
      "all_frames": true
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["voice-input/overlay.css"],
      "matches": ["http://*/*", "https://*/*"]
    }
  ],

The version number was also bumped (7.6.0 → 7.7.0).

Nothing else in the manifest changed. In particular:
  • "offscreen" was ALREADY in permissions — do not add it twice.
  • "http://*/*" and "https://*/*" were ALREADY in host_permissions — that is
    every site this module needs. Do NOT add "<all_urls>"; it would show the
    user a new permission warning and buy nothing.

NARROWING THE SITE LIST: "matches" above means "every website". To limit the
microphone button to a few sites, replace the list in BOTH keys with the sites
you want, for example:

  "matches": ["https://mail.google.com/*", "https://*.salesforce.com/*"]

Keep the two lists the same, otherwise the button loads on a page whose CSS
file it is not allowed to fetch, and it will look unstyled.


2. background.js — the shared hidden page and the message relay
---------------------------------------------------------------
  a) In the existing ensureOffscreen(), the reasons array changed from
       reasons: ["DISPLAY_MEDIA"]
     to
       reasons: ["DISPLAY_MEDIA", "USER_MEDIA"]
     and the justification string now mentions both screen recording and
     speech-to-text. NO second ensureOffscreen() was written, and
     chrome.offscreen.createDocument() is still called in exactly one place.

  b) Closing the hidden page is now reference counted. Added next to
     closeOffscreen():
       const offscreenUsers = new Set();
       acquireOffscreen(user)  — adds the user, then calls ensureOffscreen()
       releaseOffscreen(user)  — removes the user; closes the document only
                                 when the set is empty AND the recognizer says
                                 it is not live (which survives the service
                                 worker being suspended and restarted)
     The three existing call sites changed:
       ensureOffscreen()  → acquireOffscreen("screenrec")   (two start paths)
       closeOffscreen()   → releaseOffscreen("screenrec")   (the "clear" path)
     Result: ending a screen recording can no longer close the page out from
     under a dictation in progress.

  c) A NEW, separate chrome.runtime.onMessage listener was appended for the
     "vi:" namespace, plus the helpers dictationLive(), tellSharon(),
     toOverlay(), startDictation() and stopDictation(). It handles:
       vi:start      from the page   → ask the side panel, then start the
                                       recognizer; answers { ok, reason? }
       vi:stop       from the page   → stop the recognizer, release the page
       vi:open-panel from the page   → open the side panel (so the user can
                                       allow the microphone there)
       vi:evt        from recognizer → forwarded to the exact tab + frame that
                                       owns the button as vi:started /
                                       vi:result / vi:ended / vi:error
     A chrome.tabs.onRemoved listener ends dictation if the tab is closed.
     No existing message type was renamed or rerouted.


3. offscreen.html — one line
-----------------------------
Added beside the existing script tag, in the same type="module" style:

  <script type="module" src="voice-input/recognizer.js"></script>

No inline JavaScript (Manifest V3 forbids it).


4. mode.js — one new mode
--------------------------
Added to the MODES object (and described in the file's header comment):

  DICTATING: "dictating",

Nothing about how mode.js enforces exclusivity was changed.


5. sidepanel.js — register the new mode's routines
---------------------------------------------------
  a) Two routines and one status helper were added:
       enterDictatingMode()  remembers whether her mic was muted, stops her
                             speaking, mutes her mic, drops any half-heard
                             words
       exitDictatingMode()   restores the mic exactly as it was
       setDictatingStatusLine()  writes "Dictating on the page" into the
                             status line
  b) Registered with the mode manager in initModes():
       [MODES.DICTATING]: { enter: enterDictatingMode, exit: exitDictatingMode },
  c) updateStatus() gained one branch:
       else if (inMode(MODES.DICTATING)) setDictatingStatusLine();
  d) The runtime.onMessage listener now answers the one message the overlay
     sends the panel:
       { t:"vi:mode", cmd:"begin" } → { ok:false, reason:"busy" } while a voice
         or screen recording is running, otherwise enterMode(MODES.DICTATING)
         and { ok:true }
       { t:"vi:mode", cmd:"end" }   → enterMode(MODES.LISTENING)
     The "Activate Sharon" keyboard shortcut also ends an in-progress
     dictation first, so two recognizers never hold the microphone at once.

speech.js and offscreen.js were NOT modified. This module never touches them.


==================================================================
Loading the extension
==================================================================
  1. Open chrome://extensions (or edge://extensions).
  2. Turn ON "Developer mode" (top right).
  3. Click "Load unpacked".
  4. Choose this extension's folder — the one containing manifest.json.
  5. Open Sharon's side panel once and allow the microphone when Chrome asks.
     That single permission is what the mic button uses; it is never asked
     for again.
  6. Open any website, click into a text box, and the button appears.

After editing any file in this folder, press the reload (↻) button on the
extension's card, then refresh the website you are testing on — content
scripts only load into pages opened after the reload.
