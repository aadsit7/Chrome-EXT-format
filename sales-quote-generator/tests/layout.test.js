'use strict';

/* Layout harness for the flow-based one-page PDF (pdf.js — Bug 1).
   NOT shipped in the manifest — run manually with Node:

       node tests/layout.test.js

   It drives the extension's OWN exported layout probe (window.SQG_PDF._layoutProbe)
   with six representative quotes and asserts, off the recorded glyph boxes, that
   every one of them:
     • fits on ONE page  (the last signature rule lands above BOTTOM_LIMIT),
     • has ZERO overlapping text bounding boxes  (no value collides with a
       neighbouring label or column — the "Email over Currency" bug), and
     • has ZERO column overflows  (no glyph is drawn outside the printable area,
       and the two Email slots stay inside their 136pt / 170pt columns).

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

  return out;
}

/* ---- quote builders ---- */
function item(name, qty, total) {
  return { name: name, start: '07/17/2026', end: '07/16/2027', qty: String(qty), total: total };
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
    data: { tcvPdf: '94,410.00', items: [item('Application Workspace', '10,000', '94,410.00')],
      meta: baseMeta({ billToAddress: '', shipToAddress: '', billingContact: '', email: '' }) } },

  { name: '(b) direct, long customer name + long addresses',
    data: { tcvPdf: '133,000.00', items: [item('Right Click Tools', '20,000', '133,000.00')],
      meta: baseMeta({ customer: LONG_NAME, billToName: LONG_NAME, shipToName: LONG_NAME,
        billToAddress: LONG_ADDR, shipToAddress: LONG_ADDR, billingContact: 'Bartholomew Higginbotham III' }) } },

  { name: '(c) partner quote, all partner fields long',
    data: { tcvPdf: '250,000.00', items: [item('Application Workspace', '25,000', '250,000.00')],
      meta: baseMeta({ partnerActive: true, customer: LONG_NAME,
        partnerCompany: 'Reseller Partners International Distribution Group LLC',
        partnerEmail: 'orders-and-fulfillment@reseller-partners-international.example.com',
        billToName: 'Reseller Partners International Distribution Group LLC',
        shipToName: LONG_NAME, billToAddress: LONG_ADDR, shipToAddress: LONG_ADDR,
        billingContact: 'Reginald Worthington-Fitzgerald' }) } },

  { name: '(d) partner quote at max product lines',
    data: { tcvPdf: '512,000.00',
      items: [item('Application Workspace', '25,000', '250,000.00'), item('Right Click Tools', '25,000', '133,000.00'),
        item('RCT — Patching', '25,000', '60,000.00'), item('RCT — Insights', '25,000', '45,000.00'),
        item('RCT — Privilege Manager', '25,000', '24,000.00')],
      meta: baseMeta({ partnerActive: true, partnerCompany: 'Reseller Partners International LLC',
        partnerEmail: 'orders@reseller.example.com', billToName: 'Reseller Partners International LLC',
        billToAddress: LONG_ADDR, shipToAddress: LONG_ADDR, billingContact: 'Reginald Worthington' }) } },

  { name: '(e) partner renewal quote',
    data: { tcvPdf: '133,000.00', items: [item('Right Click Tools 20,000 endpoints · renews', '20,000', '133,000.00')],
      meta: baseMeta({ partnerActive: true, customer: 'Gulfstream Aerospace Corp.',
        partnerCompany: 'Insight', partnerEmail: 'orders@insight.com', billToName: 'Insight',
        shipToName: 'Gulfstream Aerospace Corp.', autoRenewal: 'Yes', billingContact: 'Travis Xiong' }) } },

  { name: '(f) quote with a 60+ character email',
    data: { tcvPdf: '94,410.00', items: [item('Application Workspace', '10,000', '94,410.00')],
      meta: baseMeta({ email: LONG_EMAIL, billToAddress: '123 Main St\nMinneapolis, MN 55402', shipToAddress: '123 Main St' }) } },
];

/* ---- run ---- */
console.log('── Flow-based one-page PDF layout (window.SQG_PDF._layoutProbe) ──\n');
let failed = 0;
const rows = [];
CASES.forEach((c) => {
  const r = checkCase(c.name, c.data);
  const ok = r.onePage && r.overlaps.length === 0 && r.overflows.length === 0;
  if (!ok) failed++;
  rows.push(r);
  console.log('• ' + c.name);
  console.log('    one-page fit     : ' + (r.onePage ? 'PASS' : 'FAIL') + '  (lastRuleY ' + r.lastRuleY.toFixed(1) + ' / limit 772)');
  console.log('    zero overlaps    : ' + (r.overlaps.length === 0 ? 'PASS' : 'FAIL (' + r.overlaps.length + ')'));
  if (r.overlaps.length) r.overlaps.slice(0, 6).forEach((o) => console.log('        ⚠ "' + o[0] + '"  ×  "' + o[1] + '"  @y' + o[2]));
  console.log('    zero col overflow: ' + (r.overflows.length === 0 ? 'PASS' : 'FAIL (' + r.overflows.length + ')'));
  if (r.overflows.length) r.overflows.slice(0, 6).forEach((o) => console.log('        ⚠ "' + o[0] + '"  ' + o[1]));
  console.log('');
});

console.log('================= LAYOUT RESULTS =================');
const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
console.log(pad('CASE', 44) + pad('ONE-PAGE', 10) + pad('OVERLAPS', 10) + pad('OVERFLOW', 10) + 'OK');
console.log('-'.repeat(84));
rows.forEach((r) => {
  const ok = r.onePage && r.overlaps.length === 0 && r.overflows.length === 0;
  console.log(pad(r.name, 44) + pad(r.onePage ? 'PASS' : 'FAIL', 10) + pad(r.overlaps.length === 0 ? 'PASS' : 'FAIL', 10) + pad(r.overflows.length === 0 ? 'PASS' : 'FAIL', 10) + (ok ? 'PASS' : 'FAIL'));
});
console.log('-'.repeat(84));
console.log('TOTAL: ' + (rows.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
