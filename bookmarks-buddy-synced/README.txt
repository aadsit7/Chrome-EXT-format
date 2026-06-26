Bookmarks Buddy — Chrome Extension (Manifest V3)
================================================

Save your favorite links and open them hands-free with your voice. Bookmarks
Buddy runs as a SIDE PANEL docked beside your web pages.


HOW TO LOAD (Developer mode -> Load unpacked)
---------------------------------------------
1. Open Chrome and go to:  chrome://extensions
2. Turn on "Developer mode" (toggle in the top-right corner).
3. Click "Load unpacked".
4. Select this "bookmarks-buddy-synced" folder (the one containing manifest.json).
5. The extension appears in your list and its icon is added to the toolbar.

OPENING THE PANEL
-----------------
Click the Bookmarks Buddy toolbar icon. There is NO popup — clicking the icon
opens the side panel docked to the side of the current page. (If you don't see
the icon, click the puzzle-piece "Extensions" button and pin Bookmarks Buddy.)

FIRST-RUN PERMISSIONS
---------------------
The first time you start listening, Chrome asks for microphone access so the
extension can hear your voice commands. Allow it to use voice features.


This is the GOOGLE SHEET–SYNCED build of Bookmarks Buddy. The look, layout,
animations and behaviour are identical to the original "bookmarks-buddy"
extension — ONLY the data source and persistence changed: instead of starter
defaults in localStorage, the panel loads your real apps from a Google Sheet
on open and writes every change back.


WHAT IT DOES
------------
- Voice listening (Web Speech API) and spoken replies (text-to-speech).
- Open bookmarks in new browser tabs/windows by voice or by tapping a tile.
- Springboard home screen with folders and a rearrange ("jiggle") edit mode.
- Site icons are fetched as images from Google's public favicon service; this
  is an ordinary <img> load and needs no special permission.

GOOGLE SHEET SYNC (the only functional change vs. the original)
---------------------------------------------------------------
- On open, the panel pulls the live list from a Google Sheet (via a Google
  Apps Script web app) and renders it through the UNCHANGED UI. The sheet is
  the source of truth.
- Adding, removing, renaming and reordering a tile writes back to the sheet.
- An offline outbox queue holds writes when the network is down and flushes
  them automatically once it's back. localStorage is kept as an instant
  offline mirror.
- The sheet engine lives in lib/sheet-sync.js (loaded before the app logic).
  It is ported verbatim from the web version (index__26_.html): same /exec
  URL and app token, GET action=getBookmarks&token=…, and POST as
  text/plain;charset=utf-8 with the token injected at send time (text/plain
  keeps it a "simple" request so Apps Script never needs to answer a CORS
  preflight). The component talks to it through a tiny adapter that maps the
  sheet's columns (Bookmark ID, Name, URL, Folder, Page, Position, Notes,
  Icon, …) to/from the exact bookmark object the existing UI renders.
- Override the app token at runtime with ?token=… on the panel URL, or in the
  DevTools console with bbSetToken('…') — same as the web version.

PERMISSIONS
-----------
- "sidePanel": dock the app as a side panel (unchanged).
- host_permissions for https://script.google.com/* and
  https://*.googleusercontent.com/* : Apps Script /exec redirects the GET to
  script.googleusercontent.com, so BOTH hosts are required or the call fails
  after the redirect.
- The offline queue uses localStorage and needs no extra permission.


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
  lib/sheet-sync.js          Google Sheet data layer (load/save + offline queue)
  lib/component-logic.js     The app's component logic (was the inline x-dc script)
  lib/lucide.min.js          Lucide icon library (bundled locally)
  lib/react.production.min.js
  lib/react-dom.production.min.js   React 18.3.1, bundled locally
  lib/font-latin.woff2
  lib/font-latin-ext.woff2   DM Sans web font, bundled locally
  icons/                     Toolbar/extension icons (16, 48, 128 px)
