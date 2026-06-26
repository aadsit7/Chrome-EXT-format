// Bookmarks Buddy — component logic.
// Extracted verbatim from the original <script type="text/x-dc"> block and
// wrapped in a real function so it runs without eval/new Function, which
// Manifest V3's content-security-policy forbids. dc-runtime's evalDcLogic
// has been patched to call this factory instead of compiling the source.
window.__dcComponentFactory = function (DCLogic, StreamableLogic, React) {

class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.PER_PAGE = 16;
    this.STALL_MS = 5000;          // recognition is considered stalled after this many ms with no events
    this._opened = [];             // window references we opened by voice/tap (for "close tabs")
    this.LS_B = 'bookmarksBuddy.sidepanel.bookmarks.v1';
    this.LS_L = 'bookmarksBuddy.sidepanel.layout.v1';
    this.LS_S = 'bookmarksBuddy.sidepanel.settings.v1';
    this.STARTERS = [
      { name: 'Gmail', url: 'gmail.com' }, { name: 'Calendar', url: 'calendar.google.com' },
      { name: 'Drive', url: 'drive.google.com' }, { name: 'YouTube', url: 'youtube.com' },
      { name: 'Notion', url: 'notion.so' }, { name: 'Slack', url: 'slack.com' },
      { name: 'Salesforce', url: 'salesforce.com' }, { name: 'GitHub', url: 'github.com' },
      { name: 'LinkedIn', url: 'linkedin.com' }, { name: 'ChatGPT', url: 'chatgpt.com' },
      { name: 'Figma', url: 'figma.com' }, { name: 'Amazon', url: 'amazon.com' }
    ];
    this.state = {
      bookmarks: [], pages: [], pageNames: [], currentPage: 0,
      search: '', adding: false, settingsOpen: false, folderOpen: null, folderEdit: false,
      editMode: false, voiceOpen: false, listening: false, interim: '', heard: '',
      draftName: '', draftUrl: '', dark: false, speak: false,
      editing: null, editName: '', editUrl: '', editIcon: '', editNotes: '', editConfirmDelete: false,
      choosing: null, choiceQuery: '',
      toast: '', toastIcon: '', srSupported: !!(window.SpeechRecognition || window.webkitSpeechRecognition)
    };
    this.loadData();
    this._attached = false;
    this._toastT = null;
  }

  /* ---------- persistence ---------- */
  loadData() {
    let bms = null, layout = null, settings = null;
    try { const v = JSON.parse(localStorage.getItem(this.LS_B) || 'null'); if (Array.isArray(v)) bms = v; } catch {}
    if (!bms) {
      try { const v = JSON.parse(localStorage.getItem('bookmarksBuddy.bookmarks.v1') || 'null'); if (Array.isArray(v) && v.length) bms = v; } catch {}
    }
    if (!bms || !bms.length) bms = this.STARTERS.map((s, i) => ({ id: 'b' + i, name: s.name, url: s.url }));
    bms = bms.filter(x => x && x.url).map(x => ({ id: x.id || this.uid(), name: x.name || '', url: x.url, notes: x.notes || '', icon: x.icon || '' }));
    this.state.bookmarks = bms;

    try { layout = JSON.parse(localStorage.getItem(this.LS_L) || 'null'); } catch {}
    if (!layout) layout = this.deriveExternalLayout(bms);
    this.applyLayout(layout, bms);

    try { settings = JSON.parse(localStorage.getItem(this.LS_S) || 'null'); } catch {}
    if (settings && typeof settings === 'object') {
      this.state.dark = !!settings.dark; this.state.speak = !!settings.speak;
    }
  }
  // Try to honor the user's existing springboard organization from the live app.
  deriveExternalLayout(bms) {
    try {
      const l = JSON.parse(localStorage.getItem('bookmarksBuddy.layout.v1') || 'null');
      if (!l || !Array.isArray(l.pages)) return null;
      const ids = new Set(bms.map(b => b.id));
      const pages = l.pages.map(pg => (pg || []).map(c => {
        if (!c) return null;
        if (c.type === 'folder') {
          const items = (c.items || []).map(it => it && it.id).filter(id => ids.has(id));
          return items.length ? { type: 'folder', name: c.name || 'Folder', items } : null;
        }
        return ids.has(c.id) ? { type: 'app', id: c.id } : null;
      }).filter(Boolean)).filter(pg => pg.length);
      if (!pages.length) return null;
      return { pages, pageNames: Array.isArray(l.pageNames) ? l.pageNames : [] };
    } catch { return null; }
  }
  applyLayout(layout, bms) {
    const placed = new Set();
    let pages = [];
    if (layout && Array.isArray(layout.pages)) {
      pages = layout.pages.map(pg => pg.map(c => {
        if (c.type === 'folder') { c.items.forEach(id => placed.add(id)); return { type: 'folder', name: c.name, items: c.items.slice() }; }
        placed.add(c.id); return { type: 'app', id: c.id };
      }));
      this.state.pageNames = (layout.pageNames || []).slice();
    }
    // paginate any unplaced bookmarks
    const rest = bms.filter(b => !placed.has(b.id));
    if (!pages.length) {
      for (let i = 0; i < rest.length; i += this.PER_PAGE) pages.push(rest.slice(i, i + this.PER_PAGE).map(b => ({ type: 'app', id: b.id })));
    } else if (rest.length) {
      const last = pages[pages.length - 1];
      rest.forEach(b => { if (last.length < this.PER_PAGE) last.push({ type: 'app', id: b.id }); else pages.push([{ type: 'app', id: b.id }]); });
    }
    if (!pages.length) pages = [[]];
    this.state.pages = pages;
  }
  save() {
    try { localStorage.setItem(this.LS_B, JSON.stringify(this.state.bookmarks)); } catch {}
    try { localStorage.setItem(this.LS_L, JSON.stringify({ pages: this.state.pages, pageNames: this.state.pageNames })); } catch {}
    // Mirror every change up to the Google Sheet (no-op until the first pull
    // has baselined us, and a no-op when no token is configured).
    try { this.sheetSync(); } catch {}
  }
  saveSettings() { try { localStorage.setItem(this.LS_S, JSON.stringify({ dark: this.state.dark, speak: this.state.speak })); } catch {} }

  /* ================================================================
   * Google Sheet backend — ported from the web app (index_26) so the
   * extension loads the same bookmarks/apps from your Google Sheet,
   * keeps the springboard arrangement (pages, folders, order) in the
   * sheet's Folder/Page/Position columns, and writes changes back.
   * localStorage stays on as an instant, offline mirror. With no token
   * the whole layer is dormant and the app is localStorage-only.
   * ================================================================ */
  sheetBoot() {
    if (this._sheet) return;
    const C = {
      url: 'https://script.google.com/macros/s/AKfycbwXvgj1niSwrREBepEA9oO_YNBtgyq1vSdZPNclYBqMz0ytTI1r1sjUDxePExx5B0mOlA/exec',
      embedded: 'c1XGANPfknryxC-49LbEhOljwWKwYIzo',
      LS_TOKEN: 'bookmarksBuddy.sidepanel.appToken',
      LS_OUTBOX: 'bookmarksBuddy.sidepanel.outbox.v1',
      LS_SYNCED: 'bookmarksBuddy.sidepanel.synced.v1'
    };
    this._sheet = Object.assign({}, C, {
      token: this.sheetResolveToken(C),
      online: true, snapshot: Object.create(null), flushing: false, ready: false, seq: Date.now()
    });
    // Console helper, same name/behaviour as the web app.
    try {
      window.bbSetToken = (t) => {
        this._sheet.token = String(t || '').trim();
        try { if (this._sheet.token) localStorage.setItem(C.LS_TOKEN, this._sheet.token); else localStorage.removeItem(C.LS_TOKEN); } catch {}
        if (this.sheetEnabled()) this.syncFromSheet();
        return this._sheet.token ? 'app_token set — syncing with your sheet' : 'app_token cleared';
      };
    } catch {}
    if (this.sheetEnabled()) this.syncFromSheet();
  }
  sheetResolveToken(C) {
    try {
      const here = new URL(location.href);
      const q = here.searchParams.get('token') || new URLSearchParams((location.hash || '').replace(/^#/, '')).get('token');
      if (q) { try { localStorage.setItem(C.LS_TOKEN, q); } catch {} return q; }
    } catch {}
    try { const saved = localStorage.getItem(C.LS_TOKEN); if (saved) return saved; } catch {}
    return C.embedded;
  }
  sheetEnabled() { return !!(this._sheet && this._sheet.url && this._sheet.token); }
  async sheetPost(payload) {
    // text/plain keeps it a "simple" request (no CORS preflight Apps Script can't answer).
    const res = await fetch(this._sheet.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: this._sheet.token }, payload))
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let data = {}; try { data = await res.json(); } catch {}
    if (data && data.ok === false) throw new Error(data.error || 'sheet rejected the write');
    return data;
  }
  async sheetGet() {
    const u = new URL(this._sheet.url);
    u.searchParams.set('action', 'getBookmarks');
    u.searchParams.set('token', this._sheet.token);
    const res = await fetch(u.toString(), { method: 'GET' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || !data.ok || !Array.isArray(data.bookmarks)) throw new Error('unexpected getBookmarks response');
    return data.bookmarks;
  }
  /* offline write queue */
  sheetLoadOutbox() { try { const o = JSON.parse(localStorage.getItem(this._sheet.LS_OUTBOX) || '[]'); return Array.isArray(o) ? o : []; } catch { return []; } }
  sheetSaveOutbox(q) { try { localStorage.setItem(this._sheet.LS_OUTBOX, JSON.stringify(q)); } catch {} }
  sheetEnqueue(item) {
    const q = this.sheetLoadOutbox();
    if (item.action === 'saveBookmark' || item.action === 'deleteBookmark') {
      const id = item.action === 'saveBookmark' ? item.bookmark['Bookmark ID'] : item.id;
      for (let i = q.length - 1; i >= 0; i--) {
        const it = q[i];
        const itId = it.action === 'saveBookmark' ? (it.bookmark && it.bookmark['Bookmark ID']) : it.action === 'deleteBookmark' ? it.id : undefined;
        if (itId !== undefined && itId === id) q.splice(i, 1);
      }
    }
    item.seq = ++this._sheet.seq; q.push(item); this.sheetSaveOutbox(q);
    if (this._sheet.online) this.sheetFlush();
  }
  async sheetFlush() {
    if (this._sheet.flushing || !this.sheetEnabled()) return;
    this._sheet.flushing = true;
    try {
      while (true) {
        const q = this.sheetLoadOutbox();
        if (!q.length) { this._sheet.online = true; break; }
        const item = q[0];
        try { const { seq, ...body } = item; await this.sheetPost(body); }
        catch { this._sheet.online = false; break; }
        this._sheet.online = true;
        this.sheetSaveOutbox(this.sheetLoadOutbox().filter(x => x.seq !== item.seq));
      }
    } finally { this._sheet.flushing = false; }
  }
  /* springboard arrangement <-> sheet columns (same encoding as the web app) */
  sheetPlacements() {
    const map = Object.create(null); const placed = new Set();
    const pages = this.state.pages || [], names = this.state.pageNames || [];
    for (let p = 0; p < pages.length; p++) {
      const nm = names[p] && String(names[p]).trim();
      const pageField = nm ? ((p + 1) + '|' + nm) : String(p + 1);
      const page = pages[p] || [];
      for (let s = 0; s < page.length; s++) {
        const it = page[s]; if (!it) continue;
        if (it.type === 'app') { map[it.id] = { folder: '', page: pageField, position: s }; placed.add(it.id); }
        else if (it.type === 'folder') { for (let k = 0; k < it.items.length; k++) { const id = it.items[k]; map[id] = { folder: it.name || 'Folder', page: pageField, position: 'F' + s + ':' + k }; placed.add(id); } }
      }
    }
    for (const b of this.state.bookmarks) if (!placed.has(b.id)) map[b.id] = { folder: '', page: '', position: '' };
    return map;
  }
  sheetRow(bm, pl) {
    pl = pl || { folder: '', page: '', position: '' };
    if (!bm._dateAdded) bm._dateAdded = new Date().toISOString();
    const cell = v => (v == null || v === '' ? '' : String(v));
    return {
      'Bookmark ID': bm.id, 'Name': bm.name || '', 'URL': bm.url || '',
      'Folder': pl.folder != null ? pl.folder : '', 'Page': cell(pl.page), 'Position': cell(pl.position),
      'Owner (Profile ID)': bm._owner != null ? bm._owner : '',
      'Date Added': bm._dateAdded, 'Last Opened': bm._lastOpened != null ? bm._lastOpened : '', 'Times Opened': bm._timesOpened != null ? bm._timesOpened : '',
      'Notes': bm.notes != null ? bm.notes : '',
      'Icon': /^https?:\/\//i.test(String(bm.icon || '').trim()) ? String(bm.icon).trim() : ''
    };
  }
  // Diff the current list against the last-known sheet state; queue only changes.
  sheetSync() {
    if (!this.sheetEnabled() || !this._sheet.ready) return;
    const pl = this.sheetPlacements(); const seen = new Set();
    for (const bm of this.state.bookmarks) {
      seen.add(bm.id);
      const json = JSON.stringify(this.sheetRow(bm, pl[bm.id]));
      if (this._sheet.snapshot[bm.id] !== json) { this._sheet.snapshot[bm.id] = json; this.sheetEnqueue({ action: 'saveBookmark', bookmark: JSON.parse(json) }); }
    }
    for (const id of Object.keys(this._sheet.snapshot)) if (!seen.has(id)) { delete this._sheet.snapshot[id]; this.sheetEnqueue({ action: 'deleteBookmark', id }); }
  }
  // Decode the sheet rows' Folder/Page/Position into a springboard layout.
  sheetBuildLayout(items) {
    const pagesMap = []; const names = [];
    for (const b of items) {
      const ps = String(b.page == null ? '' : b.page);
      const pm = ps.match(/^\s*(\d+)\s*(?:\|([\s\S]*))?$/);
      const p = pm ? parseInt(pm[1], 10) : parseInt(ps, 10);
      const pname = pm && pm[2] != null ? pm[2].trim() : '';
      if (Number.isInteger(p) && p >= 1 && pname && !names[p - 1]) names[p - 1] = pname;
      const pos = String(b.position == null ? '' : b.position).trim();
      if (!Number.isInteger(p) || p < 1 || pos === '') continue;
      const pi = p - 1; if (!pagesMap[pi]) pagesMap[pi] = Object.create(null);
      const fm = pos.match(/^F(\d+):(\d+)$/);
      if (fm) {
        const slot = parseInt(fm[1], 10), idx = parseInt(fm[2], 10);
        let c = pagesMap[pi][slot];
        if (!c || c.type !== 'folder') { c = { type: 'folder', name: String(b.folder || 'Folder'), items: Object.create(null) }; pagesMap[pi][slot] = c; }
        c.items[idx] = b.id;
      } else {
        const slot = parseInt(pos, 10); if (!Number.isInteger(slot)) continue;
        if (pagesMap[pi][slot]) continue;
        pagesMap[pi][slot] = { type: 'app', id: b.id };
      }
    }
    const pages = [], pageNames = [];
    const maxP = Math.max(pagesMap.length, names.length, 0);
    for (let pi = 0; pi < maxP; pi++) {
      const slotsObj = pagesMap[pi]; const cells = [];
      if (slotsObj) {
        const slots = Object.keys(slotsObj).map(Number).sort((a, b) => a - b);
        for (const s of slots) {
          const c = slotsObj[s];
          if (c.type === 'folder') { const ids = Object.keys(c.items).map(Number).sort((a, b) => a - b).map(k => c.items[k]); if (ids.length) cells.push({ type: 'folder', name: c.name, items: ids }); }
          else cells.push({ type: 'app', id: c.id });
        }
      }
      pages.push(cells); pageNames.push(names[pi] || '');
    }
    return { pages, pageNames };
  }
  async syncFromSheet() {
    if (!this.sheetEnabled()) return;
    let rows;
    try { rows = await this.sheetGet(); }
    catch (e) { this._sheet.online = false; console.warn('Bookmarks Buddy: could not reach the sheet — using local data.', e); return; }
    this._sheet.online = true;
    const str = v => (v == null ? '' : String(v));
    const remote = rows.map(r => ({
      id: str(r['Bookmark ID']).trim() || this.uid(),
      name: str(r['Name']).trim(),
      url: str(r['URL']).trim(),
      notes: r['Notes'] != null ? String(r['Notes']) : '',
      icon: r['Icon'] != null ? String(r['Icon']) : '',
      folder: r['Folder'] != null ? r['Folder'] : '', page: r['Page'] != null ? r['Page'] : '', position: r['Position'] != null ? r['Position'] : '',
      _owner: r['Owner (Profile ID)'] != null ? r['Owner (Profile ID)'] : '',
      _dateAdded: r['Date Added'] != null ? String(r['Date Added']) : '',
      _lastOpened: r['Last Opened'] != null ? r['Last Opened'] : '',
      _timesOpened: r['Times Opened'] != null ? r['Times Opened'] : ''
    })).filter(b => b.url);
    // The sheet is authoritative — the extension shows exactly your sheet.
    this.state.bookmarks = remote.map(b => ({ id: b.id, name: b.name, url: b.url, notes: b.notes, icon: b.icon, _owner: b._owner, _dateAdded: b._dateAdded, _lastOpened: b._lastOpened, _timesOpened: b._timesOpened }));
    this.applyLayout(this.sheetBuildLayout(remote), this.state.bookmarks);
    try { localStorage.setItem(this._sheet.LS_SYNCED, '1'); } catch {}
    try { localStorage.setItem(this.LS_B, JSON.stringify(this.state.bookmarks)); } catch {}
    try { localStorage.setItem(this.LS_L, JSON.stringify({ pages: this.state.pages, pageNames: this.state.pageNames })); } catch {}
    // Baseline the snapshot to what we just loaded so save() won't echo it back.
    const pl = this.sheetPlacements(); this._sheet.snapshot = Object.create(null);
    for (const bm of this.state.bookmarks) this._sheet.snapshot[bm.id] = JSON.stringify(this.sheetRow(bm, pl[bm.id]));
    this._sheet.ready = true;
    let cur = this.state.currentPage; if (cur >= this.state.pages.length) cur = Math.max(0, this.state.pages.length - 1);
    this.setState({ bookmarks: this.state.bookmarks, pages: this.state.pages, pageNames: this.state.pageNames, currentPage: cur });
    this.sheetFlush();
  }
  // Launch the microphone listener on open (as requested).
  autoStartMic() {
    if (this._autoMic) return; this._autoMic = true;
    setTimeout(() => { try { if (!this.state.listening) this.startListen(); } catch {} }, 350);
  }
  uid() { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ---------- url / matching helpers (ported) ---------- */
  ensureScheme(u) { u = String(u || '').trim(); if (!u) return ''; if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(mailto:|tel:)/i.test(u)) return u; return 'https://' + u.replace(/^\/+/, ''); }
  looksLikeUrl(u) { u = String(u || '').trim(); if (!u) return false; if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return true; return /^[^\s.]+\.[^\s.]{2,}/.test(u); }
  hostOf(u) { try { return new URL(this.ensureScheme(u)).hostname.replace(/^www\./, ''); } catch { return ''; } }
  hostCore(u) { const h = this.hostOf(u); if (!h) return ''; const p = h.split('.').filter(Boolean); if (p.length <= 1) return h; const t2 = p.slice(-2).join('.'); const multi = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(t2); return (multi ? p[p.length - 3] : p[p.length - 2]) || p[0]; }
  favicon(u) { const h = this.hostOf(u); return h ? 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(h) + '&sz=64' : ''; }
  iconFor(bm) { return String(bm && bm.icon || '').trim() || this.favicon(bm ? bm.url : ''); }
  letterOf(bm) { const n = (bm.name || this.hostCore(bm.url) || '?').trim(); return (n[0] || '?').toUpperCase(); }
  grad(seed) { const s = String(seed || '?'); let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } const hue = (h >>> 0) % 360; return 'linear-gradient(135deg,hsl(' + hue + ',72%,60%),hsl(' + ((hue + 42) % 360) + ',70%,47%))'; }
  normalize(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(); }
  lev(a, b) { a = a || ''; b = b || ''; if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length; let prev = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { let cur = [i]; for (let j = 1; j <= b.length; j++) { const c = a[i - 1] === b[j - 1] ? 0 : 1; cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c); } prev = cur; } return prev[b.length]; }
  sim(a, b) { a = a || ''; b = b || ''; if (!a || !b) return 0; const m = Math.max(a.length, b.length); return m ? 1 - this.lev(a, b) / m : 0; }
  // ---- speech-robust matching helpers ----
  // Common ways the speech engine mangles popular site names. These are SAFE
  // spelling/spacing fixes ("g mail" -> "gmail"): they're added as extra query
  // variants, never used to rename what the user actually said, so they can only
  // help a correct match and never cause a wrong one.
  aliasMap() {
    return this._aliasMap || (this._aliasMap = {
      'g mail': 'gmail', 'google mail': 'gmail',
      'you tube': 'youtube', 'u tube': 'youtube', 'utube': 'youtube',
      'linked in': 'linkedin', 'fig ma': 'figma',
      'chat gpt': 'chatgpt', 'chat g p t': 'chatgpt', 'chatgbt': 'chatgpt', 'chat gbt': 'chatgpt',
      'google drive': 'drive', 'g drive': 'drive',
      'google calendar': 'calendar', 'g calendar': 'calendar', 'g cal': 'calendar',
      'google docs': 'docs', 'google sheets': 'sheets', 'google slides': 'slides',
      'sales force': 'salesforce', 'git hub': 'github', 'face book': 'facebook',
      'whats app': 'whatsapp', 'what s app': 'whatsapp', 'insta': 'instagram', 'the gram': 'instagram',
      'note ion': 'notion', 'no shun': 'notion', 'red it': 'reddit', 'micro soft': 'microsoft',
      'out look': 'outlook', 'drop box': 'dropbox', 'sound cloud': 'soundcloud'
    });
  }
  // A compact Soundex-style key, used only as a last-resort tie-breaker for
  // consonant-preserving mis-hears (e.g. "figma" vs "fig mah").
  phon(s) {
    s = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!s) return '';
    const map = { b: '1', f: '1', p: '1', v: '1', c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2', d: '3', t: '3', l: '4', m: '5', n: '5', r: '6' };
    const first = s[0]; let code = ''; let prev = map[first] || '';
    for (let i = 1; i < s.length; i++) { const ch = s[i]; const c = map[ch]; if (c && c !== prev) code += c; if (ch !== 'h' && ch !== 'w') prev = c || ''; }
    return (first + code).slice(0, 6);
  }
  // Build the set of query strings we'll try when matching: the normalized form,
  // a de-spaced form ("g mail" -> "gmail"), plus alias-expanded variants.
  prepQuery(query) {
    const base = this.normalize(query);
    const variants = new Set();
    const add = v => { v = (v || '').trim(); if (v) variants.add(v); };
    add(base); add(base.replace(/\s+/g, ''));
    let aliased = base;
    for (const k in this.aliasMap()) if (aliased.includes(k)) aliased = aliased.split(k).join(this.aliasMap()[k]);
    add(aliased); add(aliased.replace(/\s+/g, ''));
    return { variants: [...variants], phon: this.phon(base.replace(/\s+/g, '')), raw: base };
  }
  scoreBookmark(prep, bm) {
    // Accept a raw string for backward-compatibility.
    if (typeof prep === 'string') prep = this.prepQuery(prep);
    const variants = prep.variants || []; if (!variants.length) return 0;
    const name = this.normalize(bm.name), core = this.normalize(this.hostCore(bm.url)), host = this.normalize(this.hostOf(bm.url).replace(/\./g, ' '));
    const nameFlat = name.replace(/\s+/g, '');
    let best = 0;
    for (const q of variants) {
      if (!q) continue;
      for (const c of [name, nameFlat, core]) { if (!c) continue; if (c === q) return 1; best = Math.max(best, this.sim(q, c)); }
      for (const c of [name, nameFlat, core, host]) { if (!c) continue; if (c.includes(q) || q.includes(c)) { const r = Math.min(q.length, c.length) / Math.max(q.length, c.length); best = Math.max(best, 0.78 + 0.2 * r); } }
      const qt = q.split(' ').filter(Boolean); const hay = (name + ' ' + host + ' ' + core).trim();
      if (qt.length && qt.every(w => hay.includes(w))) best = Math.max(best, 0.9);
      const hw = hay.split(' ').filter(Boolean);
      for (const w of qt) for (const h of hw) if (w.length >= 3 && h.length >= 3) best = Math.max(best, 0.7 * this.sim(w, h));
      const notes = this.normalize(bm.notes);
      if (notes && q.length >= 3 && notes.includes(q)) { const r = Math.min(q.length, notes.length) / Math.max(q.length, notes.length); best = Math.max(best, 0.6 + 0.18 * r); }
    }
    // Phonetic last resort — only a mild boost, never enough to beat a real match.
    if (best < 0.86 && prep.phon) { for (const c of [nameFlat, core]) { if (c && this.phon(c) === prep.phon) { best = Math.max(best, 0.85); break; } } }
    return best;
  }
  // Rank every bookmark for a prepared query, best first.
  rankBookmarks(prep) {
    return this.state.bookmarks.map(bm => ({ bm, s: this.scoreBookmark(prep, bm) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  }
  matchBookmark(q, th) { const prep = typeof q === 'string' ? this.prepQuery(q) : q; let best = null; for (const bm of this.state.bookmarks) { const s = this.scoreBookmark(prep, bm); if (s >= th && (!best || s > best.s)) best = { bm, s }; } return best; }
  allFolders() { const out = []; for (const pg of this.state.pages) for (const c of pg) if (c && c.type === 'folder') out.push(c); return out; }
  scoreFolder(q, f) { q = this.normalize(q).replace(/\b(folder|group)\b/g, ' ').replace(/\s+/g, ' ').trim(); const n = this.normalize(f.name); if (!q || !n) return 0; if (n === q) return 1; let best = this.sim(q, n); if (n.includes(q) || q.includes(n)) { const r = Math.min(q.length, n.length) / Math.max(q.length, n.length); best = Math.max(best, 0.78 + 0.2 * r); } const qt = q.split(' ').filter(Boolean); if (qt.length && qt.every(w => n.includes(w))) best = Math.max(best, 0.9); return best; }
  matchFolder(q, th) { let best = null; for (const f of this.allFolders()) { const s = this.scoreFolder(q, f); if (s >= th && (!best || s > best.s)) best = { f, s }; } return best; }

  /* ---------- voice command grammar (ported, trimmed) ---------- */
  parsePageNav(raw) {
    const t = this.normalize(raw); if (!t) return null;
    if (/\b(next|forward)\s+page\b/.test(t) || /\bpage\s+(forward|right|over)\b/.test(t)) return { to: this.state.currentPage + 1, rel: true };
    if (/\b(previous|prev|last|back|backward)\s+page\b/.test(t) || /\bgo\s+back\s+(a\s+)?page\b/.test(t) || /\bpage\s+(back|left|before)\b/.test(t)) return { to: this.state.currentPage - 1, rel: true };
    const hasPage = /\bpage\b/.test(t);
    const NUM = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10 };
    if (hasPage) { const dm = t.match(/\b(\d{1,2})\b/); let n = dm ? parseInt(dm[1], 10) : null; if (n == null) for (const w in NUM) if (new RegExp('\\b' + w + '\\b').test(t)) n = NUM[w]; if (n != null) return { to: n - 1 }; }
    const strong = /\b(go to|goto|switch to|jump to|take me to|navigate to)\b/.test(t);
    if (hasPage || strong) { const q = t.replace(/\b(go to|goto|switch to|jump to|take me to|navigate to|open|show|the)\b/g, ' ').replace(/\bpage\b/g, ' ').replace(/\s+/g, ' ').trim(); if (q) for (let i = 0; i < this.state.pages.length; i++) if (q === this.normalize(this.pageName(i))) return { to: i }; }
    return null;
  }
  parseCommand(raw) {
    const t = ' ' + this.normalize(raw) + ' ';
    if (/\b(stop listening|quit listening|turn (it |yourself )?off|go to sleep|stop now)\b/.test(t)) return { kind: 'stop' };
    if (/\bclose\b/.test(t) && /\b(tabs?|windows?|them|those|these|everything|all|it|that)\b/.test(t)) return { kind: 'close' };
    if (/\b(what can you do|help me out|show help|list (my )?bookmarks|what bookmarks)\b/.test(t)) return { kind: 'help' };
    const addM = (' ' + String(raw).toLowerCase().replace(/[^a-z0-9\s.\-]/g, ' ').replace(/\s+/g, ' ').trim() + ' ').match(/\b(add a bookmark for|new bookmark for|add a bookmark|new bookmark|bookmark|add|save|remember)\b/);
    if (addM) { const rawQ = addM.input.slice(addM.index + addM[0].length).replace(/\b(a|an|the|please|for me|to my (bookmarks|favorites))\b/g, ' ').replace(/\s+/g, ' ').trim(); return { kind: 'add', query: this.normalize(rawQ), rawQuery: rawQ }; }
    const m = t.match(/\b(open up|open|launch|go to|goto|pull up|bring up|navigate to|take me to|show me|load up|load|start up|start|fire up|jump to|switch to|visit|head to|get me)\b/);
    let query, explicit;
    if (m) { query = t.slice(m.index + m[0].length); explicit = true; } else { query = t; explicit = false; }
    query = ' ' + query + ' ';
    query = query.replace(/\b(in|on)\s+(a\s+)?(new\s+)?(tab|window|browser)\b/g, ' ').replace(/\b(please|for me|right now|now|real quick|hey|ok|okay|can you|could you|i want to|i need to)\b/g, ' ').replace(/\b(website|web site|the site|site|the page|page|the app|dot com|dot org|dot net)\b/g, ' ').replace(/\b(my|the|a|an|to|up|new|tab|window)\b/g, ' ').replace(/\s+/g, ' ').trim();
    return { kind: explicit ? 'open' : 'maybe', query };
  }
  // Decide exactly which bookmark/folder a spoken phrase means. The guiding rule
  // is accuracy over eagerness: open immediately only when there is a clear,
  // unambiguous winner; when two sites are plausibly close, return the short list
  // so the user can confirm (via the chooser) rather than risk opening the wrong
  // one.
  resolveTarget(query) {
    const prep = this.prepQuery(query); if (!prep.variants.length) return null;
    const q = prep.variants[0];
    const wantsFolder = /\b(folder|group)\b/.test(q);
    const ranked = this.rankBookmarks(prep);
    const fm = this.matchFolder(q, wantsFolder ? 0.34 : 0.52);
    const best = ranked[0] || null, second = ranked[1] || null;

    if (wantsFolder && fm && (!best || fm.s >= best.s)) return { kind: 'folder', folder: fm.f, confident: true };

    const FLOOR = 0.42, STRONG = 0.86, GAP = 0.12;
    if (best && best.s >= FLOOR) {
      // A folder that clearly beats the best bookmark wins.
      if (fm && fm.s > best.s + GAP) return { kind: 'folder', folder: fm.f, confident: true };
      // Exact hit, or a strong winner that's well clear of the runner-up → open.
      const clearWinner = best.s >= 0.999 || (best.s >= STRONG && (!second || best.s - second.s >= GAP));
      if (clearWinner) return { kind: 'bookmark', bm: best.bm, confident: true };
      // Otherwise it's ambiguous: offer the close candidates for a one-tap or one-word confirm.
      const choices = ranked.filter(x => x.s >= 0.5).slice(0, 4).map(x => x.bm);
      if (choices.length > 1) return { kind: 'choose', choices };
      return { kind: 'bookmark', bm: best.bm, confident: false };
    }
    if (fm) return { kind: 'folder', folder: fm.f, confident: true };
    return null;
  }
  handleTranscript(raw) {
    const text = String(raw).trim(); if (!text) return;
    // Dictation: while a text field is focused, type the spoken words into it
    // instead of running commands — but still honour "stop listening".
    const field = this.activeField();
    if (field) {
      const c0 = this.parseCommand(text);
      if (c0.kind === 'stop') { this.stopListen(); return; }
      this.dictate(field, text); return;
    }
    // If a disambiguation chooser is open, let the spoken words pick from it
    // ("the second one", "Gmail", "cancel") before anything else.
    if (this.state.choosing) { if (this.pickFromChoices(text)) return; }
    const nav = this.parsePageNav(text);
    if (nav) { this.applyNav(nav); return; }
    const cmd = this.parseCommand(text);
    if (cmd.kind === 'stop') { this.stopListen(); return; }
    if (cmd.kind === 'close') { this.closeOpened(); return; }
    if (cmd.kind === 'help') { this.toast('Say “open” + a site, “next page”, or “add Notion”', 'sparkles'); return; }
    if (cmd.kind === 'add') { if (cmd.rawQuery) this.addByVoice(cmd.rawQuery); else this.toast('Say a site to add, e.g. “add Notion”', 'mic'); return; }
    if (cmd.kind === 'maybe') {
      // No explicit "open" verb — this may just be ambient speech, so only act on
      // a near-perfect, unambiguous match (never guess from a bare phrase).
      const prep = this.prepQuery(cmd.query);
      const ranked = this.rankBookmarks(prep);
      const top = ranked[0], second = ranked[1];
      if (top && top.s >= 0.97 && (!second || top.s - second.s >= 0.1)) { this.openBookmark(top.bm, true); return; }
      const f = this.allFolders().find(f => this.normalize(f.name) === prep.variants[0]);
      if (f) this.openFolderVoice(f);
      return;
    }
    if (!cmd.query) { this.toast('Say “open” and a site name', 'mic'); return; }
    const tg = this.resolveTarget(cmd.query);
    if (!tg) { this.toast('No site matches “' + cmd.query + '”', 'search-x'); return; }
    if (tg.kind === 'choose') { this.offerChoices(tg.choices, cmd.query); return; }
    if (tg.kind === 'bookmark') this.openBookmark(tg.bm, true);
    else this.openFolderVoice(tg.folder);
  }
  // Present the close candidates and wait for a tap or a spoken pick. Listening
  // stays on so the user can simply say the number or the clearer name.
  offerChoices(choices, query) {
    this.setState({ choosing: (choices || []).slice(0, 4), choiceQuery: query || '' });
    this.toast('Which one? Tap it or say the number', 'sparkles');
    this.speakIf('Which one did you mean?');
  }
  // Resolve a spoken phrase against an open chooser. Returns true if it consumed
  // the phrase (picked, or cancelled); false to let normal handling try instead.
  pickFromChoices(text) {
    const list = this.state.choosing; if (!list || !list.length) return false;
    const t = this.normalize(text);
    if (/\b(cancel|never mind|nevermind|none|forget it|no thanks)\b/.test(t)) { this.setState({ choosing: null, choiceQuery: '' }); return true; }
    // Pick the EARLIEST number word in the phrase so "the second one" reads as
    // 2 (not the trailing pronoun "one"). Ordinals win ties at the same index.
    const NUM = { first: 1, second: 2, third: 3, fourth: 4, one: 1, two: 2, three: 3, four: 4, '1': 1, '2': 2, '3': 3, '4': 4 };
    let n = null, at = Infinity, ord = false;
    for (const w in NUM) {
      const m = t.match(new RegExp('\\b' + w + '\\b'));
      if (!m) continue;
      const isOrd = /first|second|third|fourth/.test(w);
      if (m.index < at || (m.index === at && isOrd && !ord)) { at = m.index; n = NUM[w]; ord = isOrd; }
    }
    if (n != null && n >= 1 && n <= list.length) { const bm = list[n - 1]; this.setState({ choosing: null, choiceQuery: '' }); this.openBookmark(bm, true); return true; }
    // Try the spoken name against just the offered candidates.
    const prep = this.prepQuery(text);
    let best = null; for (const bm of list) { const s = this.scoreBookmark(prep, bm); if (!best || s > best.s) best = { bm, s }; }
    if (best && best.s >= 0.7) { this.setState({ choosing: null, choiceQuery: '' }); this.openBookmark(best.bm, true); return true; }
    return false;
  }
  // The focused text field within our app, if any (used for dictation).
  activeField() {
    const el = document.activeElement;
    if (!el) return null;
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return null;
    if (tag === 'INPUT' && !/^(text|search|url|email|tel|number|password|)$/i.test(el.type || 'text')) return null;
    if (!el.closest || !el.closest('.bb-root')) return null;
    // The search box invites spoken commands ("or say open…"), so it stays a
    // command target rather than a dictation sink.
    if (el.hasAttribute('data-no-dictate')) return null;
    return el;
  }
  // Append dictated words to a (React-controlled) field and notify React so its
  // state updates exactly as if the user had typed.
  dictate(el, text) {
    const cur = el.value || '';
    const sep = cur && !/\s$/.test(cur) ? ' ' : '';
    const next = cur + sep + text.trim();
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, next); else el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    this.setState({ heard: text.trim() });
  }
  // Briefly pulse the matched tile on the springboard so the user sees the hit.
  highlightTile(id) {
    this._hitId = id;
    if (this._hitT) { clearTimeout(this._hitT); this._hitT = null; }
    this.applyHit();
    this._hitT = setTimeout(() => { this._hitId = null; this.applyHit(); this._hitT = null; }, 1300);
  }
  applyHit() {
    const root = document.querySelector('.bb-root'); if (!root) return;
    root.querySelectorAll('.bb-tile.bb-hit').forEach(t => t.classList.remove('bb-hit'));
    if (!this._hitId) return;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(this._hitId) : String(this._hitId).replace(/"/g, '\\"');
    const cell = root.querySelector('.bb-cell[data-id="' + sel + '"]');
    const tile = cell && cell.querySelector('.bb-tile');
    if (tile) tile.classList.add('bb-hit');
  }
  // Tuck the big voice overlay away without stopping the session's listener.
  hideVoiceOverlay() { if (this.state.voiceOpen) this.setState({ voiceOpen: false }); }
  applyNav(nav) {
    const n = this.state.pages.length, to = nav.to;
    if (to < 0 || to >= n) { this.toast(nav.rel ? (to < 0 ? 'First page' : 'Last page') : 'No such page', 'panel-left'); return; }
    this.setState({ currentPage: to, search: '' });
    this.toast(this.pageName(to), 'panel-left');
    this.speakIf('Showing ' + this.pageName(to));
  }
  pageName(i) { return (this.state.pageNames[i] || '').trim() || ('Page ' + (i + 1)); }

  /* ---------- actions ---------- */
  // Open a URL the same way the rest of the app does (window.open from the
  // panel), but keep the returned window reference so "close tabs" can shut the
  // ones voice opened and so the tile can be tracked.
  openUrl(url) {
    url = this.ensureScheme(url); if (!url) return null;
    let w = null;
    try { w = window.open(url, '_blank'); if (w) w.opener = null; } catch {}
    if (w) { this._opened = this._opened.filter(x => x && !x.closed); this._opened.push(w); }
    return w;
  }
  // Close every tab/window we opened this session.
  closeOpened() {
    const live = (this._opened || []).filter(x => x && !x.closed);
    let n = 0;
    live.forEach(w => { try { w.close(); n++; } catch {} });
    this._opened = [];
    this.toast(n ? ('Closed ' + n + (n === 1 ? ' tab' : ' tabs')) : 'Nothing to close', 'x');
    this.speakIf(n ? ('Closed ' + n + (n === 1 ? ' tab' : ' tabs')) : 'Nothing to close');
  }
  openBookmark(bm, viaVoice) {
    if (!bm) return; const url = this.ensureScheme(bm.url);
    if (!url) { this.toast('That site has no address', 'triangle-alert'); return; }
    if (this.state.choosing) this.setState({ choosing: null, choiceQuery: '' });
    this.openUrl(url);
    this.toast('Opening ' + (bm.name || this.hostCore(bm.url)), 'external-link');
    this.speakIf('Opening ' + (bm.name || this.hostCore(bm.url)));
    if (viaVoice) {
      this.highlightTile(bm.id);
      // Keep listening for the whole session — only clear the heard label and,
      // if the big voice overlay happens to be open, tuck it away.
      this.setState({ heard: bm.name || this.hostCore(bm.url) });
      setTimeout(() => { this.hideVoiceOverlay(); this.setState({ heard: '' }); }, 1400);
    }
  }
  openFolderModal(f) { this.setState({ folderOpen: f, folderEdit: false, voiceOpen: false }); this.stopRec(); }
  // Voice "open <folder>" fans the folder out, opening every site it holds (web
  // app behaviour), while keeping the listener alive.
  openFolderVoice(f) {
    if (!f) return;
    f.items.forEach(id => { const bm = this.state.bookmarks.find(b => b.id === id); if (bm) this.openUrl(bm.url); });
    this.toast('Opening ' + f.items.length + ' sites', 'layers');
    this.speakIf('Opening ' + f.name);
    this.setState({ heard: f.name });
    setTimeout(() => { this.hideVoiceOverlay(); this.setState({ heard: '' }); }, 1400);
  }
  openFolderAllFn() { const f = this.state.folderOpen; if (!f) return; f.items.forEach(id => { const bm = this.state.bookmarks.find(b => b.id === id); if (bm) this.openUrl(bm.url); }); this.toast('Opening ' + f.items.length + ' sites', 'layers'); this.setState({ folderOpen: null, folderEdit: false }); }
  addBookmark(name, url, silent) {
    url = String(url || '').trim(); name = String(name || '').trim();
    if (!url) { this.toast('Enter a web address', 'triangle-alert'); return false; }
    if (!this.looksLikeUrl(url)) { this.toast('That doesn’t look like a web address', 'triangle-alert'); return false; }
    if (!name) name = this.hostCore(url).replace(/^\w/, c => c.toUpperCase());
    const id = this.uid();
    const bms = this.state.bookmarks.concat([{ id, name, url, notes: '', icon: '' }]);
    const pages = this.state.pages.slice();
    let pi = this.state.currentPage;
    if (!pages[pi]) pi = pages.length - 1;
    if (pages[pi].length >= this.PER_PAGE) { pages.push([]); pi = pages.length - 1; }
    pages[pi] = pages[pi].concat([{ type: 'app', id }]);
    this.setState({ bookmarks: bms, pages, currentPage: pi }, () => this.save());
    if (!silent) this.toast('Added ' + name, 'check');
    return true;
  }
  addByVoice(rawQuery) {
    const q = rawQuery.trim();
    if (this.looksLikeUrl(q)) { this.addBookmark('', q); return; }
    const known = this.STARTERS.find(s => this.normalize(s.name) === this.normalize(q));
    if (known) this.addBookmark(known.name, known.url);
    else this.addBookmark(q.replace(/^\w/, c => c.toUpperCase()), q.toLowerCase().replace(/\s+/g, '') + '.com');
  }
  deleteBookmark(id) {
    const bms = this.state.bookmarks.filter(b => b.id !== id);
    const pages = this.state.pages.map(pg => pg.map(c => {
      if (c.type === 'folder') { const items = c.items.filter(x => x !== id); return items.length ? { ...c, items } : null; }
      return c.id === id ? null : c;
    }).filter(Boolean));
    while (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();
    let cur = Math.min(this.state.currentPage, pages.length - 1);
    this.setState({ bookmarks: bms, pages, currentPage: cur }, () => this.save());
    this.toast('Removed', 'trash-2');
  }

  /* ---------- per-bookmark editing (matches the web app's edit flow) ----------
   * Opened by tapping a tile while the springboard is in edit (jiggle) mode.
   * Edits the same fields the web version exposes — Name, URL, Icon, Notes —
   * writes them back onto the bookmark in place (its page/slot is untouched),
   * and persists through the existing save() -> sheetSync() outbox path so the
   * change reaches the Google Sheet and follows you to other devices. Delete
   * reuses the same confirm-then-remove flow the web app uses. */
  openEdit(id) {
    const bm = this.state.bookmarks.find(b => b.id === id);
    if (!bm) return;
    this.setState({
      editing: id,
      editName: bm.name || '', editUrl: bm.url || '',
      editIcon: bm.icon || '', editNotes: bm.notes || '',
      editConfirmDelete: false
    });
  }
  closeEdit() { this.setState({ editing: null, editConfirmDelete: false }); }
  saveEdit() {
    const id = this.state.editing; if (!id) return;
    const url = String(this.state.editUrl || '').trim();
    if (!url) { this.toast('Enter a web address', 'triangle-alert'); return; }
    if (!this.looksLikeUrl(url)) { this.toast('That doesn’t look like a web address', 'triangle-alert'); return; }
    let name = String(this.state.editName || '').trim();
    if (!name) name = this.hostCore(url).replace(/^\w/, c => c.toUpperCase());
    const icon = String(this.state.editIcon || '').trim();
    const notes = String(this.state.editNotes || '');
    // Update the bookmark in place — its springboard slot/page is left alone, so
    // editing never moves a tile. sheetSync() diffs and queues only this change.
    const bms = this.state.bookmarks.map(b => b.id === id ? { ...b, name, url, icon, notes } : b);
    this.setState({ bookmarks: bms, editing: null, editConfirmDelete: false }, () => this.save());
    this.toast('Saved', 'check');
  }
  confirmDeleteEdit() {
    const id = this.state.editing; if (!id) return;
    this.setState({ editing: null, editConfirmDelete: false });
    this.deleteBookmark(id);
  }

  /* ---------- voice lifecycle ---------- */
  ensureRec() {
    if (!this.state.srSupported) return null;
    if (this._rec) return this._rec;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new SR(); r.continuous = true; r.interimResults = true; r.lang = 'en-US';
    r.onresult = (e) => {
      this._lastEvt = Date.now(); let interim = '', fin = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const res = e.results[i]; const t = res[0] && res[0].transcript || ''; if (res.isFinal) fin += t + ' '; else interim += t; }
      if (fin) { this.setState({ interim: '' }); this.handleTranscript(fin); }
      else if (interim) this.setState({ interim: interim.trim() });
    };
    r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.stopListen(); this.toast('Allow microphone access, then try again', 'mic-off'); } };
    // Any sign of life resets the stall clock so the watchdog never aborts a
    // healthy recognizer mid-utterance; only a truly silent (zombie) one trips it.
    const bump = () => { this._lastEvt = Date.now(); };
    r.onstart = () => { this._running = true; bump(); };
    r.onaudiostart = bump; r.onsoundstart = bump; r.onspeechstart = bump; r.onaudioend = bump;
    r.onend = () => { this._running = false; if (this._want && this.state.listening) this.kick(); };
    this._rec = r; return r;
  }
  kick(attempt = 0) { if (!this._want || !this.state.listening || this._running) return; const r = this.ensureRec(); if (!r) return; try { r.start(); } catch (err) { if (/already started/i.test(err && err.message || '')) return; if (attempt < 6) setTimeout(() => this.kick(attempt + 1), 200 * (attempt + 1)); } }
  startListen() {
    const r = this.ensureRec();
    if (!r) { this.setState({ voiceOpen: true }); return; }
    this.holdMic();
    this._want = true; this.setState({ listening: true, interim: '', heard: '' }); this.kick();
    // Reliability watchdog. Web Speech silently dies on long sessions, so every
    // few seconds we (a) revive a recognizer that has stopped and (b) abort()+
    // restart one that is "running" but has gone silent past STALL_MS (a zombie).
    if (!this._wd) this._wd = setInterval(() => {
      if (!this._want || !this.state.listening) return;
      this.holdMic();
      if (!this._running) { this.kick(); return; }
      if (this._lastEvt && Date.now() - this._lastEvt > this.STALL_MS) {
        this._lastEvt = Date.now();
        try { this._rec.abort(); } catch {}   // onend -> kick() brings it straight back
      }
    }, 2500);
  }
  // Hold one live mic stream open for the whole session so the recognizer (and
  // the watchdog) stay warm. Only requested when we don't already have a live
  // track, so a granted permission is never re-prompted.
  holdMic() {
    if (this._mic && this._mic.getTracks().some(t => t.readyState === 'live')) return;
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(s => { this._mic = s; }).catch(() => {});
    }
  }
  stopRec() { this._want = false; if (this._rec) { try { this._rec.stop(); } catch {} } if (this._mic) { this._mic.getTracks().forEach(t => t.stop()); this._mic = null; } }
  stopListen() { this.stopRec(); if (this._wd) { clearInterval(this._wd); this._wd = null; } this.setState({ listening: false, interim: '' }); }
  launchVoiceFn() { this.setState({ voiceOpen: true, settingsOpen: false, adding: false, folderOpen: null, search: '' }); this.startListen(); }
  closeVoiceFn() { this.stopListen(); this.setState({ voiceOpen: false }); }
  speakIf(text) { if (this.state.speak && window.speechSynthesis) { try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch {} } }

  /* ---------- toast ---------- */
  toast(msg, icon) { if (this._toastT) clearTimeout(this._toastT); this.setState({ toast: msg, toastIcon: icon || 'info' }); this._toastT = setTimeout(() => this.setState({ toast: '' }), 2600); }

  /* ---------- theme + lifecycle ---------- */
  themeVars() {
    const d = this.state.dark;
    return d ? {
      '--bb-wall': 'radial-gradient(120% 80% at 80% -10%, rgba(49,209,255,.18), transparent 55%), radial-gradient(110% 70% at 0% 100%, rgba(3,114,255,.22), transparent 60%), linear-gradient(165deg,#0a0f2e,#070a1f)',
      '--bb-fg': '#eaf0ff', '--bb-fg-soft': '#93a3cf', '--bb-label': '#eef3ff', '--bb-label-shadow': 'rgba(0,0,8,.55)',
      '--bb-tile': '#fbfcff', '--bb-tile-bd': 'rgba(255,255,255,.10)', '--bb-tile-sh': '0 6px 18px rgba(0,0,0,.5)',
      '--bb-glass': 'rgba(28,38,76,.55)', '--bb-glass-bd': 'rgba(255,255,255,.13)', '--bb-glass-sh': '0 10px 30px rgba(0,0,0,.4)',
      '--bb-ctl': 'rgba(255,255,255,.10)', '--bb-search-bg': 'rgba(255,255,255,.08)', '--bb-dot': 'rgba(255,255,255,.32)',
      '--bb-folder': 'rgba(40,52,96,.6)', '--bb-folder-panel': 'rgba(20,28,60,.7)', '--bb-scrim': 'rgba(4,8,24,.6)', '--bb-scrim2': 'rgba(0,0,0,.5)',
      '--bb-sheet': '#121935', '--bb-input-bg': 'rgba(255,255,255,.06)', '--bb-input-bd': 'rgba(255,255,255,.14)',
      '--bb-accent': '#3a8bff', '--bb-accent2': '#31D1FF', '--bb-toast': '#070b22', '--bb-ease': 'cubic-bezier(.16,1,.3,1)',
      '--bb-orb-bg': this.state.listening ? '#fff' : '#0372FF', '--bb-orb-col': this.state.listening ? '#0372FF' : '#fff',
      '--bb-orb-sh': this.state.listening ? '0 0 0 8px rgba(49,209,255,.28),0 12px 40px rgba(0,0,0,.5)' : '0 12px 36px rgba(3,114,255,.5)'
    } : {
      '--bb-wall': 'radial-gradient(120% 78% at 82% -8%, rgba(49,209,255,.20), transparent 52%), radial-gradient(110% 72% at -5% 102%, rgba(3,114,255,.14), transparent 58%), linear-gradient(168deg,#f4f8ff 0%,#e7ecfa 100%)',
      '--bb-fg': '#161F5B', '--bb-fg-soft': '#5a6792', '--bb-label': '#1b245f', '--bb-label-shadow': 'rgba(255,255,255,.7)',
      '--bb-tile': '#ffffff', '--bb-tile-bd': 'rgba(120,130,160,.16)', '--bb-tile-sh': '0 6px 16px rgba(40,50,90,.15),0 1px 3px rgba(40,50,90,.10)',
      '--bb-glass': 'rgba(255,255,255,.6)', '--bb-glass-bd': 'rgba(255,255,255,.75)', '--bb-glass-sh': '0 8px 28px rgba(30,40,90,.13)',
      '--bb-ctl': 'rgba(255,255,255,.85)', '--bb-search-bg': 'rgba(255,255,255,.72)', '--bb-dot': 'rgba(30,40,90,.24)',
      '--bb-folder': 'rgba(255,255,255,.5)', '--bb-folder-panel': 'rgba(255,255,255,.78)', '--bb-scrim': 'rgba(22,31,91,.45)', '--bb-scrim2': 'rgba(22,31,91,.35)',
      '--bb-sheet': '#ffffff', '--bb-input-bg': '#f5f7fc', '--bb-input-bd': '#e2e7f2',
      '--bb-accent': '#0372FF', '--bb-accent2': '#31D1FF', '--bb-toast': '#161F5B', '--bb-ease': 'cubic-bezier(.16,1,.3,1)',
      '--bb-orb-bg': this.state.listening ? '#fff' : '#0372FF', '--bb-orb-col': this.state.listening ? '#0372FF' : '#fff',
      '--bb-orb-sh': this.state.listening ? '0 0 0 8px rgba(49,209,255,.26),0 14px 40px rgba(22,31,91,.18)' : '0 12px 30px rgba(3,114,255,.4)'
    };
  }
  applyTheme() { const root = document.querySelector('.bb-root'); if (!root) return; const v = this.themeVars(); for (const k in v) root.style.setProperty(k, v[k]); const orb = root.querySelector('.bb-vring'); }
  applyTransform(animate) {
    const track = document.querySelector('.bb-track'); if (!track) return;
    track.style.transition = animate === false ? 'none' : 'transform .34s cubic-bezier(.16,1,.3,1)';
    track.style.transform = 'translateX(' + (-this.state.currentPage * 100) + '%)';
  }
  applyEdit() {
    const editing = this.state.editMode;
    document.querySelectorAll('.bb-root .bb-cell').forEach((el, i) => {
      el.style.animation = editing ? ('bbJiggle .32s infinite ' + (i % 2 ? '-.16s' : '0s')) : '';
    });
    const fedit = this.state.folderEdit;
    document.querySelectorAll('.bb-root .bb-fapp').forEach((el, i) => {
      el.style.animation = fedit ? ('bbJiggle .32s infinite ' + (i % 2 ? '-.16s' : '0s')) : '';
    });
    document.querySelectorAll('.bb-root .bb-vring').forEach(el => { el.style.animation = this.state.listening ? 'bbRing 1.9s ease-out infinite' : ''; el.style.animationDelay = el.style.animationDelay; });
  }
  refreshIcons() {
    if (window.lucide && window.lucide.createIcons) { try { window.lucide.createIcons(); } catch {} this._iconTries = 0; return; }
    if ((this._iconTries = (this._iconTries || 0) + 1) < 50) { clearTimeout(this._iconT); this._iconT = setTimeout(() => this.refreshIcons(), 150); }
  }
  handleIcons() {
    const root = document.querySelector('.bb-root'); if (!root) return;
    root.querySelectorAll('img.bb-ico').forEach(img => {
      const want = img.dataset.src;
      if (want && img.getAttribute('src') !== want) { img.style.display = ''; const t = img.closest('.bb-tile'); if (t) t.classList.remove('noico'); img.setAttribute('src', want); }
      const fail = () => {
        img.style.display = 'none';
        const tile = img.closest('.bb-tile');
        if (tile) { tile.classList.add('noico'); const lt = tile.querySelector('.bb-tile-letter'); if (lt) { lt.style.display = 'grid'; tile.style.background = tile.dataset.bg || 'var(--bb-accent)'; } }
      };
      if (!img._bb) { img._bb = 1; img.addEventListener('error', fail); img.addEventListener('load', () => { if (img.naturalWidth === 0) fail(); }); }
      if (img.getAttribute('src') && img.complete && img.naturalWidth === 0) fail();
    });
  }
  postRender() { this.applyTheme(); this.applyTransform(); this.applyEdit(); this.refreshIcons(); this.handleIcons(); this.applyHit(); }
  componentDidMount() { this.postRender(); this.attachGestures(); this.attachKeys(); this.attachLifecycle(); this.sheetBoot(); this.autoStartMic(); }
  componentDidUpdate() { this.postRender(); }
  componentWillUnmount() { this.stopListen(); this.detachLifecycle(); if (this._hitT) clearTimeout(this._hitT); if (this._keyH) window.removeEventListener('keydown', this._keyH); }

  /* ---------- side-panel lifecycle (revive-only) ----------
   * A side panel keeps its own document alive for the whole session; clicking
   * into the underlying web page merely blurs the panel. So — unlike the web
   * tab version, which stops on blur/hide — we must NEVER stop listening on
   * blur, or a side-panel focus quirk would silently kill the mic on every page
   * click. We only REVIVE: whenever the panel regains visibility/focus and we
   * still want to listen, re-arm the held mic and re-kick the recognizer. The
   * watchdog covers anything that dies while we're blurred. The mic is released
   * only when the panel is genuinely torn down (pagehide / unmount). */
  attachLifecycle() {
    if (this._lifeAttached) return; this._lifeAttached = true;
    const revive = () => { if (this._want && this.state.listening) { this.holdMic(); this.kick(); } };
    this._visH = () => { if (!document.hidden) revive(); };
    this._focusH = () => revive();
    document.addEventListener('visibilitychange', this._visH);
    window.addEventListener('focus', this._focusH);
    window.addEventListener('pageshow', this._focusH);
    this._unloadH = () => { try { this.stopRec(); } catch {} };
    window.addEventListener('pagehide', this._unloadH);
  }
  detachLifecycle() {
    if (this._visH) document.removeEventListener('visibilitychange', this._visH);
    if (this._focusH) { window.removeEventListener('focus', this._focusH); window.removeEventListener('pageshow', this._focusH); }
    if (this._unloadH) window.removeEventListener('pagehide', this._unloadH);
    this._lifeAttached = false;
  }

  /* ---------- keyboard shortcut ---------- */
  attachKeys() {
    if (this._keyH) return;
    this._keyH = (e) => {
      const mod = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.code === 'KeyM' || e.key === 'M' || e.key === 'm');
      if (mod) { e.preventDefault(); if (this.state.voiceOpen) this.closeVoiceFn(); else this.launchVoiceFn(); return; }
      if (this.state.voiceOpen && e.key === 'Escape') { this.closeVoiceFn(); return; }
      const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
      if (typing || this.state.editMode || this.state.adding || this.state.settingsOpen || this.state.folderOpen || this.state.search) return;
      if (e.key === 'ArrowRight') this.goPage(this.state.currentPage + 1);
      else if (e.key === 'ArrowLeft') this.goPage(this.state.currentPage - 1);
    };
    window.addEventListener('keydown', this._keyH);
  }
  goPage(to) { const n = this.state.pages.length; to = Math.max(0, Math.min(n - 1, to)); if (to !== this.state.currentPage) this.setState({ currentPage: to }); }

  /* ---------- gestures: swipe pages + drag reorder ---------- */
  attachGestures() {
    if (this._attached) return; this._attached = true;
    const root = document.querySelector('.bb-root'); if (!root) return;
    let vp = null, startX = 0, startY = 0, dx = 0, dy = 0, mode = null, cell = null, fromIdx = -1, fromPage = -1, ghost = null, pressT = null, downAt = 0;
    const getVp = () => document.querySelector('.bb-viewport');
    const track = () => document.querySelector('.bb-track');
    const reset = () => { mode = null; cell = null; fromIdx = -1; fromPage = -1; this.cancelFlip(); if (ghost) { ghost.remove(); ghost = null; } if (pressT) { clearTimeout(pressT); pressT = null; } };

    root.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.bb-badge') || e.target.closest('button:not(.bb-cell)') && !e.target.closest('.bb-cell')) {
        if (!e.target.closest('.bb-cell')) return;
      }
      vp = getVp(); if (!vp || !vp.contains(e.target)) return;
      if (e.target.closest('.bb-badge')) return;
      startX = e.clientX; startY = e.clientY; dx = 0; dy = 0; downAt = Date.now();
      cell = e.target.closest('.bb-cell');
      if (this.state.editMode && cell) {
        mode = 'pendingdrag';
      } else {
        mode = 'pendingswipe';
        if (cell) pressT = setTimeout(() => { if (mode === 'pendingswipe' && Math.abs(dx) < 8 && Math.abs(dy) < 8) { this.setState({ editMode: true }); reset(); } }, 480);
      }
      try { vp.setPointerCapture(e.pointerId); } catch {}
    });

    root.addEventListener('pointermove', (e) => {
      if (!mode) return;
      dx = e.clientX - startX; dy = e.clientY - startY;
      if (mode === 'pendingswipe') {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { mode = 'swipe'; if (pressT) { clearTimeout(pressT); pressT = null; } const t = track(); if (t) t.style.transition = 'none'; }
        else if (Math.abs(dy) > 10) { reset(); }
      }
      if (mode === 'swipe') {
        const t = track(); if (!t) return;
        const w = vp.offsetWidth || 1; let off = -this.state.currentPage * w + dx;
        const min = -(this.state.pages.length - 1) * w;
        if (off > 0) off = off * 0.35; if (off < min) off = min + (off - min) * 0.35;
        t.style.transform = 'translateX(' + off + 'px)';
      } else if (mode === 'pendingdrag') {
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) { this.beginDrag(cell, e); mode = 'drag'; ghost = this._ghost; fromIdx = +cell.dataset.idx; fromPage = this.state.currentPage; }
      }
      if (mode === 'drag' && ghost) { ghost.style.transform = 'translate(' + (e.clientX - 31) + 'px,' + (e.clientY - 31) + 'px)'; this.highlightDrop(e); this.edgeFlip(e, vp); }
    });

    const end = (e) => {
      if (!mode) { reset(); return; }
      if (pressT) { clearTimeout(pressT); pressT = null; }
      if (mode === 'swipe') {
        const w = vp.offsetWidth || 1; let to = this.state.currentPage;
        if (dx < -w * 0.22) to++; else if (dx > w * 0.22) to--;
        to = Math.max(0, Math.min(this.state.pages.length - 1, to));
        const t = track(); if (t) t.style.transition = 'transform .34s cubic-bezier(.16,1,.3,1)';
        if (to !== this.state.currentPage) this.setState({ currentPage: to }); else this.applyTransform(true);
      } else if (mode === 'pendingswipe' && cell && Math.abs(dx) < 8 && Math.abs(dy) < 8 && Date.now() - downAt < 500) {
        this.tapCell(cell);
      } else if (mode === 'pendingdrag' && cell && Math.abs(dx) < 8 && Math.abs(dy) < 8 && Date.now() - downAt < 500) {
        // A tap (no drag) on a tile while in edit mode opens its edit panel.
        this.tapCellEdit(cell);
      } else if (mode === 'drag') {
        this.dropDrag(e, fromIdx, fromPage);
      }
      reset();
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', () => reset());
  }
  tapCell(cell) {
    const idx = +cell.dataset.idx;
    const c = this.state.pages[this.state.currentPage][idx];
    if (!c) return;
    if (c.type === 'folder') { this.openFolderModal(c); return; }
    const bm = this.state.bookmarks.find(b => b.id === c.id); if (bm) this.openBookmark(bm, false);
  }
  // In edit mode a tap (rather than a drag) on a bookmark tile opens its edit
  // panel. Folders keep their existing behaviour (drag to rearrange; rename via
  // the folder overlay), so only app tiles are editable here.
  tapCellEdit(cell) {
    const idx = +cell.dataset.idx;
    const c = this.state.pages[this.state.currentPage][idx];
    if (!c || c.type !== 'app') return;
    this.openEdit(c.id);
  }
  beginDrag(cell, e) {
    const g = cell.cloneNode(true); g.style.position = 'fixed'; g.style.left = '0'; g.style.top = '0'; g.style.zIndex = '9999';
    g.style.pointerEvents = 'none'; g.style.width = cell.offsetWidth + 'px'; g.style.margin = '0'; g.style.animation = '';
    g.style.filter = 'drop-shadow(0 16px 28px rgba(22,31,91,.35))'; g.style.opacity = '.95';
    g.style.transform = 'translate(' + (e.clientX - 31) + 'px,' + (e.clientY - 31) + 'px)';
    // Append to <body>, not .bb-root, so the ghost survives the re-render that a
    // cross-page edge-flip triggers mid-drag.
    document.body.appendChild(g); this._ghost = g; cell.style.opacity = '.25';
    this._dragCell = cell;
  }
  // While dragging near the left/right edge of the board, flip to the adjacent
  // page after a short hover so tiles can be moved across pages.
  edgeFlip(e, vp) {
    if (!vp) return;
    const r = vp.getBoundingClientRect(), edge = 38;
    if (e.clientX < r.left + edge && this.state.currentPage > 0) this.scheduleFlip(-1);
    else if (e.clientX > r.right - edge && this.state.currentPage < this.state.pages.length - 1) this.scheduleFlip(1);
    else this.cancelFlip();
  }
  scheduleFlip(dir) {
    if (this._flipDir === dir && this._flipT) return;
    this.cancelFlip(); this._flipDir = dir;
    this._flipT = setTimeout(() => {
      this._flipT = null; this._flipDir = 0;
      const to = this.state.currentPage + dir;
      if (to >= 0 && to < this.state.pages.length) this.goPage(to);
    }, 650);
  }
  cancelFlip() { if (this._flipT) { clearTimeout(this._flipT); this._flipT = null; } this._flipDir = 0; }
  highlightDrop(e) {
    document.querySelectorAll('.bb-root .bb-cell').forEach(c => c.style.outline = '');
    const el = document.elementFromPoint(e.clientX, e.clientY); const target = el && el.closest('.bb-cell');
    if (target && target !== this._dragCell) { const tile = target.querySelector('.bb-tile'); if (tile) tile.style.outline = ''; target.style.outline = '2px dashed var(--bb-accent)'; target.style.outlineOffset = '2px'; }
  }
  dropDrag(e, fromIdx, fromPage) {
    this.cancelFlip();
    document.querySelectorAll('.bb-root .bb-cell').forEach(c => c.style.outline = '');
    if (this._dragCell) this._dragCell.style.opacity = '';
    this._dragCell = null;
    if (fromPage == null) fromPage = this.state.currentPage;
    const toPage = this.state.currentPage; // may differ from fromPage after an edge-flip
    // Work on a deep-enough copy: clone every page array; cell objects stay by
    // reference so we can locate them after the source is spliced out.
    const pages = this.state.pages.map(p => p.slice());
    if (!pages[fromPage]) return;
    const src = pages[fromPage][fromIdx];
    if (!src) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const targetEl = el && el.closest('.bb-cell');
    const tIdx = targetEl ? +targetEl.dataset.idx : -1;
    const targetCell = (targetEl && pages[toPage] && tIdx >= 0) ? pages[toPage][tIdx] : null;
    if (targetCell === src) return; // dropped back on itself — no change

    // Remove the dragged cell from its origin page first.
    pages[fromPage].splice(fromIdx, 1);

    if (targetCell && src.type === 'app' && targetCell.type === 'app') {
      // App onto app → make a new folder holding both, where the target sat.
      const ti = pages[toPage].indexOf(targetCell);
      const folder = { type: 'folder', name: 'Folder', items: [targetCell.id, src.id] };
      pages[toPage].splice(ti < 0 ? pages[toPage].length : ti, 1, folder);
    } else if (targetCell && src.type === 'app' && targetCell.type === 'folder') {
      // App onto folder → drop it inside.
      targetCell.items = targetCell.items.concat([src.id]);
    } else {
      // Plain reorder / cross-page move (also when src is a folder, or dropped on
      // empty space → append to the end of the destination page).
      let ti = targetCell ? pages[toPage].indexOf(targetCell) : pages[toPage].length;
      if (ti < 0) ti = pages[toPage].length;
      pages[toPage].splice(ti, 0, src);
    }
    // Trim trailing empty pages but always keep at least one.
    while (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();
    const cur = Math.min(this.state.currentPage, pages.length - 1);
    this.setState({ pages, currentPage: cur }, () => this.save());
  }
  // Remove one app from an open folder, dropping it back beside the folder.
  // When the folder is left with a single item (or none) it dissolves, exactly
  // like dragging the last tile out on iOS.
  removeFromFolder(folderCell, id) {
    const pages = this.state.pages.map(p => p.slice());
    let fp = -1, fi = -1;
    for (let p = 0; p < pages.length && fp < 0; p++) { const i = pages[p].indexOf(folderCell); if (i >= 0) { fp = p; fi = i; } }
    if (fp < 0) return;
    const folder = pages[fp][fi];
    folder.items = folder.items.filter(x => x !== id);
    pages[fp].splice(fi + 1, 0, { type: 'app', id });
    let open = folder;
    if (folder.items.length <= 1) {
      if (folder.items.length === 1) pages[fp].splice(fi, 1, { type: 'app', id: folder.items[0] });
      else pages[fp].splice(fi, 1);
      open = null; // folder dissolved → close the overlay
    }
    this.setState({ pages, folderOpen: open, folderEdit: !!open && this.state.folderEdit }, () => this.save());
    this.toast(open ? 'Moved out' : 'Folder emptied', 'check');
  }
  toggleFolderEdit() { this.setState({ folderEdit: !this.state.folderEdit }); }
  // Rename the current page. Names ride along in the sheet's Page column
  // ("<n>|<name>") so they sync to other devices once a bookmark sits on the page.
  renamePage(name) {
    const names = (this.state.pageNames || []).slice();
    while (names.length < this.state.pages.length) names.push('');
    names[this.state.currentPage] = String(name || '');
    this.setState({ pageNames: names }, () => this.save());
  }
  // Add a new empty page at the end and jump to it. A page with no bookmarks
  // lives in the local layout; it (and any custom name) only reaches the sheet
  // once a bookmark sits on it — same limitation as page names.
  addPage() {
    const pages = this.state.pages.map(p => p.slice());
    const names = (this.state.pageNames || []).slice();
    pages.push([]);
    while (names.length < pages.length) names.push('');
    this.setState({ pages, pageNames: names, currentPage: pages.length - 1 }, () => this.save());
  }
  // Move a page (with its name) up/down in the order. Reordering re-stamps the
  // Page number on every bookmark via save() -> sheetSync, so it persists/syncs.
  movePage(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= this.state.pages.length) return;
    const pages = this.state.pages.map(p => p.slice());
    const names = (this.state.pageNames || []).slice();
    while (names.length < pages.length) names.push('');
    const pt = pages[i]; pages[i] = pages[j]; pages[j] = pt;
    const nt = names[i]; names[i] = names[j]; names[j] = nt;
    let cur = this.state.currentPage;
    if (cur === i) cur = j; else if (cur === j) cur = i;
    this.setState({ pages, pageNames: names, currentPage: cur }, () => this.save());
  }

  /* ---------- toggles ---------- */
  toggleEditFn() { this.setState({ editMode: !this.state.editMode }); }

  renderVals() {
    const s = this.state;
    const byId = id => s.bookmarks.find(b => b.id === id);
    const cellOf = (c, idx) => {
      if (c.type === 'folder') {
        c.__id = c.__id || ('f' + idx + '_' + (c.name || '').replace(/\s/g, ''));
        const mini = c.items.slice(0, 9).map(id => { const bm = byId(id); return { src: bm ? this.iconFor(bm) : '', letter: bm ? this.letterOf(bm) : '?' }; });
        return { id: c.__id, kind: 'folder', isFolder: true, isApp: false, name: c.name || 'Folder', mini, idx, onDelete: () => {} };
      }
      const bm = byId(c.id) || { id: c.id, name: '?', url: '' };
      return { id: c.id, kind: 'app', isApp: true, isFolder: false, name: bm.name || this.hostCore(bm.url), icon: this.iconFor(bm), letter: this.letterOf(bm), grad: this.grad(bm.name || bm.url), tileClass: '', idx, onDelete: () => this.deleteBookmark(c.id) };
    };
    const pages = s.pages.map((pg, pi) => ({ name: this.pageName(pi), cells: pg.map((c, i) => cellOf(c, i)), empty: pg.length === 0 }));
    // re-stamp idx as data attribute via cell objects (idx used by gestures); ensure data-index present
    pages.forEach(p => p.cells.forEach((c, i) => { c.idx = i; }));

    const dots = s.pages.map((_, i) => ({ go: () => this.goPage(i), scale: i === s.currentPage ? 1.3 : 1, bg: i === s.currentPage ? 'var(--bb-accent)' : 'var(--bb-dot)' }));

    const nq = this.normalize(s.search);
    const showResults = !!s.search.trim();
    let results = [];
    if (showResults) results = s.bookmarks.filter(b => this.normalize(b.name).includes(nq) || this.normalize(this.hostOf(b.url)).includes(nq) || this.normalize(b.notes).includes(nq))
      .map(b => ({ id: b.id, name: b.name || this.hostCore(b.url), host: this.hostOf(b.url), icon: this.iconFor(b), letter: this.letterOf(b), onTap: () => this.openBookmark(b, false) }));

    const have = new Set(s.bookmarks.map(b => this.hostOf(b.url)));
    const suggestions = this.STARTERS.filter(x => !have.has(this.hostOf(x.url))).slice(0, 6).map(x => ({ name: x.name, icon: this.favicon(x.url), letter: x.name[0], add: () => this.addBookmark(x.name, x.url) }));

    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const fname = s.bookmarks[0] ? (s.bookmarks[0].name || this.hostCore(s.bookmarks[0].url)) : 'Gmail';
    const transcript = s.interim || s.heard || (s.listening ? 'Listening… try “open ' + fname + '”' : 'Tap the mic, then say “open ' + fname + '”');
    const folder = s.folderOpen;

    return {
      greeting, subtitle: s.bookmarks.length + ' sites · swipe to browse',
      search: s.search, hasSearch: !!s.search, onSearch: e => this.setState({ search: e.target.value }), clearSearch: () => this.setState({ search: '' }),
      showResults, showBoard: !showResults, noResults: showResults && results.length === 0, results,
      pages, dots, showDots: s.pages.length > 1 && !s.editMode, editMode: s.editMode,
      openSettings: () => this.setState({ settingsOpen: true }), closeSettings: () => this.setState({ settingsOpen: false }),
      openAdd: () => this.setState({ adding: true, draftName: '', draftUrl: '' }), closeAdd: () => this.setState({ adding: false }),
      launchVoice: () => this.launchVoiceFn(), closeVoice: () => this.closeVoiceFn(), toggleListen: () => { if (s.listening) this.stopListen(); else this.startListen(); },
      // Dock mic button: pulses while the mic is live; tapping it pauses
      // listening, and tapping again simply resumes the pulse inline — no voice
      // overlay pop-out. (startListen still falls back to the overlay only when
      // speech recognition isn't supported, to show the explainer.)
      toggleMic: () => { if (this.state.listening) this.stopListen(); else this.startListen(); },
      micIcon: 'mic', micLabel: s.listening ? 'Stop listening' : 'Start voice',
      micRingStyle: s.listening ? 'position:absolute; inset:-5px; border-radius:50%; border:2px solid var(--bb-accent2); pointer-events:none; animation:bbRing 1.6s ease-out infinite;' : 'display:none;',
      micBtnAnim: s.listening ? 'animation:bbMicPulse 1.6s ease-in-out infinite;' : '',
      toggleEdit: () => this.toggleEditFn(), exitEdit: () => this.setState({ editMode: false }),
      adding: s.adding, settingsOpen: s.settingsOpen,
      draftName: s.draftName, draftUrl: s.draftUrl,
      onDraftName: e => this.setState({ draftName: e.target.value }), onDraftUrl: e => this.setState({ draftUrl: e.target.value }),
      saveAdd: () => { if (this.addBookmark(s.draftName, s.draftUrl)) this.setState({ adding: false }); },
      // ----- per-bookmark edit panel -----
      editing: !!s.editing,
      editName: s.editName, editUrl: s.editUrl, editIcon: s.editIcon, editNotes: s.editNotes,
      onEditName: e => this.setState({ editName: e.target.value }),
      onEditUrl: e => this.setState({ editUrl: e.target.value }),
      onEditIcon: e => this.setState({ editIcon: e.target.value }),
      onEditNotes: e => this.setState({ editNotes: e.target.value }),
      // Live tile preview: a hosted http(s) image if given, else the site favicon
      // (same icon rule the springboard tiles use). bb-ico falls back to the letter.
      editIconPreview: (/^https?:\/\//i.test(String(s.editIcon || '').trim()) ? String(s.editIcon).trim() : this.favicon(s.editUrl)),
      editLetter: ((String(s.editName || '').trim() || this.hostCore(s.editUrl) || '?').trim()[0] || '?').toUpperCase(),
      closeEdit: () => this.closeEdit(), saveEdit: () => this.saveEdit(),
      editConfirmDelete: s.editConfirmDelete, showEditActions: !s.editConfirmDelete,
      askDeleteEdit: () => this.setState({ editConfirmDelete: true }),
      cancelDeleteEdit: () => this.setState({ editConfirmDelete: false }),
      confirmDeleteEdit: () => this.confirmDeleteEdit(),
      suggestions,
      addPage: () => this.addPage(),
      pageList: s.pages.map((pg, i) => {
        const n = pg.reduce((t, c) => t + (c && c.type === 'folder' ? c.items.length : 1), 0);
        return {
          label: this.pageName(i), count: n + (n === 1 ? ' site' : ' sites'),
          moveUp: () => this.movePage(i, -1), moveDown: () => this.movePage(i, 1),
          upStyle: i === 0 ? 'opacity:.28; pointer-events:none;' : '',
          downStyle: i === s.pages.length - 1 ? 'opacity:.28; pointer-events:none;' : ''
        };
      }),
      // ----- voice disambiguation chooser -----
      choosing: !!(s.choosing && s.choosing.length), choiceQuery: s.choiceQuery || '',
      choices: (s.choosing || []).map((bm, i) => ({
        n: i + 1, id: bm.id, name: bm.name || this.hostCore(bm.url), host: this.hostOf(bm.url),
        icon: this.iconFor(bm), letter: this.letterOf(bm),
        onTap: () => { this.setState({ choosing: null, choiceQuery: '' }); this.openBookmark(bm, true); }
      })),
      cancelChoose: () => this.setState({ choosing: null, choiceQuery: '' }),
      voiceOpen: s.voiceOpen, voiceStatus: s.listening ? 'Listening' : 'Paused', noVoice: !s.srSupported,
      statusDot: s.listening ? '#22c55e' : 'var(--bb-fg-soft)', statusAnim: s.listening ? 'animation:bbBlink 1.4s infinite;' : '',
      orbIcon: s.listening ? 'mic' : 'mic-off',
      transcript: s.interim || s.heard || (s.listening ? 'Listening… try “open ' + fname + '”' : 'Tap the mic, then say “open ' + fname + '”'),
      transcriptColor: (s.interim || s.heard) ? 'var(--bb-fg)' : 'var(--bb-fg-soft)',
      caretStyle: s.listening && !s.heard ? 'display:inline-block;width:3px;height:1em;background:var(--bb-accent2);margin-left:3px;vertical-align:text-bottom;animation:bbCaret 1s step-end infinite;' : 'display:none;',
      voiceExamples: ['open ' + fname, 'next page', 'add Notion'],
      folderOpen: !!folder, folderName: folder ? folder.name : '', folderCount: folder ? folder.items.length : 0,
      folderEditing: s.folderEdit, folderEditLabel: s.folderEdit ? 'Done' : 'Edit', toggleFolderEdit: () => this.toggleFolderEdit(),
      folderApps: folder ? folder.items.map(id => { const bm = byId(id) || { id, name: '?', url: '' }; return { id, name: bm.name || this.hostCore(bm.url), icon: this.iconFor(bm), letter: this.letterOf(bm), grad: this.grad(bm.name || bm.url), tileClass: '', onTap: () => { if (s.folderEdit) return; this.openBookmark(bm, false); }, onRemove: () => this.removeFromFolder(folder, id) }; }) : [],
      closeFolder: () => this.setState({ folderOpen: null, folderEdit: false }), openFolderAll: () => this.openFolderAllFn(),
      pageTitle: (s.pageNames[s.currentPage] || ''), onPageName: e => this.renamePage(e.target.value),
      shortcutLabel: (navigator.platform || '').toLowerCase().includes('mac') ? '⌘⇧M' : 'Ctrl ⇧ M',
      dark: s.dark, toggleDark: () => this.setState({ dark: !s.dark }, () => this.saveSettings()),
      darkSwitchBg: s.dark ? 'var(--bb-accent)' : 'var(--bb-input-bd)', darkKnobX: s.dark ? '21px' : '2.5px',
      speak: s.speak, toggleSpeak: () => this.setState({ speak: !s.speak }, () => this.saveSettings()),
      speakSwitchBg: s.speak ? 'var(--bb-accent)' : 'var(--bb-input-bd)', speakKnobX: s.speak ? '21px' : '2.5px',
      count: s.bookmarks.length,
      toast: s.toast, toastIcon: s.toastIcon
    };
  }
}

;return (typeof Component !== "undefined" && Component) || undefined;
};
