'use strict';

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyxEGl9ri8aSieWRXizsz0Z3amfz66XbLeZZh6ILsB6dgVQDCmaC8db7DLXqEczMqGOaA/exec";

/* Sales Quote Generator — "Save to database"
   Sends the current quote to a Google Apps Script web app (which appends a row
   to a Google Sheet and returns a short AI note). This is a separate, deliberate
   action from "Create quote" — it never runs automatically and never touches the
   pricing math or the PDF export.

   Everything sent is read from the SAME computed model the app already shows in
   the quote view (computeView() in app.js), so the totals and line prices match
   the PDF exactly — pricing is never re-derived here. Relies on globals defined
   in app.js (state, computeView, persist, int, flash); this script is loaded
   before app.js and only touches those globals when saveQuoteToSheet() is called
   (well after app.js has initialised, i.e. when the user clicks the button). */

window.SQG_SHEETS = (function () {
  var USER_KEY = 'sqg-user'; // same localStorage key the profile name is stored under

  function readUserName() {
    try { return (localStorage.getItem(USER_KEY) || '').trim(); } catch (e) { return ''; }
  }

  // Round a dollar amount to cents, matching how the app formats money.
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  /* One entry per line item, using the app's already-computed line prices
     (dollars, not cents), the resolved product name, and its unit. Mirrors the
     line rows shown in the quote view / PDF for every deal type. */
  function buildLines(v) {
    var q = v.q, m = v.m, cfg = v.cfg;
    var lines = [];
    if (m.isRenOnly) {
      (q.renewLines || []).forEach(function (rl) {
        var p = cfg.products.find(function (x) { return x.id === rl.productId; }) || {};
        lines.push({
          productId: rl.productId,
          productName: p.name || 'Product',
          qty: int(rl.qty),
          unit: p.unit === 'user' ? 'user' : 'endpoint',
          annualPrice: round2(Math.max(0, +rl.price || 0)),
        });
      });
    } else {
      m.lines.forEach(function (x) {
        var c = x.c;
        lines.push({
          productId: c.prod.id,
          productName: c.prod.name,
          qty: c.units,
          unit: c.isUser ? 'user' : 'endpoint',
          annualPrice: round2(c.msrp),
        });
      });
      // Add-on + renewal quotes also carry current products that renew at today's price.
      if (m.addonRenew) {
        (q.existing || []).forEach(function (ex) {
          var p = cfg.products.find(function (x) { return x.id === ex.productId; }) || {};
          lines.push({
            productId: ex.productId,
            productName: p.name || 'Current product',
            qty: 0,
            unit: p.unit === 'user' ? 'user' : 'endpoint',
            annualPrice: round2(Math.max(0, +ex.price || 0)),
          });
        });
      }
    }
    return lines;
  }

  function buildPayload() {
    var v = computeView();     // same computed model the calculator + PDF use
    var q = v.q, m = v.m;
    return {
      action: 'saveQuote',
      user: readUserName(),
      quote: q,
      totals: {
        annual: round2(m.totalAnnualC / 100),                       // annual total (dollars)
        tcv: round2(m.tcvC / 100),                                  // total contract value = PDF Grand Total
        savings: round2(Math.max(0, (m.msrpTcvC - m.tcvC) / 100)),  // total saved vs list over the contract
      },
      lines: buildLines(v),
      sourceUrl: q.sourceUrl || '', // set when the quote was filled from "Analyze this page"
    };
  }

  /* POST the current quote as JSON, then show the AI note that comes back. On
     any failure the calculator is untouched — we just flash a friendly message. */
  function saveQuoteToSheet() {
    var payload;
    try {
      payload = buildPayload();
    } catch (e) {
      flash("Couldn't save to the database — check your connection.", 'warn');
      return Promise.resolve();
    }

    flash('Saving to the database…', 'ok');

    return fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text();
      })
      .then(function (text) {
        var data = {};
        try { data = JSON.parse(text) || {}; } catch (e) { data = {}; }
        if (data.ok === false) throw new Error('server reported failure');
        var summary = (data.aiSummary == null ? '' : String(data.aiSummary)).trim();
        // Keep the note on the quote so it isn't lost, then surface it via the toast.
        try {
          state.quote.aiSummary = summary;
          persist();
        } catch (e) { /* saving the note is best-effort */ }
        flash(summary || 'Quote saved to the database.', 'ok');
      })
      .catch(function () {
        flash("Couldn't save to the database — check your connection.", 'warn');
      });
  }

  // Attach the function so app.js can wire it to the "Save to database" button.
  window.saveQuoteToSheet = saveQuoteToSheet;

  return { saveQuoteToSheet: saveQuoteToSheet };
})();
