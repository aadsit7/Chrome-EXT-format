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
   in app.js (state, computeView, persist, int, flash, readUser, adoptCanonicalId);
   this script is loaded before app.js and only touches those globals at call time
   (well after app.js has initialised, i.e. when the user clicks a button). */

window.SQG_SHEETS = (function () {
  // The user identity object { userId, firstName, lastName } lives in localStorage
  // 'sqg-user' and is read via app.js's readUser() so there's one source of truth.
  function currentUser() {
    try { return (typeof readUser === 'function') ? readUser() : null; } catch (e) { return null; }
  }

  // If a JSON response from APPS_SCRIPT_URL carries the canonical userId, adopt it.
  function maybeAdoptId(data) {
    try { if (typeof adoptCanonicalId === 'function') adoptCanonicalId(data); } catch (e) {}
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
      user: currentUser(),   // { userId, firstName, lastName } from localStorage 'sqg-user'
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
        // Auto-merge across computers: adopt the server's canonical userId if it
        // returned one that differs from ours (silent, no UI change).
        maybeAdoptId(data);
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

  /* Fire-and-forget user registration, called once from the first-run gate.
     POSTs { action:'registerUser', user } and, if the server answers with the
     canonical userId, adopts it. Never blocks the UI and never surfaces errors:
     if the user is offline they still get into the app and are registered on
     their first saved quote. */
  function registerUser(user) {
    try {
      fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'registerUser', user: user }),
      })
        .then(function (resp) { return resp.ok ? resp.text() : ''; })
        .then(function (text) {
          var data = {};
          try { data = JSON.parse(text) || {}; } catch (e) { data = {}; }
          maybeAdoptId(data);
        })
        .catch(function () { /* offline is fine — registered on first saved quote */ });
    } catch (e) { /* fire-and-forget */ }
  }

  /* AI page analysis — POSTs the rich page snapshot + the live catalog and
     returns the Apps Script's structured fields for the review card. Rejects on
     any transport/parse failure so analyze.js can fall back to the existing
     rule-based detection. Never touches the quote or the calculator itself.

     `mode` tells the server which brain to use: "page" for "Analyze this page"
     (a web-page snapshot) and "voice" for "Speak to fill" (conversational quote
     dictation from fillFromText). It defaults to "page", so the currently
     deployed Apps Script keeps working unchanged until the voice-mode prompt is
     re-pasted (see APPS-SCRIPT-UPGRADE.txt). */
  function analyzePage(pageText, catalog, mode) {
    return fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'analyzePage', pageText: pageText, catalog: catalog, mode: mode === 'voice' ? 'voice' : 'page' }),
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text();
      })
      .then(function (text) {
        var data = {};
        try { data = JSON.parse(text) || {}; } catch (e) { data = {}; }
        if (data.ok === false) throw new Error('server reported failure');
        return data;
      });
  }

  /* Company address lookup ("Look up address" in Billing details) — POSTs
     { action:'addressLookup', company } to the same Apps Script web app and
     resolves to the company's mailing/headquarters address as a multi-line
     string. Rejects on any transport/parse failure OR when the deployed script
     doesn't know the action yet (older deployment), so app.js can fall back to
     its keyless OpenStreetMap lookup. Never touches the quote itself. */
  function lookupAddress(company) {
    return fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'addressLookup', company: String(company == null ? '' : company) }),
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text();
      })
      .then(function (text) {
        var data = {};
        try { data = JSON.parse(text) || {}; } catch (e) { data = {}; }
        if (data.ok === false) throw new Error('server reported failure'); // incl. "unknown action" pre-upgrade
        var addr = (data.address == null ? '' : String(data.address)).trim();
        if (!addr) throw new Error('no address returned');
        return addr;
      });
  }

  // Attach the functions so app.js / analyze.js can wire them to the UI.
  window.saveQuoteToSheet = saveQuoteToSheet;
  window.registerUser = registerUser;

  return { saveQuoteToSheet: saveQuoteToSheet, registerUser: registerUser, analyzePage: analyzePage, lookupAddress: lookupAddress };
})();
