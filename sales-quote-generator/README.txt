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
  On Salesforce the snapshot sent to the AI is PRIORITIZED: it leads with
  "SOURCE: Salesforce Opportunity record" and the page URL, then captures
  the panels that matter most in order — Quote Information, Renewals,
  Subscription Information, Products, Opportunity Information, Contact
  Roles, Account Details — and EXCLUDES noise sections (Stage / Field
  History, System Information, Activity, Chatter, Notes, Files) so the
  signal isn't drowned out. Repeated label/value pairs are de-duplicated
  and the payload is capped only after prioritizing, so high-value
  sections are never the part that gets truncated.
    * Account Name → Customer / company (the end customer). It stays the
      customer even when a Partner/Reseller is present.
    * A Partner/Reseller, or a Subscription Type of "Reseller" → the
      reseller / partner company (pricing is left unchanged — turning on
      Partner pricing stays your call).
    * The Contact Roles related list → contact name / email / phone,
      preferring the row marked Primary.
    * Renewal date precedence: License Expiration Date / End Date beat
      Renewal Month Date, which beats Close Date. "Close Date" is a sales
      forecast, so it's only used as a last resort and the finding says so.
    * Subscription Term (Salesforce's "12.000000000000" = 12 months) →
      the term. Endpoint Tier ("1,001 - 5,000") is context only, never a
      quantity.
    * Quantity precedence: the Renewals / Subscription panel Quantity beats
      a Products related-list quantity, which beats Account "Current Device
      Count".
    * Products come from the Products related list (Product column matched
      against the catalog by its link/title, so Salesforce's truncated
      "Application Wo…" still resolves) or, when there's no list, from the
      semicolon-separated "Product(s)" field. On a renewal, "ARR up for
      Renewal" fills the current annual price.
  Salesforce only renders panels/tabs that are open, so if a key section
  wasn't on screen the review card tells you which one to open: "open or
  scroll to the Products related list" and, on a renewal with no Renewals
  / Subscription panel visible, "open that tab in Salesforce, then Analyze
  again." The analyzer stays strictly read-only — it never opens or clicks
  anything itself. Classic content shown inside Lightning renders in
  iframes; the extraction runs in every frame and the results are merged.
  Any other (non-Salesforce) website falls back to the generic rule-based
  detection described above.
- "Speak to fill" (the microphone button next to "Analyze this page")
  fills the form LIVE as you speak. Tap it and the button turns red and
  starts listening; say values in plain language and each field updates
  the moment it's recognized — a "Listening — filling live" panel shows
  the running transcript and a green chip for every field just filled.
  It understands, in any order and combined in one breath:
    • products + quantity — "Right Click Tools 2,500 endpoints",
      "Application Workspace 500 users", "set Insights to 3,000"
      (adds the product if it isn't in the quote yet)
    • discounts — "partner margin 20 percent", "extra discount 5 percent",
      "annual increase 3 percent", "premium support"
    • term & type — "two year term", "eighteen month term", "net new",
      "current customer", "renewal", "add-on and renewal"
    • text fields — "customer is Acme Corporation", "contact name Jane Doe"
      (fills the Contact name field; "billing contact …" targets the
      Billing contact field directly), "email jane at acme dot com",
      "partner company Reseller Inc", "prepared by …", "currency euros",
      "payment terms Net 30"
  Company names are captured in FULL — multi-word names, names containing
  "and" ("Procter and Gamble") and names starting with a number word
  ("Seven Hills Software") come through whole — and a spoken name that
  closely matches a company name already on the quote (customer or
  partner company, e.g. filled by "Analyze this page") snaps to that
  known spelling.
  It also drives the rest of the extension by voice — spoken commands, run
  once each (they never repeat when the transcript is re-read):
    • navigation — "scroll down", "scroll up", "scroll to the top",
      "scroll to the bottom"
    • actions — "analyze this page" (hands off to the page reader),
      "create quote" / "download the PDF", "new quote" / "start over"
      (asks to confirm), "show the details" / "hide the details",
      "open settings"
    • sections — "expand discounts", "collapse the products section",
      "open who's it for"
  Number words ("twenty five hundred", "two thousand five hundred",
  "seven point five percent") are understood. The section holding each
  field opens automatically as it fills, so you watch it happen. Because
  the whole running transcript is re-read on every phrase, correcting a
  value is as simple as saying it again — the latest wins (e.g. say "Right
  Click Tools 3,000 endpoints" to overwrite an earlier 2,500). Applied
  changes go through the form exactly like a manual edit — visible, saved,
  and reversible — and the pricing engine recomputes every total.
  Tap the button again (or stop talking) to stop. Stopping is SILENT:
  there is no after-the-fact recap or confirmation panel — the values you
  spoke are already in the form, a short toast reports how many fields
  were filled, and all voice state is cleared so nothing lingers on
  screen. To correct a misheard value, say it again (latest wins) or edit
  the field directly.
  When you stop, an AI REASONING PASS double-checks the transcript: the
  words are sent to the tool's own Apps Script web app, whose AI works
  out exactly who the customer/company and contact are (e.g. it
  understands the company being sold to even from casual phrasing or a
  mishear) and quietly corrects those fields — with strict guardrails:
  it only ever overwrites a field that is empty or that this voice
  session itself filled and you haven't touched since; anything you
  typed yourself always wins. It then looks up that company's corporate
  HQ address online and fills it into Billing details automatically
  (same guarded lookup as the "Look up address" button, with the
  "Auto-filled — please verify" note; failures stay silent). A toast
  reports anything the AI updated. If the mic is blocked or nothing is heard you get a
  short message and the button resets — it's never left stuck listening.
  Speech is transcribed by the browser's built-in Web Speech API using
  the standard microphone permission prompt — allow mic access the first
  time; the transcription accuracy depends on your mic and surroundings,
  which is why every change is shown live as you speak. If your browser
  has no speech support the microphone button simply doesn't appear.
- The "New quote" button (the page-with-a-plus icon in the header, next
  to the gear) starts a fresh quote: it clears every field and resets
  the calculator to its defaults with a new quote number. Because this
  can't be undone, it asks for confirmation first — "Start a new
  quote?" with Cancel / New quote — so the current quote is never wiped
  by an accidental tap. Confirming also updates the saved quote in this
  browser (localStorage), same as any other edit.
- The calculator is organized into four tap-to-expand sections to keep
  the panel short and scannable. ALL four — "What kind of deal?",
  "What are you selling?", "Any discounts?", and "Who's it for?" —
  start collapsed when the tool opens, each showing a one-line summary
  of its current state on the right (for example "Net new · 1 year",
  "0 products · $0/yr", "None", or the customer name; an unset customer
  shows "Not set" in amber), so opening the panel is a clean overview.
  Tap a section header to open or close it. Sections still expand on
  their own when something fills them — a voice fill, an applied page
  analysis — and if you press "Create quote" while a required field is
  still empty, the section holding that field opens automatically so
  the message points you straight to the fix.
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
- "Who's it for?" holds Customer / company, Contact email, and a
  Contact name field directly below the email (plus Prepared by and the
  expiration date; partner fields appear on partner deals).
- Billing auto-fill: whenever the company name or the contact name is
  set — typed, spoken, or applied from "Analyze this page" — they are
  mirrored into Billing details: the company name becomes the FIRST
  LINE of the Bill To address box and the contact name fills the
  Billing contact field. A billing field is only ever auto-filled while
  it is empty or still auto-managed; the moment you type into a billing
  field yourself, your entry wins and that field is never auto-
  overwritten again (clearing it makes it auto-fillable again).
- "Billing details (for PDF)" is a collapsible group at the bottom of
  "Who's it for?". It holds the fields that only appear on the quote
  PDF: Bill To address and Ship To address (multi-line), Billing
  Contact, Payment Method (default "Credit Card, ACH/Wire, Check"),
  Payment Terms (default "Net 120"), and Currency (default "USD").
  Auto renewal is ALWAYS Yes (v3.8): it has no toggle in the panel —
  every quote simply prints "Auto Renewal: Yes" on the PDF (quotes
  saved by older versions are flipped to Yes on restore). All of the
  fields are optional — fields left blank print as blank space on the
  PDF. Like every other
  field, these save with the quote (localStorage) and are restored
  when you reopen the panel.
- "Look up address" (a small button under the Bill To address box)
  looks up the CORPORATE HEADQUARTERS mailing address of the company
  named in "Customer / company" and fills it into the Bill To address,
  below the company-name first line. The input is always treated as a
  company — "Amazon" means Amazon.com, Inc. (never the river), "Apple"
  means Apple Inc. It works out of the box, in two tiers: first it asks
  the tool's own Apps Script web app (action "addressLookup" — paste-in
  handler in APPS-SCRIPT-UPGRADE.txt) where the AI is instructed to
  resolve the name to the company and return its global headquarters
  invoice address; if that deployment doesn't have the handler yet or
  the call fails, it falls back to OpenStreetMap's public keyless
  Nominatim geocoder automatically — searched as "<company>
  headquarters" and filtered so only street-addressed, office-like
  results are accepted (a river, city, or bare place name can never
  land in the address; when nothing plausible is found it says "No
  address found" rather than filling the wrong place). The result is a
  best guess: it shows an "Auto-filled — please verify" note next to
  the box, and an address you typed yourself is never overwritten. The
  same lookup also runs AUTOMATICALLY after a "Speak to fill" session
  (once per company, only while the Bill To box is still empty /
  auto-managed, failures silent), so dictating a quote fills Billing
  details without a click. To swap in a different provider later,
  replace ADDRESS_LOOKUP_SERVICE in app.js (same shape: async company
  name → multi-line address).
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
  or the word "undefined". The Bill To / Ship To blocks never repeat the
  company name: an address first line that duplicates the block's own
  name (the billing auto-mirror keeps the company on the Bill To first
  line in the panel) is dropped at print time, and an email that isn't a
  single valid address — including a run-on dictation glob fused onto
  ".com" — prints blank. The file is named after the quote number
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
              the automatic save, first-run registration, the AI page
              analysis, and the "Look up address" lookup can reach the
              Google Apps Script web app (script.google.com /
              script.googleusercontent.com) and, for the address fallback,
              nominatim.openstreetmap.org. No new permissions were added.
              The extension does not read pages in the background; it only
              reads a tab when you press "Analyze this page", and it only
              performs an address lookup when you press "Look up address".
- microphone  Not a manifest permission. "Speak to fill" uses the
              browser's built-in Web Speech API, which asks for microphone
              access with the standard browser prompt the first time you
              use it. The mic is only on while you're actively dictating
              (the button is red); tap it again to stop.

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
                and related-list tables. On Salesforce it builds a PRIORITIZED
                snapshot (named panels in priority order, noise sections
                excluded, de-duplicated, capped after prioritizing), applies
                Salesforce-aware precedence (customer vs partner/reseller,
                renewal-date and quantity precedence, subscription term),
                POSTs it (with the catalog) for an AI read, and maps the
                returned fields — including renewal lines — into the review
                card; falls back to the built-in rule-based Salesforce/generic
                detection, then apply-through-setQ. Also exposes
                fillFromText() (an AI-analysis + review-card entry point)
tests/          Dev-only test harness (NOT shipped — manifest never references
                it). node tests/analyze.test.js runs two fixtures modeled on
                real new-business and renewal Opportunity pages through the
                extractor + finding builders and asserts customer, partner,
                renewal date, term, product and quantity for both
APPS-SCRIPT-UPGRADE.txt
                Ready-to-paste replacement for the Apps Script "analyzePage"
                handler + AI prompt (understands the prioritized payload, the
                Salesforce field names, the precedence rules, and the extended
                JSON schema). Paste it into script.google.com — see the 5-line
                header in the file
voice.js        "Speak to fill" — LIVE voice input. Transcribes speech with
                the browser's Web Speech API and, on every finalized phrase,
                re-reads the whole running transcript with a deterministic,
                local command parser (number words, product-name matching,
                discounts, term, customer/deal type, and scalar text fields)
                and applies each recognized value to the matching field
                immediately via setQ — no network round-trip. Re-saying a
                value corrects it (latest wins); the section being filled
                opens so the change is visible; stopping is silent (all
                voice state is cleared — no recap panel). Captures full
                multi-word company names and snaps close matches to a
                company name already on the quote. Also recognizes
                one-shot COMMANDS from each new phrase (scroll up/down/top/
                bottom, analyze this page, create/new quote, show/hide the
                details sheet, open settings, expand/collapse a section) and
                runs them through window.SQG_APP / SQG_ANALYZE — so they fire
                once, never on the idempotent transcript re-read. No new
                permissions (uses the browser's standard mic prompt); hides
                itself when the browser has no speech support
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
