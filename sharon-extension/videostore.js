// videostore.js — the LOCAL library of screen recordings, in IndexedDB.
//
// Screen recordings still download to the user's computer exactly as they
// always have (chrome.downloads, see sidepanel.js). This module keeps a
// SECOND, extension-local copy so the Video tab can list and replay them in
// the panel. Nothing here ever leaves the browser: no backend call, no Drive,
// no Sheet — a video's bytes only ever move between IndexedDB and a <video>
// element in the side panel.
//
// Two object stores keep listing cheap:
//   meta  — { id, title, createdAt, durationSeconds, size, mime, thumb }
//            (thumb is a small JPEG data URL — a still frame from the clip)
//   blobs — { id, blob }  the video itself, only ever read on playback
//
// The store is capped at CAP_BYTES (2 GB) TOTAL. Nothing is ever silently
// dropped to make room: callers ask fits()/usage() BEFORE recording and warn
// the user, and a save that would overflow the cap is refused with a reason.

const DB_NAME = "sharon-videos";
const DB_VERSION = 1;
const META = "meta";
const BLOBS = "blobs";

// The local cap. Deliberately generous — the download to the computer is the
// real archive; this is the "play it here" copy.
export const CAP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) {
        const store = db.createObjectStore(META, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB wouldn't open."));
  }).catch((err) => {
    dbPromise = null; // a failed open must not poison every later call
    throw err;
  });
  return dbPromise;
}

function tx(db, names, mode) {
  const t = db.transaction(names, mode);
  return {
    t,
    done: new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onabort = () => reject(t.error || new Error("The video store transaction failed."));
      t.onerror = () => reject(t.error || new Error("The video store transaction failed."));
    }),
  };
}

function reqDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("The video store call failed."));
  });
}

function newId() {
  return (
    (crypto.randomUUID && crypto.randomUUID()) ||
    "vid-" + Math.random().toString(36).slice(2) + Date.now()
  );
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */
// Every saved recording's metadata, newest first. Blobs stay on disk.
export async function listVideos() {
  const db = await openDb();
  const { t } = tx(db, [META], "readonly");
  const all = await reqDone(t.objectStore(META).getAll());
  const list = Array.isArray(all) ? all : [];
  list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return list;
}

// { used, cap, free } in bytes — what the Video tab shows and what the
// pre-recording warning is built from.
export async function usage() {
  let used = 0;
  try {
    const list = await listVideos();
    for (const v of list) used += Number(v.size) || 0;
  } catch (_) {
    used = 0;
  }
  return { used, cap: CAP_BYTES, free: Math.max(0, CAP_BYTES - used) };
}

// Would a clip of roughly this size still fit? Called BEFORE recording with
// an estimate, so the user is warned instead of losing a local copy later.
export async function fits(estimatedBytes) {
  const { free } = await usage();
  return free >= Math.max(0, Number(estimatedBytes) || 0);
}

export async function getVideoBlob(id) {
  const db = await openDb();
  const { t } = tx(db, [BLOBS], "readonly");
  const row = await reqDone(t.objectStore(BLOBS).get(String(id)));
  return (row && row.blob) || null;
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */
// Save one recording. Refuses (with a reason) rather than evicting anything
// the user didn't ask us to delete.
// Returns { ok:true, meta } or { ok:false, reason:"full"|"error", … }.
export async function saveVideo({ blob, title, durationSeconds, thumb, createdAt } = {}) {
  if (!blob || !blob.size) return { ok: false, reason: "empty" };
  const { free, used } = await usage();
  if (blob.size > free) {
    return { ok: false, reason: "full", used, cap: CAP_BYTES, needed: blob.size };
  }
  const meta = {
    id: newId(),
    title: String(title || "Screen recording"),
    createdAt: createdAt || new Date().toISOString(),
    durationSeconds: Math.max(0, Math.round(Number(durationSeconds) || 0)),
    size: blob.size,
    mime: blob.type || "video/webm",
    thumb: thumb || "",
  };
  try {
    const db = await openDb();
    const { t, done } = tx(db, [META, BLOBS], "readwrite");
    t.objectStore(BLOBS).put({ id: meta.id, blob });
    t.objectStore(META).put(meta);
    await done;
  } catch (err) {
    return { ok: false, reason: "error", error: (err && err.message) || String(err) };
  }
  return { ok: true, meta };
}

// Delete the LOCAL copy only. The file already saved on the computer is a
// separate file and is never touched by this.
export async function deleteVideo(id) {
  const db = await openDb();
  const { t, done } = tx(db, [META, BLOBS], "readwrite");
  t.objectStore(META).delete(String(id));
  t.objectStore(BLOBS).delete(String(id));
  await done;
  return true;
}

/* ------------------------------------------------------------------ *
 * Probing a finished clip — one still frame for the thumbnail, plus its real
 * length when the caller doesn't already know it.
 * ------------------------------------------------------------------ */
const THUMB_W = 320;
const THUMB_QUALITY = 0.62;

// Decode the clip locally, grab a frame a little way in, and report
// { thumb, duration }. Best-effort throughout: any failure resolves with an
// empty thumb and the caller's duration hint, so a save is never blocked.
//
// The webm quirk the review card already deals with applies here too — a
// MediaRecorder .webm reports duration Infinity/NaN until it is seeked past
// the end, so that's forced first when the length isn't known.
export function probeClip(blob, durationHint) {
  const hint = Math.max(0, Number(durationHint) || 0);
  return new Promise((resolve) => {
    let url = "";
    let settled = false;
    let v = null;
    let found = hint;

    const finish = (thumb) => {
      if (settled) return;
      settled = true;
      if (v) {
        try {
          v.pause();
        } catch (_) {
          /* ignore */
        }
        try {
          v.removeAttribute("src");
          v.load();
        } catch (_) {
          /* ignore */
        }
        if (v.parentNode) v.parentNode.removeChild(v);
      }
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {
          /* ignore */
        }
      }
      resolve({ thumb: thumb || "", duration: found });
    };

    try {
      url = URL.createObjectURL(blob);
      v = document.createElement("video");
      v.className = "srv-offscreen"; // off-screen but rendered, so it decodes
      v.src = url;
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      document.body.appendChild(v);
    } catch (_) {
      finish("");
      return;
    }

    // Never hang the save flow on a stubborn decode.
    const bail = setTimeout(() => finish(""), 10000);

    const draw = () => {
      clearTimeout(bail);
      try {
        const w = v.videoWidth || 0;
        const h = v.videoHeight || 0;
        if (!w || !h) {
          finish("");
          return;
        }
        const cw = Math.min(THUMB_W, w);
        const canvas = document.createElement("canvas");
        canvas.width = cw;
        canvas.height = Math.max(1, Math.round((h / w) * cw));
        canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL("image/jpeg", THUMB_QUALITY));
      } catch (_) {
        finish("");
      }
    };

    // Seek to the frame we want, then draw it.
    const grabFrame = () => {
      const at = found > 1 ? 0.4 : Math.max(0, found / 2);
      v.addEventListener("seeked", draw, { once: true });
      try {
        v.currentTime = at;
      } catch (_) {
        draw(); // seeking refused — the first frame will do
      }
    };

    v.addEventListener("error", () => finish(""), { once: true });
    v.addEventListener(
      "loadedmetadata",
      () => {
        if (isFinite(v.duration) && v.duration > 0) {
          found = v.duration;
          grabFrame();
          return;
        }
        if (found > 0) {
          grabFrame(); // the caller knew the length; don't chase the metadata
          return;
        }
        // Force a real duration out of the webm, then take the frame.
        const onDur = () => {
          if (!isFinite(v.duration) || v.duration <= 0) return;
          v.removeEventListener("durationchange", onDur);
          found = v.duration;
          grabFrame();
        };
        v.addEventListener("durationchange", onDur);
        try {
          v.currentTime = 1e7;
        } catch (_) {
          grabFrame();
        }
      },
      { once: true }
    );
  });
}

/* ------------------------------------------------------------------ *
 * Formatting helpers shared by the Video tab and the Library filter
 * ------------------------------------------------------------------ */
export function fmtBytes(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

export function fmtLength(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  return m + ":" + String(s % 60).padStart(2, "0");
}
