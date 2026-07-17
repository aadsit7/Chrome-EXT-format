'use strict';

/* Sales Quote Generator — "Analyze this page"
   Reads the active browser tab (read-only) and proposes matching values for the
   quote form. Extraction paths, best first:

     • AI-assisted (primary): a rich page snapshot (snapshotPage) is captured in
       every frame — walking the DOM INCLUDING shadow roots so Salesforce
       Lightning values are actually seen, plus label→value pairs and related-list
       tables — merged with the rule-based result below, and POSTed to the Apps
       Script (action:"analyzePage"). The structured fields it returns are mapped
       into the review card. If the AI call fails or returns nothing usable, we
       fall back to the rule-based detection below (so behaviour is never worse).
     • Salesforce rule-based: record-detail label/value pairs from Lightning
       (.slds-form-element__label / test-id__field-label) and Classic
       (.labelCol / .dataCol) layouts, plus related-list product tables.
     • Generic rule-based: label/value extraction from tables, forms and
       definition lists, plus catalog product matching, for any other website.

   Everything is surfaced in a review card first — nothing is written until the
   user applies. The injected functions run INSIDE the tab (allFrames: true) and
   only read the DOM; the panel side POSTs the snapshot.

   Relies on globals defined in app.js (state, setQ, render, flash, h, dsButton,
   uid, int, fmt) and window.SQG_SHEETS.analyzePage (sheets.js). This script is
   loaded before app.js / after sheets.js is defined-at-call-time; the functions
   here only touch those globals when called (well after init). */

window.SQG_ANALYZE = (function () {
  /* ---- Label vocabularies (generic, page-agnostic) ---- */
  var CUST_LABELS = ['customer', 'account name', 'account', 'company name', 'company', 'client', 'organization', 'organisation', 'end customer'];
  var BILL_LABELS = ['bill to', 'bill-to', 'billto', 'billing company', 'billing', 'invoice to', 'sold to', 'reseller', 'partner', 'distributor'];
  var EMAIL_LABELS = ['email', 'e-mail', 'contact email', 'contact'];
  var QTY_LABELS = ['quantity', 'qty', 'endpoints', 'devices', 'users', 'seats', 'licenses', 'licences', 'nodes', 'current device count', 'maximum device count'];
  var DATE_LABELS = ['renewal date', 'renews on', 'renews', 'renewal', 'expiration date', 'expiration', 'expires', 'end date', 'term end', 'contract end', 'close date', 'license start date', 'license expiration date', 'renewal month date', 'start date'];

  /* Salesforce-specific label groups, used by the rule-based extractor to apply
     the field vocabulary + precedence rules from the two real Opportunity pages
     (Quote Information / Products on new business; Renewals + Subscription
     Information + Partner/Reseller on renewals). Kept here so both the in-page
     extractor and the panel-side finding builder read from one source. */
  var SF_LABELS = {
    account: ['account name', 'account'],
    accountExclude: ['owner', 'number', 'site', 'type', 'source', 'currency', 'record', 'id', 'status', 'stage', 'parent', 'plan', 'team'],
    partner: ['partner/reseller', 'partner / reseller', 'partner reseller', 'reseller', 'partner', 'distributor'],
    // Renewal date precedence: license-expiration / end-date beat renewal-month,
    // and Close Date is only a last-resort fallback (it's a sales forecast).
    dateLicenseExpiration: ['license expiration date', 'license expiry date', 'license expiry'],
    dateEnd: ['end date', 'term end', 'contract end'],
    dateRenewalMonth: ['renewal month date', 'renewal date', 'renews on', 'renews'],
    dateClose: ['close date'],
    quoteExpiration: ['quote expiration date'],
    // Quantity precedence: Subscription/Renewals panel > related-list > device count.
    qtyPanel: ['quantity', 'qty'],
    qtyDevice: ['current device count', 'maximum device count new', 'maximum device count'],
    term: ['subscription term'],
    subscriptionType: ['subscription type'],
    arrUpForRenewal: ['arr up for renewal'],
    recordType: ['opportunity record type', 'record type'],
    products: ['product(s)', 'products', 'product'],
    // Context-only values that must never be read as a quantity.
    endpointTier: ['endpoint tier'],
    // Field labels that mark a renewal-type opportunity / its panels.
    renewalMarkers: ['arr up for renewal', 'renewal month date', 'license expiration date', 'renewal arr', 'tcv up for renewal', 'net change (arr)', 'contraction arr', 'renewal opportunity'],
    subscriptionMarkers: ['subscription term', 'subscription type', 'billing frequency', 'license start date'],
  };

  /* Catalog keyword -> default product id. Matched loosely, case-insensitively.
     Resolved against the live catalog (state.cfg.products) at build time so a
     deleted product is simply skipped. */
  var PRODUCT_KEYMAP = [
    { key: 'aw', terms: ['application workspace'] },
    { key: 'rct', terms: ['right click tools', 'right-click tools'] },
    { key: 'patch', terms: ['patching'] },
    { key: 'ins', terms: ['insights'] },
    { key: 'priv', terms: ['privilege manager'] },
  ];

  var SVG_SCAN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><circle cx="12" cy="12" r="3"></circle><path d="m16 16-1.9-1.9"></path></svg>';

  var SF_LAZY_NOTE = 'No products are visible — open or scroll to the Products related list in Salesforce, then Analyze again.';
  var SF_RENEWAL_NOTE = 'This looks like a renewal, but the Renewals / Subscription Information section wasn’t on screen — open that tab in Salesforce, then Analyze again.';

  /* Mutual exclusion with "Speak to fill": only one of the two fill features may
     be active at a time. analyzeSeq is bumped whenever a new analyze starts OR a
     voice session starts (via cancel()), which invalidates any in-flight analyze
     so its result can never surface while the user is dictating. analyzeActive is
     true while an analyze is running, and locks the mic button. */
  var analyzeSeq = 0;
  var analyzeActive = false;
  function cancelAnalyze() { analyzeSeq++; analyzeActive = false; if (state.analyze) state.analyze = null; }
  function analyzeRunning() { return analyzeActive; }

  /* =========================================================================
     Extraction — runs INSIDE the page via chrome.scripting.executeScript
     (allFrames: true, so it runs once per frame). Must be fully self-contained
     (no closure references): its source is serialised and executed in the tab.
     It only reads the DOM — never modifies it, never sends anything anywhere.
     ========================================================================= */
  function extractQuoteInfo(cfg) {
    try {
      var norm = function (s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); };
      var low = function (s) { return norm(s).toLowerCase(); };
      var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
      var EMAIL_RX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;
      var MONEY_RX = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/;

      var notEmailNum = function (v) {
        return v.length >= 2 && v.length <= 80 && !EMAIL_RX.test(v) && !/^[\d.,%$\s]+$/.test(v);
      };
      /* Money: strip a leading currency word/symbol ("USD 133,000.00", "$94,410")
         and thousands commas, then read the amount. */
      var parseMoney = function (s) {
        if (s == null) return null;
        var str = String(s);
        var m = str.match(MONEY_RX);
        if (m) { var n0 = parseFloat(m[1].replace(/,/g, '')); return isFinite(n0) ? n0 : null; }
        var m2 = str.replace(/\b(usd|eur|gbp|cad|aud)\b/gi, ' ').match(/(-?[0-9][0-9,]*(?:\.[0-9]+)?)/);
        if (!m2) return null;
        var n = parseFloat(m2[1].replace(/,/g, ''));
        return isFinite(n) ? n : null;
      };
      var looksDatey = function (s) {
        return /\d[\/\-.]\d/.test(s) || /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s);
      };
      var leadCount = function (s) {
        if (/\$/.test(s) || /%/.test(s) || looksDatey(s)) return null;
        var m = String(s).match(/(?:^|\s)([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,7})(?=\s|$|[a-zA-Z])/);
        if (!m) return null;
        var n = parseInt(m[1].replace(/,/g, ''), 10);
        return (isFinite(n) && n >= 1 && n <= 100000000) ? n : null;
      };
      /* Quantity: strip commas / "USD"; reject ranges ("1,001 - 5,000" = Endpoint
         Tier, context only), money and dates. Accepts Salesforce's "20,000.00". */
      var parseQty = function (s) {
        if (s == null) return null;
        var str = norm(s);
        if (!str) return null;
        if (/\d[\d,\.]*\s*[-–—]\s*\d/.test(str)) return null; // a RANGE (Endpoint Tier), never a quantity
        // Reject money/percent and real dates (slash dates / month names). A plain
        // decimal like "10,000.00" is a valid Salesforce quantity, so don't use the
        // date heuristic here (it would trip on the decimal point).
        if (/\$|%/.test(str) || /\d\/\d/.test(str) || /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(str)) return null;
        var m = str.replace(/\b(usd|eur|gbp|cad|aud)\b/gi, ' ').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
        if (!m) return null;
        var n = Math.round(parseFloat(m[0]));
        return (isFinite(n) && n >= 1 && n <= 100000000) ? n : null;
      };
      /* Subscription term: Salesforce stores it as a decimal ("12.000000000000");
         also handles "12 months" / "12". Returns whole months. */
      var parseTermMonths = function (s) {
        if (s == null) return null;
        var m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
        if (!m) return null;
        var n = Math.round(parseFloat(m[1]));
        return (isFinite(n) && n >= 1 && n <= 240) ? n : null;
      };

      /* ---- label/value pairs from structured markup (generic) ---- */
      var pairs = [];
      var addPair = function (l, v) {
        l = norm(l); v = norm(v);
        if (l && v && l.length <= 60 && v.length <= 200) pairs.push({ label: l, value: v });
      };

      var rows = [];
      var trs = document.querySelectorAll('table tr');
      for (var i = 0; i < trs.length; i++) {
        var cs = trs[i].querySelectorAll('th, td');
        if (!cs.length) continue;
        var cells = [];
        for (var j = 0; j < cs.length; j++) cells.push(norm(cs[j].textContent));
        rows.push(cells);
        if (cs.length >= 2) addPair(cells[0], cells[1]);
      }

      var dls = document.querySelectorAll('dl');
      for (var d = 0; d < dls.length; d++) {
        var kids = dls[d].children;
        for (var k = 0; k < kids.length; k++) {
          if (kids[k].tagName === 'DT') {
            var dd = kids[k + 1];
            if (dd && dd.tagName === 'DD') addPair(kids[k].textContent, dd.textContent);
          }
        }
      }

      var labs = document.querySelectorAll('label');
      for (var L = 0; L < labs.length; L++) {
        var lab = labs[L], inp = null, fid = lab.getAttribute('for');
        if (fid) { try { inp = document.getElementById(fid); } catch (e) { inp = null; } }
        if (!inp) inp = lab.querySelector('input, textarea, select');
        if (inp && 'value' in inp) { var vv = norm(inp.value); if (vv) addPair(lab.textContent, vv); }
      }

      var inps = document.querySelectorAll('input, textarea');
      for (var n = 0; n < inps.length; n++) {
        var el = inps[n];
        if (el.type === 'password' || el.type === 'hidden' || el.type === 'checkbox' || el.type === 'radio') continue;
        var val = norm(el.value);
        if (!val) continue;
        var lbl = el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || '';
        if (lbl) addPair(lbl, val);
      }

      /* ---- visible text ---- */
      var rawText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
      var textLines = [];
      rawText.split('\n').forEach(function (ln) { ln = norm(ln); if (ln) textLines.push(ln); });
      var flat = norm(rawText);

      /* ---- generic label lookup (scored: exact > startsWith > contains) ---- */
      var findByLabels = function (labels, validate) {
        var best = null, bestScore = 0;
        for (var p = 0; p < pairs.length; p++) {
          var pl = low(pairs[p].label), value = pairs[p].value;
          if (validate && !validate(value)) continue;
          var score = 0;
          for (var q = 0; q < labels.length; q++) {
            var key = labels[q];
            if (pl === key) score = Math.max(score, 3);
            else if (pl.indexOf(key) === 0) score = Math.max(score, 2);
            else if (pl.indexOf(key) > -1) score = Math.max(score, 1);
          }
          if (score > bestScore) { bestScore = score; best = value; }
        }
        if (best) return best;
        var rx = new RegExp('^\\s*(?:' + labels.map(esc).join('|') + ')\\b\\s*[:\\-–—]\\s*(.+)$', 'i');
        for (var t = 0; t < textLines.length; t++) {
          var mm = textLines[t].match(rx);
          if (mm) { var v = norm(mm[1]); if (v && (!validate || validate(v))) return v; }
        }
        return null;
      };

      var findEmail = function () {
        for (var p = 0; p < pairs.length; p++) {
          if (/e-?mail|contact/i.test(pairs[p].label)) {
            var m = pairs[p].value.match(EMAIL_RX);
            if (m) return m[0];
          }
        }
        var mm = flat.match(EMAIL_RX);
        return mm ? mm[0] : null;
      };

      /* ---- products (catalog match) ---- */
      var terms = cfg.productTerms;
      var matchKey = function (text) {
        var lt = low(text);
        for (var a = 0; a < terms.length; a++) {
          for (var b = 0; b < terms[a].terms.length; b++) {
            if (lt.indexOf(terms[a].terms[b]) > -1) return terms[a].key;
          }
        }
        return null;
      };

      /* generic product scan: table rows, label/value pairs, plain text lines */
      var genericProducts = function () {
        var out = [];
        for (var r = 0; r < rows.length; r++) {
          var rc = rows[r], key = null;
          for (var c = 0; c < rc.length; c++) { key = matchKey(rc[c]); if (key) break; }
          if (!key) continue;
          var price = null, qty = null;
          for (var c2 = 0; c2 < rc.length; c2++) { var pm = parseMoney(rc[c2]); if (pm != null) { price = pm; break; } }
          for (var c3 = 0; c3 < rc.length; c3++) { if (matchKey(rc[c3]) === key) continue; var qv = leadCount(rc[c3]); if (qv != null) { qty = qv; break; } }
          out.push({ key: key, qty: qty, price: price });
        }
        for (var pp = 0; pp < pairs.length; pp++) {
          var pk = matchKey(pairs[pp].label);
          if (!pk) continue;
          out.push({ key: pk, qty: leadCount(pairs[pp].value), price: parseMoney(pairs[pp].value) });
        }
        for (var t2 = 0; t2 < textLines.length; t2++) {
          var key2 = matchKey(textLines[t2]);
          if (!key2) continue;
          var line = textLines[t2];
          var price2 = parseMoney(line);
          var stripped = line.replace(MONEY_RX, ' ');
          var qty2 = leadCount(stripped);
          out.push({ key: key2, qty: qty2, price: price2 });
        }
        return out;
      };

      /* standalone quantity labels (e.g. "Endpoints: 5,000") */
      var genericQtyValues = function () {
        var qtyValues = [];
        for (var p2 = 0; p2 < pairs.length; p2++) {
          var pl2 = low(pairs[p2].label);
          for (var ql = 0; ql < cfg.qtyLabels.length; ql++) {
            if (pl2.indexOf(cfg.qtyLabels[ql]) > -1) { var qn = leadCount(pairs[p2].value); if (qn != null) qtyValues.push(qn); }
          }
        }
        return qtyValues;
      };

      /* =====================================================================
         Salesforce detection + extraction
         ===================================================================== */
      var host = (location.hostname || '');
      var isSfUrl = /(^|\.)(lightning\.force\.com|my\.salesforce\.com|salesforce\.com|force\.com|visualforce\.com)$/i.test(host)
        || /(lightning\.force\.com|my\.salesforce\.com|salesforce\.com|force\.com|visualforce\.com)/i.test(host);
      var isSfDom = !!(document.querySelector('.slds-form-element__label')
        || document.querySelector('.test-id__field-label')
        || document.querySelector('one-record-home-flexipage2, records-record-layout-item, force-record-layout-section')
        || document.querySelector('.slds-page-header')
        || document.querySelector('td.labelCol'));
      var isSalesforce = isSfUrl || isSfDom;

      /* Read a Lightning record-detail value from the container holding a label. */
      var sfLightningValue = function (labelEl) {
        var container = null;
        try { container = labelEl.closest('.slds-form-element'); } catch (e) { container = null; }
        if (!container) container = labelEl.parentElement;
        var valEl = null;
        if (container) {
          valEl = container.querySelector(
            'lightning-formatted-text, lightning-formatted-email, lightning-formatted-url, ' +
            'lightning-formatted-number, lightning-formatted-date-time, ' +
            '.test-id__field-value, .slds-form-element__static, [data-output-element-id], .uiOutputText'
          );
          if (!valEl) valEl = container.querySelector('.slds-form-element__control');
        }
        if (!valEl && labelEl.nextElementSibling) valEl = labelEl.nextElementSibling;
        return valEl ? norm(valEl.textContent) : '';
      };

      /* Build Salesforce label/value pairs from Lightning + Classic layouts. */
      var buildSfPairs = function () {
        var out = [];
        var lLabels = document.querySelectorAll('.slds-form-element__label, .test-id__field-label');
        for (var i = 0; i < lLabels.length; i++) {
          var labText = norm(lLabels[i].textContent);
          if (!labText || labText.length > 60) continue;
          var vText = sfLightningValue(lLabels[i]);
          if (vText && vText !== labText && vText.length <= 200) out.push({ label: labText, value: vText });
        }
        var labelCols = document.querySelectorAll('td.labelCol, th.labelCol');
        for (var c = 0; c < labelCols.length; c++) {
          var lc = labelCols[c];
          var dc = lc.nextElementSibling;
          while (dc && !(dc.className && /\bdataCol\b/.test(String(dc.className)))) dc = dc.nextElementSibling;
          if (!dc) continue;
          var lab = norm(lc.textContent).replace(/\s*[:：]\s*$/, '');
          var vv = norm(dc.textContent);
          if (lab && vv && lab.length <= 60 && vv.length <= 200) out.push({ label: lab, value: vv });
        }
        return out;
      };

      /* Scored lookup over Salesforce pairs. */
      var sfFind = function (sfPairs, includes, excludes, validate) {
        var best = null, bestScore = 0;
        for (var i = 0; i < sfPairs.length; i++) {
          var l = low(sfPairs[i].label), v = sfPairs[i].value;
          if (validate && !validate(v)) continue;
          var skip = false;
          if (excludes) for (var x = 0; x < excludes.length; x++) { if (l.indexOf(excludes[x]) > -1) { skip = true; break; } }
          if (skip) continue;
          var score = 0;
          for (var q = 0; q < includes.length; q++) {
            var key = includes[q];
            if (l === key) score = Math.max(score, 3);
            else if (l.indexOf(key) === 0) score = Math.max(score, 2);
            else if (l.indexOf(key) > -1) score = Math.max(score, 1);
          }
          if (score > bestScore) { bestScore = score; best = v; }
        }
        return best;
      };

      var sfFindEmail = function (sfPairs) {
        for (var i = 0; i < sfPairs.length; i++) {
          if (/e-?mail|contact email/i.test(sfPairs[i].label)) {
            var m = sfPairs[i].value.match(EMAIL_RX);
            if (m) return m[0];
          }
        }
        for (var j = 0; j < sfPairs.length; j++) {
          var mm = sfPairs[j].value.match(EMAIL_RX);
          if (mm) return mm[0];
        }
        return null;
      };

      /* Lightning page-header title (used as customer only on Account records). */
      var sfEntity = function () {
        var m = (location.pathname || '').match(/\/lightning\/r\/([A-Za-z_]+)\//);
        if (m) return m[1];
        m = (location.pathname || '').match(/\/lightning\/o\/([A-Za-z_]+)\//);
        return m ? m[1] : '';
      };
      var sfHeaderTitle = function () {
        var els = document.querySelectorAll('.slds-page-header__title, .entityNameTitle');
        for (var i = 0; i < els.length; i++) {
          var t = norm(els[i].textContent);
          if (t && t.length <= 80) return t;
        }
        return null;
      };

      /* Salesforce truncates grid cells ("Application Wo…"); the full name lives in
         the cell's link/title attribute, so prefer that over the visible text. */
      var cellFullText = function (cell) {
        if (!cell) return '';
        var t = '';
        var a = cell.querySelector ? cell.querySelector('a[title], a, [title]') : null;
        if (a) {
          if (a.getAttribute && a.getAttribute('title')) t = norm(a.getAttribute('title'));
          if (!t) t = norm(a.textContent);
        }
        if (!t && cell.getAttribute && cell.getAttribute('title')) t = norm(cell.getAttribute('title'));
        if (!t) t = norm(cell.textContent);
        return t;
      };

      /* Related-list product tables parsed by column headers. Returns matched
         product lines, whether any product-style table was present at all, and the
         first subscription-term value seen (new-business grids carry the term in a
         "Subscription Term" column instead of a record-detail field). */
      var sfProductTables = function () {
        var out = [], sawTable = false, tableTerm = null;
        var tables = document.querySelectorAll('table, [role="grid"], [role="table"], [role="treegrid"]');
        for (var t = 0; t < tables.length; t++) {
          var table = tables[t];
          var heads = table.querySelectorAll('thead th, thead td, [role="columnheader"]');
          if (!heads.length) {
            var fr = table.querySelector('tr');
            if (fr) { var ths = fr.querySelectorAll('th'); if (ths.length) heads = ths; }
          }
          if (!heads || !heads.length) continue;

          var prodIdx = -1, qtyIdx = -1, priceIdx = -1, priceRank = -1, termIdx = -1;
          for (var hI = 0; hI < heads.length; hI++) {
            var htext = low(heads[hI].getAttribute && heads[hI].getAttribute('title') ? heads[hI].getAttribute('title') : heads[hI].textContent);
            if (prodIdx < 0 && /\b(product name|product|line item|item|asset name|asset)\b/.test(htext)) prodIdx = hI;
            if (qtyIdx < 0 && /\b(quantity|qty)\b/.test(htext)) qtyIdx = hI;
            if (termIdx < 0 && /(subscription term|\bterm\b)/.test(htext)) termIdx = hI;
            var pr = -1;
            if (/annual price/.test(htext)) pr = 3;
            else if (/total price/.test(htext)) pr = 2;
            else if (/sales price/.test(htext)) pr = 1;
            else if (/(unit price|list price|net price|\bprice\b)/.test(htext)) pr = 0;
            if (pr > priceRank) { priceRank = pr; priceIdx = hI; }
          }
          if (prodIdx < 0) continue; // not a product/related-list table
          sawTable = true;

          var bodyRows = table.querySelectorAll('tbody tr');
          if (!bodyRows.length) bodyRows = table.querySelectorAll('tr, [role="row"]');
          for (var r = 0; r < bodyRows.length; r++) {
            var rowCells = bodyRows[r].querySelectorAll('th, td, [role="gridcell"], [role="cell"], [role="rowheader"]');
            if (!rowCells.length || rowCells.length <= prodIdx) continue;
            var pname = cellFullText(rowCells[prodIdx]);
            var key = matchKey(pname);
            if (termIdx >= 0 && rowCells[termIdx] && tableTerm == null) {
              var tv = parseTermMonths(norm(rowCells[termIdx].textContent));
              if (tv != null) tableTerm = tv;
            }
            if (!key) continue;
            var qty = (qtyIdx >= 0 && rowCells[qtyIdx]) ? parseQty(cellFullText(rowCells[qtyIdx])) : null;
            var price = (priceIdx >= 0 && rowCells[priceIdx]) ? parseMoney(cellFullText(rowCells[priceIdx])) : null;
            out.push({ key: key, qty: qty, price: price });
          }
        }
        return { products: out, sawTable: sawTable, term: tableTerm };
      };

      /* Contact Roles related list: prefer the row flagged Primary for the
         contact name / email / phone (falls back to the first row). */
      var sfContactRoles = function () {
        var res = { name: null, email: null, phone: null };
        var tables = document.querySelectorAll('table, [role="grid"], [role="table"], [role="treegrid"]');
        for (var t = 0; t < tables.length; t++) {
          var table = tables[t];
          var heads = table.querySelectorAll('thead th, thead td, [role="columnheader"]');
          if (!heads.length) { var fr = table.querySelector('tr'); if (fr) heads = fr.querySelectorAll('th'); }
          if (!heads || !heads.length) continue;
          var nameIdx = -1, emailIdx = -1, phoneIdx = -1, primaryIdx = -1;
          for (var h = 0; h < heads.length; h++) {
            var ht = low(heads[h].getAttribute && heads[h].getAttribute('title') ? heads[h].getAttribute('title') : heads[h].textContent);
            if (nameIdx < 0 && /(contact name|\bname\b)/.test(ht)) nameIdx = h;
            if (emailIdx < 0 && /email/.test(ht)) emailIdx = h;
            if (phoneIdx < 0 && /phone/.test(ht)) phoneIdx = h;
            if (primaryIdx < 0 && /primary/.test(ht)) primaryIdx = h;
          }
          if (nameIdx < 0 || primaryIdx < 0) continue; // not a contact-roles grid
          var rows = table.querySelectorAll('tbody tr');
          if (!rows.length) rows = table.querySelectorAll('tr, [role="row"]');
          var firstRow = null, primaryRow = null;
          for (var r = 0; r < rows.length; r++) {
            var cells = rows[r].querySelectorAll('th, td, [role="gridcell"], [role="cell"], [role="rowheader"]');
            if (cells.length <= nameIdx) continue;
            var nm = cellFullText(cells[nameIdx]);
            if (!nm || nm.length > 80) continue;
            if (!firstRow) firstRow = cells;
            var pc = cells[primaryIdx], isPrimary = false;
            if (pc) {
              var cbx = pc.querySelector ? pc.querySelector('input[type="checkbox"]') : null;
              if (cbx && cbx.checked) isPrimary = true;
              if (!isPrimary && pc.querySelector && pc.querySelector('[aria-checked="true"], [data-checked="true"]')) isPrimary = true;
              if (!isPrimary && /\b(true|yes)\b|✓|✔/i.test(norm(pc.textContent))) isPrimary = true;
              if (!isPrimary && pc.querySelector && pc.querySelector('img[alt*="rue"], img[alt*="heck"], img[alt*="es"]')) isPrimary = true;
            }
            if (isPrimary && !primaryRow) primaryRow = cells;
          }
          var pick = primaryRow || firstRow;
          if (pick) {
            res.name = (nameIdx >= 0 && pick[nameIdx]) ? cellFullText(pick[nameIdx]) : null;
            var em = (emailIdx >= 0 && pick[emailIdx]) ? cellFullText(pick[emailIdx]) : '';
            var emm = em.match(EMAIL_RX); res.email = emm ? emm[0] : null;
            var ph = (phoneIdx >= 0 && pick[phoneIdx]) ? cellFullText(pick[phoneIdx]) : '';
            res.phone = (ph && /\d/.test(ph)) ? ph : null;
            return res;
          }
        }
        return res;
      };

      /* Scored value lookup over SF pairs by a list of candidate labels. */
      var sfByLabels = function (sfPairs, labels, validate) {
        var best = null, bestScore = 0;
        for (var i = 0; i < sfPairs.length; i++) {
          var l = low(sfPairs[i].label), v = sfPairs[i].value;
          if (validate && !validate(v)) continue;
          var score = 0;
          for (var q = 0; q < labels.length; q++) {
            var key = labels[q];
            if (l === key) score = Math.max(score, 3);
            else if (l.indexOf(key) === 0) score = Math.max(score, 2);
            else if (l.indexOf(key) > -1) score = Math.max(score, 1);
          }
          if (score > bestScore) { bestScore = score; best = v; }
        }
        return best;
      };
      var sfHasAny = function (sfPairs, labels) {
        for (var i = 0; i < sfPairs.length; i++) {
          var l = low(sfPairs[i].label);
          for (var q = 0; q < labels.length; q++) if (l.indexOf(labels[q]) > -1) return true;
        }
        return false;
      };
      var hasDate = function (v) { return !!v && /\d/.test(v) && !/\d[\d,\.]*\s*[-–—]\s*\d/.test(v); };

      /* Parse a semicolon/comma-separated "Product(s)" field against the catalog. */
      var parseProductsField = function (str) {
        var outp = [], seen = {};
        if (!str) return outp;
        String(str).split(/[;,\n]/).forEach(function (part) {
          var k = matchKey(part);
          if (k && !seen[k]) { seen[k] = 1; outp.push({ key: k, qty: null, price: null }); }
        });
        return outp;
      };

      /* ---- Assemble the result for this frame ---- */
      var result;
      if (isSalesforce) {
        var SL = cfg.sfLabels || {};
        var sfPairs = buildSfPairs();

        /* Customer = Account Name (never the partner/reseller). */
        var customer = sfFind(sfPairs, SL.account || ['account name', 'account'], SL.accountExclude || ['owner', 'number', 'site', 'type', 'source', 'currency', 'record', 'id', 'status', 'stage', 'parent'], notEmailNum);
        if (!customer && sfEntity() === 'Account') customer = sfHeaderTitle();
        if (!customer) customer = findByLabels(cfg.custLabels, notEmailNum); // generic backstop

        /* Partner/Reseller — Account Name stays the customer even when present. */
        var partnerCompany = sfByLabels(sfPairs, SL.partner || ['partner/reseller', 'reseller', 'partner'], notEmailNum);
        var subscriptionType = sfByLabels(sfPairs, SL.subscriptionType || ['subscription type']);
        var isReseller = !!(subscriptionType && /reseller/i.test(subscriptionType));

        var contact = sfContactRoles();
        var email = contact.email || sfFindEmail(sfPairs) || findEmail();

        /* Renewal-date candidates, kept separate so the panel side can apply the
           precedence rule (License Expiration / End Date > Renewal Month > Close). */
        var renewalDates = {
          licenseExpiration: sfByLabels(sfPairs, SL.dateLicenseExpiration || ['license expiration date'], hasDate),
          endDate: sfByLabels(sfPairs, SL.dateEnd || ['end date'], hasDate),
          renewalMonth: sfByLabels(sfPairs, SL.dateRenewalMonth || ['renewal month date', 'renewal date'], hasDate),
          closeDate: sfByLabels(sfPairs, SL.dateClose || ['close date'], hasDate),
        };
        var renewalDateRaw = renewalDates.licenseExpiration || renewalDates.endDate || renewalDates.renewalMonth || renewalDates.closeDate || null;
        var quoteExpirationRaw = sfByLabels(sfPairs, SL.quoteExpiration || ['quote expiration date'], hasDate);

        var termMonths = parseTermMonths(sfByLabels(sfPairs, SL.term || ['subscription term']));
        var arrUpForRenewal = parseMoney(sfByLabels(sfPairs, SL.arrUpForRenewal || ['arr up for renewal']));

        var tbl = sfProductTables();
        if (termMonths == null) termMonths = tbl.term; // new-business grids carry the term

        /* Products: related-list lines first; if none, the semicolon Product(s) field. */
        var productsField = sfByLabels(sfPairs, SL.products || ['product(s)', 'products']);
        var products = tbl.products;
        if ((!products || !products.length) && productsField) products = parseProductsField(productsField);

        /* Quantity candidates by source (never Endpoint Tier — it's a range). */
        var qtyPanel = parseQty(sfByLabels(sfPairs, SL.qtyPanel || ['quantity', 'qty']));
        var qtyProduct = null;
        for (var pi = 0; pi < (tbl.products || []).length; pi++) { if (tbl.products[pi].qty != null) { qtyProduct = tbl.products[pi].qty; break; } }
        var qtyDevice = parseQty(sfByLabels(sfPairs, SL.qtyDevice || ['current device count', 'maximum device count']));

        var recordType = sfByLabels(sfPairs, SL.recordType || ['opportunity record type']);
        var renewalsSeen = sfHasAny(sfPairs, SL.renewalMarkers || ['arr up for renewal', 'renewal month date', 'license expiration date']);
        var subscriptionSeen = sfHasAny(sfPairs, SL.subscriptionMarkers || ['subscription term', 'subscription type', 'billing frequency']);
        var isRenewal = /renewal/i.test(recordType || '') || isReseller || renewalsSeen || subscriptionSeen || /renew/i.test(document.title || '');

        result = {
          source: 'salesforce',
          title: document.title || '',
          url: location.href || '',
          isRenewal: isRenewal,
          customer: customer,
          partnerCompany: partnerCompany || null,
          billTo: partnerCompany || null, // legacy alias (older merge/snapshot paths)
          subscriptionType: subscriptionType || null,
          email: email,
          contactName: contact.name || null,
          contactPhone: contact.phone || null,
          renewalDates: renewalDates,
          renewalDateRaw: renewalDateRaw,
          quoteExpirationRaw: quoteExpirationRaw || null,
          qty: { panel: qtyPanel, product: qtyProduct, device: qtyDevice },
          termMonths: termMonths,
          arrUpForRenewal: arrUpForRenewal,
          products: products,
          productsField: productsField || null,
          qtyValues: [],
          productsSeen: tbl.sawTable || (products && products.length > 0),
          sectionsSeen: { products: tbl.sawTable, renewals: renewalsSeen, subscription: subscriptionSeen },
        };
      } else {
        result = {
          source: 'generic',
          title: document.title || '',
          url: location.href || '',
          customer: findByLabels(cfg.custLabels, notEmailNum),
          billTo: findByLabels(cfg.billLabels, notEmailNum),
          email: findEmail(),
          renewalDateRaw: findByLabels(cfg.dateLabels, function (v) { return /\d/.test(v); }),
          products: genericProducts(),
          qtyValues: genericQtyValues(),
          productsSeen: true,
        };
      }

      var q = result.qty || {};
      var anyQty = (q.panel != null || q.product != null || q.device != null) ? 1 : 0;
      result.matchCount =
        (result.customer ? 1 : 0) + (result.partnerCompany || result.billTo ? 1 : 0) + (result.email ? 1 : 0) +
        (result.renewalDateRaw ? 1 : 0) + (result.products ? result.products.length : 0) +
        (result.qtyValues ? result.qtyValues.length : 0) + anyQty +
        (result.termMonths ? 1 : 0) + (result.contactName ? 1 : 0);
      return result;
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  /* =========================================================================
     Rich page snapshot for the AI path — runs INSIDE the page via
     chrome.scripting.executeScript (allFrames: true). Fully self-contained and
     ASYNC: it returns a Promise that executeScript awaits.

     Salesforce lightning-datatables VIRTUALIZE rows (only scrolled-into-view
     rows exist in the DOM), so before reading the DOM this runs a BOUNDED
     auto-scroll pass — it finds the main record scroll container and every
     scrollable related-list container, scrolls each to the bottom in steps
     (pausing ~200ms per step for rows to render), then captures, then scrolls
     everything back to the top. The pass is hard-capped at ~12 steps / ~3s per
     frame and fully wrapped in try/catch, so it can never hang or throw — on any
     failure it just captures whatever is already rendered.

     Capture walks the DOM *including every element.shadowRoot* (Lightning
     renders most values inside SHADOW DOM, which document.body.innerText can't
     see), collecting: visible record text, label→value pairs (lightning-
     formatted-* / dt-dd / classic labelCol), and every related-list table
     (role="grid" / <table>) with its column headers + row cells. Nav / header /
     footer / menu chrome is skipped. Read-only; nothing is sent from here — the
     panel side POSTs the merged result. Returns { record, tables, fields }
     strings for this frame.
     ========================================================================= */
  async function snapshotPage() {
    var sleep = function (ms) { return new Promise(function (res) { setTimeout(res, ms); }); };

    /* Find the main record scroll container plus every scrollable related-list
       container: elements taller than their viewport (scrollHeight > clientHeight)
       with a scrolling overflow. Walks shadow roots too, bounded by a node cap. */
    var findScrollers = function () {
      var out = [], visited = 0;
      var scrollable = function (el) {
        try {
          if (!el || el.nodeType !== 1) return false;
          var ch = el.clientHeight;
          if (ch < 40 || (el.scrollHeight - ch) < 40) return false;
          var view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
          var oy = view.getComputedStyle(el).overflowY;
          return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
        } catch (e) { return false; }
      };
      var walkS = function (root, depth) {
        if (depth > 40 || visited > 9000) return;
        var els;
        try { els = root.querySelectorAll('*'); } catch (e) { return; }
        for (var i = 0; i < els.length && visited < 9000; i++) {
          visited++;
          var el = els[i];
          if (scrollable(el)) out.push(el);
          if (el.shadowRoot) walkS(el.shadowRoot, depth + 1);
        }
      };
      try { walkS(document, 0); } catch (e) {}
      var doc = document.scrollingElement || document.documentElement;
      if (doc && (doc.scrollHeight - doc.clientHeight) > 40 && out.indexOf(doc) < 0) out.push(doc);
      // Largest scroll distance first; bound how many containers we drive.
      out.sort(function (a, b) { return (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight); });
      return out.slice(0, 30);
    };

    /* Capture — reads the DOM exactly as before. Its own try/catch means a
       capture failure never rejects the returned Promise. */
    var capture = function () {
      try {
        var norm = function (s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); };
        var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, SVG: 1, PATH: 1, IFRAME: 1, LINK: 1, META: 1, IMG: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1 };
        var SKIP_ROLE = { navigation: 1, banner: 1, menu: 1, menubar: 1, menuitem: 1, toolbar: 1, tablist: 1, tab: 1, search: 1, contentinfo: 1, complementary: 1 };

        var isChrome = function (el) {
          var tag = el.tagName;
          if (tag === 'NAV' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'ASIDE') return true;
          try {
            if (el.getAttribute) {
              var r = (el.getAttribute('role') || '').toLowerCase();
              if (SKIP_ROLE[r]) return true;
              if (el.getAttribute('aria-hidden') === 'true') return true;
            }
          } catch (e) {}
          return false;
        };
        var isGrid = function (el) {
          if (el.tagName === 'TABLE') return true;
          try {
            var r = (el.getAttribute && (el.getAttribute('role') || '') || '').toLowerCase();
            return r === 'grid' || r === 'table' || r === 'treegrid';
          } catch (e) { return false; }
        };

        /* Salesforce detection (same markers the rule-based extractor uses). */
        var isSf = false;
        try {
          isSf = !!(document.querySelector('.slds-form-element__label, .test-id__field-label, one-record-home-flexipage2, records-record-layout-item, force-record-layout-section, .slds-page-header, td.labelCol'))
            || /(lightning\.force\.com|my\.salesforce\.com|salesforce\.com|force\.com|visualforce\.com)/i.test((location && location.hostname) || '');
        } catch (e) { isSf = false; }

        /* Section priority + noise, from the two real Opportunity pages. Noise
           sections (Stage / Field History, System Information, Activity, Chatter,
           Feed, Notes, Files) drown the signal and are excluded entirely. */
        var NOISE_RX = /stage history|field history|system information|activity|chatter|feed|notes|files|news history/i;
        var priorityOf = function (title) {
          var t = String(title).toLowerCase();
          if (/quote information/.test(t)) return 0;
          if (/renewal/.test(t)) return 1;
          if (/subscription/.test(t)) return 2;
          if (/product/.test(t)) return 3;
          if (/opportunity information|opportunity detail/.test(t)) return 4;
          if (/contact role|contacts/.test(t)) return 5;
          if (/account detail|account information/.test(t)) return 6;
          return 8;
        };
        var isSectionContainer = function (el) {
          try {
            var tag = el.tagName || '';
            if (tag === 'ARTICLE' || tag === 'RECORDS-RECORD-LAYOUT-SECTION' || tag === 'FORCE-RELATED-LIST-CARD' || tag === 'FLEXIPAGE-COMPONENT2') return true;
            var cls = (el.className && String(el.className)) || '';
            return /slds-card|forcePageBlockSection|forcePageBlock\b|cardContainer|slds-section/i.test(cls);
          } catch (e) { return false; }
        };
        var sectionTitleOf = function (el) {
          try {
            if (!el.querySelector) return '';
            var te = el.querySelector('.slds-card__header-title, .test-id__section-header-title, .slds-section__title, [class*="section-title"], [class*="cardTitle"], legend, h1, h2, h3');
            if (te) { var t = norm(te.textContent); if (t && t.length <= 60) return t; }
          } catch (e) {}
          return '';
        };

        var recordParts = [], tableParts = [], fieldParts = [];
        var seen = {}, seenCount = 0, recordChars = 0;
        var RECORD_CAP = 24000;

        // Named-section buckets (Salesforce) + global field dedup.
        var sections = {}, sectionOrder = [], curSection = 'Other', seenField = {};
        var noteSection = function (title) {
          if (!sections[title]) { sections[title] = { fields: [], tables: [], priority: priorityOf(title) }; sectionOrder.push(title); }
          curSection = title;
        };

        var pushText = function (t) {
          t = norm(t);
          if (!t || t.length < 2) return;
          if (t.length > 400) t = t.slice(0, 400);
          if (recordChars > RECORD_CAP) return;
          if (seenCount < 6000) { if (seen[t]) return; seen[t] = 1; seenCount++; }
          recordParts.push(t); recordChars += t.length + 1;
        };

        var addField = function (label, val) {
          label = norm(label).replace(/\s*[:：]\s*$/, ''); val = norm(val);
          if (!(label && val && label !== val && label.length <= 60 && val.length <= 300)) return;
          var line = label + ': ' + val;
          if (seenField[line]) return; // dedup repeated label→value pairs across panels/frames
          seenField[line] = 1;
          if (fieldParts.length <= 400) fieldParts.push(line);
          if (isSf && sections[curSection]) sections[curSection].fields.push(line);
        };

        var cellText = function (cell) {
          try {
            var a = cell.querySelector ? cell.querySelector('a[title], a, [title]') : null;
            if (a) { var tt = a.getAttribute && a.getAttribute('title'); if (tt) return norm(tt); var lt = norm(a.textContent); if (lt) return lt; }
            var ct = cell.getAttribute && cell.getAttribute('title'); if (ct) return norm(ct);
          } catch (e) {}
          return norm(cell.textContent);
        };

        var dumpGrid = function (g) {
          try {
            if (tableParts.length > 40) return;
            var lines = [];
            var headCells = g.querySelectorAll('thead th, thead td, [role="columnheader"]');
            var headers = [];
            for (var i = 0; i < headCells.length; i++) {
              var ht = norm((headCells[i].getAttribute && headCells[i].getAttribute('title')) ? headCells[i].getAttribute('title') : headCells[i].textContent);
              if (ht) headers.push(ht);
            }
            if (headers.length) lines.push(headers.join(' | '));
            var rows = g.querySelectorAll('tbody tr, [role="row"]');
            if (!rows.length) rows = g.querySelectorAll('tr');
            var count = 0;
            for (var r = 0; r < rows.length && count < 60; r++) {
              var cells = rows[r].querySelectorAll('th, td, [role="gridcell"], [role="cell"], [role="rowheader"]');
              if (!cells.length) continue;
              var vals = [];
              for (var c = 0; c < cells.length; c++) vals.push(cellText(cells[c])); // prefer link/title over truncated cell text
              var joined = vals.join(' | ');
              if (norm(joined.replace(/\|/g, ''))) { lines.push(joined); count++; }
            }
            if (lines.length > (headers.length ? 1 : 0)) {
              var block = lines.join('\n');
              tableParts.push(block);
              if (isSf && sections[curSection]) sections[curSection].tables.push(block);
            }
          } catch (e) {}
        };

        var walk = function (node, depth) {
          if (depth > 60) return;
          var cn = node.childNodes;
          if (!cn) return;
          for (var i = 0; i < cn.length; i++) {
            var ch = cn[i];
            if (ch.nodeType === 3) { pushText(ch.nodeValue); continue; }
            if (ch.nodeType !== 1) continue;
            var el = ch;
            if (SKIP_TAGS[el.tagName]) continue;
            if (isChrome(el)) continue;
            // Salesforce: exclude noise sections entirely; tag other sections so
            // the payload can be assembled in priority order.
            var prevSection = curSection;
            if (isSf && isSectionContainer(el)) {
              var title = sectionTitleOf(el);
              if (title) {
                if (NOISE_RX.test(title)) continue; // skip the whole subtree
                noteSection(title);
              }
            }
            if (isGrid(el)) { dumpGrid(el); if (el.shadowRoot) dumpGrid(el.shadowRoot); curSection = prevSection; continue; }
            try {
              if (el.classList && (el.classList.contains('slds-form-element__label') || el.classList.contains('test-id__field-label'))) {
                var container = el.closest ? el.closest('.slds-form-element') : null;
                var v = '';
                if (container) {
                  var ve = container.querySelector('lightning-formatted-text, lightning-formatted-email, lightning-formatted-url, lightning-formatted-number, lightning-formatted-date-time, .test-id__field-value, .slds-form-element__static, .uiOutputText, [data-output-element-id]');
                  if (ve) v = norm(ve.textContent);
                  if (!v) { var vc = container.querySelector('.slds-form-element__control'); if (vc) v = norm(vc.textContent); }
                }
                if (v) addField(el.textContent, v);
              }
              if (el.tagName === 'DT') { var dd = el.nextElementSibling; if (dd && dd.tagName === 'DD') addField(el.textContent, dd.textContent); }
              if (el.classList && el.classList.contains('labelCol')) {
                var dc = el.nextElementSibling;
                while (dc && !(dc.className && /\bdataCol\b/.test(String(dc.className)))) dc = dc.nextElementSibling;
                if (dc) addField(el.textContent, dc.textContent);
              }
            } catch (e) {}
            if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
            walk(el, depth + 1);
            curSection = prevSection; // leaving this container
          }
        };

        if (document.body) walk(document.body, 0);
        else if (document.documentElement) walk(document.documentElement, 0);

        var head = [];
        if (document.title) head.push('Title: ' + norm(document.title));
        if (typeof location !== 'undefined' && location.href) head.push('URL: ' + location.href);

        // Assemble the prioritized, section-ordered payload (Salesforce only).
        var prioritized = '';
        if (isSf && sectionOrder.length) {
          var ordered = sectionOrder.slice().sort(function (a, b) { return sections[a].priority - sections[b].priority; });
          var blocks = [];
          for (var so = 0; so < ordered.length; so++) {
            var name = ordered[so], sec = sections[name];
            if (!sec.fields.length && !sec.tables.length) continue;
            var body = sec.fields.join('\n');
            if (sec.tables.length) body += (body ? '\n' : '') + sec.tables.join('\n');
            blocks.push('== ' + name.toUpperCase() + ' ==\n' + body);
          }
          prioritized = blocks.join('\n\n');
        }

        return {
          record: recordParts.join('\n'),
          tables: tableParts.join('\n\n'),
          fields: head.concat(fieldParts).join('\n'),
          prioritized: prioritized,
          source: isSf ? 'salesforce' : 'generic',
          url: (typeof location !== 'undefined' && location.href) || '',
        };
      } catch (e) {
        return { record: '', tables: '', fields: '', prioritized: '', error: String((e && e.message) || e) };
      }
    };

    /* ---- bounded auto-scroll pass (renders lazy / virtualized rows) ----
       Hard-capped at ~12 steps OR ~3s per frame, whichever comes first, so it
       can never hang. Wrapped in try/catch so scrolling never throws — on any
       failure we fall straight through to capturing what's already there. */
    var scrollers = [];
    try {
      scrollers = findScrollers();
      var STEP_MS = 200, MAX_STEPS = 12, MAX_MS = 3000, start = Date.now();
      for (var step = 0; step < MAX_STEPS && scrollers.length; step++) {
        if (Date.now() - start > MAX_MS) break;
        var moved = false;
        for (var s = 0; s < scrollers.length; s++) {
          var el = scrollers[s];
          try {
            var max = el.scrollHeight - el.clientHeight;
            var before = el.scrollTop;
            if (before < max - 1) {
              el.scrollTop = Math.min(max, before + Math.max(200, el.clientHeight));
              if (el.scrollTop > before) moved = true;
            }
          } catch (e) {}
        }
        if (!moved) break; // every container already at the bottom
        await sleep(STEP_MS);
      }
    } catch (e) { /* scrolling must never throw — capture what's there */ }

    var snap = capture();

    // Restore scroll position so the page looks untouched.
    try {
      scrollers.forEach(function (el) { try { el.scrollTop = 0; } catch (e) {} });
      try { window.scrollTo(0, 0); } catch (e) {}
    } catch (e) {}

    return snap;
  }

  /* =========================================================================
     Panel side — merge frames, then turn the raw extraction into findings.
     ========================================================================= */
  function normS(s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); }

  /* Merge per-frame results, preferring the frame with the most matches; fill
     any gaps from the remaining frames (handles Classic-in-Lightning iframes). */
  function mergeFrames(frames) {
    var ok = (frames || []).filter(function (f) { return f && !f.error; });
    if (!ok.length) return null;
    ok.sort(function (a, b) { return (b.matchCount || 0) - (a.matchCount || 0); });
    var base = Object.assign({}, ok[0]);
    for (var i = 1; i < ok.length; i++) {
      var f = ok[i];
      ['customer', 'billTo', 'partnerCompany', 'subscriptionType', 'email', 'contactName', 'contactPhone',
        'renewalDateRaw', 'quoteExpirationRaw', 'productsField', 'termMonths', 'arrUpForRenewal'].forEach(function (k) {
        if (!base[k] && f[k]) base[k] = f[k];
      });
      if (f.isRenewal) base.isRenewal = true;
      // Merge renewal-date candidates label-by-label so the strongest one survives.
      if (f.renewalDates) {
        base.renewalDates = base.renewalDates || {};
        ['licenseExpiration', 'endDate', 'renewalMonth', 'closeDate'].forEach(function (k) {
          if (!base.renewalDates[k] && f.renewalDates[k]) base.renewalDates[k] = f.renewalDates[k];
        });
      }
      // Merge quantity candidates by source, preferring the higher-priority source.
      if (f.qty) {
        base.qty = base.qty || { panel: null, product: null, device: null };
        ['panel', 'product', 'device'].forEach(function (k) {
          if (base.qty[k] == null && f.qty[k] != null) base.qty[k] = f.qty[k];
        });
      }
      if (f.sectionsSeen) {
        base.sectionsSeen = base.sectionsSeen || {};
        ['products', 'renewals', 'subscription'].forEach(function (k) {
          if (f.sectionsSeen[k]) base.sectionsSeen[k] = true;
        });
      }
      if ((!base.products || !base.products.length) && f.products && f.products.length) base.products = f.products;
      if (f.qtyValues && f.qtyValues.length) base.qtyValues = (base.qtyValues || []).concat(f.qtyValues);
      if (f.source === 'salesforce') base.source = 'salesforce';
      if (f.productsSeen) base.productsSeen = true;
    }
    return base;
  }

  function parseDate(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    var months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    var iso = function (y, mo, dd) {
      if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || y < 1970 || y > 2100) return null;
      var p = function (v) { return String(v).length < 2 ? '0' + v : '' + v; };
      return y + '-' + p(mo) + '-' + p(dd);
    };
    var m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = s.match(/\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})\b/);
    if (m) { var y = +m[3]; if (y < 100) y += 2000; return iso(y, +m[1], +m[2]); }
    m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
    if (m) { var mo = months[m[1].slice(0, 3).toLowerCase()]; if (mo) return iso(+m[3], mo, +m[2]); }
    m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
    if (m) { var mo2 = months[m[2].slice(0, 3).toLowerCase()]; if (mo2) return iso(+m[3], mo2, +m[1]); }
    return null;
  }

  function fmtDate(isoStr) {
    var d = new Date(isoStr + 'T00:00:00');
    return isNaN(d) ? isoStr : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function unitWord(prod) { return prod.unit === 'user' ? 'users' : 'endpoints'; }

  /* Tolerant catalog resolver. The AI sometimes returns a product's NAME (e.g.
     "Application Workspace") where the schema asks for its id ("aw"); a strict
     id-only match silently dropped those lines. Resolve a returned reference to
     the live catalog product by, in order:
       1. exact id match (case-insensitive), else
       2. exact name match (case-insensitive), else
       3. partial name match (catalog name contains ref, or ref contains catalog
          name), else
       4. null.
     Used everywhere a returned productId is matched so a line reliably fills. */
  function resolveCatalogProduct(ref) {
    var products = (state.cfg && state.cfg.products) || [];
    var r = normS(ref).toLowerCase();
    if (!r) return null;
    var byId = products.find(function (p) { return String(p.id).toLowerCase() === r; });
    if (byId) return byId;
    var byName = products.find(function (p) { return normS(p.name).toLowerCase() === r; });
    if (byName) return byName;
    return products.find(function (p) {
      var name = normS(p.name).toLowerCase();
      return name && (name.indexOf(r) > -1 || r.indexOf(name) > -1);
    }) || null;
  }

  function resolveProducts(products, qtyValues) {
    var byKey = {};
    (products || []).forEach(function (p) {
      if (!p || !p.key) return;
      var cur = byKey[p.key] || { key: p.key, qty: null, price: null };
      if (p.qty != null && cur.qty == null) cur.qty = p.qty;
      if (p.price != null && cur.price == null) cur.price = p.price;
      byKey[p.key] = cur;
    });
    var list = Object.keys(byKey).map(function (k) { return byKey[k]; });
    var qv = (qtyValues || []).filter(function (x) { return typeof x === 'number' && x > 0; });
    if (list.length === 1 && list[0].qty == null && qv.length === 1) list[0].qty = qv[0];
    return list;
  }

  function scalarFinding(field, label, value, display, current) {
    var cur = normS(current);
    return {
      field: field, value: value, checked: true, label: label,
      display: display || value,
      replaces: (cur && cur !== normS(value)) ? String(current) : null,
    };
  }

  /* Renewal-date precedence (Task 3): License Expiration / End Date beat Renewal
     Month Date, which beats Close Date. Close Date is a sales forecast, so it's
     only used as a last resort and the finding says so. Generic pages (no candidate
     map) fall through to raw.renewalDateRaw. Returns { iso, fromClose } or null. */
  function pickRenewalDate(raw) {
    var d = (raw && raw.renewalDates) || {};
    var order = [
      { v: d.licenseExpiration, close: false }, { v: d.endDate, close: false },
      { v: d.renewalMonth, close: false }, { v: d.closeDate, close: true },
      { v: raw && raw.renewalDateRaw, close: false },
    ];
    for (var i = 0; i < order.length; i++) {
      var iso = parseDate(order[i].v);
      if (iso) return { iso: iso, fromClose: order[i].close };
    }
    return null;
  }

  /* Quantity precedence (Task 3): Renewals/Subscription panel > Products
     related-list > Account Current Device Count. Never Endpoint Tier. */
  function primaryQty(raw) {
    var q = raw && raw.qty;
    if (!q) return null;
    if (q.panel != null) return q.panel;
    if (q.product != null) return q.product;
    if (q.device != null) return q.device;
    return null;
  }

  function buildFindings(raw) {
    var q = state.quote, cfg = state.cfg, out = [];
    if (!raw) return out;

    if (raw.customer) out.push(scalarFinding('customer', 'Customer / company', raw.customer, raw.customer, q.customer));
    if (raw.email) out.push(scalarFinding('email', 'Contact email', raw.email, raw.email, q.email));

    // Account Name stays the customer; the reseller/partner is a separate company.
    var partner = raw.partnerCompany || raw.billTo;
    if (partner && (!raw.customer || normS(partner) !== normS(raw.customer))) {
      out.push(scalarFinding('partnerCompany', 'Reseller / partner company', partner, partner, q.partnerCompany));
    }

    var rd = pickRenewalDate(raw);
    if (rd) {
      var label = rd.fromClose ? "Customer's renewal date (from Close Date — sales forecast)" : "Customer's renewal date";
      var f = scalarFinding('coTermDate', label, rd.iso, fmtDate(rd.iso), q.coTermDate);
      if (f.replaces) f.replaces = fmtDate(q.coTermDate);
      out.push(f);
    }

    // Subscription term (Salesforce decimal "12.000000000000" → 12 months).
    var tm = parseInt(raw.termMonths, 10);
    if (isFinite(tm) && tm > 0) {
      var yrs = Math.max(1, Math.round(tm / 12));
      out.push({
        field: 'term', months: tm, years: yrs, checked: true, label: 'Subscription term',
        display: tm + ' month' + (tm === 1 ? '' : 's') + ' (' + yrs + ' year' + (yrs === 1 ? '' : 's') + ')',
        replaces: (q.months && q.months !== tm) ? (q.months + ' months') : null,
      });
    }

    // Feed the precedence-chosen quantity into the resolver so a single product
    // with no line quantity (a renewal from the Product(s) field) still fills.
    var qvals = [];
    var pq = primaryQty(raw);
    if (pq != null) qvals.push(pq);
    if (raw.qtyValues) qvals = qvals.concat(raw.qtyValues);

    var isRen = !!raw.isRenewal;
    var resolved = resolveProducts(raw.products, qvals);
    resolved.forEach(function (p) {
      var prod = cfg.products.find(function (x) { return x.id === p.key; });
      if (!prod) return;
      // On a renewal, "ARR up for Renewal" is what the customer pays today; use it
      // as the current renewal-line price when the single line has no price of its own.
      var price = p.price;
      if (isRen && price == null && raw.arrUpForRenewal != null && resolved.length === 1) price = raw.arrUpForRenewal;
      if (price != null) {
        var curR = (q.renewLines || []).find(function (l) { return l.productId === prod.id; });
        var parts = [];
        if (p.qty != null) parts.push(int(p.qty).toLocaleString('en-US') + ' ' + unitWord(prod));
        parts.push(fmt(price) + '/yr');
        out.push({
          field: 'renewLine', productId: prod.id, qty: p.qty, price: price, checked: true,
          label: prod.name + ' — renewal', display: parts.join(' · '),
          replaces: curR ? ((curR.qty ? int(curR.qty).toLocaleString('en-US') + ' · ' : '') + fmt(Math.max(0, +curR.price || 0)) + '/yr') : null,
        });
      } else if (p.qty != null) {
        var curL = q.lines.find(function (l) { return l.productId === prod.id; });
        out.push({
          field: 'lineQty', productId: prod.id, qty: p.qty, checked: true,
          label: prod.name + ' — quantity', display: int(p.qty).toLocaleString('en-US') + ' ' + unitWord(prod),
          replaces: curL ? int(curL.qty).toLocaleString('en-US') + ' ' + unitWord(prod) : null,
        });
      }
    });

    return out;
  }

  /* =========================================================================
     AI path — assemble the request text and map the response into findings.
     ========================================================================= */

  /* Rough section priority for a single "Label: value" line, so that on
     Salesforce the highest-value fields survive the payload cap even when the
     in-page section grouping isn't available. Lower = more important. */
  function fieldRank(line) {
    var t = String(line).toLowerCase();
    if (/^(created by|last modified|deployment type|commission pool)\b/.test(t) || /stage history|field history|system information/.test(t)) return 90;
    if (/quote|total price|volume discount|real discount|discount from list|amended terms|purchase order|primary quote|total real list/.test(t)) return 0;
    if (/renewal|arr up for renewal|license expiration|renewal month|renewal arr|tcv up for renewal|net change|contraction|\bmrr\b|days to close/.test(t)) return 1;
    if (/subscription term|subscription type|billing frequency|license start|start date|end date|contract|\bquantity\b|product\(s\)/.test(t)) return 2;
    if (/opportunity|forecast|\bstage\b|close date|\bamount\b|price book|partner\/reseller|reseller|primary contact|owner|expansion/.test(t)) return 4;
    if (/contact|email|phone|\brole\b|primary/.test(t)) return 5;
    if (/account name|industry|website|support plan|endpoint tier|current device count/.test(t)) return 6;
    return 7;
  }
  function rankFieldLines(text) {
    var lines = String(text).split('\n').filter(function (l) { return l.trim(); });
    return lines
      .map(function (l, i) { return { l: l, i: i, r: (/^(title:|url:|==)/i.test(l.trim()) ? -1 : fieldRank(l)) }; })
      .sort(function (a, b) { return a.r - b.r || a.i - b.i; })
      .map(function (x) { return x.l; })
      .join('\n');
  }
  /* Drop repeated Label: value lines (across panels and frames); keep headers. */
  function dedupePairLines(text) {
    var seen = {}, out = [];
    String(text).split('\n').forEach(function (l) {
      var t = l.trim();
      var isHeader = !t || /^(==|##|source:|url:|title:)/i.test(t);
      if (!isHeader && t.indexOf(':') > -1) { if (seen[t]) return; seen[t] = 1; }
      out.push(l);
    });
    return out.join('\n');
  }

  /* Merge the per-frame snapshots into one text blob, then fold in the rule-based
     extraction (belt and suspenders) so the AI gets the richest possible input.
     On Salesforce the payload is PRIORITIZED — a SOURCE line, the page URL, the
     rule-based DETECTED summary, then the in-page section-ordered capture (Quote
     Information / Renewals / Subscription / Products / … with noise excluded) —
     and only THEN capped at ~24000 chars, so high-value sections are never the
     ones truncated. Non-Salesforce pages keep the original structure. */
  function buildSnapshotText(snaps, rawRule) {
    var ok = (snaps || []).filter(function (s) { return s && !s.error; });
    var CAP = 24000;
    var isSf = !!(rawRule && rawRule.source === 'salesforce') || ok.some(function (s) { return s.source === 'salesforce' || s.prioritized; });
    var url = (rawRule && rawRule.url) || '';
    var prioritized = [], fields = [], tables = [], record = [];
    ok.forEach(function (s) {
      if (!url && s.url) url = s.url;
      if (s.prioritized) prioritized.push(s.prioritized);
      if (s.fields) fields.push(s.fields);
      if (s.tables) tables.push(s.tables);
      if (s.record) record.push(s.record);
    });

    var ruleLines = [];
    if (rawRule) {
      if (rawRule.customer) ruleLines.push('Account/Customer: ' + rawRule.customer);
      var partner = rawRule.partnerCompany || rawRule.billTo;
      if (partner) ruleLines.push('Partner/Reseller: ' + partner);
      if (rawRule.subscriptionType) ruleLines.push('Subscription Type: ' + rawRule.subscriptionType);
      if (rawRule.isRenewal) ruleLines.push('Opportunity Type: Renewal');
      if (rawRule.contactName) ruleLines.push('Primary Contact: ' + rawRule.contactName);
      if (rawRule.email) ruleLines.push('Contact Email: ' + rawRule.email);
      if (rawRule.contactPhone) ruleLines.push('Contact Phone: ' + rawRule.contactPhone);
      var rd = rawRule.renewalDates || {};
      if (rd.licenseExpiration) ruleLines.push('License Expiration Date: ' + rd.licenseExpiration);
      if (rd.endDate) ruleLines.push('End Date: ' + rd.endDate);
      if (rd.renewalMonth) ruleLines.push('Renewal Month Date: ' + rd.renewalMonth);
      if (rd.closeDate) ruleLines.push('Close Date (sales forecast, not the renewal date): ' + rd.closeDate);
      if (!rawRule.renewalDates && rawRule.renewalDateRaw) ruleLines.push('Renewal/End Date: ' + rawRule.renewalDateRaw);
      if (rawRule.termMonths) ruleLines.push('Subscription Term (months): ' + rawRule.termMonths);
      if (rawRule.arrUpForRenewal != null) ruleLines.push('ARR up for Renewal: ' + rawRule.arrUpForRenewal);
      var pq = rawRule.qty ? (rawRule.qty.panel != null ? rawRule.qty.panel : (rawRule.qty.product != null ? rawRule.qty.product : rawRule.qty.device)) : null;
      if (pq != null) ruleLines.push('Quantity: ' + pq);
      if (rawRule.productsField) ruleLines.push('Product(s) field: ' + rawRule.productsField);
      (rawRule.products || []).forEach(function (p) {
        if (!p || !p.key) return;
        var prod = state.cfg.products.find(function (x) { return x.id === p.key; });
        ruleLines.push('Product: ' + (prod ? prod.name : p.key) + (p.qty != null ? ' · qty ' + p.qty : '') + (p.price != null ? ' · $' + p.price : ''));
      });
    }

    var parts = [];
    if (isSf) {
      var head = 'SOURCE: Salesforce Opportunity record';
      if (url) head += '\nURL: ' + url;
      parts.push(head);
      if (ruleLines.length) parts.push('== DETECTED (rule-based) ==\n' + ruleLines.join('\n'));
      if (prioritized.length) parts.push(prioritized.join('\n\n'));
      else if (fields.length) parts.push('== FIELDS ==\n' + rankFieldLines(fields.join('\n')));
      if (tables.length) parts.push('== RELATED LISTS ==\n' + tables.join('\n\n'));
      if (record.length) parts.push('== PAGE TEXT ==\n' + record.join('\n'));
    } else {
      if (url) parts.push('URL: ' + url);
      if (fields.length) parts.push('== FIELDS ==\n' + fields.join('\n'));
      if (tables.length) parts.push('== RELATED LISTS ==\n' + tables.join('\n\n'));
      if (ruleLines.length) parts.push('== DETECTED (rule-based) ==\n' + ruleLines.join('\n'));
      if (record.length) parts.push('== PAGE TEXT ==\n' + record.join('\n'));
    }
    var text = dedupePairLines(parts.join('\n\n'));
    if (text.length > CAP) text = text.slice(0, CAP);
    return text;
  }

  /* Turn the Apps Script's structured response into review-card findings.
     Every returned field maps to a finding so the user previews it before Apply;
     nothing is written here. Returns { findings, note }. */
  function buildAiFindings(data) {
    var out = [], note = null;
    if (!data || typeof data !== 'object') return { findings: out, note: note };
    var q = state.quote;
    var S = function (x) { return (x == null ? '' : String(x)).replace(/\s+/g, ' ').trim(); };

    if (S(data.customer)) out.push(scalarFinding('customer', 'Customer / company', S(data.customer), S(data.customer), q.customer));
    if (S(data.contactName)) out.push(scalarFinding('billingContact', 'Billing contact', S(data.contactName), S(data.contactName), q.billingContact));
    if (S(data.email)) out.push(scalarFinding('email', 'Contact email', S(data.email), S(data.email), q.email));
    if (S(data.partnerCompany)) {
      out.push(scalarFinding('partnerCompany', 'Reseller / partner company', S(data.partnerCompany), S(data.partnerCompany), q.partnerCompany));
      note = 'Reseller detected — turn on Partner pricing in “Who’s it for?” if this should be a partner deal (left off because it changes pricing).';
    }
    if (S(data.partnerEmail)) out.push(scalarFinding('partnerEmail', 'Reseller / partner email', S(data.partnerEmail), S(data.partnerEmail), q.partnerEmail));
    if (S(data.billToAddress)) out.push(scalarFinding('billToAddress', 'Bill-to address', S(data.billToAddress), S(data.billToAddress), q.billToAddress));
    if (S(data.shipToAddress)) out.push(scalarFinding('shipToAddress', 'Ship-to address', S(data.shipToAddress), S(data.shipToAddress), q.shipToAddress));

    var iso = parseDate(S(data.quoteExpirationDate));
    if (iso) {
      var f = scalarFinding('expires', 'Quote expiration date', iso, fmtDate(iso), q.expires);
      if (f.replaces) f.replaces = q.expires ? fmtDate(q.expires) : f.replaces;
      out.push(f);
    }
    if (S(data.currency)) out.push(scalarFinding('currency', 'Currency', S(data.currency), S(data.currency), q.currency));

    // Renewal date (the customer's renewal / co-term date) — the server returns it
    // already resolved by the precedence rules; map it to the same field the
    // rule-based path fills. (data.contactPhone and any other extras it may return
    // are ignored gracefully — there's no quote field for them.)
    var riso = parseDate(S(data.renewalDate));
    if (riso) {
      var rf = scalarFinding('coTermDate', "Customer's renewal date", riso, fmtDate(riso), q.coTermDate);
      if (rf.replaces) rf.replaces = fmtDate(q.coTermDate);
      out.push(rf);
    }

    var tm = parseInt(data.termMonths, 10);
    if (isFinite(tm) && tm > 0) {
      var yrs = Math.max(1, Math.round(tm / 12));
      out.push({
        field: 'term', months: tm, years: yrs, checked: true, label: 'Subscription term',
        display: tm + ' month' + (tm === 1 ? '' : 's') + ' (' + yrs + ' year' + (yrs === 1 ? '' : 's') + ')',
        replaces: (q.months && q.months !== tm) ? (q.months + ' months') : null,
      });
    }

    // Deal / discount / support fields (Task 2). Each is shown as a normal
    // finding in the review card and, on Apply, routed through the SAME state
    // patches the live voice parser uses (see applyFindings — mirrors voice.js
    // buildPatch, including the clamp / max-discount rules). Nothing is written
    // here; findings are only proposed until the user applies.
    var ct = S(data.customerType).toLowerCase();
    if (ct) {
      var ctVal = /new|net.?new/.test(ct) ? 'new' : (/current|existing/.test(ct) ? 'current' : null);
      if (ctVal) out.push({
        field: 'customerType', value: ctVal, checked: true, label: 'Customer type',
        display: ctVal === 'new' ? 'Net new' : 'Current customer',
        replaces: (q.customerType && q.customerType !== ctVal) ? (q.customerType === 'new' ? 'Net new' : 'Current customer') : null,
      });
    }
    var dt = S(data.dealType).toLowerCase().replace(/[^a-z]/g, '');
    if (dt) {
      var dtVal = (dt === 'addonren' || dt === 'addonrenewal' || /addon.*ren/.test(dt)) ? 'addonren'
        : (dt === 'ren' || dt === 'renewal' || dt === 'renew') ? 'ren'
        : (dt === 'addon' || /add.?on/.test(dt)) ? 'addon' : null;
      if (dtVal) out.push({
        field: 'dealType', value: dtVal, checked: true, label: 'Deal type',
        display: (dtVal === 'ren' ? 'Renewal' : dtVal === 'addonren' ? 'Add-on + renewal' : 'Add-on') + ' (current customer)',
        replaces: (q.customerType === 'current' && q.dealType && q.dealType !== dtVal) ? q.dealType : null,
      });
    }
    var ed = parseFloat(data.extraDiscountPct);
    if (isFinite(ed) && ed > 0) out.push({
      field: 'extraPct', value: ed, checked: true, label: 'Extra discount',
      display: ed + '%', replaces: (+q.extraPct > 0 && +q.extraPct !== ed) ? (q.extraPct + '%') : null,
    });
    var pmg = parseFloat(data.partnerMarginPct);
    if (isFinite(pmg) && pmg >= 0) out.push({
      field: 'partnerMargin', value: pmg, checked: true, label: 'Partner margin',
      display: pmg + '% · turns on partner pricing', replaces: null,
    });
    if (data.premiumSupport === true || /^true$/i.test(String(data.premiumSupport))) out.push({
      field: 'premiumSupport', value: true, checked: true, label: 'Premium support', display: 'On', replaces: null,
    });
    else if ((data.premiumSupport === false || /^false$/i.test(String(data.premiumSupport))) && q.supportAll) out.push({
      field: 'premiumSupport', value: false, checked: true, label: 'Premium support', display: 'Off', replaces: 'On',
    });

    (Array.isArray(data.lines) ? data.lines : []).forEach(function (li) {
      if (!li) return;
      // Resolve by id OR name OR partial name (the AI may return either). Fall
      // back to any name-ish field the model used instead of productId.
      var prod = resolveCatalogProduct(li.productId) || resolveCatalogProduct(li.name) || resolveCatalogProduct(li.product);
      if (!prod) return; // drop only if it resolves to nothing …
      var qty = parseInt(li.qty, 10);
      if (!isFinite(qty) || qty <= 0) return; // … or the quantity is missing / <= 0
      var curL = q.lines.find(function (l) { return l.productId === prod.id; });
      out.push({
        field: 'lineQty', productId: prod.id, qty: qty, checked: true,
        label: prod.name + ' — quantity', display: qty.toLocaleString('en-US') + ' ' + unitWord(prod),
        replaces: curL ? int(curL.qty).toLocaleString('en-US') + ' ' + unitWord(prod) : null,
      });
    });

    // Renewal lines (renewal opportunities) — map to the SAME renewLine finding
    // shape the rule-based path produces, so a renewal fills through the AI path
    // too. currentAnnualPrice is what the customer pays today (ARR up for Renewal).
    (Array.isArray(data.renewLines) ? data.renewLines : []).forEach(function (li) {
      if (!li) return;
      var prod = resolveCatalogProduct(li.productId) || resolveCatalogProduct(li.name) || resolveCatalogProduct(li.product);
      if (!prod) return;
      var rqty = parseInt(li.qty, 10);
      var hasQty = isFinite(rqty) && rqty > 0;
      var rawPrice = (li.currentAnnualPrice != null) ? li.currentAnnualPrice : (li.price != null ? li.price : (li.annualPrice != null ? li.annualPrice : null));
      var rprice = (rawPrice == null) ? NaN : parseFloat(String(rawPrice).replace(/[^0-9.\-]/g, ''));
      var hasPrice = isFinite(rprice) && rprice >= 0;
      if (!hasQty && !hasPrice) return;
      var curR = (q.renewLines || []).find(function (l) { return l.productId === prod.id; });
      var parts = [];
      if (hasQty) parts.push(rqty.toLocaleString('en-US') + ' ' + unitWord(prod));
      if (hasPrice) parts.push(fmt(rprice) + '/yr');
      out.push({
        field: 'renewLine', productId: prod.id, qty: hasQty ? rqty : null, price: hasPrice ? rprice : null, checked: true,
        label: prod.name + ' — renewal', display: parts.join(' · ') || prod.name,
        replaces: curR ? ((curR.qty ? int(curR.qty).toLocaleString('en-US') + ' · ' : '') + fmt(Math.max(0, +curR.price || 0)) + '/yr') : null,
      });
    });

    return { findings: out, note: note };
  }

  /* Show the AI findings, then supplement with any rule-based finding the AI
     didn't cover (e.g. a renewal date or renewal prices the AI schema omits) so
     nothing the page offered is dropped. Deduped by target field / product. */
  function mergeAiRule(aiFindings, ruleFindings) {
    var keyOf = function (f) {
      if (f.field === 'lineQty') return 'line:' + f.productId;
      if (f.field === 'renewLine') return 'renew:' + f.productId;
      return 'f:' + f.field;
    };
    var have = {};
    aiFindings.forEach(function (f) { have[keyOf(f)] = 1; });
    var merged = aiFindings.slice();
    (ruleFindings || []).forEach(function (f) { if (!have[keyOf(f)]) { have[keyOf(f)] = 1; merged.push(f); } });
    return merged;
  }

  /* Fill the form from free text (used by the voice / "Speak to fill" feature).
     Runs the SAME advanced AI analysis as "Analyze this page" — the words are
     POSTed to the Apps Script, which routes each spoken value to the right field
     — then shows the results in the review card. Nothing is written until Apply;
     the pricing engine still computes every total. On any failure it just tells
     the user to try again (there's no page to fall back to). */
  function fillFromText(text, sourceLabel) {
    text = (text == null ? '' : String(text)).replace(/\s+/g, ' ').trim();
    if (!text) { flash('Nothing to fill in — try again', 'warn'); return; }
    if (!(window.SQG_SHEETS && typeof window.SQG_SHEETS.analyzePage === 'function')) {
      flash('Voice fill needs a connection — try again', 'warn');
      return;
    }
    var catalog = state.cfg.products.map(function (p) { return { id: p.id, name: p.name, unit: p.unit }; });
    flash('Analyzing what you said…', 'ok');
    // "voice" mode → the server treats the text as conversational quote dictation
    // (see APPS-SCRIPT-UPGRADE.txt) and returns the extended deal/discount schema.
    window.SQG_SHEETS.analyzePage(text, catalog, 'voice').then(function (data) {
      var ai = buildAiFindings(data);
      if (ai.findings.length) {
        state.analyze = {
          findings: ai.findings, title: '', url: '', note: ai.note || null,
          spoken: text, source: sourceLabel || 'voice',
        };
        render();
      } else {
        flash('Couldn’t pull quote details from that — try rephrasing', 'warn');
      }
    }).catch(function () {
      flash('Couldn’t analyze that — check your connection and try again', 'warn');
    });
  }

  /* ---- apply through the app's state functions (setQ) ---- */
  function applyFindings() {
    if (!state.analyze) return;
    var q = state.quote, patch = {}, count = 0;
    var srcUrl = state.analyze.url || ''; // the analyzed tab URL, recorded onto the quote
    var lines = q.lines.map(function (l) { return Object.assign({}, l); });
    var renew = (q.renewLines || []).map(function (l) { return Object.assign({}, l); });
    var linesTouched = false, renewTouched = false;
    // Deal / discount / support patches mirror voice.js buildPatch EXACTLY (same
    // clamp + max-discount rules, same isRenOnly margin routing) so the AI review
    // path and the live parser apply these fields identically.
    var rules = (state.cfg && state.cfg.rules) || {};
    var clampPct = function (v, max) { return Math.max(0, Math.min(max == null ? 100 : max, +v || 0)); };
    var isRenOnly = (q.customerType === 'current' && q.dealType === 'ren');
    var touched = {}; // sections to expand so the applied change is visible (like voice)

    // Scalar findings whose field name is exactly the quote key they fill.
    // Includes the original rule-based fields (customer / email / partnerCompany /
    // coTermDate) plus the AI-only fields, so behaviour for the old ones is
    // unchanged and the new ones just work.
    var SCALAR_FIELDS = {
      customer: 1, email: 1, partnerCompany: 1, partnerEmail: 1, billingContact: 1,
      billToAddress: 1, shipToAddress: 1, expires: 1, currency: 1, coTermDate: 1,
    };

    state.analyze.findings.forEach(function (f) {
      if (!f.checked) return;
      count++;
      if (SCALAR_FIELDS[f.field]) patch[f.field] = f.value;
      else if (f.field === 'term') { patch.months = f.months; patch.years = f.years; touched.deal = 1; }
      else if (f.field === 'customerType') { patch.customerType = f.value; touched.deal = 1; }
      else if (f.field === 'dealType') { patch.customerType = 'current'; patch.dealType = f.value; touched.deal = 1; }
      else if (f.field === 'extraPct') { patch.extraPct = clampPct(f.value, rules.maxExtra != null ? rules.maxExtra : 50); touched.discounts = 1; }
      else if (f.field === 'partnerMargin') { patch.partner = true; patch[isRenOnly ? 'marginRenPct' : 'marginNewPct'] = clampPct(f.value, 100); touched.discounts = 1; }
      else if (f.field === 'premiumSupport') { patch.supportAll = f.value; touched.selling = 1; }
      else if (f.field === 'lineQty') {
        var ln = lines.find(function (l) { return l.productId === f.productId; });
        if (ln) ln.qty = f.qty; else lines.push({ id: uid(), productId: f.productId, qty: f.qty });
        linesTouched = true;
      } else if (f.field === 'renewLine') {
        var rl = renew.find(function (l) { return l.productId === f.productId; });
        if (rl) { if (f.qty != null) rl.qty = f.qty; if (f.price != null) rl.price = f.price; }
        else renew.push({ id: uid(), productId: f.productId, qty: f.qty != null ? f.qty : 1000, price: f.price != null ? f.price : 0 });
        renewTouched = true;
      }
    });

    if (linesTouched) patch.lines = lines;
    if (renewTouched) patch.renewLines = renew;

    state.analyze = null;
    if (count === 0) { render(); flash('Select at least one value to apply', 'warn'); return; }
    patch.sourceUrl = srcUrl; // this quote now came from "Analyze this page"
    // Expand any section we filled so the applied change is visible.
    var APP = window.SQG_APP || {};
    if (typeof APP.openSections === 'function') APP.openSections(Object.keys(touched));
    setQ(patch); // persists to localStorage + re-renders, exactly like a manual edit
    flash('Filled in ' + count + ' value' + (count > 1 ? 's' : '') + ' from the page', 'ok');
  }

  /* =========================================================================
     UI — button + review card (built during app.js render()).
     ========================================================================= */
  function reviewCard() {
    var a = state.analyze;
    var isVoice = a.source === 'voice';
    var card = h('section', { class: 'sqg-card sqg-analyze-card' },
      h('div', { class: 'sqg-analyze-head' },
        h('h2', null, isVoice ? 'From what you said' : 'Found on this page'),
        h('p', { class: 'sqg-subhead' }, 'Review and choose what to fill in — nothing changes until you apply.')
      ));

    if (isVoice && a.spoken) card.append(h('p', { class: 'sqg-voice-heard' }, '“' + a.spoken + '”'));

    var list = h('div', { class: 'sqg-analyze-list' });
    a.findings.forEach(function (f) {
      var cb = h('input', {
        type: 'checkbox', class: 'sqg-analyze-cb', checked: f.checked,
        onChange: function (e) { f.checked = e.target.checked; },
      });
      list.append(h('label', { class: 'sqg-analyze-row' },
        cb,
        h('div', { class: 'sqg-analyze-texts' },
          h('span', { class: 'sqg-analyze-label' }, f.label),
          h('span', { class: 'sqg-analyze-value' }, f.display),
          f.replaces ? h('span', { class: 'sqg-analyze-replace' }, 'will replace: ' + f.replaces) : null
        )
      ));
    });
    card.append(list);

    if (a.note) card.append(h('p', { class: 'sqg-analyze-note' }, a.note));

    card.append(h('div', { class: 'sqg-analyze-actions' },
      dsButton('Cancel', 'secondary', 'md', false, function () { state.analyze = null; render(); }),
      dsButton('Apply', 'primary', 'md', false, applyFindings)
    ));
    return card;
  }

  /* The output surface for the two "fill the form" features, shown at the top of
     the scrollable content. The trigger buttons themselves (Analyze / Speak to
     fill) now live in the bottom icon dock (buildDockToolbar in app.js); this only
     renders the live-listening strip, the "here's what I heard" review box, and the
     analyze review/apply card. Returns null when there's nothing to show so no empty
     spacer is left at the top. */
  function bar() {
    var wrap = h('div', { class: 'sqg-analyze-wrap' });
    var any = false;

    var strip = (window.SQG_VOICE && typeof window.SQG_VOICE.liveStrip === 'function') ? window.SQG_VOICE.liveStrip() : null;
    if (strip) { wrap.append(strip); any = true; }

    // Editable "here's what I heard" confirmation — shown after listening stops,
    // before the words are sent to the AI (voice.js owns its state).
    var vreview = (window.SQG_VOICE && typeof window.SQG_VOICE.reviewBox === 'function') ? window.SQG_VOICE.reviewBox() : null;
    if (vreview) { wrap.append(vreview); any = true; }

    if (state.analyze) { wrap.append(reviewCard()); any = true; }
    return any ? wrap : null;
  }

  /* ---- tab access + injection ---- */
  function blockedUrl(url) {
    return !url
      || /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|view-source|data|file|devtools):/i.test(url)
      || /^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url);
  }

  function getActiveTab() {
    function query(opts) {
      return new Promise(function (resolve) {
        try { chrome.tabs.query(opts, function (tabs) { resolve(tabs && tabs[0]); }); }
        catch (e) { resolve(null); }
      });
    }
    return query({ active: true, lastFocusedWindow: true }).then(function (t) {
      return t || query({ active: true, currentWindow: true });
    });
  }

  /* Show a set of findings in the review card (or the "nothing found" toast). */
  function showFindings(findings, raw, tab, note) {
    if (!findings || !findings.length) {
      flash('Couldn’t find quote info on this page.', 'warn');
      state.analyze = null; render();
      return;
    }
    state.analyze = { findings: findings, title: (raw && raw.title) || '', url: (tab && tab.url) || '', note: note || null };
    render();
  }

  /* Salesforce only renders panels/tabs that are open, so after an analyze we tell
     the user which section to open when a key one was absent from the snapshot:
       • a renewal-type page with no Renewals / Subscription section captured, or
       • no Products visible at all.
     The analyzer stays strictly read-only — it never opens anything itself. */
  function ruleNote(raw, ruleFindings) {
    if (!raw || raw.source !== 'salesforce') return null;
    var hasProducts = (ruleFindings || []).some(function (f) { return f.field === 'renewLine' || f.field === 'lineQty'; });
    var ss = raw.sectionsSeen || {};
    var msgs = [];
    if (raw.isRenewal && !ss.renewals && !ss.subscription) msgs.push(SF_RENEWAL_NOTE);
    if (!hasProducts && !raw.productsSeen) msgs.push(SF_LAZY_NOTE);
    return msgs.length ? msgs.join(' ') : null;
  }

  function run() {
    // Mutual exclusion — "Speak to fill" and "Analyze this page" never run at the
    // same time. If the user is dictating, stop that first.
    if (window.SQG_VOICE && typeof window.SQG_VOICE.isListening === 'function' && window.SQG_VOICE.isListening()) {
      if (typeof window.SQG_VOICE.stop === 'function') window.SQG_VOICE.stop();
    }
    var mySeq = ++analyzeSeq;                       // invalidated if voice starts or a newer analyze runs
    var stale = function () { return mySeq !== analyzeSeq; };

    if (state.analyze) { state.analyze = null; }
    if (!(typeof chrome !== 'undefined' && chrome.scripting && chrome.tabs)) {
      flash('Page analysis isn’t available in this context', 'warn');
      return;
    }
    analyzeActive = true; render();                 // lock the mic while analyzing
    getActiveTab().then(function (tab) {
      if (stale()) return;
      if (!tab || !tab.id || blockedUrl(tab.url)) {
        analyzeActive = false;
        flash('This page can’t be analyzed — open a normal website tab and try again', 'warn');
        render();
        return;
      }
      flash('Analyzing this page…', 'ok');
      var target = { tabId: tab.id, allFrames: true };
      // Run the rule-based extractor and the rich snapshot together (both in all
      // frames), so we always have a complete fallback and the best AI input.
      var pRule = chrome.scripting.executeScript({
        target: target, func: extractQuoteInfo,
        args: [{
          custLabels: CUST_LABELS, billLabels: BILL_LABELS, emailLabels: EMAIL_LABELS,
          qtyLabels: QTY_LABELS, dateLabels: DATE_LABELS, productTerms: PRODUCT_KEYMAP,
          sfLabels: SF_LABELS,
        }],
      });
      var pSnap = chrome.scripting.executeScript({ target: target, func: snapshotPage });

      return Promise.all([pRule, pSnap.catch(function () { return []; })]).then(function (res) {
        if (stale()) return;                        // a voice session (or newer analyze) superseded us
        var raw = mergeFrames((res[0] || []).map(function (r) { return r && r.result; }));
        var ruleFindings = raw ? buildFindings(raw) : [];
        var pageText = buildSnapshotText((res[1] || []).map(function (r) { return r && r.result; }), raw);
        var catalog = state.cfg.products.map(function (p) { return { id: p.id, name: p.name, unit: p.unit }; });

        var fallback = function () { if (stale()) return; analyzeActive = false; showFindings(ruleFindings, raw, tab, ruleNote(raw, ruleFindings)); };

        // No AI transport available → behave exactly like the original tool.
        if (!(window.SQG_SHEETS && typeof window.SQG_SHEETS.analyzePage === 'function') || !pageText) {
          fallback(); return;
        }
        return window.SQG_SHEETS.analyzePage(pageText, catalog).then(function (data) {
          if (stale()) return;
          analyzeActive = false;
          var ai = buildAiFindings(data);
          if (ai.findings.length) {
            var merged = mergeAiRule(ai.findings, ruleFindings); // supplement, never drop
            showFindings(merged, raw, tab, ai.note || ruleNote(raw, ruleFindings));
          } else {
            fallback(); // AI returned nothing usable → rule-based detection
          }
        }).catch(fallback); // AI call failed → rule-based detection
      });
    }).catch(function () {
      if (stale()) return;
      analyzeActive = false;
      flash('This page can’t be analyzed — try a different tab', 'warn');
      render();
    });
  }

  return {
    bar: bar, run: run, applyFindings: applyFindings, fillFromText: fillFromText,
    cancel: cancelAnalyze, isRunning: analyzeRunning,
    _extract: extractQuoteInfo, _snapshot: snapshotPage, _parseDate: parseDate,
    _buildFindings: buildFindings, _buildAiFindings: buildAiFindings, _resolveCatalogProduct: resolveCatalogProduct,
    _buildSnapshotText: buildSnapshotText, _mergeAiRule: mergeAiRule, _mergeFrames: mergeFrames,
    _pickRenewalDate: pickRenewalDate, _primaryQty: primaryQty, _resolveProducts: resolveProducts,
    _ruleNote: ruleNote, _sfLabels: SF_LABELS,
  };
})();
