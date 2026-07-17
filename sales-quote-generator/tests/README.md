# Analyze-this-page test harness (dev only)

This folder is **not** part of the shipped Chrome extension — `manifest.json`
never references it, so it has no effect on the packaged side panel. It exists
to prove the upgraded `analyze.js` extraction works against the two real
Salesforce Opportunity pages the feature targets.

## What it checks

`analyze.test.js` feeds two fixtures modeled on the attached PDFs
(`fixtures.js` — a **new-business** Opportunity and a **renewal** Opportunity)
through the extension's own exported functions
(`window.SQG_ANALYZE._extract` → `_mergeFrames` → `_buildFindings`,
`_buildAiFindings`, and `_snapshot` → `_buildSnapshotText`) and asserts that
**customer, partner, renewal date, term months, product and quantity** come out
correct for both pages — through the rule-based DOM path *and* the AI-response
path — plus that the prioritized snapshot puts high-value sections first and
excludes the noise sections (Stage History, Field History, System Information).

## Run it

```bash
cd sales-quote-generator/tests
npm install        # installs jsdom (dev-only) for the DOM-driven checks
node analyze.test.js
```

`node analyze.test.js` also runs without `npm install`; it just skips the
DOM-driven checks (jsdom absent) and still runs the AI-response checks. The
process exits non-zero if any assertion fails.
