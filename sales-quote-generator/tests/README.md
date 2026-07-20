# Analyze / Speak-to-fill test harness (dev only)

This folder is **not** part of the shipped Chrome extension — `manifest.json`
never references it, so it has no effect on the packaged side panel. It exists
to prove the upgraded `analyze.js` extraction **and** the `voice.js` live parser
work against the scenarios each feature targets, **plus** that the flow-based PDF
layout (`pdf.js`) and the value-cleaning guards (`clean.js` + `voice.js` +
`analyze.js` + `app.js`) hold for both direct and partner quotes.

## What it checks

### `analyze.test.js` — "Analyze this page" + the AI review path

Feeds two fixtures modeled on the attached PDFs (`fixtures.js` — a
**new-business** Opportunity and a **renewal** Opportunity) through the
extension's own exported functions (`window.SQG_ANALYZE._extract` →
`_mergeFrames` → `_buildFindings`, `_buildAiFindings`, and `_snapshot` →
`_buildSnapshotText`) and asserts that **customer, partner, renewal date, term
months, product and quantity** come out correct for both pages — through the
rule-based DOM path *and* the AI-response path — plus that the prioritized
snapshot puts high-value sections first and excludes the noise sections (Stage
History, Field History, System Information).

It also exercises the **extended deal/discount schema** the voice review path
returns (Task 2): `customerType`, `dealType`, `extraDiscountPct`,
`partnerMarginPct`, `premiumSupport` become review-card findings and then apply
through the same state patches (with the clamp / max-discount rules) as the live
voice parser.

A detected contact (`contactName`, e.g. the Salesforce Contact Roles primary)
now maps to the quote's **Contact name** field on both the rule-based and AI
paths — never to a direct `billingContact` write (Billing contact fills via the
app's billing auto-mirror instead), and both fixtures assert that.

### `voice.test.js` — "Speak to fill" live parser

Drives the extension's own `window.SQG_VOICE._parse` with spoken-phrase fixtures
in natural, out-of-order phrasing and asserts every part routes to the right
command. Includes the canonical sentence *"We are selling Application Workspace
to Amazon with a fifteen percent discount. It's a new customer."* (product,
customer = Amazon, extra discount = 15, customer type = new), a label-first
fixture that must still parse identically (additive-only guard), `quote for
Costco, …`, partner-margin phrasing, and a renewal phrasing.

Also covers the "Who's it for?" upgrades: **full multi-word company capture**
("Johnson and Johnson", "Seven Hills Software" come through whole while a real
quantity still ends the capture), the **known-company spelling snap**
(`_parse(text, knownNames)` — a close mishear or leading-words match snaps to
the known spelling; different or longer spoken names are kept as spoken), the
**Contact name routing** ("contact name John Smith" → `contactName`, "billing
contact Pat Lee" → `billingContact`), and — Change 1 — that `reviewBox()`
renders nothing (voice is silent after stopping; no recap panel).

### `layout.test.js` — flow-based one-page PDF (Bug 1)

Drives `window.SQG_PDF._layoutProbe` (the logo's `chrome.runtime.getURL` call is
stubbed) with six quotes — a minimal direct quote, a direct quote with a long
customer name + long addresses, a partner quote with all partner fields long, a
partner quote at max product lines, a partner renewal, and a quote with a 60+
character email — and asserts, off the recorded glyph boxes, **one-page fit, zero
overlapping text bounding boxes, and zero column overflows** for every one.

### `cleaning.test.js` — value cleaning (Bugs 2 & 3)

Drives the shipped cleaning code at each checkpoint with the exact broken strings
from the attached quote: `voice.js` (sentence-fragment customer → "Amazon"; fused
email → one valid email + partnerEmail), `analyze.js` ("Insight Preview" →
"Insight"), and the `app.js` PDF meta guard (`SQG_CLEAN.cleanMeta`: "Gulfstream
Aerospace Corp." unchanged, hand-typed "Preview Inc" with no sourceUrl unchanged,
invalid email blanked).

Also covers the v3.5 PDF output-formatting guards, from a real broken PDF: a
Bill To / Ship To address first line that duplicates the block's party name (or
the customer, on partner deals) is dropped so the company never prints twice,
and a run-on dictation glob fused onto ".com" is rejected by the email guard
(prints blank) and is never captured by the voice parser in the first place.

## Run it

```bash
cd sales-quote-generator/tests
npm install        # installs jsdom (dev-only) for the DOM-driven checks
npm test           # runs analyze / voice / cleaning / layout
```

Both files also run without `npm install`: `voice.test.js` needs nothing, and
`analyze.test.js` just skips the DOM-driven checks (jsdom absent) and still runs
every AI-response check. Each process exits non-zero if any assertion fails
(`npm run test:analyze` / `npm run test:voice` run them individually).
