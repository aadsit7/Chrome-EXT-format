// mode.js — Sharon's one mode manager. She is in exactly ONE mode at a time:
//
//   LISTENING  (default) — normal conversation: adaptive listening, barge-in,
//                          memory tools, agent tasks. Every mode ends here.
//   RECORDING  — the recorder owns the ears; command listening, TTS, assist
//                and page context are all off until the whole flow (record →
//                upload → organize) is done.
//   SCREEN     — one look at the current tab; the next message is answered
//                with that snapshot attached, then the mode ends itself.
//   SEARCHING  — automatic: lit while an assist call is out running a web
//                search, cleared when the reply arrives (or is interrupted).
//
// Exclusivity is enforced HERE, not by each feature: entering a mode always
// runs the previous mode's exit routine first, so no code path can leave
// Sharon in two modes at once. If an exit or enter routine throws, the
// manager lands in LISTENING with a clean status instead of a stuck mode.
//
// This module is logic-free about the modes themselves — the orchestrator
// (sidepanel.js) registers each mode's enter/exit routine and reads the
// current mode; features check the manager instead of scattered flags.

export const MODES = {
  LISTENING: "listening",
  RECORDING: "recording",
  SCREEN: "screen",
  SEARCHING: "searching",
};

const VALID = new Set(Object.values(MODES));

let current = MODES.LISTENING;
let routines = {}; // { [mode]: { enter?(prevMode), exit?(nextMode) } }
let notify = () => {};

export function initModes({ routines: r, onChange } = {}) {
  routines = r || {};
  notify = typeof onChange === "function" ? onChange : () => {};
}

export function currentMode() {
  return current;
}

export function inMode(m) {
  return current === m;
}

function run(mode, hook, arg) {
  const r = routines[mode];
  if (r && typeof r[hook] === "function") r[hook](arg);
}

// The one door between modes. Same-mode entries are no-ops (toggling a mode
// OFF is expressed as enterMode(LISTENING) by the caller).
export function enterMode(next) {
  if (!VALID.has(next)) next = MODES.LISTENING;
  if (next === current) return current;
  const prev = current;

  // The previous mode leaves first — exclusivity lives in this ordering.
  // A failing exit routine must never strand Sharon: fall back to LISTENING
  // (whose enter routine is the idempotent "make everything clean" path).
  let target = next;
  try {
    run(prev, "exit", target);
  } catch (_) {
    target = MODES.LISTENING;
  }
  current = target;

  try {
    run(target, "enter", prev);
  } catch (_) {
    if (target !== MODES.LISTENING) {
      current = MODES.LISTENING;
      try {
        run(MODES.LISTENING, "enter", target);
      } catch (_) {
        /* LISTENING's enter is defensive by design; nothing more to do */
      }
    }
  }

  notify(current, prev);
  return current;
}
