'use strict';

/* Value-cleaning harness for Bugs 2 & 3 (clean.js + voice.js + analyze.js).
   NOT shipped in the manifest — run manually with Node:

       node tests/cleaning.test.js

   It drives the extension's OWN code at each checkpoint, using the exact broken
   strings from the attached quote, and asserts:

     1. voice.js   — "customer Amazon. Selling …"  → customer "Amazon"
        (scalar capture ends at sentence punctuation)
     2. voice.js   — fused email "bob@…com.partneremail.bob@…com" → ONE valid
        email each for email + partnerEmail
     3. app.js guard (SQG_CLEAN.cleanMeta) — "Gulfstream Aerospace Corp." → UNCHANGED
        (trailing "." after a known abbreviation is preserved)
     4. analyze.js — captured "Insight Preview" → "Insight"
        (leading/trailing UI action words stripped)
     5. app.js guard — hand-typed "Preview Inc" with NO sourceUrl → UNCHANGED
        (action-word scrub only runs when the value may have come from the page)
     6. app.js guard — invalid email "bob at simple services" → BLANK on the PDF

   The app.js meta guard is exercised through the very function app.js calls
   (window.SQG_CLEAN.cleanMeta), so these assert the shipped code path. */

const fs = require('fs');
const path = require('path');

/* ---- shared globals ---- */
const CATALOG = [
  { id: 'aw', name: 'Application Workspace', unit: 'user' },
  { id: 'rct', name: 'Right Click Tools', unit: 'endpoint' },
  { id: 'patch', name: 'RCT — Patching', unit: 'endpoint' },
  { id: 'ins', name: 'RCT — Insights', unit: 'endpoint' },
  { id: 'priv', name: 'RCT — Privilege Manager', unit: 'endpoint' },
];
global.window = {};
global.window.SQG_CLEAN = require(path.join('..', 'clean.js')); // load the shared cleaner first
global.state = { cfg: { products: CATALOG, rules: { minUsers: 250, maxExtra: 50 } }, quote: { customer: '', email: '', partnerCompany: '', billingContact: '', billToAddress: '', shipToAddress: '' }, voice: {} };
global.int = (n) => { n = Number(String(n).replace(/[^0-9]/g, '')); return isFinite(n) ? Math.max(0, Math.floor(n)) : 0; };
global.fmt = (n) => '$' + Math.round(n).toLocaleString('en-US');
global.render = () => {}; global.flash = () => {}; global.setQ = () => {}; global.uid = () => 'x';
global.h = () => ({}); global.dsButton = () => ({});

(new Function(fs.readFileSync(path.join(__dirname, '..', 'voice.js'), 'utf8')))();
(new Function(fs.readFileSync(path.join(__dirname, '..', 'analyze.js'), 'utf8')))();
const V = global.window.SQG_VOICE, A = global.window.SQG_ANALYZE, C = global.window.SQG_CLEAN;

/* ---- helpers ---- */
function scalar(cs, f) { const c = cs.find((x) => x.type === 'scalar' && x.field === f); return c ? c.value : null; }
function findingVal(fs2, f) { const x = fs2.find((y) => y.field === f); return x ? x.value : null; }

let passed = 0, failed = 0;
const rows = [];
function check(name, source, input, expected, got) {
  const ok = String(got) === String(expected);
  rows.push({ name, source, input, expected: JSON.stringify(expected), got: JSON.stringify(got), ok });
  ok ? passed++ : failed++;
  console.log('• ' + name);
  console.log('    [' + source + ']  ' + JSON.stringify(input));
  console.log('    expected ' + JSON.stringify(expected) + '   got ' + JSON.stringify(got) + '   ' + (ok ? 'PASS' : 'FAIL'));
  console.log('');
}

/* Mirror of app.js buildQuoteData's final guard: build a meta and clean it with
   the same call app.js makes, so these tests exercise the shipped path. */
function cleanedMeta(metaIn, sourceUrl) {
  const fromPage = !!(sourceUrl && String(sourceUrl).trim());
  return C.cleanMeta(metaIn, fromPage);
}

console.log('── Value cleaning (Bugs 2 & 3) — exact broken strings from the attached quote ──\n');

/* 1 — voice: sentence-fragment customer */
{
  const cs = V._parse('customer Amazon. Selling Application Workspace to them').commands;
  check('1. Voice: sentence fragment in customer name', 'voice.js parse()',
    'customer Amazon. Selling Application Workspace to them', 'Amazon', scalar(cs, 'customer'));
}

/* 2 — voice: fused emails → one valid each */
{
  const cs = V._parse('email bob@simpleservices.com.partneremail.bob@simpleservices.com').commands;
  check('2a. Voice: fused email → single valid email', 'voice.js parse()',
    'bob@simpleservices.com.partneremail.bob@simpleservices.com', 'bob@simpleservices.com', scalar(cs, 'email'));
  check('2b. Voice: fused email → partnerEmail split out', 'voice.js parse()',
    '(same phrase)', 'bob@simpleservices.com', scalar(cs, 'partnerEmail'));
}

/* 3 — app guard: legitimate trailing abbreviation preserved */
{
  const m = cleanedMeta({ customer: 'Gulfstream Aerospace Corp.', billToName: 'Gulfstream Aerospace Corp.', shipToName: 'Gulfstream Aerospace Corp.', email: 'a@b.com' }, 'https://sf.example/opportunity');
  check('3. App guard: "Corp." abbreviation preserved', 'app.js meta guard (cleanMeta)',
    'Gulfstream Aerospace Corp.', 'Gulfstream Aerospace Corp.', m.customer);
}

/* 4 — analyze: UI action word stripped from captured value */
{
  const findings = A._buildAiFindings({ customer: 'Insight Preview' }).findings;
  check('4. Analyze: UI action word "Preview" stripped', 'analyze.js buildAiFindings()',
    'Insight Preview', 'Insight', findingVal(findings, 'customer'));
}

/* 5 — app guard: hand-typed value (no sourceUrl) survives action-word scrub */
{
  const m = cleanedMeta({ customer: 'Preview Inc', billToName: 'Preview Inc', shipToName: 'Preview Inc', email: 'a@b.com' }, ''); // no sourceUrl → hand-typed
  check('5. App guard: hand-typed "Preview Inc" (no sourceUrl) untouched', 'app.js meta guard (cleanMeta)',
    'Preview Inc', 'Preview Inc', m.customer);
}

/* 6 — app guard: malformed email prints blank */
{
  const m = cleanedMeta({ customer: 'Acme', email: 'bob at simple services', partnerEmail: '' }, '');
  check('6. App guard: invalid email → blank on the PDF', 'app.js meta guard (cleanMeta)',
    'bob at simple services', '', m.email);
}

/* ---- extra guards that back the six above (no false positives) ---- */
console.log('── supporting guards ──\n');
{
  // "Preview Inc" DOES get scrubbed when it may have come from the page (fromPage true).
  const m = cleanedMeta({ customer: 'Preview Inc', email: 'a@b.com' }, 'https://sf.example/opportunity');
  check('7. App guard: page-sourced "Preview Inc" → "Inc"', 'app.js meta guard (fromPage=true)', 'Preview Inc', 'Inc', m.customer);
  // Interior punctuation and comma preserved.
  const m2 = cleanedMeta({ customer: 'Recast Software, Inc.', email: 'a@b.com' }, '');
  check('8. App guard: "Recast Software, Inc." unchanged', 'app.js meta guard (cleanMeta)', 'Recast Software, Inc.', 'Recast Software, Inc.', m2.customer);
  // Valid email passes through.
  const m3 = cleanedMeta({ customer: 'Acme', email: 'jane@acme.com' }, '');
  check('9. App guard: valid email passes through', 'app.js meta guard (cleanMeta)', 'jane@acme.com', 'jane@acme.com', m3.email);
}

/* ---- report ---- */
console.log('================= CLEANING RESULTS =================');
const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
console.log(pad('CASE', 52) + pad('EXPECTED', 30) + pad('GOT', 30) + 'OK');
console.log('-'.repeat(118));
rows.forEach((r) => console.log(pad(r.name, 52) + pad(r.expected, 30) + pad(r.got, 30) + (r.ok ? 'PASS' : 'FAIL')));
console.log('-'.repeat(118));
console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
