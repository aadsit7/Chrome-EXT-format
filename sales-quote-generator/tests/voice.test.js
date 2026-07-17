'use strict';

/* Test harness for the upgraded "Speak to fill" LIVE voice parser (voice.js).
   NOT shipped in the manifest — run manually with Node:

       node tests/voice.test.js

   It drives the extension's OWN exported parser (window.SQG_VOICE._parse) with a
   set of spoken-phrase fixtures that mix field order the way people actually talk
   — prepositional customer phrasing ("selling X to Amazon", "quote for Costco",
   "deal with Acme"), spelled-out numbers, discount vs margin either side of the
   percentage, term, quantities and customer/deal type — and asserts every part
   routes to the right command. The label-first phrasing that worked before must
   still parse identically (additive-only), so a label-first fixture is included.

   Pure parser only: _parse touches no DOM and no app state beyond
   state.cfg.products, so this runs on a bare Node with no dependencies. */

/* ---- minimal globals voice.js reads at call time ---- */
const fs = require('fs');
const path = require('path');

const CATALOG = [
  { id: 'aw', name: 'Application Workspace', unit: 'user' },
  { id: 'rct', name: 'Right Click Tools', unit: 'endpoint' },
  { id: 'patch', name: 'RCT — Patching', unit: 'endpoint' },
  { id: 'ins', name: 'RCT — Insights', unit: 'endpoint' },
  { id: 'priv', name: 'RCT — Privilege Manager', unit: 'endpoint' },
];
global.window = {};
global.state = { cfg: { products: CATALOG, rules: { minUsers: 250, maxExtra: 50 } }, quote: {}, voice: {} };
// Harmless stubs — _parse never calls these, but keep them defined for safety.
global.render = function () {};
global.flash = function () {};
global.setQ = function () {};
global.uid = function () { return 'x'; };
global.h = function () { return {}; };
global.dsButton = function () { return {}; };

/* Load voice.js (assigns window.SQG_VOICE). */
const src = fs.readFileSync(path.join(__dirname, '..', 'voice.js'), 'utf8');
(new Function(src))();
const V = global.window.SQG_VOICE;
if (!V || typeof V._parse !== 'function') { console.error('voice.js did not expose SQG_VOICE._parse'); process.exit(1); }

/* ---- read commands out of a parse ---- */
function parse(text) { return V._parse(text).commands; }
function scalar(cs, field) { const c = cs.find((x) => x.type === 'scalar' && x.field === field); return c ? c.value : null; }
function extraPct(cs) { const c = cs.find((x) => x.type === 'pct' && x.field === 'extraPct'); return c ? c.value : null; }
function partnerMargin(cs) { const c = cs.find((x) => x.type === 'partner' && x.margin != null); return c ? c.margin : null; }
function uplift(cs) { const c = cs.find((x) => x.type === 'uplift'); return c ? c.value : null; }
function support(cs) { const c = cs.find((x) => x.type === 'support'); return c ? c.value : null; }
function customerType(cs) { const c = cs.find((x) => x.type === 'customerType'); return c ? c.value : null; }
function dealType(cs) { const c = cs.find((x) => x.type === 'dealType'); return c ? c.value : null; }
function termYears(cs) { const c = cs.find((x) => x.type === 'term'); return c ? c.years : null; }
function hasProduct(cs, id) { return cs.some((x) => x.type === 'lineQty' && x.productId === id); }
function qtyOf(cs, id) { const c = cs.find((x) => x.type === 'lineQty' && x.productId === id); return c ? c.qty : undefined; }

/* ---- tiny assertion framework ---- */
let passed = 0, failed = 0;
const rows = [];
function checkEq(label, field, expected, got) {
  const ok = String(got) === String(expected);
  rows.push({ label, field, expected: String(expected), got: got == null ? '(none)' : String(got), ok });
  ok ? passed++ : failed++;
}
function checkTrue(label, field, got) {
  const ok = got === true;
  rows.push({ label, field, expected: 'true', got: got === true ? 'true' : String(got), ok });
  ok ? passed++ : failed++;
}

/* ============================ FIXTURES ============================ */
/* Each fixture: a spoken phrase + the command values it must produce.
   `assert(cs)` receives the parsed commands and calls the check* helpers. */
const FIXTURES = [
  {
    name: 'Canonical — selling X to Y, spelled-out discount, new customer',
    text: "We are selling Application Workspace to Amazon with a fifteen percent discount. It's a new customer.",
    assert: function (cs) {
      checkTrue('Canonical', 'product = Application Workspace', hasProduct(cs, 'aw'));
      checkEq('Canonical', 'customer', 'Amazon', scalar(cs, 'customer'));
      checkEq('Canonical', 'extra discount %', 15, extraPct(cs));
      checkEq('Canonical', 'customer type', 'new', customerType(cs));
    },
  },
  {
    name: 'Label-first phrasing still works (additive-only guard)',
    text: 'customer Acme Corporation, extra discount 5 percent, two year term',
    assert: function (cs) {
      checkEq('Label-first', 'customer', 'Acme Corporation', scalar(cs, 'customer'));
      checkEq('Label-first', 'extra discount %', 5, extraPct(cs));
      checkEq('Label-first', 'term years', 2, termYears(cs));
    },
  },
  {
    name: 'quote for <Name>, product, quantity, term',
    text: 'quote for Costco, Right Click Tools, 2,500 endpoints, two year term',
    assert: function (cs) {
      checkEq('quote for', 'customer', 'Costco', scalar(cs, 'customer'));
      checkTrue('quote for', 'product = Right Click Tools', hasProduct(cs, 'rct'));
      checkEq('quote for', 'quantity', 2500, qtyOf(cs, 'rct'));
      checkEq('quote for', 'term years', 2, termYears(cs));
    },
  },
  {
    name: 'Partner margin (keyword before %)',
    text: 'Right Click Tools 2,500 endpoints, partner margin 20 percent',
    assert: function (cs) {
      checkEq('Partner margin', 'partner margin %', 20, partnerMargin(cs));
      checkEq('Partner margin', 'quantity', 2500, qtyOf(cs, 'rct'));
    },
  },
  {
    name: 'Renewal phrasing + prepositional customer',
    text: "It's a renewal for Gulfstream Aerospace Corporation",
    assert: function (cs) {
      checkEq('Renewal', 'deal type', 'ren', dealType(cs));
      checkEq('Renewal', 'customer', 'Gulfstream Aerospace Corporation', scalar(cs, 'customer'));
    },
  },
  {
    name: 'Margin keyword AFTER the % (both-sides) + selling…to + bare product',
    text: 'sell Right Click Tools to Costco with a twenty percent margin',
    assert: function (cs) {
      checkEq('Margin-after', 'partner margin %', 20, partnerMargin(cs));
      checkEq('Margin-after', 'customer', 'Costco', scalar(cs, 'customer'));
      checkTrue('Margin-after', 'product = Right Click Tools', hasProduct(cs, 'rct'));
    },
  },
  {
    name: 'Net new + single-word product with quantity + prepositional customer',
    text: 'net new, selling Insights to Initech, 3,000 endpoints',
    assert: function (cs) {
      checkEq('Net-new', 'customer type', 'new', customerType(cs));
      checkEq('Net-new', 'customer', 'Initech', scalar(cs, 'customer'));
      checkEq('Net-new', 'quantity (Insights)', 3000, qtyOf(cs, 'ins'));
    },
  },
  {
    name: 'Discount BEFORE the number (both-sides) + generic "for" customer',
    text: 'discount of fifteen percent for Amazon',
    assert: function (cs) {
      checkEq('Discount-before', 'extra discount %', 15, extraPct(cs));
      checkEq('Discount-before', 'customer', 'Amazon', scalar(cs, 'customer'));
    },
  },
  {
    name: 'Trailing-keyword term ("a term of three years") + customer',
    text: 'a term of three years for Costco',
    assert: function (cs) {
      checkEq('Trailing-term', 'term years', 3, termYears(cs));
      checkEq('Trailing-term', 'customer', 'Costco', scalar(cs, 'customer'));
    },
  },
];

/* ============================ RUN ============================ */
console.log('── Speak-to-fill live parser (window.SQG_VOICE._parse) ──\n');
FIXTURES.forEach(function (fx) {
  console.log('• ' + fx.name);
  console.log('    “' + fx.text + '”');
  fx.assert(parse(fx.text));
});

/* ---- report ---- */
console.log('\n================= RESULTS =================');
const pad = function (s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
console.log(pad('FIXTURE', 18) + pad('ASSERTION', 34) + pad('EXPECTED', 26) + pad('GOT', 26) + 'OK');
console.log('-'.repeat(112));
rows.forEach(function (r) {
  console.log(pad(r.label, 18) + pad(r.field, 34) + pad(r.expected, 26) + pad(r.got, 26) + (r.ok ? 'PASS' : 'FAIL'));
});
console.log('-'.repeat(112));
console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
