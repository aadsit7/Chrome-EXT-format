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
      search: '', adding: false, settingsOpen: false, folderOpen: null,
      editMode: false, voiceOpen: false, listening: false, interim: '', heard: '',
      draftName: '', draftUrl: '', dark: false, speak: false,
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
    // has baselined us; covers add / remove / rename / reorder via save()).
    try { if (this._sheet) this._sheet.push(); } catch {}
  }
  saveSettings() { try { localStorage.setItem(this.LS_S, JSON.stringify({ dark: this.state.dark, speak: this.state.speak })); } catch {} }
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
  scoreBookmark(query, bm) {
    const q = this.normalize(query); if (!q) return 0;
    const name = this.normalize(bm.name), core = this.normalize(this.hostCore(bm.url)), host = this.normalize(this.hostOf(bm.url).replace(/\./g, ' '));
    let best = 0;
    for (const c of [name, core]) { if (!c) continue; if (c === q) return 1; best = Math.max(best, this.sim(q, c)); }
    for (const c of [name, core, host]) { if (!c) continue; if (c.includes(q) || q.includes(c)) { const r = Math.min(q.length, c.length) / Math.max(q.length, c.length); best = Math.max(best, 0.78 + 0.2 * r); } }
    const qt = q.split(' ').filter(Boolean); const hay = (name + ' ' + host + ' ' + core).trim();
    if (qt.length && qt.every(w => hay.includes(w))) best = Math.max(best, 0.9);
    const hw = hay.split(' ').filter(Boolean);
    for (const w of qt) for (const h of hw) if (w.length >= 3 && h.length >= 3) best = Math.max(best, 0.7 * this.sim(w, h));
    const notes = this.normalize(bm.notes);
    if (notes && q.length >= 3 && notes.includes(q)) { const r = Math.min(q.length, notes.length) / Math.max(q.length, notes.length); best = Math.max(best, 0.6 + 0.18 * r); }
    return best;
  }
  matchBookmark(q, th) { let best = null; for (const bm of this.state.bookmarks) { const s = this.scoreBookmark(q, bm); if (s >= th && (!best || s > best.s)) best = { bm, s }; } return best; }
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
  resolveTarget(query) {
    const q = this.normalize(query); if (!q) return null;
    const wantsFolder = /\b(folder|group)\b/.test(q);
    const fm = this.matchFolder(q, wantsFolder ? 0.34 : 0.52);
    const bm = this.matchBookmark(q, 0.42);
    if (wantsFolder && fm) return { kind: 'folder', folder: fm.f };
    if (bm && (!fm || bm.s >= fm.s)) return { kind: 'bookmark', bm: bm.bm };
    if (fm) return { kind: 'folder', folder: fm.f };
    return null;
  }
  handleTranscript(raw) {
    const text = String(raw).trim(); if (!text) return;
    const nav = this.parsePageNav(text);
    if (nav) { this.applyNav(nav); return; }
    const cmd = this.parseCommand(text);
    if (cmd.kind === 'stop') { this.stopListen(); return; }
    if (cmd.kind === 'help') { this.toast('Say “open” + a site, “next page”, or “add Notion”', 'sparkles'); return; }
    if (cmd.kind === 'add') { if (cmd.rawQuery) this.addByVoice(cmd.rawQuery); else this.toast('Say a site to add, e.g. “add Notion”', 'mic'); return; }
    if (cmd.kind === 'maybe') {
      const exact = this.state.bookmarks.find(b => this.normalize(b.name) === cmd.query || this.normalize(this.hostCore(b.url)) === cmd.query);
      if (exact) this.openBookmark(exact, true);
      else { const f = this.allFolders().find(f => this.normalize(f.name) === cmd.query); if (f) this.openFolderModal(f); }
      return;
    }
    if (!cmd.query) { this.toast('Say “open” and a site name', 'mic'); return; }
    const tg = this.resolveTarget(cmd.query);
    if (!tg) { this.toast('No site matches “' + cmd.query + '”', 'search-x'); return; }
    if (tg.kind === 'bookmark') this.openBookmark(tg.bm, true);
    else this.openFolderModal(tg.folder);
  }
  applyNav(nav) {
    const n = this.state.pages.length, to = nav.to;
    if (to < 0 || to >= n) { this.toast(nav.rel ? (to < 0 ? 'First page' : 'Last page') : 'No such page', 'panel-left'); return; }
    this.setState({ currentPage: to, search: '' });
    this.toast(this.pageName(to), 'panel-left');
    this.speakIf('Showing ' + this.pageName(to));
  }
  pageName(i) { return (this.state.pageNames[i] || '').trim() || ('Page ' + (i + 1)); }

  /* ---------- actions ---------- */
  openBookmark(bm, viaVoice) {
    if (!bm) return; const url = this.ensureScheme(bm.url);
    if (!url) { this.toast('That site has no address', 'triangle-alert'); return; }
    try { const w = window.open(url, '_blank'); if (w) w.opener = null; } catch {}
    this.toast('Opening ' + (bm.name || this.hostCore(bm.url)), 'external-link');
    this.speakIf('Opening ' + (bm.name || this.hostCore(bm.url)));
    if (viaVoice) { this.setState({ heard: bm.name || this.hostCore(bm.url) }); setTimeout(() => this.closeVoiceFn(), 900); }
  }
  openFolderModal(f) { this.setState({ folderOpen: f, voiceOpen: false }); this.stopRec(); }
  openFolderAllFn() { const f = this.state.folderOpen; if (!f) return; f.items.forEach(id => { const bm = this.state.bookmarks.find(b => b.id === id); if (bm) { try { const w = window.open(this.ensureScheme(bm.url), '_blank'); if (w) w.opener = null; } catch {} } }); this.toast('Opening ' + f.items.length + ' sites', 'layers'); this.setState({ folderOpen: null }); }
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
    r.onstart = () => { this._running = true; this._lastEvt = Date.now(); };
    r.onend = () => { this._running = false; if (this._want && this.state.listening) this.kick(); };
    this._rec = r; return r;
  }
  kick(attempt = 0) { if (!this._want || !this.state.listening || this._running) return; const r = this.ensureRec(); if (!r) return; try { r.start(); } catch (err) { if (/already started/i.test(err && err.message || '')) return; if (attempt < 6) setTimeout(() => this.kick(attempt + 1), 200 * (attempt + 1)); } }
  startListen() {
    const r = this.ensureRec();
    if (!r) { this.setState({ voiceOpen: true }); return; }
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia({ audio: true }).then(s => { this._mic = s; }).catch(() => {});
    this._want = true; this.setState({ listening: true, interim: '', heard: '' }); this.kick();
    if (!this._wd) this._wd = setInterval(() => { if (this._want && this.state.listening && !this._running) this.kick(); }, 4000);
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
  postRender() { this.applyTheme(); this.applyTransform(); this.applyEdit(); this.refreshIcons(); this.handleIcons(); }
  // Boot the Google Sheet sync layer (lib/sheet-sync.js). The sheet is the
  // source of truth: on open we pull the live list and render it through the
  // EXISTING UI; edits go back via save() -> this._sheet.push(). The UI is
  // untouched — only the data source/persistence changes.
  sheetBoot() {
    if (this._sheet || !window.BBSheetSync) return;
    this._sheet = new window.BBSheetSync({
      getState: () => ({ bookmarks: this.state.bookmarks, pages: this.state.pages, pageNames: this.state.pageNames }),
      uid: () => this.uid(),
      onLoaded: (bookmarks, layout) => {
        // The sheet is authoritative — show exactly what's in your sheet.
        this.state.bookmarks = bookmarks;
        this.applyLayout(layout, this.state.bookmarks);
        // Keep localStorage as an instant offline mirror.
        try { localStorage.setItem(this.LS_B, JSON.stringify(this.state.bookmarks)); } catch {}
        try { localStorage.setItem(this.LS_L, JSON.stringify({ pages: this.state.pages, pageNames: this.state.pageNames })); } catch {}
        // Baseline the snapshot to the final state so save() won't echo it back.
        this._sheet.baseline();
        let cur = this.state.currentPage;
        if (cur >= this.state.pages.length) cur = Math.max(0, this.state.pages.length - 1);
        this.setState({ bookmarks: this.state.bookmarks, pages: this.state.pages, pageNames: this.state.pageNames, currentPage: cur });
      }
    });
    this._sheet.boot();
  }
  componentDidMount() { this.postRender(); this.attachGestures(); this.attachKeys(); this.sheetBoot(); }
  componentDidUpdate() { this.postRender(); }
  componentWillUnmount() { this.stopListen(); if (this._keyH) window.removeEventListener('keydown', this._keyH); }

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
    let vp = null, startX = 0, startY = 0, dx = 0, dy = 0, mode = null, cell = null, fromIdx = -1, ghost = null, pressT = null, downAt = 0;
    const getVp = () => document.querySelector('.bb-viewport');
    const track = () => document.querySelector('.bb-track');
    const reset = () => { mode = null; cell = null; fromIdx = -1; if (ghost) { ghost.remove(); ghost = null; } if (pressT) { clearTimeout(pressT); pressT = null; } };

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
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) { this.beginDrag(cell, e); mode = 'drag'; ghost = this._ghost; const pg = this.state.pages[this.state.currentPage]; fromIdx = +cell.dataset.idx; }
      }
      if (mode === 'drag' && ghost) { ghost.style.transform = 'translate(' + (e.clientX - 31) + 'px,' + (e.clientY - 31) + 'px)'; this.highlightDrop(e); }
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
      } else if (mode === 'drag') {
        this.dropDrag(e, fromIdx);
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
  beginDrag(cell, e) {
    const g = cell.cloneNode(true); g.style.position = 'fixed'; g.style.left = '0'; g.style.top = '0'; g.style.zIndex = '9999';
    g.style.pointerEvents = 'none'; g.style.width = cell.offsetWidth + 'px'; g.style.margin = '0'; g.style.animation = '';
    g.style.filter = 'drop-shadow(0 16px 28px rgba(22,31,91,.35))'; g.style.opacity = '.95';
    g.style.transform = 'translate(' + (e.clientX - 31) + 'px,' + (e.clientY - 31) + 'px)';
    document.querySelector('.bb-root').appendChild(g); this._ghost = g; cell.style.opacity = '.25';
    this._dragCell = cell;
  }
  highlightDrop(e) {
    document.querySelectorAll('.bb-root .bb-cell').forEach(c => c.style.outline = '');
    const el = document.elementFromPoint(e.clientX, e.clientY); const target = el && el.closest('.bb-cell');
    if (target && target !== this._dragCell) { const tile = target.querySelector('.bb-tile'); if (tile) tile.style.outline = ''; target.style.outline = '2px dashed var(--bb-accent)'; target.style.outlineOffset = '2px'; }
  }
  dropDrag(e, fromIdx) {
    document.querySelectorAll('.bb-root .bb-cell').forEach(c => c.style.outline = '');
    if (this._dragCell) this._dragCell.style.opacity = '';
    const el = document.elementFromPoint(e.clientX, e.clientY); const target = el && el.closest('.bb-cell');
    const pages = this.state.pages.slice(); const pg = pages[this.state.currentPage].slice();
    if (target && target !== this._dragCell) {
      const toIdx = +target.dataset.idx;
      if (!isNaN(toIdx) && !isNaN(fromIdx) && toIdx !== fromIdx) { const [moved] = pg.splice(fromIdx, 1); pg.splice(toIdx, 0, moved); pages[this.state.currentPage] = pg; this.setState({ pages }, () => this.save()); }
    }
    this._dragCell = null;
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
    const pages = s.pages.map((pg, pi) => ({ cells: pg.map((c, i) => cellOf(c, i)), empty: pg.length === 0 }));
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
      toggleEdit: () => this.toggleEditFn(), exitEdit: () => this.setState({ editMode: false }),
      adding: s.adding, settingsOpen: s.settingsOpen,
      draftName: s.draftName, draftUrl: s.draftUrl,
      onDraftName: e => this.setState({ draftName: e.target.value }), onDraftUrl: e => this.setState({ draftUrl: e.target.value }),
      saveAdd: () => { if (this.addBookmark(s.draftName, s.draftUrl)) this.setState({ adding: false }); },
      suggestions,
      voiceOpen: s.voiceOpen, voiceStatus: s.listening ? 'Listening' : 'Paused', noVoice: !s.srSupported,
      statusDot: s.listening ? '#22c55e' : 'var(--bb-fg-soft)', statusAnim: s.listening ? 'animation:bbBlink 1.4s infinite;' : '',
      orbIcon: s.listening ? 'mic' : 'mic-off',
      transcript: s.interim || s.heard || (s.listening ? 'Listening… try “open ' + fname + '”' : 'Tap the mic, then say “open ' + fname + '”'),
      transcriptColor: (s.interim || s.heard) ? 'var(--bb-fg)' : 'var(--bb-fg-soft)',
      caretStyle: s.listening && !s.heard ? 'display:inline-block;width:3px;height:1em;background:var(--bb-accent2);margin-left:3px;vertical-align:text-bottom;animation:bbCaret 1s step-end infinite;' : 'display:none;',
      voiceExamples: ['open ' + fname, 'next page', 'add Notion'],
      folderOpen: !!folder, folderName: folder ? folder.name : '', folderCount: folder ? folder.items.length : 0,
      folderApps: folder ? folder.items.map(id => { const bm = byId(id) || { id, name: '?', url: '' }; return { id, name: bm.name || this.hostCore(bm.url), icon: this.iconFor(bm), letter: this.letterOf(bm), grad: this.grad(bm.name || bm.url), tileClass: '', onTap: () => this.openBookmark(bm, false) }; }) : [],
      closeFolder: () => this.setState({ folderOpen: null }), openFolderAll: () => this.openFolderAllFn(),
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
