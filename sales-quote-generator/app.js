'use strict';

/* Sales Quote Generator — vanilla JS port of the original design-tool component.
   All pricing math (graduated tiers, computeLine, model) is kept identical.
   v2: redesigned as a single-column side-panel experience — the running quote
   lives in a bottom dock with an expandable details sheet. */

const KEY = 'sqg-v2';
const USER_KEY = 'sqg-user'; // saved user profile { userId, firstName, lastName } (captured on first run)
const PARTNER_FEATURE = true; // original prop partnerPricing, default true

/* ---- User profile (localStorage 'sqg-user') ----
   Stored as JSON { userId, firstName, lastName }. A missing value, invalid JSON,
   or a value with no userId (this includes any old plain-text name saved by the
   previous version) all mean the user is NOT registered yet. */
function readUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw); // old plain-text names aren't valid JSON → throws → not registered
    if (!u || typeof u !== 'object' || !u.userId) return null;
    return { userId: String(u.userId), firstName: String(u.firstName || ''), lastName: String(u.lastName || '') };
  } catch (e) { return null; }
}
function writeUser(u) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(u)); } catch (e) {}
}
function isRegistered() { return !!readUser(); }
function userFullName() {
  const u = readUser();
  return u ? (u.firstName + ' ' + u.lastName).trim() : '';
}
function makeUserId() {
  return 'usr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/* CHANGE 3 — adopt the server's canonical userId. The Apps Script matches people
   by first + last name and returns the ONE canonical userId for that name. Given
   any parsed JSON response from APPS_SCRIPT_URL (registerUser or saveQuote), if it
   carries a userId different from ours, silently overwrite our stored userId while
   keeping the same first/last name. No UI change. Exposed as a global so sheets.js
   can call it from its fetch callbacks. */
function adoptCanonicalId(data) {
  try {
    if (!data || typeof data !== 'object' || !data.userId) return;
    const u = readUser();
    if (!u) return;
    if (String(data.userId) === u.userId) return;
    writeUser({ userId: String(data.userId), firstName: u.firstName, lastName: u.lastName });
  } catch (e) { /* best-effort */ }
}

/* ---------------- Defaults ---------------- */

function defaults() {
  return {
    products: [
      { id: 'aw', name: 'Application Workspace', unit: 'user', platformFee: 15000, minTotal: 12000, factor: 2.2 },
      { id: 'rct', name: 'Right Click Tools', unit: 'endpoint', platformFee: 7500, minTotal: 12500, factor: 1 },
      { id: 'patch', name: 'RCT — Patching', unit: 'endpoint', platformFee: 7500, minTotal: 12500, factor: 1 },
      { id: 'ins', name: 'RCT — Insights', unit: 'endpoint', platformFee: 0, minTotal: 5000, factor: 1 },
      { id: 'priv', name: 'RCT — Privilege Manager', unit: 'endpoint', platformFee: 0, minTotal: 5000, factor: 1 },
    ],
    epTiers: [
      { upTo: 1000, rate: 5.00 }, { upTo: 2000, rate: 4.50 }, { upTo: 3000, rate: 4.25 }, { upTo: 4000, rate: 4.00 }, { upTo: 5000, rate: 3.75 },
      { upTo: 6000, rate: 3.50 }, { upTo: 7000, rate: 3.25 }, { upTo: 8000, rate: 3.00 }, { upTo: 9000, rate: 2.75 }, { upTo: 10000, rate: 2.50 },
      { upTo: 15000, rate: 2.25 }, { upTo: 20000, rate: 2.00 }, { upTo: 25000, rate: 1.75 }, { upTo: 30000, rate: 1.50 }, { upTo: 40000, rate: 1.25 },
      { upTo: 50000, rate: 1.00 }, { upTo: 60000, rate: 0.75 }, { upTo: 70000, rate: 0.50 }, { upTo: 80000, rate: 0.40 }, { upTo: 90000, rate: 0.35 },
      { upTo: 100000, rate: 0.30 }, { upTo: 120000, rate: 0.25 }, { upTo: 140000, rate: 0.20 }, { upTo: 160000, rate: 0.15 }, { upTo: 180000, rate: 0.10 },
      { upTo: 200000, rate: 0.05 }, { upTo: null, rate: 0.05 },
    ],
    userTiers: [
      { upTo: 999, rate: 4.00 }, { upTo: 4999, rate: 3.50 }, { upTo: 9999, rate: 3.00 },
      { upTo: 24999, rate: 2.50 }, { upTo: 49999, rate: 2.00 }, { upTo: null, rate: 1.50 },
    ],
    rules: { bundleMin: 2, bundlePct: 25, waiveAt: 30000, suppPct: 20, suppMin: 6000, minUsers: 250, maxExtra: 50 },
    terms: [{ years: 1, pct: 0 }, { years: 2, pct: 0 }, { years: 3, pct: 0 }],
    defaultYears: 1,
    allowProration: false,
    settingsPassword: '2026',
    // Admin setting: which quote types users may pick. Four independent on/off
    // entries. DEFAULT — only net-new is on; the three current-customer types are
    // off. Existing installs whose saved cfg lacks this key inherit this same
    // default via Object.assign(defaults(), d.cfg) on load, and "Reset to default
    // pricing" restores it like every other cfg field.
    enabledQuoteTypes: { new: true, addon: false, ren: false, addonren: false },
    // Admin setting: show the "Analyze this page" button in the bottom dock.
    // DEFAULT — hidden. Existing installs inherit this default via
    // Object.assign(defaults(), d.cfg) on load, and "Reset to default pricing"
    // restores it like every other cfg field.
    showAnalyze: false,
  };
}

/* ---------------- Quote-type enablement (admin setting) ----------------
   The four quote types and how they map onto the quote's (customerType, dealType):
     new       → customerType 'new'
     addon     → customerType 'current', dealType 'addon'
     ren       → customerType 'current', dealType 'ren'
     addonren  → customerType 'current', dealType 'addonren'
   These pure helpers are the single source of truth used by the calculator UI,
   the settings toggles, the load/new-quote clamp, and (mirrored) by voice.js and
   analyze.js. They read only the passed cfg, so they're trivially testable. */
const QUOTE_TYPE_ORDER = ['new', 'addon', 'ren', 'addonren'];
const CURRENT_TYPE_ORDER = ['addon', 'ren', 'addonren'];

function normalizeEnabledTypes(cfg) {
  const e = (cfg && cfg.enabledQuoteTypes) || {};
  const out = { new: !!e.new, addon: !!e.addon, ren: !!e.ren, addonren: !!e.addonren };
  // Never let the set be empty — a cfg with everything off falls back to net-new,
  // matching the guardrail (at least one type is always available).
  if (!out.new && !out.addon && !out.ren && !out.addonren) out.new = true;
  return out;
}
function quoteTypeKey(customerType, dealType) {
  if (customerType !== 'current') return 'new';
  return CURRENT_TYPE_ORDER.indexOf(dealType) > -1 ? dealType : 'addon';
}
function isTypeEnabled(cfg, customerType, dealType) {
  return !!normalizeEnabledTypes(cfg)[quoteTypeKey(customerType, dealType)];
}
function enabledCurrentKeys(cfg) {
  const e = normalizeEnabledTypes(cfg);
  return CURRENT_TYPE_ORDER.filter((k) => e[k]);
}
// The clamp target for a disabled combination: net-new if enabled, else the first
// enabled current type in order addon > ren > addonren.
function fallbackType(cfg) {
  const e = normalizeEnabledTypes(cfg);
  if (e.new) return 'new';
  const k = CURRENT_TYPE_ORDER.find((x) => e[x]);
  return k || 'new';
}
// Given a quote's (customerType, dealType), return the fields to use so the quote
// is always an ENABLED type. changed=true when the input combination was disabled.
function clampQuoteType(cfg, customerType, dealType) {
  if (isTypeEnabled(cfg, customerType, dealType)) {
    return { customerType, dealType, key: quoteTypeKey(customerType, dealType), changed: false };
  }
  const key = fallbackType(cfg);
  return key === 'new'
    ? { customerType: 'new', dealType, key, changed: true }
    : { customerType: 'current', dealType: key, key, changed: true };
}
function renewalCapableEnabled(cfg) {
  const e = normalizeEnabledTypes(cfg);
  return !!(e.ren || e.addonren);
}
function quoteTypeLabel(key) {
  return key === 'new' ? 'Net new customer'
    : key === 'addon' ? 'Current customer — Add-on'
    : key === 'ren' ? 'Current customer — Renewal'
    : key === 'addonren' ? 'Current customer — Add-on + renewal'
    : key;
}
// Guardrail-aware toggle: returns { ok, enabledQuoteTypes }. Turning off the LAST
// enabled type is rejected (ok=false) so at least one is always available.
function toggleEnabledType(cfg, key, on) {
  const cur = normalizeEnabledTypes(cfg);
  if (!on && cur[key] && QUOTE_TYPE_ORDER.filter((k) => cur[k]).length <= 1) {
    return { ok: false, enabledQuoteTypes: cur };
  }
  const next = Object.assign({}, cur); next[key] = !!on;
  return { ok: true, enabledQuoteTypes: next };
}

function defaultQuote() {
  const d = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  return {
    number: 'QT-' + new Date().getFullYear() + '-' + String(Math.floor(1000 + Math.random() * 9000)),
    customer: '', email: '', contactName: '', preparedBy: userFullName(), expires: d, partnerCompany: '', partnerEmail: '',
    sourceUrl: '', aiSummary: '',
    billToAddress: '', shipToAddress: '', billingContact: '',
    // Which billing fields are still AUTO-managed (mirrored from "Who's it for?"
    // / filled by address lookup). A manual edit of a billing field flips its
    // flag off, and from then on that field is never auto-overwritten again.
    // lookedUp marks a Bill To address filled by "Look up address", which shows
    // the "Auto-filled — please verify" note. (Changes 2c & 3.)
    billingAuto: { billTo: true, contact: true, lookedUp: false },
    paymentMethod: 'Credit Card, ACH/Wire, Check', paymentTerms: 'Net 120', currency: 'USD', autoRenewal: false,
    lines: [], // start empty — the user adds products (no default Right Click Tools)
    years: 1, months: 12, partner: false, customerType: 'new', dealType: 'addon', marginNewPct: 20, marginRenPct: 15, extraPct: 0, supportAll: false,
    coTermDate: new Date(Date.now() + 182 * 864e5).toISOString().slice(0, 10),
    existing: [],
    renewLines: [], // start empty for renewals too
    uplift: false, upliftPct: 3,
  };
}

/* ---------------- State ---------------- */

/* Which calculator sections are expanded. ALL four start COLLAPSED, each showing
   its one-line summary ("Net new · 1 year", "0 products · $0/yr", "None",
   "Not set"), so opening the tool is a clean, scannable overview — tap a section
   to expand it. Sections still auto-expand when something fills them (voice,
   page analyze, a validation miss on Create quote).
   Kept in memory only (not persisted) so every reload starts in this clean state. */
function defaultSections() { return { deal: false, selling: false, discounts: false, who: false }; }

const state = { view: 'calc', cfg: defaults(), quote: defaultQuote(), toast: '', toastTone: 'ok', addMenu: false, sheet: false, analyze: null, pwPrompt: false, newQuotePrompt: false, billingOpen: false, registerGate: false, sections: defaultSections(), voice: { on: false, interim: '', finalText: '', error: '', heard: '' }, pendingClampToast: '' };
let toastTimer = null;

try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const d = JSON.parse(raw);
    state.cfg = Object.assign(defaults(), d.cfg || {});
    state.quote = Object.assign(defaultQuote(), d.quote || {});
    // Migration for quotes saved before the billing auto-mirror (Change 2c):
    // billing values that already exist were typed by hand, so mark them manual;
    // empty ones stay auto-managed.
    if (!(d.quote && d.quote.billingAuto)) {
      state.quote.billingAuto = {
        billTo: !String(state.quote.billToAddress || '').trim(),
        contact: !String(state.quote.billingContact || '').trim(),
        lookedUp: false,
      };
    }
    // A restored in-progress quote may be a type the admin has since turned off
    // (or an install migrating to the new default where only net-new is on).
    // Clamp it to an enabled type and queue a one-time toast shown right after
    // the first render (flash() isn't safe until the DOM boots below).
    const clamped = clampQuoteType(state.cfg, state.quote.customerType, state.quote.dealType);
    if (clamped.changed) {
      state.quote.customerType = clamped.customerType;
      state.quote.dealType = clamped.dealType;
      state.pendingClampToast = 'Quote type no longer available — switched to ' + quoteTypeLabel(clamped.key);
    }
  }
} catch (e) { /* ignore corrupt storage */ }

// First run (or any pre-2.2 install without a valid { userId } profile): lock the
// whole app behind the first + last name registration gate until the user registers.
state.registerGate = !isRegistered();

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify({ cfg: state.cfg, quote: state.quote })); } catch (e) {}
}

/* ---- Billing auto-mirror (Change 2c) ----
   Whenever the company name (customer) or the contact name is set — typed,
   spoken, or applied from page analysis — mirror them into Billing details:
     customer    → the FIRST LINE of the Bill To address box
     contactName → the Billing contact field
   A billing field is only auto-filled while it is empty or still auto-managed
   (per the quote's billingAuto flags). The moment the user edits a billing
   field themselves — including by voice ("billing address …") or by applying a
   page-detected address — its flag flips off and their entry always wins.
   Centralized here inside setQ so every fill path behaves identically. */
function normalizeBillingAuto(q) {
  const a = (q && q.billingAuto) || {};
  return { billTo: a.billTo !== false, contact: a.contact !== false, lookedUp: a.lookedUp === true };
}
function applyBillingMirror(patch, q) {
  const out = Object.assign({}, patch);
  const auto = normalizeBillingAuto(q);
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has('billingAuto')) {
    // An explicit billingAuto in the patch marks a programmatic fill (the
    // address lookup) — honor its flags instead of treating it as a manual edit.
    Object.assign(auto, patch.billingAuto);
  } else {
    // A direct write to a billing field is a manual entry: it wins from now on.
    // Clearing the field makes it fair game for auto-fill again ("still empty").
    if (has('billToAddress')) { auto.billTo = !String(patch.billToAddress || '').trim(); auto.lookedUp = false; }
    if (has('billingContact')) auto.contact = !String(patch.billingContact || '').trim();
  }
  if (has('customer')) {
    const name = String(patch.customer || '').trim();
    const curAddr = has('billToAddress') ? String(out.billToAddress || '') : String(q.billToAddress || '');
    if (name && (auto.billTo || !curAddr.trim())) {
      // First line = company name; keep any lines below it (a looked-up address).
      const rest = curAddr.trim() ? curAddr.split('\n').slice(1) : [];
      out.billToAddress = [name].concat(rest).join('\n');
      auto.billTo = true;
    }
  }
  if (has('contactName')) {
    const cn = String(patch.contactName || '').trim();
    const curContact = has('billingContact') ? String(out.billingContact || '') : String(q.billingContact || '');
    if (cn && (auto.contact || !curContact.trim())) {
      out.billingContact = cn;
      auto.contact = true;
    }
  }
  out.billingAuto = auto;
  return out;
}

function setQ(p) { state.quote = Object.assign({}, state.quote, applyBillingMirror(p, state.quote)); persist(); render(); }
function setCfg(p) { state.cfg = Object.assign({}, state.cfg, p); persist(); render(); }
function uid() { return 'x' + Math.random().toString(36).slice(2, 8); }
function flash(text, tone) {
  clearTimeout(toastTimer);
  state.toast = text; state.toastTone = tone;
  render();
  toastTimer = setTimeout(() => { state.toast = ''; render(); }, 5000);
}

/* ---------------- Pricing math (identical to original) ---------------- */

function int(n) { n = Number(String(n).replace(/[^0-9]/g, '')); return isFinite(n) ? Math.max(0, Math.floor(n)) : 0; }
function fmt(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
function fmtU(n) { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function sortTiers(list) { return list.slice().sort((a, b) => (a.upTo == null ? Infinity : a.upTo) - (b.upTo == null ? Infinity : b.upTo)); }

function graduated(units, tiers) {
  let rem = Math.max(0, Math.floor(units)), from = 0, sum = 0;
  for (const b of tiers) {
    if (rem <= 0) break;
    const max = b.upTo == null ? Infinity : b.upTo;
    const chunk = Math.min(rem, max - from);
    if (chunk > 0) { sum += chunk * b.rate; rem -= chunk; from = max; }
  }
  return sum;
}

function computeLine(ln, cfg, supportOn) {
  const prod = cfg.products.find((p) => p.id === ln.productId) || cfg.products[0] || { name: '?', unit: 'endpoint', platformFee: 0, minTotal: 0, factor: 1, id: 'none' };
  const isUser = prod.unit === 'user';
  const r = cfg.rules;
  let units = int(ln.qty);
  let baseARR = 0, fee = 0, waived = false, bpp = 0, support = 0, minApplied = false;
  if (isUser) {
    units = Math.max(r.minUsers, units);
    baseARR = graduated(units, sortTiers(cfg.userTiers)) * 12;
    waived = true; bpp = baseARR;
  } else {
    const f = prod.factor || 1;
    const tiers = sortTiers(cfg.epTiers).map((t) => ({ upTo: t.upTo, rate: Math.max(+(t.rate * f).toFixed(4), 0.05) }));
    baseARR = graduated(units, tiers);
    fee = baseARR >= r.waiveAt ? 0 : (prod.platformFee || 0);
    waived = fee === 0 && (prod.platformFee || 0) > 0;
    bpp = Math.max(baseARR + fee, prod.minTotal || 0);
    minApplied = baseARR + fee < (prod.minTotal || 0);
    support = supportOn ? Math.max(bpp * r.suppPct / 100, r.suppMin) : 0;
  }
  const msrp = bpp + support;
  return { prod, isUser, units, baseARR, fee, waived, bpp, support, minApplied, msrp };
}

function model(cfg, q, partnerFeature) {
  const r = cfg.rules;
  const computed = q.lines.map((ln) => ({ ln, c: computeLine(ln, cfg, !!q.supportAll) }));
  const epCount = computed.filter((x) => !x.c.isUser).length;
  const bundleOn = epCount >= r.bundleMin;
  const partnerOn = partnerFeature && !!q.partner;
  const isCurrent = q.customerType === 'current';
  const dealType = isCurrent ? (q.dealType || 'addon') : 'new';
  const rawMargin = dealType === 'ren' ? (q.marginRenPct ?? 15) : (q.marginNewPct ?? 20);
  const margin = partnerOn ? Math.min(100, Math.max(0, +rawMargin || 0)) : 0;
  const extra = Math.max(0, Math.min(r.maxExtra, +q.extraPct || 0));
  let msrpC = 0, afterBundleC = 0, step1C = 0, netC = 0;
  const lines = computed.map((x) => {
    const mC = Math.round(x.c.msrp * 100);
    const bundleApplied = bundleOn && !x.c.isUser;
    const aC = bundleApplied ? Math.round(mC * (100 - r.bundlePct) / 100) : mC;
    const s1 = Math.round(aC * (100 - margin) / 100);
    const pC = Math.round(aC * (100 - margin) / 100 * (100 - extra) / 100);
    msrpC += mC; afterBundleC += aC; step1C += s1; netC += pC;
    return Object.assign({ bundleApplied }, x);
  });
  const years = q.years || 1;
  const months = q.months || years * 12;
  const isCoterm = dealType === 'addon';
  const addonRenew = dealType === 'addonren';
  const needsDate = isCoterm || addonRenew;
  const baseYears = cfg.allowProration ? months / 12 : years;
  let addonDays = 0, addonValid = false, stubYears = 0;
  if (needsDate) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = q.coTermDate ? new Date(q.coTermDate + 'T00:00:00') : null;
    addonDays = d && !isNaN(d) ? Math.round((d - today) / 864e5) : 0;
    addonValid = addonDays >= 1;
    stubYears = Math.min(5, Math.max(30, addonDays) / 365);
  }
  const effYears = isCoterm ? stubYears : baseYears;
  const existingC = addonRenew ? (q.existing || []).reduce((a, e) => a + Math.round(Math.max(0, +e.price || 0) * 100), 0) : 0;
  const floorY = Math.max(0, Math.floor(effYears + 1e-9));
  let termPct = 0;
  for (const t of cfg.terms.slice().sort((a, b) => a.years - b.years)) { if (floorY >= t.years) termPct = t.pct; }
  if (dealType === 'ren') {
    const rl = q.renewLines || [];
    const baseC = rl.reduce((a, e) => a + Math.round(Math.max(0, +e.price || 0) * 100), 0);
    const p = q.uplift ? Math.min(10, Math.max(0, +q.upliftPct || 0)) : 0;
    const nYears = Math.max(1, Math.ceil(baseYears - 1e-9));
    let tcvC2 = 0, grossC = 0; const renYears = [];
    for (let i = 1; i <= nYears; i++) {
      const frac = Math.min(1, baseYears - (i - 1));
      const rateC = Math.round(baseC * Math.pow(1 + p / 100, i));
      const amtC = Math.round(rateC * frac);
      const netYC = Math.round(amtC * (100 - margin) / 100 * (100 - extra) / 100 * (100 - termPct) / 100);
      grossC += amtC; tcvC2 += netYC;
      renYears.push({ frac, netYC });
    }
    const y1 = Math.round(baseC * (1 + p / 100));
    const s1 = Math.round(y1 * (100 - margin) / 100);
    const s2 = Math.round(y1 * (100 - margin) / 100 * (100 - extra) / 100);
    const s3 = Math.round(y1 * (100 - margin) / 100 * (100 - extra) / 100 * (100 - termPct) / 100);
    return {
      lines, bundleOn: false, partnerOn, margin, extra, termPct, effYears: baseYears,
      isCurrent, dealType, isCoterm: false, addonRenew: false, needsDate: false,
      addonDays: 0, addonValid: true, stubYears: 0, baseYears, existingC: 0, stubC: 0, renewalAnnualC: s3,
      isRenOnly: true, renBaseC: baseC, upliftP: p, upliftY1C: y1 - baseC, renYears,
      msrpC: baseC, bundleAmtC: 0, marginAmtC: y1 - s1, extraAmtC: s1 - s2, termAmtC: s2 - s3,
      netFinalC: s3, totalAnnualC: s3, tcvC: tcvC2, msrpTcvC: grossC,
    };
  }
  const termAmtC = netC - Math.round(netC * (100 - termPct) / 100);
  const netFinalC = netC - termAmtC;
  const stubC = addonRenew ? Math.round(netFinalC * stubYears) : 0;
  const renewalAnnualC = netFinalC + existingC;
  const tcvC = isCoterm ? Math.round(netFinalC * stubYears)
    : addonRenew ? stubC + Math.round(renewalAnnualC * baseYears)
    : Math.round(netFinalC * baseYears);
  const msrpTcvC = isCoterm ? Math.round(msrpC * stubYears)
    : addonRenew ? Math.round(msrpC * stubYears) + Math.round((msrpC + existingC) * baseYears)
    : Math.round(msrpC * baseYears);
  return {
    lines, bundleOn, partnerOn, margin, extra, termPct, effYears, isCurrent, dealType, isCoterm, addonRenew, needsDate,
    isRenOnly: false, renBaseC: 0, upliftP: 0, upliftY1C: 0, renYears: [],
    addonDays, addonValid, stubYears, baseYears, existingC, stubC, renewalAnnualC,
    msrpC, bundleAmtC: msrpC - afterBundleC, marginAmtC: afterBundleC - step1C, extraAmtC: step1C - netC, termAmtC,
    netFinalC, totalAnnualC: renewalAnnualC, tcvC, msrpTcvC,
  };
}

function bumpStep(isUser, qty) { return isUser ? 50 : (qty < 1000 ? 100 : qty < 10000 ? 500 : 1000); }

function initialsOf(name) {
  const words = String(name || '?').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : String(words[0] || '?').slice(0, 2)).toUpperCase();
}

/* ---------------- DOM helpers ---------------- */

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let deferredValue;
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === 'style') el.style.cssText = v;
      else if (k === 'class') el.className = v;
      else if (k === 'dataK') el.dataset.k = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') deferredValue = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  if (deferredValue !== undefined) el.value = deferredValue; // after <option> children exist
  return el;
}

const SVG_SETTINGS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
const SVG_X_MD = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
const SVG_X_SM = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
const SVG_CHEVRON_UP = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>';
const SVG_FILE_PLUS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>';
/* Dock-toolbar glyphs (20px). Presentational markup only — the handlers still
   live in analyze.js (run) and voice.js (toggle). Scan mirrors SVG_SCAN in
   analyze.js; mic/stop mirror SVG_MIC/SVG_STOP in voice.js. */
const SVG_SCAN_DOCK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><circle cx="12" cy="12" r="3"></circle><path d="m16 16-1.9-1.9"></path></svg>';
const SVG_FILE_PLUS_DOCK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>';
const SVG_MIC_DOCK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>';
const SVG_STOP_DOCK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2.5"></rect></svg>';

function iconButton(name, size, onClick, ariaLabel) {
  const btn = h('button', { class: 'ds-iconbtn ds-iconbtn-' + size, type: 'button', 'aria-label': ariaLabel, title: ariaLabel, onClick });
  btn.innerHTML = name === 'settings' ? SVG_SETTINGS : name === 'newquote' ? SVG_FILE_PLUS : (size === 'sm' ? SVG_X_SM : SVG_X_MD);
  return btn;
}

function switchEl(checked, onChange) {
  const input = h('input', { type: 'checkbox', checked, onChange });
  return h('label', { class: 'ds-switch' }, input, h('span', { class: 'track' }));
}

function labeledInput(labelText, opts) {
  const input = h('input', {
    type: opts.type || 'text', placeholder: opts.placeholder || '', value: opts.value,
    onChange: opts.onChange, dataK: opts.dataK,
  });
  return h('div', { class: 'ds-input' }, h('label', null, labelText), input);
}

function labeledTextarea(labelText, opts) {
  const ta = h('textarea', {
    placeholder: opts.placeholder || '', value: opts.value, dataK: opts.dataK, rows: opts.rows || 3,
    onChange: opts.onChange,
  });
  return h('div', { class: 'ds-input' }, h('label', null, labelText), ta);
}

function dsButton(text, variant, size, fullWidth, onClick) {
  return h('button', {
    class: 'ds-btn ds-btn-' + variant + ' ds-btn-' + size + (fullWidth ? ' ds-btn-full' : ''),
    type: 'button', onClick,
  }, text);
}

function segButton(seg, fontSize) {
  const b = h('button', {
    class: 'sqg-seg' + (seg.active ? ' active' : ''), type: 'button', onClick: seg.onPick,
    style: fontSize ? 'font-size: ' + fontSize + ';' : '',
  }, seg.label);
  return b;
}

function existOptions(cfg) {
  return cfg.products.map((p) => h('option', { value: p.id }, p.name));
}

const IN_BASE = 'border: 1px solid var(--hairline); border-radius: 12px; background: var(--bg); box-sizing: border-box;';

/* ---------------- Render ---------------- */

function render() {
  // preserve focus across the re-render
  const active = document.activeElement;
  const focusKey = active && active.dataset ? active.dataset.k : null;
  let selStart = null, selEnd = null;
  if (focusKey && typeof active.selectionStart === 'number') { selStart = active.selectionStart; selEnd = active.selectionEnd; }

  const { view, quote: q } = state;
  const gate = state.registerGate; // blocking registration screen takes over the whole panel
  document.getElementById('header-title').textContent = gate ? 'Welcome' : (view === 'calc' ? 'New quote' : 'Settings');
  document.getElementById('quote-number').textContent = gate ? '' : q.number;
  const iconSlot = document.getElementById('header-icon-slot');
  iconSlot.textContent = '';
  if (!gate) {
    // "New quote" moved to the bottom icon dock (see buildDockToolbar); the
    // header keeps only the settings / close icon.
    iconSlot.append(iconButton(
      view === 'calc' ? 'settings' : 'x', 'md',
      () => {
        if (view === 'calc') { state.pwPrompt = true; render(); }
        else { state.view = 'calc'; render(); }
      },
      view === 'calc' ? 'Open pricing settings' : 'Close settings'
    ));
  }

  const root = document.getElementById('screen-root');
  root.textContent = '';
  root.append(gate ? renderRegisterGate() : (view === 'calc' ? renderCalc() : renderSettings()));

  if (focusKey) {
    const el = root.querySelector('[data-k="' + focusKey + '"]') || document.querySelector('[data-k="' + focusKey + '"]');
    if (el) {
      el.focus();
      if (selStart != null && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(selStart, selEnd); } catch (e) {}
      }
    }
  }
}

/* Shared view computation used by the calculator main column and the quote dock/sheet */
function computeView() {
  const cfg = state.cfg, q = state.quote;
  const r = cfg.rules;
  const m = model(cfg, q, PARTNER_FEATURE);
  const prorated = !!cfg.allowProration;
  const years = q.years || 1;
  const months = q.months || years * 12;
  const coTermMo = (m.addonDays > 0 ? m.addonDays : 30) / 30.44;
  const termLabel = m.isCoterm
    ? 'co-term · ' + coTermMo.toFixed(1) + ' mo'
    : prorated ? months + ' mo' + (months % 12 !== 0 ? ' · prorated' : '') : years + (years > 1 ? ' years' : ' year');
  const termsSorted = cfg.terms.slice().sort((a, b) => a.years - b.years);
  const partnerActive = m.partnerOn;
  const isRen = m.dealType === 'ren';
  const totalDiscC = m.msrpC - m.netFinalC;
  return { cfg, q, r, m, prorated, years, months, coTermMo, termLabel, termsSorted, partnerActive, isRen, totalDiscC };
}

/* ---- First-run: require first + last name before showing the app ----
   This gate takes over the whole panel (render() shows nothing else while
   state.registerGate is true), so the calculator, settings and dock stay
   hidden until the user registers. */
function renderRegisterGate() {
  const frag = document.createDocumentFragment();
  const main = h('main', { class: 'sqg-main' });

  const errEl = h('p', { class: 'sqg-pw-error' });
  const inStyle = 'height: 42px; padding: 0 12px; font: inherit; font-size: 15px; color: var(--text-primary); ' + IN_BASE;

  const firstIn = h('input', {
    class: 'sqg-in', type: 'text', dataK: 'sqg-reg-first', placeholder: 'First name', 'aria-label': 'First name',
    value: '', autocomplete: 'off', style: inStyle,
    onInput: () => sync(),
    onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); lastIn.focus(); } },
  });
  const lastIn = h('input', {
    class: 'sqg-in', type: 'text', dataK: 'sqg-reg-last', placeholder: 'Last name', 'aria-label': 'Last name',
    value: '', autocomplete: 'off', style: inStyle,
    onInput: () => sync(),
    onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); start(); } },
  });

  // "Start" stays disabled until BOTH fields have non-whitespace text.
  const startBtn = dsButton('Start', 'primary', 'md', true, () => start());
  startBtn.disabled = true;

  const sync = () => {
    const ok = !!firstIn.value.trim() && !!lastIn.value.trim();
    startBtn.disabled = !ok;
    if (ok) errEl.textContent = '';
  };

  const start = () => {
    const firstName = firstIn.value.trim();
    const lastName = lastIn.value.trim();
    if (!firstName || !lastName) {
      errEl.textContent = 'Please enter both your first and last name to continue';
      (firstName ? lastIn : firstIn).focus();
      return;
    }
    const user = { userId: makeUserId(), firstName: firstName, lastName: lastName };
    writeUser(user);
    // Fire-and-forget registration; if offline they still get in and are
    // registered on the first saved quote. The response (if any) may adopt a
    // canonical userId.
    try { window.SQG_SHEETS.registerUser(user); } catch (e) {}
    if (!state.quote.preparedBy) { state.quote.preparedBy = firstName + ' ' + lastName; persist(); }
    state.registerGate = false;
    render();
    flash('Welcome, ' + firstName + ' — your quotes are ready', 'ok');
  };

  main.append(h('section', { class: 'sqg-card' },
    h('div', { style: 'margin-bottom: 8px;' }, h('h2', null, "Let's get you set up")),
    h('p', { class: 'sqg-subhead', style: 'margin: 0 0 14px;' },
      'Enter your first and last name to start. We’ll use it as the default “Prepared by” on your quotes and to identify your entries in the shared database. This is a one-time step.'),
    h('div', { style: 'display: flex; flex-direction: column; gap: 10px;' }, firstIn, lastIn),
    errEl,
    startBtn
  ));

  frag.append(main);
  setTimeout(() => { try { firstIn.focus(); } catch (e) {} sync(); }, 0);
  return frag;
}

/* One-line summaries shown on each collapsed section — a glance tells you what's
   set without expanding it (the iOS grouped-settings "value on the right" idiom). */
function calcSummaries(v) {
  const { q, m, termLabel, partnerActive, isRen } = v;

  const dealBits = [m.isCurrent ? 'Current' : 'Net new'];
  if (m.isCurrent) dealBits.push(m.isCoterm ? 'Add-on' : isRen ? 'Renewal' : m.addonRenew ? 'Add-on + renewal' : '');
  dealBits.push(termLabel);

  const prodCount = m.isRenOnly ? (q.renewLines || []).length : m.lines.length;
  const selling = prodCount + ' product' + (prodCount === 1 ? '' : 's') + ' · ' + fmt(m.msrpC / 100) + '/yr';

  const discBits = [];
  if (partnerActive) discBits.push('Partner ' + m.margin + '%');
  if (+q.extraPct > 0) discBits.push('+' + q.extraPct + '% extra');

  let who = q.customer ? q.customer : 'Not set';
  if (partnerActive && q.partnerCompany) who += ' · via ' + q.partnerCompany;

  return {
    deal: dealBits.filter(Boolean).join(' · '),
    selling: selling,
    discounts: discBits.length ? discBits.join(' · ') : 'None',
    who: who, whoSet: !!q.customer,
  };
}

/* Wrap a section card in a collapsible accordion. The section function still
   builds its full <section class="sqg-card"> (header first); here we lift the
   title into a tappable head with a summary + chevron, and show the rest of the
   body only when expanded. Pure presentation — the section's own controls are
   untouched. */
function accordionSection(key, title, summary, sectionEl, opts) {
  opts = opts || {};
  if (!state.sections) state.sections = defaultSections();
  const isOpen = !!state.sections[key];

  // Drop the section's own header block (first child) — the accordion head
  // carries the title, and dropping the sub-heading is part of condensing.
  if (sectionEl.children.length) sectionEl.removeChild(sectionEl.children[0]);

  const chev = h('span', { class: 'sqg-acc-chev' + (isOpen ? ' open' : '') });
  chev.innerHTML = SVG_CHEVRON_UP;
  const right = h('div', { class: 'sqg-acc-right' });
  if (!isOpen) right.append(h('span', { class: 'sqg-acc-summary' + (opts.attention ? ' attention' : '') }, summary));
  right.append(chev);

  const head = h('button', {
    class: 'sqg-acc-head', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false',
    onClick: () => { state.sections[key] = !state.sections[key]; render(); },
  }, h('span', { class: 'sqg-acc-title' }, title), right);

  const card = h('section', { class: 'sqg-card sqg-acc' + (isOpen ? ' open' : '') }, head);
  if (isOpen) {
    const body = h('div', { class: 'sqg-acc-body' });
    while (sectionEl.firstChild) body.appendChild(sectionEl.firstChild);
    card.append(body);
  }
  return card;
}

function renderCalc() {
  const v = computeView();
  const s = calcSummaries(v);
  const frag = document.createDocumentFragment();
  const main = h('main', { class: 'sqg-main' });
  if (window.SQG_ANALYZE) { const abar = window.SQG_ANALYZE.bar(v); if (abar) main.append(abar); }
  main.append(
    accordionSection('deal', 'What kind of deal?', s.deal, sectionDeal(v)),
    accordionSection('selling', 'What are you selling?', s.selling, sectionSelling(v)),
    accordionSection('discounts', 'Any discounts?', s.discounts, sectionDiscounts(v)),
    accordionSection('who', "Who's it for?", s.who, sectionWho(v), { attention: !s.whoSet })
  );
  frag.append(main, buildDock(v), buildSheet(v));
  if (state.toast) {
    frag.append(h('div', { class: 'sqg-toast sqg-toast-' + (state.toastTone === 'warn' ? 'warn' : 'ok'), role: 'status' }, state.toast));
  }
  if (state.pwPrompt) frag.append(buildPasswordModal());
  if (state.newQuotePrompt) frag.append(buildNewQuoteModal());
  return frag;
}

/* ---- Settings password gate ---- */
function buildPasswordModal() {
  const cfg = state.cfg;
  const close = () => { state.pwPrompt = false; render(); };
  const errEl = h('p', { class: 'sqg-pw-error' });
  const input = h('input', {
    class: 'sqg-in', type: 'password', dataK: 'settings-pw', placeholder: 'Password', 'aria-label': 'Settings password',
    style: 'height: 42px; padding: 0 12px; font: inherit; font-size: 15px; color: var(--text-primary); ' + IN_BASE,
    onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); attempt(); } },
  });
  const attempt = () => {
    const val = input.value.trim();
    if (val && val === String(cfg.settingsPassword || '2026')) {
      state.pwPrompt = false; state.view = 'settings'; render();
    } else {
      errEl.textContent = 'Incorrect password — try again';
      input.select();
      input.focus();
    }
  };
  const card = h('div', {
    class: 'sqg-pw-card', role: 'dialog', 'aria-label': 'Settings password required',
    onClick: (e) => e.stopPropagation(),
  },
    h('h2', null, 'Settings are locked'),
    h('p', null, 'Enter the password to open pricing settings.'),
    input,
    errEl,
    h('div', { class: 'sqg-pw-actions' },
      dsButton('Cancel', 'secondary', 'md', false, close),
      dsButton('Unlock', 'primary', 'md', false, attempt)
    )
  );
  const modal = h('div', { class: 'sqg-pw-modal', onClick: close }, card);
  setTimeout(() => { try { input.focus(); } catch (e) {} }, 0);
  return modal;
}

/* ---- New quote: reset every field to a fresh, empty quote ---- */
function newQuote() {
  state.quote = defaultQuote(); // fresh number + cleared fields, exactly like first launch
  // A fresh quote defaults to net-new; if net-new is turned off, clamp to the
  // first enabled current type so the new quote is always a valid enabled type.
  const c = clampQuoteType(state.cfg, state.quote.customerType, state.quote.dealType);
  if (c.changed) { state.quote.customerType = c.customerType; state.quote.dealType = c.dealType; }
  state.newQuotePrompt = false;
  state.sheet = false;
  state.addMenu = false;
  state.analyze = null;
  state.billingOpen = false;
  state.sections = defaultSections(); // back to the clean all-collapsed overview
  lastAutoLookupCompany = ''; // a fresh quote may auto-look-up the same company again
  persist(); // clears the saved quote in localStorage the same way a manual edit would
  render();
  flash('Started a new quote — all fields cleared', 'ok');
}

function buildNewQuoteModal() {
  const close = () => { state.newQuotePrompt = false; render(); };
  const card = h('div', {
    class: 'sqg-pw-card', role: 'dialog', 'aria-label': 'Start a new quote',
    onClick: (e) => e.stopPropagation(),
  },
    h('h2', null, 'Start a new quote?'),
    h('p', null, 'This clears the current quote and resets every field. It can’t be undone.'),
    h('div', { class: 'sqg-pw-actions' },
      dsButton('Cancel', 'secondary', 'md', false, close),
      dsButton('New quote', 'primary', 'md', false, newQuote)
    )
  );
  return h('div', { class: 'sqg-pw-modal', onClick: close }, card);
}

/* Live update of the dock + sheet while a slider is dragged (no full re-render) */
function rerenderAside() {
  const v = computeView();
  const oldDock = document.getElementById('sqg-dock');
  if (oldDock) oldDock.replaceWith(buildDock(v));
  const oldSheet = document.getElementById('sqg-sheet-wrap');
  if (oldSheet) oldSheet.replaceWith(buildSheet(v));
}

/* ---- Section: What kind of deal? ---- */
function sectionDeal(v) {
  const { cfg, q, m, prorated, years, months, coTermMo, termsSorted, isRen } = v;
  const col = h('div', { class: 'sqg-col' });

  // Which quote types the admin has enabled (see Settings → Quote types). Only
  // enabled options are rendered — disabled ones are hidden, not grayed out.
  const enabled = normalizeEnabledTypes(cfg);
  const curKeys = enabledCurrentKeys(cfg); // enabled current types, in addon>ren>addonren order

  // Customer type — shown only when BOTH net-new and at least one current type
  // are offered. If only net-new is enabled, the choice is implicit (net-new) and
  // the whole picker is hidden.
  if (enabled.new && curKeys.length >= 1) {
    // Picking "Current" lands on an enabled deal type — the one already set if it
    // is enabled, otherwise the first enabled current type.
    const curDeal = curKeys.indexOf(q.dealType) > -1 ? q.dealType : curKeys[0];
    const custSegs = [
      { label: 'Net new customer', active: !m.isCurrent, onPick: () => setQ({ customerType: 'new' }) },
      { label: 'Current customer', active: m.isCurrent, onPick: () => setQ({ customerType: 'current', dealType: curDeal }) },
    ];
    col.append(h('div', { class: 'sqg-field' },
      h('span', { class: 'sqg-field-label' }, 'Customer type'),
      h('div', { class: 'sqg-seg-wrap' }, custSegs.map((s) => segButton(s)))
    ));
  }

  // Deal type — shown only for current customers AND only when more than one
  // current type is enabled (a single enabled current type is implied, so its
  // sub-picker is hidden). Only enabled deal-type options are rendered.
  if (m.isCurrent && curKeys.length >= 2) {
    const dealDefs = [
      { key: 'addon', label: 'Add-on', active: m.isCoterm },
      { key: 'ren', label: 'Renewal', active: isRen },
      { key: 'addonren', label: 'Add-on + renewal', active: m.addonRenew },
    ].filter((d) => enabled[d.key]);
    const dealSegs = dealDefs.map((d) => ({
      label: d.label, active: d.active, onPick: () => setQ({ customerType: 'current', dealType: d.key }),
    }));
    col.append(h('div', { class: 'sqg-field' },
      h('span', { class: 'sqg-field-label' }, 'Deal type'),
      h('div', { class: 'sqg-seg-wrap' }, dealSegs.map((s) => segButton(s, '12px')))
    ));
  }

  // Co-term date
  if (m.needsDate) {
    col.append(h('div', { class: 'sqg-field' },
      h('span', { class: 'sqg-field-label' }, "Customer's renewal date"),
      h('div', { style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap;' },
        h('input', {
          class: 'sqg-in', type: 'date', value: q.coTermDate, dataK: 'coterm',
          onChange: (e) => setQ({ coTermDate: e.target.value }),
          style: 'height: 40px; padding: 0 12px; font: inherit; font-size: 14px; color: var(--text-primary); ' + IN_BASE,
        }),
        h('span', {
          style: 'display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; background: var(--surface-accent-soft); color: var(--text-accent); font-size: 12px; font-weight: 600;',
        }, m.addonValid ? coTermMo.toFixed(1) + ' months · ' + Math.round(m.stubYears * 100) + '% of annual' : 'Pick a future date')
      )
    ));
  }

  // Term picker
  if (!m.isCoterm) {
    const inner = h('div', { class: 'sqg-field' },
      h('span', { class: 'sqg-field-label' }, m.addonRenew ? 'Renewal term' : 'Term'));
    if (!prorated) {
      const termSegs = termsSorted.map((t) => ({
        label: t.years + (t.years > 1 ? ' years' : ' year') + (t.pct ? ' · −' + t.pct + '%' : ''),
        active: years === t.years,
        onPick: () => setQ({ years: t.years, months: t.years * 12 }),
      }));
      inner.append(h('div', { class: 'sqg-seg-wrap' }, termSegs.map((s) => segButton(s))));
    } else {
      const label = h('span', { id: 'months-label', style: "font-family: var(--font-mono); font-weight: 400; font-size: 12px; color: var(--text-accent);" }, months + ' months');
      const slider = h('input', {
        type: 'range', min: 6, max: 60, step: 1, value: months,
        style: 'width: 100%; margin: 8px 0 2px;',
        onInput: (e) => {
          const val = parseInt(e.target.value, 10) || 12;
          state.quote.months = val;
          label.textContent = val + ' months';
          rerenderAside();
        },
        onChange: (e) => setQ({ months: parseInt(e.target.value, 10) || 12 }),
      });
      inner.append(h('div', { class: 'sqg-field' },
        h('span', { style: 'font-size: 13px; font-weight: 600;' }, 'Contract length ', label),
        slider
      ));
    }
    col.append(inner);
  }

  // Term hint
  const termHint = m.isCoterm
    ? (m.addonValid
      ? 'New products are prorated to the existing renewal date, then renew together with the current agreement'
      : 'Enter the customer’s current renewal date — pricing is prorated to it (1-month minimum)')
    : m.addonRenew
      ? 'New products are prorated to the renewal date, then everything renews together for the term above — new products from the rate card, current products at today’s price'
      : isRen
        ? 'Enter the products and current pricing below — add a yearly increase if needed'
        : m.termPct > 0 ? Math.floor(m.effYears) + '-year term applies a ' + m.termPct + '% discount' : 'Billed once per year · annual price × term = total contract value';
  col.append(h('p', { class: 'sqg-hint' }, termHint));

  // Current products — renewing (add-on + renewal)
  if (m.addonRenew) {
    const wrap = h('div', { style: 'display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--border-subtle); padding-top: 14px;' },
      h('div', { style: 'padding-bottom: 4px;' },
        h('span', { style: 'font-size: 13px; font-weight: 600;' }, 'Current products — renewing'),
        h('p', { class: 'sqg-subhead' },
          'Carried at the price the customer pays today · volume pricing and discounts apply only to new products')
      )
    );
    for (const ex of (q.existing || [])) {
      wrap.append(h('div', { class: 'sqg-stack-row' },
        h('div', { class: 'sqg-stack-head' },
          h('select', {
            class: 'sqg-sel', value: ex.productId, dataK: 'ex-prod-' + ex.id,
            onChange: (e) => setQ({ existing: q.existing.map((x) => x.id === ex.id ? Object.assign({}, x, { productId: e.target.value }) : x) }),
            style: 'height: 38px; padding: 0 10px; font: inherit; font-size: 13.5px; color: var(--text-primary); flex: 1; min-width: 0; ' + IN_BASE,
          }, existOptions(cfg)),
          iconButton('x', 'sm', () => setQ({ existing: q.existing.filter((x) => x.id !== ex.id) }), 'Remove current product')
        ),
        h('div', { class: 'sqg-money', style: 'max-width: 210px;' },
          h('span', { class: 'sqg-prefix' }, '$'),
          h('input', {
            class: 'sqg-in', type: 'number', min: 0, step: 100, value: ex.price, dataK: 'ex-price-' + ex.id, 'aria-label': 'Current amount per year',
            onChange: (e) => setQ({ existing: q.existing.map((x) => x.id === ex.id ? Object.assign({}, x, { price: Math.max(0, parseFloat(e.target.value) || 0) }) : x) }),
            style: 'height: 38px; padding: 0 10px; font-family: var(--font-mono); font-size: 13px; color: var(--text-primary); text-align: right; ' + IN_BASE,
          }),
          h('span', { class: 'sqg-suffix' }, '/yr')
        )
      ));
    }
    wrap.append(h('button', {
      class: 'sqg-dashed-btn', type: 'button', style: 'align-self: flex-start; margin-top: 8px;',
      onClick: () => setQ({ existing: (q.existing || []).concat([{ id: uid(), productId: (cfg.products[0] || {}).id, price: 0 }]) }),
    }, '+ Add current product'));
    col.append(wrap);
  }

  return h('section', { class: 'sqg-card' },
    h('div', { style: 'margin-bottom: 14px;' }, h('h2', null, 'What kind of deal?')),
    col);
}

/* ---- Section: What are you selling? ---- */
function sectionSelling(v) {
  const { cfg, q, r, m } = v;
  const epTiersSorted = sortTiers(cfg.epTiers);
  const userTiersSorted = sortTiers(cfg.userTiers);

  const section = h('section', { class: 'sqg-card' },
    h('div', { style: 'margin-bottom: 6px;' },
      h('h2', null, 'What are you selling?'),
      h('p', { class: 'sqg-subhead' },
        m.isRenOnly
          ? 'Enter what the customer pays today — the increase and any discounts are applied for the renewal'
          : 'Volume pricing applies automatically as quantities grow')
    ));

  if (!m.isRenOnly) {
    // New-product line items
    const list = h('div', { style: 'display: flex; flex-direction: column;' });
    for (const { ln, c } of m.lines) {
      const noun = c.isUser ? 'user' : 'endpoint';
      const topRate = c.isUser
        ? (userTiersSorted[0] ? userTiersSorted[0].rate * 12 : 0)
        : (epTiersSorted[0] ? Math.max(+(epTiersSorted[0].rate * (c.prod.factor || 1)).toFixed(4), 0.05) : 0);
      const listTop = topRate * c.units;
      const volPct = listTop > 0 ? Math.max(0, (listTop - c.baseARR) / listTop * 100) : 0;
      const bits = [fmtU(c.units > 0 ? c.msrp / c.units / 12 : 0) + '/' + noun + '/mo'];
      if (volPct >= 0.05) bits.push(volPct.toFixed(0) + '% volume discount');
      if (!c.isUser && c.fee > 0) bits.push('incl. ' + fmt(c.fee) + ' platform fee');
      if (c.waived && !c.isUser) bits.push('platform fee waived');
      if (c.minApplied) bits.push(fmt(c.prod.minTotal) + ' yearly minimum');
      if (c.support > 0) bits.push('support +' + fmt(c.support));
      const setQty = (val) => {
        let n = int(val);
        if (c.isUser) n = Math.max(r.minUsers, n || r.minUsers);
        setQ({ lines: q.lines.map((l) => l.id === ln.id ? Object.assign({}, l, { qty: n || 1 }) : l) });
      };
      list.append(h('div', { class: 'sqg-line' },
        h('div', { class: 'sqg-line-top' },
          h('span', { class: 'sqg-avatar' }, initialsOf(c.prod.name)),
          h('div', { class: 'sqg-line-names' },
            h('span', { class: 'sqg-line-name' }, c.prod.name),
            h('span', { class: 'sqg-line-meta' }, bits.join(' · '))
          ),
          h('div', { class: 'sqg-line-price' },
            h('span', { class: 'sqg-line-amt' }, fmt(c.msrp)),
            h('span', { class: 'sqg-line-per' }, 'per year')
          )
        ),
        h('div', { class: 'sqg-line-controls' },
          h('div', { class: 'sqg-stepper' },
            h('button', { class: 'sqg-qty-btn', type: 'button', 'aria-label': 'Decrease quantity', onClick: () => setQty(c.units - bumpStep(c.isUser, c.units)) }, '−'),
            h('input', {
              class: 'sqg-in', type: 'text', inputmode: 'numeric', value: ln.qty, dataK: 'qty-' + ln.id, 'aria-label': 'Quantity',
              onChange: (e) => setQty(e.target.value),
              style: 'height: 34px; width: 72px; padding: 0 6px; border-radius: 9px; font-family: var(--font-mono); font-size: 13px; color: var(--text-primary); text-align: center; ' + IN_BASE,
            }),
            h('button', { class: 'sqg-qty-btn', type: 'button', 'aria-label': 'Increase quantity', style: 'font-size: 15px;', onClick: () => setQty(c.units + bumpStep(c.isUser, c.units)) }, '+'),
            h('span', { class: 'sqg-stepper-unit' }, c.isUser ? 'users' : 'endpoints')
          ),
          q.lines.length > 1
            ? iconButton('x', 'sm', () => setQ({ lines: q.lines.filter((l) => l.id !== ln.id) }), 'Remove product')
            : h('span')
        )
      ));
    }
    section.append(list);

    // Empty state — no products chosen yet (the quote starts empty by design).
    if (m.lines.length === 0) {
      section.append(h('p', { class: 'sqg-empty-hint' }, 'No products yet — add one below to start your quote.'));
    }

    // + Add product menu
    const inQuote = new Set(q.lines.map((l) => l.productId));
    const addPills = cfg.products.filter((p) => !inQuote.has(p.id));
    if (addPills.length > 0) {
      const holder = h('div', { style: 'position: relative; padding-top: 14px; align-self: flex-start;' },
        h('button', { class: 'sqg-dashed-btn', type: 'button', style: 'padding: 7px 16px;', onClick: () => { state.addMenu = !state.addMenu; render(); } }, '+ Add product'));
      if (state.addMenu) {
        holder.append(
          h('div', { style: 'position: fixed; inset: 0; z-index: 30;', onClick: () => { state.addMenu = false; render(); } }),
          h('div', { class: 'sqg-menu' },
            addPills.map((p) => h('button', {
              class: 'sqg-menu-item', type: 'button',
              onClick: () => {
                state.addMenu = false;
                setQ({ lines: q.lines.concat([{ id: uid(), productId: p.id, qty: p.unit === 'user' ? r.minUsers : 1000 }]) });
              },
            },
              h('span', null, p.name),
              h('span', { style: 'color: var(--text-tertiary); font-size: 12px;' }, p.unit === 'user' ? 'per user' : 'per endpoint')
            ))
          )
        );
      }
      section.append(holder);
    }

    // Bundle banner
    if (m.bundleOn) {
      section.append(h('div', { class: 'sqg-banner' },
        h('span', { style: 'font-weight: 700;' }, '✓'),
        'RCT bundle applied — ' + r.bundlePct + '% off endpoint products'));
    }

    // Premium support toggle
    if (m.lines.some((x) => !x.c.isUser)) {
      section.append(h('div', { class: 'sqg-toggle-row', style: 'margin-top: 12px;' },
        h('div', { class: 'sqg-toggle-titles' },
          h('span', { class: 'sqg-toggle-title' }, 'Premium support'),
          h('span', { class: 'sqg-toggle-desc' }, 'Adds ' + r.suppPct + '% per endpoint product, min ' + fmt(r.suppMin) + '/yr')
        ),
        switchEl(!!q.supportAll, (e) => setQ({ supportAll: e.target.checked }))
      ));
    }
  } else {
    // Renewal-only rows
    if ((q.renewLines || []).length === 0) {
      section.append(h('p', { class: 'sqg-empty-hint' }, 'No renewing products yet — add one below.'));
    }
    for (const rl of (q.renewLines || [])) {
      const p = cfg.products.find((x) => x.id === rl.productId) || cfg.products[0] || { name: '?', unit: 'endpoint' };
      section.append(h('div', { class: 'sqg-stack-row' },
        h('div', { class: 'sqg-stack-head' },
          h('span', { class: 'sqg-avatar', style: 'width: 34px; height: 34px;' }, initialsOf(p.name)),
          h('select', {
            class: 'sqg-sel', value: rl.productId, dataK: 'rl-prod-' + rl.id,
            onChange: (e) => setQ({ renewLines: q.renewLines.map((x) => x.id === rl.id ? Object.assign({}, x, { productId: e.target.value }) : x) }),
            style: 'height: 38px; padding: 0 10px; font: inherit; font-size: 13.5px; font-weight: 500; color: var(--text-primary); flex: 1; min-width: 0; ' + IN_BASE,
          }, existOptions(cfg)),
          (q.renewLines || []).length > 1
            ? iconButton('x', 'sm', () => setQ({ renewLines: q.renewLines.filter((x) => x.id !== rl.id) }), 'Remove product')
            : null
        ),
        h('div', { class: 'sqg-stack-fields' },
          h('div', { class: 'sqg-cell' },
            h('span', { class: 'sqg-mini-label' }, p.unit === 'user' ? 'Users' : 'Endpoints'),
            h('input', {
              class: 'sqg-in', type: 'text', inputmode: 'numeric', value: rl.qty, dataK: 'rl-qty-' + rl.id, 'aria-label': 'Quantity',
              onChange: (e) => setQ({ renewLines: q.renewLines.map((x) => x.id === rl.id ? Object.assign({}, x, { qty: int(e.target.value) }) : x) }),
              style: 'height: 38px; padding: 0 8px; font-family: var(--font-mono); font-size: 13px; color: var(--text-primary); text-align: right; width: 100%; ' + IN_BASE,
            })
          ),
          h('div', { class: 'sqg-cell' },
            h('span', { class: 'sqg-mini-label' }, 'Amount / yr'),
            h('div', { class: 'sqg-money' },
              h('span', { class: 'sqg-prefix' }, '$'),
              h('input', {
                class: 'sqg-in', type: 'number', min: 0, step: 100, value: rl.price, dataK: 'rl-price-' + rl.id, 'aria-label': 'Current amount per year',
                onChange: (e) => setQ({ renewLines: q.renewLines.map((x) => x.id === rl.id ? Object.assign({}, x, { price: Math.max(0, parseFloat(e.target.value) || 0) }) : x) }),
                style: 'height: 38px; padding: 0 10px; font-family: var(--font-mono); font-size: 13px; color: var(--text-primary); width: 100%; text-align: right; ' + IN_BASE,
              })
            )
          )
        )
      ));
    }
    section.append(h('div', { style: 'padding-top: 14px;' },
      h('button', {
        class: 'sqg-dashed-btn', type: 'button',
        onClick: () => setQ({ renewLines: (q.renewLines || []).concat([{ id: uid(), productId: (cfg.products[0] || {}).id, qty: 1000, price: 0 }]) }),
      }, '+ Add product')));

    // Annual cost increase (uplift)
    const upliftDesc = h('span', { id: 'uplift-desc', class: 'sqg-toggle-desc' },
      q.uplift ? '+' + (+q.upliftPct || 0) + '% each year of the term, compounding' : 'Include a yearly price increase in the renewal');
    const upliftRight = h('div', { style: 'display: flex; align-items: center; gap: 14px; flex: 1 1 100%; justify-content: flex-end;' });
    if (q.uplift) {
      const pctLabel = h('span', { id: 'uplift-label', style: 'font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text-accent);' },
        (q.uplift ? (+q.upliftPct || 0) : 0) + '%');
      upliftRight.append(h('div', { style: 'display: flex; flex-direction: column; gap: 2px; flex: 1; max-width: 220px;' },
        h('input', {
          type: 'range', min: 0, max: 10, step: 0.5, value: q.upliftPct, style: 'width: 100%;',
          onInput: (e) => {
            const val = Math.min(10, Math.max(0, parseFloat(e.target.value) || 0));
            state.quote.upliftPct = val;
            pctLabel.textContent = val + '%';
            upliftDesc.textContent = '+' + val + '% each year of the term, compounding';
            rerenderAside();
          },
          onChange: (e) => setQ({ upliftPct: Math.min(10, Math.max(0, parseFloat(e.target.value) || 0)) }),
        }),
        h('div', { style: 'display: flex; justify-content: space-between; font-size: 11px; color: var(--text-tertiary);' },
          h('span', null, '0%'), pctLabel, h('span', null, '10%'))
      ));
    }
    const upliftSwitch = switchEl(!!q.uplift, (e) => setQ({ uplift: e.target.checked }));
    section.append(h('div', { class: 'sqg-toggle-row', style: 'margin-top: 14px;' },
      h('div', { class: 'sqg-toggle-titles' },
        h('span', { class: 'sqg-toggle-title' }, 'Annual cost increase'),
        upliftDesc
      ),
      upliftSwitch,
      q.uplift ? upliftRight : null
    ));
  }

  return section;
}

/* ---- Section: Any discounts? ---- */
function sectionDiscounts(v) {
  const { q, r, m, partnerActive, isRen } = v;
  const section = h('section', { class: 'sqg-card' },
    h('div', { style: 'margin-bottom: 6px;' }, h('h2', null, 'Any discounts?')));

  if (PARTNER_FEATURE) {
    const partnerRow = h('div', { style: 'display: flex; flex-direction: column; gap: 10px; padding: 12px 0; border-bottom: 1px solid var(--border-subtle);' },
      h('div', { style: 'display: flex; align-items: center; justify-content: space-between; gap: 12px;' },
        h('div', { style: 'display: flex; flex-direction: column; gap: 1px; min-width: 0;' },
          h('span', { class: 'sqg-toggle-title' }, 'Partner deal'),
          h('span', { class: 'sqg-toggle-desc' },
            partnerActive
              ? m.margin + '% ' + (isRen ? 'renewal' : 'net-new') + ' margin off list applies to this quote'
              : 'Selling through a reseller? Flip on to set their margin')
        ),
        switchEl(!!q.partner, (e) => setQ({ partner: e.target.checked }))
      ));
    if (q.partner) {
      partnerRow.append(h('div', { style: 'display: flex; align-items: center; justify-content: space-between; gap: 10px;' },
        h('span', { class: 'sqg-toggle-desc' }, isRen ? 'Renewal margin' : 'Net-new margin'),
        h('div', { style: 'display: flex; align-items: center; gap: 7px;' },
          h('input', {
            class: 'sqg-in', type: 'number', min: 0, max: 100, step: 1,
            value: isRen ? (q.marginRenPct ?? 15) : (q.marginNewPct ?? 20), dataK: 'margin',
            onChange: (e) => {
              const val = Math.min(100, Math.max(0, parseFloat(e.target.value) || 0));
              setQ(isRen ? { marginRenPct: val } : { marginNewPct: val });
            },
            style: 'height: 34px; width: 72px; padding: 0 8px; border-radius: 9px; font-family: var(--font-mono); font-size: 13px; color: var(--text-primary); text-align: right; ' + IN_BASE,
          }),
          h('span', { style: 'color: var(--text-tertiary); font-size: 13px;' }, '%')
        )
      ));
    }
    section.append(partnerRow);
  }

  section.append(h('div', { style: 'display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0 2px;' },
    h('div', { style: 'display: flex; flex-direction: column; gap: 1px; min-width: 0;' },
      h('span', { class: 'sqg-toggle-title' }, 'Extra discount'),
      h('span', { class: 'sqg-toggle-desc' }, 'One-off sweetener · stacks after partner margin · up to ' + r.maxExtra + '%')
    ),
    h('div', { style: 'display: flex; align-items: center; gap: 7px; flex-shrink: 0;' },
      h('input', {
        class: 'sqg-in', type: 'number', min: 0, max: r.maxExtra, step: 0.5, value: q.extraPct, dataK: 'extra',
        onChange: (e) => setQ({ extraPct: Math.min(r.maxExtra, Math.max(0, parseFloat(e.target.value) || 0)) }),
        style: 'height: 34px; width: 72px; padding: 0 8px; border-radius: 9px; font-family: var(--font-mono); font-size: 13px; color: var(--text-primary); text-align: right; ' + IN_BASE,
      }),
      h('span', { style: 'color: var(--text-tertiary); font-size: 13px;' }, '%')
    )
  ));

  return section;
}

/* ---- Section: Who's it for? ---- */
function sectionWho(v) {
  const { q, partnerActive } = v;
  const head = h('div', { style: 'margin-bottom: 14px;' }, h('h2', null, "Who's it for?"));
  if (partnerActive) {
    head.append(h('p', { class: 'sqg-subhead' },
      'Partner deal — the partner is billed, the customer receives the licenses'));
  }
  const section = h('section', { class: 'sqg-card' }, head);

  const custFields = [
    labeledInput('Customer / company', { placeholder: 'Acme Corp', value: q.customer, dataK: 'customer', onChange: (e) => setQ({ customer: e.target.value }) }),
    // Contact email + the new Contact name (Change 2b) share one grid cell so the
    // name field sits DIRECTLY below the email field at every panel width. The
    // contact name mirrors into the Billing contact field until that field is
    // edited by hand (Change 2c).
    h('div', { style: 'display: flex; flex-direction: column; gap: 12px;' },
      labeledInput('Contact email', { type: 'email', placeholder: 'name@acme.com', value: q.email, dataK: 'email', onChange: (e) => setQ({ email: e.target.value }) }),
      labeledInput('Contact name', { placeholder: 'Jane Doe', value: q.contactName, dataK: 'contactName', onChange: (e) => setQ({ contactName: e.target.value }) })
    ),
  ];
  const metaFields = [
    labeledInput('Prepared by', { placeholder: 'Your name', value: q.preparedBy, dataK: 'preparedBy', onChange: (e) => setQ({ preparedBy: e.target.value }) }),
    labeledInput('Quote expires', { type: 'date', value: q.expires, dataK: 'expires', onChange: (e) => setQ({ expires: e.target.value }) }),
  ];

  if (partnerActive) {
    section.append(h('div', { style: 'display: flex; flex-direction: column; gap: 16px;' },
      h('div', { style: 'display: flex; flex-direction: column; gap: 10px;' },
        h('span', { style: 'font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-accent);' }, 'Bill to · Partner'),
        h('div', { class: 'sqg-form-grid' },
          labeledInput('Partner company', { placeholder: 'Reseller Inc.', value: q.partnerCompany, dataK: 'partnerCompany', onChange: (e) => setQ({ partnerCompany: e.target.value }) }),
          labeledInput('Partner email', { type: 'email', placeholder: 'orders@reseller.com', value: q.partnerEmail, dataK: 'partnerEmail', onChange: (e) => setQ({ partnerEmail: e.target.value }) })
        )
      ),
      h('div', { style: 'display: flex; flex-direction: column; gap: 10px;' },
        h('span', { style: 'font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-tertiary);' }, 'Ship to · Customer'),
        h('div', { class: 'sqg-form-grid' }, custFields)
      ),
      h('div', { class: 'sqg-form-grid', style: 'border-top: 1px solid var(--border-subtle); padding-top: 16px;' }, metaFields)
    ));
  } else {
    section.append(h('div', { class: 'sqg-form-grid' }, custFields, metaFields));
  }
  section.append(sectionBillingDetails(q));
  return section;
}

/* ---- Billing-address lookup (Change 3 — now LIVE) ----
   "Look up address" uses the company name to look up the company's mailing /
   headquarters address online and fills it into the Bill To address box, below
   the company-name first line (Change 2c). It works out of the box, two tiers:

     1. The tool's own Apps Script backend (the same web app that powers page
        analysis and quote saves): action "addressLookup" returns an AI-curated
        corporate mailing address. See APPS-SCRIPT-UPGRADE.txt for the paste-in
        server handler; an older deployment that doesn't know the action simply
        rejects and tier 2 takes over — nothing breaks.
     2. Keyless fallback: OpenStreetMap's public Nominatim geocoder (no API key,
        no signup), searched as "<company> headquarters" then plain "<company>".

   Either way the result is best-guess: it fills below the company-name first
   line, shows "Auto-filled — please verify", and NEVER overwrites an address
   the user typed. To swap in a different provider later, replace this function
   (same shape: async (companyName) → multi-line address string, ''/null when
   nothing is found). */
async function ADDRESS_LOOKUP_SERVICE(companyName) {
  try {
    if (window.SQG_SHEETS && typeof window.SQG_SHEETS.lookupAddress === 'function') {
      const addr = await window.SQG_SHEETS.lookupAddress(companyName);
      if (addr) return addr;
    }
  } catch (e) { /* backend unavailable or pre-upgrade deployment — use tier 2 */ }
  return lookupAddressViaOpenStreetMap(companyName);
}

/* The lookup input is ALWAYS a COMPANY name — "Amazon" means the company
   Amazon.com, Inc., never the river; "Apple" means Apple Inc., never the
   fruit. Tier 2's geocoder results are therefore filtered before use: a
   usable hit must be street-addressable (carry a house number or road), and
   natural features / waterways / bare place names are rejected outright, so a
   non-company match can never land in the Bill To address. Office-type
   results and ones labeled "headquarters" outrank generic matches. Pure
   (result list in → best candidate or null out); exposed on SQG_APP for the
   tests harness. */
function pickOsmCandidate(list) {
  const REJECT_CLASS = { natural: 1, waterway: 1, boundary: 1, place: 1, landuse: 1 };
  let best = null, bestScore = 0;
  (Array.isArray(list) ? list : []).forEach((hit) => {
    if (!hit || typeof hit !== 'object') return;
    const cls = String(hit.class || hit.category || '').toLowerCase();
    if (REJECT_CLASS[cls]) return;
    const a = hit.address || {};
    if (!a.house_number && !a.road) return; // not a street-addressable location
    let score = 1 + (a.house_number ? 2 : 0) + (a.road ? 1 : 0);
    const typ = String(hit.type || '').toLowerCase();
    if (cls === 'office' || typ === 'company' || typ === 'office' || /corporate|headquarters/.test(typ)) score += 3;
    if (/headquarters|\bhq\b/i.test(String(hit.display_name || ''))) score += 2;
    if (score > bestScore) { bestScore = score; best = hit; }
  });
  return best;
}

/* Tier 2 — OpenStreetMap Nominatim (public, keyless; runs per click).
   Searches "<company> headquarters" first, then the plain company name, and
   picks the best COMPANY-plausible candidate via pickOsmCandidate above.
   Returns 'Street\nCity, State ZIP\nCountry' built from the winner's
   structured address, or '' when nothing plausible is found (an honest
   "No address found" beats filling in the wrong place). */
async function lookupAddressViaOpenStreetMap(companyName) {
  const queryOnce = async (q) => {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&accept-language=en&q=' + encodeURIComponent(q);
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  };
  let hit = pickOsmCandidate(await queryOnce(companyName + ' headquarters'));
  if (!hit) hit = pickOsmCandidate(await queryOnce(companyName));
  if (!hit) return '';
  const a = hit.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const city = a.city || a.town || a.village || a.municipality || a.county || '';
  const line2 = [city, [a.state, a.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const lines = [street, line2, a.country].map((s) => String(s || '').trim()).filter(Boolean);
  if (lines.length) return lines.join('\n');
  // No structured parts — fall back to the display name minus the leading POI name.
  const disp = String(hit.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
  return disp.length > 1 ? disp.slice(1).join(', ') : '';
}

function lookupBillingAddress(opts) {
  // quiet = an AUTOMATIC run (after a voice session, via SQG_APP.autoLookupAddress):
  // failures stay silent — the user didn't click anything, so don't nag them.
  const quiet = !!(opts && opts.auto);
  const q = state.quote;
  const company = String(q.customer || '').trim();
  if (!company) {
    if (quiet) return;
    state.sections.who = true;
    flash('Add the customer / company name first — the lookup uses it', 'warn');
    return;
  }
  const auto = normalizeBillingAuto(q);
  // Never overwrite an address the user typed themselves (Change 3 guard):
  // an address body below the company line that is NOT auto-managed is theirs.
  const curBody = String(q.billToAddress || '').split('\n').slice(1).join('\n').trim();
  if (curBody && !auto.billTo) {
    if (!quiet) flash('You entered this address yourself — it won’t be overwritten', 'warn');
    return;
  }
  flash('Looking up the address for ' + company + '…', 'ok');
  Promise.resolve()
    .then(() => ADDRESS_LOOKUP_SERVICE(company))
    .then((address) => {
      address = (address == null ? '' : String(address)).trim();
      if (!address) { if (!quiet) flash('No address found for ' + company + ' — enter it manually', 'warn'); return; }
      // Re-check before writing: the user may have typed meanwhile — theirs wins.
      const now = state.quote;
      const nowAuto = normalizeBillingAuto(now);
      const nowBody = String(now.billToAddress || '').split('\n').slice(1).join('\n').trim();
      if (nowBody && !nowAuto.billTo) return;
      setQ({
        billToAddress: company + '\n' + address,
        billingAuto: { billTo: true, contact: nowAuto.contact, lookedUp: true },
      });
      state.billingOpen = true;
      flash('Address filled from lookup — please verify it before sending', 'ok');
    })
    .catch(() => { if (!quiet) flash('Address lookup failed — try again or enter it manually', 'warn'); });
}

/* v3.7 — automatic HQ-address fill after a voice session (called by voice.js's
   AI reasoning pass via SQG_APP.autoLookupAddress). Runs the SAME guarded
   lookup as the button, but only when it can act safely on its own: there must
   be a company, the Bill To box must still be auto-managed (or empty) with no
   address body yet, and each company is only attempted once — so it can never
   overwrite anything or spam lookups. */
let lastAutoLookupCompany = '';
function maybeAutoLookupBillingAddress() {
  const q = state.quote;
  const company = String(q.customer || '').trim();
  if (!company) return;
  const auto = normalizeBillingAuto(q);
  if (!auto.billTo && String(q.billToAddress || '').trim()) return; // manual Bill To — theirs
  const body = String(q.billToAddress || '').split('\n').slice(1).join('\n').trim();
  if (body) return; // an address is already there (looked up or typed)
  const key = company.toLowerCase();
  if (key === lastAutoLookupCompany) return; // one automatic attempt per company
  lastAutoLookupCompany = key;
  lookupBillingAddress({ auto: true });
}

/* ---- Collapsible: Billing details (for PDF) ---- */
function sectionBillingDetails(q) {
  const open = state.billingOpen;
  const toggle = () => { state.billingOpen = !state.billingOpen; render(); };
  const chev = h('span', { class: 'sqg-collapse-chev' + (open ? ' open' : '') });
  chev.innerHTML = SVG_CHEVRON_UP;
  const header = h('button', {
    class: 'sqg-collapse-head', type: 'button', 'aria-expanded': open ? 'true' : 'false', onClick: toggle,
  },
    h('span', { class: 'sqg-toggle-titles' },
      h('span', { class: 'sqg-toggle-title' }, 'Billing details (for PDF)'),
      h('span', { class: 'sqg-toggle-desc' }, 'Bill-to / ship-to addresses, contact, and payment terms shown on the quote PDF')),
    chev
  );
  const wrap = h('div', { class: 'sqg-collapse' }, header);
  if (open) {
    // Bill To cell: the address box plus the "Look up address" button (Change 3)
    // and, when the address came from lookup, the "Auto-filled — please verify"
    // note. Grouped in one cell so the button sits right by its box.
    const billAuto = normalizeBillingAuto(q);
    const billToRow = h('div', { style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap;' },
      dsButton('Look up address', 'secondary', 'sm', false, lookupBillingAddress));
    if (billAuto.lookedUp && String(q.billToAddress || '').trim()) {
      billToRow.append(h('span', { class: 'sqg-hint', style: 'color: var(--text-accent); font-weight: 600;' }, 'Auto-filled — please verify'));
    }
    const billToCell = h('div', { style: 'display: flex; flex-direction: column; gap: 8px;' },
      labeledTextarea('Bill To address', {
        placeholder: 'Street address\nCity, State ZIP\nCountry', value: q.billToAddress, dataK: 'billToAddress',
        onChange: (e) => setQ({ billToAddress: e.target.value }),
      }),
      billToRow);
    wrap.append(h('div', { class: 'sqg-collapse-body' },
      h('div', { class: 'sqg-form-grid' },
        billToCell,
        labeledTextarea('Ship To address', {
          placeholder: 'Street address\nCity, State ZIP\nCountry', value: q.shipToAddress, dataK: 'shipToAddress',
          onChange: (e) => setQ({ shipToAddress: e.target.value }),
        })
      ),
      h('div', { class: 'sqg-form-grid' },
        labeledInput('Billing contact', { placeholder: 'Name at company', value: q.billingContact, dataK: 'billingContact', onChange: (e) => setQ({ billingContact: e.target.value }) }),
        labeledInput('Payment method', { value: q.paymentMethod, dataK: 'paymentMethod', onChange: (e) => setQ({ paymentMethod: e.target.value }) }),
        labeledInput('Payment terms', { value: q.paymentTerms, dataK: 'paymentTerms', onChange: (e) => setQ({ paymentTerms: e.target.value }) }),
        labeledInput('Currency', { value: q.currency, dataK: 'currency', onChange: (e) => setQ({ currency: e.target.value }) })
      ),
      h('div', { class: 'sqg-toggle-row' },
        h('div', { class: 'sqg-toggle-titles' },
          h('span', { class: 'sqg-toggle-title' }, 'Auto renewal'),
          h('span', { class: 'sqg-toggle-desc' }, 'Printed on the quote PDF as Yes / No')),
        switchEl(!!q.autoRenewal, (e) => setQ({ autoRenewal: e.target.checked }))
      )
    ));
  }
  return wrap;
}

/* ---- Date helpers for the PDF's product-row Start/End Date columns ---- */
function parseDateLocal(s) { return s ? new Date(s + 'T00:00:00') : null; }
function addTermDate(start, years) {
  const end = new Date(start.getTime());
  const whole = Math.floor(years);
  end.setFullYear(end.getFullYear() + whole);
  const frac = years - whole;
  if (frac > 1e-9) end.setDate(end.getDate() + Math.round(frac * 365.25));
  end.setDate(end.getDate() - 1); // inclusive end date (term ends the day before the anniversary)
  return end;
}
function formatMDY(d) {
  if (!d || isNaN(d)) return '';
  return String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
}
function fmtPdf(n) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// The term window shared by every new-product / renewal-only line in a quote.
function computeTermWindow(v) {
  const { m, q } = v;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (m.isCoterm) return { start: today, end: parseDateLocal(q.coTermDate) || today };
  if (m.addonRenew) return { start: today, end: addTermDate(parseDateLocal(q.coTermDate) || today, m.baseYears) };
  return { start: today, end: addTermDate(today, m.baseYears) };
}
// Current products carried forward on an add-on + renewal deal: they resume at the co-term date.
function existingTermWindow(v) {
  const { m, q } = v;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const coterm = parseDateLocal(q.coTermDate) || today;
  return { start: coterm, end: addTermDate(coterm, m.baseYears) };
}

/* ---- Quote data (shared by the quote sheet and the PDF export) ---- */
function buildQuoteData(v) {
  const { cfg, q, r, m, coTermMo, termLabel, partnerActive, isRen, totalDiscC } = v;

  const termWin = computeTermWindow(v);
  const termStartDisp = formatMDY(termWin.start), termEndDisp = formatMDY(termWin.end);
  const existingWin = m.addonRenew ? existingTermWindow(v) : null;
  const existingStartDisp = existingWin ? formatMDY(existingWin.start) : '';
  const existingEndDisp = existingWin ? formatMDY(existingWin.end) : '';

  const items = (m.isRenOnly ? (q.renewLines || []).map((rl) => {
    const p = cfg.products.find((x) => x.id === rl.productId);
    return {
      name: p ? p.name : 'Product',
      qtyDisp: int(rl.qty).toLocaleString('en-US') + ' ' + (p && p.unit === 'user' ? 'users' : 'endpoints') + ' · renews',
      amt: fmt(Math.max(0, +rl.price || 0)),
      start: termStartDisp, end: termEndDisp, qty: int(rl.qty).toLocaleString('en-US'), total: fmtPdf(Math.max(0, +rl.price || 0)),
    };
  }) : m.lines.map(({ c }) => ({
    name: c.prod.name,
    qtyDisp: c.units.toLocaleString('en-US') + ' ' + (c.isUser ? 'users' : 'endpoints') + (c.support > 0 ? ' · support' : '') + (m.addonRenew ? ' · new' : ''),
    amt: fmt(c.msrp),
    start: termStartDisp, end: termEndDisp, qty: c.units.toLocaleString('en-US'), total: fmtPdf(c.msrp),
  }))).concat(m.addonRenew ? (q.existing || []).map((ex) => {
    const p = cfg.products.find((x) => x.id === ex.productId);
    return {
      name: p ? p.name : 'Current product', qtyDisp: 'current · renews at today’s price', amt: fmt(Math.max(0, +ex.price || 0)),
      start: existingStartDisp, end: existingEndDisp, qty: '', total: fmtPdf(Math.max(0, +ex.price || 0)),
    };
  }) : []);

  const totals = [];
  totals.push({ label: m.isRenOnly ? 'Current · annual' : 'List price · annual', amt: fmt(m.msrpC / 100) });
  if (m.isRenOnly && m.upliftY1C > 0) {
    totals.push({ label: 'Annual increase · ' + ((q.uplift ? (+q.upliftPct || 0) : 0) + '%'), amt: '+' + fmt(m.upliftY1C / 100) });
  }
  if (m.bundleAmtC > 0) totals.push({ label: 'RCT bundle · ' + r.bundlePct + '%', amt: '−' + fmt(m.bundleAmtC / 100), green: true });
  if (m.marginAmtC > 0) totals.push({ label: 'Partner margin · ' + m.margin + '%', amt: '−' + fmt(m.marginAmtC / 100), green: true });
  if (m.extraAmtC > 0) totals.push({ label: 'Extra discount · ' + q.extraPct + '%', amt: '−' + fmt(m.extraAmtC / 100), green: true });
  if (m.termAmtC > 0) totals.push({ label: 'Term discount · ' + m.termPct + '%', amt: '−' + fmt(m.termAmtC / 100), green: true });
  totals.push({ divider: true });
  const netRowLabel = m.isRenOnly
    ? (partnerActive ? 'Partner net · annual' : 'Renewal · annual')
    : m.addonRenew ? (partnerActive ? 'New products · partner net' : 'New products · annual') : (partnerActive ? 'Partner net · annual' : 'Your price · annual');
  totals.push({ label: netRowLabel, amt: fmt(m.netFinalC / 100), bold: true });
  if (m.addonRenew) {
    totals.push({ label: 'Prorated to renewal · ' + coTermMo.toFixed(1) + ' mo', amt: fmt(m.stubC / 100) });
  }
  if (m.addonRenew && (q.existing || []).length > 0) {
    totals.push({ label: 'Current products · renew', amt: fmt(m.existingC / 100) });
    totals.push({ divider: true });
    totals.push({ label: 'Renewal · per year', amt: fmt(m.renewalAnnualC / 100), bold: true });
  }

  const hasYears = m.addonRenew || (!m.isCoterm && m.effYears > 1 + 1e-9);
  const schedule = !hasYears ? [] : (() => {
    if (m.isRenOnly) {
      return m.renYears.map((y, i) => ({
        label: 'Year ' + (i + 1) + (y.frac < 1 - 1e-9 ? ' · ' + Math.round(y.frac * 12) + ' mo' : ''),
        amt: fmt(y.netYC / 100),
      }));
    }
    const rows = [];
    if (m.addonRenew) rows.push({ label: 'Now → renewal · ' + coTermMo.toFixed(1) + ' mo', amt: fmt(m.stubC / 100) });
    const annualC = m.addonRenew ? m.renewalAnnualC : m.netFinalC;
    const fullYears = Math.floor(m.baseYears + 1e-9);
    let acc = m.addonRenew ? m.stubC : 0;
    for (let i = 1; i <= fullYears; i++) { rows.push({ label: 'Year ' + i, amt: fmt(annualC / 100) }); acc += annualC; }
    if (!m.isCoterm && m.baseYears - fullYears > 1e-9) {
      const months = state.quote.months || (state.quote.years || 1) * 12;
      const remMo = months - fullYears * 12;
      rows.push({ label: 'Year ' + (fullYears + 1) + ' · ' + remMo + ' mo', amt: fmt((m.tcvC - acc) / 100) });
    }
    return rows;
  })();

  const tcvLabel = partnerActive ? 'Partner price · total' : (m.isCoterm ? 'Total to renewal' : 'Total contract value');
  const tcvSub = (m.isCoterm ? 'Add-on · co-terms ' + (q.coTermDate || '—')
    : m.addonRenew ? 'Add-on + renewal · co-terms ' + (q.coTermDate || '—') + ' · then ' + termLabel
    : (isRen ? 'Renewal' : 'Net new') + ' · ' + termLabel + (m.isRenOnly && m.upliftP > 0 ? ' · +' + m.upliftP + '%/yr' : ''))
    + (partnerActive ? ' · ' + m.margin + '% margin' : (m.isRenOnly ? '' : ' · list price'));

  const savings = (totalDiscC > 0 && m.msrpC > 0)
    ? { amt: fmt(totalDiscC / 100), pct: Math.round(totalDiscC / m.msrpC * 100) }
    : null;
  const partner = partnerActive
    ? { msrpTcv: fmt(m.msrpTcvC / 100), savings: fmt((m.msrpTcvC - m.tcvC) / 100), pays: fmt(m.tcvC / 100) }
    : null;

  const meta = {
    number: q.number, customer: q.customer, email: q.email, preparedBy: q.preparedBy, expires: q.expires,
    partnerActive, partnerCompany: q.partnerCompany, partnerEmail: q.partnerEmail,
    today: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
    billToName: partnerActive ? (q.partnerCompany || '') : (q.customer || ''),
    billToAddress: q.billToAddress || '',
    shipToName: q.customer || '',
    shipToAddress: q.shipToAddress || '',
    billingFrequency: 'Annually',
    autoRenewal: q.autoRenewal ? 'Yes' : 'No',
    expiresDisp: q.expires ? formatMDY(parseDateLocal(q.expires)) : '',
    billingContact: q.billingContact || '',
    paymentMethod: q.paymentMethod || '',
    paymentTerms: q.paymentTerms || '',
    currency: q.currency || '',
  };

  // Final PDF guard (Bugs 2 & 3): scrub leading/trailing UI action words from the
  // name fields ONLY when the quote may have come from page analysis (it carries a
  // sourceUrl) — so a hand-typed "Preview Inc" survives; trim trailing punctuation
  // for ALL quotes (keeping "Corp." and interior commas); and blank any email that
  // isn't a single valid address so malformed values print blank, never as garbage.
  const fromPage = !!(q.sourceUrl && String(q.sourceUrl).trim());
  const cleanedMeta = (typeof window !== 'undefined' && window.SQG_CLEAN && window.SQG_CLEAN.cleanMeta)
    ? window.SQG_CLEAN.cleanMeta(meta, fromPage) : meta;

  return {
    items, totals, hasYears, schedule, tcvLabel, tcv: fmt(m.tcvC / 100), tcvPdf: fmtPdf(m.tcvC / 100), tcvSub, savings, partner, termLabel,
    meta: cleanedMeta,
  };
}

/* ---- Create quote (validation identical to original) ---- */
function makeCreateQuote(v, data) {
  const { q, m, partnerActive } = v;
  return () => {
    // On a validation miss, expand the section that holds the offending field so
    // the error message always points at something the user can see and fix.
    if (m.needsDate && !m.addonValid) { state.sections.deal = true; flash('Pick the customer’s renewal date (a future date) first', 'warn'); return; }
    if (!m.isRenOnly && (!q.lines || q.lines.length === 0)) { state.sections.selling = true; flash('Add at least one product to the quote first', 'warn'); return; }
    if (m.isRenOnly && ((q.renewLines || []).length === 0 || (q.renewLines || []).some((x) => !(+x.price > 0)))) { state.sections.selling = true; flash('Enter the amount per year for each renewing product', 'warn'); return; }
    if (partnerActive && !q.partnerCompany.trim()) { state.sections.who = true; flash('Add the partner company (bill to) in “Who’s it for?”', 'warn'); return; }
    if (!q.customer.trim()) { state.sections.who = true; flash('Add a customer name in “Who’s it for?” first', 'warn'); return; }
    // Auto-save to the shared database on every quote request (there's no longer
    // a separate "Save to database" button). Fire-and-forget — its own toast /
    // AI note surface when it returns, and a save failure never blocks the PDF.
    try {
      if (window.SQG_SHEETS && typeof window.SQG_SHEETS.saveQuoteToSheet === 'function') {
        window.SQG_SHEETS.saveQuoteToSheet();
      }
    } catch (e) { /* saving is best-effort; the PDF still generates */ }
    window.SQG_PDF.downloadQuotePdf(data)
      .then(() => flash('Quote ' + q.number + ' ready for ' + q.customer + (partnerActive ? ' via ' + q.partnerCompany : '') + ' — PDF downloaded', 'ok'))
      .catch(() => flash('Could not generate the PDF — try again', 'warn'));
  };
}

/* ---- Bottom dock: running total + Create quote ---- */
/* One circular dock button (iOS-dock style) — a round icon on top, a tiny text
   label underneath. Pure presentation; every caller passes an existing handler.
   `disabled` reuses the same lock look the old inline buttons used (.sqg-locked). */
function dockIcon(opts) {
  const circle = h('span', { class: 'sqg-dock-icon-circle' });
  circle.innerHTML = opts.icon;
  const btn = h('button', {
    class: 'sqg-dock-icon'
      + (opts.accent ? ' accent' : '')
      + (opts.listening ? ' listening' : '')
      + (opts.disabled ? ' sqg-locked' : ''),
    type: 'button',
    'aria-label': opts.ariaLabel,
    title: opts.ariaLabel,
    'aria-pressed': opts.pressed != null ? (opts.pressed ? 'true' : 'false') : null,
    disabled: opts.disabled ? 'disabled' : null,
    onClick: opts.onClick,
  }, circle, h('span', { class: 'sqg-dock-icon-label' }, opts.label));
  return btn;
}

/* The iPhone-style bottom dock row: Analyze · New quote · Speak. Each icon fires
   the SAME existing handler the old triggers used — analyze's run(), the new-quote
   reset prompt, and voice's toggle() — and reuses the existing mutual-exclusion
   lock checks (SQG_VOICE.isListening / SQG_ANALYZE.isRunning). The mic hides itself
   when the browser has no speech recognition, exactly as before. */
function buildDockToolbar() {
  const voice = window.SQG_VOICE;
  const analyze = window.SQG_ANALYZE;
  const listening = !!(voice && typeof voice.isListening === 'function' && voice.isListening());
  const analyzing = !!(analyze && typeof analyze.isRunning === 'function' && analyze.isRunning());
  const voiceSupported = !!(voice && typeof voice.supported === 'function' && voice.supported());
  const speakLocked = analyzing && !listening; // mic locked while analyze runs (same rule as voice.js button())

  const row = h('div', { class: 'sqg-dock-toolbar', role: 'group', 'aria-label': 'Quote actions' });

  // Analyze this page — same run() action; locked while "Speak to fill" is
  // listening. Hidden unless the admin turns it on in Settings (default off).
  if (state.cfg && state.cfg.showAnalyze) {
    row.append(dockIcon({
      icon: SVG_SCAN_DOCK,
      label: 'Analyze',
      ariaLabel: listening
        ? 'Stop “Speak to fill” first — only one runs at a time'
        : 'Analyze this page',
      disabled: listening,
      onClick: () => { if (analyze && typeof analyze.run === 'function') analyze.run(); },
    }));
  }

  // New quote — same action the old header icon used (confirmation modal follows).
  row.append(dockIcon({
    icon: SVG_FILE_PLUS_DOCK,
    label: 'New quote',
    ariaLabel: 'Start a new quote',
    onClick: () => { state.newQuotePrompt = true; render(); },
  }));

  // Speak to fill — default white like the other two dock icons; hidden when voice
  // is unsupported, locked while an analyze is running, and turns to the red
  // listening state (stop glyph + pulse) only while actively listening.
  if (voiceSupported) {
    row.append(dockIcon({
      icon: listening ? SVG_STOP_DOCK : SVG_MIC_DOCK,
      label: listening ? 'Stop' : 'Speak',
      ariaLabel: speakLocked
        ? 'Analyzing the page… wait for it to finish'
        : (listening ? 'Stop listening (fields fill live as you speak)' : 'Speak to fill'),
      listening: listening,
      pressed: listening,
      disabled: speakLocked,
      onClick: () => { if (voice && typeof voice.toggle === 'function') voice.toggle(); },
    }));
  }

  return row;
}

function buildDock(v) {
  const data = buildQuoteData(v);
  const summary = h('button', {
    class: 'sqg-dock-summary', type: 'button',
    'aria-expanded': state.sheet ? 'true' : 'false',
    'aria-label': 'Show quote details',
    onClick: () => { state.sheet = !state.sheet; render(); },
  });
  const label = h('span', { class: 'sqg-dock-label' }, data.tcvLabel + ' ');
  const chev = h('span', { style: 'display: inline-flex; transition: transform 160ms; transform: rotate(' + (state.sheet ? '180deg' : '0deg') + ');' });
  chev.innerHTML = SVG_CHEVRON_UP;
  label.append(chev);
  summary.append(
    label,
    h('span', { class: 'sqg-dock-amt' }, data.tcv),
    h('span', { class: 'sqg-dock-sub' },
      data.termLabel,
      data.savings ? h('span', { class: 'save' }, ' · saves ' + data.savings.amt + ' (' + data.savings.pct + '%)') : null
    )
  );

  return h('div', { class: 'sqg-dock', id: 'sqg-dock' },
    buildDockToolbar(),
    h('div', { class: 'sqg-dock-inner' },
      summary,
      h('div', { class: 'sqg-dock-actions' },
        // "Save to database" is no longer a button — every quote is saved
        // automatically when "Create quote" runs (see makeCreateQuote).
        dsButton('Create quote', 'primary', 'md', false, makeCreateQuote(v, data))
      )
    ));
}

/* ---- Quote details sheet ---- */
function buildSheet(v) {
  const wrap = h('div', { id: 'sqg-sheet-wrap' });
  if (!state.sheet) return wrap;

  const { m, partnerActive } = v;
  const data = buildQuoteData(v);
  const close = () => { state.sheet = false; render(); };

  const body = h('div', { class: 'sqg-sheet-body' });

  // Line items
  body.append(h('div', { style: 'display: flex; flex-direction: column; margin-bottom: 12px;' },
    data.items.map((it) => h('div', { class: 'sqg-sum-item' },
      h('div', { style: 'display: flex; flex-direction: column; gap: 0; min-width: 0;' },
        h('span', { style: 'font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' }, it.name),
        h('span', { style: 'font-size: 11.5px; color: var(--text-tertiary);' }, it.qtyDisp)
      ),
      h('span', { class: 'sqg-mono', style: 'font-size: 13px; flex-shrink: 0;' }, it.amt)
    ))));

  // Totals block
  const totalsEl = h('div', { class: 'sqg-sum-rows' });
  data.totals.forEach((rowData) => {
    if (rowData.divider) {
      totalsEl.append(h('div', { class: 'sqg-sum-divider' }));
      return;
    }
    totalsEl.append(h('div', { class: 'sqg-sum-row', style: rowData.bold ? 'font-weight: 600; font-size: 13.5px;' : '' },
      h('span', { style: rowData.bold ? '' : 'color: var(--text-secondary);' }, rowData.label),
      h('span', { class: 'sqg-mono', style: rowData.green ? 'color: var(--green-600);' : '' }, rowData.amt)));
  });
  body.append(totalsEl);

  // Billing schedule
  if (data.hasYears) {
    body.append(h('div', { class: 'sqg-sum-box' },
      h('span', { class: 'sqg-sum-box-label' }, 'Billing schedule'),
      data.schedule.map((y) => h('div', { class: 'sqg-sum-row', style: 'font-size: 12.5px;' },
        h('span', { style: 'color: var(--text-secondary);' }, y.label),
        h('span', { class: 'sqg-mono' }, y.amt)))));
  }

  // TCV box
  body.append(h('div', { class: 'sqg-tcv-box' },
    h('span', { class: 'sqg-tcv-label' }, data.tcvLabel),
    h('span', { class: 'sqg-tcv-amt' }, data.tcv),
    h('span', { class: 'sqg-tcv-sub' }, data.tcvSub)));

  // Savings banner
  if (data.savings) {
    body.append(h('div', { style: 'margin-top: 10px; padding: 9px 13px; background: var(--success-soft); border-radius: 10px; display: flex; justify-content: space-between; align-items: center; gap: 8px;' },
      h('span', { style: 'font-size: 12px; font-weight: 600; color: var(--green-600);' }, 'Customer saves vs list'),
      h('span', { class: 'sqg-mono', style: 'font-size: 12px; font-weight: 700; color: var(--green-600);' },
        '−' + data.savings.amt + ' (' + data.savings.pct + '%)')));
  }

  // Partner breakdown
  if (partnerActive) {
    body.append(h('div', { class: 'sqg-sum-box' },
      h('div', { class: 'sqg-sum-row', style: 'font-size: 12.5px;' },
        h('span', { style: 'color: var(--text-secondary);' }, 'List price · TCV'),
        h('span', { class: 'sqg-mono' }, fmt(m.msrpTcvC / 100))),
      h('div', { class: 'sqg-sum-row', style: 'font-size: 12.5px;' },
        h('span', { style: 'color: var(--text-secondary);' }, 'Partner savings'),
        h('span', { class: 'sqg-mono', style: 'color: var(--green-600);' }, '−' + fmt((m.msrpTcvC - m.tcvC) / 100))),
      h('div', { class: 'sqg-sum-row', style: 'font-size: 12.5px; font-weight: 600; border-top: 1px solid var(--border-default); padding-top: 7px;' },
        h('span', null, 'Partner pays'),
        h('span', { class: 'sqg-mono' }, fmt(m.tcvC / 100)))));
  }

  body.append(h('p', { style: 'margin: 14px 0 0; font-size: 11.5px; color: var(--text-tertiary); text-wrap: pretty;' },
    'Estimate only, not a formal quote · USD, billed annually · pricing follows the rates in settings'));

  wrap.append(
    h('button', { class: 'sqg-scrim', type: 'button', 'aria-label': 'Close quote details', onClick: close }),
    h('div', { class: 'sqg-sheet', role: 'dialog', 'aria-label': 'Quote details' },
      h('div', { class: 'sqg-sheet-grab' }),
      h('div', { class: 'sqg-sheet-head' },
        h('h2', null, 'Your quote'),
        h('div', { style: 'display: flex; align-items: center; gap: 10px;' },
          h('span', { class: 'sqg-sheet-term' }, data.termLabel),
          iconButton('x', 'sm', close, 'Close quote details'))),
      body)
  );
  return wrap;
}

/* ---------------- Settings screen ---------------- */

function renderSettings() {
  const cfg = state.cfg;
  const r = cfg.rules;
  const epTiersSorted = sortTiers(cfg.epTiers);
  const userTiersSorted = sortTiers(cfg.userTiers);
  const termsSorted = cfg.terms.slice().sort((a, b) => a.years - b.years);

  const main = h('main', { class: 'sqg-settings-main' });

  main.append(h('div', { style: 'display: flex; flex-direction: column; gap: 2px; padding: 2px 4px 0;' },
    h('h1', { style: "margin: 0; font-family: var(--font-display); font-weight: 700; font-size: 21px; letter-spacing: -0.02em; color: var(--text-strong);" }, 'Pricing settings'),
    h('p', { style: 'margin: 0; font-size: 13px; color: var(--text-secondary);' }, 'Changes apply to the calculator immediately and save to this browser.')));

  /* Your profile — read-only. Names are captured once at first run (localStorage
     'sqg-user'); that's intended, so there's no editable field here. */
  const profileSection = h('section', { class: 'sqg-set-card' },
    h('div', { style: 'padding-bottom: 2px;' }, h('h2', null, 'Your profile')),
    h('div', { class: 'sqg-rule-row', style: 'border-bottom: none; padding-bottom: 4px;' },
      h('div', { class: 'sqg-rule-titles' },
        h('span', { style: 'font-size: 13.5px; font-weight: 600;' }, 'Signed in as ' + userFullName()),
        h('span', { style: 'font-size: 12.5px; color: var(--text-secondary);' }, 'Captured at first run · default “Prepared by” · sent with every quote saved to the database'))));
  main.append(profileSection);

  /* Access */
  const accessSection = h('section', { class: 'sqg-set-card' },
    h('div', { style: 'padding-bottom: 2px;' }, h('h2', null, 'Settings access')),
    h('div', { class: 'sqg-rule-row', style: 'border-bottom: none; padding-bottom: 4px;' },
      h('div', { class: 'sqg-rule-titles' },
        h('span', { style: 'font-size: 13.5px; font-weight: 600;' }, 'Settings password'),
        h('span', { style: 'font-size: 12.5px; color: var(--text-secondary);' }, 'Required to open this screen · default 2026')),
      h('input', {
        class: 'sqg-in', type: 'text', value: cfg.settingsPassword, dataK: 'settings-password-cfg',
        onChange: (e) => { const v = e.target.value.trim(); if (v) setCfg({ settingsPassword: v }); },
        style: 'height: 36px; padding: 0 10px; font-family: var(--font-mono); font-size: 13.5px; color: var(--text-primary); width: 140px; text-align: right; ' + IN_BASE,
      })));
  main.append(accessSection);

  /* Quote types — which deal types users may pick in the calculator. Toggling one
     off hides it everywhere (UI, voice, analyze). At least one must stay on. */
  const enabledTypes = normalizeEnabledTypes(cfg);
  const qtRows = [
    { key: 'new', label: 'Net new customer' },
    { key: 'addon', label: 'Current customer — Add-on' },
    { key: 'ren', label: 'Current customer — Renewal' },
    { key: 'addonren', label: 'Current customer — Add-on + renewal' },
  ];
  const qtSection = h('section', { class: 'sqg-set-card' },
    h('div', { style: 'padding-bottom: 2px;' },
      h('h2', null, 'Quote types'),
      h('p', { style: 'margin: 3px 0 0; font-size: 12.5px; color: var(--text-secondary);' },
        'Users only see the quote types turned on here.')));
  qtRows.forEach((row, i) => {
    qtSection.append(h('div', { class: 'sqg-rule-row', style: i === qtRows.length - 1 ? 'border-bottom: none;' : null },
      h('div', { class: 'sqg-rule-titles' },
        h('span', { style: 'font-size: 13.5px; font-weight: 600;' }, row.label)),
      switchEl(!!enabledTypes[row.key], (e) => {
        const res = toggleEnabledType(cfg, row.key, e.target.checked);
        if (!res.ok) {
          // Guardrail — at least one type must stay on. flash() re-renders, which
          // snaps the toggle back to on (state is unchanged) and shows the reason.
          flash('At least one quote type must stay on', 'warn');
          return;
        }
        // Persist the new set and, if the active quote is now a disabled type,
        // clamp it so returning to the calculator lands on a valid type.
        state.cfg = Object.assign({}, state.cfg, { enabledQuoteTypes: res.enabledQuoteTypes });
        const c = clampQuoteType(state.cfg, state.quote.customerType, state.quote.dealType);
        if (c.changed) state.quote = Object.assign({}, state.quote, { customerType: c.customerType, dealType: c.dealType });
        persist();
        render();
      })));
  });
  main.append(qtSection);

  /* Products */
  const prodSection = h('section', { class: 'sqg-set-card' },
    h('div', { class: 'sqg-set-head' },
      h('div', null,
        h('h2', null, 'Products'),
        h('p', { style: 'margin: 3px 0 0; font-size: 12.5px; color: var(--text-secondary);' },
          'Endpoint products use the endpoint rate table (× rate multiplier); user products use the per-user monthly table')),
      dsButton('Add', 'secondary', 'sm', false,
        () => setCfg({ products: cfg.products.concat([{ id: uid(), name: 'New product', unit: 'endpoint', platformFee: 0, minTotal: 5000, factor: 1 }]) }))));
  const numIn = 'height: 36px; padding: 0 8px; font-family: var(--font-mono); font-size: 13px; color: var(--text-primary); width: 100%; text-align: right; ' + IN_BASE;
  const prodList = h('div', { style: 'display: flex; flex-direction: column; gap: 10px;' });
  for (const p of cfg.products) {
    const upd = (patch) => setCfg({ products: cfg.products.map((x) => x.id === p.id ? Object.assign({}, x, patch) : x) });
    const cell = (labelText, field) => h('div', { class: 'sqg-cell' }, h('span', { class: 'sqg-mini-label' }, labelText), field);
    prodList.append(h('div', { class: 'sqg-prod-card' },
      h('div', { class: 'sqg-prod-head' },
        h('input', {
          class: 'sqg-in', type: 'text', value: p.name, dataK: 'p-name-' + p.id, 'aria-label': 'Product name',
          onChange: (e) => upd({ name: e.target.value }),
          style: 'height: 38px; padding: 0 10px; font: inherit; font-size: 14px; font-weight: 600; color: var(--text-primary); ' + IN_BASE,
        }),
        cfg.products.length > 1
          ? iconButton('x', 'sm', () => setCfg({ products: cfg.products.filter((x) => x.id !== p.id) }), 'Remove product')
          : null
      ),
      h('div', { class: 'sqg-prod-fields' },
        cell('Priced per', h('select', {
          class: 'sqg-sel', value: p.unit, dataK: 'p-unit-' + p.id,
          onChange: (e) => upd({ unit: e.target.value }),
          style: 'height: 36px; padding: 0 8px; font: inherit; font-size: 13px; color: var(--text-primary); width: 100%; ' + IN_BASE,
        }, h('option', { value: 'user' }, 'User'), h('option', { value: 'endpoint' }, 'Endpoint'))),
        cell('Rate ×', h('input', { class: 'sqg-in', type: 'number', min: 0, step: 0.1, value: p.factor, dataK: 'p-factor-' + p.id, onChange: (e) => upd({ factor: Math.max(0, parseFloat(e.target.value) || 1) }), style: numIn })),
        cell('Platform fee', h('input', { class: 'sqg-in', type: 'number', min: 0, step: 500, value: p.platformFee, dataK: 'p-fee-' + p.id, onChange: (e) => upd({ platformFee: Math.max(0, parseFloat(e.target.value) || 0) }), style: numIn })),
        cell('Min / yr', h('input', { class: 'sqg-in', type: 'number', min: 0, step: 500, value: p.minTotal, dataK: 'p-min-' + p.id, onChange: (e) => upd({ minTotal: Math.max(0, parseFloat(e.target.value) || 0) }), style: numIn }))
      )
    ));
  }
  prodSection.append(prodList);
  prodSection.append(h('p', { style: 'margin: 10px 0 0; font-size: 11.5px; color: var(--text-tertiary);' },
    "Platform fee is waived when a line's subscription reaches " + fmt(r.waiveAt) + '/yr; the yearly minimum then applies to subscription + fee.'));
  main.append(prodSection);

  /* Tier tables */
  const tierSection = (title, desc, key, sorted, unitWord, addLabel, onAdd, headUnit, rateStep) => {
    const sec = h('section', { class: 'sqg-set-card' },
      h('div', { class: 'sqg-set-head' },
        h('div', null, h('h2', null, title),
          h('p', { style: 'margin: 3px 0 0; font-size: 12.5px; color: var(--text-secondary);' }, desc)),
        dsButton(addLabel, 'secondary', 'sm', false, onAdd)),
      h('div', { class: 'sqg-tier-grid sqg-table-head' },
        h('span', null, 'Up to (' + (unitWord === 'Users' ? 'users' : 'units') + ')'),
        h('span', { style: 'text-align: right;' }, headUnit), h('span')));
    sorted.forEach((t, i) => {
      const from = i === 0 ? 1 : (sorted[i - 1].upTo == null ? 1 : sorted[i - 1].upTo + 1);
      const hint = t.upTo == null
        ? unitWord + ' ' + from.toLocaleString('en-US') + ' and up'
        : unitWord + ' ' + from.toLocaleString('en-US') + '–' + t.upTo.toLocaleString('en-US');
      const tierIn = 'height: 34px; padding: 0 10px; font-family: var(--font-mono); font-size: 13px; color: var(--text-primary); width: 100%; text-align: right; ' + IN_BASE;
      sec.append(h('div', { class: 'sqg-tier-block' },
        h('div', { class: 'sqg-tier-grid' },
          t.upTo == null
            ? h('span', { style: 'font-family: var(--font-mono); font-size: 13px; color: var(--text-tertiary); padding-left: 10px;' }, '∞ and up')
            : h('input', {
                class: 'sqg-in', type: 'number', min: 1, step: 500, value: t.upTo, dataK: key + '-upto-' + i,
                onChange: (e) => setCfg({ [key]: cfg[key].map((x) => x === t ? Object.assign({}, x, { upTo: Math.max(1, int(e.target.value) || 1) }) : x) }),
                style: tierIn,
              }),
          h('input', {
            class: 'sqg-in', type: 'number', min: 0, step: rateStep, value: t.rate, dataK: key + '-rate-' + i,
            onChange: (e) => setCfg({ [key]: cfg[key].map((x) => x === t ? Object.assign({}, x, { rate: Math.max(0, parseFloat(e.target.value) || 0) }) : x) }),
            style: tierIn,
          }),
          t.upTo != null
            ? iconButton('x', 'sm', () => setCfg({ [key]: cfg[key].filter((x) => x !== t) }), 'Remove tier')
            : h('span')
        ),
        h('span', { class: 'sqg-tier-hint' }, hint)
      ));
    });
    return sec;
  };

  main.append(tierSection(
    'Endpoint volume rates',
    'Graduated $/endpoint/year — each block bills at its bracket rate, like tax brackets',
    'epTiers', epTiersSorted, 'Endpoints', 'Add tier',
    () => {
      const finite = epTiersSorted.filter((t) => t.upTo != null);
      const last = finite[finite.length - 1];
      setCfg({ epTiers: cfg.epTiers.concat([{ upTo: last ? last.upTo * 2 : 1000, rate: last ? Math.max(0.05, +(last.rate / 2).toFixed(2)) : 5 }]) });
    },
    '$ / endpoint / yr', 0.05
  ));

  main.append(tierSection(
    'User volume rates',
    'Graduated $/user/month — annual price is the blended monthly total × 12 · minimum ' + r.minUsers.toLocaleString('en-US') + ' users',
    'userTiers', userTiersSorted, 'Users', 'Add tier',
    () => {
      const finite = userTiersSorted.filter((t) => t.upTo != null);
      const last = finite[finite.length - 1];
      setCfg({ userTiers: cfg.userTiers.concat([{ upTo: last ? last.upTo * 2 + 1 : 999, rate: last ? Math.max(0.25, +(last.rate - 0.5).toFixed(2)) : 4 }]) });
    },
    '$ / user / mo', 0.25
  ));

  /* Deal rules */
  const setRule = (k) => (e) => setCfg({ rules: Object.assign({}, r, { [k]: Math.max(0, parseFloat(e.target.value) || 0) }) });
  const ruleRows = [
    { label: 'Bundle threshold', desc: 'Endpoint products in a quote before the bundle discount applies', value: r.bundleMin, step: 1, isMoney: false, isPct: false, onChange: (e) => setCfg({ rules: Object.assign({}, r, { bundleMin: Math.max(1, int(e.target.value) || 2) }) }) },
    { label: 'Bundle discount', desc: 'Off MSRP on every endpoint line once the threshold is met', value: r.bundlePct, step: 1, isMoney: false, isPct: true, onChange: setRule('bundlePct') },
    { label: 'Platform fee waived at', desc: 'Annual subscription value where the platform fee drops off', value: r.waiveAt, step: 1000, isMoney: true, isPct: false, onChange: setRule('waiveAt') },
    { label: 'Premium support rate', desc: 'Percent of subscription + platform fee, per line', value: r.suppPct, step: 1, isMoney: false, isPct: true, onChange: setRule('suppPct') },
    { label: 'Premium support minimum', desc: 'Yearly floor for the support add-on', value: r.suppMin, step: 500, isMoney: true, isPct: false, onChange: setRule('suppMin') },
    { label: 'Minimum users', desc: 'Quantity floor for user-priced products', value: r.minUsers, step: 50, isMoney: false, isPct: false, onChange: (e) => setCfg({ rules: Object.assign({}, r, { minUsers: Math.max(1, int(e.target.value) || 250) }) }) },
    { label: 'Max extra discount', desc: 'Cap on the rep’s stacked discount', value: r.maxExtra, step: 1, isMoney: false, isPct: true, onChange: setRule('maxExtra') },
  ];
  const rulesSection = h('section', { class: 'sqg-set-card', style: 'padding: 4px 16px;' },
    h('div', { style: 'padding: 12px 0 2px;' }, h('h2', null, 'Deal rules')));
  ruleRows.forEach((rr, i) => {
    rulesSection.append(h('div', { class: 'sqg-rule-row' },
      h('div', { class: 'sqg-rule-titles' },
        h('span', { style: 'font-size: 13.5px; font-weight: 600;' }, rr.label),
        h('span', { style: 'font-size: 12.5px; color: var(--text-secondary);' }, rr.desc)),
      h('div', { class: 'sqg-rule-input' },
        rr.isMoney ? h('span', { style: 'color: var(--text-tertiary); font-size: 14px;' }, '$') : null,
        h('input', {
          class: 'sqg-in', type: 'number', min: 0, step: rr.step, value: rr.value, dataK: 'rule-' + i,
          onChange: rr.onChange,
          style: 'height: 36px; padding: 0 10px; font-family: var(--font-mono); font-size: 13.5px; color: var(--text-primary); width: 96px; text-align: right; ' + IN_BASE,
        }),
        rr.isPct ? h('span', { style: 'color: var(--text-tertiary); font-size: 14px;' }, '%') : null
      )));
  });
  rulesSection.append(h('div', { class: 'sqg-rule-row', style: 'border-bottom: none;' },
    h('div', { class: 'sqg-rule-titles' },
      h('span', { style: 'font-size: 13.5px; font-weight: 600;' }, 'Allow prorated terms'),
      h('span', { style: 'font-size: 12.5px; color: var(--text-secondary);' }, 'Reps quote any length from 6 to 60 months with a slider')),
    switchEl(!!cfg.allowProration, (e) => setCfg({ allowProration: e.target.checked }))));
  rulesSection.append(h('div', { class: 'sqg-rule-row', style: 'border-bottom: none;' },
    h('div', { class: 'sqg-rule-titles' },
      h('span', { style: 'font-size: 13.5px; font-weight: 600;' }, 'Show Analyze button'),
      h('span', { style: 'font-size: 12.5px; color: var(--text-secondary);' }, 'Show the “Analyze this page” button in the bottom toolbar')),
    switchEl(!!cfg.showAnalyze, (e) => setCfg({ showAnalyze: e.target.checked }))));
  rulesSection.append(h('div', { class: 'sqg-rule-row', style: 'border-bottom: none; padding-top: 0; padding-bottom: 14px;' },
    h('div', { class: 'sqg-rule-titles' },
      h('span', { style: 'font-size: 13.5px; font-weight: 600;' }, 'Default billing term'),
      h('span', { style: 'font-size: 12.5px; color: var(--text-secondary);' }, 'Pre-selected term on new quotes')),
    h('select', {
      class: 'sqg-sel', value: cfg.defaultYears, dataK: 'default-years',
      onChange: (e) => setCfg({ defaultYears: parseInt(e.target.value, 10) || 1 }),
      style: 'height: 38px; padding: 0 12px; border-radius: 12px; font: inherit; font-size: 13.5px; color: var(--text-primary); ' + IN_BASE,
    }, termsSorted.map((t) => h('option', { value: t.years }, t.years + (t.years > 1 ? ' years' : ' year') + (t.pct ? ' · −' + t.pct + '%' : ''))))));
  main.append(rulesSection);

  /* Term discounts */
  const termSection = h('section', { class: 'sqg-set-card' },
    h('div', { class: 'sqg-set-head' },
      h('div', null,
        h('h2', null, 'Term discounts'),
        h('p', { style: 'margin: 3px 0 0; font-size: 12.5px; color: var(--text-secondary);' }, 'Optional discount on the whole quote by contract length — 0% by default')),
      dsButton('Add term', 'secondary', 'sm', false, () => {
        const last = termsSorted[termsSorted.length - 1];
        setCfg({ terms: cfg.terms.concat([{ years: last ? last.years + 1 : 1, pct: last ? last.pct : 0 }]) });
      })),
    h('div', { class: 'sqg-term-grid sqg-table-head' },
      h('span', null, 'Term (years)'), h('span', { style: 'text-align: right;' }, 'Discount'), h('span')));
  termsSorted.forEach((t, i) => {
    termSection.append(h('div', { class: 'sqg-term-grid', style: 'padding: 8px 0; border-bottom: 1px solid var(--border-subtle);' },
      h('input', {
        class: 'sqg-in', type: 'number', min: 1, max: 10, value: t.years, dataK: 'term-years-' + i,
        onChange: (e) => setCfg({ terms: cfg.terms.map((x) => x === t ? Object.assign({}, x, { years: Math.max(1, int(e.target.value) || 1) }) : x) }),
        style: 'height: 36px; padding: 0 10px; font-family: var(--font-mono); font-size: 13.5px; color: var(--text-primary); width: 100%; text-align: right; ' + IN_BASE,
      }),
      h('div', { style: 'display: flex; align-items: center; gap: 6px; justify-content: flex-end;' },
        h('input', {
          class: 'sqg-in', type: 'number', min: 0, max: 100, value: t.pct, dataK: 'term-pct-' + i,
          onChange: (e) => setCfg({ terms: cfg.terms.map((x) => x === t ? Object.assign({}, x, { pct: Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)) }) : x) }),
          style: 'height: 36px; padding: 0 10px; font-family: var(--font-mono); font-size: 13.5px; color: var(--text-primary); width: 72px; text-align: right; ' + IN_BASE,
        }),
        h('span', { style: 'color: var(--text-tertiary); font-size: 14px;' }, '%')),
      cfg.terms.length > 1
        ? iconButton('x', 'sm', () => setCfg({ terms: cfg.terms.filter((x) => x !== t) }), 'Remove term')
        : h('span')
    ));
  });
  main.append(termSection);

  /* Footer actions */
  main.append(h('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;' },
    h('button', { class: 'sqg-link-btn', type: 'button', onClick: () => {
      state.cfg = defaults();
      // Reset restores the default quote-type set (only net-new on) too; clamp the
      // active quote so it stays a valid enabled type.
      const c = clampQuoteType(state.cfg, state.quote.customerType, state.quote.dealType);
      if (c.changed) state.quote = Object.assign({}, state.quote, { customerType: c.customerType, dealType: c.dealType });
      persist(); render();
    } }, 'Reset to default pricing'),
    dsButton('Back to calculator', 'primary', 'md', false, () => { state.view = 'calc'; render(); })));

  return main;
}

/* Action API for voice commands (voice.js) — lets "Speak to fill" drive the same
   capabilities as the buttons: create/new quote, show the quote details sheet,
   open settings, and expand/collapse a section. Each goes through the normal
   state + render path, exactly like a click. Defined here (after everything) so
   the helpers it calls already exist. */
window.SQG_APP = {
  createQuote: function () { try { const v = computeView(); makeCreateQuote(v, buildQuoteData(v))(); } catch (e) {} },
  promptNewQuote: function () { if (state.view !== 'calc') return; state.newQuotePrompt = true; render(); },
  showSheet: function (open) { if (state.view !== 'calc') return; state.sheet = !!open; render(); },
  openSettings: function () { if (state.view === 'calc') { state.pwPrompt = true; render(); } },
  setSection: function (key, open) { if (state.sections && Object.prototype.hasOwnProperty.call(state.sections, key)) { state.sections[key] = !!open; render(); } },
  // Expand a set of calculator sections without forcing a render (the caller's
  // own setQ/render follows). Used by the AI review path (analyze.js) so applied
  // deal/discount/support values land in a section the user can see.
  openSections: function (keys) { if (!state.sections) return; (keys || []).forEach(function (k) { if (Object.prototype.hasOwnProperty.call(state.sections, k)) state.sections[k] = true; }); },
  // "Look up address" fallback candidate filter — exposed for the /tests
  // harness (pure: OSM result list in → best company-plausible hit or null).
  osmPick: pickOsmCandidate,
  // v3.7 — automatic, guarded HQ-address fill; called by voice.js's AI
  // reasoning pass after a dictation session ends.
  autoLookupAddress: maybeAutoLookupBillingAddress,
  // Quote-type enablement helpers — exposed for the /tests harness (and available
  // to any future caller). The extension itself uses the top-level functions.
  defaults: defaults,
  quoteTypes: {
    normalize: normalizeEnabledTypes,
    key: quoteTypeKey,
    isEnabled: isTypeEnabled,
    currentKeys: enabledCurrentKeys,
    clamp: clampQuoteType,
    toggle: toggleEnabledType,
    fallback: fallbackType,
    renewalCapable: renewalCapableEnabled,
    label: quoteTypeLabel,
  },
};

/* ---------------- Boot ----------------
   Guarded so the file can also be loaded head-less (the /tests harness drives the
   exported helpers under Node with no DOM); in the extension the side-panel root
   always exists, so this runs exactly as before. */
if (typeof document !== 'undefined' && document.getElementById && document.getElementById('screen-root')) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.pwPrompt) { state.pwPrompt = false; render(); }
    else if (e.key === 'Escape' && state.sheet) { state.sheet = false; render(); }
  });
  render();
  // One-time notice when a restored quote was clamped to an enabled type.
  if (state.pendingClampToast) { const msg = state.pendingClampToast; state.pendingClampToast = ''; flash(msg, 'warn'); }
}
