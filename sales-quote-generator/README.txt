Sales Quote Generator — Chrome extension (side panel)
======================================================

Build sales quotes with volume pricing, discounts, renewals, and
configurable pricing rules — right in the browser side panel, next to
whatever page you're working on. Fully self-contained: no network
access, no external dependencies. Requires Chrome 114+.

The optional "Analyze this page" button reads the tab you're on to
pre-fill the form; page reading happens locally in your browser and
nothing is ever sent anywhere.

HOW TO LOAD (unpacked)
----------------------
1. Open Chrome and go to chrome://extensions
2. Turn ON "Developer mode" (toggle in the top-right corner)
3. Click "Load unpacked"
4. Select this folder (sales-quote-generator)
5. Click the extension's toolbar icon — the quote generator opens
   in the browser side panel (click the icon again, or the side
   panel's × button, to close it)

USING THE TOOL
--------------
- "Analyze this page" (at the top of the calculator) reads the web
  page in the active tab and looks for quote details — customer /
  company, contact email, a bill-to company (mapped to the partner
  field), catalog products with their quantities, a renewal date, and
  current annual prices. Detected values are shown in a review card
  with a checkbox each (checked by default); a value that would
  overwrite something you already typed is flagged "will replace: …".
  Nothing changes until you press Apply — Cancel discards the
  suggestions. Detection is rule-based and read-only: the page is only
  read, never modified, and no data leaves the browser. Pages that
  can't be read (chrome:// pages, the Chrome Web Store, PDF viewers)
  show a short notice, and "Couldn't find quote info on this page."
  appears when nothing useful is detected.
- The gear icon in the header switches between the quote calculator
  and the pricing settings screen. Opening settings requires a
  password — the default is 2026. Change it any time from the
  "Settings access" field at the top of the settings screen (note:
  "Reset to default pricing" also resets the password back to 2026).
- Settings changes apply to the calculator immediately.
- The running total lives in the dock at the bottom of the panel.
  Tap it to slide up the full quote breakdown (line items, discounts,
  billing schedule, savings); tap the dimmed area, the ×, or press
  Escape to close it.
- "Create quote" downloads a one-page branded quote PDF (line items,
  discounts, billing schedule, total contract value, and signature
  lines), named after the quote number (e.g. QT-2026-1234.pdf).
- The in-progress quote and all pricing settings are saved to this
  browser (localStorage) and restored automatically when you reopen
  the panel. Use "Reset to default pricing" on the settings screen to
  restore the built-in rate tables and rules.

PERMISSIONS
-----------
- sidePanel   Opens the tool in the browser side panel.
- scripting   Lets "Analyze this page" run a read-only extraction
              function in the active tab (via chrome.scripting).
- host_permissions "http://*/*" and "https://*/*" — so the button
              works on any normal website when you click it. The
              extension does not read pages in the background; it only
              reads a tab when you press "Analyze this page".

FILES
-----
manifest.json   Manifest V3 definition (sidePanel + scripting; host
                permissions for http/https so Analyze works anywhere)
background.js   Service worker — opens the side panel on icon click
app.html        The app page (calculator + settings screens)
app.css         All styles (single-column, side-panel-first layout)
app.js          All application logic (no inline scripts)
analyze.js      "Analyze this page" — read-only page extraction,
                review card, and apply-through-setQ logic
pdf.js          Self-contained PDF writer for the quote export
icons/          Recast-branded "Re" icons (16, 48, 128 px; 512 px source)
