// api.js — Sharon's transport to the Speaking_Assistant backend.
//
// One rule everywhere: POST text/plain (Apps Script web apps can't answer a
// CORS preflight, so we never send application/json or extra headers), with
// the { api_key, action, payload } envelope. Success data lives in
// data.result; failures come back as { ok:false, error }.

import {
  PROXY_URL,
  API_KEY,
  USER_ID,
  ASSISTANT_ID,
  EXTENSION_VERSION,
} from "./config.js";

async function call(action, payload, signal) {
  const body = { api_key: API_KEY, action, payload };
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(body),
    signal,
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error("Sharon got an unexpected reply from the server. Please try again.");
  }
  if (!data || data.ok !== true) {
    const message = (data && data.error) || "something went wrong on the server.";
    // "unknown action: assist" from a working server means the deployed
    // Apps Script is an older version that predates that action — the URL
    // and key are fine, the DEPLOYMENT is stale. Flag it so the UI can give
    // redeploy instructions instead of misdiagnosing the connection.
    if (/^unknown action\b/i.test(message)) {
      const err = new Error(
        "your Google Apps Script backend is running an older version that doesn't know “" +
          action +
          "” yet."
      );
      err.backendOutdated = true;
      throw err;
    }
    throw new Error(message);
  }
  return data.result;
}

/**
 * The brain. One round trip: Claude answers, and/or reads-writes the Sheet
 * through tools, and/or returns an on-page action plan.
 *
 * Returns { reply, plan, events, model }:
 *   reply  — what Sharon says (always present)
 *   plan   — { say, actions[], done } when she wants to act on the page
 *   events — [{ tool, ok, data:{kind,...} }] for rendering result cards
 */
export function assist(
  {
    sessionId,
    userText,
    history = [],
    page = null,
    agent = null,
    asrConfidence = null,
    transcriptRaw = "",
    clientMsgId = "",
    logTurns = true,
  },
  signal
) {
  return call(
    "assist",
    {
      session_id: sessionId,
      user_id: USER_ID,
      assistant_id: ASSISTANT_ID,
      user_text: userText,
      history,
      page: page || {},
      agent: agent || null,
      asr_confidence: asrConfidence,
      transcript_raw: transcriptRaw,
      client_msg_id: clientMsgId,
      extension_version: EXTENSION_VERSION,
      log: logTurns,
    },
    signal
  );
}

/** Search the memory_log (Notes sheet + quick lookups). Returns an array. */
export function searchMemory({ query = "", entryType = "", limit = 20, touch = false }) {
  return call("search_memory", {
    query,
    entry_type: entryType,
    limit,
    touch,
    user_id: USER_ID,
    assistant_id: ASSISTANT_ID,
  });
}

/**
 * Save one note straight from the panel (the Notes view's editor and its
 * paste-to-save box). The backend writes it through the SAME internal path
 * and columns the AI's save_memory tool uses, and returns the created entry
 * (entry_id included) so the list can update in place. An older deployment
 * answers "unknown action: save_memory", which call() flags as
 * backendOutdated so the UI can say "redeploy Code.gs".
 */
export function saveMemory({ title, content, entryType = "note" }) {
  return call("save_memory", {
    title: title || "",
    content: content || "",
    entry_type: entryType,
    user_id: USER_ID,
    assistant_id: ASSISTANT_ID,
  });
}

/** Patch one memory entry (mark a task done, edit, or delete). */
export function updateMemory({ entryId, status, title, content, deleted }) {
  return call("update_memory", {
    entry_id: entryId,
    status,
    title,
    content,
    deleted,
  });
}

/**
 * Patch many memory entries in ONE round trip (bulk mark done / reopen /
 * soft-delete, and the batch undo, which re-sends with deleted:false).
 * updates: [{ entryId, status?, deleted? }, ...]
 * Returns { results: [{ entry_id, ok, error? }], updated, skipped } so the
 * panel can report "8 updated, 2 skipped" and roll back only the failures.
 */
export function batchUpdateMemory(updates) {
  return call("batch_update_memory", {
    updates: (Array.isArray(updates) ? updates : []).map((u) => ({
      entry_id: u.entryId,
      status: u.status,
      deleted: u.deleted,
    })),
  });
}

/** Recent turns for this session so a reopened panel remembers the thread. */
export function getRecentTurns(sessionId, limit = 12) {
  return call("get_recent_turns", { session_id: sessionId, limit });
}

/**
 * Upload a finished voice recording. The backend saves the audio to Drive,
 * appends a row to the recordings tab (transcript + timestamped segments),
 * distills the transcript into memory notes (each linking the audio), and
 * returns { recording_id, drive_file_url, notes }.
 * segments is [{ t: seconds, text }] — one entry per finalized recognition
 * segment, so search can later queue playback to the matching moment.
 * Deliberately no abort signal: a 30-minute file is roughly 7–15 MB and the
 * upload must never be killed mid-flight by a timeout.
 */
export function saveRecording({
  sessionId,
  audioBase64,
  mimeType,
  durationSeconds,
  transcript,
  segments,
  timestamp,
}) {
  return call("save_recording", {
    session_id: sessionId,
    user_id: USER_ID,
    assistant_id: ASSISTANT_ID,
    audio_base64: audioBase64,
    mime_type: mimeType,
    duration_seconds: durationSeconds,
    transcript: transcript,
    segments: Array.isArray(segments) ? segments : [],
    timestamp: timestamp,
  });
}

/**
 * List every saved voice recording, newest first — the browse-all list
 * behind the memory view's "Recordings" filter and the "show my recordings"
 * voice request. Each entry comes back in the same shape a recording search
 * hit uses (entry_id "rec:<id>", entry_type "recording", the Drive audio as
 * page_url), so the panel plays any of them in place. Returns an array.
 */
export function listRecordings({ limit = 50 } = {}) {
  return call("list_recordings", {
    limit,
    user_id: USER_ID,
    assistant_id: ASSISTANT_ID,
  });
}

/**
 * Fetch a saved recording's audio so it can play right inside the panel.
 * The Drive file's sharing settings are never touched — the bytes flow
 * through the backend, so recordings stay private.
 * Returns { audio_base64, mime_type, duration_seconds, drive_file_url },
 * or { too_large: true, drive_file_url } when the file is past the
 * backend's size cap (the panel then falls back to opening Drive).
 * Deliberately no abort signal: a long file takes a moment to come down
 * and must never be killed mid-flight by a timeout.
 */
export function getRecordingAudio(recordingId) {
  return call("get_recording_audio", { recording_id: recordingId });
}
