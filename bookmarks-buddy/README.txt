Bookmarks Buddy — Chrome Extension (Manifest V3)
================================================

Save your favorite links and open them hands-free with your voice. Bookmarks
Buddy runs as a SIDE PANEL docked beside your web pages.


HOW TO LOAD (Developer mode -> Load unpacked)
---------------------------------------------
1. Open Chrome and go to:  chrome://extensions
2. Turn on "Developer mode" (toggle in the top-right corner).
3. Click "Load unpacked".
4. Select this "bookmarks-buddy" folder (the one containing manifest.json).
5. The extension appears in your list and its icon is added to the toolbar.

OPENING THE PANEL
-----------------
Click the Bookmarks Buddy toolbar icon. There is NO popup — clicking the icon
opens the side panel docked to the side of the current page. (If you don't see
the icon, click the puzzle-piece "Extensions" button and pin Bookmarks Buddy.)

FIRST-RUN PERMISSIONS
---------------------
The first time the panel opens it starts the microphone listener, so Chrome
asks for microphone access. Allow it to use voice features. (You can stop
listening any time by tapping the mic; it starts again on the next open.)


WHAT IT DOES
------------
- Loads your apps from your Google Sheet on launch (see below) and keeps the
  springboard arrangement — pages, folders, and order — in sync with it.
- Auto-starts the microphone listener when the panel opens.
- Voice listening (Web Speech API) and spoken replies (text-to-speech).
- Hands-free entry: opening the Add or Edit sheet auto-starts the mic in
  dictation mode, typing what you say into whichever text box has focus. Click
  a different box with the mouse and dictation follows it — no keyboard needed.
  URL/Icon boxes understand spoken punctuation ("dot" -> ".", "slash" -> "/").
  A status pill in the sheet shows when it's listening and can pause/resume it.
- Open bookmarks in new browser tabs/windows by voice or by tapping a tile.
- Springboard home screen with named pages, folders, and a rearrange
  ("jiggle") edit mode.
- localStorage is kept as an instant, offline mirror.
- Site icons are fetched as images from Google's public favicon service; this
  is an ordinary <img> load and needs no special permission.


GOOGLE SHEET SYNC (ported from the web app)
-------------------------------------------
Your bookmarks live in a Google Sheet, reached through a deployed Apps Script
web app (the same backend and embedded token as the browser version). On
launch the extension pulls the list and rebuilds your pages/folders/order from
the sheet's Folder / Page / Position columns; every change you make (add,
remove, rearrange) is written back, and changes made while offline are queued
and flushed once the sheet is reachable again. The sheet is authoritative, so
the extension shows exactly what's in your sheet.

This is why the manifest now requests host access to:
  - https://script.google.com/*            (the Apps Script web app)
  - https://script.googleusercontent.com/* (where its GET response is served)

To point a device at a different token without editing files, open the panel's
DevTools console and run:  bbSetToken('your-token')   (or clear it with
bbSetToken('')). A ?token=… on the panel URL works too.


HOW IT WAS PACKAGED (notes for maintainers)
-------------------------------------------
The source was an exported, self-extracting single-file bundle built on a
small React-based template framework ("dc-runtime"). Manifest V3 forbids two
things the original relied on, so the bundle was unpacked into ordinary local
files and two minimal, behavior-preserving adjustments were made:

  1. dc-runtime evaluated the component logic with `new Function(...)`, which
     MV3's content-security-policy blocks. The component source is now shipped
     verbatim in lib/component-logic.js, wrapped in a real function; dc-runtime
     was patched to call it instead of compiling a string. The app logic is
     byte-for-byte unchanged.

  2. dc-runtime loaded React, ReactDOM and Babel from a CDN at runtime. Those
     are now bundled locally (lib/react*.js) and the runtime's URLs point at
     the local copies. (Babel is only used for JSX, which this app does not
     use, so it is not bundled.)

Everything is local, so the default MV3 CSP is used (no custom CSP needed).


FILES
-----
  manifest.json              Manifest V3 configuration
  panel.html                 The side-panel page (the unpacked app template)
  background.js              Service worker — makes the toolbar icon open the panel
  lib/dc-runtime.js          The template framework (patched: no eval, local URLs)
  lib/component-logic.js     The app's component logic (was the inline x-dc
                             script), plus the ported Google Sheet sync layer
                             and the auto-start-mic-on-launch hook
  lib/lucide.min.js          Lucide icon library (bundled locally)
  lib/react.production.min.js
  lib/react-dom.production.min.js   React 18.3.1, bundled locally
  lib/font-latin.woff2
  lib/font-latin-ext.woff2   DM Sans web font, bundled locally
  icons/                     Toolbar/extension icons (16, 48, 128 px)
