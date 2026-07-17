'use strict';

/* Test harness for the upgraded "Analyze this page" feature (analyze.js).
   NOT shipped in the manifest — run manually with Node:

       node tests/analyze.test.js

   It feeds two fixtures modeled on the attached Salesforce Opportunity PDFs (a
   new-business page and a renewal page) through the extension's OWN exported
   functions (window.SQG_ANALYZE._extract / _mergeFrames / _buildFindings /
   _buildAiFindings / _snapshot / _buildSnapshotText) and asserts that customer,
   partner, renewal date, term months, product and quantity come out right for
   both pages — through the rule-based DOM path AND the AI-response path.

   The DOM path uses jsdom if it's installed (npm i -D jsdom, or point NODE_PATH
   at a jsdom install). Without jsdom it skips the DOM-driven checks and still
   runs the AI-path checks, so the script always runs on a bare Node. */

const fs = require('fs');
const path = require('path');
const fx = require('./fixtures');

/* ---- minimal app.js globals the panel-side functions read at call time ---- */
const CATALOG = [
  { id: 'aw', name: 'Application Workspace', unit: 'user' },
  { id: 'rct', name: 'Right Click Tools', unit: 'endpoint' },
  { id: 'patch', name: 'RCT — Patching', unit: 'endpoint' },
  { id: 'ins', name: 'RCT — Insights', unit: 'endpoint' },
  { id: 'priv', name: 'RCT — Privilege Manager', unit: 'endpoint' },
];
function freshQuote() {
  return {
    customer: '', email: '', partnerCompany: '', partnerEmail: '', billingContact: '',
    billToAddress: '', shipToAddress: '', expires: '', currency: '', coTermDate: '',
    months: 12, years: 1, lines: [], renewLines: [],
    // deal / discount / support state the AI review path (Task 2) can fill
    customerType: 'new', dealType: 'addon', partner: false,
    marginNewPct: 20, marginRenPct: 15, extraPct: 0, supportAll: false,
  };
}
global.int = function (n) { n = Number(String(n).replace(/[^0-9]/g, '')); return isFinite(n) ? Math.max(0, Math.floor(n)) : 0; };
global.fmt = function (n) { return '$' + Math.round(n).toLocaleString('en-US'); };
global.state = { quote: freshQuote(), cfg: { products: CATALOG, rules: { maxExtra: 50, minUsers: 250 } }, sections: { deal: false, selling: false, discounts: false, who: false } };
global.window = {};
/* Stubs so the panel-side apply path (applyFindings → setQ) runs under Node. */
let __uid = 0;
global.uid = function () { return 'x' + (++__uid); };
global.render = function () {};
global.flash = function () {};
global.setQ = function (p) { global.state.quote = Object.assign({}, global.state.quote, p); };

/* Load analyze.js into this scope (it assigns window.SQG_ANALYZE). */
const src = fs.readFileSync(path.join(__dirname, '..', 'analyze.js'), 'utf8');
(new Function(src))();
const A = global.window.SQG_ANALYZE;

const PRODUCT_KEYMAP = [
  { key: 'aw', terms: ['application workspace'] },
  { key: 'rct', terms: ['right click tools', 'right-click tools'] },
  { key: 'patch', terms: ['patching'] },
  { key: 'ins', terms: ['insights'] },
  { key: 'priv', terms: ['privilege manager'] },
];
const CFG = {
  custLabels: ['customer', 'account name', 'account', 'company name', 'company', 'client'],
  billLabels: ['bill to', 'reseller', 'partner'],
  emailLabels: ['email', 'contact email'],
  qtyLabels: ['quantity', 'qty', 'current device count'],
  dateLabels: ['close date', 'end date', 'renewal date'],
  productTerms: PRODUCT_KEYMAP,
  sfLabels: A._sfLabels,
};

/* ---- jsdom (optional) ---- */
let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (e) { JSDOM = null; }
function setDom(html, url) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { url: url });
  global.document = dom.window.document;
  global.location = dom.window.location;
  return dom;
}

/* ---- tiny assertion framework ---- */
let passed = 0, failed = 0;
const rows = [];
function check(page, fieldName, expected, got) {
  const ok = got != null && got !== '' && (expected == null || String(got) === String(expected));
  rows.push({ page, field: fieldName, expected: expected == null ? '(any non-empty)' : expected, got: got == null ? '(none)' : got, ok });
  ok ? passed++ : failed++;
  return ok;
}
function checkEq(page, fieldName, expected, got) {
  const ok = String(got) === String(expected);
  rows.push({ page, field: fieldName, expected: String(expected), got: got == null ? '(none)' : String(got), ok });
  ok ? passed++ : failed++;
  return ok;
}
function checkAbsent(page, fieldName, got) {
  const ok = got == null || got === '';
  rows.push({ page, field: fieldName, expected: '(correctly absent)', got: got == null || got === '' ? '(none)' : got, ok });
  ok ? passed++ : failed++;
  return ok;
}

/* ---- helpers to read findings ---- */
function pick(findings, field) { return findings.find(function (f) { return f.field === field; }); }
function productLine(findings) { return findings.find(function (f) { return f.field === 'lineQty' || f.field === 'renewLine'; }); }
function prodName(id) { const p = CATALOG.find(function (x) { return x.id === id; }); return p ? p.name : id; }

/* ============================ RULE-BASED (DOM) PATH ============================ */
function runRulePath(label, html, url, expect) {
  console.log('\n── ' + label + ' — rule-based DOM extraction ──');
  if (!JSDOM) { console.log('  (skipped: jsdom not installed)'); return; }
  global.state.quote = freshQuote();
  setDom(html, url);
  const rawFrame = A._extract(CFG);
  if (rawFrame && rawFrame.error) { console.log('  extract error: ' + rawFrame.error); }
  const raw = A._mergeFrames([rawFrame]); // mergeFrames takes raw results (run() maps r.result first)
  const findings = A._buildFindings(raw);

  check(label, 'customer', expect.customer, pick(findings, 'customer') && pick(findings, 'customer').value);
  if (expect.partner) check(label, 'partner', expect.partner, pick(findings, 'partnerCompany') && pick(findings, 'partnerCompany').value);
  else checkAbsent(label, 'partner', pick(findings, 'partnerCompany') && pick(findings, 'partnerCompany').value);
  check(label, 'renewal date', expect.renewalDate, pick(findings, 'coTermDate') && pick(findings, 'coTermDate').value);
  checkEq(label, 'term months', expect.termMonths, pick(findings, 'term') && pick(findings, 'term').months);
  const pl = productLine(findings);
  check(label, 'product', expect.product, pl && prodName(pl.productId));
  checkEq(label, 'quantity', expect.quantity, pl && pl.qty);

  // extra visibility on precedence / labeling
  const rd = pick(findings, 'coTermDate');
  if (rd) console.log('  renewal-date finding label: "' + rd.label + '"');
  console.log('  raw.isRenewal=' + raw.isRenewal + '  qty=' + JSON.stringify(raw.qty) + '  termMonths=' + raw.termMonths);
  return raw;
}

/* ============================ AI-RESPONSE PATH ============================ */
function runAiPath(label, data, expect) {
  console.log('\n── ' + label + ' — AI-response mapping ──');
  global.state.quote = freshQuote();
  const res = A._buildAiFindings(data);
  const findings = res.findings;
  check(label + ' (AI)', 'customer', expect.customer, pick(findings, 'customer') && pick(findings, 'customer').value);
  if (expect.partner) check(label + ' (AI)', 'partner', expect.partner, pick(findings, 'partnerCompany') && pick(findings, 'partnerCompany').value);
  checkEq(label + ' (AI)', 'term months', expect.termMonths, pick(findings, 'term') && pick(findings, 'term').months);
  const pl = productLine(findings);
  check(label + ' (AI)', 'product', expect.product, pl && prodName(pl.productId));
  checkEq(label + ' (AI)', 'quantity', expect.quantity, pl && pl.qty);
  if (expect.renewalDate) check(label + ' (AI)', 'renewal date', expect.renewalDate, pick(findings, 'coTermDate') && pick(findings, 'coTermDate').value);
  if (res.note) console.log('  note: ' + res.note);
}

/* ==================== EXTENDED AI SCHEMA (Task 2) ====================
   The voice review path returns extra deal/discount fields. Prove they (1) turn
   into review-card findings via _buildAiFindings and (2) apply through the exact
   same state patches (with the clamp / max-discount rules) via applyFindings. */
function findingVal(findings, field) { const f = findings.find(function (x) { return x.field === field; }); return f ? f.value : undefined; }

function runExtendedAiPath(label, data, expectFindings, expectQuote) {
  console.log('\n── ' + label + ' — extended AI schema (Task 2) ──');
  global.state.quote = freshQuote();
  const findings = A._buildAiFindings(data).findings;
  Object.keys(expectFindings).forEach(function (field) {
    checkEq(label + ' (finding)', field, expectFindings[field], findingVal(findings, field));
  });
  // Apply through applyFindings (mirrors voice.js buildPatch) and read the quote.
  global.state.analyze = { findings: findings, url: '', source: 'voice' };
  A.applyFindings();
  const q = global.state.quote;
  Object.keys(expectQuote).forEach(function (key) {
    if (key === 'lines') {
      const ln = (q.lines || []).find(function (l) { return l.productId === expectQuote.lines.productId; });
      checkEq(label + ' (applied)', 'line ' + expectQuote.lines.productId + ' qty', expectQuote.lines.qty, ln && ln.qty);
    } else {
      checkEq(label + ' (applied)', key, expectQuote[key], q[key]);
    }
  });
}

/* ============================ SNAPSHOT (Task 1) ============================ */
async function runSnapshot(label, html, url, mustContain, mustExclude, orderBefore, orderAfter) {
  console.log('\n── ' + label + ' — prioritized AI snapshot ──');
  if (!JSDOM) { console.log('  (skipped: jsdom not installed)'); return; }
  setDom(html, url);
  const snap = await A._snapshot();
  global.state.quote = freshQuote();
  setDom(html, url);
  const rawFrame = A._extract(CFG);
  const raw = A._mergeFrames([rawFrame]);
  const text = A._buildSnapshotText([snap], raw);

  check(label, 'snapshot SOURCE line', 'SOURCE: Salesforce Opportunity record', text.split('\n')[0]);
  mustContain.forEach(function (s) {
    rows.push({ page: label, field: 'contains "' + s + '"', expected: 'present', got: text.indexOf(s) > -1 ? 'present' : 'MISSING', ok: text.indexOf(s) > -1 });
    text.indexOf(s) > -1 ? passed++ : failed++;
  });
  mustExclude.forEach(function (s) {
    const gone = text.indexOf(s) === -1;
    rows.push({ page: label, field: 'excludes "' + s + '"', expected: 'absent', got: gone ? 'absent' : 'PRESENT', ok: gone });
    gone ? passed++ : failed++;
  });
  if (orderBefore && orderAfter) {
    const ib = text.indexOf(orderBefore), ia = text.indexOf(orderAfter);
    const ok = ib > -1 && ia > -1 && ib < ia;
    rows.push({ page: label, field: '"' + orderBefore + '" before "' + orderAfter + '"', expected: 'ordered', got: ok ? 'ordered' : 'out of order', ok: ok });
    ok ? passed++ : failed++;
  }
  console.log('  snapshot length: ' + text.length + ' chars (cap 24000)');
}

/* ============================ RUN ============================ */
(async function () {
  runRulePath('NEW BUSINESS (Insight - AW MSP)', fx.NEW_BUSINESS_HTML, fx.NEW_BUSINESS_URL, {
    customer: 'Insight', partner: null, renewalDate: '2026-11-25', termMonths: 12, product: 'Application Workspace', quantity: 10000,
  });
  runRulePath('RENEWAL (Gulfstream Aerospace Corp.)', fx.RENEWAL_HTML, fx.RENEWAL_URL, {
    customer: 'Gulfstream Aerospace Corp.', partner: 'Insight', renewalDate: '2027-09-29', termMonths: 12, product: 'Right Click Tools', quantity: 20000,
  });

  runAiPath('NEW BUSINESS (Insight - AW MSP)', fx.NEW_BUSINESS_AI, {
    customer: 'Insight', partner: null, termMonths: 12, product: 'Application Workspace', quantity: 10000,
  });
  runAiPath('RENEWAL (Gulfstream Aerospace Corp.)', fx.RENEWAL_AI, {
    customer: 'Gulfstream Aerospace Corp.', partner: 'Insight', renewalDate: '2027-09-29', termMonths: 12, product: 'Right Click Tools', quantity: 20000,
  });

  // Task 2 — the extended deal/discount/support schema the voice review path returns.
  runExtendedAiPath('VOICE (Amazon, net new, 15% off)',
    { isRenewal: false, customer: 'Amazon', customerType: 'new', extraDiscountPct: 15, partnerMarginPct: 20, premiumSupport: true, termMonths: 24, lines: [{ productId: 'aw', qty: 500 }] },
    { customer: 'Amazon', customerType: 'new', extraPct: 15, partnerMargin: 20, premiumSupport: true },
    { customer: 'Amazon', customerType: 'new', extraPct: 15, partner: true, marginNewPct: 20, supportAll: true, months: 24, years: 2, lines: { productId: 'aw', qty: 500 } });

  runExtendedAiPath('VOICE (renewal, current customer)',
    { isRenewal: true, customer: 'Globex', dealType: 'ren' },
    { customer: 'Globex', dealType: 'ren' },
    { customer: 'Globex', customerType: 'current', dealType: 'ren' });

  // Clamping parity with voice.js buildPatch: extra ≤ maxExtra (50), margin ≤ 100.
  runExtendedAiPath('VOICE (over-cap discount + margin clamps)',
    { extraDiscountPct: 999, partnerMarginPct: 150 },
    { extraPct: 999, partnerMargin: 150 },
    { extraPct: 50, partner: true, marginNewPct: 100 });

  await runSnapshot('NEW BUSINESS snapshot', fx.NEW_BUSINESS_HTML, fx.NEW_BUSINESS_URL,
    ['== QUOTE INFORMATION ==', 'Application Workspace', 'Endpoint Tier'], [], 'QUOTE INFORMATION', 'ACCOUNT DETAILS');
  await runSnapshot('RENEWAL snapshot', fx.RENEWAL_HTML, fx.RENEWAL_URL,
    ['ARR up for Renewal', 'Subscription Term', 'Partner/Reseller'],
    ['Stage History', 'Opportunity Field History', 'Created By'],
    'RENEWALS', 'ACCOUNT DETAILS');

  /* ---- report ---- */
  console.log('\n================= RESULTS =================');
  const pad = function (s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
  console.log(pad('PAGE', 34) + pad('FIELD', 26) + pad('EXPECTED', 26) + pad('GOT', 26) + 'OK');
  console.log('-'.repeat(118));
  rows.forEach(function (r) {
    console.log(pad(r.page, 34) + pad(r.field, 26) + pad(r.expected, 26) + pad(r.got, 26) + (r.ok ? 'PASS' : 'FAIL'));
  });
  console.log('-'.repeat(118));
  console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed' + (JSDOM ? '' : '   (jsdom not installed — DOM checks skipped)'));
  process.exit(failed ? 1 : 0);
})();
