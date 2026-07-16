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

        var recordParts = [], tableParts = [], fieldParts = [];
        var seen = {}, seenCount = 0, recordChars = 0;
        var RECORD_CAP = 24000;

        var pushText = function (t) {
          t = norm(t);
          if (!t || t.length < 2) return;
          if (t.length > 400) t = t.slice(0, 400);
          if (recordChars > RECORD_CAP) return;
          if (seenCount < 6000) { if (seen[t]) return; seen[t] = 1; seenCount++; }
          recordParts.push(t); recordChars += t.length + 1;
        };

        var addField = function (label, val) {
          if (fieldParts.length > 400) return;
          label = norm(label).replace(/\s*[:：]\s*$/, ''); val = norm(val);
          if (label && val && label !== val && label.length <= 60 && val.length <= 300) fieldParts.push(label + ': ' + val);
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
              for (var c = 0; c < cells.length; c++) vals.push(norm(cells[c].textContent));
              var joined = vals.join(' | ');
              if (norm(joined.replace(/\|/g, ''))) { lines.push(joined); count++; }
            }
            if (lines.length > (headers.length ? 1 : 0)) tableParts.push(lines.join('\n'));
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
            if (isGrid(el)) { dumpGrid(el); if (el.shadowRoot) dumpGrid(el.shadowRoot); continue; }
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
          }
        };

        if (document.body) walk(document.body, 0);
        else if (document.documentElement) walk(document.documentElement, 0);

        var head = [];
        if (document.title) head.push('Title: ' + norm(document.title));
        if (typeof location !== 'undefined' && location.href) head.push('URL: ' + location.href);

        return {
          record: recordParts.join('\n'),
          tables: tableParts.join('\n\n'),
          fields: head.concat(fieldParts).join('\n'),
        };
      } catch (e) {
        return { record: '', tables: '', fields: '', error: String((e && e.message) || e) };
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

  /* =========================================================================
     AI path — assemble the request text and map the response into findings.
     ========================================================================= */

  /* Merge the per-frame snapshots into one text blob, then fold in the
     rule-based extraction (belt and suspenders) so the AI gets the richest
     possible input. Structured parts (fields, tables) come first; free page
     text fills the remainder up to a ~12000-char cap. */
  function buildSnapshotText(snaps, rawRule) {
    var ok = (snaps || []).filter(function (s) { return s && !s.error; });
    var fields = [], tables = [], record = [];
    ok.forEach(function (s) {
      if (s.fields) fields.push(s.fields);
      if (s.tables) tables.push(s.tables);
      if (s.record) record.push(s.record);
    });
    var ruleLines = [];
    if (rawRule) {
      if (rawRule.customer) ruleLines.push('Account/Customer: ' + rawRule.customer);
      if (rawRule.billTo) ruleLines.push('Bill To / Reseller: ' + rawRule.billTo);
      if (rawRule.email) ruleLines.push('Contact Email: ' + rawRule.email);
      if (rawRule.renewalDateRaw) ruleLines.push('Renewal/End Date: ' + rawRule.renewalDateRaw);
      (rawRule.products || []).forEach(function (p) {
        if (!p || !p.key) return;
        var prod = state.cfg.products.find(function (x) { return x.id === p.key; });
        ruleLines.push('Product: ' + (prod ? prod.name : p.key) + (p.qty != null ? ' · qty ' + p.qty : '') + (p.price != null ? ' · $' + p.price : ''));
      });
    }
    var parts = [];
    if (fields.length) parts.push('== FIELDS ==\n' + fields.join('\n'));
    if (tables.length) parts.push('== RELATED LISTS ==\n' + tables.join('\n\n'));
    if (ruleLines.length) parts.push('== DETECTED (rule-based) ==\n' + ruleLines.join('\n'));
    if (record.length) parts.push('== PAGE TEXT ==\n' + record.join('\n'));
    var text = parts.join('\n\n');
    if (text.length > 12000) text = text.slice(0, 12000);
    return text;
  }

  /* Turn the Apps Script's structured response into review-card findings.
     Every returned field maps to a finding so the user previews it before Apply;
     nothing is written here. Returns { findings, note }. */
  function buildAiFindings(data) {
    var out = [], note = null;
    if (!data || typeof data !== 'object') return { findings: out, note: note };
    var q = state.quote, cfg = state.cfg;
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

    var tm = parseInt(data.termMonths, 10);
    if (isFinite(tm) && tm > 0) {
      var yrs = Math.max(1, Math.round(tm / 12));
      out.push({
        field: 'term', months: tm, years: yrs, checked: true, label: 'Subscription term',
        display: tm + ' month' + (tm === 1 ? '' : 's') + ' (' + yrs + ' year' + (yrs === 1 ? '' : 's') + ')',
        replaces: (q.months && q.months !== tm) ? (q.months + ' months') : null,
      });
    }

    (Array.isArray(data.lines) ? data.lines : []).forEach(function (li) {
      if (!li) return;
      var prod = cfg.products.find(function (p) { return p.id === li.productId; }); // keep only live-catalog ids
      if (!prod) return;
      var qty = parseInt(li.qty, 10);
      if (!isFinite(qty) || qty <= 0) return;
      var curL = q.lines.find(function (l) { return l.productId === prod.id; });
      out.push({
        field: 'lineQty', productId: prod.id, qty: qty, checked: true,
        label: prod.name + ' — quantity', display: qty.toLocaleString('en-US') + ' ' + unitWord(prod),
        replaces: curL ? int(curL.qty).toLocaleString('en-US') + ' ' + unitWord(prod) : null,
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
    window.SQG_SHEETS.analyzePage(text, catalog).then(function (data) {
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
      else if (f.field === 'term') { patch.months = f.months; patch.years = f.years; }
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

  function bar() {
    var wrap = h('div', { class: 'sqg-analyze-wrap' });
    var ico = h('span', { class: 'sqg-analyze-ico' });
    ico.innerHTML = SVG_SCAN;
    var analyzeBtn = h('button', {
      class: 'sqg-analyze-btn', type: 'button', onClick: run,
      title: 'Read the current tab and suggest quote fields',
    }, ico, h('span', null, 'Analyze this page'));

    // Sit the "Speak to fill" mic button next to "Analyze this page" — both fill
    // the form for you. The mic button hides itself when voice isn't supported.
    var micBtn = (window.SQG_VOICE && typeof window.SQG_VOICE.button === 'function') ? window.SQG_VOICE.button() : null;
    wrap.append(micBtn ? h('div', { class: 'sqg-fill-row' }, analyzeBtn, micBtn) : analyzeBtn);

    var strip = (window.SQG_VOICE && typeof window.SQG_VOICE.liveStrip === 'function') ? window.SQG_VOICE.liveStrip() : null;
    if (strip) wrap.append(strip);

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

  /* The rule-based fallback note (Salesforce products still loading). */
  function ruleNote(raw, ruleFindings) {
    var hasProducts = (ruleFindings || []).some(function (f) { return f.field === 'renewLine' || f.field === 'lineQty'; });
    return (raw && raw.source === 'salesforce' && !hasProducts && !raw.productsSeen) ? SF_LAZY_NOTE : null;
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
      flash('Analyzing this page…', 'ok');
      var target = { tabId: tab.id, allFrames: true };
      // Run the rule-based extractor and the rich snapshot together (both in all
      // frames), so we always have a complete fallback and the best AI input.
      var pRule = chrome.scripting.executeScript({
        target: target, func: extractQuoteInfo,
        args: [{
          custLabels: CUST_LABELS, billLabels: BILL_LABELS, emailLabels: EMAIL_LABELS,
          qtyLabels: QTY_LABELS, dateLabels: DATE_LABELS, productTerms: PRODUCT_KEYMAP,
        }],
      });
      var pSnap = chrome.scripting.executeScript({ target: target, func: snapshotPage });

      return Promise.all([pRule, pSnap.catch(function () { return []; })]).then(function (res) {
        var raw = mergeFrames((res[0] || []).map(function (r) { return r && r.result; }));
        var ruleFindings = raw ? buildFindings(raw) : [];
        var pageText = buildSnapshotText((res[1] || []).map(function (r) { return r && r.result; }), raw);
        var catalog = state.cfg.products.map(function (p) { return { id: p.id, name: p.name, unit: p.unit }; });

        var fallback = function () { showFindings(ruleFindings, raw, tab, ruleNote(raw, ruleFindings)); };

        // No AI transport available → behave exactly like the original tool.
        if (!(window.SQG_SHEETS && typeof window.SQG_SHEETS.analyzePage === 'function') || !pageText) {
          fallback(); return;
        }
        return window.SQG_SHEETS.analyzePage(pageText, catalog).then(function (data) {
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
      flash('This page can’t be analyzed — try a different tab', 'warn');
    });
  }

  return {
    bar: bar, run: run, applyFindings: applyFindings, fillFromText: fillFromText,
    _extract: extractQuoteInfo, _snapshot: snapshotPage, _parseDate: parseDate,
    _buildFindings: buildFindings, _buildAiFindings: buildAiFindings,
    _buildSnapshotText: buildSnapshotText, _mergeAiRule: mergeAiRule, _mergeFrames: mergeFrames,
  };
})();
