Sales Quote Generator — Chrome extension
=========================================

Build sales quotes with volume pricing, discounts, renewals, and
configurable pricing rules. Fully self-contained: no permissions,
no network access, no external dependencies.

HOW TO LOAD (unpacked)
----------------------
1. Open Chrome and go to chrome://extensions
2. Turn ON "Developer mode" (toggle in the top-right corner)
3. Click "Load unpacked"
4. Select this folder (sales-quote-generator)
5. Click the extension's toolbar icon — the quote generator opens
   in a new tab

USING THE TOOL
--------------
- The gear icon in the header switches between the quote calculator
  and the pricing settings screen.
- Settings changes apply to the calculator immediately.
- The in-progress quote and all pricing settings are saved to this
  browser (localStorage) and restored automatically when you reopen
  the page. Use "Reset to default pricing" on the settings screen to
  restore the built-in rate tables and rules.

FILES
-----
manifest.json   Manifest V3 definition (no special permissions)
background.js   Service worker — opens app.html on icon click
app.html        The app page (calculator + settings screens)
app.css         All styles
app.js          All application logic (no inline scripts)
icons/          Placeholder icons (16, 48, 128 px)
