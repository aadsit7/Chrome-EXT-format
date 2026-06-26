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
The first time you start listening, Chrome asks for microphone access so the
extension can hear your voice commands. Allow it to use voice features.


WHAT IT DOES (unchanged from the original)
------------------------------------------
- Voice listening (Web Speech API) and spoken replies (text-to-speech).
- Open bookmarks in new browser tabs/windows by voice or by tapping a tile.
- Save bookmarks, settings, and your home-screen layout on the device
  (localStorage — nothing leaves your browser).
- Springboard home screen with folders and a rearrange ("jiggle") edit mode.
- Site icons are fetched as images from Google's public favicon service; this
  is an ordinary <img> load and needs no special permission.


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
  lib/component-logic.js     The app's component logic (was the inline x-dc script)
  lib/lucide.min.js          Lucide icon library (bundled locally)
  lib/react.production.min.js
  lib/react-dom.production.min.js   React 18.3.1, bundled locally
  lib/font-latin.woff2
  lib/font-latin-ext.woff2   DM Sans web font, bundled locally
  icons/                     Toolbar/extension icons (16, 48, 128 px)
