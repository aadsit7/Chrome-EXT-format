Bookmarks Buddy — Chrome Extension (Manifest V3)
================================================

Save your favorite links and open them hands-free with your voice. Bookmarks
Buddy runs as a SIDE PANEL docked beside your web pages.


HOW TO LOAD (Developer mode → Load unpacked)
--------------------------------------------
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


WHAT IT DOES
------------
- Voice listening (Web Speech API) and spoken replies (text-to-speech).
- Open bookmarks in new browser tabs/windows by voice or by clicking.
- Save bookmarks, settings, and your home-screen layout on the device
  (stored in localStorage — nothing leaves your browser by default).
- A keyboard shortcut (configurable in Settings, default Ctrl+R) toggles
  listening while the panel is focused.
- Optional Google Sheet backup/sync: stays off unless you enter a code in
  Settings. This is the only feature that talks to the network, which is why
  the manifest requests host access to https://script.google.com/* — the app
  works fully without it.


FILES
-----
  manifest.json      Manifest V3 configuration
  panel.html         The side-panel page (markup only)
  panel.css          All styles (moved out of the original <style> block)
  panel.js           The whole app (moved out of the original inline <script>)
  background.js       Service worker — makes the toolbar icon open the panel
  lib/lucide.min.js  Lucide icon library, bundled locally (no internet needed)
  icons/             Toolbar/extension icons (16, 48, 128 px)


NOTES
-----
- No code is loaded from the internet; everything is bundled locally, so the
  default Manifest V3 content-security-policy is used (no custom CSP needed).
- The DM Sans web font from the original file was removed; the UI falls back to
  the system sans-serif font. This is purely cosmetic.
