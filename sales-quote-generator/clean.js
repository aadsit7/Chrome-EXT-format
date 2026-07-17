'use strict';

/* Sales Quote Generator — shared value-cleaning helpers.

   One source of truth for the string hygiene applied to values that reach the
   PDF, so the panel-side analyze path (buildFindings / buildAiFindings) and the
   final PDF guard (app.js buildQuoteData meta) scrub identically. Pure — no DOM,
   no app globals — so it is safe to load first and to unit-test in bare Node.

   Three independent operations, each documented at its function:
     • scrubEdges          — strip leading/trailing Salesforce UI action words
     • trimTrailingPunct   — trim a trailing comma/period (abbreviations kept)
     • validEmail          — is this a single, syntactically valid email address
     • cleanMeta           — compose the above for a PDF meta object

   The in-page capture functions in analyze.js (extractQuoteInfo / snapshotPage)
   run serialized inside the tab and can't reach this module, so they carry their
   own tiny inline copy of the action-word list; this file stays the source of
   truth for everything that runs panel-side. */

(function () {
  function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* Salesforce Lightning renders hover-action buttons ("Preview", "Edit", …)
     next to record names; a snapshot can capture them fused onto a value
     ("Insight Preview"). These are the action labels stripped from the LEADING
     and TRAILING edge of an extracted value — the minimum set the spec requires,
     longest phrases first so "view all" is tried before a bare word would be. */
  var ACTION_PHRASES = ['more actions', 'view all', 'show all', 'show more', 'preview', 'refresh', 'change', 'edit'];

  /* Strip standalone UI action words from BOTH edges of a value, repeatedly,
     collapsing whitespace. Only whole tokens at an edge are removed, so interior
     text ("Application Workspace") and words that merely contain an action word
     ("Previewing") are never touched. Returns '' if nothing survives. */
  function scrubEdges(s) {
    if (s == null) return s;
    var v = String(s).replace(/\s+/g, ' ').trim();
    var changed = true;
    while (changed && v) {
      changed = false;
      for (var i = 0; i < ACTION_PHRASES.length; i++) {
        var p = ACTION_PHRASES[i];
        var lead = new RegExp('^' + esc(p) + '(?![a-z0-9])\\s*', 'i');
        var trail = new RegExp('\\s*(?:^|[^a-z0-9])' + esc(p) + '$', 'i');
        if (lead.test(v)) { v = v.replace(lead, '').trim(); changed = true; }
        if (v && trail.test(v)) { v = v.replace(new RegExp('\\s+' + esc(p) + '$', 'i'), '').trim(); changed = true; }
      }
    }
    return v;
  }

  /* Trim trailing punctuation (commas / periods) only. Interior punctuation is
     never touched ("Recast Software, Inc." keeps its comma), and a legitimate
     trailing "." that closes a known company abbreviation (Inc, Corp, Ltd, LLC,
     Co) is preserved ("Gulfstream Aerospace Corp." stays intact). */
  var ABBR_RX = /(?:^|\s)(?:inc|corp|ltd|llc|co)\.$/i;
  function trimTrailingPunct(s) {
    if (s == null) return s;
    var v = String(s).replace(/\s+$/, '');
    var prev;
    do {
      prev = v;
      v = v.replace(/,+$/, '').replace(/\s+$/, '');                 // trailing commas always go
      if (/\.$/.test(v) && !ABBR_RX.test(v)) v = v.replace(/\.+$/, '').replace(/\s+$/, ''); // trailing period unless an abbreviation
    } while (v !== prev);
    return v;
  }

  /* A value is a printable email only if it is exactly one syntactically valid
     address. Anything else ("bob at simple services", garbage, blank) is not. */
  var EMAIL_RX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
  function validEmail(s) {
    if (s == null) return false;
    return EMAIL_RX.test(String(s).trim());
  }

  /* Final guard applied to the PDF meta object (app.js buildQuoteData):
       • fromPage true (the quote carries a sourceUrl, so the value MAY have come
         from page analysis) → strip edge action words first, then trim trailing
         punctuation. Hand-typed values (no sourceUrl) skip the action scrub so a
         real "Preview Inc" survives.
       • trailing-punctuation trim runs for ALL quotes.
       • email / partnerEmail are blanked unless they are a single valid address,
         so malformed voice/analyze emails print blank rather than as garbage.
     Returns a cleaned COPY; the input is not mutated. */
  function cleanMeta(meta, fromPage) {
    var m = Object.assign({}, meta || {});
    ['customer', 'partnerCompany', 'billToName', 'shipToName'].forEach(function (k) {
      var val = m[k];
      if (val == null) return;
      if (fromPage) val = scrubEdges(val);
      val = trimTrailingPunct(val);
      m[k] = val;
    });
    if (!validEmail(m.email)) m.email = '';
    if (!validEmail(m.partnerEmail)) m.partnerEmail = '';
    return m;
  }

  var api = { scrubEdges: scrubEdges, trimTrailingPunct: trimTrailingPunct, validEmail: validEmail, cleanMeta: cleanMeta, ACTION_PHRASES: ACTION_PHRASES };
  if (typeof window !== 'undefined') window.SQG_CLEAN = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
