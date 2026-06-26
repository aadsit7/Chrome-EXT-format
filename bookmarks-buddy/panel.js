      "use strict";

      /* ================================================================
       * Bookmarks Buddy
       * Save links, then open them hands-free by voice ("open my
       * Salesforce"). Everything is cached locally — nothing leaves the
       * browser. The speech engine (continuous listening + watchdog +
       * auto-restart + a held mic stream that keeps it alive in the
       * background) is carried over from the original assistant; only the
       * microphone is used.
       * ================================================================ */

      const LS_BOOKMARKS = 'bookmarksBuddy.bookmarks.v1';
      const LS_SETTINGS  = 'bookmarksBuddy.settings.v1';
      const LS_LAYOUT    = 'bookmarksBuddy.layout.v1';
      const LS_OUTBOX    = 'bookmarksBuddy.outbox.v1';   // queued sheet writes awaiting sync
      const LS_TOKEN     = 'bookmarksBuddy.appToken';    // optional on-device app_token override
      const LS_SYNCED    = 'bookmarksBuddy.synced.v1';   // set once this device has merged with the sheet

      /* ================================================================
       * Google Sheet backend
       * Bookmarks now live in a Google Sheet, reached through a deployed
       * Apps Script web app. localStorage stays on as an offline mirror:
       * the UI always loads instantly from it, every change is written to
       * it, and any change made while the sheet is unreachable is queued
       * and flushed once it's reachable again. With no app_token set the
       * sheet layer stays dormant and the app behaves exactly as the
       * localStorage-only app it has always been.
       * ================================================================ */
      // The Apps Script app_token, embedded so sync is on by default. NOTE:
      // this ships in the served page, so anyone who can open the app can read
      // it — rotate it (change the 'app_token' Script Property and this value)
      // if it's ever misused. A ?token=… URL param or bbSetToken('…') in the
      // console overrides this per-device without editing the file.
      const EMBEDDED_APP_TOKEN = 'c1XGANPfknryxC-49LbEhOljwWKwYIzo';

      const SHEET = {
        url: 'https://script.google.com/macros/s/AKfycbwXvgj1niSwrREBepEA9oO_YNBtgyq1vSdZPNclYBqMz0ytTI1r1sjUDxePExx5B0mOlA/exec',
        token: resolveAppToken(),
        online: true,                   // last known reachability of the sheet
        snapshot: Object.create(null),  // Bookmark ID -> JSON of the row the sheet last had
        flushing: false,                // guards against overlapping outbox flushes
        ready: false                    // true once the snapshot is baselined, so
                                        // boot-time saves don't push before we pull
      };
      function sheetEnabled() { return !!(SHEET.url && SHEET.token); }

      // Resolve the token without baking the secret into the page: a
      // ?token=… (or #token=…) URL param wins and is remembered on the
      // device, then a previously saved value, then the embedded constant.
      function resolveAppToken() {
        try {
          const here = new URL(location.href);
          const q = here.searchParams.get('token') ||
            new URLSearchParams((location.hash || '').replace(/^#/, '')).get('token');
          if (q) { try { localStorage.setItem(LS_TOKEN, q); } catch {} return q; }
        } catch {}
        try { const saved = localStorage.getItem(LS_TOKEN); if (saved) return saved; } catch {}
        return EMBEDDED_APP_TOKEN;
      }
      // Set or clear the token at runtime (persists on this device), then
      // kick a sync so a freshly-configured app pulls the sheet right away.
      window.bbSetToken = function (t) {
        SHEET.token = String(t || '').trim();
        try {
          if (SHEET.token) localStorage.setItem(LS_TOKEN, SHEET.token);
          else localStorage.removeItem(LS_TOKEN);
        } catch {}
        if (sheetEnabled())
          (async () => { try { await flushOutbox(); } catch {} await syncFromSheet(); })();
        return SHEET.token ? 'app_token set — syncing with your sheet' : 'app_token cleared';
      };

      // A short, recognizable starter set so a brand-new user can fill their
      // home screen in one tap each instead of facing an empty grid.
      const STARTER_SITES = [
        { name: 'Gmail', url: 'gmail.com' },
        { name: 'Calendar', url: 'calendar.google.com' },
        { name: 'Drive', url: 'drive.google.com' },
        { name: 'YouTube', url: 'youtube.com' },
        { name: 'Notion', url: 'notion.so' },
        { name: 'Slack', url: 'slack.com' },
        { name: 'Salesforce', url: 'salesforce.com' },
        { name: 'GitHub', url: 'github.com' },
        { name: 'LinkedIn', url: 'linkedin.com' },
        { name: 'ChatGPT', url: 'chatgpt.com' },
        { name: 'Figma', url: 'figma.com' },
        { name: 'Amazon', url: 'amazon.com' }
      ];

      // How many cells (apps or folders) fit on one springboard page before it
      // spills onto the next — a 4×4 iPhone-style grid.
      const PAGE_SIZE = 16;

      // ----------------------------------------------------------------
      // What's new — the running changelog shown in Settings. Newest entry
      // goes FIRST; the first one is highlighted as the latest update. When
      // you ship a change, add an entry at the top with a date and a couple
      // of plain-language bullets and it shows up automatically. The list is
      // baked into the page (no backend needed) and the "last seen" version
      // is cached on the device so the NEW badge clears once it's been read.
      // ----------------------------------------------------------------
      const CHANGELOG = [
        {
          version: '2026-06-23c',
          date: 'Jun 23, 2026',
          title: 'Listening stops when you leave',
          items: [
            'When a bookmark opens and you click over to it — or switch to another tab or app — listening now turns off on its own. Come back to Bookmarks Buddy and tap the mic (or press your shortcut) to start again.'
          ]
        },
        {
          version: '2026-06-23b',
          date: 'Jun 23, 2026',
          title: 'Roomier home screen — at least three rows per page',
          items: [
            'Each home-screen page now lays out as a 4×3 grid, so your sites stack into at least three rows instead of stretching across one or two wide rows on a large screen.'
          ]
        },
        {
          version: '2026-06-23',
          date: 'Jun 23, 2026',
          title: 'Name your pages — and a Pages menu to jump between them',
          items: [
            'Give each home-screen page a name, then use the new Pages list on the left to jump straight to any one.',
            'While arranging, rename a page or nudge it earlier or later with the ↑/↓ buttons to set the order — and your page names sync across devices too.',
            'By voice, say “next page”, “go to page 2”, or “go to Work” to switch pages hands-free.'
          ]
        },
        {
          version: '2026-06-22e',
          date: 'Jun 22, 2026',
          title: 'Your layout now follows you across devices',
          items: [
            'Folders, pages, and exactly where each site sits now sync through your Google Sheet — open the app on another device and your home screen is arranged the same way.',
            'Listening starts more reliably the moment you click the mic or press Ctrl+Alt+B, even right after stopping.'
          ]
        },
        {
          version: '2026-06-22d',
          date: 'Jun 22, 2026',
          title: 'Simpler voice — just say the command',
          items: [
            'Voice now acts on any command right away — say “open Salesforce” or “add Notion” with no wake word to remember.',
            'Listening still keeps going while you work in other tabs; tap the mic or press Ctrl+Alt+B to start or stop.'
          ]
        },
        {
          version: '2026-06-22b',
          date: 'Jun 22, 2026',
          title: 'Colorful default icons',
          items: [
            'Sites without a logo now get a bright, colorful tile with their initial instead of a plain gray one.',
            'Each site keeps its own consistent color across the home screen, folders, and search.'
          ]
        },
        {
          version: '2026-06-22',
          date: 'Jun 22, 2026',
          title: 'What’s new in Settings',
          items: [
            'Settings now shows the most recent updates so you always know what changed.',
            'Each release lists a date and a couple of quick highlights.'
          ]
        },
        {
          version: '2026-06-15',
          date: 'Jun 15, 2026',
          title: 'Descriptions, editing & custom thumbnails',
          items: [
            'Add a short note to any site and edit a saved bookmark in place.',
            'Upload your own thumbnail when a site’s favicon isn’t enough.'
          ]
        },
        {
          version: '2026-06-10',
          date: 'Jun 10, 2026',
          title: 'Free-placement springboard',
          items: [
            'Drop apps anywhere on the page, iPhone-style, leaving gaps where you like.',
            'App tiles are larger and easier to tap.'
          ]
        },
        {
          version: '2026-06-05',
          date: 'Jun 5, 2026',
          title: 'Google Sheet sync',
          items: [
            'Your bookmarks back up to a Google Sheet and sync across devices.',
            'Works offline — changes queue up and flush once you’re back online.'
          ]
        }
      ];
      const LS_CHANGELOG_SEEN = 'bookmarksBuddy.changelogSeen.v1';

      const STATE = {
        view: 'home',              // 'home' | 'focus'
        bookmarks: [],             // { id, name, url, notes, icon }
        editingId: null,
        confirmDeleteId: null,
        draftName: '',             // add-form drafts (kept across re-renders)
        draftUrl: '',
        draftNotes: '',            // optional description note
        draftIcon: '',             // optional custom thumbnail (URL or data URL)
        editDraftName: '',
        editDraftUrl: '',
        editDraftNotes: '',        // edit-form description note
        editDraftIcon: '',         // edit-form custom thumbnail
        // speak: optional spoken confirmation, off by default.
        // shortcut: key combo that toggles listening from anywhere (default Ctrl+R).
        settings: { speak: false, shortcut: defaultShortcut() },
        // iPhone-style home-screen layout. pages[] holds "cells", each either
        // { type:'app', id } or { type:'folder', id, name, items:[{type:'app',id}] }.
        // The flat STATE.bookmarks list stays the source of truth (voice uses
        // it); the layout just arranges those same bookmarks into pages/folders.
        // pages[] holds the slot arrays; pageNames[] is a parallel list of the
        // (optional) custom name for each page, indexed identically.
        layout: { pages: [], pageNames: [] },
        currentPage: 0,
        // The left "Pages" rail. Open by default on a wide screen, tucked away
        // on a phone where it slides in as a drawer.
        pageNavOpen: !(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 820px)').matches),
        editMode: false,           // "jiggle" mode for rearranging
        openFolderId: null,        // folder whose overlay is open, if any
        adding: false,             // add-website modal open
        homeSearch: '',            // live filter on the Bookmarks screen
        recordingShortcut: false   // Settings is capturing a new shortcut combo
      };

      // Transient drag state for rearranging in edit mode.
      const DRAG = { from: null, intent: null };

      const VOICE = {
        srSupported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
        ttsSupported: !!window.speechSynthesis,
        recognition: null,
        wantRunning: false,        // we want the recognizer running
        srRunning: false,          // it is currently running
        listenOn: false,           // the user has turned listening on
        micStream: null,           // held open so the recognizer stays healthy while in use
        permissionDenied: false,
        interimText: '',           // live partial transcript
        dictating: false,          // Add/Edit-modal dictation mode is active
        dictateField: null,        // which modal field voice types into
        dictateFresh: false,       // next spoken chunk replaces the field, then appends
        dictatePrevListenOn: false,// was command-listening on before dictation?
        lastSrEventAt: 0,
        watchdogId: null,
        recentActions: [],         // { type, name, url, query, at }
        pendingOpen: null,         // a bookmark a popup-block kept us from opening
        pendingGroup: null,        // { label, bms:[] } a folder a popup-block kept us from opening
        pendingSplit: null,        // { label, plan:[{bm,feat}] } a split view a popup-block kept us from opening
        openWindows: [],           // { id, name, host, win, severed, at } tabs we opened, so voice can tile a split beside them
        popupHintShown: false,
        lastMatchedId: null,
        matchClearId: null,
        toastMessage: '',
        toastIcon: '',
        toastTimeoutId: null
      };

      /* ---------------- persistence ---------------- */
      function loadData() {
        try {
          const b = JSON.parse(localStorage.getItem(LS_BOOKMARKS) || '[]');
          if (Array.isArray(b)) STATE.bookmarks = b.filter(x => x && x.url).map(normalizeBookmark);
        } catch {}
        try {
          const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
          if (s && typeof s === 'object') STATE.settings = Object.assign(STATE.settings, s);
          const sc = STATE.settings.shortcut;
          if (!sc || typeof sc !== 'object' || (!sc.code && !sc.key)) STATE.settings.shortcut = defaultShortcut();
        } catch {}
      }
      function persistBookmarks() {
        try {
          // Save the list to the local mirror first so the offline copy is
          // never lost, even if the steps below hiccup. Then keep the
          // springboard layout in step with the bookmark list (new ones get
          // placed, deleted ones pruned); persistLayout() stamps each
          // bookmark's folder/page/position, saves again, and mirrors
          // everything up to the Google Sheet.
          persistBookmarksLocal();
          syncLayout();
          persistLayout();
          return true;
        }
        catch { return false; }
      }
      function persistBookmarksLocal() {
        localStorage.setItem(LS_BOOKMARKS, JSON.stringify(STATE.bookmarks));
      }
      function persistSettings() {
        try { localStorage.setItem(LS_SETTINGS, JSON.stringify(STATE.settings)); } catch {}
      }
      function loadLayout() {
        try {
          const l = JSON.parse(localStorage.getItem(LS_LAYOUT) || 'null');
          if (l && Array.isArray(l.pages)) {
            if (!Array.isArray(l.pageNames)) l.pageNames = [];
            STATE.layout = l;
          }
        } catch {}
      }
      // Persist the springboard arrangement. Beyond saving the layout object to
      // localStorage, this stamps the folder / page / position of every
      // bookmark and mirrors the whole thing up to the Google Sheet, so the
      // arrangement — not just the list of sites — follows the user to any
      // device. Every layout change (drag, folder rename, page move, add,
      // delete) flows through here, so cross-device placement stays in step.
      function persistLayout() {
        try { localStorage.setItem(LS_LAYOUT, JSON.stringify(STATE.layout)); } catch {}
        writeLayoutToBookmarks();
        persistBookmarksLocal();
        // Mirror the change up to the Google Sheet (queued; a no-op when no
        // app_token is set, and gated until the first sync has baselined the
        // snapshot). Never let a sync hiccup fail the local save.
        try { syncSheet(); } catch {}
      }

      /* ================================================================
       * Google Sheet sync — mappers, network, and an offline write queue
       * ================================================================ */

      // localStorage object -> internal bookmark, preserving the metadata
      // columns so they survive a round-trip even though only id/name/url
      // drive the UI.
      function normalizeBookmark(x) {
        x = x || {};
        return {
          id: x.id || uid(),
          name: String(x.name || '').trim(),
          url: String(x.url || '').trim(),
          folder: x.folder ?? '', page: x.page ?? '', position: x.position ?? '',
          owner: x.owner ?? '', dateAdded: x.dateAdded ?? '',
          lastOpened: x.lastOpened ?? '', timesOpened: x.timesOpened ?? '',
          notes: x.notes ?? '', icon: x.icon ?? ''
        };
      }

      // Sheet row -> internal bookmark, using the exact column names as keys.
      function fromSheetRow(row) {
        row = row || {};
        const str = v => (v == null ? '' : String(v));
        return {
          id: str(row['Bookmark ID']).trim() || uid(),
          name: str(row['Name']).trim(),
          url: str(row['URL']).trim(),
          folder: row['Folder'] ?? '',
          page: row['Page'] ?? '',
          position: row['Position'] ?? '',
          owner: row['Owner (Profile ID)'] ?? '',
          dateAdded: row['Date Added'] ?? '',
          lastOpened: row['Last Opened'] ?? '',
          timesOpened: row['Times Opened'] ?? '',
          notes: row['Notes'] ?? '',
          icon: row['Icon'] ?? ''
        };
      }

      // Internal bookmark -> Sheet row, using the exact column names. A new
      // bookmark gets a Date Added stamp (written back so it stays stable);
      // metadata the app doesn't manage is passed through untouched.
      function toSheetRow(bm) {
        if (!bm.dateAdded) bm.dateAdded = new Date().toISOString();
        // Page/Position can arrive from the sheet as numbers or strings; coerce
        // both to a canonical string here (used for outgoing rows AND the
        // snapshot baseline) so a number-vs-string mismatch never looks like a
        // change and triggers a needless re-save on every sync.
        const cell = v => (v == null || v === '' ? '' : String(v));
        return {
          'Bookmark ID': bm.id,
          'Name': bm.name || '',
          'URL': bm.url || '',
          'Folder': bm.folder ?? '',
          'Page': cell(bm.page),
          'Position': cell(bm.position),
          'Owner (Profile ID)': bm.owner ?? '',
          'Date Added': bm.dateAdded,
          'Last Opened': bm.lastOpened ?? '',
          'Times Opened': bm.timesOpened ?? '',
          'Notes': bm.notes ?? '',
          // Mirror a hosted image URL up to the sheet so the same thumbnail
          // follows the user to any device. An uploaded image (a large data:
          // URL) stays on this device — it won't fit a sheet cell.
          'Icon': /^https?:\/\//i.test(String(bm.icon || '').trim()) ? String(bm.icon).trim() : ''
        };
      }

      /* ---- network ---- */
      // POST as text/plain;charset=utf-8 so the browser keeps it a "simple"
      // request and skips the CORS preflight that Apps Script can't answer.
      // The body is still JSON text; the token is injected here so it never
      // has to sit in the persisted queue.
      async function sheetPost(payload) {
        const res = await fetch(SHEET.url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(Object.assign({ token: SHEET.token }, payload))
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        let data = {};
        try { data = await res.json(); } catch {}
        if (data && data.ok === false) throw new Error(data.error || 'sheet rejected the write');
        return data;
      }
      // GET the full list. token rides as a query param per the web app's API.
      async function apiGetBookmarks() {
        const u = new URL(SHEET.url);
        u.searchParams.set('action', 'getBookmarks');
        u.searchParams.set('token', SHEET.token);
        const res = await fetch(u.toString(), { method: 'GET' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data || !data.ok || !Array.isArray(data.bookmarks))
          throw new Error('unexpected getBookmarks response');
        return data.bookmarks;
      }

      /* ---- offline write queue ---- */
      let OUTBOX_SEQ = Date.now();
      function loadOutbox() {
        try { const o = JSON.parse(localStorage.getItem(LS_OUTBOX) || '[]'); return Array.isArray(o) ? o : []; }
        catch { return []; }
      }
      function saveOutbox(q) { try { localStorage.setItem(LS_OUTBOX, JSON.stringify(q)); } catch {} }
      // Queue a write and (when we think we're online) try to flush. A newer
      // save/delete for a bookmark supersedes an older pending save for the
      // same id; activity entries are distinct events and never collapse.
      function enqueue(item) {
        const q = loadOutbox();
        if (item.action === 'saveBookmark' || item.action === 'deleteBookmark') {
          const id = item.action === 'saveBookmark' ? item.bookmark['Bookmark ID'] : item.id;
          for (let i = q.length - 1; i >= 0; i--) {
            const it = q[i];
            const itId = it.action === 'saveBookmark' ? (it.bookmark && it.bookmark['Bookmark ID'])
              : it.action === 'deleteBookmark' ? it.id : undefined;
            if (itId !== undefined && itId === id) q.splice(i, 1);
          }
        }
        item.seq = ++OUTBOX_SEQ;
        q.push(item);
        saveOutbox(q);
        if (SHEET.online) flushOutbox();
      }
      // Drain the queue in order. Stop at the first failure (treat the sheet
      // as offline) and keep the remainder for the next attempt. Items are
      // removed by seq so a concurrent enqueue can't drop an unsent write.
      async function flushOutbox() {
        if (SHEET.flushing || !sheetEnabled()) return;
        SHEET.flushing = true;
        try {
          while (true) {
            const q = loadOutbox();
            if (!q.length) { SHEET.online = true; break; }
            const item = q[0];
            try {
              const { seq, ...body } = item;
              await sheetPost(body);
            } catch {
              SHEET.online = false;
              break;
            }
            SHEET.online = true;
            saveOutbox(loadOutbox().filter(x => x.seq !== item.seq));
          }
        } finally {
          SHEET.flushing = false;
        }
      }

      /* ---- reconcile + activity ---- */
      // Diff the current list against the last-known sheet state: changed or
      // new rows queue a save, vanished ids queue a delete. Cheap, idempotent,
      // and a no-op without a token — safe to call after any change.
      function syncSheet() {
        if (!sheetEnabled() || !SHEET.ready) return;
        const seen = new Set();
        for (const bm of STATE.bookmarks) {
          seen.add(bm.id);
          const json = JSON.stringify(toSheetRow(bm));
          if (SHEET.snapshot[bm.id] !== json) {
            SHEET.snapshot[bm.id] = json;
            enqueue({ action: 'saveBookmark', bookmark: JSON.parse(json) });
          }
        }
        for (const id of Object.keys(SHEET.snapshot)) {
          if (!seen.has(id)) {
            delete SHEET.snapshot[id];
            enqueue({ action: 'deleteBookmark', id });
          }
        }
      }
      // Treat the current list as already in step with the sheet (used right
      // after a load) so we don't immediately echo it all back.
      function rebuildSnapshot() {
        SHEET.snapshot = Object.create(null);
        for (const bm of STATE.bookmarks) SHEET.snapshot[bm.id] = JSON.stringify(toSheetRow(bm));
      }
      // Mirror a recorded user action to the sheet's Activity Log. Keys match
      // that tab's column headers exactly; Timestamp is left to the script,
      // which stamps a real Date when the field is omitted.
      function queueActivity(a) {
        if (!sheetEnabled() || !a) return;
        enqueue({
          action: 'logActivity',
          entry: {
            'Action': a.type || '',
            'Name': a.name || '',
            'URL': a.url || '',
            'What You Said': a.query || '',
            'Message': a.text || ''
          }
        });
      }

      /* ---- load ---- */
      // A loose URL key so the first-run merge doesn't duplicate a site the
      // sheet already lists (ignoring scheme, leading www, and trailing slash).
      function normUrlKey(u) {
        return String(u || '').trim().toLowerCase()
          .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
      }
      // Pull the list from the sheet; on any failure keep the local mirror on
      // screen (the app keeps working offline). On success the sheet is
      // authoritative — except the very first time this device syncs, when any
      // bookmark it has locally that the sheet lacks is preserved and pushed
      // up, so switching from localStorage to the sheet never loses data.
      async function syncFromSheet() {
        if (!sheetEnabled()) return;
        let rows;
        try { rows = await apiGetBookmarks(); }
        catch (e) {
          SHEET.online = false;   // stay on local data
          console.warn('Bookmarks Buddy: could not reach the sheet — using local data.', e);
          return;
        }
        SHEET.online = true;
        const remote = rows.map(fromSheetRow).filter(b => b.url);
        let firstRun = false;
        try { firstRun = !localStorage.getItem(LS_SYNCED); } catch {}
        if (firstRun) {
          const have = new Set(remote.map(b => normUrlKey(b.url)));
          const localOnly = STATE.bookmarks.filter(b => b.url && !have.has(normUrlKey(b.url)));
          STATE.bookmarks = remote.concat(localOnly);
        } else {
          STATE.bookmarks = remote;
        }
        try { localStorage.setItem(LS_SYNCED, '1'); } catch {}
        persistBookmarksLocal();
        // Baseline the snapshot to the sheet's rows; syncSheet() then queues
        // saves for any preserved local-only bookmarks (and nothing else).
        SHEET.snapshot = Object.create(null);
        for (const b of remote) SHEET.snapshot[b.id] = JSON.stringify(toSheetRow(b));
        SHEET.ready = true;
        // Rebuild the springboard from the placement the sheet carried, so the
        // arrangement — pages, slots, folders — is restored on this device too.
        buildLayoutFromBookmarks();
        persistLayout();
        render();
        syncSheet();      // push up local-only bookmarks (no-op in steady state)
        flushOutbox();
      }

      function uid() { return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

      /* ================================================================
       * Springboard layout — arrange bookmarks like apps on an iPhone
       * home screen (pages + folders), kept reconciled with the flat
       * STATE.bookmarks list.
       * ================================================================ */
      // Each page is a FIXED-LENGTH grid of PAGE_SIZE "slots". A slot holds a
      // cell ({type:'app'|'folder',…}) or null when empty. Keeping empty slots
      // explicit is what lets apps and folders stay exactly where they're
      // dropped — leaving gaps anywhere on the page, just like an iPhone home
      // screen — instead of always packing toward the top-left.
      function newPage() { return new Array(PAGE_SIZE).fill(null); }
      function isPageEmpty(p) { return !p.some(s => s); }
      function firstEmptySlot(p) { const i = p.indexOf(null); return i; }
      function pageArr(i) { return STATE.layout.pages[i]; }

      /* ---- page names (parallel to STATE.layout.pages) ----
       * Each page can carry an optional custom name; the names live in a
       * parallel array indexed exactly like pages[], so the two are reordered,
       * filtered and rebuilt in lockstep. An empty name just shows "Page N". */
      function pageNamesArr() {
        if (!Array.isArray(STATE.layout.pageNames)) STATE.layout.pageNames = [];
        return STATE.layout.pageNames;
      }
      function hasPageName(n) { return !!(n && String(n).trim()); }
      function pageNameRaw(i) { const n = pageNamesArr()[i]; return n == null ? '' : String(n); }
      // What the rail / springboard show for a page: the custom name, or a
      // sensible "Page N" default when it has none.
      function pageDisplayName(i) { return hasPageName(pageNameRaw(i)) ? pageNameRaw(i).trim() : ('Page ' + (i + 1)); }
      // Keep the names array the same length as pages[] (pad new trailing pages
      // with '', drop names for pages that no longer exist). Index-shifting
      // removals are handled where they happen, so this only ever pads/trims
      // the tail.
      function normalizePageNames() {
        const pages = STATE.layout.pages || [];
        const names = pageNamesArr();
        while (names.length < pages.length) names.push('');
        if (names.length > pages.length) names.length = pages.length;
        for (let i = 0; i < names.length; i++) names[i] = names[i] == null ? '' : String(names[i]);
      }
      // Move a page one step earlier (toward the first/default page) or later,
      // carrying its name and keeping the viewed page following the moved one.
      function movePage(i, dir) {
        const pages = STATE.layout.pages, names = pageNamesArr();
        const j = i + dir;
        if (j < 0 || j >= pages.length) return;
        const tp = pages[i]; pages[i] = pages[j]; pages[j] = tp;
        const tn = names[i]; names[i] = names[j]; names[j] = tn;
        if (STATE.currentPage === i) STATE.currentPage = j;
        else if (STATE.currentPage === j) STATE.currentPage = i;
        persistLayout();
        render();
      }
      // Encode a page's number + optional name into the single "Page" field
      // that travels through the sheet. parseInt() still reads the leading
      // number, so old code and old rows round-trip unchanged; the name (if
      // any) rides along after a "|" so it follows the user across devices.
      function encodePageField(num, name) {
        return hasPageName(name) ? (num + '|' + String(name).trim()) : String(num);
      }
      function findFolderById(fid) {
        for (const page of STATE.layout.pages)
          for (const it of page) if (it && it.type === 'folder' && it.id === fid) return it;
        return null;
      }
      function asApp(item) { return { type: 'app', id: item.id }; }
      function makeFolder(appA, appB) {
        return { type: 'folder', id: 'f' + uid(), name: 'Folder', items: [asApp(appA), asApp(appB)] };
      }
      function clampCurrentPage() {
        const n = Math.max(1, STATE.layout.pages.length);
        STATE.currentPage = Math.min(Math.max(0, STATE.currentPage), n - 1);
      }
      // Coerce every page to a length-PAGE_SIZE slot array. Also migrates the
      // older packed format (variable-length arrays with no empty slots) by
      // padding it out with nulls; any overflow spills onto a new page.
      function ensureSlots() {
        const pages = STATE.layout.pages;
        for (let i = 0; i < pages.length; i++) {
          let p = Array.isArray(pages[i]) ? pages[i].filter(s => s !== undefined) : [];
          if (p.length > PAGE_SIZE) {
            const overflow = p.slice(PAGE_SIZE);
            p = p.slice(0, PAGE_SIZE);
            pages.splice(i + 1, 0, overflow); // re-shaped on the next loop pass
            pageNamesArr().splice(i + 1, 0, ''); // the spilled page is a fresh, unnamed one
          }
          while (p.length < PAGE_SIZE) p.push(null);
          pages[i] = p;
        }
      }
      // Drop the first empty slot found anywhere, opening a fresh page if every
      // page is full. Used when adding a new bookmark or re-homing a displaced
      // app (e.g. one pulled out of a folder).
      function placeInFirstEmpty(cell) {
        for (const page of STATE.layout.pages) {
          const s = firstEmptySlot(page);
          if (s !== -1) { page[s] = cell; return; }
        }
        const p = newPage(); p[0] = cell; STATE.layout.pages.push(p); pageNamesArr().push('');
      }
      function addAppToLayout(id) { placeInFirstEmpty({ type: 'app', id }); }
      // Place a freshly added app on the page the user is currently viewing, so
      // "Add" drops it where they're looking instead of back-filling an earlier
      // page. If that page is full, spill forward to the next page with room (or
      // a brand-new page) — never backward onto a previous page. Call this
      // BEFORE persistBookmarks()/syncLayout() so the auto-placer leaves it put.
      function placeNewAppOnCurrentPage(id) {
        const cell = { type: 'app', id };
        const pages = STATE.layout.pages;
        const start = pages.length ? Math.min(Math.max(0, STATE.currentPage), pages.length - 1) : 0;
        for (let i = start; i < pages.length; i++) {
          const s = firstEmptySlot(pages[i]);
          if (s !== -1) { pages[i][s] = cell; return; }
        }
        const p = newPage(); p[0] = cell; pages.push(p); pageNamesArr().push('');
      }
      // Which page a given bookmark ended up on (so the view can jump to it).
      function pageIndexOfApp(id) {
        for (let i = 0; i < STATE.layout.pages.length; i++)
          for (const it of STATE.layout.pages[i]) {
            if (!it) continue;
            if (it.type === 'app' && it.id === id) return i;
            if (it.type === 'folder' && it.items.some(a => a.id === id)) return i;
          }
        return STATE.layout.pages.length - 1;
      }
      // Tidy folders (drop missing apps, dissolve folders left with <2 apps),
      // drop stale app cells, remove fully-empty pages, and close a folder
      // overlay that vanished. Gaps within a page are always preserved.
      function normalizeLayout() {
        if (!STATE.layout || !Array.isArray(STATE.layout.pages)) STATE.layout = { pages: [] };
        ensureSlots();
        const valid = new Set(STATE.bookmarks.map(b => b.id));
        for (const page of STATE.layout.pages) {
          for (let i = 0; i < page.length; i++) {
            const it = page[i];
            if (!it) continue;
            if (it.type === 'folder') {
              it.items = it.items.filter(a => valid.has(a.id));
              if (it.items.length === 0) page[i] = null;
              else if (it.items.length === 1) page[i] = { type: 'app', id: it.items[0].id };
            } else if (it.type === 'app' && !valid.has(it.id)) {
              page[i] = null;
            }
          }
        }
        // Drop empty pages — but keep a page the user has named (so a freshly
        // named, not-yet-filled page sticks around), and, while arranging, keep
        // one trailing empty page as the "new page" to drop apps onto. The
        // names array is filtered by the very same mask so it stays in lockstep.
        const pages = STATE.layout.pages;
        const names = pageNamesArr();
        const lastI = pages.length - 1;
        const keepTrailingEmpty = STATE.editMode && pages.length > 0 && isPageEmpty(pages[lastI]);
        const keep = pages.map((p, i) =>
          !isPageEmpty(p) || hasPageName(names[i]) || (keepTrailingEmpty && i === lastI));
        STATE.layout.pages = pages.filter((_, i) => keep[i]);
        STATE.layout.pageNames = names.filter((_, i) => keep[i]);
        if (!STATE.layout.pages.length) { STATE.layout.pages.push(newPage()); STATE.layout.pageNames.push(''); }
        // While arranging, guarantee a trailing empty "new page" at the end so
        // an app can always be dragged (or swiped/arrowed) onto a fresh page —
        // just like an iPhone home screen in jiggle mode.
        if (STATE.editMode && !isPageEmpty(STATE.layout.pages[STATE.layout.pages.length - 1])) {
          STATE.layout.pages.push(newPage()); STATE.layout.pageNames.push('');
        }
        normalizePageNames();
        clampCurrentPage();
        if (STATE.openFolderId && !findFolderById(STATE.openFolderId)) STATE.openFolderId = null;
      }
      // Reconcile the layout with the bookmark list: drop stale app cells, add
      // any bookmark that isn't placed yet, then normalize.
      function syncLayout() {
        if (!STATE.layout || !Array.isArray(STATE.layout.pages)) STATE.layout = { pages: [] };
        ensureSlots();
        const valid = new Set(STATE.bookmarks.map(b => b.id));
        for (const page of STATE.layout.pages) {
          for (let i = 0; i < page.length; i++) {
            const it = page[i];
            if (it && it.type === 'app' && !valid.has(it.id)) page[i] = null;
          }
        }
        normalizeLayout();
        const present = new Set();
        for (const page of STATE.layout.pages) for (const it of page) {
          if (!it) continue;
          if (it.type === 'app') present.add(it.id);
          else if (it.type === 'folder') it.items.forEach(a => present.add(a.id));
        }
        for (const b of STATE.bookmarks) if (!present.has(b.id)) addAppToLayout(b.id);
        normalizePageNames();
        clampCurrentPage();
      }
      function moveAppOutOfFolder(fid, id) {
        const f = findFolderById(fid);
        if (!f) return;
        const idx = f.items.findIndex(a => a.id === id);
        if (idx < 0) return;
        f.items.splice(idx, 1);
        addAppToLayout(id);
      }

      /* ================================================================
       * Layout <-> sheet bridge — encode the springboard arrangement into
       * each bookmark's Folder / Page / Position fields so it travels through
       * the Google Sheet and is rebuilt verbatim on every other device.
       *
       * Encoding (kept human-readable in the sheet):
       *   • Page     = 1-based page number the cell sits on, with the page's
       *                custom name appended after a "|" when it has one
       *                ("2|Work"). parseInt() still reads the number, so this
       *                stays backward compatible with rows that carry a bare
       *                number — and the name now follows the user across devices.
       *   • Position = the slot index (0..PAGE_SIZE-1) for an app sitting
       *                directly on a page; "F<folderSlot>:<indexInFolder>"
       *                for an app living inside a folder.
       *   • Folder   = the folder's name (blank for an app on the page).
       * ================================================================ */
      // Stamp folder/page/position onto every bookmark from the current layout.
      function writeLayoutToBookmarks() {
        const byId = Object.create(null);
        for (const b of STATE.bookmarks) byId[b.id] = b;
        const placed = new Set();
        const pages = (STATE.layout && STATE.layout.pages) || [];
        for (let p = 0; p < pages.length; p++) {
          const page = pages[p];
          const pageField = encodePageField(p + 1, pageNameRaw(p)); // "<n>" or "<n>|<name>"
          for (let s = 0; s < page.length; s++) {
            const it = page[s];
            if (!it) continue;
            if (it.type === 'app') {
              const b = byId[it.id];
              if (b) { b.folder = ''; b.page = pageField; b.position = s; placed.add(b.id); }
            } else if (it.type === 'folder') {
              for (let k = 0; k < it.items.length; k++) {
                const b = byId[it.items[k].id];
                if (b) { b.folder = it.name || 'Folder'; b.page = pageField; b.position = 'F' + s + ':' + k; placed.add(b.id); }
              }
            }
          }
        }
        // Anything not represented in the layout gets its placement cleared so a
        // stale page/slot doesn't linger in the sheet.
        for (const b of STATE.bookmarks) if (!placed.has(b.id)) { b.folder = ''; b.page = ''; b.position = ''; }
      }

      // Rebuild STATE.layout from the bookmarks' Folder/Page/Position fields
      // (as synced from the sheet). Anything without a valid placement — new
      // sites added on another device, or first-run local-only ones — is left
      // for syncLayout() to drop into the first open slot.
      function buildLayoutFromBookmarks() {
        const pages = [];
        const names = [];                       // page name carried in the "Page" field
        const ensurePage = (p) => { while (pages.length <= p) pages.push(newPage()); return pages[p]; };
        const folderAt = Object.create(null); // "page:slot" -> folder cell
        for (const b of STATE.bookmarks) {
          // "Page" may be a bare number ("2") or number + name ("2|Work").
          const ps = String(b.page == null ? '' : b.page);
          const pm = ps.match(/^\s*(\d+)\s*(?:\|([\s\S]*))?$/);
          const p = pm ? parseInt(pm[1], 10) : parseInt(ps, 10);
          const pname = pm && pm[2] != null ? pm[2].trim() : '';
          if (Number.isInteger(p) && p >= 1 && pname && !names[p - 1]) names[p - 1] = pname;
          const pos = String(b.position == null ? '' : b.position).trim();
          if (!Number.isInteger(p) || p < 1 || pos === '') continue;
          const fm = pos.match(/^F(\d+):(\d+)$/);
          if (fm) {
            const slot = parseInt(fm[1], 10), idx = parseInt(fm[2], 10);
            if (slot < 0 || slot >= PAGE_SIZE) continue;
            const key = (p - 1) + ':' + slot;
            let f = folderAt[key];
            if (!f) {
              f = { type: 'folder', id: 'f' + uid(), name: String(b.folder || 'Folder'), items: [] };
              folderAt[key] = f;
              ensurePage(p - 1)[slot] = f;
            }
            f.items[idx] = { type: 'app', id: b.id }; // by index, to preserve order
          } else {
            const slot = parseInt(pos, 10);
            if (!Number.isInteger(slot) || slot < 0 || slot >= PAGE_SIZE) continue;
            const page = ensurePage(p - 1);
            if (page[slot]) continue; // collision — let syncLayout re-home it
            page[slot] = { type: 'app', id: b.id };
          }
        }
        // Compact folder item arrays (a missing index leaves a hole).
        for (const key in folderAt) folderAt[key].items = folderAt[key].items.filter(Boolean);
        const builtPages = pages.length ? pages : [newPage()];
        STATE.layout = { pages: builtPages, pageNames: builtPages.map((_, i) => names[i] || '') };
        // Place anything still unplaced and tidy folders (<2 items dissolve).
        syncLayout();
      }

      /* ---------------- escaping ---------------- */
      function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
      function escAttr(s) { return escHtml(s); }

      /* ================================================================
       * URL + matching helpers
       * ================================================================ */

      // Normalize free text for matching: lowercase, strip punctuation,
      // collapse whitespace.
      function normalize(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      }

      // A looser normalize that keeps dots and hyphens — used when adding a
      // bookmark by voice so a spoken address ("salesforce.com") survives
      // intact instead of being flattened into "salesforce com".
      function normalizeLoose(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9\s.\-]/g, ' ').replace(/\s+/g, ' ').trim();
      }

      // Title-case spoken words for a friendly bookmark name: "bank of
      // america" -> "Bank Of America", "salesforce" -> "Salesforce".
      function titleCase(s) {
        return String(s || '').replace(/\b[a-z]/g, c => c.toUpperCase());
      }

      // Prepend https:// when the user typed a bare host.
      function ensureScheme(url) {
        const u = String(url || '').trim();
        if (!u) return '';
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
        if (/^(mailto:|tel:)/i.test(u)) return u;
        return 'https://' + u.replace(/^\/+/, '');
      }

      function looksLikeUrl(url) {
        const u = String(url || '').trim();
        if (!u) return false;
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return true;
        return /^[^\s.]+\.[^\s.]{2,}/.test(u); // has a dot + a TLD-ish tail
      }

      function hostOf(url) {
        try { return new URL(ensureScheme(url)).hostname.replace(/^www\./, ''); }
        catch { return ''; }
      }

      // The memorable core of a host: "login.salesforce.com" -> "salesforce".
      function hostCore(url) {
        const h = hostOf(url);
        if (!h) return '';
        const parts = h.split('.').filter(Boolean);
        if (parts.length <= 1) return h;
        // Drop the TLD; for "co.uk" style, drop the last two.
        const tail2 = parts.slice(-2).join('.');
        const multi = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(tail2);
        const core = multi ? parts[parts.length - 3] : parts[parts.length - 2];
        return core || parts[0];
      }

      function faviconFor(url) {
        const h = hostOf(url);
        return h ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(h)}&sz=64` : '';
      }

      // The thumbnail to show for a bookmark: a user-set custom image (URL or
      // uploaded data URL) wins; otherwise we fall back to the site's favicon.
      // Used everywhere a bookmark tile/icon is drawn so a custom thumbnail
      // shows consistently across the springboard, folders, and search.
      function iconFor(bm) {
        const custom = String(bm && bm.icon || '').trim();
        return custom || faviconFor(bm ? bm.url : '');
      }

      // A deterministic, vibrant gradient used to give bookmarks that have no
      // usable image a distinct, colorful tile instead of a plain gray letter.
      // The seed (name or URL) hashes to a stable hue, so a given site always
      // gets the same color across the springboard, folders, and search. The
      // output is fixed-format (only hsl numbers) and contains no quotes, so it
      // is safe to drop straight into an inline style or onerror handler.
      function iconGradient(seed) {
        const s = String(seed || '?');
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        const hue = (h >>> 0) % 360;
        return `linear-gradient(135deg, hsl(${hue},72%,60%), hsl(${(hue + 42) % 360},70%,47%))`;
      }

      // Levenshtein-based 0..1 similarity for short strings (typo tolerance).
      function levenshtein(a, b) {
        a = a || ''; b = b || '';
        if (a === b) return 0;
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
          let cur = [i];
          for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
          }
          prev = cur;
        }
        return prev[b.length];
      }
      function simRatio(a, b) {
        a = a || ''; b = b || '';
        if (!a || !b) return 0;
        const m = Math.max(a.length, b.length);
        return m ? 1 - levenshtein(a, b) / m : 0;
      }

      // Score how well a spoken query matches a bookmark (0..1).
      function scoreBookmark(query, bm) {
        const q = normalize(query);
        if (!q) return 0;
        const name = normalize(bm.name);
        const core = normalize(hostCore(bm.url));
        const host = normalize(hostOf(bm.url).replace(/\./g, ' '));
        let best = 0;

        for (const cand of [name, core]) {
          if (!cand) continue;
          if (cand === q) return 1;
          best = Math.max(best, simRatio(q, cand));
        }

        // Substring containment in either direction is a strong signal.
        for (const cand of [name, core, host]) {
          if (!cand) continue;
          if (cand.includes(q) || q.includes(cand)) {
            const ratio = Math.min(q.length, cand.length) / Math.max(q.length, cand.length);
            best = Math.max(best, 0.78 + 0.2 * ratio);
          }
        }

        // Every spoken word lands somewhere in the name/host -> very likely.
        const qTokens = q.split(' ').filter(Boolean);
        const hay = (name + ' ' + host + ' ' + core).trim();
        if (qTokens.length && qTokens.every(w => hay.includes(w))) best = Math.max(best, 0.9);

        // Per-word fuzzy: any spoken word close to any name/host word.
        const hayWords = hay.split(' ').filter(Boolean);
        for (const w of qTokens) {
          for (const hw of hayWords) {
            if (w.length >= 3 && hw.length >= 3) best = Math.max(best, 0.7 * simRatio(w, hw));
          }
        }

        // The optional description note widens what voice can find: saying
        // something captured in a bookmark's note ("open my expense report")
        // resolves it even when the name/host don't contain those words. Scored
        // a notch below name/host matches and gated on longer words so an
        // all-day listener doesn't open tabs on ordinary chatter.
        const notes = normalize(bm.notes);
        if (notes && q.length >= 3) {
          if (notes.includes(q)) {
            const ratio = Math.min(q.length, notes.length) / Math.max(q.length, notes.length);
            best = Math.max(best, 0.6 + 0.18 * ratio);
          }
          const noteWords = notes.split(' ').filter(Boolean);
          for (const w of qTokens)
            for (const nw of noteWords)
              if (w.length >= 4 && nw.length >= 4) best = Math.max(best, 0.6 * simRatio(w, nw));
        }
        return best;
      }

      function matchBookmark(query, threshold) {
        let best = null;
        for (const bm of STATE.bookmarks) {
          const score = scoreBookmark(query, bm);
          if (score >= threshold && (!best || score > best.score)) best = { bm, score };
        }
        return best;
      }

      // Every folder across all springboard pages, flattened for matching.
      function allFolders() {
        const out = [];
        for (const page of STATE.layout.pages)
          for (const it of page) if (it && it.type === 'folder') out.push(it);
        return out;
      }

      // Score a spoken query against a folder's name (0..1). The literal word
      // "folder"/"group" is dropped first so "open my work folder" scores on
      // "work". Mirrors scoreBookmark's name handling (exact / containment /
      // per-word fuzzy) so folders feel as forgiving as single bookmarks.
      function scoreFolder(query, folder) {
        const q = normalize(query).replace(/\b(folder|group)\b/g, ' ').replace(/\s+/g, ' ').trim();
        const name = normalize(folder.name);
        if (!q || !name) return 0;
        if (name === q) return 1;
        let best = simRatio(q, name);
        if (name.includes(q) || q.includes(name)) {
          const ratio = Math.min(q.length, name.length) / Math.max(q.length, name.length);
          best = Math.max(best, 0.78 + 0.2 * ratio);
        }
        const qTokens = q.split(' ').filter(Boolean);
        const nameWords = name.split(' ').filter(Boolean);
        if (qTokens.length && qTokens.every(w => name.includes(w))) best = Math.max(best, 0.9);
        for (const w of qTokens)
          for (const nw of nameWords)
            if (w.length >= 3 && nw.length >= 3) best = Math.max(best, 0.7 * simRatio(w, nw));
        return best;
      }

      function matchFolder(query, threshold) {
        let best = null;
        for (const f of allFolders()) {
          const score = scoreFolder(query, f);
          if (score >= threshold && (!best || score > best.score)) best = { folder: f, score };
        }
        return best;
      }

      // Resolve one spoken name to a single target: a folder (which fans out to
      // every site inside it) or one bookmark. Saying "folder"/"group" forces
      // the folder reading; otherwise a bookmark wins ties and a folder only
      // wins when it scores strictly higher. Returns a tagged object with the
      // winning score, or null when nothing clears the bar.
      function resolveTarget(query) {
        const q = normalize(query);
        if (!q) return null;
        const wantsFolder = /\b(folder|group)\b/.test(q);
        const folderMatch = matchFolder(q, wantsFolder ? 0.34 : 0.52);
        const bmMatch = matchBookmark(q, 0.42);
        if (wantsFolder && folderMatch) return { kind: 'folder', folder: folderMatch.folder, score: folderMatch.score };
        if (bmMatch && (!folderMatch || bmMatch.score >= folderMatch.score))
          return { kind: 'bookmark', bm: bmMatch.bm, score: bmMatch.score };
        if (folderMatch) return { kind: 'folder', folder: folderMatch.folder, score: folderMatch.score };
        return null;
      }

      // Resolve a phrase that may name several groups at once — "open games and
      // searches", "open games in searches". The whole phrase is tried as a
      // single target first so a real name that contains a joiner ("News and
      // Sports") stays intact; only when that isn't a confident match do we
      // split on the joiners and resolve each part. Returns a list of targets.
      function resolveTargets(query) {
        const whole = resolveTarget(query);
        const parts = query.split(MULTI_JOIN_RE).map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2 && (!whole || whole.score < 0.9)) {
          const each = parts.map(resolveTarget).filter(Boolean);
          if (each.length >= 2) return each;
        }
        return whole ? [whole] : [];
      }

      // Expand a resolved target to the bookmarks it should open — one for a
      // bookmark target, the whole group for a folder target.
      function targetBookmarks(target) {
        if (!target) return [];
        if (target.kind === 'bookmark') return target.bm ? [target.bm] : [];
        return target.folder.items
          .map(a => STATE.bookmarks.find(b => b.id === a.id))
          .filter(bm => bm && ensureScheme(bm.url));
      }

      // Flatten a list of targets into a de-duplicated bookmark list plus a
      // human label, so several folders/bookmarks open as one batch.
      function collectTargets(targets) {
        const seen = new Set();
        const bms = [];
        for (const t of targets) {
          for (const bm of targetBookmarks(t)) {
            if (!seen.has(bm.id)) { seen.add(bm.id); bms.push(bm); }
          }
        }
        const label = targets
          .map(t => t.kind === 'folder' ? t.folder.name : (t.bm.name || hostCore(t.bm.url)))
          .join(' & ');
        return { bms, label };
      }

      /* ================================================================
       * Command parsing — turn a spoken phrase into an intent
       * ================================================================ */
      const ACTION_VERBS = /\b(open up|open|launch|go to|goto|pull up|bring up|navigate to|take me to|show me|load up|load|start up|start|fire up|jump to|switch to|switch over to|visit|head to|head over to|get me|bring me to|take me over to)\b/;
      // Verbs that mean "save a new bookmark". Longest phrases first so
      // "add a bookmark for X" doesn't get clipped to a bare "add" + junk.
      // Bare "favorite/favourite" is left out on purpose — it's usually an
      // adjective ("open my favorite site"), so it must not trigger an add.
      const ADD_VERBS = /\b(create a bookmark for|add a bookmark for|save a bookmark for|new bookmark for|add a bookmark|new bookmark|add to (my )?(bookmarks|favorites|favourites)|bookmark|add|save|remember)\b/;
      const STOP_RE = /\b(stop listening|stop the assistant|stop bookmarks buddy|quit listening|turn (it |yourself )?off|go to sleep|that's all|stop now)\b/;
      const HELP_RE = /\b(what can you do|what do you do|help me out|show help|list (my )?bookmarks|what are my bookmarks|what bookmarks)\b/;
      // Split view — open a page (or two pages) side by side, mirroring the
      // browser tab menu's "Add tab to new split view". The strong form names
      // split view/screen/tabs or "side by side" explicitly; the loose bare
      // "split" only counts when two names are joined ("split Notion and Gmail").
      const SPLIT_STRONG_RE = /\b(split[\s-]?(?:view|screen|tabs?)|splitview|splitscreen|side[\s-]?by[\s-]?side)\b/;
      const SPLIT_LOOSE_RE = /\bsplit\b/;
      // Conjunctions that separate the two sites in a split request.
      const SPLIT_JOIN_RE = /\b(?:and|with|plus|versus|vs|alongside|next to|together with|beside)\b/;
      // Conjunctions that separate several targets in one open/split request —
      // "open games and searches", "open games in searches", "Notion, Gmail".
      // Broader than SPLIT_JOIN_RE (it also accepts commas, "&", and a bare
      // "in") because an open command lists groups rather than pitting two
      // sites against each other.
      const MULTI_JOIN_RE = /\s*(?:,|&|\b(?:and|with|plus|also|then|in|alongside|together with|beside)\b)\s*/;

      // Common TLDs people speak — used to glue a trailing "<name> com" back
      // into a real domain when the recognizer dropped the dot.
      const SPOKEN_TLDS = ['com', 'org', 'net'];

      // Connector/filler words that are never a company name on their own. After
      // the add verb is stripped, a leftover like "in" ("add in", a mis-heard
      // fragment) must NOT become a bookmark such as "in.com". These are trimmed
      // off the edges of a bare-name add phrase, and a phrase that is nothing but
      // these is rejected entirely.
      const ADD_STOPWORDS = new Set([
        'in', 'on', 'at', 'to', 'into', 'onto', 'up', 'it', 'its', "it's",
        'of', 'and', 'or', 'with', 'for', 'a', 'an', 'the', 'my', 'me',
        'this', 'that', 'is', 'as', 'by', 'be', 'so', 'um', 'uh', 'one'
      ]);

      // Strip polite filler and "bookmark"-ish words from a spoken add phrase
      // while PRESERVING dots/hyphens so a dictated URL stays a URL.
      function cleanAddQuery(q) {
        q = ' ' + q + ' ';
        q = q
          .replace(/\b(please|for me|right now|now|real quick|hey|ok|okay|bookmarks? buddy|can you|could you|would you|will you|i want to|i need to|i would like to|i'd like to|let's|lets)\b/g, ' ')
          .replace(/\b(to (my )?(bookmarks|book marks|favorites|favourites|favorite|favourite|faves))\b/g, ' ')
          .replace(/\b(as (a )?(bookmark|favorite|favourite))\b/g, ' ')
          .replace(/\b(a (new )?bookmark for|bookmark for)\b/g, ' ')
          .replace(/\b(the website|website|web ?site|the web ?page|the site|the page)\b/g, ' ')
          .replace(/\b(my|the|a|an)\b/g, ' ')
          .replace(/\s+/g, ' ').trim();
        return q;
      }

      // Turn a spoken "company name or URL" into { url, name }. A phrase that
      // looks like an address keeps its URL and gets a name from the host; a
      // bare company name gets a ".com" guess and a title-cased name.
      function interpretAddTarget(phrase) {
        let t = String(phrase || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!t) return null;
        t = t.replace(/\s*\bdot\b\s*/g, '.');                                  // "sales dot com" -> "sales.com"
        t = t.replace(new RegExp('\\s+(' + SPOKEN_TLDS.join('|') + ')$'), '.$1'); // "sales com" -> "sales.com"
        t = t.replace(/\.+/g, '.').replace(/^[.\s]+|[.\s]+$/g, '').trim();      // tidy stray dots

        if (t.includes('.')) {
          const url = t.replace(/\s+/g, '');           // a dictated address has no spaces
          if (looksLikeUrl(url)) {
            const core = hostCore(url) || url;
            return { url, name: titleCase(core) };
          }
        }
        // Bare company name -> guess a .com and title-case the spoken words.
        // First peel any connector/filler words off the edges so "add in" (or a
        // mis-heard "in") collapses to nothing instead of inventing "in.com".
        let words = t.split(/\s+/).filter(Boolean);
        while (words.length && ADD_STOPWORDS.has(words[0])) words.shift();
        while (words.length && ADD_STOPWORDS.has(words[words.length - 1])) words.pop();
        const cleaned = words.join(' ');
        const slug = cleaned.replace(/[^a-z0-9]+/g, '');
        // Nothing substantive left (pure filler), or the recognizer caught only a
        // lone noise letter — refuse rather than save a junk bookmark.
        if (!slug || slug.length < 2) return null;
        return { url: slug + '.com', name: titleCase(cleaned) };
      }

      // Verbs that mean "attach to something already open" rather than "open
      // fresh" — the signal that a split request targets a tab already on screen.
      const SPLIT_ATTACH_VERBS = /\b(add|put|place|attach|include|throw|stick|drop|append|join|tack)\b/;
      // A reference naming an existing tab: "for the Wikipedia tab", "to that
      // window". The captured group is the tab's name ("" for this/that/current).
      // "tab"/"window" only (not "page") — "go to the X page" means open X.
      const SPLIT_ANCHOR_RE = /\b(?:for|to|onto|into|on|beside|alongside|next to)\s+(?:the\s+|this\s+|that\s+|my\s+|current\s+|currently\s+|currently open\s+|open\s+|already open\s+|existing\s+|its?\s+)*([\w .'-]*?)\s*\b(?:tab|window)\b/;
      // A bare "this/that/current tab" pointer with no name.
      const SPLIT_THIS_TAB_RE = /\b(?:this|that|the current|current|currently open|already open|the open|its?|it)\s+(?:tab|window)\b/;

      // Detect "add <site> to the split view [for the <open tab> tab]" — adding a
      // site BESIDE a tab that's already open. Returns { kind:'addsplit',
      // queries:[..], anchor } or null. Only fires when something is actually
      // open to attach to, so it never steals a plain "split A and B" (which
      // opens both fresh) or an "add <company>" bookmark save.
      function parseAddToSplit(t) {
        pruneWindows();
        if (!VOICE.openWindows.length) return null;     // nothing open to attach to

        const splitIntent = SPLIT_STRONG_RE.test(t);
        const anchorM = t.match(SPLIT_ANCHOR_RE);
        const thisTab = !anchorM && SPLIT_THIS_TAB_RE.test(t);
        const attachVerb = SPLIT_ATTACH_VERBS.test(t);

        // Require a clear attach signal: either an explicit reference to an
        // existing tab paired with a split/attach action ("add YouTube to the
        // Wikipedia tab"), or the "add … split view" shorthand while a tab is
        // open. A plain "split view A and B" (no attach verb, no tab reference)
        // is left for parseSplit, which opens both fresh.
        const tabRef = !!anchorM || thisTab;
        if (!((tabRef && (attachVerb || splitIntent)) || (attachVerb && splitIntent))) return null;

        // Pull the anchor reference out first; whatever it captured names the
        // open tab to attach to ("" → the most recent).
        let anchor = null;
        let q = ' ' + t + ' ';
        if (anchorM) { anchor = (anchorM[1] || '').trim(); q = q.replace(anchorM[0], ' '); }
        else if (thisTab) { anchor = ''; q = q.replace(SPLIT_THIS_TAB_RE, ' '); }

        // Strip split/attach phrasing and filler the same way parseSplit does,
        // keeping the joiners so several added sites stay separable.
        q = q
          .replace(SPLIT_STRONG_RE, ' ')
          .replace(SPLIT_LOOSE_RE, ' ')
          .replace(ACTION_VERBS, ' ')
          .replace(SPLIT_ATTACH_VERBS, ' ')
          .replace(/\b(move|set)\b/g, ' ')
          .replace(/\b(in|on|into|to|as)\s+(a\s+|the\s+)?(new\s+)?(view|screen|window|tab|tabs)\b/g, ' ')
          .replace(/\b(please|for me|right now|now|real quick|hey|ok|okay|bookmarks? buddy|can you|could you|would you|will you|i want to|i need to|i would like to|i'd like to|let's|lets)\b/g, ' ')
          .replace(/\b(website|web site|the site|site|the page|page|the app|dot com|dot org|dot net)\b/g, ' ')
          .replace(/\b(in|on|into|my|the|a|an|to|up|new|tab|tabs|window|view|screen|both|together|side)\b/g, ' ')
          .replace(/\s+/g, ' ').trim();

        const queries = q.split(MULTI_JOIN_RE).map(s => s.trim()).filter(Boolean).slice(0, 5);
        if (!queries.length) return null;
        return { kind: 'addsplit', queries, anchor };
      }

      // Pull the bookmark name(s) out of a split-view request. Returns
      // { kind:'split', queries:[..] } with up to two cleaned names, or null
      // when the phrase isn't a split request at all. A single name means
      // "open one page in a new split view"; two names means "open both side
      // by side".
      function parseSplit(t) {
        const strong = SPLIT_STRONG_RE.test(t);
        const loose = SPLIT_LOOSE_RE.test(t);
        if (!strong && !loose) return null;

        // Strip the split-view phrasing and any open/action verbs, then the
        // usual filler — but keep the joining "and"/"with" so we can still
        // split the two names apart afterwards.
        let q = ' ' + t + ' ';
        q = q
          .replace(SPLIT_STRONG_RE, ' ')
          .replace(SPLIT_LOOSE_RE, ' ')
          .replace(ACTION_VERBS, ' ')
          .replace(/\b(add|put|place|move|throw|stick|drop|set)\b/g, ' ')
          .replace(/\b(in|on|into|to|as)\s+(a\s+|the\s+)?(new\s+)?(view|screen|window|tab|tabs)\b/g, ' ')
          .replace(/\b(please|for me|right now|now|real quick|hey|ok|okay|bookmarks? buddy|can you|could you|would you|will you|i want to|i need to|i would like to|i'd like to|let's|lets)\b/g, ' ')
          .replace(/\b(website|web site|the site|site|the page|page|the app|dot com|dot org|dot net)\b/g, ' ')
          .replace(/\b(in|on|into|my|the|a|an|to|up|new|tab|tabs|window|view|screen|both|together|side)\b/g, ' ')
          .replace(/\s+/g, ' ').trim();

        // Split on any of the multi-target joiners so a split request can name
        // more than two groups ("split games, searches and youtube"); each
        // name may itself be a folder that fans out to several sites.
        const queries = q.split(MULTI_JOIN_RE).map(s => s.trim()).filter(Boolean).slice(0, 6);

        // A bare "split" with no explicit "split view"/"side by side" only
        // counts as a real request when two names were actually joined —
        // keeps casual talk that happens to contain "split" from firing.
        if (!strong && queries.length < 2) return null;
        return { kind: 'split', queries };
      }

      function parseCommand(raw) {
        const t = ' ' + normalize(raw) + ' ';
        if (STOP_RE.test(t)) return { kind: 'stop' };
        if (HELP_RE.test(t)) return { kind: 'help' };

        // "Add to split view" comes first: attaching a site to a tab that's
        // already open ("add split screen with YouTube for the Wikipedia tab")
        // is distinct from opening a fresh split, and would otherwise be read
        // as one. Only fires when a tab is actually open to attach to.
        const addSplit = parseAddToSplit(t);
        if (addSplit) return addSplit;

        // Split view comes before add/open so "open Notion and Gmail in a
        // split view" routes here instead of being read as a single open.
        const split = parseSplit(t);
        if (split) return split;

        // "add <company or url>" — save a new bookmark hands-free. Parsed off a
        // dot-preserving string so a spoken address survives, and checked
        // before the open verbs since "add"/"bookmark" are unambiguous.
        const loose = ' ' + normalizeLoose(raw) + ' ';
        const addM = loose.match(ADD_VERBS);
        if (addM) {
          const rawQuery = cleanAddQuery(loose.slice(addM.index + addM[0].length));
          return { kind: 'add', query: normalize(rawQuery), rawQuery };
        }

        const m = t.match(ACTION_VERBS);
        let query, explicit;
        if (m) { query = t.slice(m.index + m[0].length); explicit = true; }
        else { query = t; explicit = false; }

        // Strip filler around the bookmark name. Order matters: pull off the
        // "in a new tab / window" phrase as a unit FIRST, before article
        // removal can fracture it into a dangling "in".
        query = ' ' + query + ' ';
        query = query
          .replace(/\b(in|on)\s+(a\s+)?(new\s+)?(tab|window|browser)\b/g, ' ')
          .replace(/\b(please|for me|right now|now|real quick|hey|ok|okay|bookmarks? buddy|can you|could you|would you|will you|i want to|i need to|i would like to|i'd like to|let's|lets)\b/g, ' ')
          .replace(/\b(website|web site|the site|site|the page|page|the app|dot com|dot org|dot net)\b/g, ' ')
          .replace(/\b(my|the|a|an|to|up|new|tab|window)\b/g, ' ')
          .replace(/\s+/g, ' ').trim();

        return { kind: explicit ? 'open' : 'maybe', query };
      }

      /* ================================================================
       * Acting on a command
       * ================================================================ */
      // Spoken page navigation — "next page", "go to page 3", "go to Work".
      // Runs before the open/add parser so a page jump never reads as a
      // bookmark open. Kept deliberately narrow (see parsePageNav) so ordinary
      // "open Gmail" still opens the bookmark.
      const PAGE_NUMWORDS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19, twenty:20 };
      function pageNumberFromText(t) {
        const dm = t.match(/\b(\d{1,3})\b/);
        if (dm) return parseInt(dm[1], 10);
        for (const w in PAGE_NUMWORDS) if (new RegExp('\\b' + w + '\\b').test(t)) return PAGE_NUMWORDS[w];
        return null;
      }
      function parsePageNav(raw) {
        const t = normalize(raw);
        if (!t) return null;
        // Relative moves always require the literal "page" word.
        if (/\b(next|forward)\s+page\b/.test(t) || /\bpage\s+(forward|right|over)\b/.test(t)) return { to: STATE.currentPage + 1, rel: true };
        if (/\b(previous|prev|last|back|backward)\s+page\b/.test(t) || /\bgo\s+back\s+(a\s+)?page\b/.test(t) || /\bpage\s+(back|left|before)\b/.test(t)) return { to: STATE.currentPage - 1, rel: true };

        const hasPageWord = /\bpage\b/.test(t);
        // "page 3" / "go to page three" — a number alongside the word "page".
        if (hasPageWord) {
          const num = pageNumberFromText(t);
          if (num != null) return { to: num - 1 };
        }
        // By name. Allowed when the word "page" is present, or with a strong
        // navigation verb ("go to"/"switch to"/…) — but NOT bare "open"/"show",
        // which stay reserved for opening bookmarks.
        const strongVerb = /\b(go to|goto|switch to|switch over to|jump to|take me to|navigate to)\b/.test(t);
        if (hasPageWord || strongVerb) {
          const q = t.replace(/\b(go to|goto|switch to|switch over to|jump to|take me to|navigate to|open|show|the)\b/g, ' ')
                     .replace(/\bpage\b/g, ' ').replace(/\s+/g, ' ').trim();
          if (q) {
            const pages = STATE.layout.pages;
            for (let i = 0; i < pages.length; i++) {
              if (q === normalize(pageDisplayName(i))) return { to: i }; // matches a custom name or "page N"
            }
          }
        }
        return null;
      }
      function applyPageNav(nav) {
        const n = STATE.layout.pages.length;
        const to = nav.to;
        if (to < 0 || to >= n) {
          showToast(nav.rel ? (to < 0 ? 'Already on the first page' : 'Already on the last page') : 'No such page', 'panel-left');
          return;
        }
        if (STATE.view !== 'home') STATE.view = 'home';
        STATE.homeSearch = '';
        STATE.currentPage = to;
        render();
        const label = pageDisplayName(to);
        showToast(label, 'panel-left');
        announce('Showing ' + label);
      }

      function handleCommand(raw) {
        const pageNav = parsePageNav(raw);
        if (pageNav) { applyPageNav(pageNav); return; }

        const cmd = parseCommand(raw);

        if (cmd.kind === 'stop') { stopListening(); return; }
        if (cmd.kind === 'help') {
          recordAction({ type: 'info', text: STATE.bookmarks.length
            ? 'Say “open” and a bookmark or folder, e.g. ' + exampleNames()[0] + '. Name several to open them all (“open games and searches”). Say “split view” and two names — bookmarks or folders — to tile them side by side, or “add split screen with YouTube for this tab” to add a site beside one that’s already open. Or “add” a company to save it.'
            : 'Say “add” and a company name to save your first bookmark, like “add Notion”.' });
          announce('Say open and one or more bookmarks or folders, split view and two names to tile them, add a site to a tab that is already open, or add and a company name.');
          renderSoft(); return;
        }

        if (cmd.kind === 'addsplit') { handleAddToSplit(cmd); return; }

        if (cmd.kind === 'split') { handleSplit(cmd.queries); return; }

        if (!cmd.query) {
          if (cmd.kind === 'open') showToast('Say “open” and a bookmark name', 'mic');
          else if (cmd.kind === 'add') showToast('Say a company to add, e.g. “add Notion”', 'mic');
          return;
        }

        if (cmd.kind === 'add') { addBookmarkByVoice(cmd.rawQuery); return; }

        if (cmd.kind === 'maybe') {
          // No action verb was heard. To keep all-day listening from flinging
          // tabs open on ordinary conversation, only a bare utterance that IS
          // a bookmark name (or its site name) — or exactly a folder name —
          // opens without a verb.
          const exact = STATE.bookmarks.find(b =>
            normalize(b.name) === cmd.query || normalize(hostCore(b.url)) === cmd.query);
          if (exact) { openBookmark(exact, { viaVoice: true, query: cmd.query }); return; }
          const exactFolder = allFolders().find(f => normalize(f.name) === cmd.query);
          if (exactFolder) openFolder(exactFolder, { viaVoice: true, query: cmd.query });
          return;
        }

        // Explicit "open X" is forgiving — fuzzy-match through typos/mishears.
        // X may name a single bookmark, a folder (which opens every site in
        // it), OR several of either joined by "and"/"in"/commas ("open games
        // and searches"), which opens every site across all of them at once.
        const targets = resolveTargets(cmd.query);
        if (!targets.length) {
          recordAction({ type: 'notfound', query: cmd.query });
          showToast(`No bookmark matches “${cmd.query}”`, 'search-x');
          announce('No bookmark found for ' + cmd.query);
          renderSoft();
          return;
        }
        if (targets.length === 1 && targets[0].kind === 'bookmark') {
          openBookmark(targets[0].bm, { viaVoice: true, query: cmd.query });
        } else if (targets.length === 1 && targets[0].kind === 'folder') {
          openFolder(targets[0].folder, { viaVoice: true, query: cmd.query });
        } else {
          openTargets(targets, { viaVoice: true });
        }
      }

      /* ---------------- open-window registry ----------------
       * Every tab Bookmarks Buddy opens is remembered here (with its bookmark
       * identity) so a later "add to split view" can find that tab and tile a
       * new pane beside it. Windows the user closed on their own are pruned
       * lazily before each use.
       *
       * Caveat: a cross-origin page that ships a Cross-Origin-Opener-Policy
       * header — YouTube, Google, GitHub and many others do — is moved into
       * its OWN browsing-context group the moment it loads. That DISOWNS the
       * handle we're holding: win.closed flips to true even though the tab is
       * wide open. A naive prune on win.closed therefore throws away live
       * tabs. We keep such "severed" entries instead so the split-view anchor
       * still resolves (its moveTo/resizeTo is then best-effort). */
      function pruneWindows() {
        const now = Date.now();
        VOICE.openWindows = VOICE.openWindows.filter(w => {
          if (!w.win) return false;
          if (w.severed) return true;            // disowned-but-open (COOP) — keep it
          if (now - w.at < SEVER_PROBE_MS) return true; // too soon to tell — COOP severs only after the load lands
          try { return !w.win.closed; } catch { return true; }
        });
      }
      // A window the user really closed reports closed === true; so does a
      // COOP-severed (but still open) one. We can't read the difference, but we
      // can read the timing: severance happens within a beat of the page
      // loading, while a deliberate close almost never does. So a handle that
      // already reports closed this soon after opening was disowned, not shut.
      const SEVER_PROBE_MS = 2500;
      function registerWindow(bm, win) {
        if (!win) return;
        pruneWindows();
        // Reopening the same bookmark supersedes its previous (now stale) handle.
        VOICE.openWindows = VOICE.openWindows.filter(w => w.id !== bm.id);
        const entry = {
          id: bm.id,
          name: bm.name || hostCore(bm.url),
          host: hostOf(bm.url),
          win,
          severed: false,
          at: Date.now()
        };
        VOICE.openWindows.push(entry);
        setTimeout(() => {
          try { if (win.closed) entry.severed = true; } catch { entry.severed = true; }
        }, SEVER_PROBE_MS);
      }
      // Open a placed window (see openPlaced) AND remember it for closing. Used
      // by every open path so the close command can reach any tab we launched.
      function openAndTrack(bm, feat) {
        const win = openPlaced(ensureScheme(bm.url), feat);
        if (win) registerWindow(bm, win);
        return win;
      }

      // Open a bookmark in a new tab. A voice-triggered window.open() has no
      // fresh user gesture, so the browser may block it; on a block we surface
      // a one-tap banner and, the first time, a hint to allow pop-ups (after
      // which opening is fully hands-free).
      function openBookmark(bm, { viaVoice = false, query = '' } = {}) {
        const url = ensureScheme(bm.url);
        if (!url) { showToast('That bookmark has no address', 'triangle-alert'); return; }

        highlightMatch(bm.id);
        const win = openAndTrack(bm);

        if (win) {
          VOICE.pendingOpen = null;
          recordAction({ type: 'opened', name: bm.name || hostCore(bm.url), url });
          announce('Opening ' + (bm.name || hostCore(bm.url)));
          if (STATE.settings.speak && viaVoice) speak('Opening ' + (bm.name || hostCore(bm.url)));
          if (!viaVoice) { renderSoft(); return; }
          showToast('Opening ' + (bm.name || hostCore(bm.url)), 'external-link');
        } else {
          // Blocked — stage it for a single click.
          VOICE.pendingOpen = bm;
          recordAction({ type: 'blocked', name: bm.name || hostCore(bm.url), url });
          announce(bm.name + ' is ready to open — tap to confirm');
          if (!VOICE.popupHintShown) {
            VOICE.popupHintShown = true;
            showToast('Tap “Open”, or allow pop-ups for this site to open hands-free', 'mouse-pointer-click');
          } else {
            showToast('Tap to open ' + (bm.name || hostCore(bm.url)), 'mouse-pointer-click');
          }
        }
        renderSoft();
      }

      function openPending() {
        const bm = VOICE.pendingOpen;
        if (!bm) return;
        VOICE.pendingOpen = null;
        // This runs inside a real click, so the pop-up is allowed.
        openAndTrack(bm);
        recordAction({ type: 'opened', name: bm.name || hostCore(bm.url), url: ensureScheme(bm.url) });
        render();
      }

      // Open a batch of bookmarks at once — the shared "group" open behind both
      // a single folder and a multi-target ("open games and searches") command.
      // Voice-triggered window.open() has no fresh user gesture, so the browser
      // commonly blocks all but (at most) the first; whatever it blocks is
      // staged behind a one-tap "Open" banner, and the first time we nudge the
      // user to allow pop-ups so future group opens are fully hands-free.
      function openGroup(bms, label, { viaVoice = false } = {}) {
        bms = (bms || []).filter(bm => bm && ensureScheme(bm.url));
        if (!bms.length) {
          showToast('“' + label + '” has no sites yet', 'triangle-alert');
          announce(label + ' is empty.');
          return;
        }

        highlightMatch(bms[0].id);

        let opened = 0;
        const blocked = [];
        for (const bm of bms) {
          const win = openAndTrack(bm);
          if (win) { opened++; recordAction({ type: 'opened', name: bm.name || hostCore(bm.url), url: ensureScheme(bm.url) }); }
          else blocked.push(bm);
        }

        if (opened && !viaVoice) { render(); return; }

        if (blocked.length) {
          VOICE.pendingGroup = { label: label || 'folder', bms: blocked };
          announce(blocked.length + ' sites from ' + label + ' are ready to open — tap to confirm');
          if (!VOICE.popupHintShown) {
            VOICE.popupHintShown = true;
            showToast('Allow pop-ups for this site to open folders hands-free', 'mouse-pointer-click');
          } else {
            showToast('Tap to open ' + blocked.length + ' site' + (blocked.length > 1 ? 's' : '') + ' from “' + label + '”', 'mouse-pointer-click');
          }
        } else {
          showToast('Opening ' + opened + ' site' + (opened > 1 ? 's' : '') + ' in “' + label + '”', 'external-link');
          announce('Opening ' + opened + ' sites in ' + label);
          if (STATE.settings.speak && viaVoice) speak('Opening ' + label);
        }
        renderSoft();
      }

      // Open every site in a single folder at once.
      function openFolder(folder, { viaVoice = false, query = '' } = {}) {
        if (!folder) return;
        openGroup(targetBookmarks({ kind: 'folder', folder }), folder.name || 'folder', { viaVoice });
      }

      // Open every site across several resolved targets (folders and/or
      // bookmarks) as one de-duplicated batch — "open games and searches".
      function openTargets(targets, { viaVoice = false } = {}) {
        const { bms, label } = collectTargets(targets);
        openGroup(bms, label, { viaVoice });
      }

      function openPendingGroup() {
        const g = VOICE.pendingGroup;
        if (!g) return;
        VOICE.pendingGroup = null;
        // Runs inside a real click, so the whole batch of pop-ups is allowed.
        let opened = 0;
        for (const bm of g.bms) {
          if (openAndTrack(bm)) { opened++; recordAction({ type: 'opened', name: bm.name || hostCore(bm.url), url: ensureScheme(bm.url) }); }
        }
        if (opened) showToast('Opening ' + opened + ' site' + (opened > 1 ? 's' : '') + ' from “' + g.label + '”', 'external-link');
        render();
      }

      /* ---------------- split view ---------------- */

      // Resolve the spoken names to bookmarks and open them side by side. Each
      // name is matched like a normal "open", so it may be a single bookmark OR
      // a folder — a folder fans out to every site inside it, so "split games
      // and searches" tiles all four sites across the two folders. Repeats are
      // de-duped so the same page can't open twice.
      function handleSplit(queries) {
        if (!queries || !queries.length) {
          showToast('Say two bookmarks, e.g. “split view Notion and Gmail”', 'mic');
          announce('Tell me which bookmarks to open in a split view.');
          return;
        }

        const found = [];
        const seen = new Set();
        const misses = [];
        for (const q of queries) {
          const t = resolveTarget(q);
          const bms = targetBookmarks(t);
          if (!bms.length) { misses.push(q); continue; }
          for (const bm of bms) if (!seen.has(bm.id)) { seen.add(bm.id); found.push(bm); }
        }

        if (!found.length) {
          const label = queries.join('” or “');
          recordAction({ type: 'notfound', query: queries.join(' and ') });
          showToast('No bookmark matches “' + label + '”', 'search-x');
          announce('No bookmarks found to open in a split view.');
          renderSoft();
          return;
        }

        openSplitView(found, { viaVoice: true });

        // Some names matched, others didn't — open what we have and say so.
        if (misses.length) {
          showToast('Couldn’t find “' + misses[0] + '”', 'search-x');
        }
      }

      // "add split screen with Youtube for the Wikipedia tab" — tile a new site
      // beside a tab that's already open. The anchor names which open tab to
      // attach to (or "this/that tab", or nothing → the most recent); the rest
      // names the site(s) to add. Falls back to a fresh split when no matching
      // open tab is found, so the request never just fizzles.
      function handleAddToSplit(cmd) {
        pruneWindows();
        const live = VOICE.openWindows;

        // Resolve the site(s) to add beside the open tab.
        const found = [];
        const seen = new Set();
        const misses = [];
        for (const q of (cmd.queries || [])) {
          const t = resolveTarget(q);
          const bms = targetBookmarks(t);
          if (!bms.length) { misses.push(q); continue; }
          for (const bm of bms) if (!seen.has(bm.id)) { seen.add(bm.id); found.push(bm); }
        }
        if (!found.length) {
          const label = (cmd.queries || []).join('” or “');
          recordAction({ type: 'notfound', query: (cmd.queries || []).join(' and ') });
          showToast('No bookmark matches “' + label + '”', 'search-x');
          announce('No bookmark found to add to the split view.');
          renderSoft();
          return;
        }

        // Nothing open to attach to — open the new site(s) in a fresh split.
        if (!live.length) {
          openSplitView(found, { viaVoice: true });
          if (misses.length) showToast('Couldn’t find “' + misses[0] + '”', 'search-x');
          return;
        }

        // Pick the anchor tab: a spoken name is fuzzy-matched against the open
        // tabs; "this tab" or no name uses the most recently opened one.
        let anchor = live[live.length - 1];
        const aq = (cmd.anchor || '').trim();
        if (aq) {
          let best = null;
          for (const w of live) {
            const score = scoreBookmark(aq, { name: w.name, url: w.host });
            if (score >= 0.42 && (!best || score > best.score)) best = { w, score };
          }
          if (best) anchor = best.w;
        }

        // Don't re-open the anchor itself if it was also named as a site to add.
        const adds = anchor ? found.filter(bm => bm.id !== anchor.id) : found;
        if (!adds.length) {
          showToast('Name a different site to add beside it', 'mic');
          announce('Tell me which site to add beside that tab.');
          renderSoft();
          return;
        }

        addToSplitView(anchor, adds, { viaVoice: true });
        if (misses.length) showToast('Couldn’t find “' + misses[0] + '”', 'search-x');
      }

      // Window features that tile pop-ups across the screen, simulating the
      // browser's split view from a plain web page. One page takes the left
      // half (leaving room to add a second by hand); two sit side by side; more
      // fan out into the squarest grid that fits them all.
      // NB: 'noopener'/'noreferrer' are deliberately NOT in the feature string
      // — with either set, window.open() returns null even on success, which
      // would defeat the open-vs-blocked detection below. We sever the opener
      // link manually after the window is handed back instead.
      // The tile rectangles, as {left,top,width,height} objects. Used both to
      // build window.open feature strings (new panes) and to moveTo/resizeTo an
      // already-open tab when adding it to a split view.
      function tileRects(count) {
        const scr = window.screen || {};
        const sw = scr.availWidth || scr.width || window.innerWidth || 1280;
        const sh = scr.availHeight || scr.height || window.innerHeight || 800;
        const sx = scr.availLeft || 0;
        const sy = scr.availTop || 0;
        if (count <= 1) {
          const half = Math.floor(sw / 2);
          return [{ left: sx, top: sy, width: half, height: sh }];
        }
        const cols = count <= 2 ? count : Math.ceil(Math.sqrt(count));
        const rows = Math.ceil(count / cols);
        const cw = Math.floor(sw / cols);
        const ch = Math.floor(sh / rows);
        const rects = [];
        for (let i = 0; i < count; i++) {
          const c = i % cols, r = Math.floor(i / cols);
          rects.push({ left: sx + c * cw, top: sy + r * ch, width: cw, height: ch });
        }
        return rects;
      }
      function rectFeature(rc) {
        return 'left=' + rc.left + ',top=' + rc.top + ',width=' + rc.width + ',height=' + rc.height;
      }
      function tileFeatures(count) {
        return tileRects(count).map(rectFeature);
      }

      // Open one positioned window and sever its opener link. Returns the
      // window (truthy) on success, or null when the pop-up was blocked.
      function openPlaced(url, feat) {
        let win = null;
        try { win = window.open(url, '_blank', feat); } catch { win = null; }
        if (win) { try { win.opener = null; } catch {} }
        return win;
      }

      // Open the resolved bookmarks as positioned pop-up windows. As with
      // single and folder opens, a voice-triggered window.open() has no fresh
      // user gesture, so the browser may block it; anything blocked is staged
      // behind a one-tap "Open" banner (with its half-screen placement kept).
      function openSplitView(bms, { viaVoice = false } = {}) {
        const valid = bms.filter(bm => bm && ensureScheme(bm.url)).slice(0, 6);
        if (!valid.length) { showToast('Those bookmarks have no address', 'triangle-alert'); return; }

        highlightMatch(valid[0].id);
        const feats = tileFeatures(valid.length);
        const plan = valid.map((bm, i) => ({ bm, feat: feats[i] }));
        const label = valid.map(b => b.name || hostCore(b.url)).join(' & ');

        let opened = 0;
        const blocked = [];
        for (const p of plan) {
          if (openAndTrack(p.bm, p.feat)) { opened++; recordAction({ type: 'split', name: p.bm.name || hostCore(p.bm.url), url: ensureScheme(p.bm.url) }); }
          else blocked.push(p);
        }

        if (blocked.length) {
          VOICE.pendingSplit = { label, plan: blocked };
          announce('A split view of ' + label + ' is ready — tap to confirm.');
          if (!VOICE.popupHintShown) {
            VOICE.popupHintShown = true;
            showToast('Allow pop-ups for this site to open split views hands-free', 'mouse-pointer-click');
          } else {
            showToast('Tap to open ' + label + ' in a split view', 'mouse-pointer-click');
          }
        } else {
          showToast('Opening ' + label + (valid.length > 1 ? ' in a split view' : ' in a new split view'), 'columns-2');
          announce('Opening ' + label + ' in a split view.');
          if (STATE.settings.speak && viaVoice) speak('Opening ' + label + ' in a split view');
        }
        renderSoft();
      }

      function openPendingSplit() {
        const s = VOICE.pendingSplit;
        if (!s) return;
        VOICE.pendingSplit = null;
        // Runs inside a real click, so the positioned pop-ups are allowed.
        let opened = 0;
        for (const p of s.plan) {
          if (openAndTrack(p.bm, p.feat)) { opened++; recordAction({ type: 'split', name: p.bm.name || hostCore(p.bm.url), url: ensureScheme(p.bm.url) }); }
        }
        if (opened) showToast('Opening ' + s.label + ' in a split view', 'columns-2');
        render();
      }

      // Add one or more sites BESIDE a tab that's already open, mirroring
      // Chrome's "Add tab to new split view". The anchor is an entry from the
      // open-window registry; we re-tile it into the first slot and open the new
      // pane(s) in the remaining slot(s). The anchor handle may be COOP-severed
      // (so moveTo silently fails) — the new panes still tile beside it.
      function addToSplitView(anchor, bms, { viaVoice = false } = {}) {
        const valid = (bms || []).filter(bm => bm && ensureScheme(bm.url));
        if (!valid.length) { showToast('Those bookmarks have no address', 'triangle-alert'); return; }

        const total = Math.min(1 + valid.length, 6);
        const adds = valid.slice(0, total - 1);
        const rects = tileRects(total);

        // Re-tile the existing tab into the first slot (best effort).
        if (anchor && anchor.win) {
          const rc = rects[0];
          try { anchor.win.moveTo(rc.left, rc.top); anchor.win.resizeTo(rc.width, rc.height); anchor.win.focus(); } catch {}
          anchor.at = Date.now();
        }

        const anchorLabel = anchor ? anchor.name : '';
        const addLabel = adds.map(b => b.name || hostCore(b.url)).join(' & ');
        const label = anchorLabel ? anchorLabel + ' & ' + addLabel : addLabel;

        let opened = 0;
        const blocked = [];
        adds.forEach((bm, i) => {
          const feat = rectFeature(rects[i + 1]);
          if (openAndTrack(bm, feat)) { opened++; recordAction({ type: 'split', name: bm.name || hostCore(bm.url), url: ensureScheme(bm.url) }); }
          else blocked.push({ bm, feat });
        });

        if (blocked.length) {
          // Reuse the pending-split banner so a blocked pop-up opens on one tap.
          VOICE.pendingSplit = { label, plan: blocked };
          announce('Adding ' + addLabel + ' beside ' + (anchorLabel || 'your tab') + ' — tap to confirm.');
          if (!VOICE.popupHintShown) {
            VOICE.popupHintShown = true;
            showToast('Allow pop-ups for this site to add split views hands-free', 'mouse-pointer-click');
          } else {
            showToast('Tap to add ' + addLabel + ' to the split view', 'mouse-pointer-click');
          }
        } else {
          showToast('Adding ' + addLabel + ' beside ' + (anchorLabel || 'your tab'), 'columns-2');
          announce('Adding ' + addLabel + ' to a split view with ' + (anchorLabel || 'your tab') + '.');
          if (STATE.settings.speak && viaVoice) speak('Adding ' + addLabel + ' to the split view');
        }
        renderSoft();
      }

      // Add a bookmark from a spoken company name or URL. The user supplies
      // just one half — we infer the other: a bare name gets a ".com" guess,
      // a dictated address gets a friendly name from its host. Re-saying a
      // site already on the list is a no-op (with a gentle nudge).
      function addBookmarkByVoice(rawQuery) {
        const target = interpretAddTarget(rawQuery);
        if (!target || !target.url || !looksLikeUrl(target.url)) {
          showToast('Say a company name to add, e.g. “add Notion”', 'mic');
          announce('Tell me a company name or web address to add.');
          return;
        }

        const host = hostOf(target.url);
        const existing = host && STATE.bookmarks.find(b => hostOf(b.url) === host);
        if (existing) {
          highlightMatch(existing.id);
          const label = existing.name || hostCore(existing.url);
          recordAction({ type: 'info', text: '“' + label + '” is already saved' });
          showToast('“' + label + '” is already in your bookmarks', 'info');
          announce(label + ' is already saved.');
          renderSoft();
          return;
        }

        const bm = { id: uid(), name: target.name, url: target.url };
        STATE.bookmarks.push(bm);
        persistBookmarks();
        highlightMatch(bm.id);
        recordAction({ type: 'added', name: bm.name, url: ensureScheme(bm.url) });
        showToast('Added “' + bm.name + '” to your bookmarks', 'bookmark-plus');
        announce('Added ' + bm.name + ' to your bookmarks.');
        if (STATE.settings.speak) speak('Added ' + bm.name);
        renderSoft();
      }

      function highlightMatch(id) {
        VOICE.lastMatchedId = id;
        if (VOICE.matchClearId) clearTimeout(VOICE.matchClearId);
        VOICE.matchClearId = setTimeout(() => { VOICE.lastMatchedId = null; renderSoft(); }, 2600);
      }

      function recordAction(a) {
        VOICE.recentActions.unshift(Object.assign({ at: Date.now() }, a));
        if (VOICE.recentActions.length > 14) VOICE.recentActions.length = 14;
        // Mirror the action to the sheet's activity feed (no-op without a token).
        try { queueActivity(a); } catch {}
      }

      function announce(msg) {
        const el = document.getElementById('a11y-live');
        if (el) el.textContent = msg;
      }

      // Optional, opt-in spoken confirmation. Default off — "only the
      // microphone is leveraged" unless the user turns this on.
      function speak(text) {
        if (!VOICE.ttsSupported || !STATE.settings.speak) return;
        try {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(text);
          u.rate = 1.05; u.pitch = 1.0;
          window.speechSynthesis.speak(u);
        } catch {}
      }

      /* ================================================================
       * SPEECH RECOGNITION — continuous, microphone only
       * (patterns carried over from the original assistant: auto-restart on
       *  end, a stall watchdog, and revival when the tab returns to front)
       * ================================================================ */

      function recognitionWanted() { return VOICE.listenOn; }

      function ensureRecognition() {
        if (!VOICE.srSupported) return null;
        if (VOICE.recognition) return VOICE.recognition;
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        const r = new SR();
        r.continuous = true;
        r.interimResults = true;
        r.lang = 'en-US';
        r.onresult = (e) => {
          VOICE.lastSrEventAt = Date.now();
          let interim = '', finalChunk = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            const t = res[0] && res[0].transcript ? res[0].transcript : '';
            if (res.isFinal) finalChunk += t + ' '; else interim += t;
          }
          if (finalChunk) { clearInterim(); handleVoiceTranscript(finalChunk); }
          else if (interim) updateInterim(interim);
        };
        r.onerror = (e) => {
          VOICE.lastSrEventAt = Date.now();
          if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
            VOICE.permissionDenied = true;
            stopListening({ silent: true });
            showToast('Bookmarks Buddy needs microphone access — allow it and try again', 'mic-off');
            return;
          }
          if (e.error === 'audio-capture') {
            stopListening({ silent: true });
            showToast("No microphone found — check that one is connected", 'mic-off');
            return;
          }
          // no-speech / aborted / network fall through to onend, which restarts
        };
        r.onstart = () => { VOICE.srRunning = true; VOICE.lastSrEventAt = Date.now(); };
        r.onend = () => {
          VOICE.srRunning = false;
          VOICE.lastSrEventAt = Date.now();
          if (!VOICE.wantRunning || !recognitionWanted()) return;
          kickRecognition(); // restart so listening keeps going for the whole session
        };
        VOICE.recognition = r;
        return r;
      }

      // Single resilient entry point for (re)starting the recognizer. Chrome
      // throws a synchronous InvalidStateError in two cases that used to leave
      // listening silently dead until the 5s watchdog noticed:
      //   • "already started" — a session is (or is about to be) running, so
      //     this is success: leave it be.
      //   • the previous session is still tearing down — retry on a short
      //     backoff instead of swallowing the error and waiting for the watchdog.
      // This is what makes clicking the button / pressing the shortcut start
      // listening promptly and reliably, even right after stopping.
      function kickRecognition(attempt = 0) {
        if (!VOICE.wantRunning || !recognitionWanted()) return;
        if (VOICE.srRunning) return;
        const r = ensureRecognition();
        if (!r) return;
        try {
          r.start();
        } catch (err) {
          if (err && /already started/i.test(err.message || '')) return;
          if (attempt < 8) setTimeout(() => kickRecognition(attempt + 1), 200 * (attempt + 1));
        }
      }

      function startRecognition() {
        const r = ensureRecognition();
        if (!r) return;
        VOICE.wantRunning = true;
        kickRecognition();
        startWatchdog();
      }

      // Chrome's cloud recognizer can silently stop delivering results during
      // long sessions; an abort()+restart (under a second) un-sticks it. The
      // held mic stream keeps this watchdog interval reliable so listening stays
      // healthy for as long as you're using the app.
      const SR_STALL_MS = 15000;
      function startWatchdog() {
        if (VOICE.watchdogId) return;
        VOICE.watchdogId = setInterval(() => {
          if (!VOICE.wantRunning || !recognitionWanted()) return;
          if (!VOICE.srRunning) { kickRecognition(); return; }
          if (Date.now() - VOICE.lastSrEventAt > SR_STALL_MS) { try { VOICE.recognition.abort(); } catch {} }
        }, 5000);
      }
      function stopWatchdog() { if (VOICE.watchdogId) { clearInterval(VOICE.watchdogId); VOICE.watchdogId = null; } }

      // Leaving the tab (a bookmark we opened taking over, or the user switching
      // away) stops listening; returning to the foreground is a free chance to
      // revive a recognizer that died while the tab was briefly throttled.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { stopListeningOnLeave(); return; }
        if (VOICE.wantRunning && recognitionWanted() && !VOICE.srRunning) {
          kickRecognition();
        }
      });

      function stopRecognition() {
        VOICE.wantRunning = false;
        stopWatchdog();
        if (VOICE.recognition) { try { VOICE.recognition.stop(); } catch {} }
        VOICE.interimText = '';
      }

      /* ---------------- listening lifecycle ---------------- */
      async function toggleListening() {
        if (VOICE.listenOn) { stopListening(); return; }
        startListening();
      }

      async function startListening({ forDictation = false } = {}) {
        if (VOICE.listenOn) return;
        const r = ensureRecognition();
        if (!r) { showToast('Voice needs Chrome or Edge', 'mic-off'); return; }

        // Ask for the mic up front so a denial fails loudly here. The stream is
        // HELD for the whole session (not stopped): an active capture exempts
        // the tab from Chrome's intensive timer throttling, which keeps the
        // restart watchdog alive while the user works in other tabs. Standard
        // processing is ON — we only want the user's own voice.
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          try {
            VOICE.micStream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            VOICE.micStream.getTracks().forEach(t => { t.onended = () => { VOICE.micStream = null; }; });
          } catch {
            showToast('Microphone blocked — click Allow and try again', 'mic-off');
            render();
            return;
          }
        }

        VOICE.listenOn = true;
        VOICE.permissionDenied = false;
        startRecognition();
        if (forDictation) {
          showToast('Dictation on — speak to fill the form', 'mic');
          announce('Dictation on. Speak to fill the form, and click a field to switch.');
        } else {
          showToast('Listening — say “open” or “add” and a name', 'mic');
          announce('Listening for commands.');
        }
        render();
      }

      function stopListening({ silent = false, leftApp = false } = {}) {
        const wasOn = VOICE.listenOn;
        VOICE.listenOn = false;
        if (VOICE.micStream) { try { VOICE.micStream.getTracks().forEach(t => t.stop()); } catch {} VOICE.micStream = null; }
        stopRecognition();
        VOICE.interimText = '';
        if (!silent && wasOn) {
          if (leftApp) {
            showToast('Listening stopped — you left Bookmarks Buddy', 'mic-off');
            announce('Listening stopped because you left Bookmarks Buddy.');
          } else {
            showToast('Stopped listening', 'mic-off');
            announce('Stopped listening.');
          }
        }
        render();
      }

      // When you leave Bookmarks Buddy — clicking into a bookmark we just
      // opened, switching to another tab, or moving to another app — listening
      // stops on its own. Opening a site hands you off to it, so the mic
      // shouldn't keep running while your attention is elsewhere. Come back and
      // tap the mic (or press the shortcut) to start listening again.
      function stopListeningOnLeave() {
        // Mid-dictation the Add/Edit form has focus inside the app, so a stray
        // blur there shouldn't cut the user off — leave that flow alone.
        if (!VOICE.listenOn || VOICE.dictating) return;
        stopListening({ leftApp: true });
      }
      window.addEventListener('blur', stopListeningOnLeave);

      /* ---------------- hands-free dictation (Add modal) ----------------
       * While the "Add a website" modal is open the recognizer flips from
       * command mode into dictation: whatever the user says is typed into the
       * field they last focused, and clicking another field moves dictation
       * there — so a bookmark can be added with the mouse and voice alone, no
       * keyboard needed. */
      // Dictation works in both the Add and Edit modals; only one is open at a
      // time, so this is the union of their field IDs (used to bind focus).
      const DICTATE_FIELDS = ['bm-name', 'bm-url', 'bm-notes', 'bm-icon', 'edit-name', 'edit-url', 'edit-notes', 'edit-icon'];
      function dictationActive() { return STATE.adding || !!STATE.editingId; }
      function dictationFirstField() { return STATE.adding ? 'bm-name' : (STATE.editingId ? 'edit-name' : null); }

      async function startDictation() {
        if (!dictationActive()) return;
        VOICE.dictateField = dictationFirstField();
        VOICE.dictateFresh = true;
        if (!VOICE.srSupported) { focusDictationField(); return; } // no engine — keyboard still works
        VOICE.dictating = true;
        if (!VOICE.listenOn) {
          VOICE.dictatePrevListenOn = false;
          await startListening({ forDictation: true });
          if (!VOICE.listenOn) { VOICE.dictating = false; render(); return; } // mic denied/unavailable
        } else {
          VOICE.dictatePrevListenOn = true;
          showToast('Dictation on — speak to fill the form', 'mic');
        }
        render();
        focusDictationField();
      }

      function stopDictation() {
        if (!VOICE.dictating) { VOICE.dictateField = null; return; }
        const resumeCommands = VOICE.dictatePrevListenOn;
        VOICE.dictating = false;
        VOICE.dictateField = null;
        VOICE.dictateFresh = false;
        VOICE.dictatePrevListenOn = false;
        // Listening was off before dictation -> turn the mic back off. The user
        // was already listening for commands -> leave it running.
        if (!resumeCommands && VOICE.listenOn) stopListening({ silent: true });
      }

      function setDictationField(id) {
        // A fresh focus -> the next spoken chunk replaces the field (handy when
        // editing a pre-filled bookmark); keep talking to append after that.
        if (DICTATE_FIELDS.includes(id)) { VOICE.dictateField = id; VOICE.dictateFresh = true; }
      }

      function focusDictationField() {
        const id = VOICE.dictateField || dictationFirstField();
        const el = id && document.getElementById(id);
        if (el) { try { el.focus(); const n = (el.value || '').length; el.selectionStart = el.selectionEnd = n; } catch {} }
      }

      // Turn a spoken web address into something usable: "github dot com slash
      // x" -> "github.com/x". Used only for the URL + thumbnail fields.
      function normalizeSpokenUrl(text) {
        let t = ' ' + String(text).toLowerCase().trim() + ' ';
        t = t.replace(/\s+/g, ' ')
             .replace(/ (dot|point) /g, '.')
             .replace(/ (slash|forward slash) /g, '/')
             .replace(/ (dash|hyphen) /g, '-')
             .replace(/ underscore /g, '_')
             .replace(/ colon /g, ':');
        return t.replace(/\s+/g, '');
      }

      // Append a finalized spoken chunk to the active modal field (Add or Edit),
      // reusing the field's own input handler so STATE and the live preview stay
      // in sync.
      function dictateIntoField(text) {
        const id = VOICE.dictateField || dictationFirstField();
        const el = id && document.getElementById(id);
        if (!el) return;
        const isUrl = id.endsWith('-url') || id.endsWith('-icon');
        const chunk = isUrl ? normalizeSpokenUrl(text) : String(text).trim();
        if (!chunk) return;
        if (VOICE.dictateFresh) {
          el.value = chunk;                 // first words after focusing replace the field
          VOICE.dictateFresh = false;
        } else {
          const cur = el.value || '';
          const joiner = (!cur || isUrl || /\s$/.test(cur)) ? '' : ' ';
          el.value = cur + joiner + chunk;  // keep talking to append
        }
        try { const n = el.value.length; el.selectionStart = el.selectionEnd = n; } catch {}
        el.dispatchEvent(new Event('input', { bubbles: true }));
        flashDictation(el);
      }

      function flashDictation(el) {
        el.classList.add('dictating-flash');
        clearTimeout(el._dictTimer);
        el._dictTimer = setTimeout(() => el.classList.remove('dictating-flash'), 400);
      }

      /* ---------------- transcript plumbing ---------------- */
      const RECENT_FINALS = [];
      function isDuplicateUtterance(text) {
        const norm = normalize(text);
        if (!norm) return false;
        const now = Date.now();
        while (RECENT_FINALS.length && now - RECENT_FINALS[0].at > 6000) RECENT_FINALS.shift();
        for (const e of RECENT_FINALS) { if (e.norm === norm) { e.at = now; return true; } }
        RECENT_FINALS.push({ norm, at: now });
        return false;
      }

      function handleVoiceTranscript(raw) {
        const text = String(raw).trim();
        if (!text || !VOICE.listenOn) return;
        // Add or Edit modal open -> dictate into the focused field instead of running a command.
        if (VOICE.dictating && dictationActive()) { dictateIntoField(text); return; }
        if (isDuplicateUtterance(text)) return;
        handleCommand(text);
      }

      function updateInterim(text) {
        const trimmed = String(text || '').trim();
        if (trimmed.length < 2) { clearInterim(); return; }
        VOICE.interimText = trimmed;
        if (!patchTranscript(trimmed)) renderSoft();
      }
      function clearInterim() {
        if (!VOICE.interimText) return;
        VOICE.interimText = '';
        if (!patchTranscript('')) renderSoft();
      }
      // Patch the live transcript node directly so streaming words don't force
      // a full re-render (which would steal focus from the add-bookmark form).
      function patchTranscript(text) {
        const nodes = [
          document.getElementById('live-transcript'),
          document.getElementById('focus-transcript'),
          document.getElementById('home-transcript')
        ].filter(Boolean);
        // No transcript on screen — treat as handled so live interim words
        // don't force a full re-render.
        if (!nodes.length) return true;
        nodes.forEach(n => {
          if (text) n.innerHTML = escHtml(text) + '<span class="caret"></span>';
          else n.innerHTML = transcriptResting(n.id);
          n.classList.toggle('muted', !text);
        });
        return true;
      }
      function transcriptResting(id) {
        if (id === 'home-transcript') {
          const fn = escHtml(firstSpokenName());
          if (!VOICE.listenOn) return 'Tap to talk, then say “open ' + fn + '”';
          return 'Listening… say “open ' + fn + '” or “add” a site';
        }
        const isFocus = id === 'focus-transcript';
        if (VOICE.listenOn) return 'Listening… say “open” or “add” and a name';
        return isFocus ? 'Tap the circle to start listening' : 'Press the mic to start';
      }

      /* ================================================================
       * Bookmark CRUD
       * ================================================================ */
      function addBookmark() {
        let name = STATE.draftName.trim();
        let url = STATE.draftUrl.trim();
        if (!url && !name) { showToast('Enter a name and a web address', 'triangle-alert'); return; }
        if (!url) { showToast('Enter a web address for “' + name + '”', 'triangle-alert'); return; }
        if (!looksLikeUrl(url)) { showToast('That doesn’t look like a web address', 'triangle-alert'); return; }
        if (!name) name = hostCore(url).replace(/^\w/, c => c.toUpperCase());
        const id = uid();
        STATE.bookmarks.push({ id, name, url, notes: STATE.draftNotes.trim(), icon: STATE.draftIcon.trim() });
        placeNewAppOnCurrentPage(id); // drop it on the page being viewed, not an earlier one
        persistBookmarks();
        STATE.draftName = ''; STATE.draftUrl = ''; STATE.draftNotes = ''; STATE.draftIcon = '';
        stopDictation();
        STATE.adding = false;
        STATE.currentPage = pageIndexOfApp(id); // show where it landed (the current page)
        showToast('Added “' + name + '”', 'check');
        render();
      }

      // One-tap add from the starter suggestions (onboarding + Add modal).
      function addStarter(i) {
        const s = STARTER_SITES[i];
        if (!s) return;
        const host = hostOf(s.url);
        if (host && STATE.bookmarks.some(b => hostOf(b.url) === host)) {
          showToast('“' + s.name + '” is already saved', 'info');
          return;
        }
        const id = uid();
        STATE.bookmarks.push({ id, name: s.name, url: s.url });
        placeNewAppOnCurrentPage(id); // drop it on the page being viewed, not an earlier one
        persistBookmarks();
        STATE.currentPage = pageIndexOfApp(id);
        showToast('Added “' + s.name + '”', 'check');
        render();
      }

      // Starter sites the user hasn't already saved (matched by host).
      function starterSuggestions(n) {
        const have = new Set(STATE.bookmarks.map(b => hostOf(b.url)));
        return STARTER_SITES.filter(s => !have.has(hostOf(s.url))).slice(0, n);
      }

      function saveBookmarks() {
        // Fold in anything typed but not yet added, then persist.
        if (STATE.draftUrl.trim()) addBookmark();
        const ok = persistBookmarks();
        showToast(ok ? 'Saved to this computer' : 'Could not save — storage unavailable', ok ? 'hard-drive-download' : 'triangle-alert');
      }

      function startEdit(id) {
        const bm = STATE.bookmarks.find(b => b.id === id);
        if (!bm) return;
        STATE.editingId = id;
        STATE.confirmDeleteId = null;
        STATE.editDraftName = bm.name;
        STATE.editDraftUrl = bm.url;
        STATE.editDraftNotes = bm.notes || '';
        STATE.editDraftIcon = bm.icon || '';
        render();
      }
      function saveEdit(id) {
        const bm = STATE.bookmarks.find(b => b.id === id);
        if (!bm) return;
        const url = STATE.editDraftUrl.trim();
        if (!looksLikeUrl(url)) { showToast('That doesn’t look like a web address', 'triangle-alert'); return; }
        bm.name = STATE.editDraftName.trim() || hostCore(url).replace(/^\w/, c => c.toUpperCase());
        bm.url = url;
        bm.notes = STATE.editDraftNotes.trim();
        bm.icon = STATE.editDraftIcon.trim();
        stopDictation();
        STATE.editingId = null;
        persistBookmarks();
        showToast('Updated', 'check');
        render();
      }
      function cancelEdit() { stopDictation(); STATE.editingId = null; render(); }

      function deleteBookmark(id) {
        STATE.bookmarks = STATE.bookmarks.filter(b => b.id !== id);
        STATE.confirmDeleteId = null;
        persistBookmarks();
        render();
      }

      /* ================================================================
       * Toast
       * ================================================================ */
      function showToast(msg, icon) {
        VOICE.toastMessage = msg;
        VOICE.toastIcon = icon || '';
        renderToastOnly();
        if (VOICE.toastTimeoutId) clearTimeout(VOICE.toastTimeoutId);
        VOICE.toastTimeoutId = setTimeout(() => { VOICE.toastMessage = ''; renderToastOnly(); }, 3600);
      }

      /* ================================================================
       * Rendering
       * ================================================================ */
      function exampleNames() {
        const names = STATE.bookmarks.slice(0, 3).map(b => '“Open ' + (b.name || hostCore(b.url)) + '”');
        return names.length ? names : ['“Open Salesforce”', '“Open Outreach”', '“Open Gmail”'];
      }

      // A "split view A and B" example chip, built from the user's first two
      // bookmarks (or sensible defaults) so it always reflects real names.
      function splitExampleChip() {
        const two = STATE.bookmarks.slice(0, 2).map(b => b.name || hostCore(b.url));
        if (two.length < 2) two.splice(0, two.length, 'Salesforce', 'Gmail');
        return `<span class="vp-chip">${escHtml('“Split view ' + two[0] + ' and ' + two[1] + '”')}</span>`;
      }

      // The launch shortcut is user-configurable (Settings) and stored as
      // { ctrl, alt, shift, meta, code, key }. These helpers keep its display
      // and matching in one place so every screen shows the same combo.
      function defaultShortcut() {
        return { ctrl: true, alt: false, shift: false, meta: false, code: 'KeyR', key: 'r' };
      }
      function isDefaultShortcut() {
        const sc = (STATE.settings && STATE.settings.shortcut) || {}, d = defaultShortcut();
        return (!!sc.ctrl === d.ctrl) && (!!sc.alt === d.alt) && (!!sc.shift === d.shift) &&
               (!!sc.meta === d.meta) && ((sc.code || '') === d.code || (sc.key || '').toLowerCase() === d.key);
      }
      // A readable name for the shortcut's main (non-modifier) key.
      function shortcutKeyName(sc) {
        sc = sc || {};
        const code = sc.code || '';
        let m;
        if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
        if ((m = /^Digit(\d)$/.exec(code))) return m[1];
        if (/^F\d{1,2}$/.test(code)) return code;
        const named = {
          Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Tab: 'Tab', Delete: 'Del',
          ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
          Minus: '-', Equal: '=', Slash: '/', Backslash: '\\', Period: '.', Comma: ',',
          Semicolon: ';', Quote: '\'', BracketLeft: '[', BracketRight: ']', Backquote: '`'
        };
        if (named[code]) return named[code];
        const k = sc.key || '';
        if (k === ' ') return 'Space';
        if (k.length === 1) return k.toUpperCase();
        return k || '?';
      }
      // The shortcut as ordered parts, e.g. ['Ctrl','R'] or ['Ctrl','Shift','/'].
      function shortcutParts() {
        const sc = (STATE.settings && STATE.settings.shortcut) || {};
        const parts = [];
        if (sc.ctrl) parts.push('Ctrl');
        if (sc.alt) parts.push('Alt');
        if (sc.shift) parts.push('Shift');
        if (sc.meta) parts.push('Cmd');
        parts.push(shortcutKeyName(sc));
        return parts;
      }
      // Plain text ("Ctrl+R") for titles/aria; keycap HTML for on-screen hints.
      function shortcutLabel() { return shortcutParts().join('+'); }
      function shortcutKbdHtml() { return shortcutParts().map(p => '<kbd>' + escHtml(p) + '</kbd>').join(' + '); }
      function shortcutHint() {
        return 'Press ' + shortcutKbdHtml() + ' to start or stop listening';
      }

      function captureFocus() {
        const el = document.activeElement;
        if (el && el.id && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'))
          return { id: el.id, s: el.selectionStart, e: el.selectionEnd };
        return null;
      }
      function restoreFocus(f) {
        if (!f) return;
        const el = document.getElementById(f.id);
        if (el) { try { el.focus(); if (f.s != null) { el.selectionStart = f.s; el.selectionEnd = f.e; } } catch {} }
      }

      function render() {
        const f = captureFocus();
        const scroll = document.querySelector('.page')?.scrollTop || 0;
        document.getElementById('app').innerHTML = `
          <div class="shell">
            ${renderTopbar()}
            <div class="page">
              ${STATE.view === 'focus' ? renderFocus() : renderHome()}
            </div>
          </div>
          ${renderOverlays()}
          ${renderToast()}
        `;
        const page = document.querySelector('.page'); if (page) page.scrollTop = scroll;
        if (window.lucide?.createIcons) try { window.lucide.createIcons(); } catch {}
        bindEvents();
        restoreFocus(f);
      }

      // Full render, but skip it while an add/edit input is focused so voice
      // updates can't yank the cursor away mid-type.
      function renderSoft() {
        const el = document.activeElement;
        if (el && el.id && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          patchTranscript(VOICE.interimText);
          return;
        }
        render();
      }

      function renderToastOnly() {
        const existing = document.getElementById('toast-mount');
        if (existing) existing.outerHTML = renderToast();
        else document.getElementById('app').insertAdjacentHTML('beforeend', renderToast());
        if (window.lucide?.createIcons) try { window.lucide.createIcons(); } catch {}
      }

      function renderTopbar() {
        return `
          <header class="topbar">
            <div class="brand">
              <div class="brand-mark"><i data-lucide="bookmark"></i></div>
              <div class="brand-text">
                <div class="brand-name">Bookmarks <span class="accent">Buddy</span></div>
                <div class="brand-tag">Open by voice</div>
              </div>
            </div>
            <nav class="nav-tabs">
              <button class="nav-tab ${STATE.view === 'home' ? 'active' : ''}" data-action="go-home">
                <i data-lucide="layout-grid"></i> Bookmarks
              </button>
              <button class="nav-tab ${STATE.view === 'focus' ? 'active' : ''}" data-action="go-focus">
                <i data-lucide="radio"></i> Settings${hasUnseenChangelog() ? '<span class="nav-dot" aria-label="New updates"></span>' : ''}
              </button>
            </nav>
          </header>`;
      }

      /* ---------------- home: iPhone-style springboard ---------------- */
      function firstSpokenName() {
        const b = STATE.bookmarks[0];
        return b ? (b.name || hostCore(b.url) || 'Gmail') : 'Gmail';
      }

      function renderHome() {
        // Brand-new user → a welcoming hero instead of an empty grid.
        if (!STATE.bookmarks.length) return `<div class="home">${renderOnboard()}</div>`;

        const q = STATE.homeSearch.trim();
        // Searching shows a flat result list; otherwise the springboard sits
        // beside the "Pages" rail in a two-column layout (a drawer on mobile).
        const body = q
          ? renderSearchResults(q)
          : `<div class="sb-layout ${STATE.pageNavOpen ? 'nav-open' : ''}">
               <div class="page-nav-backdrop" data-action="toggle-page-nav" aria-hidden="true"></div>
               ${renderPageNav()}
               ${renderSpringboard()}
             </div>`;
        return `
          <div class="home home-springboard">
            ${VOICE.pendingOpen ? renderPending() : ''}
            ${VOICE.pendingGroup ? renderPendingGroup() : ''}
            ${VOICE.pendingSplit ? renderPendingSplit() : ''}
            ${renderHomeTools()}
            ${body}
          </div>`;
      }

      // The "Pages" rail down the left of the Bookmarks screen. Each page shows
      // its name (or "Page N") and item count; tapping one jumps there. While
      // arranging (the pencil/jiggle mode) every row turns into a rename field
      // with ↑/↓ nudgers to move the page earlier (toward the first/default
      // page) or later — that's how the order is changed.
      function renderPageNav() {
        const pages = STATE.layout.pages.length ? STATE.layout.pages : [newPage()];
        const edit = STATE.editMode;
        const rows = pages.map((page, i) => {
          const name = pageDisplayName(i);
          const count = page.filter(Boolean).length;
          const active = i === STATE.currentPage;
          if (edit) {
            return `
              <li class="page-nav-item ${active ? 'active' : ''}" data-pagenav="${i}">
                <input type="text" id="page-name-${i}" data-page-name data-page="${i}" value="${escAttr(pageNameRaw(i))}" placeholder="Page ${i + 1}" autocomplete="off" spellcheck="false" aria-label="Name for page ${i + 1}">
                <div class="page-nav-reorder">
                  <button class="page-nav-move" data-action="move-page-up" data-page="${i}" ${i === 0 ? 'disabled' : ''} title="Move earlier (toward the first page)" aria-label="Move page ${i + 1} earlier"><i data-lucide="chevron-up"></i></button>
                  <button class="page-nav-move" data-action="move-page-down" data-page="${i}" ${i >= pages.length - 1 ? 'disabled' : ''} title="Move later" aria-label="Move page ${i + 1} later"><i data-lucide="chevron-down"></i></button>
                </div>
              </li>`;
          }
          return `
            <li data-pagenav="${i}">
              <button class="page-nav-link ${active ? 'active' : ''}" data-action="goto-page" data-page="${i}" title="Go to ${escAttr(name)}">
                <span class="page-nav-name">${escHtml(name)}</span>
                <span class="page-nav-count">${count}</span>
              </button>
            </li>`;
        }).join('');
        return `
          <aside class="page-nav" id="page-nav" aria-label="Pages">
            <div class="page-nav-head">
              <span class="page-nav-title">Pages</span>
              <button class="page-nav-addbtn" data-action="add-page" title="Add a page" aria-label="Add a page"><i data-lucide="plus"></i></button>
            </div>
            <ul class="page-nav-list">${rows}</ul>
          </aside>`;
      }

      // First-run welcome: explains the product in a line, gives a clear primary
      // action, and lets the user seed their home screen one tap at a time.
      function renderOnboard() {
        const sr = VOICE.srSupported;
        const sugg = starterSuggestions(8);
        return `
          <div class="onboard">
            <div class="onboard-hero">
              <div class="onboard-mark"><i data-lucide="bookmark"></i></div>
              <div class="onboard-title">Open your sites by voice</div>
              <div class="onboard-sub">Save the websites you visit most, then open them hands-free — just say <b>“open Gmail.”</b> Everything stays on this computer.</div>
              <div class="onboard-cta">
                <button class="btn-primary" data-action="add-app"><i data-lucide="plus"></i> Add a website</button>
                ${sr ? `<button class="btn-outline" data-action="toggle-listen"><i data-lucide="mic"></i> Turn on voice</button>` : ''}
              </div>
              ${sugg.length ? `
                <div class="onboard-divider">Or start with a favorite</div>
                <div class="starter-grid">${sugg.map(renderStarterChip).join('')}</div>` : ''}
            </div>
          </div>`;
      }

      function renderStarterChip(s) {
        const i = STARTER_SITES.indexOf(s);
        const fav = faviconFor(s.url);
        const letter = (s.name.replace(/[^a-z0-9]/ig, '').charAt(0) || '?').toUpperCase();
        return `
          <button class="starter-chip" data-action="add-starter" data-starter="${i}" title="Add ${escAttr(s.name)}">
            <img src="${escAttr(fav)}" alt="" onerror="var p=this.parentNode;this.remove();if(p){p.classList.add('sc-noimg');p.setAttribute('data-letter','${escAttr(letter)}');}">
            <span class="sc-name">${escHtml(s.name)}</span>
            <span class="sc-add"><i data-lucide="plus"></i></span>
          </button>`;
      }

      // The voice bar keeps the product's core gesture present on the Bookmarks
      // screen: a tap-to-talk orb, the live transcript, and a couple of example
      // commands so the feature is never hidden behind the Listen tab.
      function renderVoiceBar() {
        const sr = VOICE.srSupported;
        const on = VOICE.listenOn;
        const interim = VOICE.interimText;
        const line = interim ? (escHtml(interim) + '<span class="caret"></span>') : transcriptResting('home-transcript');
        const hints = voiceBarHints();
        return `
          <div class="voicebar">
            <button class="vb-orb ${on ? 'on' : ''}" data-action="${sr ? 'toggle-listen' : 'noop'}" ${sr ? '' : 'disabled'} aria-label="${on ? 'Stop listening' : 'Start listening'}" title="${on ? 'Listening — tap to stop (' + shortcutLabel() + ')' : 'Tap to talk (' + shortcutLabel() + ')'}">
              <i data-lucide="mic"></i>
            </button>
            <div class="vb-body">
              <div class="vb-status ${on ? 'on' : ''}"><span class="st-dot"></span>${on ? 'Listening' : (sr ? 'Voice ready' : 'Voice')}</div>
              <div class="vb-line ${interim ? '' : 'muted'}" id="home-transcript">${line}</div>
            </div>
            ${sr ? `<div class="vb-hints">${hints.map(h => `<span class="vb-hint">${escHtml(h)}</span>`).join('')}</div>` : ''}
          </div>`;
      }

      function voiceBarHints() {
        const fn = firstSpokenName();
        const chips = ['“open ' + fn + '”'];
        const f = allFolders()[0];
        if (f && f.name) chips.push('“open ' + f.name + ' folder”');
        else if (STATE.bookmarks.length >= 2) {
          const two = STATE.bookmarks.slice(0, 2).map(b => b.name || hostCore(b.url));
          chips.push('“split ' + two[0] + ' and ' + two[1] + '”');
        } else chips.push('“add Dropbox”');
        return chips.slice(0, 2);
      }

      // The home action bar — listening, rearrange, and add, lined up together
      // just above the search so every control sits in one place. The search
      // field itself only appears once a collection is big enough to need it.
      function renderHomeTools() {
        const sr = VOICE.srSupported;
        const on = VOICE.listenOn;
        const edit = STATE.editMode;
        const listenCls = !sr ? 'disabled' : (on ? 'on' : 'off');
        const listenLabel = !sr ? 'Voice needs Chrome' : (on ? 'Listening' : 'Start listening');
        const q = STATE.homeSearch;
        const showSearch = STATE.bookmarks.length >= 5;
        return `
          <div class="home-actions">
            ${q ? '' : `<button class="home-pages-btn ${STATE.pageNavOpen ? 'on' : ''}" data-action="toggle-page-nav" title="${STATE.pageNavOpen ? 'Hide pages' : 'Show pages'}" aria-label="${STATE.pageNavOpen ? 'Hide pages' : 'Show pages'}"><i data-lucide="panel-left"></i></button>`}
            <button class="home-listen ${listenCls}" data-action="${sr ? 'toggle-listen' : 'noop'}" ${sr ? '' : 'disabled'} title="${on ? 'Click to stop listening (' + shortcutLabel() + ')' : 'Click to start listening (' + shortcutLabel() + ')'}">
              <span class="dot"></span><i data-lucide="mic"></i> ${escHtml(listenLabel)}
            </button>
            <button class="sb-edit-btn home-edit ${edit ? 'on' : ''}" data-action="toggle-edit" title="${edit ? 'Done' : 'Rearrange apps'}" aria-label="${edit ? 'Done arranging' : 'Rearrange apps'}">
              <i data-lucide="${edit ? 'check' : 'pencil'}"></i>
            </button>
            <div class="home-actions-spacer"></div>
            <button class="btn-primary home-add-btn" data-action="add-app"><i data-lucide="plus"></i> Add</button>
          </div>
          ${showSearch ? `
          <div class="home-search-row">
            <div class="home-search">
              <i data-lucide="search" class="search-ic"></i>
              <input type="text" id="home-search" placeholder="Search your bookmarks…" value="${escAttr(q)}" autocomplete="off" spellcheck="false">
              ${q ? `<button class="clear-search" data-action="clear-search" aria-label="Clear search"><i data-lucide="x"></i></button>` : ''}
            </div>
          </div>` : ''}`;
      }

      function renderSearchResults(q) {
        const nq = normalize(q);
        const matches = STATE.bookmarks.filter(b =>
          normalize(b.name).includes(nq) ||
          normalize(hostCore(b.url)).includes(nq) ||
          normalize(hostOf(b.url).replace(/\./g, ' ')).includes(nq) ||
          normalize(b.notes).includes(nq));
        if (!matches.length) {
          return `<div class="search-empty"><i data-lucide="search-x"></i><p>No bookmarks match “${escHtml(q)}”.<br>Try a different word, or add it as a new site.</p></div>`;
        }
        return `<div class="search-results">${matches.map(renderSearchCard).join('')}</div>`;
      }

      function renderSearchCard(bm) {
        const fav = iconFor(bm);
        const letter = appLetter(bm);
        const grad = iconGradient(bm.name || bm.url);
        const inner = fav
          ? `<img src="${escAttr(fav)}" alt="" onerror="var p=this.parentNode;this.remove();if(p){p.textContent='${escAttr(letter)}';p.classList.add('noimg');p.style.background='${grad}';}">`
          : escHtml(letter);
        const favStyle = fav ? '' : ` style="background:${grad}"`;
        return `
          <div class="src-card" data-action="open-bookmark" data-id="${escAttr(bm.id)}" title="Open ${escAttr(bm.name)}">
            <div class="src-fav${fav ? '' : ' noimg'}"${favStyle}>${inner}</div>
            <div class="src-meta">
              <div class="src-name">${escHtml(bm.name || hostCore(bm.url))}</div>
              <div class="src-host">${escHtml(hostOf(bm.url) || bm.url)}</div>
            </div>
            <button class="src-edit" data-action="edit-bookmark" data-id="${escAttr(bm.id)}" aria-label="Edit ${escAttr(bm.name)}"><i data-lucide="pencil"></i></button>
          </div>`;
      }

      function renderSpringboard() {
        const pages = STATE.layout.pages.length ? STATE.layout.pages : [newPage()];
        clampCurrentPage();
        const edit = STATE.editMode;
        const track = pages.map((page, pi) =>
          `<div class="sb-page" data-sb-page="${pi}" style="width:${100 / pages.length}%">${
            page.map((item, idx) => item ? renderSbCell(item, pi, idx) : renderEmptySlot(pi, idx)).join('')
          }</div>`).join('');

        // Dot strip — page indicators plus, while arranging, a "+" to add a
        // new page. Shown whenever there's more than one page or we're editing.
        const dots = (pages.length > 1 || edit) ? `
          <div class="sb-dots">
            ${pages.map((_, i) => `<button class="sb-dot ${i === STATE.currentPage ? 'active' : ''}" data-action="goto-page" data-page="${i}" data-dot="${i}" aria-label="Page ${i + 1}"></button>`).join('')}
            ${edit ? `<button class="sb-dot-add" data-action="add-page" title="Add a page" aria-label="Add a page"><i data-lucide="plus"></i></button>` : ''}
          </div>` : '';

        // iPhone-style prev/next arrows, shown when there's more than one page.
        const arrows = pages.length > 1 ? `
          <button class="sb-arrow sb-arrow-prev ${STATE.currentPage === 0 ? 'disabled' : ''}" data-action="prev-page" aria-label="Previous page"><i data-lucide="chevron-left"></i></button>
          <button class="sb-arrow sb-arrow-next ${STATE.currentPage >= pages.length - 1 ? 'disabled' : ''}" data-action="next-page" aria-label="Next page"><i data-lucide="chevron-right"></i></button>` : '';

        return `
          <div class="springboard ${edit ? 'editing' : ''}">
            ${arrows}
            <div class="sb-viewport" id="sb-viewport">
              <div class="sb-track" id="sb-track" style="width:${pages.length * 100}%; transform:translateX(-${STATE.currentPage * (100 / pages.length)}%)">
                ${track}
              </div>
            </div>
            ${dots}
            <div class="sb-dock">
              <div class="sb-dock-hint">${edit ? 'Drag an app to any open spot · drop onto another app to make a folder · drag to an edge for a new page' : 'Tip: press and hold an app — or tap the pencil up top — to rearrange'}</div>
            </div>
          </div>`;
      }

      function renderSbCell(item, pi, idx) {
        return item.type === 'folder' ? renderFolderCell(item, pi, idx) : renderAppCell(item, pi, idx);
      }

      // An empty grid slot — invisible when idle, a dashed drop target while
      // arranging. It mirrors a real cell's footprint so the grid stays aligned
      // and apps can be dropped into any open position, gaps and all.
      function renderEmptySlot(pi, idx) {
        return `<div class="sb-cell sb-slot-empty" data-sb="empty" data-page="${pi}" data-index="${idx}" aria-hidden="true"><div class="sb-tile-ghost"></div><div class="sb-label">&nbsp;</div></div>`;
      }

      // The fallback initial — strictly alphanumeric since it's interpolated
      // into an inline onerror handler, so no quotes/markup can leak in.
      function appLetter(bm) {
        return ((bm.name || hostCore(bm.url) || '?').replace(/[^a-z0-9]/ig, '').charAt(0) || '?').toUpperCase();
      }

      function renderAppCell(item, pi, idx) {
        const bm = STATE.bookmarks.find(b => b.id === item.id);
        if (!bm) return '';
        const edit = STATE.editMode;
        const fav = iconFor(bm);
        const letter = appLetter(bm);
        const grad = iconGradient(bm.name || bm.url);
        const tileInner = fav
          ? `<img src="${escAttr(fav)}" alt="" onerror="var p=this.parentNode;this.remove();if(p){p.classList.add('noimg');p.setAttribute('data-letter','${escAttr(letter)}');p.style.background='${grad}';}">`
          : `<span class="sb-letter">${escHtml(letter)}</span>`;
        const tileStyle = fav ? '' : ` style="background:${grad}"`;
        return `
          <div class="sb-cell" data-sb="app" data-page="${pi}" data-index="${idx}" data-id="${escAttr(bm.id)}">
            ${edit ? `<button class="sb-badge" data-action="confirm-delete" data-id="${escAttr(bm.id)}" title="Delete" aria-label="Delete ${escAttr(bm.name)}"><i data-lucide="x"></i></button>` : ''}
            <div class="sb-tile" data-action="${edit ? 'edit-bookmark' : 'open-bookmark'}" data-id="${escAttr(bm.id)}" title="${escAttr(bm.name)}"${tileStyle}>${tileInner}</div>
            <div class="sb-label">${escHtml(bm.name || hostCore(bm.url))}</div>
          </div>`;
      }

      function renderFolderCell(folder, pi, idx) {
        const edit = STATE.editMode;
        const preview = folder.items.slice(0, 9).map(a => {
          const bm = STATE.bookmarks.find(b => b.id === a.id);
          const fav = bm ? iconFor(bm) : '';
          const grad = bm ? iconGradient(bm.name || bm.url) : '';
          return fav
            ? `<span class="sb-mini"><img src="${escAttr(fav)}" alt="" onerror="this.remove();if(this.parentNode)this.parentNode.style.background='${grad}'"></span>`
            : `<span class="sb-mini"${grad ? ` style="background:${grad}"` : ''}></span>`;
        }).join('');
        return `
          <div class="sb-cell" data-sb="folder" data-page="${pi}" data-index="${idx}" data-fid="${escAttr(folder.id)}">
            <div class="sb-folder" data-action="open-folder" data-fid="${escAttr(folder.id)}" title="${escAttr(folder.name)}">
              <div class="sb-folder-grid">${preview}</div>
            </div>
            <div class="sb-label">${escHtml(folder.name)}</div>
          </div>`;
      }

      /* ---------------- overlays: folder view + modals ---------------- */
      function renderOverlays() {
        return renderFolderOverlay() + renderEditModal() + renderAddModal() + renderConfirmModal();
      }

      function renderFolderOverlay() {
        if (!STATE.openFolderId) return '';
        const folder = findFolderById(STATE.openFolderId);
        if (!folder) return '';
        const edit = STATE.editMode;
        const apps = folder.items.map((a, idx) => {
          const bm = STATE.bookmarks.find(b => b.id === a.id);
          if (!bm) return '';
          const fav = iconFor(bm);
          const letter = appLetter(bm);
          const grad = iconGradient(bm.name || bm.url);
          const tileInner = fav
            ? `<img src="${escAttr(fav)}" alt="" onerror="var p=this.parentNode;this.remove();if(p){p.classList.add('noimg');p.setAttribute('data-letter','${escAttr(letter)}');p.style.background='${grad}';}">`
            : `<span class="sb-letter">${escHtml(letter)}</span>`;
          const tileStyle = fav ? '' : ` style="background:${grad}"`;
          return `
            <div class="sb-cell" data-sb="fapp" data-fid="${escAttr(folder.id)}" data-index="${idx}" data-id="${escAttr(bm.id)}">
              ${edit ? `<button class="sb-badge" data-action="remove-from-folder" data-fid="${escAttr(folder.id)}" data-id="${escAttr(bm.id)}" title="Move out of folder" aria-label="Move ${escAttr(bm.name)} out of folder"><i data-lucide="x"></i></button>` : ''}
              <div class="sb-tile" data-action="${edit ? 'edit-bookmark' : 'open-bookmark'}" data-id="${escAttr(bm.id)}" title="${escAttr(bm.name)}"${tileStyle}>${tileInner}</div>
              <div class="sb-label">${escHtml(bm.name || hostCore(bm.url))}</div>
            </div>`;
        }).join('');
        return `
          <div class="sb-overlay">
            <div class="sb-overlay-bg" data-action="close-folder"></div>
            <div class="sb-folder-panel">
              <div class="sb-folder-head">
                ${edit
                  ? `<input type="text" id="folder-name" data-folder-name placeholder="Folder name" value="${escAttr(folder.name)}" autocomplete="off">`
                  : `<div class="sb-folder-title">${escHtml(folder.name)}</div>`}
                <button class="sb-folder-close" data-action="close-folder" aria-label="Close folder"><i data-lucide="x"></i></button>
              </div>
              <div class="sb-folder-apps" data-folder-apps="${escAttr(folder.id)}">${apps}</div>
            </div>
          </div>`;
      }

      // First letter fallback for a thumbnail preview built from draft values.
      function draftLetter(name, url) {
        return ((name || hostCore(url) || '?').replace(/[^a-z0-9]/ig, '').charAt(0) || '?').toUpperCase();
      }

      // The small live thumbnail preview shown in the add/edit modals: the
      // custom image if set, otherwise the site favicon, otherwise a letter.
      function renderThumbPreview(iconVal, url, letter) {
        const src = String(iconVal || '').trim() || faviconFor(url);
        const grad = iconGradient(url || letter);
        return src
          ? `<img src="${escAttr(src)}" alt="" onerror="var p=this.parentNode;this.remove();if(p){p.textContent='${escAttr(letter)}';p.classList.add('noimg');p.style.background='${grad}';}">`
          : escHtml(letter);
      }

      // Shared description-note + custom-thumbnail fields used by both the add
      // and edit modals. Everything here is optional; left blank, the app keeps
      // its current behaviour (no note, favicon thumbnail).
      function renderMetaFields(o) {
        const letter = draftLetter(o.name, o.url);
        return `
          <div class="field-label"><i data-lucide="align-left"></i> Description <span class="opt">— optional, helps voice find it</span></div>
          <textarea id="${o.idNotes}" placeholder="A note about this bookmark — e.g. “work email, open every morning”" autocomplete="off">${escHtml(o.notes)}</textarea>
          <div class="field-label"><i data-lucide="image"></i> Thumbnail <span class="opt">— optional</span></div>
          <div class="thumb-row">
            <div class="thumb-prev" id="${o.idPrev}">${renderThumbPreview(o.icon, o.url, letter)}</div>
            <div class="thumb-fields">
              <input type="text" id="${o.idIcon}" placeholder="Image URL (https://…/logo.png)" value="${escAttr(o.icon)}" autocomplete="off">
              <div class="thumb-actions">
                <label class="btn-ghost thumb-upload"><i data-lucide="upload"></i> Upload image<input type="file" id="${o.idFile}" accept="image/*"></label>
                <button type="button" class="btn-ghost" data-action="${o.resetAction}"><i data-lucide="rotate-ccw"></i> Use site icon</button>
              </div>
            </div>
          </div>`;
      }

      function renderAddModal() {
        if (!STATE.adding) return '';
        const sugg = starterSuggestions(6);
        const suggHtml = sugg.length ? `
              <div class="modal-sugg">
                <div class="modal-sugg-label">Quick add</div>
                <div class="modal-sugg-row">
                  ${sugg.map(s => {
                    const i = STARTER_SITES.indexOf(s);
                    const fav = faviconFor(s.url);
                    const letter = (s.name.replace(/[^a-z0-9]/ig, '').charAt(0) || '?').toUpperCase();
                    return `<button class="sugg-pill" data-action="add-starter" data-starter="${i}"><img src="${escAttr(fav)}" alt="" onerror="var p=this.parentNode;this.remove();if(p){p.classList.add('sc-noimg');p.setAttribute('data-letter','${escAttr(letter)}');}"><span>${escHtml(s.name)}</span></button>`;
                  }).join('')}
                </div>
              </div>` : '';
        return `
          <div class="sb-overlay">
            <div class="sb-overlay-bg" data-action="close-add"></div>
            <div class="modal">
              <div class="modal-head">
                <div>
                  <div class="modal-title">Add a website</div>
                  <div class="modal-sub">The name is what you’ll say out loud to open it by voice.</div>
                </div>
                ${VOICE.srSupported ? `<button class="modal-mic ${VOICE.dictating ? 'on' : ''}" data-action="toggle-dictation" title="${VOICE.dictating ? 'Voice dictation on — click to turn off' : 'Turn on voice dictation'}" aria-label="${VOICE.dictating ? 'Turn off voice dictation' : 'Turn on voice dictation'}"><span class="modal-mic-dot"></span><i data-lucide="mic"></i></button>` : ''}
              </div>
              ${VOICE.dictating ? `<div class="modal-dictate-hint"><i data-lucide="mic"></i> Listening — speak to fill the field you’re in, and click any field to switch.</div>` : ''}
              <div class="modal-fields">
                <input type="text" id="bm-name" placeholder="Name (e.g. Salesforce)" value="${escAttr(STATE.draftName)}" autocomplete="off">
                <input type="text" id="bm-url" placeholder="Web address (salesforce.com)" value="${escAttr(STATE.draftUrl)}" autocomplete="off">
                ${renderMetaFields({
                  idNotes: 'bm-notes', idIcon: 'bm-icon', idFile: 'bm-icon-file', idPrev: 'thumb-prev-add',
                  resetAction: 'reset-icon-add',
                  notes: STATE.draftNotes, icon: STATE.draftIcon, name: STATE.draftName, url: STATE.draftUrl
                })}
              </div>
              ${suggHtml}
              <div class="modal-actions">
                <span style="flex:1"></span>
                <button class="btn-outline" data-action="close-add">Cancel</button>
                <button class="btn-primary" data-action="add-bookmark"><i data-lucide="plus"></i> Add</button>
              </div>
            </div>
          </div>`;
      }

      function renderEditModal() {
        if (!STATE.editingId) return '';
        const bm = STATE.bookmarks.find(b => b.id === STATE.editingId);
        if (!bm) return '';
        return `
          <div class="sb-overlay">
            <div class="sb-overlay-bg" data-action="cancel-edit"></div>
            <div class="modal">
              <div class="modal-head">
                <div class="modal-title">Edit website</div>
                ${VOICE.srSupported ? `<button class="modal-mic ${VOICE.dictating ? 'on' : ''}" data-action="toggle-dictation" title="${VOICE.dictating ? 'Voice dictation on — click to turn off' : 'Turn on voice dictation'}" aria-label="${VOICE.dictating ? 'Turn off voice dictation' : 'Turn on voice dictation'}"><span class="modal-mic-dot"></span><i data-lucide="mic"></i></button>` : ''}
              </div>
              ${VOICE.dictating ? `<div class="modal-dictate-hint"><i data-lucide="mic"></i> Listening — speak to fill the field you’re in, and click any field to switch.</div>` : ''}
              <div class="modal-fields">
                <input type="text" id="edit-name" data-edit="name" placeholder="Name" value="${escAttr(STATE.editDraftName)}" autocomplete="off">
                <input type="text" id="edit-url" data-edit="url" placeholder="Web address" value="${escAttr(STATE.editDraftUrl)}" autocomplete="off">
                ${renderMetaFields({
                  idNotes: 'edit-notes', idIcon: 'edit-icon', idFile: 'edit-icon-file', idPrev: 'thumb-prev-edit',
                  resetAction: 'reset-icon-edit',
                  notes: STATE.editDraftNotes, icon: STATE.editDraftIcon, name: STATE.editDraftName, url: STATE.editDraftUrl
                })}
              </div>
              <div class="modal-actions">
                <button class="btn-ghost del-text" data-action="confirm-delete" data-id="${escAttr(bm.id)}"><i data-lucide="trash-2"></i> Delete</button>
                <span style="flex:1"></span>
                <button class="btn-outline" data-action="cancel-edit">Cancel</button>
                <button class="btn-primary" data-action="save-edit" data-id="${escAttr(bm.id)}"><i data-lucide="check"></i> Save</button>
              </div>
            </div>
          </div>`;
      }

      function renderConfirmModal() {
        if (!STATE.confirmDeleteId) return '';
        const bm = STATE.bookmarks.find(b => b.id === STATE.confirmDeleteId);
        if (!bm) return '';
        return `
          <div class="sb-overlay">
            <div class="sb-overlay-bg" data-action="cancel-delete"></div>
            <div class="modal modal-confirm">
              <div class="modal-ic-del"><i data-lucide="trash-2"></i></div>
              <div class="modal-title">Delete “${escHtml(bm.name)}”?</div>
              <div class="modal-sub">This removes it from your bookmarks. You can always add it again.</div>
              <div class="modal-actions">
                <button class="btn-outline" data-action="cancel-delete">Cancel</button>
                <button class="btn-primary danger" data-action="delete-bookmark" data-id="${escAttr(bm.id)}">Delete</button>
              </div>
            </div>
          </div>`;
      }

      function renderPending() {
        const bm = VOICE.pendingOpen;
        return `
          <div class="pending" style="width:100%">
            <div class="pending-ic"><i data-lucide="mouse-pointer-click"></i></div>
            <div class="pending-body">
              <div class="pending-title">Ready to open ${escHtml(bm.name)}</div>
              <div class="pending-sub">Your browser blocked the pop-up. Tap to open, or allow pop-ups for this site to go hands-free.</div>
            </div>
            <button class="btn-primary" data-action="open-pending"><i data-lucide="external-link"></i> Open</button>
            <button class="pending-x" data-action="dismiss-pending" title="Dismiss"><i data-lucide="x"></i></button>
          </div>`;
      }

      function renderPendingGroup() {
        const g = VOICE.pendingGroup;
        if (!g) return '';
        const n = g.bms.length;
        return `
          <div class="pending" style="width:100%">
            <div class="pending-ic"><i data-lucide="mouse-pointer-click"></i></div>
            <div class="pending-body">
              <div class="pending-title">Ready to open ${n} site${n > 1 ? 's' : ''} from ${escHtml(g.label)}</div>
              <div class="pending-sub">Your browser blocked the pop-ups. Tap to open them all, or allow pop-ups for this site to open folders hands-free.</div>
            </div>
            <button class="btn-primary" data-action="open-pending-group"><i data-lucide="external-link"></i> Open ${n}</button>
            <button class="pending-x" data-action="dismiss-pending-group" title="Dismiss"><i data-lucide="x"></i></button>
          </div>`;
      }

      function renderPendingSplit() {
        const s = VOICE.pendingSplit;
        if (!s) return '';
        const n = s.plan.length;
        return `
          <div class="pending" style="width:100%">
            <div class="pending-ic"><i data-lucide="columns-2"></i></div>
            <div class="pending-body">
              <div class="pending-title">Ready to open ${escHtml(s.label)} in a split view</div>
              <div class="pending-sub">Your browser blocked the pop-up${n > 1 ? 's' : ''}. Tap to open ${n > 1 ? 'them side by side' : 'it'}, or allow pop-ups for this site to open split views hands-free.</div>
            </div>
            <button class="btn-primary" data-action="open-pending-split"><i data-lucide="columns-2"></i> Open</button>
            <button class="pending-x" data-action="dismiss-pending-split" title="Dismiss"><i data-lucide="x"></i></button>
          </div>`;
      }

      // The newest changelog version this device has already seen, used to
      // show a "New" badge until Settings is opened. Stored locally so it
      // never depends on the sheet being reachable.
      function changelogSeen() {
        try { return localStorage.getItem(LS_CHANGELOG_SEEN) || ''; } catch { return ''; }
      }
      function markChangelogSeen() {
        const latest = CHANGELOG[0] && CHANGELOG[0].version;
        if (!latest) return;
        try { localStorage.setItem(LS_CHANGELOG_SEEN, latest); } catch {}
      }
      function hasUnseenChangelog() {
        const latest = CHANGELOG[0] && CHANGELOG[0].version;
        return !!latest && changelogSeen() !== latest;
      }

      // The "What's new" panel for Settings: the latest update is highlighted,
      // with a handful of prior releases listed below, each as a couple of
      // bullet points.
      function renderWhatsNew() {
        if (!CHANGELOG.length) return '';
        const fresh = hasUnseenChangelog();
        const entries = CHANGELOG.slice(0, 4).map((e, i) => `
          <div class="wn-entry ${i === 0 ? 'latest' : ''}">
            <div class="wn-entry-head">
              <span class="wn-entry-title">${escHtml(e.title)}</span>
              <span class="wn-entry-date">${escHtml(e.date)}</span>
            </div>
            <ul class="wn-bullets">${(e.items || []).map(it => `<li>${escHtml(it)}</li>`).join('')}</ul>
          </div>`).join('');
        return `
          <div class="whatsnew">
            <div class="whatsnew-head">
              <span class="whatsnew-title">What’s new</span>
              ${fresh ? '<span class="whatsnew-badge">New</span>' : ''}
            </div>
            <div class="whatsnew-list">${entries}</div>
          </div>`;
      }

      function renderRecent(isFocus) {
        const items = VOICE.recentActions;
        return `
          <div class="recent" ${isFocus ? '' : 'style="width:100%"'}>
            <div class="recent-head">
              <span class="recent-title">Recent</span>
              ${items.length ? `<button class="recent-clear" data-action="clear-recent">Clear</button>` : ''}
            </div>
            ${items.length ? `<div class="recent-list">${items.map(renderRecentItem).join('')}</div>` : `
              <div class="recent-empty">Nothing yet. When you open a bookmark by voice, it shows up here.</div>`}
          </div>`;
      }

      function renderRecentItem(a) {
        const icon = a.type === 'opened' ? 'external-link' : a.type === 'split' ? 'columns-2' : a.type === 'added' ? 'bookmark-plus' : a.type === 'blocked' ? 'mouse-pointer-click' : a.type === 'notfound' ? 'search-x' : 'info';
        let main;
        if (a.type === 'opened') main = 'Opened ' + escHtml(a.name);
        else if (a.type === 'split') main = 'Split view ' + escHtml(a.name);
        else if (a.type === 'added') main = 'Added ' + escHtml(a.name);
        else if (a.type === 'blocked') main = 'Tap to open ' + escHtml(a.name);
        else if (a.type === 'notfound') main = 'No match for “' + escHtml(a.query) + '”';
        else main = escHtml(a.text || '');
        return `
          <div class="recent-item">
            <div class="recent-ic ${a.type}"><i data-lucide="${icon}"></i></div>
            <div class="recent-body">
              <div class="recent-main">${main}</div>
              <div class="recent-time">${relTime(a.at)}</div>
            </div>
          </div>`;
      }

      /* ---------------- focus screen ---------------- */
      function renderFocus() {
        const sr = VOICE.srSupported;
        const on = VOICE.listenOn;
        const interim = VOICE.interimText;
        return `
          <div class="focus">
            <div class="focus-inner">
              ${VOICE.pendingOpen ? `<div style="width:100%;max-width:480px;margin-bottom:18px">${renderPending()}</div>` : ''}
              ${VOICE.pendingGroup ? `<div style="width:100%;max-width:480px;margin-bottom:18px">${renderPendingGroup()}</div>` : ''}
              ${VOICE.pendingSplit ? `<div style="width:100%;max-width:480px;margin-bottom:18px">${renderPendingSplit()}</div>` : ''}
              <div class="orb-wrap ${on ? 'live' : ''}">
                <span class="orb-ring"></span><span class="orb-ring d"></span>
                <button class="voice-orb ${on ? 'on' : 'off'}" data-action="${sr ? 'toggle-listen' : 'noop'}" ${sr ? '' : 'disabled'} aria-label="${on ? 'Stop listening' : 'Start listening'}">
                  <i data-lucide="mic"></i>
                </button>
              </div>
              <div class="focus-title">${on ? 'Listening' : 'Ready when you are'}</div>
              <div class="focus-sub">${!sr ? 'Voice needs Chrome or Edge to listen.' : on ? 'Say “open” and a bookmark name to open one site, or a folder name to open the whole group — name several (“open games and searches”) to open them all. Say “split view” and two names, bookmarks or folders, to tile them side by side. Say “add” and a company to save it. When a site opens and you click over to it, listening stops on its own — come back and tap to start again.' : 'Tap the circle and start talking.'}</div>
              ${sr ? `<div class="vp-shortcut" style="margin-top:16px">${shortcutHint()}</div>` : ''}
              <div class="focus-transcript ${interim ? '' : 'muted'}" id="focus-transcript">${interim ? escHtml(interim) + '<span class="caret"></span>' : transcriptResting('focus-transcript')}</div>
              <div class="vp-examples" style="justify-content:center">
                ${exampleNames().map(n => `<span class="vp-chip">${escHtml(n)}</span>`).join('')}
                ${allFolders()[0] ? `<span class="vp-chip">${escHtml('“Open ' + (allFolders()[0].name || 'folder') + ' folder”')}</span>` : ''}
                ${splitExampleChip()}
                <span class="vp-chip">${escHtml('“Add Dropbox”')}</span>
              </div>
              <div class="focus-options">
                <div class="opt-row">
                  <div class="opt-text">
                    <div class="opt-title">Speak confirmations</div>
                    <div class="opt-sub">Say “Opening Salesforce” out loud when it acts. Off keeps it mic-only.</div>
                  </div>
                  <span class="switch ${STATE.settings.speak ? 'on' : ''}" role="switch" tabindex="0" aria-checked="${STATE.settings.speak}" data-action="toggle-speak" aria-label="Speak confirmations"></span>
                </div>
                ${sr ? `<div class="opt-row">
                  <div class="opt-text">
                    <div class="opt-title">Keyboard shortcut</div>
                    <div class="opt-sub">Press this anywhere to start or stop listening. Click to change.</div>
                  </div>
                  <div class="sc-edit">
                    <button class="sc-rec ${STATE.recordingShortcut ? 'recording' : ''}" data-action="record-shortcut" aria-label="Change keyboard shortcut" title="Click, then press your key combo">
                      ${STATE.recordingShortcut ? 'Press keys…<span class="sc-esc">Esc to cancel</span>' : shortcutKbdHtml()}
                    </button>
                    ${!STATE.recordingShortcut && !isDefaultShortcut() ? `<button class="sc-reset" data-action="reset-shortcut" title="Reset to Ctrl+R">Reset</button>` : ''}
                  </div>
                </div>` : ''}
              </div>
              ${renderWhatsNew()}
              <div class="focus-recent">${renderRecent(true)}</div>
            </div>
          </div>`;
      }

      function renderToast() {
        if (!VOICE.toastMessage) return '<div id="toast-mount"></div>';
        return `<div id="toast-mount"><div class="toast">${VOICE.toastIcon ? `<i data-lucide="${escAttr(VOICE.toastIcon)}"></i>` : ''}<span>${escHtml(VOICE.toastMessage)}</span></div></div>`;
      }

      function relTime(ts) {
        const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (s < 5) return 'just now';
        if (s < 60) return s + 's ago';
        const m = Math.round(s / 60);
        if (m < 60) return m + 'm ago';
        const h = Math.round(m / 60);
        if (h < 24) return h + 'h ago';
        return new Date(ts).toLocaleDateString();
      }

      /* ================================================================
       * Events
       * ================================================================ */
      // Read a chosen image file into a data URL so a custom thumbnail persists
      // locally (and syncs) without needing a hosted image. Guards type and
      // size so a stray huge file can't blow past localStorage limits.
      function readIconFile(file, cb) {
        if (!file) return;
        if (!/^image\//.test(file.type || '')) { showToast('Choose an image file', 'triangle-alert'); return; }
        if (file.size > 1024 * 1024) { showToast('That image is too large — pick one under 1 MB', 'triangle-alert'); return; }
        const reader = new FileReader();
        reader.onload = () => cb(String(reader.result || ''));
        reader.onerror = () => showToast('Could not read that image', 'triangle-alert');
        reader.readAsDataURL(file);
      }

      // Wire the optional description note + thumbnail controls for one modal.
      // Kept generic so the add and edit modals share the exact same behaviour.
      function bindMetaFields(o) {
        const notesEl = document.getElementById(o.idNotes);
        if (notesEl) notesEl.oninput = (e) => o.setNotes(e.target.value);

        const iconEl = document.getElementById(o.idIcon);
        if (iconEl) iconEl.oninput = (e) => {
          o.setIcon(e.target.value);
          const prev = document.getElementById(o.idPrev);
          if (prev) prev.innerHTML = renderThumbPreview(e.target.value, o.url(), draftLetter(o.name(), o.url()));
        };

        const fileEl = document.getElementById(o.idFile);
        if (fileEl) fileEl.onchange = (e) => readIconFile(e.target.files && e.target.files[0], (dataUrl) => {
          o.setIcon(dataUrl);
          render();   // re-render so the preview and field reflect the upload
        });
      }

      function bindEvents() {
        const app = document.getElementById('app');

        app.onclick = (e) => {
          // Swallow the synthetic click that fires right after a drag/long-press
          // so "carry an app" never also "opens" it.
          if (Date.now() - PDRAG.dragEndedAt < 350) { PDRAG.dragEndedAt = 0; e.preventDefault(); e.stopPropagation(); return; }
          const target = e.target.closest('[data-action]');
          if (!target) return;
          const action = target.getAttribute('data-action');
          const id = target.getAttribute('data-id');
          const fid = target.getAttribute('data-fid');
          switch (action) {
            case 'noop': break;
            case 'go-home': STATE.view = 'home'; render(); break;
            case 'go-focus': STATE.view = 'focus'; markChangelogSeen(); render(); break;
            case 'toggle-listen': toggleListening(); break;
            case 'toggle-dictation': if (VOICE.dictating) { stopDictation(); render(); } else { startDictation(); } break;
            case 'add-bookmark': addBookmark(); break;
            case 'save-bookmarks': saveBookmarks(); break;
            case 'open-bookmark': { const bm = STATE.bookmarks.find(b => b.id === id); if (bm) openBookmark(bm, { viaVoice: false }); break; }
            case 'edit-bookmark': startEdit(id); startDictation(); break;
            case 'save-edit': saveEdit(id); break;
            case 'cancel-edit': cancelEdit(); break;
            case 'confirm-delete': stopDictation(); STATE.confirmDeleteId = id; STATE.editingId = null; STATE.adding = false; render(); break;
            case 'cancel-delete': STATE.confirmDeleteId = null; render(); break;
            case 'delete-bookmark': deleteBookmark(id); break;
            case 'open-pending': openPending(); break;
            case 'dismiss-pending': VOICE.pendingOpen = null; render(); break;
            case 'open-pending-group': openPendingGroup(); break;
            case 'dismiss-pending-group': VOICE.pendingGroup = null; render(); break;
            case 'open-pending-split': openPendingSplit(); break;
            case 'dismiss-pending-split': VOICE.pendingSplit = null; render(); break;
            case 'toggle-speak': STATE.settings.speak = !STATE.settings.speak; persistSettings(); render(); break;
            case 'record-shortcut': STATE.recordingShortcut = !STATE.recordingShortcut; render(); break;
            case 'reset-shortcut': STATE.settings.shortcut = defaultShortcut(); STATE.recordingShortcut = false; persistSettings(); render(); break;
            case 'clear-recent': VOICE.recentActions = []; render(); break;
            // ----- springboard -----
            case 'goto-page': {
              gotoPage(parseInt(target.getAttribute('data-page'), 10) || 0);
              // On a phone the rail is a drawer over the board — close it once a
              // page is picked so the board is visible.
              if (STATE.pageNavOpen && window.matchMedia && window.matchMedia('(max-width: 820px)').matches) { STATE.pageNavOpen = false; render(); }
              break;
            }
            case 'prev-page': gotoPage(STATE.currentPage - 1); break;
            case 'next-page': gotoPage(STATE.currentPage + 1); break;
            case 'add-page': addBlankPage(); break;
            case 'toggle-page-nav': STATE.pageNavOpen = !STATE.pageNavOpen; render(); break;
            case 'move-page-up': movePage(parseInt(target.getAttribute('data-page'), 10) || 0, -1); break;
            case 'move-page-down': movePage(parseInt(target.getAttribute('data-page'), 10) || 0, +1); break;
            case 'toggle-edit': STATE.editMode = !STATE.editMode; normalizeLayout(); persistLayout(); render(); break;
            case 'add-app': STATE.adding = true; STATE.draftName = ''; STATE.draftUrl = ''; STATE.draftNotes = ''; STATE.draftIcon = ''; VOICE.dictateField = 'bm-name'; render(); startDictation(); break;
            case 'reset-icon-add': STATE.draftIcon = ''; render(); break;
            case 'reset-icon-edit': STATE.editDraftIcon = ''; render(); break;
            case 'add-starter': addStarter(parseInt(target.getAttribute('data-starter'), 10)); break;
            case 'clear-search': STATE.homeSearch = ''; render(); break;
            case 'close-add': stopDictation(); STATE.adding = false; render(); break;
            case 'open-folder': STATE.openFolderId = fid; render(); break;
            case 'close-folder': STATE.openFolderId = null; persistLayout(); render(); break;
            case 'remove-from-folder': moveAppOutOfFolder(fid, id); normalizeLayout(); persistLayout(); render(); break;
          }
        };

        // Keyboard switch toggle
        app.onkeydown = (e) => {
          const sw = e.target.closest('[role="switch"]');
          if (sw && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sw.click(); }
        };

        // Add-form drafts (kept in state so voice re-renders don't lose typing)
        const nameEl = document.getElementById('bm-name');
        const urlEl = document.getElementById('bm-url');
        // Live search on the Bookmarks screen. render() captures/restores focus
        // (with caret position), so re-rendering on each keystroke keeps typing
        // smooth while the results update underneath.
        const searchEl = document.getElementById('home-search');
        if (searchEl) {
          searchEl.oninput = (e) => { STATE.homeSearch = e.target.value; render(); };
          searchEl.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); STATE.homeSearch = ''; render(); } };
        }
        if (nameEl) {
          nameEl.oninput = (e) => { STATE.draftName = e.target.value; };
          nameEl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); if (urlEl) urlEl.focus(); } };
        }
        if (urlEl) {
          urlEl.oninput = (e) => { STATE.draftUrl = e.target.value; };
          urlEl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addBookmark(); } };
        }
        // Hands-free dictation: focusing a field (e.g. clicking it) makes it the
        // dictation target, so the user can move between fields with the mouse.
        DICTATE_FIELDS.forEach(fid => {
          const el = document.getElementById(fid);
          if (el) el.onfocus = () => { if (VOICE.dictating) setDictationField(fid); };
        });

        // Inline-edit drafts (name + url)
        document.querySelectorAll('[data-edit]').forEach(el => {
          el.oninput = (ev) => {
            if (ev.target.getAttribute('data-edit') === 'name') STATE.editDraftName = ev.target.value;
            else STATE.editDraftUrl = ev.target.value;
          };
          el.onkeydown = (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); if (STATE.editingId) saveEdit(STATE.editingId); }
            else if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
          };
        });

        // Description note + custom thumbnail — add modal. The note is a plain
        // draft; the thumbnail URL updates the little preview live, and an
        // uploaded image is read into a data URL so it persists on this device.
        bindMetaFields({
          idNotes: 'bm-notes', idIcon: 'bm-icon', idFile: 'bm-icon-file', idPrev: 'thumb-prev-add',
          setNotes: v => { STATE.draftNotes = v; },
          setIcon: v => { STATE.draftIcon = v; },
          name: () => STATE.draftName, url: () => STATE.draftUrl
        });
        // Description note + custom thumbnail — edit modal.
        bindMetaFields({
          idNotes: 'edit-notes', idIcon: 'edit-icon', idFile: 'edit-icon-file', idPrev: 'thumb-prev-edit',
          setNotes: v => { STATE.editDraftNotes = v; },
          setIcon: v => { STATE.editDraftIcon = v; },
          name: () => STATE.editDraftName, url: () => STATE.editDraftUrl
        });

        // Live folder rename (kept on the folder object as you type).
        const fname = document.querySelector('[data-folder-name]');
        if (fname) {
          fname.oninput = (ev) => {
            const folder = findFolderById(STATE.openFolderId);
            if (folder) { folder.name = ev.target.value; persistLayout(); }
          };
        }

        // Live page rename in the "Pages" rail. Like the folder rename, we
        // persist as you type (no re-render, so the cursor stays put); pressing
        // Enter/Escape commits and refreshes the rail's labels.
        document.querySelectorAll('[data-page-name]').forEach(el => {
          el.oninput = (ev) => {
            const i = parseInt(el.getAttribute('data-page'), 10);
            if (Number.isInteger(i)) { pageNamesArr()[i] = ev.target.value; persistLayout(); }
          };
          el.onkeydown = (ev) => {
            if (ev.key === 'Enter' || ev.key === 'Escape') { ev.preventDefault(); el.blur(); render(); }
          };
        });

        // Pointer-driven "lift and carry" rearranging (assignment, not
        // addEventListener, so handlers don't stack across re-renders). Killing
        // the native dragstart stops the browser ghost-dragging a favicon image.
        app.onpointerdown = sbPointerDown;
        app.ondragstart = (e) => { if (e.target.closest('[data-sb]')) e.preventDefault(); };

        // Touch swipe between pages (when not rearranging).
        const vp = document.getElementById('sb-viewport');
        if (vp) {
          let sx = 0, sy = 0, tracking = false;
          vp.ontouchstart = (e) => { if (STATE.editMode) return; const t = e.touches[0]; sx = t.clientX; sy = t.clientY; tracking = true; };
          vp.ontouchend = (e) => {
            if (!tracking) return; tracking = false;
            const t = e.changedTouches[0];
            const dx = t.clientX - sx, dy = t.clientY - sy;
            if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) gotoPage(STATE.currentPage + (dx < 0 ? 1 : -1));
          };
        }
      }

      /* ---------------- page navigation + drag-and-drop ---------------- */
      // Switch pages by sliding the track directly — no full re-render, so an
      // in-progress drag (whose source node would otherwise be torn down) keeps
      // working and typing focus is never stolen.
      function gotoPage(i) {
        const n = Math.max(1, STATE.layout.pages.length);
        STATE.currentPage = Math.min(Math.max(0, i), n - 1);
        const track = document.getElementById('sb-track');
        if (track) track.style.transform = `translateX(-${STATE.currentPage * (100 / n)}%)`;
        document.querySelectorAll('.sb-dot').forEach((d, idx) => d.classList.toggle('active', idx === STATE.currentPage));
        // Keep the "Pages" rail's highlight in step with swipes/arrows (which
        // move the track without a full re-render).
        document.querySelectorAll('.page-nav-link').forEach((el, idx) => el.classList.toggle('active', idx === STATE.currentPage));
        const prev = document.querySelector('.sb-arrow-prev');
        const next = document.querySelector('.sb-arrow-next');
        if (prev) prev.classList.toggle('disabled', STATE.currentPage === 0);
        if (next) next.classList.toggle('disabled', STATE.currentPage >= n - 1);
      }

      // Add a fresh page and jump to it. Page management lives in arrange
      // (jiggle) mode, so this turns that on; the empty page persists while
      // editing so apps can be dragged onto it or added there.
      function addBlankPage() {
        if (!STATE.editMode) STATE.editMode = true;
        normalizeLayout();                              // guarantees a trailing empty page
        STATE.currentPage = STATE.layout.pages.length - 1;
        persistLayout();
        render();
      }

      function readLoc(cell) {
        const sb = cell.getAttribute('data-sb');
        if (sb === 'fapp') return { kind: 'folder', fid: cell.getAttribute('data-fid'), index: +cell.getAttribute('data-index'), id: cell.getAttribute('data-id') };
        if (sb === 'folder') return { kind: 'page', page: +cell.getAttribute('data-page'), index: +cell.getAttribute('data-index'), fid: cell.getAttribute('data-fid'), isFolder: true };
        return { kind: 'page', page: +cell.getAttribute('data-page'), index: +cell.getAttribute('data-index'), id: cell.getAttribute('data-id') };
      }

      function clearDropMarkers() {
        document.querySelectorAll('.drop-before, .drop-after, .drop-folder, .drop-slot, .drop-swap').forEach(n => n.classList.remove('drop-before', 'drop-after', 'drop-folder', 'drop-slot', 'drop-swap'));
        document.querySelectorAll('.drop-page').forEach(n => n.classList.remove('drop-page'));
        document.querySelectorAll('.sb-folder-panel.pop-out').forEach(n => n.classList.remove('pop-out'));
      }

      // iPhone-style "drag to the edge to turn the page": while carrying an app
      // near the left/right border of the viewport, flip to the neighbouring
      // page after a short hover so you can move the app across pages.
      let edgeFlipTimer = null;
      function clearEdgeFlip() { if (edgeFlipTimer) { clearTimeout(edgeFlipTimer); edgeFlipTimer = null; } }
      function handleEdgeFlip(clientX) {
        // Not while reordering inside an open folder — that drag isn't a page move.
        if (STATE.openFolderId) { clearEdgeFlip(); return; }
        const vp = document.getElementById('sb-viewport');
        if (!vp) { clearEdgeFlip(); return; }
        const r = vp.getBoundingClientRect();
        const zone = 70;
        const dir = (clientX - r.left < zone) ? -1 : (r.right - clientX < zone) ? 1 : 0;
        const target = STATE.currentPage + dir;
        if (!dir || target < 0 || target >= STATE.layout.pages.length) { clearEdgeFlip(); return; }
        if (edgeFlipTimer) return; // already counting down toward a flip
        edgeFlipTimer = setTimeout(() => { edgeFlipTimer = null; gotoPage(target); }, 500);
      }

      /* ----- pointer-driven "lift and carry" drag (touch + mouse) -----
       * Replaces native HTML5 drag-and-drop, which felt rigid and didn't work
       * on touch. A pressed app is lifted into a floating clone that follows the
       * pointer 1:1; the cell underneath is highlighted to show where it lands.
       * Handles reordering, building folders, moving across pages, and pulling
       * an app back out of an open folder — one smooth gesture for all of it. */
      const PDRAG = {
        pointerId: null, cell: null, loc: null, sourceIsApp: false,
        ghost: null, offX: 0, offY: 0, startX: 0, startY: 0, lastX: 0, lastY: 0,
        lifted: false, longPress: null, dragEndedAt: 0
      };
      const PDRAG_SCALE = 1.08;

      function sbTileRect(cell) {
        const t = cell.querySelector('.sb-tile, .sb-folder');
        return (t || cell).getBoundingClientRect();
      }
      // Re-find a cell after a re-render by the identity of what it holds.
      function sbFindCell(loc) {
        if (!loc) return null;
        if (loc.kind === 'folder') return document.querySelector('[data-sb="fapp"][data-id="' + loc.id + '"]');
        if (loc.isFolder)          return document.querySelector('[data-sb="folder"][data-fid="' + loc.fid + '"]');
        return document.querySelector('[data-sb="app"][data-id="' + loc.id + '"]');
      }

      function sbPointerDown(e) {
        if (PDRAG.pointerId !== null) return;                 // a drag is already in flight
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.target.closest('.sb-badge')) return;            // the ×/remove button — let it click
        const cell = e.target.closest('[data-sb]');
        if (!cell) return;
        if (cell.getAttribute('data-sb') === 'empty') return;  // nothing to lift from a gap

        PDRAG.pointerId = e.pointerId;
        PDRAG.cell = cell;
        PDRAG.loc = readLoc(cell);
        PDRAG.sourceIsApp = (PDRAG.loc.kind === 'folder') || (PDRAG.loc.kind === 'page' && !PDRAG.loc.isFolder);
        PDRAG.startX = PDRAG.lastX = e.clientX;
        PDRAG.startY = PDRAG.lastY = e.clientY;
        const r = sbTileRect(cell);
        PDRAG.offX = e.clientX - r.left;
        PDRAG.offY = e.clientY - r.top;
        PDRAG.lifted = false;

        window.addEventListener('pointermove', sbPointerMove, { passive: false });
        window.addEventListener('pointerup', sbPointerUp);
        window.addEventListener('pointercancel', sbPointerCancel);

        // Not in arrange mode yet → press and hold to enter "jiggle" mode and
        // lift the app in the same motion, just like a phone home screen. (In
        // arrange mode a small drag lifts immediately — see sbPointerMove.)
        if (!STATE.editMode) {
          PDRAG.longPress = setTimeout(() => {
            PDRAG.longPress = null;
            if (PDRAG.pointerId === null) return;
            STATE.editMode = true;
            normalizeLayout(); persistLayout(); render();
            const fresh = sbFindCell(PDRAG.loc);    // the re-rendered node for this app
            if (!fresh) { PDRAG.dragEndedAt = Date.now(); sbEndGesture(false); return; }
            PDRAG.cell = fresh;
            const r = sbTileRect(fresh);            // keep the grab point under the finger
            PDRAG.offX = Math.min(Math.max(PDRAG.lastX - r.left, 8), r.width - 8);
            PDRAG.offY = Math.min(Math.max(PDRAG.lastY - r.top, 8), r.height - 8);
            sbLift();
            sbUpdateIntent(PDRAG.lastX, PDRAG.lastY);
          }, 430);
        }
      }

      function sbLift() {
        const cell = PDRAG.cell;
        if (!cell || PDRAG.lifted) return;
        PDRAG.lifted = true;
        if (PDRAG.longPress) { clearTimeout(PDRAG.longPress); PDRAG.longPress = null; }
        const tile = cell.querySelector('.sb-tile, .sb-folder');
        const label = cell.querySelector('.sb-label');
        const r = sbTileRect(cell);
        const ghost = document.createElement('div');
        ghost.className = 'sb-ghost';
        ghost.style.width = r.width + 'px';
        if (tile) { const c = tile.cloneNode(true); c.style.width = r.width + 'px'; c.style.height = r.height + 'px'; ghost.appendChild(c); }
        if (label) ghost.appendChild(label.cloneNode(true));
        document.body.appendChild(ghost);
        PDRAG.ghost = ghost;
        cell.classList.add('dragging');
        sbMoveGhost(PDRAG.lastX, PDRAG.lastY);
      }

      function sbMoveGhost(x, y) {
        if (!PDRAG.ghost) return;
        const gx = x - PDRAG.offX * PDRAG_SCALE;
        const gy = y - PDRAG.offY * PDRAG_SCALE;
        PDRAG.ghost.style.transform = 'translate(' + gx + 'px,' + gy + 'px) scale(' + PDRAG_SCALE + ')';
      }

      function sbPointerMove(e) {
        if (e.pointerId !== PDRAG.pointerId) return;
        PDRAG.lastX = e.clientX; PDRAG.lastY = e.clientY;
        if (!PDRAG.lifted) {
          const dist = Math.hypot(e.clientX - PDRAG.startX, e.clientY - PDRAG.startY);
          if (!STATE.editMode) {
            // Moved before the hold completed → it's a scroll/swipe, not a lift.
            if (dist > 10) sbEndGesture(false);
            return;
          }
          if (dist > 6) sbLift();
          if (!PDRAG.lifted) return;
        }
        e.preventDefault();
        sbMoveGhost(e.clientX, e.clientY);
        sbUpdateIntent(e.clientX, e.clientY);
      }

      // Work out where a release right now would land the app, and light up the
      // matching drop indicator. Mirrors the old onDragOver, but coordinate-driven.
      function sbUpdateIntent(x, y) {
        handleEdgeFlip(x);
        if (PDRAG.ghost) PDRAG.ghost.style.visibility = 'hidden';   // so it isn't the hit-test result
        const el = document.elementFromPoint(x, y);
        if (PDRAG.ghost) PDRAG.ghost.style.visibility = '';
        clearDropMarkers();
        DRAG.from = PDRAG.loc; DRAG.intent = null;
        if (!el) return;

        // Hovering a page dot flips to that page so you can carry across pages.
        const dot = el.closest('[data-dot]');
        if (dot) { const i = +dot.getAttribute('data-dot'); if (i !== STATE.currentPage) gotoPage(i); return; }

        const sourceIsApp = PDRAG.sourceIsApp;

        // ----- inside an open folder -----
        if (STATE.openFolderId) {
          const folderApps = el.closest('[data-folder-apps]');
          if (folderApps) {
            const fappCell = el.closest('[data-sb="fapp"]');
            const fid = folderApps.getAttribute('data-folder-apps');
            if (fappCell && fappCell !== PDRAG.cell) {
              const r = fappCell.getBoundingClientRect();
              const after = (x - r.left) > r.width / 2;
              DRAG.intent = { kind: 'folder', fid, pos: after ? 'after' : 'before', index: +fappCell.getAttribute('data-index') };
              fappCell.classList.add(after ? 'drop-after' : 'drop-before');
            } else if (!fappCell) {
              DRAG.intent = { kind: 'folder', fid, pos: 'append' };
              folderApps.classList.add('drop-page');
            }
            return;
          }
          // Dragged outside the folder grid → pull the app back out onto the page.
          if (PDRAG.loc.kind === 'folder') {
            DRAG.intent = { kind: 'popOut' };
            const panel = document.querySelector('.sb-folder-panel');
            if (panel) panel.classList.add('pop-out');
          }
          return;
        }

        // ----- on the springboard (free grid placement) -----
        const cell = el.closest('[data-sb="app"],[data-sb="folder"],[data-sb="empty"]');
        if (cell === PDRAG.cell) return;          // hovering our own origin → no-op
        if (cell) {
          const sb = cell.getAttribute('data-sb');
          const page = +cell.getAttribute('data-page');
          const index = +cell.getAttribute('data-index');
          if (sb === 'empty') {
            // Drop straight into this open slot — apps stay exactly where placed.
            DRAG.intent = { kind: 'placeSlot', page, index };
            cell.classList.add('drop-slot');
            return;
          }
          const r = cell.getBoundingClientRect();
          const fx = (x - r.left) / r.width;
          if (sb === 'folder' && sourceIsApp && fx > 0.2 && fx < 0.8) {
            DRAG.intent = { kind: 'intoFolder', fid: cell.getAttribute('data-fid') };
            cell.classList.add('drop-folder');
          } else if (sb === 'app' && sourceIsApp && fx > 0.25 && fx < 0.75) {
            DRAG.intent = { kind: 'combine', page, index };
            cell.classList.add('drop-folder');
          } else {
            // Onto an occupied slot's edge → swap the two so the carried app can
            // take any spot, even one that's already filled.
            DRAG.intent = { kind: 'swap', page, index };
            cell.classList.add('drop-swap');
          }
          return;
        }
        // Padding / area below the grid → drop into the first open slot on the
        // page under the pointer (or the one being viewed).
        const pageEl = el.closest('[data-sb-page]');
        const pageIdx = pageEl ? +pageEl.getAttribute('data-sb-page')
                       : (el.closest('.sb-viewport') ? STATE.currentPage : -1);
        if (pageIdx >= 0) {
          const p = pageArr(pageIdx);
          const s = p ? firstEmptySlot(p) : -1;
          if (s !== -1) {
            DRAG.intent = { kind: 'placeSlot', page: pageIdx, index: s };
            const pe = document.querySelector('.sb-page[data-sb-page="' + pageIdx + '"]');
            if (pe) pe.classList.add('drop-page');
          }
        }
      }

      // Apply the pending intent to the layout. Returns true if anything moved.
      function sbCommit() {
        if (!DRAG.intent) return false;
        if (DRAG.intent.kind === 'popOut') {
          const src = getSourceRef(PDRAG.loc);
          if (src.item && src.arr) {
            src.arr.splice(src.arr.indexOf(src.item), 1);
            const cell = { type: 'app', id: src.item.id };
            const page = pageArr(STATE.currentPage);
            const s = page ? firstEmptySlot(page) : -1;
            if (s !== -1) page[s] = cell; else placeInFirstEmpty(cell);
          }
          STATE.openFolderId = null;
        } else {
          applyDrag(DRAG.from, DRAG.intent);
        }
        return true;
      }

      // Settle the floating clone in place, then drop it from the DOM.
      function sbFinishGhost() {
        const g = PDRAG.ghost; PDRAG.ghost = null;
        if (!g) return;
        const cur = g.style.transform || '';
        g.style.transition = 'transform .16s cubic-bezier(.16,1,.3,1), opacity .16s ease';
        g.style.transform = cur.replace(/scale\([^)]*\)/, 'scale(1)');
        g.style.opacity = '0';
        setTimeout(() => { try { g.remove(); } catch {} }, 200);
      }

      function sbPointerUp(e) {
        if (e.pointerId !== PDRAG.pointerId) return;
        if (!PDRAG.lifted) { sbEndGesture(false); return; }    // a tap/short hold, not a drag
        const changed = sbCommit();
        PDRAG.dragEndedAt = Date.now();                         // swallow the trailing click
        if (PDRAG.cell) PDRAG.cell.classList.remove('dragging');
        clearDropMarkers(); clearEdgeFlip();
        if (changed) { normalizeLayout(); persistLayout(); render(); }
        sbFinishGhost();
        sbEndGesture(true);
      }

      function sbPointerCancel(e) {
        if (e.pointerId !== PDRAG.pointerId) return;
        sbFinishGhost();
        sbEndGesture(true);
      }

      function sbEndGesture(keepGhost) {
        window.removeEventListener('pointermove', sbPointerMove);
        window.removeEventListener('pointerup', sbPointerUp);
        window.removeEventListener('pointercancel', sbPointerCancel);
        if (PDRAG.longPress) { clearTimeout(PDRAG.longPress); PDRAG.longPress = null; }
        if (!keepGhost && PDRAG.ghost) { try { PDRAG.ghost.remove(); } catch {} PDRAG.ghost = null; }
        if (PDRAG.cell) PDRAG.cell.classList.remove('dragging');
        clearDropMarkers(); clearEdgeFlip();
        PDRAG.pointerId = null; PDRAG.cell = null; PDRAG.loc = null; PDRAG.lifted = false; PDRAG.sourceIsApp = false;
        DRAG.from = null; DRAG.intent = null;
      }

      function getSourceRef(from) {
        if (from.kind === 'page') { const arr = STATE.layout.pages[from.page]; return { arr, item: arr && arr[from.index] }; }
        const folder = findFolderById(from.fid);
        return folder ? { arr: folder.items, item: folder.items[from.index] } : { arr: null, item: null };
      }
      // Detach the dragged cell from where it came from. A page is a fixed grid,
      // so clear the slot (keep the gap); a folder is a packed list, so splice.
      function removeFromSource(from, src) {
        if (from.kind === 'page') src.arr[from.index] = null;
        else src.arr.splice(src.arr.indexOf(src.item), 1);
      }

      function applyDrag(from, intent) {
        const src = getSourceRef(from);
        const item = src.item;
        if (!item || !src.arr) return;

        // ----- reordering inside an open folder (folders stay packed) -----
        if (intent.kind === 'folder') {
          const f = findFolderById(intent.fid);
          if (!f) return;
          const targetArr = f.items;
          const refItem = intent.pos !== 'append' ? targetArr[intent.index] : null;
          if (refItem === item) return;
          removeFromSource(from, src);
          if (intent.pos === 'append') targetArr.push(asApp(item));
          else { let ti = targetArr.indexOf(refItem); if (ti < 0) ti = targetArr.length; targetArr.splice(intent.pos === 'after' ? ti + 1 : ti, 0, asApp(item)); }
          return;
        }

        // ----- free placement on a page grid -----
        if (intent.kind === 'placeSlot') {
          const targetArr = pageArr(intent.page);
          if (!targetArr) return;
          if (targetArr[intent.index] && targetArr[intent.index] !== item) return; // slot taken
          removeFromSource(from, src);
          targetArr[intent.index] = item;
          return;
        }
        if (intent.kind === 'swap') {
          const targetArr = pageArr(intent.page);
          if (!targetArr) return;
          const targetItem = targetArr[intent.index];
          if (!targetItem || targetItem === item) return;
          if (from.kind === 'page') {              // swap two slots (across pages too)
            src.arr[from.index] = targetItem;
            targetArr[intent.index] = item;
          } else {                                 // from a folder: take the slot, re-home the bumped app
            removeFromSource(from, src);
            targetArr[intent.index] = item;
            placeInFirstEmpty(targetItem);
          }
          return;
        }
        if (intent.kind === 'combine') {
          const targetArr = pageArr(intent.page);
          if (!targetArr) return;
          const refItem = targetArr[intent.index];
          if (!refItem || refItem === item || refItem.type !== 'app') return;
          removeFromSource(from, src);
          targetArr[intent.index] = makeFolder(refItem, item);
          return;
        }
        if (intent.kind === 'intoFolder') {
          const folder = findFolderById(intent.fid);
          if (!folder) return;
          removeFromSource(from, src);
          folder.items.push(asApp(item));
          return;
        }
      }

      window.addEventListener('beforeunload', () => { persistBookmarks(); persistSettings(); });

      /* ================================================================
       * Global shortcut — toggles voice listening (default Ctrl + R)
       * Starts OR stops hands-free listening from anywhere (any screen, even
       * with focus in a text field) without reaching for the mouse, so the
       * user can flip listening on and off between screens with one combo. The
       * combo is user-configurable in Settings. A keydown is a user gesture, so
       * the microphone prompt is allowed exactly as it is from the on-screen
       * button. Registered once so it survives re-renders.
       * ================================================================ */
      function matchesListenShortcut(e) {
        const sc = STATE.settings && STATE.settings.shortcut;
        if (!sc) return false;
        // Match the physical key by code so non-QWERTY layouts still work, with
        // a key-value fallback. Every modifier must match exactly so e.g. Ctrl+R
        // doesn't also fire on Ctrl+Shift+R.
        const keyOk = (sc.code && e.code === sc.code) ||
                      (sc.key && typeof e.key === 'string' && e.key.toLowerCase() === sc.key.toLowerCase());
        return !!keyOk && e.ctrlKey === !!sc.ctrl && e.altKey === !!sc.alt &&
               e.shiftKey === !!sc.shift && e.metaKey === !!sc.meta;
      }
      window.addEventListener('keydown', (e) => {
        if (!matchesListenShortcut(e)) return;
        e.preventDefault();
        if (e.repeat) return; // ignore auto-repeat while the keys are held down
        if (!VOICE.srSupported) { showToast('Voice needs Chrome or Edge', 'mic-off'); return; }
        // Toggle: the same combo turns listening on when off and off when on,
        // so the user can switch it between screens without the mouse.
        if (VOICE.listenOn) stopListening();
        else startListening();
      });

      // Settings shortcut recorder — capture the next combo the user presses and
      // store it as the launch shortcut. Runs in the capture phase so it preempts
      // the listen/arrow shortcuts and the browser's own default for the chosen
      // combo (e.g. Ctrl+R reload) while recording.
      window.addEventListener('keydown', (e) => {
        if (!STATE.recordingShortcut) return;
        // Wait for a "real" key — ignore a lone modifier press.
        if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape') { STATE.recordingShortcut = false; render(); return; }
        if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
          showToast('Hold Ctrl, Alt, or Shift with a key', 'keyboard');
          return; // keep recording until a valid combo is pressed
        }
        STATE.settings.shortcut = {
          ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey,
          code: e.code || '', key: (typeof e.key === 'string' ? e.key.toLowerCase() : '')
        };
        STATE.recordingShortcut = false;
        persistSettings();
        showToast('Shortcut set to ' + shortcutLabel(), 'keyboard');
        render();
      }, true);
      // Clicking anywhere but the recorder (or leaving the window) cancels
      // recording, so a stray click can't capture the user's next keystroke.
      window.addEventListener('click', (e) => {
        if (!STATE.recordingShortcut) return;
        if (e.target.closest && e.target.closest('[data-action="record-shortcut"]')) return;
        STATE.recordingShortcut = false;
        requestAnimationFrame(render);
      }, true);
      window.addEventListener('blur', () => {
        if (STATE.recordingShortcut) { STATE.recordingShortcut = false; render(); }
      });

      // Arrow keys page through the springboard (when on the Bookmarks screen
      // and not typing or inside a dialog) — the keyboard counterpart to the
      // on-screen arrows and touch swipe.
      window.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        if (STATE.view !== 'home' || STATE.adding || STATE.openFolderId || STATE.homeSearch.trim()) return;
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
        if (STATE.layout.pages.length < 2) return;
        gotoPage(STATE.currentPage + (e.key === 'ArrowRight' ? 1 : -1));
      });

      // Some browsers populate speechSynthesis voices asynchronously.
      if (VOICE.ttsSupported) { try { window.speechSynthesis.getVoices(); window.speechSynthesis.onvoiceschanged = () => {}; } catch {} }

      /* ================================================================
       * Init
       * ================================================================ */
      /* Boot: show the local mirror instantly, then reconcile with the sheet —
         pushing any changes queued while offline up first, so the fetch
         reflects them. Falls back to local data when the sheet is unreachable. */
      async function bootstrap() {
        loadData();
        loadLayout();
        syncLayout();
        persistLayout();
        render();
        if (!sheetEnabled()) return;
        rebuildSnapshot();
        SHEET.ready = true;   // snapshot baselined — saves may push from here on
        try { await flushOutbox(); } catch {}
        await syncFromSheet();
      }
      bootstrap();

      // Resync the queue when the network returns, plus a slow safety-net poll.
      window.addEventListener('online', () => flushOutbox());
      setInterval(() => { if (sheetEnabled() && loadOutbox().length) flushOutbox(); }, 30000);

      // Keep the "Recent" timestamps fresh without a heavy re-render.
      setInterval(() => {
        if (STATE.editingId) return;
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
        document.querySelectorAll('.recent-time').forEach((node, i) => {
          const a = VOICE.recentActions[i]; if (a) node.textContent = relTime(a.at);
        });
      }, 30000);
