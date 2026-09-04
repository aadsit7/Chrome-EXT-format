'use strict';

/* Layout harness for the flow-based one-page PDF (pdf.js — Bug 1).
   NOT shipped in the manifest — run manually with Node:

       node tests/layout.test.js

   It drives the extension's OWN exported layout probe (window.SQG_PDF._layoutProbe)
   with eight representative quotes and asserts, off the recorded glyph boxes, that
   every one of them:
     • fits on ONE page  (the last signature rule lands above BOTTOM_LIMIT),
     • has ZERO overlapping text bounding boxes  (no value collides with a
       neighbouring label or column — the "Email over Currency" bug),
     • has ZERO column overflows  (no glyph is drawn outside the printable area,
       the two Email slots stay inside their 136pt / 170pt columns, and — v3.9 —
       every product-table figure stays inside its own column: right-aligned at
       the column's right edge and never reaching into the column to its left),
     • prints the v3.9 totals waterfall in full (Total List Price, one line per
       discount, Net Total, Taxes, Grand Total) with every figure right-aligned
       on the same 588pt edge as the Net Price column.

   The bundled-logo call (chrome.runtime.getURL) is stubbed away, so no logo is
   drawn — it has a fixed position in the header and doesn't affect the flow. */

const fs = require('fs');
const path = require('path');

/* ---- stub the chrome.runtime logo call; pdf.js needs nothing else ---- */
global.window = {};
global.chrome = { runtime: { getURL: function () { return ''; } } };
(new Function(fs.readFileSync(path.join(__dirname, '..', 'pdf.js'), 'utf8')))();
const PDF = global.window.SQG_PDF;
if (!PDF || typeof PDF._layoutProbe !== 'function') { console.error('pdf.js did not expose SQG_PDF._layoutProbe'); process.exit(1); }

/* ---- geometry helpers ---- */
// Glyph vertical extent around the baseline (ascent above, descender below).
function box(t) { return { x: t.x, r: t.x + t.w, top: t.y - t.size * 0.72, bot: t.y + t.size * 0.24, str: t.str, y: t.y, w: t.w, size: t.size }; }
function overlaps(a, b) {
  const xo = Math.min(a.r, b.r) - Math.max(a.x, b.x);
  const yo = Math.min(a.bot, b.bot) - Math.max(a.top, b.top);
  return xo > 0.5 && yo > 0.5; // >0.5pt on BOTH axes = a real overlap (contiguous tokens share only an edge)
}

const PRINT_LEFT = 11.5, PRINT_RIGHT = 600.5; // printable band (right OD column legitimately reaches 600)

function checkCase(name, data) {
  const res = PDF._layoutProbe(data);
  const boxes = res.texts.map(box);
  const out = { name: name, onePage: false, overlaps: [], overflows: [], lastRuleY: res.layout.lastRuleY };

  // 1) one page
  out.onePage = res.layout.lastRuleY <= res.BOTTOM_LIMIT;

  // 2) zero overlapping text boxes
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlaps(boxes[i], boxes[j])) out.overlaps.push([boxes[i].str, boxes[j].str, boxes[i].y.toFixed(0)]);
    }
  }

  // 3) zero column overflows — nothing outside the printable band, and each Email
  //    slot stays inside its own column (214+136=350 in Order Details; 172+170=342
  //    in the Bill To block).
  boxes.forEach((b) => {
    if (b.x < PRINT_LEFT - 0.01 || b.r > PRINT_RIGHT + 0.01) out.overflows.push([b.str, 'x=' + b.x.toFixed(1) + ' r=' + b.r.toFixed(1)]);
  });
  const L = res.layout;
  boxes.forEach((b) => {
    if (Math.abs(b.y - L.odRow2) < 1.5 && b.x > 210 && b.x < 220 && b.r > 350.5) out.overflows.push([b.str, 'Order Details Email past Currency (r=' + b.r.toFixed(1) + ')']);
    if (Math.abs(b.x - 172) < 1.5 && /^Email:/.test(b.str) && b.r > 342.5) out.overflows.push([b.str, 'Bill To email past column (r=' + b.r.toFixed(1) + ')']);
  });

  // 4) v3.9 product-table columns: every figure drawn on a product row sits
  //    inside its own column (right edge on COL.r, left edge no further left than
  //    COL.r - COL.w), and the product name / term subline never cross into Qty.
  const COL = PDF._columns;
  const M = L.metrics;
  const rowTops = [];
  for (let i = 0; i < res.plan.rowCount; i++) rowTops.push(L.rowTop0 + i * M.rowH);
  const numCols = ['qty', 'unit', 'ext', 'pct', 'disc', 'net'];
  rowTops.forEach((top) => {
    boxes.forEach((b) => {
      if (Math.abs(b.y - (top + M.rowNameDy)) > 0.6 && Math.abs(b.y - (top + M.rowTermDy)) > 0.6) return; // not on this row
      if (b.x < COL.name.x + 0.01 + COL.name.w && b.x >= COL.name.x - 0.01) {
        if (b.r > COL.name.x + COL.name.w + 0.01) out.overflows.push([b.str, 'product name past its column (r=' + b.r.toFixed(1) + ')']);
        return;
      }
      const col = numCols.find((k) => Math.abs(b.r - COL[k].r) < 0.05);
      if (!col) { out.overflows.push([b.str, 'row figure not on a column edge (r=' + b.r.toFixed(1) + ')']); return; }
      if (b.x < COL[col].r - COL[col].w - 0.01) out.overflows.push([b.str, col + ' figure wider than its column (x=' + b.x.toFixed(1) + ')']);
    });
  });

  // 4b) v3.9: a quote of up to five products prints EVERY line — the "+N more"
  //     fold is a last resort for pathological counts only, never for a normal
  //     quote that merely has several discount layers (density compresses first).
  out.folded = data.items.length <= 5 && res.plan.rowCount !== data.items.length;
  out.rowsPrinted = res.plan.rowCount + '/' + data.items.length;
  out.dense = M.dense;

  // 5) v3.9 totals waterfall: every label + value present, values on the 588 edge.
  const wf = data.waterfall;
  const want = [['Total List Price', wf.list]].concat(wf.discounts.map((d) => [d.label, d.amt]))
    .concat([['Net Total', wf.net], ['Taxes', 'Not Included'], ['Grand Total', wf.grand]]);
  out.missing = [];
  want.forEach((pair) => {
    const lab = boxes.find((b) => b.str === pair[0] && Math.abs(b.r - 492) < 0.05);
    const val = boxes.find((b) => b.str === pair[1] && Math.abs(b.r - 588) < 0.05 && lab && Math.abs(b.y - lab.y) < 0.01);
    if (!lab || !val) out.missing.push(pair[0] + ' = ' + pair[1]);
  });

  return out;
}

/* ---- quote builders ----
   Items carry the v3.9 pre-formatted column strings exactly as app.js's pdfFigures
   emits them (the arithmetic itself is asserted in pdfmath.test.js). */
function money(n, sym) { return (sym || '$') + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function item(name, qty, ext, pct, sym) {
  sym = sym || '$';
  pct = pct || 0;
  const qtyN = Number(String(qty).replace(/,/g, ''));
  const disc = Math.round(ext * pct) / 100;
  return {
    name: name, start: '07/17/2026', end: '07/16/2027', qty: String(qty),
    unitList: sym + (ext / qtyN).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
    extList: money(ext, sym), discPct: pct + '%', discAmt: money(disc, sym), net: money(ext - disc, sym),
  };
}
function waterfall(list, discounts, sym) {
  sym = sym || '$';
  let net = list;
  const lines = (discounts || []).map((d) => { const amt = Math.round(list * d[1]) / 100; net -= amt; return { label: d[0] + ' (' + d[1] + '%)', amt: (amt ? '-' : '') + money(amt, sym) }; });
  if (!lines.length) lines.push({ label: 'Discount (0%)', amt: money(0, sym) });
  return { list: money(list, sym), discounts: lines, net: money(net, sym), taxes: 'Not Included', grand: money(net, sym) };
}
function baseMeta(over) {
  return Object.assign({
    number: 'QT-2026-1234', customer: 'Acme', email: 'a@b.com', preparedBy: 'Aaron Adsit',
    partnerActive: false, partnerCompany: '', partnerEmail: '',
    billToName: 'Acme', billToAddress: '123 Main St\nMinneapolis, MN 55402\nUnited States',
    shipToName: 'Acme', shipToAddress: '123 Main St\nMinneapolis, MN 55402',
    billingFrequency: 'Annually', autoRenewal: 'No', expiresDisp: '08/16/2026',
    billingContact: 'Jane Doe', paymentMethod: 'Credit Card, ACH/Wire, Check', paymentTerms: 'Net 120', currency: 'USD',
  }, over || {});
}

const LONG_ADDR = 'Attention: Accounts Payable Department, Building 7\n1200 Enterprise Technology Parkway, Suite 4400\nSan Francisco, California 94105-1802\nUnited States of America';
const LONG_NAME = 'Insight Global Technology Solutions & Managed Services Incorporated';
const LONG_EMAIL = 'alexander.christopherson-worthington@insight-global-technology.example.com'; // 60+ chars

const CASES = [
  { name: '(a) minimal direct quote',
    data: { items: [item('Application Workspace', '10,000', 94410)], waterfall: waterfall(94410, []),
      meta: baseMeta({ billToAddress: '', shipToAddress: '', billingContact: '', email: '' }) } },

  { name: '(b) direct, long customer name + long addresses',
    data: { items: [item('Right Click Tools', '20,000', 133000)], waterfall: waterfall(133000, []),
      meta: baseMeta({ customer: LONG_NAME, billToName: LONG_NAME, shipToName: LONG_NAME,
        billToAddress: LONG_ADDR, shipToAddress: LONG_ADDR, billingContact: 'Bartholomew Higginbotham III' }) } },

  { name: '(c) partner quote, all partner fields long',
    data: { items: [item('Application Workspace', '25,000', 250000, 25)], waterfall: waterfall(250000, [['Partner Discount', 25]]),
      meta: baseMeta({ partnerActive: true, customer: LONG_NAME,
        partnerCompany: 'Reseller Partners International Distribution Group LLC',
        partnerEmail: 'orders-and-fulfillment@reseller-partners-international.example.com',
        billToName: 'Reseller Partners International Distribution Group LLC',
        shipToName: LONG_NAME, billToAddress: LONG_ADDR, shipToAddress: LONG_ADDR,
        billingContact: 'Reginald Worthington-Fitzgerald' }) } },

  { name: '(d) partner quote at max product lines',
    data: {
      items: [item('Application Workspace', '25,000', 250000, 20), item('Right Click Tools', '25,000', 133000, 20),
        item('RCT — Patching', '25,000', 60000, 20), item('RCT — Insights', '25,000', 45000, 20),
        item('RCT — Privilege Manager', '25,000', 24000, 20)],
      waterfall: waterfall(512000, [['Partner Discount', 20]]),
      meta: baseMeta({ partnerActive: true, partnerCompany: 'Reseller Partners International LLC',
        partnerEmail: 'orders@reseller.example.com', billToName: 'Reseller Partners International LLC',
        billToAddress: LONG_ADDR, shipToAddress: LONG_ADDR, billingContact: 'Reginald Worthington' }) } },

  { name: '(e) partner renewal quote (the $2.8875 unit-price example)',
    data: { items: [item('Right Click Tools 20,000 endpoints · renews', '20,000', 57750, 25)],
      waterfall: waterfall(57750, [['Partner Discount', 25]]),
      meta: baseMeta({ partnerActive: true, customer: 'Gulfstream Aerospace Corp.',
        partnerCompany: 'Insight', partnerEmail: 'orders@insight.com', billToName: 'Insight',
        shipToName: 'Gulfstream Aerospace Corp.', autoRenewal: 'Yes', billingContact: 'Travis Xiong' }) } },

  { name: '(f) quote with a 60+ character email',
    data: { items: [item('Application Workspace', '10,000', 94410)], waterfall: waterfall(94410, []),
      meta: baseMeta({ email: LONG_EMAIL, billToAddress: '123 Main St\nMinneapolis, MN 55402', shipToAddress: '123 Main St' }) } },

  // v3.9 worst case for height: max product lines, every discount layer showing
  // (four waterfall lines), long addresses — must still fit one page.
  { name: '(g) max lines + all four discount layers + long addresses',
    data: {
      items: [item('Application Workspace', '1,234', 1250000.5, 48.75), item('Right Click Tools', '25,000', 133000, 48.75),
        item('RCT — Patching', '25,000', 60000, 48.75), item('RCT — Insights', '25,000', 45000, 48.75),
        item('RCT — Privilege Manager', '25,000', 24000, 48.75)],
      waterfall: waterfall(1512000.5, [['RCT Bundle Discount', 25], ['Partner Discount', 20], ['Extra Discount', 10], ['Term Discount', 5]]),
      meta: baseMeta({ partnerActive: true, customer: LONG_NAME, partnerCompany: 'Reseller Partners International Distribution Group LLC',
        partnerEmail: 'orders-and-fulfillment@reseller-partners-international.example.com',
        billToName: 'Reseller Partners International Distribution Group LLC', shipToName: LONG_NAME,
        billToAddress: LONG_ADDR, shipToAddress: LONG_ADDR, billingContact: 'Reginald Worthington-Fitzgerald', email: LONG_EMAIL }) } },

  // v3.9 pathological count: 12 products can only fit by folding the tail into
  // the "+N more" note — it must still be ONE page with a complete waterfall.
  { name: '(i) twelve products (fold tail, still one page)',
    data: {
      items: ['Application Workspace', 'Right Click Tools', 'RCT — Patching', 'RCT — Insights', 'RCT — Privilege Manager', 'Application Workspace',
        'Right Click Tools', 'RCT — Patching', 'RCT — Insights', 'RCT — Privilege Manager', 'Application Workspace', 'Right Click Tools'].map((n, i) => item(n, '1,000', 5000 + i, 20)),
      waterfall: waterfall(60066, [['Partner Discount', 20]]),
      meta: baseMeta({ partnerActive: true, partnerCompany: 'Insight', partnerEmail: 'orders@insight.com', billToName: 'Insight' }) } },

  // v3.9 non-USD: the symbol rides on every figure (WinAnsi € glyph, measured).
  { name: '(h) EUR quote with a 4-decimal unit price',
    data: { items: [item('Right Click Tools', '20,000', 57750, 25, '€')], waterfall: waterfall(57750, [['Partner Discount', 25]], '€'),
      meta: baseMeta({ partnerActive: true, partnerCompany: 'Bechtle AG', partnerEmail: 'orders@bechtle.example', billToName: 'Bechtle AG', currency: 'EUR' }) } },
];

/* ---- run ---- */
console.log('── Flow-based one-page PDF layout (window.SQG_PDF._layoutProbe) ──\n');
let failed = 0;
const rows = [];
CASES.forEach((c) => {
  const r = checkCase(c.name, c.data);
  const ok = r.onePage && r.overlaps.length === 0 && r.overflows.length === 0 && r.missing.length === 0 && !r.folded;
  if (!ok) failed++;
  rows.push(r);
  console.log('• ' + c.name);
  console.log('    one-page fit     : ' + (r.onePage ? 'PASS' : 'FAIL') + '  (lastRuleY ' + r.lastRuleY.toFixed(1) + ' / limit 772; density ' + r.dense + ')');
  console.log('    every line shown : ' + (r.folded ? 'FAIL' : 'PASS') + '  (' + r.rowsPrinted + ' rows)');
  console.log('    zero overlaps    : ' + (r.overlaps.length === 0 ? 'PASS' : 'FAIL (' + r.overlaps.length + ')'));
  if (r.overlaps.length) r.overlaps.slice(0, 6).forEach((o) => console.log('        ⚠ "' + o[0] + '"  ×  "' + o[1] + '"  @y' + o[2]));
  console.log('    zero col overflow: ' + (r.overflows.length === 0 ? 'PASS' : 'FAIL (' + r.overflows.length + ')'));
  if (r.overflows.length) r.overflows.slice(0, 6).forEach((o) => console.log('        ⚠ "' + o[0] + '"  ' + o[1]));
  console.log('    totals waterfall : ' + (r.missing.length === 0 ? 'PASS' : 'FAIL (' + r.missing.length + ' missing)'));
  if (r.missing.length) r.missing.slice(0, 6).forEach((o) => console.log('        ⚠ ' + o));
  console.log('');
});

console.log('================= LAYOUT RESULTS =================');
const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
console.log(pad('CASE', 56) + pad('ONE-PAGE', 10) + pad('OVERLAPS', 10) + pad('OVERFLOW', 10) + pad('TOTALS', 8) + pad('LINES', 7) + 'OK');
console.log('-'.repeat(105));
rows.forEach((r) => {
  const ok = r.onePage && r.overlaps.length === 0 && r.overflows.length === 0 && r.missing.length === 0 && !r.folded;
  console.log(pad(r.name, 56) + pad(r.onePage ? 'PASS' : 'FAIL', 10) + pad(r.overlaps.length === 0 ? 'PASS' : 'FAIL', 10) + pad(r.overflows.length === 0 ? 'PASS' : 'FAIL', 10) + pad(r.missing.length === 0 ? 'PASS' : 'FAIL', 8) + pad(r.folded ? 'FAIL' : 'PASS', 7) + (ok ? 'PASS' : 'FAIL'));
});
console.log('-'.repeat(105));
console.log('TOTAL: ' + (rows.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
