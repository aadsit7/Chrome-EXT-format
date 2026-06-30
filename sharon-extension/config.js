// config.js — single source of truth for Sharon's backend.
//
// Sharon never contains the AI provider key. She POSTs an action envelope to
// this Google Apps Script web app ("Speaking_Assistant"), which checks the
// shared API_KEY, adds the secret ANTHROPIC_API_KEY, calls the model, and
// reads/writes the conversation_turns and memory_log tables for her.
//
// ┌─ YOU MUST PASTE THESE TWO IN ───────────────────────────────────────────┐
// │ PROXY_URL  — your NEW Apps Script Web App /exec URL.                     │
// │ API_KEY    — must MATCH the Script Property named API_KEY in that        │
// │              Apps Script project.                                        │
// └─────────────────────────────────────────────────────────────────────────┘
export const PROXY_URL = "<MY NEW APPS SCRIPT /exec URL>";
export const API_KEY = "<MUST MATCH the Script Property API_KEY>";

// Real rows in the Sheet, so Sharon's memory recall matches your data.
// Sent on EVERY backend call. If blank, memory recall won't match.
export const USER_ID = "usr_aaron"; // row in the "users" tab
export const ASSISTANT_ID = "asst_sharon"; // row in the "assistants" tab (this is Sharon)

// Cap the amount of page text we send so requests stay reasonable.
export const MAX_PAGE_TEXT = 45000;
