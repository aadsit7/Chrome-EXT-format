// Bookmarks Buddy — Google Sheet sync engine.
// ---------------------------------------------------------------------------
// Ported VERBATIM (URL + token + network behaviour) from the web app
// (index__26_.html) so the side panel loads the same apps from your Google
// Sheet on launch and writes every change back, with an offline outbox queue.
//
// This file is the DATA LAYER only. It does not touch the DOM or the React /
// dc-runtime view — the existing UI is unchanged. The component talks to it
// through a tiny "host" adapter (getState / onLoaded / uid) passed at
// construction time, and this module maps the sheet's columns to/from the
// exact bookmark object shape the component already expects.
//
// Manifest V3 clean: a plain local script, no eval / new Function / remote code.
// localStorage is used for the offline queue + an instant offline mirror, so no
// extra Chrome permission is required.
// ===========================================================================
(function () {
  'use strict';

  // --- SHEET config: copied verbatim from index__26_.html --------------------
  var CONFIG = {
    url: 'https://script.google.com/macros/s/AKfycbwXvgj1niSwrREBepEA9oO_YNBtgyq1vSdZPNclYBqMz0ytTI1r1sjUDxePExx5B0mOlA/exec',
    // EMBEDDED_APP_TOKEN — default app token baked into the build.
    embedded: 'c1XGANPfknryxC-49LbEhOljwWKwYIzo',
    LS_TOKEN: 'bookmarksBuddy.sidepanel.appToken',
    LS_OUTBOX: 'bookmarksBuddy.sidepanel.outbox.v1',
    LS_SYNCED: 'bookmarksBuddy.sidepanel.synced.v1'
  };

  function defaultUid() { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // host = {
  //   getState: () => ({ bookmarks, pages, pageNames }),   // current UI state
  //   onLoaded: (bookmarks, layout) => void,               // apply sheet data to UI
  //   uid:      () => string                               // id generator (optional)
  // }
  function SheetSync(host) {
    host = host || {};
    this.getState = host.getState || function () { return { bookmarks: [], pages: [], pageNames: [] }; };
    this.onLoaded = host.onLoaded || function () {};
    this.uid = host.uid || defaultUid;

    this.url = CONFIG.url;
    this.embedded = CONFIG.embedded;
    this.LS_TOKEN = CONFIG.LS_TOKEN;
    this.LS_OUTBOX = CONFIG.LS_OUTBOX;
    this.LS_SYNCED = CONFIG.LS_SYNCED;

    this.token = this.resolveToken();
    this.online = true;
    this.snapshot = Object.create(null);
    this.flushing = false;
    this.ready = false;
    this.seq = Date.now();
  }

  // -------- app-token handling (resolveAppToken + ?token= override) ----------
  // Priority: ?token= (query or hash) > saved token > EMBEDDED_APP_TOKEN.
  SheetSync.prototype.resolveToken = function () {
    try {
      var here = new URL(location.href);
      var q = here.searchParams.get('token') ||
        new URLSearchParams((location.hash || '').replace(/^#/, '')).get('token');
      if (q) { try { localStorage.setItem(this.LS_TOKEN, q); } catch (e) {} return q; }
    } catch (e) {}
    try { var saved = localStorage.getItem(this.LS_TOKEN); if (saved) return saved; } catch (e) {}
    return this.embedded;
  };

  SheetSync.prototype.enabled = function () { return !!(this.url && this.token); };

  // -------- network: GET getBookmarks + POST (text/plain, no preflight) ------
  // text/plain;charset=utf-8 keeps it a "simple" request, so the browser skips
  // the CORS preflight that Apps Script /exec can't answer. The token is
  // injected into the body at send time.
  SheetSync.prototype.post = function (payload) {
    var self = this;
    return fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: self.token }, payload))
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().catch(function () { return {}; });
    }).then(function (data) {
      if (data && data.ok === false) throw new Error(data.error || 'sheet rejected the write');
      return data;
    });
  };

  // apiGetBookmarks: GET with action=getBookmarks&token=…
  SheetSync.prototype.get = function () {
    var u = new URL(this.url);
    u.searchParams.set('action', 'getBookmarks');
    u.searchParams.set('token', this.token);
    return fetch(u.toString(), { method: 'GET' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (!data || !data.ok || !Array.isArray(data.bookmarks)) throw new Error('unexpected getBookmarks response');
      return data.bookmarks;
    });
  };

  // -------- offline outbox queue ---------------------------------------------
  SheetSync.prototype.loadOutbox = function () {
    try { var o = JSON.parse(localStorage.getItem(this.LS_OUTBOX) || '[]'); return Array.isArray(o) ? o : []; }
    catch (e) { return []; }
  };
  SheetSync.prototype.saveOutbox = function (q) { try { localStorage.setItem(this.LS_OUTBOX, JSON.stringify(q)); } catch (e) {} };
  SheetSync.prototype.enqueue = function (item) {
    var q = this.loadOutbox();
    // Collapse any earlier pending write for the same bookmark id.
    if (item.action === 'saveBookmark' || item.action === 'deleteBookmark') {
      var id = item.action === 'saveBookmark' ? item.bookmark['Bookmark ID'] : item.id;
      for (var i = q.length - 1; i >= 0; i--) {
        var it = q[i];
        var itId = it.action === 'saveBookmark' ? (it.bookmark && it.bookmark['Bookmark ID'])
          : it.action === 'deleteBookmark' ? it.id : undefined;
        if (itId !== undefined && itId === id) q.splice(i, 1);
      }
    }
    item.seq = ++this.seq; q.push(item); this.saveOutbox(q);
    if (this.online) this.flush();
  };
  SheetSync.prototype.flush = function () {
    var self = this;
    if (this.flushing || !this.enabled()) return Promise.resolve();
    this.flushing = true;
    function step() {
      var q = self.loadOutbox();
      if (!q.length) { self.online = true; return Promise.resolve(); }
      var item = q[0];
      var seq = item.seq, body = {};
      for (var k in item) if (k !== 'seq') body[k] = item[k];
      return self.post(body).then(function () {
        self.online = true;
        self.saveOutbox(self.loadOutbox().filter(function (x) { return x.seq !== item.seq; }));
        return step();
      }, function () { self.online = false; });
    }
    return step().then(function () { self.flushing = false; }, function () { self.flushing = false; });
  };

  // -------- springboard arrangement <-> sheet Folder/Page/Position -----------
  // Same encoding as the web app: Page = "n" or "n|Name"; Position = slot index
  // for a loose app, or "F<slot>:<index>" for an app inside a folder.
  SheetSync.prototype.placements = function () {
    var st = this.getState();
    var map = Object.create(null), placed = new Set();
    var pages = st.pages || [], names = st.pageNames || [];
    for (var p = 0; p < pages.length; p++) {
      var nm = names[p] && String(names[p]).trim();
      var pageField = nm ? ((p + 1) + '|' + nm) : String(p + 1);
      var page = pages[p] || [];
      for (var s = 0; s < page.length; s++) {
        var it = page[s]; if (!it) continue;
        if (it.type === 'app') { map[it.id] = { folder: '', page: pageField, position: s }; placed.add(it.id); }
        else if (it.type === 'folder') {
          for (var k = 0; k < it.items.length; k++) {
            var id = it.items[k];
            map[id] = { folder: it.name || 'Folder', page: pageField, position: 'F' + s + ':' + k };
            placed.add(id);
          }
        }
      }
    }
    var bms = st.bookmarks || [];
    for (var b = 0; b < bms.length; b++) if (!placed.has(bms[b].id)) map[bms[b].id] = { folder: '', page: '', position: '' };
    return map;
  };

  // Map one bookmark object -> a sheet row (the exact column names the sheet uses).
  SheetSync.prototype.row = function (bm, pl) {
    pl = pl || { folder: '', page: '', position: '' };
    if (!bm._dateAdded) bm._dateAdded = new Date().toISOString();
    var cell = function (v) { return (v == null || v === '' ? '' : String(v)); };
    return {
      'Bookmark ID': bm.id, 'Name': bm.name || '', 'URL': bm.url || '',
      'Folder': pl.folder != null ? pl.folder : '', 'Page': cell(pl.page), 'Position': cell(pl.position),
      'Owner (Profile ID)': bm._owner != null ? bm._owner : '',
      'Date Added': bm._dateAdded, 'Last Opened': bm._lastOpened != null ? bm._lastOpened : '',
      'Times Opened': bm._timesOpened != null ? bm._timesOpened : '',
      'Notes': bm.notes != null ? bm.notes : '',
      'Icon': /^https?:\/\//i.test(String(bm.icon || '').trim()) ? String(bm.icon).trim() : ''
    };
  };

  // Decode sheet rows' Folder/Page/Position into a springboard layout.
  SheetSync.prototype.buildLayout = function (items) {
    var pagesMap = [], names = [];
    for (var n = 0; n < items.length; n++) {
      var b = items[n];
      var ps = String(b.page == null ? '' : b.page);
      var pm = ps.match(/^\s*(\d+)\s*(?:\|([\s\S]*))?$/);
      var p = pm ? parseInt(pm[1], 10) : parseInt(ps, 10);
      var pname = pm && pm[2] != null ? pm[2].trim() : '';
      if (Number.isInteger(p) && p >= 1 && pname && !names[p - 1]) names[p - 1] = pname;
      var pos = String(b.position == null ? '' : b.position).trim();
      if (!Number.isInteger(p) || p < 1 || pos === '') continue;
      var pi = p - 1; if (!pagesMap[pi]) pagesMap[pi] = Object.create(null);
      var fm = pos.match(/^F(\d+):(\d+)$/);
      if (fm) {
        var slot = parseInt(fm[1], 10), idx = parseInt(fm[2], 10);
        var c = pagesMap[pi][slot];
        if (!c || c.type !== 'folder') { c = { type: 'folder', name: String(b.folder || 'Folder'), items: Object.create(null) }; pagesMap[pi][slot] = c; }
        c.items[idx] = b.id;
      } else {
        var slot2 = parseInt(pos, 10); if (!Number.isInteger(slot2)) continue;
        if (pagesMap[pi][slot2]) continue;
        pagesMap[pi][slot2] = { type: 'app', id: b.id };
      }
    }
    var pages = [], pageNames = [];
    var maxP = Math.max(pagesMap.length, names.length, 0);
    for (var pii = 0; pii < maxP; pii++) {
      var slotsObj = pagesMap[pii]; var cells = [];
      if (slotsObj) {
        var slots = Object.keys(slotsObj).map(Number).sort(function (a, b) { return a - b; });
        for (var si = 0; si < slots.length; si++) {
          var cc = slotsObj[slots[si]];
          if (cc.type === 'folder') {
            var ids = Object.keys(cc.items).map(Number).sort(function (a, b) { return a - b; }).map(function (k) { return cc.items[k]; });
            if (ids.length) cells.push({ type: 'folder', name: cc.name, items: ids });
          } else cells.push({ type: 'app', id: cc.id });
        }
      }
      pages.push(cells); pageNames.push(names[pii] || '');
    }
    return { pages: pages, pageNames: pageNames };
  };

  // -------- snapshot baseline + diff -----------------------------------------
  // Baseline the snapshot to the current UI state so push() won't echo it back.
  SheetSync.prototype.baseline = function () {
    var st = this.getState();
    var pl = this.placements();
    this.snapshot = Object.create(null);
    var bms = st.bookmarks || [];
    for (var i = 0; i < bms.length; i++) this.snapshot[bms[i].id] = JSON.stringify(this.row(bms[i], pl[bms[i].id]));
    try { localStorage.setItem(this.LS_SYNCED, '1'); } catch (e) {}
    this.ready = true;
    this.flush();
  };

  // Diff the current list against the last-known sheet state; queue only changes.
  SheetSync.prototype.push = function () {
    if (!this.enabled() || !this.ready) return;
    var st = this.getState();
    var pl = this.placements(); var seen = new Set();
    var bms = st.bookmarks || [];
    for (var i = 0; i < bms.length; i++) {
      var bm = bms[i]; seen.add(bm.id);
      var json = JSON.stringify(this.row(bm, pl[bm.id]));
      if (this.snapshot[bm.id] !== json) { this.snapshot[bm.id] = json; this.enqueue({ action: 'saveBookmark', bookmark: JSON.parse(json) }); }
    }
    for (var id in this.snapshot) if (!seen.has(id)) { delete this.snapshot[id]; this.enqueue({ action: 'deleteBookmark', id: id }); }
  };

  // -------- pull: GET the live list and hand it to the UI via the adapter ----
  SheetSync.prototype.pull = function () {
    var self = this;
    if (!this.enabled()) return Promise.resolve();
    return this.get().then(function (rows) {
      self.online = true;
      var str = function (v) { return (v == null ? '' : String(v)); };
      var remote = rows.map(function (r) {
        return {
          id: str(r['Bookmark ID']).trim() || self.uid(),
          name: str(r['Name']).trim(),
          url: str(r['URL']).trim(),
          notes: r['Notes'] != null ? String(r['Notes']) : '',
          icon: r['Icon'] != null ? String(r['Icon']) : '',
          folder: r['Folder'] != null ? r['Folder'] : '', page: r['Page'] != null ? r['Page'] : '', position: r['Position'] != null ? r['Position'] : '',
          _owner: r['Owner (Profile ID)'] != null ? r['Owner (Profile ID)'] : '',
          _dateAdded: r['Date Added'] != null ? String(r['Date Added']) : '',
          _lastOpened: r['Last Opened'] != null ? r['Last Opened'] : '',
          _timesOpened: r['Times Opened'] != null ? r['Times Opened'] : ''
        };
      }).filter(function (b) { return b.url; });
      // Adapter -> the exact object shape component-logic.js renders.
      var bookmarks = remote.map(function (b) {
        return { id: b.id, name: b.name, url: b.url, notes: b.notes, icon: b.icon, _owner: b._owner, _dateAdded: b._dateAdded, _lastOpened: b._lastOpened, _timesOpened: b._timesOpened };
      });
      var layout = self.buildLayout(remote);
      // Hand off to the UI. The host applies the layout (its own pagination of
      // any unplaced apps), mirrors to localStorage, then calls baseline().
      self.onLoaded(bookmarks, layout);
    }, function (e) {
      self.online = false;
      console.warn('Bookmarks Buddy: could not reach the sheet — using local data.', e);
    });
  };

  // -------- boot --------------------------------------------------------------
  SheetSync.prototype.boot = function () {
    var self = this;
    // Console helper, same name/behaviour as the web app.
    try {
      window.bbSetToken = function (t) {
        self.token = String(t || '').trim();
        try { if (self.token) localStorage.setItem(self.LS_TOKEN, self.token); else localStorage.removeItem(self.LS_TOKEN); } catch (e) {}
        if (self.enabled()) self.pull();
        return self.token ? 'app_token set — syncing with your sheet' : 'app_token cleared';
      };
    } catch (e) {}
    if (this.enabled()) this.pull();
  };

  window.BBSheetSync = SheetSync;
})();
