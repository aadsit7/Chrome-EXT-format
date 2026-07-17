# Analyze / Speak-to-fill test harness (dev only)

This folder is **not** part of the shipped Chrome extension — `manifest.json`
never references it, so it has no effect on the packaged side panel. It exists
to prove the upgraded `analyze.js` extraction **and** the `voice.js` live parser
work against the scenarios each feature targets.

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

### `voice.test.js` — "Speak to fill" live parser

Drives the extension's own `window.SQG_VOICE._parse` with spoken-phrase fixtures
in natural, out-of-order phrasing and asserts every part routes to the right
command. Includes the canonical sentence *"We are selling Application Workspace
to Amazon with a fifteen percent discount. It's a new customer."* (product,
customer = Amazon, extra discount = 15, customer type = new), a label-first
fixture that must still parse identically (additive-only guard), `quote for
Costco, …`, partner-margin phrasing, and a renewal phrasing.

## Run it

```bash
cd sales-quote-generator/tests
npm install        # installs jsdom (dev-only) for the DOM-driven checks
npm test           # runs analyze.test.js then voice.test.js
```

Both files also run without `npm install`: `voice.test.js` needs nothing, and
`analyze.test.js` just skips the DOM-driven checks (jsdom absent) and still runs
every AI-response check. Each process exits non-zero if any assertion fails
(`npm run test:analyze` / `npm run test:voice` run them individually).
