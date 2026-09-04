'use strict';

/* Footing harness for the v3.9 quote PDF figures (app.js — pdfFigures).
   NOT shipped in the manifest — run manually with Node:

       node tests/pdfmath.test.js

   It loads the extension's OWN app.js head-less and drives SQG_APP._pdfFigures
   (the exact figures the PDF prints) against SQG_APP._model (the calculator's
   pricing model) for every quote type, asserting on the PRINTED strings that:

     • Qty × Unit List Price = Extended List           (per line, to the cent)
     • Extended List − Discount Amt = Net Price        (per line, to the cent)
     • Σ Extended List = Total List Price = the model's list contract value
     • Σ Discount Amt  = Σ waterfall discount lines = Total List − Net Total
     • Σ Net Price     = Net Total = Grand Total = the calculator's total (m.tcvC)
     • an undiscounted line prints "0%" and "$0.00" — never blank
     • every figure carries the currency symbol
     • the worked example: 20,000 × $2.8875 = $57,750.00, Partner Discount (25%)
       −$14,437.50, Net Total / Grand Total $43,312.50 */

const fs = require('fs');
const path = require('path');

global.window = {};
(new Function(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')))();
const APP = global.window.SQG_APP;
if (!APP || typeof APP._pdfFigures !== 'function' || typeof APP._model !== 'function') {
  console.error('app.js did not expose SQG_APP._pdfFigures / SQG_APP._model');
  process.exit(1);
}

let passed = 0, failed = 0;
const rows = [];
function check(scope, label, ok, detail) {
  rows.push({ scope, label, ok, detail: detail == null ? '' : String(detail) });
  ok ? passed++ : failed++;
}
function eq(scope, label, expected, got) { check(scope, label, String(expected) === String(got), 'expected ' + expected + ', got ' + got); }

/* ---- parse the printed strings back to cents ---- */
function cents(str, sym) {
  const s = String(str);
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  if (!body.startsWith(sym)) return NaN;
  const n = Number(body.slice(sym.length).replace(/,/g, ''));
  return (neg ? -1 : 1) * Math.round(n * 100);
}
function unitNumber(str, sym) { return Number(String(str).slice(sym.length).replace(/,/g, '')); }
function qtyNumber(str) { return Number(String(str).replace(/,/g, '')); }

/* ---- the generic footing contract, applied to every case ---- */
function foot(scope, cfg, q) {
  const fig = APP._pdfFigures(cfg, q);
  const m = APP._model(cfg, q);
  const sym = fig.sym;
  const wf = fig.waterfall;
  let sumExt = 0, sumDisc = 0, sumNet = 0;
  fig.items.forEach((it, i) => {
    const tag = 'line ' + (i + 1) + ' (' + it.name + ')';
    const ext = cents(it.extList, sym), disc = cents(it.discAmt, sym), net = cents(it.net, sym);
    check(scope, tag + ': figures carry the symbol', !isNaN(ext) && !isNaN(disc) && !isNaN(net), it.extList + ' / ' + it.discAmt + ' / ' + it.net);
    check(scope, tag + ': Extended − Discount = Net', ext - disc === net, it.extList + ' − ' + it.discAmt + ' = ' + it.net);
    if (it.qty !== '—') {
      const prod = Math.round(unitNumber(it.unitList, sym) * qtyNumber(it.qty) * 100);
      check(scope, tag + ': Qty × Unit = Extended', prod === ext, it.qty + ' × ' + it.unitList + ' = ' + (prod / 100).toFixed(2) + ' vs ' + it.extList);
    } else {
      eq(scope, tag + ': current product prints — for unit', '—', it.unitList);
    }
    check(scope, tag + ': Discount % never blank', /^\d+(\.\d+)?%$/.test(it.discPct), it.discPct);
    if (disc === 0) {
      eq(scope, tag + ': zero discount prints 0%', '0%', it.discPct);
      eq(scope, tag + ': zero discount prints ' + sym + '0.00', sym + '0.00', it.discAmt);
    } else {
      const pct = disc / ext * 100;
      check(scope, tag + ': Discount % matches Amt / Extended', Math.abs(Number(it.discPct.slice(0, -1)) - pct) < 0.006, it.discPct + ' vs ' + pct.toFixed(4));
    }
    sumExt += ext; sumDisc += disc; sumNet += net;
  });
  const list = cents(wf.list, sym), net = cents(wf.net, sym), grand = cents(wf.grand, sym);
  const layerSum = wf.discounts.reduce((a, d) => a - cents(d.amt, sym), 0);
  check(scope, 'waterfall has at least one discount line', wf.discounts.length >= 1, wf.discounts.length);
  wf.discounts.forEach((d) => check(scope, 'discount line labelled with its %: ' + d.label, /\(\d+(\.\d+)?%\)$/.test(d.label), d.label));
  eq(scope, 'Σ Extended List = Total List Price', list, sumExt);
  eq(scope, 'Total List Price = model list contract value', m.msrpTcvC, list);
  eq(scope, 'Σ Discount Amt = Σ waterfall discount lines', layerSum, sumDisc);
  eq(scope, 'Total List − Σ discounts = Net Total', list - layerSum, net);
  eq(scope, 'Σ Net Price = Net Total', net, sumNet);
  eq(scope, 'Net Total = Grand Total', net, grand);
  eq(scope, 'Grand Total = calculator total (m.tcvC)', m.tcvC, grand);
  eq(scope, 'Taxes line', 'Not Included', wf.taxes);
  eq(scope, 'model waterfall ends on tcvC', m.tcvC, m.tcvStepsC[4]);
  eq(scope, 'model waterfall starts on list', m.msrpTcvC, m.tcvStepsC[0]);
  return { fig, m };
}

function quote(over) { return Object.assign(APP._defaultQuote(), over || {}); }
const future = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

/* ============ (a) the worked example: 20,000 × $2.8875, partner 25% ============ */
{
  const cfg = APP.defaults();
  const q = quote({ customerType: 'current', dealType: 'ren', partner: true, marginRenPct: 25,
    renewLines: [{ id: 'r1', productId: 'rct', qty: 20000, price: 57750 }] });
  const { fig } = foot('(a) worked example', cfg, q);
  const it = fig.items[0];
  eq('(a) worked example', 'qty', '20,000', it.qty);
  eq('(a) worked example', 'unit list price (4 decimals)', '$2.8875', it.unitList);
  eq('(a) worked example', 'extended list', '$57,750.00', it.extList);
  eq('(a) worked example', 'discount %', '25%', it.discPct);
  eq('(a) worked example', 'discount amt', '$14,437.50', it.discAmt);
  eq('(a) worked example', 'net price', '$43,312.50', it.net);
  eq('(a) worked example', 'Total List Price', '$57,750.00', fig.waterfall.list);
  eq('(a) worked example', 'one discount line', 1, fig.waterfall.discounts.length);
  eq('(a) worked example', 'Partner Discount label', 'Partner Discount (25%)', fig.waterfall.discounts[0].label);
  eq('(a) worked example', 'Partner Discount amount', '-$14,437.50', fig.waterfall.discounts[0].amt);
  eq('(a) worked example', 'Net Total', '$43,312.50', fig.waterfall.net);
  eq('(a) worked example', 'Grand Total', '$43,312.50', fig.waterfall.grand);
}

/* ============ (b) direct net-new, no discount: same template, zeros ============ */
{
  const cfg = APP.defaults();
  const q = quote({ lines: [{ id: 'l1', productId: 'aw', qty: 10000 }] });
  const { fig } = foot('(b) direct, no discount', cfg, q);
  eq('(b) direct, no discount', 'discount %', '0%', fig.items[0].discPct);
  eq('(b) direct, no discount', 'discount amt', '$0.00', fig.items[0].discAmt);
  eq('(b) direct, no discount', 'Discount (0%) line', 'Discount (0%)', fig.waterfall.discounts[0].label);
  eq('(b) direct, no discount', 'Discount (0%) amount', '$0.00', fig.waterfall.discounts[0].amt);
  eq('(b) direct, no discount', 'list = net', fig.waterfall.list, fig.waterfall.net);
  eq('(b) direct, no discount', 'unit list price (graduated user tiers -> 4 decimals)', '$39.5982', fig.items[0].unitList);
  eq('(b) direct, no discount', 'extended list', '$395,982.00', fig.items[0].extList);
}

/* ===== (c) partner + bundle + extra + term, 3 years, five lines (mixed units) ===== */
{
  const cfg = APP.defaults();
  cfg.terms = [{ years: 1, pct: 0 }, { years: 2, pct: 0 }, { years: 3, pct: 5 }];
  const q = quote({ partner: true, marginNewPct: 20, extraPct: 10, years: 3, months: 36, supportAll: true,
    lines: [{ id: 'l1', productId: 'aw', qty: 1234 }, { id: 'l2', productId: 'rct', qty: 25000 }, { id: 'l3', productId: 'patch', qty: 25000 },
      { id: 'l4', productId: 'ins', qty: 7777 }, { id: 'l5', productId: 'priv', qty: 25000 }] });
  const { fig } = foot('(c) all four layers, 3 yr', cfg, q);
  eq('(c) all four layers, 3 yr', 'four discount lines', 'RCT Bundle Discount (25%)|Partner Discount (20%)|Extra Discount (10%)|Term Discount (5%)',
    fig.waterfall.discounts.map((d) => d.label).join('|'));
  // the user line gets no bundle discount, so its effective % differs from the endpoint lines
  check('(c) all four layers, 3 yr', 'user line (no bundle) discounted less than endpoint lines',
    Number(fig.items[0].discPct.slice(0, -1)) < Number(fig.items[1].discPct.slice(0, -1)), fig.items[0].discPct + ' vs ' + fig.items[1].discPct);
}

/* ============ (d) co-term add-on: fractional term multiplier ============ */
{
  const cfg = APP.defaults();
  const q = quote({ customerType: 'current', dealType: 'addon', coTermDate: future(200), partner: true, marginNewPct: 20,
    lines: [{ id: 'l1', productId: 'rct', qty: 3210 }, { id: 'l2', productId: 'ins', qty: 3210 }] });
  foot('(d) co-term add-on', cfg, q);
}

/* ===== (e) add-on + renewal with current products (no qty, 0% lines) ===== */
{
  const cfg = APP.defaults();
  const q = quote({ customerType: 'current', dealType: 'addonren', coTermDate: future(120), years: 2, months: 24, partner: true, marginNewPct: 15,
    lines: [{ id: 'l1', productId: 'patch', qty: 4321 }],
    existing: [{ id: 'e1', productId: 'rct', price: 12345.67 }, { id: 'e2', productId: 'aw', price: 20000 }] });
  const { fig } = foot('(e) add-on + renewal', cfg, q);
  eq('(e) add-on + renewal', 'current product qty prints —', '—', fig.items[1].qty);
  eq('(e) add-on + renewal', 'current product discount %', '0%', fig.items[1].discPct);
  eq('(e) add-on + renewal', 'current product discount amt', '$0.00', fig.items[1].discAmt);
  eq('(e) add-on + renewal', 'current product 2 discount amt', '$0.00', fig.items[2].discAmt);
}

/* ===== (f) multi-year renewal with uplift, partner 15%, 3 renewing lines ===== */
{
  const cfg = APP.defaults();
  const q = quote({ customerType: 'current', dealType: 'ren', partner: true, marginRenPct: 15, uplift: true, upliftPct: 3, years: 3, months: 36,
    renewLines: [{ id: 'r1', productId: 'rct', qty: 20000, price: 133000 }, { id: 'r2', productId: 'ins', qty: 20000, price: 45000.33 },
      { id: 'r3', productId: 'aw', qty: 2500, price: 9999.99 }] });
  foot('(f) 3-yr renewal + uplift', cfg, q);
}

/* ============ (g) prorated 18-month direct quote, extra discount only ============ */
{
  const cfg = APP.defaults();
  cfg.allowProration = true;
  const q = quote({ years: 2, months: 18, extraPct: 7.5, lines: [{ id: 'l1', productId: 'rct', qty: 999 }, { id: 'l2', productId: 'aw', qty: 250 }] });
  const { fig } = foot('(g) prorated 18 mo, extra 7.5%', cfg, q);
  eq('(g) prorated 18 mo, extra 7.5%', 'Extra Discount label', 'Extra Discount (7.5%)', fig.waterfall.discounts[0].label);
}

/* ============ (h) EUR: the symbol rides on every figure ============ */
{
  const cfg = APP.defaults();
  const q = quote({ currency: 'EUR', partner: true, marginNewPct: 25, lines: [{ id: 'l1', productId: 'rct', qty: 20000 }] });
  const { fig } = foot('(h) EUR', cfg, q);
  eq('(h) EUR', 'symbol', '€', fig.sym);
  check('(h) EUR', 'unit / extended / discount / net all start with €', [fig.items[0].unitList, fig.items[0].extList, fig.items[0].discAmt, fig.items[0].net].every((s) => s.startsWith('€')), JSON.stringify(fig.items[0]));
  check('(h) EUR', 'waterfall discount is negative euro', fig.waterfall.discounts[0].amt.startsWith('-€'), fig.waterfall.discounts[0].amt);
}

/* ============ (i) 100% margin: net is zero, still foots ============ */
{
  const cfg = APP.defaults();
  const q = quote({ partner: true, marginNewPct: 100, lines: [{ id: 'l1', productId: 'ins', qty: 5000 }] });
  const { fig } = foot('(i) 100% margin', cfg, q);
  eq('(i) 100% margin', 'net', '$0.00', fig.items[0].net);
  eq('(i) 100% margin', 'discount %', '100%', fig.items[0].discPct);
}

/* ---- report ---- */
const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
console.log('── v3.9 PDF figures foot (window.SQG_APP._pdfFigures) ──\n');
let lastScope = '';
rows.forEach((r) => {
  if (r.scope !== lastScope) { console.log('• ' + r.scope); lastScope = r.scope; }
  if (!r.ok || process.argv.includes('-v')) console.log('    ' + pad(r.label, 60) + (r.ok ? 'PASS' : 'FAIL  ' + r.detail));
});
const scopes = [...new Set(rows.map((r) => r.scope))];
console.log('\n================= FOOTING RESULTS =================');
scopes.forEach((sc) => {
  const rs = rows.filter((r) => r.scope === sc);
  const bad = rs.filter((r) => !r.ok).length;
  console.log(pad(sc, 40) + pad(rs.length + ' checks', 12) + (bad ? 'FAIL (' + bad + ')' : 'PASS'));
});
console.log('-'.repeat(64));
console.log('TOTAL: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
