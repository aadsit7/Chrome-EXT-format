'use strict';

/* Sales Quote Generator — "Analyze this page"
   Reads the active browser tab (read-only, nothing leaves the browser) and
   proposes matching values for the quote form. Two extraction paths:

     • Salesforce-first (primary): when the tab is a Salesforce page (by URL or
       Lightning DOM markers) we read record-detail label/value pairs from
       Lightning (.slds-form-element__label / test-id__field-label) and Classic
       (.labelCol / .dataCol) layouts, and parse related-list tables (Opportunity
       Products, Quote Line Items, Assets) by their column headers.
     • Generic fallback: rule-based label/value extraction from tables, forms and
       definition lists, plus catalog product matching, for any other website.

   Everything is surfaced in a review card first — nothing is written until the
   user applies. The extraction function runs INSIDE the tab (in every frame,
   allFrames: true) and only reads the DOM.

   Relies on globals defined in app.js (state, setQ, render, flash, h, dsButton,
   uid, int, fmt). This script is loaded before app.js; the functions here only
   touch those globals when called (well after app.js has initialised). */

window.SQG_ANALYZE = (function () {
  /* ---- Label vocabularies (generic, page-agnostic) ---- */
  var CUST_LABELS = ['customer', 'account name', 'account', 'company name', 'company', 'client', 'organization', 'organisation', 'end customer'];
  var BILL_LABELS = ['bill to', 'bill-to', 'billto', 'billing company', 'billing', 'invoice to', 'sold to', 'reseller', 'partner', 'distributor'];
  var EMAIL_LABELS = ['email', 'e-mail', 'contact email', 'contact'];
  var QTY_LABELS = ['quantity', 'qty', 'endpoints', 'devices', 'users', 'seats', 'licenses', 'licences', 'nodes'];
  var DATE_LABELS = ['renewal date', 'renews on', 'renews', 'renewal', 'expiration date', 'expiration', 'expires', 'end date', 'term end', 'contract end'];

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

  var SF_LAZY_NOTE = 'No products list visible — scroll to the Products section in Salesforce and analyze again.';

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
      var parseMoney = function (s) {
        var m = String(s).match(MONEY_RX);
        if (!m) return null;
        var n = parseFloat(m[1].replace(/,/g, ''));
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

      /* Renewal date: labels containing Renewal / Contract End / End Date /
         Expiration with a date value. "Close Date" is explicitly NOT a renewal. */
      var sfFindRenewalDate = function (sfPairs) {
        for (var i = 0; i < sfPairs.length; i++) {
          var l = low(sfPairs[i].label), v = sfPairs[i].value;
          if (l.indexOf('close') > -1) continue;
          if (/(renewal|contract end|end date|expiration|expires)/.test(l) && /\d/.test(v)) return v;
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

      /* Related-list product tables parsed by column headers. Returns matched
         product lines plus whether any product-style table was present at all. */
      var sfProductTables = function () {
        var out = [], sawTable = false;
        var tables = document.querySelectorAll('table');
        for (var t = 0; t < tables.length; t++) {
          var table = tables[t];
          var heads = table.querySelectorAll('thead th, thead td');
          if (!heads.length) {
            var fr = table.querySelector('tr');
            if (fr) { var ths = fr.querySelectorAll('th'); if (ths.length) heads = ths; }
          }
          if (!heads || !heads.length) continue;

          var prodIdx = -1, qtyIdx = -1, priceIdx = -1, priceRank = -1;
          for (var hI = 0; hI < heads.length; hI++) {
            var htext = low(heads[hI].getAttribute && heads[hI].getAttribute('title') ? heads[hI].getAttribute('title') : heads[hI].textContent);
            if (prodIdx < 0 && /\b(product name|product|line item|item|asset name|asset)\b/.test(htext)) prodIdx = hI;
            if (qtyIdx < 0 && /\b(quantity|qty)\b/.test(htext)) qtyIdx = hI;
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
          if (!bodyRows.length) bodyRows = table.querySelectorAll('tr');
          for (var r = 0; r < bodyRows.length; r++) {
            var rowCells = bodyRows[r].querySelectorAll('th, td');
            if (!rowCells.length || rowCells.length <= prodIdx) continue;
            var pname = norm(rowCells[prodIdx].textContent);
            var key = matchKey(pname);
            if (!key) continue;
            var qty = (qtyIdx >= 0 && rowCells[qtyIdx]) ? leadCount(norm(rowCells[qtyIdx].textContent)) : null;
            var price = (priceIdx >= 0 && rowCells[priceIdx]) ? parseMoney(norm(rowCells[priceIdx].textContent)) : null;
            out.push({ key: key, qty: qty, price: price });
          }
        }
        return { products: out, sawTable: sawTable };
      };

      /* ---- Assemble the result for this frame ---- */
      var result;
      if (isSalesforce) {
        var sfPairs = buildSfPairs();
        var customer = sfFind(sfPairs, ['account name', 'account'], ['owner', 'number', 'site', 'type', 'source', 'currency', 'record', 'id', 'status', 'stage', 'parent'], notEmailNum);
        if (!customer && sfEntity() === 'Account') customer = sfHeaderTitle();
        if (!customer) customer = findByLabels(cfg.custLabels, notEmailNum); // generic backstop
        var billTo = sfFind(sfPairs, ['bill to name', 'bill to', 'billing account', 'bill-to name', 'sold to'], null, notEmailNum);
        var email = sfFindEmail(sfPairs) || findEmail();
        var renewalDateRaw = sfFindRenewalDate(sfPairs);
        var tbl = sfProductTables();

        result = {
          source: 'salesforce',
          title: document.title || '',
          url: location.href || '',
          customer: customer,
          billTo: billTo,
          email: email,
          renewalDateRaw: renewalDateRaw,
          products: tbl.products,
          qtyValues: [],
          productsSeen: tbl.sawTable || tbl.products.length > 0,
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

      result.matchCount =
        (result.customer ? 1 : 0) + (result.billTo ? 1 : 0) + (result.email ? 1 : 0) +
        (result.renewalDateRaw ? 1 : 0) + (result.products ? result.products.length : 0) +
        (result.qtyValues ? result.qtyValues.length : 0);
      return result;
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
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
      ['customer', 'billTo', 'email', 'renewalDateRaw'].forEach(function (k) {
        if (!base[k] && f[k]) base[k] = f[k];
      });
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

  function buildFindings(raw) {
    var q = state.quote, cfg = state.cfg, out = [];

    if (raw.customer) out.push(scalarFinding('customer', 'Customer / company', raw.customer, raw.customer, q.customer));
    if (raw.email) out.push(scalarFinding('email', 'Contact email', raw.email, raw.email, q.email));
    if (raw.billTo && (!raw.customer || normS(raw.billTo) !== normS(raw.customer))) {
      out.push(scalarFinding('partnerCompany', 'Partner company (bill-to)', raw.billTo, raw.billTo, q.partnerCompany));
    }
    var isoDate = parseDate(raw.renewalDateRaw);
    if (isoDate) {
      var f = scalarFinding('coTermDate', "Customer's renewal date", isoDate, fmtDate(isoDate), q.coTermDate);
      if (f.replaces) f.replaces = fmtDate(q.coTermDate);
      out.push(f);
    }

    resolveProducts(raw.products, raw.qtyValues).forEach(function (p) {
      var prod = cfg.products.find(function (x) { return x.id === p.key; });
      if (!prod) return;
      if (p.price != null) {
        var curR = (q.renewLines || []).find(function (l) { return l.productId === prod.id; });
        var parts = [];
        if (p.qty != null) parts.push(int(p.qty).toLocaleString('en-US') + ' ' + unitWord(prod));
        parts.push(fmt(p.price) + '/yr');
        out.push({
          field: 'renewLine', productId: prod.id, qty: p.qty, price: p.price, checked: true,
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

  /* ---- apply through the app's state functions (setQ) ---- */
  function applyFindings() {
    if (!state.analyze) return;
    var q = state.quote, patch = {}, count = 0;
    var lines = q.lines.map(function (l) { return Object.assign({}, l); });
    var renew = (q.renewLines || []).map(function (l) { return Object.assign({}, l); });
    var linesTouched = false, renewTouched = false;

    state.analyze.findings.forEach(function (f) {
      if (!f.checked) return;
      count++;
      if (f.field === 'customer') patch.customer = f.value;
      else if (f.field === 'email') patch.email = f.value;
      else if (f.field === 'partnerCompany') patch.partnerCompany = f.value;
      else if (f.field === 'coTermDate') patch.coTermDate = f.value;
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
    setQ(patch); // persists to localStorage + re-renders, exactly like a manual edit
    flash('Filled in ' + count + ' value' + (count > 1 ? 's' : '') + ' from the page', 'ok');
  }

  /* =========================================================================
     UI — button + review card (built during app.js render()).
     ========================================================================= */
  function reviewCard() {
    var a = state.analyze;
    var card = h('section', { class: 'sqg-card sqg-analyze-card' },
      h('div', { class: 'sqg-analyze-head' },
        h('h2', null, 'Found on this page'),
        h('p', { class: 'sqg-subhead' }, 'Review and choose what to fill in — nothing changes until you apply.')
      ));

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

  function bar() {
    var wrap = h('div', { class: 'sqg-analyze-wrap' });
    var ico = h('span', { class: 'sqg-analyze-ico' });
    ico.innerHTML = SVG_SCAN;
    wrap.append(h('button', {
      class: 'sqg-analyze-btn', type: 'button', onClick: run,
      title: 'Read the current tab and suggest quote fields',
    }, ico, h('span', null, 'Analyze this page')));
    if (state.analyze) wrap.append(reviewCard());
    return wrap;
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

  function run() {
    if (state.analyze) { state.analyze = null; render(); }
    if (!(typeof chrome !== 'undefined' && chrome.scripting && chrome.tabs)) {
      flash('Page analysis isn’t available in this context', 'warn');
      return;
    }
    getActiveTab().then(function (tab) {
      if (!tab || !tab.id || blockedUrl(tab.url)) {
        flash('This page can’t be analyzed — open a normal website tab and try again', 'warn');
        return;
      }
      return chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: extractQuoteInfo,
        args: [{
          custLabels: CUST_LABELS, billLabels: BILL_LABELS, emailLabels: EMAIL_LABELS,
          qtyLabels: QTY_LABELS, dateLabels: DATE_LABELS, productTerms: PRODUCT_KEYMAP,
        }],
      }).then(function (results) {
        var frames = (results || []).map(function (r) { return r && r.result; });
        var raw = mergeFrames(frames);
        var findings = raw ? buildFindings(raw) : [];
        if (!findings.length) {
          flash('Couldn’t find quote info on this page.', 'warn');
          state.analyze = null; render();
          return;
        }
        var hasProducts = findings.some(function (f) { return f.field === 'renewLine' || f.field === 'lineQty'; });
        var note = (raw && raw.source === 'salesforce' && !hasProducts && !raw.productsSeen) ? SF_LAZY_NOTE : null;
        state.analyze = { findings: findings, title: (raw && raw.title) || '', url: (tab.url || ''), note: note };
        render();
      });
    }).catch(function () {
      flash('This page can’t be analyzed — try a different tab', 'warn');
    });
  }

  return { bar: bar, run: run, applyFindings: applyFindings, _extract: extractQuoteInfo, _parseDate: parseDate, _buildFindings: buildFindings, _mergeFrames: mergeFrames };
})();
