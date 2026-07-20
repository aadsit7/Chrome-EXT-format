'use strict';

/* Test harness for app.js's exported pure helpers.
   NOT shipped in the manifest — run manually with Node:

       node tests/quotetypes.test.js

   It loads the extension's OWN app.js (its boot is guarded so it runs head-less
   with no DOM) and drives the exported pure helpers on window.SQG_APP:

     • defaults()                     — the default enabledQuoteTypes set
     • SQG_APP.quoteTypes.clamp()     — clamp a disabled combination to an enabled one
     • SQG_APP.quoteTypes.toggle()    — the last-enabled-type guardrail
     • SQG_APP.osmPick()              — "Look up address" fallback candidate filter
                                        (the input is a COMPANY name: rivers/places
                                        are rejected, office-like hits win)
     • SQG_APP._defaultQuote()        — fresh-quote factory (v3.8: auto renewal
                                        starts Yes and has no UI toggle)

   Pure functions only (no DOM, no state mutation), so this runs on a bare Node
   with no dependencies. */

const fs = require('fs');
const path = require('path');

/* app.js assigns window.SQG_APP and, at load, only reads localStorage/document
   inside try/catch or behind a DOM guard — so stubbing window is enough. */
global.window = {};
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
(new Function(src))();
const APP = global.window.SQG_APP;
if (!APP || !APP.quoteTypes || typeof APP.defaults !== 'function') {
  console.error('app.js did not expose SQG_APP.quoteTypes / SQG_APP.defaults');
  process.exit(1);
}
const QT = APP.quoteTypes;
const defaults = APP.defaults;

/* ---- tiny assertion framework ---- */
let passed = 0, failed = 0;
const rows = [];
function checkEq(label, field, expected, got) {
  const ok = String(got) === String(expected);
  rows.push({ label, field, expected: String(expected), got: got == null ? '(none)' : String(got), ok });
  ok ? passed++ : failed++;
}

/* ============================ (a) default cfg ============================ */
console.log('\n── (a) defaults() → only net-new enabled ──');
const d = defaults();
checkEq('default cfg', 'new enabled', true, d.enabledQuoteTypes.new);
checkEq('default cfg', 'addon disabled', false, d.enabledQuoteTypes.addon);
checkEq('default cfg', 'ren disabled', false, d.enabledQuoteTypes.ren);
checkEq('default cfg', 'addonren disabled', false, d.enabledQuoteTypes.addonren);

/* ============================ (b) clamping ============================ */
console.log('\n── (b) restored quote clamps a disabled type to an enabled one ──');
// A restored in-progress quote is customerType "current" / dealType "ren" while
// only net-new is enabled → it clamps to customerType "new".
const clampNew = QT.clamp(defaults(), 'current', 'ren');
checkEq('clamp → new', 'changed', true, clampNew.changed);
checkEq('clamp → new', 'customerType', 'new', clampNew.customerType);
checkEq('clamp → new', 'target key', 'new', clampNew.key);

// When net-new is OFF, the clamp picks the first enabled current type in order
// addon > ren > addonren (here addon is off, so it lands on ren).
const cfgNoNew = { enabledQuoteTypes: { new: false, addon: false, ren: true, addonren: true } };
const clampCur = QT.clamp(cfgNoNew, 'current', 'addon');
checkEq('clamp → current', 'changed', true, clampCur.changed);
checkEq('clamp → current', 'customerType', 'current', clampCur.customerType);
checkEq('clamp → current', 'dealType (first enabled current)', 'ren', clampCur.dealType);

// An already-enabled combination is left untouched.
const cfgAll = { enabledQuoteTypes: { new: true, addon: true, ren: true, addonren: true } };
const clampNoop = QT.clamp(cfgAll, 'current', 'ren');
checkEq('clamp noop', 'changed', false, clampNoop.changed);
checkEq('clamp noop', 'dealType kept', 'ren', clampNoop.dealType);

/* ============================ (e) guardrail ============================ */
console.log('\n── (e) last-enabled-type guardrail ──');
// Disabling the ONLY enabled type is rejected.
const reject = QT.toggle(defaults(), 'new', false);
checkEq('guardrail', 'reject disabling last type (ok)', false, reject.ok);
checkEq('guardrail', 'set unchanged (new still on)', true, reject.enabledQuoteTypes.new);

// Disabling one of several enabled types is allowed.
const allow = QT.toggle(cfgAll, 'new', false);
checkEq('guardrail', 'disabling one of many (ok)', true, allow.ok);
checkEq('guardrail', 'new now off', false, allow.enabledQuoteTypes.new);

// Turning a type ON is always allowed.
const turnOn = QT.toggle(defaults(), 'ren', true);
checkEq('guardrail', 'enabling a type (ok)', true, turnOn.ok);
checkEq('guardrail', 'ren now on', true, turnOn.enabledQuoteTypes.ren);

/* ============ (f) "Look up address" — company-aware fallback filter ============
   The lookup input is always a COMPANY name ("Amazon" = the company, never the
   river). osmPick must reject non-company geocoder hits and prefer office /
   headquarters results with a real street address. */
console.log('\n── (f) osmPick — company-aware candidate filter ──');
const RIVER = { class: 'waterway', type: 'river', display_name: 'Amazon, South America', address: { country: 'Brazil' } };
const CITY = { class: 'place', type: 'city', display_name: 'Amazon City', address: { city: 'Amazon City', country: 'Utopia' } };
const HQ = { class: 'office', type: 'company', display_name: 'Amazon Headquarters, 410 Terry Avenue North, Seattle',
  address: { house_number: '410', road: 'Terry Avenue North', city: 'Seattle', state: 'Washington', postcode: '98109', country: 'United States' } };
const SHOP = { class: 'shop', type: 'books', display_name: 'Amazon Books, 100 Side St',
  address: { road: 'Side St', city: 'Elsewhere', country: 'United States' } };

checkEq('osmPick', 'river alone → rejected (null)', null, APP.osmPick([RIVER]));
checkEq('osmPick', 'bare city alone → rejected (null)', null, APP.osmPick([CITY]));
checkEq('osmPick', 'river + HQ → picks the HQ', HQ.display_name, (APP.osmPick([RIVER, HQ]) || {}).display_name);
checkEq('osmPick', 'shop + HQ → office/HQ outranks the shop', HQ.display_name, (APP.osmPick([SHOP, HQ]) || {}).display_name);
checkEq('osmPick', 'street-addressed hit accepted when alone', SHOP.display_name, (APP.osmPick([SHOP]) || {}).display_name);
checkEq('osmPick', 'no street evidence → rejected (null)', null, APP.osmPick([{ class: 'office', type: 'company', display_name: 'X', address: {} }]));
checkEq('osmPick', 'empty / garbage input → null', null, APP.osmPick(null));

/* ============ (g) auto renewal — always Yes, no UI control (v3.8) ============
   Every fresh quote starts with autoRenewal true (the PDF prints
   "Auto Renewal: Yes"), and app.js no longer renders a toggle for it —
   the render source must not build an 'Auto renewal' control. */
console.log('\n── (g) auto renewal fixed to Yes ──');
checkEq('auto renewal', 'fresh quote starts Yes', true, APP._defaultQuote().autoRenewal);
const appSrc = src; // the exact app.js source loaded above
checkEq('auto renewal', 'no Auto renewal toggle rendered', false, /sqg-toggle-title'\s*},\s*'Auto renewal'/.test(appSrc));
checkEq('auto renewal', 'restored quotes coerced to Yes', true, /state\.quote\.autoRenewal = true/.test(appSrc));

/* ---- report ---- */
console.log('\n================= RESULTS =================');
const pad = function (s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
console.log(pad('CASE', 20) + pad('ASSERTION', 40) + pad('EXPECTED', 12) + pad('GOT', 12) + 'OK');
console.log('-'.repeat(90));
rows.forEach(function (r) {
  console.log(pad(r.label, 20) + pad(r.field, 40) + pad(r.expected, 12) + pad(r.got, 12) + (r.ok ? 'PASS' : 'FAIL'));
});
console.log('-'.repeat(90));
console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
