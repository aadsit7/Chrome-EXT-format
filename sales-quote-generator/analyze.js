'use strict';

/* Sales Quote Generator — "Analyze this page"
   Reads the active browser tab (read-only, nothing leaves the browser) and
   proposes matching values for the quote form. Detection is rule-based:
   label/value pairs from tables, forms and definition lists, plus the built-in
   product catalog matched loosely against the visible text. Everything is
   surfaced in a review card first — nothing is written until the user applies.

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

  /* =========================================================================
     Extraction — runs INSIDE the page via chrome.scripting.executeScript.
     Must be fully self-contained (no closure references): its source is
     serialised and executed in the tab. It only reads the DOM.
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

      /* ---- label/value pairs from structured markup ---- */
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

      /* ---- products (catalog match + nearby qty/price) ---- */
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

      var found = [];
      /* structural: a table row where one cell names a product */
      for (var r = 0; r < rows.length; r++) {
        var rc = rows[r], key = null;
        for (var c = 0; c < rc.length; c++) { key = matchKey(rc[c]); if (key) break; }
        if (!key) continue;
        var price = null, qty = null;
        for (var c2 = 0; c2 < rc.length; c2++) { var pm = parseMoney(rc[c2]); if (pm != null) { price = pm; break; } }
        for (var c3 = 0; c3 < rc.length; c3++) { if (matchKey(rc[c3]) === key) continue; var qv = leadCount(rc[c3]); if (qv != null) { qty = qv; break; } }
        found.push({ key: key, qty: qty, price: price });
      }
      /* structural: a label/value pair whose label names a product (e.g. a
         definition list <dt>Application Workspace</dt><dd>1,200 users</dd>) */
      for (var pp = 0; pp < pairs.length; pp++) {
        var pk = matchKey(pairs[pp].label);
        if (!pk) continue;
        found.push({ key: pk, qty: leadCount(pairs[pp].value), price: parseMoney(pairs[pp].value) });
      }
      /* fallback: a plain text line mentioning a product */
      for (var t2 = 0; t2 < textLines.length; t2++) {
        var key2 = matchKey(textLines[t2]);
        if (!key2) continue;
        var line = textLines[t2];
        var price2 = parseMoney(line);
        var stripped = line.replace(MONEY_RX, ' ');
        var qty2 = leadCount(stripped);
        found.push({ key: key2, qty: qty2, price: price2 });
      }

      /* standalone quantity labels (e.g. "Endpoints: 5,000") */
      var qtyValues = [];
      for (var p2 = 0; p2 < pairs.length; p2++) {
        var pl2 = low(pairs[p2].label);
        for (var ql = 0; ql < cfg.qtyLabels.length; ql++) {
          if (pl2.indexOf(cfg.qtyLabels[ql]) > -1) { var qn = leadCount(pairs[p2].value); if (qn != null) qtyValues.push(qn); }
        }
      }

      return {
        title: document.title || '',
        url: location.href || '',
        customer: findByLabels(cfg.custLabels, notEmailNum),
        billTo: findByLabels(cfg.billLabels, notEmailNum),
        email: findEmail(),
        renewalDateRaw: findByLabels(cfg.dateLabels, function (v) { return /\d/.test(v); }),
        products: found,
        qtyValues: qtyValues,
      };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  /* =========================================================================
     Panel side — turn the raw extraction into reviewable findings.
     ========================================================================= */
  function normS(s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); }

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
        target: { tabId: tab.id },
        func: extractQuoteInfo,
        args: [{
          custLabels: CUST_LABELS, billLabels: BILL_LABELS, emailLabels: EMAIL_LABELS,
          qtyLabels: QTY_LABELS, dateLabels: DATE_LABELS, productTerms: PRODUCT_KEYMAP,
        }],
      }).then(function (results) {
        var raw = results && results[0] && results[0].result;
        var findings = (raw && !raw.error) ? buildFindings(raw) : [];
        if (!findings.length) {
          flash('Couldn’t find quote info on this page.', 'warn');
          state.analyze = null; render();
          return;
        }
        state.analyze = { findings: findings, title: (raw && raw.title) || '', url: (tab.url || '') };
        render();
      });
    }).catch(function () {
      flash('This page can’t be analyzed — try a different tab', 'warn');
    });
  }

  return { bar: bar, run: run, applyFindings: applyFindings, _extract: extractQuoteInfo, _parseDate: parseDate, _buildFindings: buildFindings };
})();
