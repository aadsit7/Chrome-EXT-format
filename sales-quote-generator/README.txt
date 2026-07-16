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

  Salesforce support (primary target): the button recognises Salesforce
  record pages — both Lightning and Classic — by their URL
  (lightning.force.com, my.salesforce.com, salesforce.com, force.com,
  visualforce.com) or by Lightning page markers, and reads them first.
    * Account Name / the Opportunity's related Account → Customer /
      company. A Bill To Name (or billing account) that differs from the
      account is mapped to Partner company.
    * A contact email on the record → Contact email.
    * A "Renewal", "Contract End", "End Date" or "Expiration" date →
      the customer's renewal date. "Close Date" is never treated as a
      renewal date.
    * Related lists (Opportunity Products, Quote Line Items, Assets) are
      read by their column headers: the Product column is matched
      against the built-in catalog, Quantity / Qty sets the line
      quantity, and Sales Price / Total Price / Annual Price fill the
      renewal price.
  Salesforce loads sections lazily, so if the Products related list
  isn't on screen yet the review card shows: "No products list visible
  — scroll to the Products section in Salesforce and analyze again." —
  scroll it into view and click the button again. Classic content shown
  inside Lightning renders in iframes; the extraction runs in every
  frame and the results are merged. Any other (non-Salesforce) website
  falls back to the generic rule-based detection described above.
- The "New quote" button (the page-with-a-plus icon in the header, next
  to the gear) starts a fresh quote: it clears every field and resets
  the calculator to its defaults with a new quote number. Because this
  can't be undone, it asks for confirmation first — "Start a new
  quote?" with Cancel / New quote — so the current quote is never wiped
  by an accidental tap. Confirming also updates the saved quote in this
  browser (localStorage), same as any other edit.
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
- "Billing details (for PDF)" is a collapsible group at the bottom of
  "Who's it for?". It holds the fields that only appear on the quote
  PDF: Bill To address and Ship To address (multi-line), Billing
  Contact, Payment Method (default "Credit Card, ACH/Wire, Check"),
  Payment Terms (default "Net 120"), Currency (default "USD"), and an
  Auto Renewal Yes/No toggle (default No). All of it is optional —
  fields left blank print as blank space on the PDF. Like every other
  field, these save with the quote (localStorage) and are restored
  when you reopen the panel.
- "Create quote" downloads a one-page Recast-branded quote PDF that
  matches the official Recast Software quote form: the Recast logo
  and company address, the quote number, a Bill To / Ship To block,
  an Order Details section (billing contact, payment method, currency,
  payment terms), a product table (one row per line item, with start
  date, end date, quantity, and total), a Grand Total, the standard
  Terms & Conditions copy, and an Acceptance & Signatures block with
  signature/name/title/date lines for both parties. The file is named
  after the quote number (e.g. QT-2026-1234.pdf). All pricing shown is
  the same computed total already displayed in the app — the PDF never
  re-derives pricing math, and everything is laid out to always fit on
  one page (the Terms & Conditions type shrinks slightly first if a
  quote has many line items).
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
analyze.js      "Analyze this page" — read-only page extraction
                (Salesforce Lightning/Classic first, generic fallback),
                all-frames merge, review card, apply-through-setQ logic
pdf.js          Self-contained PDF writer for the quote export —
                replicates the official Recast quote template
                (section bars, product table, terms, signatures) and
                embeds the bundled logo as a raster image at runtime
icons/          Recast-branded "Re" icons (16, 48, 128 px; 512 px source)
assets/         recast-logo.png — the transparent Recast wordmark logo,
                embedded in the top-left of every generated quote PDF
