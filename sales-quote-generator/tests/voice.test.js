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
function checkNull(label, field, got) {
  const ok = got == null;
  rows.push({ label, field, expected: '(none)', got: got == null ? '(none)' : String(got), ok });
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

  /* ---- regression guards for issues found in adversarial review ---- */
  {
    name: 'Two discount %s back-to-back: each keeps its own keyword (no hijack)',
    text: 'partner margin 20 percent, extra discount 5 percent',
    assert: function (cs) {
      checkEq('Multi-pct', 'partner margin %', 20, partnerMargin(cs));
      checkEq('Multi-pct', 'extra discount %', 5, extraPct(cs));
    },
  },
  {
    name: 'Discount % immediately before an increase % (no connector)',
    text: 'extra discount 5 percent annual increase 3 percent',
    assert: function (cs) {
      checkEq('Discount+increase', 'extra discount %', 5, extraPct(cs));
      checkEq('Discount+increase', 'annual increase %', 3, uplift(cs));
    },
  },
  {
    name: 'Prepositional capture must not swallow a bare quantity as the customer',
    text: 'quote for 3000 endpoints',
    assert: function (cs) {
      checkNull('Bare-qty', 'customer (not "3000 …")', scalar(cs, 'customer'));
    },
  },
  {
    name: 'Name right after a customer-type phrase still fills',
    text: 'current customer Acme Corporation',
    assert: function (cs) {
      checkEq('Type+name', 'customer type', 'current', customerType(cs));
      checkEq('Type+name', 'customer', 'Acme Corporation', scalar(cs, 'customer'));
    },
  },
  {
    name: 'Net-new phrase immediately followed by the customer name',
    text: 'new customer Globex Industries',
    assert: function (cs) {
      checkEq('New+name', 'customer type', 'new', customerType(cs));
      checkEq('New+name', 'customer', 'Globex Industries', scalar(cs, 'customer'));
    },
  },

  /* ---- CHANGE 2a: full multi-word company capture ---- */
  {
    name: 'Company name containing "and" is captured in full (prepositional)',
    text: 'deal with Johnson and Johnson',
    assert: function (cs) {
      checkEq('Name-with-and', 'customer (full name)', 'Johnson And Johnson', scalar(cs, 'customer'));
    },
  },
  {
    name: 'Company name starting with a number word is captured in full',
    text: 'customer is Seven Hills Software',
    assert: function (cs) {
      checkEq('Number-word name', 'customer (full name)', 'Seven Hills Software', scalar(cs, 'customer'));
    },
  },
  {
    name: 'A real quantity after the name still ends the capture',
    text: 'customer Acme two thousand endpoints',
    assert: function (cs) {
      checkEq('Name-then-qty', 'customer', 'Acme', scalar(cs, 'customer'));
    },
  },

  /* ---- CHANGE 2b: spoken contact fills the new Contact name field ---- */
  {
    name: 'Spoken contact routes to the new contactName field',
    text: 'contact name John Smith, billing contact Pat Lee',
    assert: function (cs) {
      checkEq('Contact fields', 'contactName', 'John Smith', scalar(cs, 'contactName'));
      checkEq('Contact fields', 'billingContact', 'Pat Lee', scalar(cs, 'billingContact'));
    },
  },
  {
    name: 'Bare "contact" also fills Contact name',
    text: 'contact is Mary Jones',
    assert: function (cs) {
      checkEq('Bare contact', 'contactName', 'Mary Jones', scalar(cs, 'contactName'));
      checkNull('Bare contact', 'billingContact untouched', scalar(cs, 'billingContact'));
    },
  },
  {
    // Regression: the boundary at the next field keyword used to leave a
    // dangling article on the name — "customer Amazon the email is …"
    // captured "Amazon The". The tail trim must drop it.
    name: 'Dangling article before the next keyword is trimmed',
    text: 'customer Amazon the email is johnsmith at amazon dot com',
    assert: function (cs) {
      checkEq('Dangling-article', 'customer', 'Amazon', scalar(cs, 'customer'));
      checkEq('Dangling-article', 'email', 'johnsmith@amazon.com', scalar(cs, 'email'));
    },
  },

  /* ---- PDF output-formatting guards (v3.5) — from a real broken PDF ---- */
  {
    // "Contact: John Smith At Amazon.Com The" on the PDF: a person-name field
    // must end where the company/email attachment begins.
    name: 'Person name ends at "at" in run-on dictation',
    text: 'contact name john smith at amazon dot com the lookup address should be automatically working',
    assert: function (cs) {
      checkEq('Person-at-cut', 'contactName', 'John Smith', scalar(cs, 'contactName'));
    },
  },
  {
    // "johnsmith@amazon.comthelookupaddressshoul" on the PDF: dictation with no
    // pause after "dot com" fuses into a glob with no valid TLD boundary — NO
    // email is captured (the field stays as it was; garbage never lands).
    name: 'Run-on dictation glob is never captured as an email',
    text: 'email john smith at amazon dot com the lookup address should be automatically working for the user',
    assert: function (cs) {
      checkNull('Email-glob', 'email (glob rejected)', scalar(cs, 'email'));
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

/* ============ CHANGE 2a: known-company spelling snap ============
   _parse takes an optional list of company names the tool already knows
   (in the extension: the quote's customer / partner company). A close mishear
   or a leading-words match snaps to the known spelling; a genuinely different
   or LONGER spoken name is kept as spoken. */
console.log('\n• Known-company spelling snap (Change 2a)');
(function () {
  const KNOWN = ['Gulfstream Aerospace Corporation'];
  const snap = (t) => { const c = V._parse(t, KNOWN).commands.find((x) => x.type === 'scalar' && x.field === 'customer'); return c ? c.value : null; };
  checkEq('Known snap', 'mishear → known spelling', 'Gulfstream Aerospace Corporation', snap('customer goldstream aerospace corporation'));
  checkEq('Known snap', 'leading words → full known name', 'Gulfstream Aerospace Corporation', snap('quote for gulfstream aerospace'));
  checkEq('Known snap', 'different name stays as spoken', 'Initech', snap('customer is Initech'));
  checkEq('Known snap', 'longer spoken name is never truncated', 'Gulfstream Aerospace Corporation Devco', snap('customer gulfstream aerospace corporation devco'));
})();

/* ============ CHANGE 1: voice is silent after stopping ============
   The post-listening recap panel ("Filled live from your voice" + editable
   transcript + Done / Re-apply) is retired: reviewBox() must render NOTHING,
   even in the exact state that used to show it (stopped, with heard text and
   applied fields). */
console.log('\n• No recap panel after stopping (Change 1)');
(function () {
  global.state.voice = { on: false, interim: '', finalText: '', error: '', heard: 'right click tools 2500 endpoints', applied: ['Right Click Tools → 2,500 endpoints'] };
  checkEq('Silent stop', 'reviewBox() renders nothing', null, V.reviewBox());
  global.state.voice = {};
})();

/* ============ Quote-type enablement guardrail (Task c) ============
   A spoken command that targets a disabled quote type is SKIPPED through the
   applier (window.SQG_VOICE._buildPatch): no state change and a
   "<type> — not enabled" note in the applied feedback. Enabled types still apply. */
console.log('\n• Voice respects Settings → Quote types');
console.log('    “it’s a renewal” with renewals turned off → skipped');
(function () {
  const saved = global.state.cfg.enabledQuoteTypes;

  // Only net-new enabled → "it's a renewal" is skipped, no patch, skip label shown.
  global.state.quote = {};
  global.state.cfg.enabledQuoteTypes = { new: true, addon: false, ren: false, addonren: false };
  const off = V._buildPatch(parse("it's a renewal"));
  checkEq('Voice type off', 'no state change (hasChange)', false, off.hasChange);
  checkTrue('Voice type off', 'skip label "Renewal — not enabled"', off.labels.indexOf('Renewal — not enabled') > -1);

  // All types enabled → the same phrase applies dealType "ren" as before.
  global.state.quote = {};
  global.state.cfg.enabledQuoteTypes = { new: true, addon: true, ren: true, addonren: true };
  const on = V._buildPatch(parse("it's a renewal"));
  checkEq('Voice type on', 'dealType applied', 'ren', on.patch.dealType);
  checkTrue('Voice type on', 'state changed (hasChange)', on.hasChange === true);

  global.state.cfg.enabledQuoteTypes = saved;
})();

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
