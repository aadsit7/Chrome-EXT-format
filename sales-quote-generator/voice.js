'use strict';

/* Sales Quote Generator — "Speak to fill" (LIVE voice fill)

   A microphone toggle that fills the quote form as you speak. Speech is
   transcribed with the browser's Web Speech API (runs in the side panel; uses
   the browser's standard microphone prompt — no new extension permissions).

   Unlike a dictate-then-send flow, this parses each finalized phrase LOCALLY and
   updates the matching field immediately, so the form fills in real time:
     • products + quantity — "Right Click Tools 2,500 endpoints",
       "Application Workspace 500 users", "set Insights to 3,000"
     • discounts — "partner margin 20 percent", "extra discount 5 percent",
       "annual increase 3 percent", "premium support"
     • term / type — "two year term", "net new", "current customer", "renewal"
     • text fields — "customer is Acme Corporation", "email jane at acme dot com",
       "contact John Smith", "partner company Reseller Inc"
   Number words ("twenty five hundred", "two thousand five hundred") are
   understood. The parse is deterministic: the same words always route to the
   same fields. Because the whole running transcript is re-parsed on every phrase,
   simply re-saying a value corrects it (the latest wins), and the fields update
   live so any mis-hear is visible instantly. After stopping, the transcript is
   shown in an editable box so you can fix a misheard word and Re-apply.

   Applied changes go through setQ — exactly like a manual edit (visible, saved,
   reversible) — so the pricing engine still computes every total. Speech
   recognition itself is the browser's; accuracy of the transcription depends on
   the mic/environment, which is why every change is shown live and is editable.

   Relies on globals defined in app.js (state, render, flash, h, dsButton, setQ,
   uid). Loaded after analyze.js / sheets.js and before app.js; its functions
   only touch those globals when called. */

window.SQG_VOICE = (function () {
  // Web Speech API (Chrome exposes it as webkitSpeechRecognition).
  var Rec = (typeof window !== 'undefined') && (window.SpeechRecognition || window.webkitSpeechRecognition);

  var recog = null;    // the active SpeechRecognition instance, or null
  var finalText = '';  // accumulated final transcript for the current session
  var manualStop = false; // true when the user (or a hand-off) ended the session

  var SVG_MIC = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>';
  var SVG_STOP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2.5"></rect></svg>';

  function supported() { return !!Rec; }

  function setVoice(patch) {
    state.voice = Object.assign({ on: false, interim: '', finalText: '', error: '', heard: '', applied: [] }, state.voice || {}, patch || {});
    render();
  }

  function transcript() {
    var interim = (state.voice && state.voice.interim) || '';
    return (finalText + ' ' + interim).replace(/\s+/g, ' ').trim();
  }

  /* ========================================================================
     Deterministic command parser — pure (no DOM). parse(text, catalog) returns
     { commands, recognized }. See test coverage in the repo's dev tests.
     ======================================================================== */
  var parser = (function buildVoiceParser() {
    var NUM_WORDS = {
      zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
      ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
      seventeen: 17, eighteen: 18, nineteen: 19,
      twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    };
    var SCALES = { hundred: 100, thousand: 1000, k: 1000, million: 1000000, m: 1000000 };

    function norm(s) { return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim(); }
    function low(s) { return norm(s).toLowerCase(); }
    function escapeRx(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function isNumWord(t) { return NUM_WORDS[t] != null || SCALES[t] != null; }

    // Normalize a spoken email span ("jane at acme dot com" → "jane@acme.com").
    function spokenEmail(s) {
      return String(s == null ? '' : s).toLowerCase()
        .replace(/\s+at\s+/g, '@').replace(/\s+(?:dot|period)\s+/g, '.').replace(/\s+/g, '');
    }
    // The FIRST syntactically valid email in a (possibly noisy / fused) span. The
    // domain is matched non-greedily up to the first plausible TLD, so a fused
    // "a@x.com.partneremail.b@x.com" yields just "a@x.com" — never the whole run.
    var EMAIL_ONE = /[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)*?\.[a-z]{2,24}/i;
    function firstEmail(s) { var m = String(s == null ? '' : s).match(EMAIL_ONE); return m ? m[0] : ''; }

    function groupToNumber(tokens) {
      var pointIdx = tokens.indexOf('point');
      if (pointIdx >= 0) {
        var intPart = pointIdx === 0 ? 0 : (groupToNumber(tokens.slice(0, pointIdx)) || 0);
        var decDigits = tokens.slice(pointIdx + 1).map(function (t) { return NUM_WORDS[t]; })
          .filter(function (n) { return n != null && n < 10; });
        return parseFloat(String(intPart) + '.' + (decDigits.join('') || '0'));
      }
      var total = 0, current = 0, any = false;
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (NUM_WORDS[t] != null) { current += NUM_WORDS[t]; any = true; }
        else if (SCALES[t] != null) {
          any = true;
          var s = SCALES[t];
          if (s === 100) current = (current === 0 ? 1 : current) * 100;
          else { current = (current === 0 ? 1 : current) * s; total += current; current = 0; }
        }
      }
      return any ? (total + current) : null;
    }

    function replaceNumberWords(text) {
      var tokens = low(text).split(' ');
      var out = [], i = 0;
      while (i < tokens.length) {
        var t = tokens[i];
        var startsGroup = isNumWord(t) || ((t === 'a' || t === 'an') && SCALES[tokens[i + 1]] != null);
        if (!startsGroup) { out.push(t); i++; continue; }
        var grp = [];
        while (i < tokens.length) {
          var tk = tokens[i];
          if (isNumWord(tk)) { grp.push(tk); i++; continue; }
          if ((tk === 'a' || tk === 'an') && SCALES[tokens[i + 1]] != null) { grp.push('one'); i++; continue; }
          if (tk === 'point' && NUM_WORDS[tokens[i + 1]] != null) { grp.push('point'); i++; continue; }
          break;
        }
        var val = groupToNumber(grp);
        out.push(val == null ? grp.join(' ') : String(val));
      }
      return out.join(' ');
    }

    var ALIAS_BY_ID = {
      aw: ['application workspace', 'app workspace', 'workspace'],
      rct: ['right click tools', 'right-click tools', 'right click tool', 'right click', 'rct'],
      patch: ['rct patching', 'patching', 'patch'],
      ins: ['rct insights', 'insights', 'insight'],
      priv: ['rct privilege manager', 'privilege manager', 'privilege'],
    };
    function productPhrases(prod) {
      var set = {};
      var add = function (p) { p = low(p); if (p && p.length >= 2) set[p] = 1; };
      add(prod.name);
      add(low(prod.name).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim());
      var tail = String(prod.name).split(/[—\-:]/).pop();
      if (tail) add(tail);
      (ALIAS_BY_ID[prod.id] || []).forEach(add);
      return Object.keys(set);
    }

    function findProducts(text, catalog) {
      var raw = [];
      (catalog || []).forEach(function (prod) {
        productPhrases(prod).forEach(function (phrase) {
          var rx = new RegExp('(?:^|[^a-z0-9])(' + escapeRx(phrase) + ')(?![a-z0-9])', 'g');
          var mm;
          while ((mm = rx.exec(text))) {
            var start = mm.index + (mm[0].length - phrase.length);
            raw.push({ id: prod.id, unit: prod.unit, name: prod.name, phrase: phrase, start: start, end: start + phrase.length });
            rx.lastIndex = start + phrase.length;
          }
        });
      });
      raw.sort(function (a, b) { return (a.start - b.start) || (b.end - a.end); });
      var kept = [];
      raw.forEach(function (h) {
        if (!kept.some(function (k) { return h.start < k.end && k.start < h.end; })) kept.push(h);
      });
      return kept;
    }

    function labelFor(f) {
      var M = { customer: 'Customer', email: 'Email', partnerCompany: 'Partner company', partnerEmail: 'Partner email',
        billingContact: 'Contact', preparedBy: 'Prepared by', billToAddress: 'Bill-to address',
        shipToAddress: 'Ship-to address', paymentTerms: 'Payment terms', paymentMethod: 'Payment method', currency: 'Currency' };
      return M[f] || f;
    }

    /* Action / navigation commands (not field fills). NON-idempotent (scroll,
       create quote, …) so callers run them once per spoken phrase, never on a
       full-transcript re-parse. */
    function detectActions(text) {
      var t = ' ' + low(text) + ' ';
      var a = [];
      if (/\bscroll\w*\s+(?:to\s+)?(?:the\s+)?top\b|\bgo to (?:the )?top\b|\btop of (?:the )?(?:page|form|quote)\b/.test(t)) a.push({ action: 'scrollTop', label: 'Scroll to top' });
      else if (/\bscroll\w*\s+(?:to\s+)?(?:the\s+)?bottom\b|\bgo to (?:the )?bottom\b|\bbottom of (?:the )?(?:page|form|quote)\b/.test(t)) a.push({ action: 'scrollBottom', label: 'Scroll to bottom' });
      else if (/\b(?:scroll\w*\s+down|page down|further down|keep scrolling)\b/.test(t)) a.push({ action: 'scrollDown', label: 'Scroll down' });
      else if (/\b(?:scroll\w*\s+up|page up|back up)\b/.test(t)) a.push({ action: 'scrollUp', label: 'Scroll up' });
      if (/\banaly[sz]e\w*\s+(?:this\s+|the\s+|current\s+)?(?:page|screen|tab|website|site)\b|\bscan\s+(?:this\s+|the\s+)?(?:page|screen)\b|\bread\s+(?:this\s+|the\s+)?page\b/.test(t)) a.push({ action: 'analyze', label: 'Analyze this page' });
      if (/\b(?:new quote|start over|start a new quote|clear (?:the )?(?:form|quote)|reset (?:the )?(?:form|quote)|start fresh|start again|blank quote)\b/.test(t)) a.push({ action: 'newQuote', label: 'New quote' });
      else if (/\b(?:create|generate|make|download|build|finish|finalize|complete|export)\s+(?:the\s+|this\s+|a\s+|my\s+)?quote\b|\bdownload (?:the )?(?:pdf|quote)\b|\bgenerate (?:the )?pdf\b/.test(t)) a.push({ action: 'createQuote', label: 'Create quote' });
      if (/\b(?:show|open|view|see|expand|pull up)\s+(?:the\s+)?(?:details|breakdown|summary|full quote|quote details|totals?)\b/.test(t)) a.push({ action: 'showDetails', label: 'Show quote details' });
      else if (/\b(?:hide|close|collapse|dismiss)\s+(?:the\s+)?(?:details|breakdown|summary|totals?)\b/.test(t)) a.push({ action: 'hideDetails', label: 'Hide quote details' });
      if (/\b(?:open|show|go to)\s+(?:the\s+)?settings\b|\bopen (?:the )?pricing settings\b/.test(t)) a.push({ action: 'openSettings', label: 'Open settings' });
      var SEC = [
        { key: 'deal', re: /(?:kind of deal|deal section|the deal|deal card)/ },
        { key: 'selling', re: /(?:products? section|what are you selling|selling section|the products|products card)/ },
        { key: 'discounts', re: /(?:discounts? section|the discounts|discounts card)/ },
        { key: 'who', re: /(?:who'?s it for|customer section|who section|who card)/ },
      ];
      var openVerb = /\b(?:expand|open|show|unfold)\b/, closeVerb = /\b(?:collapse|close|hide|fold)\b/;
      SEC.forEach(function (s) {
        if (!s.re.test(t)) return;
        if (closeVerb.test(t)) a.push({ action: 'section', key: s.key, open: false, label: 'Collapse ' + s.key });
        else if (openVerb.test(t)) a.push({ action: 'section', key: s.key, open: true, label: 'Expand ' + s.key });
      });
      return a;
    }

    function parse(text, catalog) {
      var commands = [];
      var actions = detectActions(text);
      var t = ' ' + replaceNumberWords(low(text)) + ' ';
      t = t.replace(/\bpercent(?:age)?\b/g, '%').replace(/\bdollars?\b/g, ' ');
      function blank(s, e) { t = t.slice(0, s) + t.slice(s, e).replace(/[^ ]/g, ' ') + t.slice(e); }

      // 1. Percentages (margin / extra discount / annual increase)
      var pctRx = /(\d+(?:\.\d+)?)\s*%/g, pm;
      var pcts = [];
      while ((pm = pctRx.exec(t))) pcts.push({ val: parseFloat(pm[1]), start: pm.index, end: pm.index + pm[0].length });
      pcts.forEach(function (p) {
        // Classify by the NEAREST keyword on EITHER side of the % (within ~40
        // chars before OR after), so "fifteen percent discount", "discount of
        // fifteen percent" and "15% margin" all classify correctly. Nearest
        // wins; on a tie the prior precedence (margin > uplift > extra) is kept.
        var pre = t.slice(Math.max(0, p.start - 40), p.start);
        var post = t.slice(p.end, Math.min(t.length, p.end + 40));
        var nearest = function (re) {
          var d = Infinity, m, rx = new RegExp(re, 'g');
          while ((m = rx.exec(pre))) d = Math.min(d, pre.length - m.index);   // chars from a preceding match → %
          rx = new RegExp(re, 'g');
          while ((m = rx.exec(post))) d = Math.min(d, m.index + 1);           // chars from % → a following match
          return d;
        };
        var dMargin = nearest('\\bmargin\\b');
        var dUplift = nearest('\\b(?:increase|uplift|escalat\\w*)\\b');
        var dExtra = nearest('\\b(?:extra|additional|discount|sweetener)\\b');
        var dPartner = nearest('\\b(?:partner|reseller)\\b');
        var cands = [
          { f: 'margin', d: dMargin, pri: 3 },
          { f: 'uplift', d: dUplift, pri: 2 },
          { f: 'extra', d: dExtra, pri: 1 },
        ];
        var field = 'extra', best = Infinity, bestPri = -1;
        cands.forEach(function (c) { if (c.d < best || (c.d === best && c.pri > bestPri)) { best = c.d; bestPri = c.pri; field = c.f; } });
        if (best === Infinity) field = (dPartner !== Infinity) ? 'margin' : 'extra';
        if (field === 'margin') commands.push({ type: 'partner', margin: p.val, label: 'Partner margin → ' + p.val + '%' });
        else if (field === 'uplift') commands.push({ type: 'uplift', value: p.val, label: 'Annual increase → ' + p.val + '%' });
        else commands.push({ type: 'pct', field: 'extraPct', value: p.val, label: 'Extra discount → ' + p.val + '%' });
        blank(p.start, p.end);
      });

      // 2. Term (years / months)
      var yrRx = /(\d+(?:\.\d+)?)\s*(?:year|yr)s?\b/g, ym;
      while ((ym = yrRx.exec(t))) {
        var yrs = parseFloat(ym[1]);
        commands.push({ type: 'term', years: Math.max(1, Math.round(yrs)), months: Math.round(yrs * 12), label: 'Term → ' + (Math.round(yrs) === 1 ? '1 year' : Math.round(yrs) + ' years') });
        blank(ym.index, ym.index + ym[0].length);
      }
      var moRx = /(\d+)\s*(?:month|mo)s?\b/g, mm2;
      while ((mm2 = moRx.exec(t))) {
        var mo = parseInt(mm2[1], 10);
        commands.push({ type: 'term', months: mo, years: Math.max(1, Math.round(mo / 12)), label: 'Term → ' + mo + ' months' });
        blank(mm2.index, mm2.index + mm2[0].length);
      }

      // 2.5 Partner deal on/off (when no explicit margin % was said)
      var hasMargin = commands.some(function (c) { return c.type === 'partner'; });
      if (/\b(no|not a|without|remove|turn off|disable)\s+(partner|reseller)\b/.test(t)) commands.push({ type: 'partnerOff', label: 'Partner deal → off' });
      else if (!hasMargin && /\b(partner deal|partner pricing|reseller deal|partner discount|through a partner|through partner|sell through)\b/.test(t)) commands.push({ type: 'partner', label: 'Partner deal → on' });

      // 3. Premium support toggle
      if (/\b(no|without|remove|turn off|disable)\s+(premium\s+)?support\b/.test(t)) commands.push({ type: 'support', value: false, label: 'Premium support → off' });
      else if (/\b(premium\s+support|with support|add support|turn on support|enable support|support on)\b/.test(t)) commands.push({ type: 'support', value: true, label: 'Premium support → on' });

      // 4. Customer type / deal type
      if (/\b(net[- ]?new|new customer)\b/.test(t)) commands.push({ type: 'customerType', value: 'new', label: 'Customer type → Net new' });
      else if (/\b(current customer|existing customer|current account)\b/.test(t)) commands.push({ type: 'customerType', value: 'current', label: 'Customer type → Current' });
      if (/\badd[- ]?on (?:and|plus|\+) renewal\b/.test(t)) commands.push({ type: 'dealType', value: 'addonren', label: 'Deal type → Add-on + renewal' });
      else if (/\brenewal\b/.test(t) && !/\badd[- ]?on\b/.test(t)) commands.push({ type: 'dealType', value: 'ren', label: 'Deal type → Renewal' });
      else if (/\badd[- ]?on\b/.test(t)) commands.push({ type: 'dealType', value: 'addon', label: 'Deal type → Add-on' });

      // 5. Product quantities (and bare product mentions)
      var prods = findProducts(t, catalog);
      var byProduct = {};
      var barePhrase = {}; // multi-word product mentions with no nearby quantity
      prods.forEach(function (pr) {
        // A multi-word product name ("application workspace", "right click tools")
        // is a confident product mention even without a number, so it can add its
        // line on its own. Single-word aliases ("workspace", "insights") are too
        // easily said in passing, so they still require a quantity to add a line.
        if (/\s/.test(pr.phrase)) barePhrase[pr.id] = { id: pr.id, name: pr.name, unit: pr.unit };
        var numRx = /(\d[\d,]*)(?:\s*(endpoints?|end ?points?|devices?|machines?|nodes?|seats?|users?|licen[cs]es?))?/g, nm;
        var best = null, bestScore = 1e9;
        while ((nm = numRx.exec(t))) {
          if (!/\d/.test(nm[0])) continue;
          var npos = nm.index;
          var dist = npos >= pr.end ? (npos - pr.end) : (pr.start - (npos + nm[0].length));
          var score = dist - (nm[2] ? 25 : 0);
          // Window widened ~45 → 60 so a slightly farther "… needs 2,500 of them"
          // near a product mention still attaches (nearest-with-unit still wins).
          if (Math.abs(dist) <= 60 && score < bestScore) { bestScore = score; best = { qty: parseInt(nm[1].replace(/,/g, ''), 10), start: nm.index, end: nm.index + nm[0].length }; }
        }
        if (best && best.qty > 0) { byProduct[pr.id] = { id: pr.id, name: pr.name, unit: pr.unit, qty: best.qty, order: best.start }; blank(best.start, best.end); }
      });
      Object.keys(byProduct).forEach(function (id) {
        var b = byProduct[id];
        commands.push({ type: 'lineQty', productId: id, qty: b.qty, unit: b.unit,
          label: b.name + ' → ' + b.qty.toLocaleString('en-US') + ' ' + (b.unit === 'user' ? 'users' : 'endpoints') });
      });
      // A product named without any quantity ("selling Application Workspace to
      // Amazon") still adds its line; quantity keeps the app's own new-line
      // default (set later by the user). qty:null means "ensure the line exists".
      Object.keys(barePhrase).forEach(function (id) {
        if (byProduct[id]) return; // already added with a quantity
        var b = barePhrase[id];
        commands.push({ type: 'lineQty', productId: id, qty: null, unit: b.unit, label: b.name + ' → added' });
      });

      // 6. Scalar text fields — value ends at the first natural boundary.
      var raw = norm(text);
      var orig = raw.toLowerCase();   // stable — used for value-boundary detection
      var work = raw.toLowerCase();   // blanked as fields are consumed — used for keyword matching
      function blankWork(s, e) { work = work.slice(0, s) + work.slice(s, e).replace(/[^ ]/g, ' ') + work.slice(e); }
      var FIELD_DEFS = [
        { field: 'partnerEmail', kind: 'email', kw: ['partner email', 'reseller email'] },
        { field: 'email', kind: 'email', kw: ['email', 'e-mail', 'e mail'] },
        { field: 'partnerCompany', kind: 'text', kw: ['partner company', 'reseller company', 'partner name'] },
        { field: 'billingContact', kind: 'text', num: true, kw: ['billing contact', 'contact name', 'contact'] },
        { field: 'preparedBy', kind: 'text', num: true, kw: ['prepared by'] },
        { field: 'billToAddress', kind: 'text', kw: ['bill to address', 'bill-to address', 'billing address'] },
        { field: 'shipToAddress', kind: 'text', kw: ['ship to address', 'ship-to address', 'shipping address'] },
        { field: 'paymentTerms', kind: 'text', kw: ['payment terms'] },
        { field: 'paymentMethod', kind: 'text', kw: ['payment method'] },
        { field: 'currency', kind: 'text', num: true, kw: ['currency'] },
        { field: 'customer', kind: 'text', num: true, kw: ['customer', 'company name', 'company', 'account name'] },
      ];
      var ALL_KWS = [];
      FIELD_DEFS.forEach(function (d) { d.kw.forEach(function (k) { ALL_KWS.push(k); }); });
      var CMD_WORDS = ['partner', 'margin', 'extra', 'discount', 'premium support', 'term', 'renewal',
        'add-on', 'add on', 'net new', 'current customer', 'uplift', 'increase', 'escalation'];
      var prodPhrasesAll = [];
      (catalog || []).forEach(function (p) { productPhrases(p).forEach(function (ph) { prodPhrasesAll.push(ph); }); });
      function firstMatch(hay, phrases, from) {
        var best = -1;
        phrases.forEach(function (p) {
          var rx = new RegExp('\\b' + escapeRx(p) + '\\b', 'g'); rx.lastIndex = from;
          var mm; while ((mm = rx.exec(hay))) { if (mm.index > from) { if (best < 0 || mm.index < best) best = mm.index; break; } }
        });
        return best;
      }
      function valueEnd(vStart, numBound) {
        var end = raw.length;
        var rest = orig.slice(vStart);
        var ci = rest.search(/[,;]/); if (ci >= 0) end = Math.min(end, vStart + ci);
        // End at sentence punctuation — a period / question / exclamation that
        // closes a clause (followed by whitespace or end), so "customer Amazon.
        // Selling …" yields "Amazon", never "Amazon. Selling". An in-token dot
        // ("acme.com") is followed by a letter, so it is left alone.
        var si = rest.search(/[.?!](?:\s|$)/); if (si >= 0) end = Math.min(end, vStart + si);
        var kb = firstMatch(orig, ALL_KWS.concat(CMD_WORDS), vStart); if (kb > vStart) end = Math.min(end, kb);
        if (prodPhrasesAll.length) { var pb = firstMatch(orig, prodPhrasesAll, vStart); if (pb > vStart) end = Math.min(end, pb); }
        if (numBound) { var di = rest.search(/\b(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)\b/); if (di >= 0) end = Math.min(end, vStart + di); }
        return end;
      }
      // Order of operations: blank phrase-level matches ("new customer",
      // "current/existing customer", partner phrases) in the keyword-scan copy
      // BEFORE the scalar field scan, so the word "customer" inside "it's a new
      // customer" can never be mistaken for the start of a customer-name field.
      var PHRASE_BLANKS = [
        /\bnet[- ]?new\b/g, /\bnew customer\b/g, /\bcurrent customer\b/g,
        /\bexisting customer\b/g, /\bcurrent account\b/g, /\bsell through\b/g,
        /\b(?:through|via)\s+(?:a\s+)?(?:partner|reseller)\b/g,
        /\bpartner (?:deal|pricing|discount)\b/g, /\breseller deal\b/g,
      ];
      PHRASE_BLANKS.forEach(function (re) {
        work.replace(re, function (match, offset) { blankWork(offset, offset + match.length); return match; });
      });

      FIELD_DEFS.forEach(function (def) {
        for (var k = 0; k < def.kw.length; k++) {
          var rx = new RegExp('\\b' + escapeRx(def.kw[k]) + '\\b\\s*(?:is|=|:|are|equals|to)?\\s+', 'g');
          var m = rx.exec(work);
          if (!m) continue;
          var vStart = m.index + m[0].length;
          var vEnd = valueEnd(vStart, !!def.num);
          var value = norm(raw.slice(vStart, vEnd)).replace(/[,.;:]+$/, '');
          if (def.kind === 'email') {
            // An email field may only ever hold ONE valid address. Extract the
            // first valid match and discard the rest; a value with no valid email
            // is discarded (value stays '' → not stored below).
            var compact = spokenEmail(value);
            if (def.field === 'email') {
              // A fused "…partner email <addr>" (the two addresses run together by
              // speech-to-text) routes the SECOND address to partnerEmail; the
              // primary email keeps only the first valid one.
              var segs = compact.split(/\.*(?:partner|reseller)\s*email\.*/i);
              value = firstEmail(segs[0]);
              if (value && segs.length > 1) {
                var pe = firstEmail(segs.slice(1).join(' '));
                if (pe && !commands.some(function (c) { return c.type === 'scalar' && c.field === 'partnerEmail'; })) {
                  commands.push({ type: 'scalar', field: 'partnerEmail', value: pe, label: labelFor('partnerEmail') + ' → ' + pe });
                }
              }
            } else {
              value = firstEmail(compact);
            }
          }
          else value = value.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
          if (value) { commands.push({ type: 'scalar', field: def.field, value: value, label: labelFor(def.field) + ' → ' + value }); blankWork(m.index, vEnd); }
          break;
        }
      });

      // 7. Customer from natural prepositional phrasing — "selling/sell/quoting X
      // to <Name>", "quote for <Name>", "deal with <Name>", or a plain "for
      // <Name>". Additive fallback: runs only when the label-first scan above
      // didn't already capture a customer. The name ends at the first boundary —
      // a command word, product phrase, field keyword, percentage / number, a
      // connective (with / at / and / plus) or sentence punctuation.
      var haveCustomer = commands.some(function (c) { return c.type === 'scalar' && c.field === 'customer'; });
      if (!haveCustomer) {
        var STOP_LEAD = /^(?:the|a|an|our|their|this|that)\s+/i;
        var STOP_TAIL = /(?:^|\s)(?:with|at|for|to|of|and|plus|via|through|the|a|an|is|are|be|our|their|this|that)$/i;
        var trimName = function (s) {
          s = norm(s).replace(/[,.;:!?]+$/, '').replace(STOP_LEAD, '');
          var prev;
          do { prev = s; s = norm(s.replace(STOP_TAIL, '')).replace(/[,.;:!?]+$/, ''); } while (s !== prev);
          return norm(s);
        };
        var custEnd = function (vStart) {
          var end = valueEnd(vStart, true); // [,;] + field/command keywords + product phrases + numbers
          var rest = orig.slice(vStart);
          var pi = rest.search(/[.!?]/); if (pi >= 0) end = Math.min(end, vStart + pi);
          var wi = rest.search(/\b(?:with|at|plus|and)\b/); if (wi >= 0) end = Math.min(end, vStart + wi);
          return end;
        };
        var TRIGGERS = [
          { re: /\b(?:selling|sell|sold|reselling|quoting)\b[\s\S]*?\bto\s+/, strong: true },
          { re: /\bquote\b[\s\S]*?\bto\s+/, strong: true },
          { re: /\b(?:quote|quoting|quotes)\s+for\s+/, strong: true },
          { re: /\bdeal\s+(?:with|for)\s+/, strong: true },
          { re: /\bfor\s+/, strong: false },
        ];
        for (var ti = 0; ti < TRIGGERS.length; ti++) {
          var tm = TRIGGERS[ti].re.exec(orig);
          if (!tm) continue;
          var cStart = tm.index + tm[0].length;
          var cVal = raw.slice(cStart, custEnd(cStart)); // original case (for the proper-noun check)
          var name = trimName(cVal);
          if (!name || name.length < 2) continue;
          if (/^(?:new|current|existing|net[- ]?new)$/i.test(name)) continue; // a customer-TYPE word, not a name
          // A plain "for <Name>" is weak, so require a proper noun (capitalized in
          // the original), which the stronger verbs ("selling … to") don't need.
          if (!TRIGGERS[ti].strong && !/^[A-Z]/.test(cVal.replace(STOP_LEAD, '').replace(/^\s+/, ''))) continue;
          name = name.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
          commands.push({ type: 'scalar', field: 'customer', value: name, label: labelFor('customer') + ' → ' + name });
          break;
        }
      }

      return { commands: commands, actions: actions, recognized: commands.length > 0 || actions.length > 0 };
    }

    return { parse: parse };
  })();

  /* ========================================================================
     Applier — turn parsed commands into a quote patch (through setQ, exactly
     like a manual edit) and expand the sections being filled so the change is
     visible. De-dupes by target keeping the latest, so re-saying a value fixes it.
     ======================================================================== */
  function catalog() {
    return ((state.cfg && state.cfg.products) || []).map(function (p) { return { id: p.id, name: p.name, unit: p.unit }; });
  }
  function cmdKey(c) {
    if (c.type === 'lineQty') return 'line:' + c.productId;
    if (c.type === 'scalar' || c.type === 'pct') return 'f:' + c.field;
    if (c.type === 'partner' || c.type === 'partnerOff') return 'partner';
    return c.type;
  }

  // Build a setQ patch + labels from the FULL transcript's commands. Also opens
  // the sections being touched. Returns { patch, labels, hasChange }.
  function buildPatch(cmds) {
    var q = state.quote, patch = {}, labels = [];
    var lines = null, renew = null, touched = {};
    var isRenOnly = (q.customerType === 'current' && q.dealType === 'ren');
    var rules = (state.cfg && state.cfg.rules) || {};
    var ensureLines = function () { if (!lines) lines = q.lines.map(function (l) { return Object.assign({}, l); }); return lines; };
    var ensureRenew = function () { if (!renew) renew = (q.renewLines || []).map(function (l) { return Object.assign({}, l); }); return renew; };
    var clampPct = function (v, max) { return Math.max(0, Math.min(max == null ? 100 : max, +v || 0)); };
    // Default quantity for a brand-new line = the app's own "+ Add product"
    // default (minUsers for user products, 1000 for endpoint products).
    var defQty = function (productId) {
      var prod = ((state.cfg && state.cfg.products) || []).find(function (p) { return p.id === productId; }) || {};
      return prod.unit === 'user' ? ((rules.minUsers != null) ? rules.minUsers : 250) : 1000;
    };

    cmds.forEach(function (c) {
      if (c.type === 'lineQty') {
        // qty null = a bare product mention: ensure the line exists, but never
        // overwrite a quantity the user already has (or one said elsewhere).
        if (isRenOnly) { var rl = ensureRenew(); var ex = rl.find(function (l) { return l.productId === c.productId; }); if (ex) { if (c.qty != null) ex.qty = c.qty; } else rl.push({ id: uid(), productId: c.productId, qty: c.qty != null ? c.qty : defQty(c.productId), price: 0 }); }
        else { var ls = ensureLines(); var e2 = ls.find(function (l) { return l.productId === c.productId; }); if (e2) { if (c.qty != null) e2.qty = c.qty; } else ls.push({ id: uid(), productId: c.productId, qty: c.qty != null ? c.qty : defQty(c.productId) }); }
        touched.selling = 1;
      } else if (c.type === 'scalar') {
        patch[c.field] = c.value;
        touched.who = 1;
        if (['billToAddress', 'shipToAddress', 'billingContact', 'paymentMethod', 'paymentTerms', 'currency'].indexOf(c.field) > -1) state.billingOpen = true;
      } else if (c.type === 'pct') { patch[c.field] = clampPct(c.value, rules.maxExtra != null ? rules.maxExtra : 50); touched.discounts = 1; }
      else if (c.type === 'partner') { patch.partner = true; if (c.margin != null) patch[isRenOnly ? 'marginRenPct' : 'marginNewPct'] = clampPct(c.margin, 100); touched.discounts = 1; }
      else if (c.type === 'partnerOff') { patch.partner = false; touched.discounts = 1; }
      else if (c.type === 'support') { patch.supportAll = c.value; touched.selling = 1; }
      else if (c.type === 'uplift') { patch.uplift = true; if (c.value != null) patch.upliftPct = clampPct(c.value, 10); touched.selling = 1; }
      else if (c.type === 'term') { if (c.years != null) patch.years = c.years; if (c.months != null) patch.months = c.months; touched.deal = 1; }
      else if (c.type === 'customerType') { patch.customerType = c.value; touched.deal = 1; }
      else if (c.type === 'dealType') { patch.customerType = 'current'; patch.dealType = c.value; touched.deal = 1; }
      labels.push(c.label);
    });
    if (lines) patch.lines = lines;
    if (renew) patch.renewLines = renew;
    if (state.sections) Object.keys(touched).forEach(function (s) { state.sections[s] = true; });
    return { patch: patch, labels: labels, hasChange: Object.keys(patch).length > 0 };
  }

  // Parse the FULL running transcript and apply — called on every finalized
  // phrase so the form fills live and re-saying a value corrects it.
  function applyLive(fullText, interim) {
    var res = parser.parse(fullText, catalog());
    var map = {};
    res.commands.forEach(function (c) { map[cmdKey(c)] = c; }); // keep latest per target
    var cmds = Object.keys(map).map(function (k) { return map[k]; });
    var built = buildPatch(cmds);
    state.voice = Object.assign({ on: false, interim: '', finalText: '', error: '', heard: '', applied: [] }, state.voice || {},
      { on: true, interim: interim || '', finalText: fullText, applied: built.labels, error: '' });
    if (built.hasChange) setQ(built.patch); // persists + renders (fields + applied list)
    else render();
  }

  /* ---- action / navigation commands (run once per spoken phrase) ---- */
  function scrollBy(dir) {
    try {
      var amount = Math.round((window.innerHeight || 600) * 0.85) * dir;
      window.scrollBy({ top: amount, left: 0, behavior: 'smooth' });
    } catch (e) {
      try { var el = document.scrollingElement || document.documentElement || document.body; el.scrollTop += dir * 320; } catch (e2) {}
    }
  }
  function scrollTo(pos) {
    try {
      var el = document.scrollingElement || document.documentElement || document.body;
      var top = pos ? (el.scrollHeight || 999999) : 0;
      window.scrollTo({ top: top, left: 0, behavior: 'smooth' });
    } catch (e) {}
  }
  // Turn voice off cleanly (no editable recap) so another feature can take over.
  function handoff() {
    manualStop = true;
    teardown();
    setVoice({ on: false, interim: '', heard: '', applied: [] });
  }

  // Execute the actions parsed from a single phrase. Returns true if an action
  // ended the voice session (so the caller should stop processing this phrase).
  function runActions(segmentText) {
    var res = parser.parse(segmentText, catalog());
    var acts = res.actions || [];
    if (!acts.length) return false;
    var APP = window.SQG_APP || {};
    var ended = false;
    acts.forEach(function (act) {
      switch (act.action) {
        case 'scrollDown': scrollBy(1); flash('Scrolling down', 'ok'); break;
        case 'scrollUp': scrollBy(-1); flash('Scrolling up', 'ok'); break;
        case 'scrollTop': scrollTo(0); flash('Top of the form', 'ok'); break;
        case 'scrollBottom': scrollTo(1); flash('Bottom of the form', 'ok'); break;
        case 'analyze':
          // Hand off to "Analyze this page" (mutually exclusive with voice).
          handoff(); ended = true;
          if (window.SQG_ANALYZE && typeof window.SQG_ANALYZE.run === 'function') window.SQG_ANALYZE.run();
          break;
        case 'createQuote': flash('Creating quote…', 'ok'); if (typeof APP.createQuote === 'function') APP.createQuote(); break;
        case 'newQuote': if (typeof APP.promptNewQuote === 'function') APP.promptNewQuote(); break;
        case 'showDetails': if (typeof APP.showSheet === 'function') APP.showSheet(true); break;
        case 'hideDetails': if (typeof APP.showSheet === 'function') APP.showSheet(false); break;
        case 'openSettings': handoff(); ended = true; if (typeof APP.openSettings === 'function') APP.openSettings(); break;
        case 'section': if (typeof APP.setSection === 'function') APP.setSection(act.key, act.open); break;
      }
    });
    if (!ended) render(); // reflect any state change (sheet, section) while still listening
    return ended;
  }

  /* ---- lifecycle ----
     Robustness against "sticky / won't turn on": the LIVE recognizer object
     (`recog`) is the single source of truth. Every path that ends a session
     fully tears the recognizer down AND flips state.voice.on off, so the flag
     can never desync from reality; toggle() keys off `recog`, not the flag, so a
     stale flag can never block starting; and start() force-tears-down any
     lingering recognizer (instead of bailing) and retries once on the transient
     InvalidStateError browsers throw when a prior session hasn't fully ended. */

  // Detach handlers and abort the recognizer so it can never fire again.
  function teardown() {
    if (!recog) return;
    try { recog.onresult = null; recog.onerror = null; recog.onend = null; recog.onstart = null; } catch (e) {}
    try { recog.abort(); } catch (e) { try { recog.stop(); } catch (e2) {} }
    recog = null;
  }

  // A listening session ended (manual stop, hand-off, or the service ended on
  // its own): show the editable recap if anything was heard.
  function finalizeSession() {
    var text = transcript();
    var applied = (state.voice && state.voice.applied) || [];
    if (!text && !applied.length) {
      setVoice({ on: false, interim: '', heard: '' });
      flash('Didn’t catch anything — tap the microphone and try again', 'warn');
      return;
    }
    setVoice({ on: false, interim: '', heard: text }); // keep transcript editable for corrections
    if (applied.length) flash('Filled ' + applied.length + ' field' + (applied.length > 1 ? 's' : '') + ' from your voice', 'ok');
  }

  function stop() {
    var wasActive = !!recog || !!(state.voice && state.voice.on);
    manualStop = true;
    teardown();
    if (!wasActive) { setVoice({ on: false, interim: '' }); return; }
    finalizeSession();
  }

  function beginRecognition() {
    recog = new Rec();
    recog.lang = 'en-US';
    recog.continuous = true;
    recog.interimResults = true;

    recog.onstart = function () { manualStop = false; setVoice({ on: true }); }; // confirm the mic is truly live

    recog.onresult = function (ev) {
      var interim = '', newFinal = '', sawFinal = false;
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        var tt = (r[0] && r[0].transcript) ? r[0].transcript : '';
        if (r.isFinal) { finalText = (finalText + ' ' + tt).replace(/\s+/g, ' ').trim(); newFinal += ' ' + tt; sawFinal = true; }
        else interim += tt;
      }
      interim = interim.replace(/\s+/g, ' ').trim();
      if (sawFinal) {
        // Actions run from the NEW phrase only (fire-once); field fills re-read
        // the whole transcript (idempotent). Actions first, so an "analyze this
        // page" hand-off can take over before we bother rendering fields.
        if (runActions(newFinal)) return;   // an action ended the session (e.g. analyze)
        applyLive(finalText, interim);       // parse full transcript + fill live
      } else setVoice({ on: true, interim: interim, finalText: finalText });
    };

    recog.onerror = function (ev) {
      var code = ev && ev.error;
      // "aborted" is what a deliberate teardown/restart raises — not a user error.
      if (code === 'aborted') { return; }
      var msg = code === 'not-allowed' || code === 'service-not-allowed'
          ? 'Microphone blocked — allow mic access for the extension and try again'
        : code === 'no-speech' ? 'Didn’t hear anything — tap the microphone and try again'
        : code === 'audio-capture' ? 'No microphone found — check your mic and try again'
        : 'Voice input error — try again';
      manualStop = true; // the following onend must not be treated as an unexpected drop
      teardown();
      setVoice({ on: false, interim: '', heard: '', error: msg });
      flash(msg, 'warn');
    };

    recog.onend = function () {
      recog = null;
      if (manualStop) { manualStop = false; return; } // we ended it on purpose
      // The service ended on its own (silence/focus) while we thought we were on:
      // finalize cleanly so the button never sticks on "Listening".
      if (state.voice && state.voice.on) finalizeSession();
    };

    recog.start(); // may throw InvalidStateError if a prior session is still ending
  }

  function start() {
    if (!supported()) { flash('Voice input isn’t supported in this browser', 'warn'); return; }
    // Mutual exclusion — cancel any page analysis so the two never overlap.
    if (window.SQG_ANALYZE && typeof window.SQG_ANALYZE.cancel === 'function') window.SQG_ANALYZE.cancel();
    if (state.analyze) { state.analyze = null; }
    teardown();           // never bail on a stale recognizer — replace it
    finalText = '';
    manualStop = false;
    setVoice({ on: true, interim: '', finalText: '', error: '', heard: '', applied: [] });
    try {
      beginRecognition();
      flash('Listening… say products, discounts, term, customer — or a command', 'ok');
    } catch (e) {
      // Transient InvalidStateError (a prior session still ending) — retry once.
      recog = null;
      try {
        setTimeout(function () {
          if (!(state.voice && state.voice.on)) return; // user gave up meanwhile
          try { beginRecognition(); }
          catch (e2) { teardown(); setVoice({ on: false }); flash('Couldn’t start the microphone — tap the mic again', 'warn'); }
        }, 250);
      } catch (e3) { setVoice({ on: false }); flash('Couldn’t start the microphone — tap the mic again', 'warn'); }
    }
  }

  // Toggle keyed off the REAL recognizer, so a stale flag can never block start.
  function toggle() { if (recog) stop(); else start(); }

  // Re-apply an edited transcript (correction path after stopping).
  function reapply(text) {
    text = (text == null ? '' : String(text)).replace(/\s+/g, ' ').trim();
    if (!text) { flash('Nothing to apply — tap the microphone and try again', 'warn'); return; }
    finalText = text;
    var res = parser.parse(text, catalog());
    var map = {};
    res.commands.forEach(function (c) { map[cmdKey(c)] = c; });
    var cmds = Object.keys(map).map(function (k) { return map[k]; });
    var built = buildPatch(cmds);
    state.voice = Object.assign({ on: false, interim: '', finalText: '', error: '', heard: '', applied: [] }, state.voice || {},
      { on: false, heard: text, applied: built.labels });
    if (built.hasChange) { setQ(built.patch); flash('Applied ' + built.labels.length + ' field' + (built.labels.length > 1 ? 's' : ''), 'ok'); }
    else { render(); flash('Couldn’t pull any fields from that — try rephrasing', 'warn'); }
  }

  function done() { setVoice({ on: false, interim: '', heard: '', applied: [] }); }

  /* ---- UI ---- */
  function button() {
    if (!supported()) return null;
    var on = !!(state.voice && state.voice.on);
    // Locked out while "Analyze this page" is running — only one runs at a time.
    var analyzing = !on && window.SQG_ANALYZE && typeof window.SQG_ANALYZE.isRunning === 'function' && window.SQG_ANALYZE.isRunning();
    var btn = h('button', {
      class: 'sqg-mic-btn' + (on ? ' listening' : '') + (analyzing ? ' sqg-locked' : ''), type: 'button',
      disabled: analyzing ? 'disabled' : null,
      title: analyzing ? 'Analyzing the page… wait for it to finish' : (on ? 'Stop listening (fields fill live as you speak)' : 'Speak to fill the form live (uses your browser’s speech recognition)'),
      'aria-pressed': on ? 'true' : 'false', onClick: toggle,
    });
    var ico = h('span', { class: 'sqg-mic-ico' });
    ico.innerHTML = on ? SVG_STOP : SVG_MIC;
    btn.append(ico, h('span', null, on ? 'Listening — tap to stop' : 'Speak to fill'));
    return btn;
  }

  function chips(applied) {
    if (!applied || !applied.length) return null;
    var wrap = h('div', { class: 'sqg-voice-chips' });
    applied.forEach(function (l) { wrap.append(h('span', { class: 'sqg-voice-chip' }, l)); });
    return wrap;
  }

  // Live panel WHILE listening: indicator, running transcript, and the fields
  // filled so far — all updating as the user speaks.
  function liveStrip() {
    if (!(state.voice && state.voice.on)) return null;
    var txt = transcript();
    var applied = (state.voice && state.voice.applied) || [];
    var panel = h('div', { class: 'sqg-voice-live' },
      h('div', { class: 'sqg-voice-live-row' },
        h('span', { class: 'sqg-voice-dot' }),
        h('div', { class: 'sqg-voice-live-texts' },
          h('span', { class: 'sqg-voice-live-label' }, applied.length ? 'Listening — filling live' : 'Listening…'),
          h('span', { class: 'sqg-voice-text' }, txt || 'Fields: “Right Click Tools 2,500 endpoints, partner margin 20 percent, two year term.” Commands: “scroll down”, “analyze this page”, “show details”, “create quote”.')
        )));
    var c = chips(applied);
    if (c) panel.append(c);
    return panel;
  }

  // After stopping: recap of what was filled + editable transcript to correct
  // and Re-apply. Not shown while listening or when nothing was heard.
  function reviewBox() {
    var v = state.voice || {};
    if (v.on || (!v.heard && !(v.applied && v.applied.length))) return null;
    var ta = h('textarea', {
      class: 'sqg-voice-review-ta', dataK: 'sqg-voice-review', rows: 3,
      'aria-label': 'What we heard — edit and re-apply to correct', spellcheck: 'true',
      value: v.heard || '',
      onInput: function (e) { if (state.voice) state.voice.heard = e.target.value; },
    });
    var box = h('div', { class: 'sqg-voice-review' },
      h('span', { class: 'sqg-voice-review-title' }, (v.applied && v.applied.length) ? 'Filled live from your voice' : 'Here’s what I heard'));
    var c = chips(v.applied);
    if (c) box.append(c);
    box.append(
      h('span', { class: 'sqg-voice-review-sub' }, 'Fix any misheard word below and Re-apply:'),
      ta,
      h('p', { class: 'sqg-voice-review-note' },
        'Fields fill live as you speak — this uses your browser’s speech recognition. Re-saying a value (or editing here) corrects it.'),
      h('div', { class: 'sqg-voice-review-actions' },
        dsButton('Done', 'secondary', 'md', false, done),
        dsButton('Re-apply', 'primary', 'md', false, function () { reapply(ta.value); })
      ));
    return box;
  }

  return {
    button: button, liveStrip: liveStrip, reviewBox: reviewBox, toggle: toggle, supported: supported,
    stop: stop, isListening: function () { return !!(state.voice && state.voice.on); },
    _start: start, _stop: stop, _transcript: transcript, _reapply: reapply,
    _parse: function (text) { return parser.parse(text, catalog()); },
    _applyLive: applyLive, _buildPatch: buildPatch, _runActions: runActions,
  };
})();
