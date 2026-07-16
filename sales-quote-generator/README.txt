Sales Quote Generator — Chrome extension (side panel)
======================================================

Build sales quotes with volume pricing, discounts, renewals, and
configurable pricing rules — right in the browser side panel, next to
whatever page you're working on. Dependency-free and works offline; the
only network calls are the one-time first-run registration and the
optional "Save to database" action, which sends a finished quote to a
shared Google Sheet (both go to the same Apps Script web app; if you're
offline at first run you still get straight into the app). Requires
Chrome 114+.

The "Analyze this page" button reads the tab you're on to pre-fill the
form. It captures a thorough snapshot of the record — including values
inside Salesforce Lightning's shadow DOM and every related-list table —
and sends that snapshot (plus your product catalog) to the same Apps
Script web app, which returns the fields to review. If that call can't be
made (offline, etc.), it falls back to the built-in local rule-based
detection, so the button always works. Nothing is written to the form
until you press Apply.

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
  company, contact (billing contact) and email, a reseller / bill-to
  company, bill-to and ship-to addresses, a quote expiration date, the
  currency, the subscription term, and catalog products with their
  quantities (and, from a renewal, current annual prices). It reads the
  page two ways and shows the best result: an AI-assisted read (a rich
  snapshot of the record — including Salesforce Lightning values that
  live in the shadow DOM, and every related-list table — is sent to the
  Apps Script, which returns structured fields), and, if that can't run,
  the built-in local rule-based detection. Either way the results are
  shown in a review card with a checkbox each (checked by default); a
  value that would overwrite something you already typed is flagged
  "will replace: …". Nothing changes until you press Apply — Cancel
  discards the suggestions. A detected reseller only fills the partner
  company / email fields and shows a note; it never flips the Partner
  pricing switch for you (that changes pricing, so it's your call). The
  page itself is only read, never modified. Pages that can't be read
  (chrome:// pages, the Chrome Web Store, PDF viewers) show a short
  notice, and "Couldn't find quote info on this page." appears when
  nothing useful is detected.

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
  an Order Details section, a product table (one row per line item, with
  start date, end date, quantity, and total), a Grand Total, the standard
  Terms & Conditions copy, and an Acceptance & Signatures block with
  signature/name/title/date lines for both parties. Every form field the
  app knows about is drawn (or left cleanly blank): the Bill To block
  shows the name (customer, or the reseller on a partner deal), the
  bill-to address, a Contact line (billing contact) and an Email line
  (the contact email, or the partner email on a partner deal); the Ship
  To block shows the customer and ship-to address; and Order Details
  shows billing contact, email, payment method, currency and payment
  terms. Blank fields simply print as blank space — never a stray label
  or the word "undefined". The file is named after the quote number
  (e.g. QT-2026-1234.pdf). All pricing shown is the same computed total
  already displayed in the app — the PDF never re-derives pricing math,
  and everything is laid out to always fit on one page (the Terms &
  Conditions type shrinks slightly first if a quote has many line items).
- Every time you "Create quote", the quote is also saved automatically
  to the shared database (there is no separate "Save to database"
  button anymore) — see below.
- The in-progress quote and all pricing settings are saved to this
  browser (localStorage) and restored automatically when you reopen
  the panel. Use "Reset to default pricing" on the settings screen to
  restore the built-in rate tables and rules.

FIRST RUN — WHO ARE YOU?
------------------------
- On first run the panel REQUIRES your first and last name before it
  shows anything else. The whole app (calculator, settings, dock) stays
  hidden behind a one-time registration screen with a "First name" and a
  "Last name" field; the "Start" button stays disabled until both fields
  have text. This replaces the old single "name" prompt — any name saved
  by an earlier version no longer counts, so you'll be asked once more.
- When you press Start, your names are saved to this browser
  (localStorage) along with a hidden user_id — a random identifier
  generated once for you. Your names become the default "Prepared by" on
  your quotes, and the user_id is stamped on every entry you save to the
  shared database.
- The registration screen never appears again unless the browser's
  storage is cleared. Your names are captured once and are intended to be
  fixed; the settings screen shows them read-only as "Signed in as
  <first> <last>" (there is no editable name field anymore).
- Merged across computers: the shared database matches people by first +
  last name and hands back one canonical user_id for that name. The
  extension quietly adopts that id, so the same name used on a second
  computer is merged into a single profile automatically — nothing to
  set up, and you won't see any change in the app.

SAVING QUOTES TO THE SHARED DATABASE
------------------------------------
- Saving is automatic. There is no "Save to database" button — every
  time you press "Create quote", the current quote is sent to the shared
  Google Sheet as part of the same action. It sends your user object
  ({ user_id, first name, last name }), the full quote, the same annual /
  total / savings figures and per-line prices shown in the app, and the
  source page URL if the quote came from "Analyze this page". It never
  changes what the PDF export contains.
- When the save succeeds, a short AI note about the quote comes back and
  is shown in the usual toast message (and kept with the quote). If the
  save can't go through (offline, etc.), a friendly "Couldn't save to the
  database — check your connection." toast appears and the calculator
  keeps working normally. The database URL is already wired in, so there
  is nothing to configure.

PERMISSIONS
-----------
- sidePanel   Opens the tool in the browser side panel.
- scripting   Lets "Analyze this page" run a read-only extraction
              function in the active tab (via chrome.scripting).
- host_permissions "http://*/*" and "https://*/*" — so "Analyze this
              page" works on any normal website when you click it, and so
              the automatic save, first-run registration, and the AI page
              analysis can reach the Google Apps Script web app
              (script.google.com / script.googleusercontent.com). No new
              permissions were added. The extension does not read pages in
              the background; it only reads a tab when you press "Analyze
              this page".

FILES
-----
manifest.json   Manifest V3 definition (sidePanel + scripting; host
                permissions for http/https so Analyze works anywhere)
background.js   Service worker — opens the side panel on icon click
app.html        The app page (calculator + settings screens)
app.css         All styles (single-column, side-panel-first layout)
app.js          All application logic (no inline scripts) — includes the
                first-run first/last-name registration gate and the user
                profile { user_id, first name, last name } stored in
                localStorage 'sqg-user'
analyze.js      "Analyze this page" — read-only page extraction. Captures a
                rich all-frames snapshot that walks the shadow DOM (so
                Salesforce Lightning values are seen) plus label/value pairs
                and related-list tables, POSTs it (with the catalog) for an
                AI read, and maps the returned fields into the review card;
                falls back to the built-in rule-based Salesforce/generic
                detection, then apply-through-setQ
sheets.js       Shared-database + AI network calls to the Apps Script web
                app: saveQuote (auto-run by "Create quote"; sends the user
                object + computed totals/line prices, returns the AI note),
                registerUser (first run), and analyzePage (page snapshot →
                structured fields); adopts the canonical user_id the server
                returns
pdf.js          Self-contained PDF writer for the quote export —
                replicates the official Recast quote template
                (section bars, Bill To / Ship To with contact + email,
                Order Details, product table, terms, signatures) and
                embeds the bundled logo as a raster image at runtime
icons/          Recast-branded "Re" icons (16, 48, 128 px; 512 px source)
assets/         recast-logo.png — the transparent Recast wordmark logo,
                embedded in the top-left of every generated quote PDF
