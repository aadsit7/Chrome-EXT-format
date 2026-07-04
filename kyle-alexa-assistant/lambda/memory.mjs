/**
 * Kyle's persistent memory — per-person conversation history, long-term notes,
 * and a global daily Claude-call counter.
 *
 * Storage drivers, in priority order:
 *   1. Test store: `globalThis.__kyleMemoryStore` (a Map) — used by the local
 *      test harness for deterministic fixtures.
 *   2. DynamoDB: table named by MEMORY_TABLE (default "kyle-memory"),
 *      partition key `pk` (string). Uses the AWS SDK v3 bundled in the Lambda
 *      Node runtime — it is intentionally NOT a bundled dependency.
 *   3. Disabled: if the SDK is unavailable or the table doesn't exist, every
 *      operation degrades to a harmless no-op and Kyle behaves like the
 *      original session-only build. Memory must never break the conversation.
 */

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const MAX_STORED_MESSAGES = 20;
const MAX_NOTES = 25;

let ddb = null;            // cached document client
let ddbFailed = false;     // remembered failure → stop retrying imports

function tableName() {
  return process.env.MEMORY_TABLE || 'kyle-memory';
}

function testStore() {
  return globalThis.__kyleMemoryStore instanceof Map ? globalThis.__kyleMemoryStore : null;
}

async function getDdb() {
  if (testStore() || ddbFailed) return null;
  if (ddb) return ddb;
  try {
    const [{ DynamoDBClient }, { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand }] =
      await Promise.all([import('@aws-sdk/client-dynamodb'), import('@aws-sdk/lib-dynamodb')]);
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    ddb = { client, GetCommand, PutCommand, UpdateCommand, DeleteCommand };
    return ddb;
  } catch (err) {
    console.error('Kyle memory disabled (AWS SDK unavailable):', err.message);
    ddbFailed = true;
    return null;
  }
}

async function getItem(pk) {
  const store = testStore();
  if (store) return store.get(pk) ?? null;
  const d = await getDdb();
  if (!d) return null;
  try {
    const res = await d.client.send(new d.GetCommand({ TableName: tableName(), Key: { pk } }));
    return res.Item ?? null;
  } catch (err) {
    console.error(`Kyle memory read failed for ${pk}:`, err.message);
    return null;
  }
}

async function putItem(item) {
  const store = testStore();
  if (store) { store.set(item.pk, item); return true; }
  const d = await getDdb();
  if (!d) return false;
  try {
    await d.client.send(new d.PutCommand({ TableName: tableName(), Item: item }));
    return true;
  } catch (err) {
    console.error(`Kyle memory write failed for ${item.pk}:`, err.message);
    return false;
  }
}

export function isMemoryAvailable() {
  return Boolean(testStore()) || (!ddbFailed);
}

/** Load a person's memory: { history, notes, lastTurnAt } (empty defaults). */
export async function loadMemory(memoryId) {
  const item = await getItem(`user#${memoryId}`);
  return {
    history: Array.isArray(item?.history) ? item.history : [],
    notes: Array.isArray(item?.notes) ? item.notes : [],
    lastTurnAt: typeof item?.lastTurnAt === 'number' ? item.lastTurnAt : 0,
  };
}

/** True when the stored conversation is fresh enough to auto-resume. */
export function isRecent(lastTurnAt, now = Date.now()) {
  return lastTurnAt > 0 && now - lastTurnAt < TWO_HOURS_MS;
}

/** Persist the conversation after a turn (history capped, notes preserved). */
export async function saveConversation(memoryId, history, notes) {
  return putItem({
    pk: `user#${memoryId}`,
    history: (history ?? []).slice(-MAX_STORED_MESSAGES),
    notes: (notes ?? []).slice(-MAX_NOTES),
    lastTurnAt: Date.now(),
  });
}

/** Wipe the conversation only; long-term notes survive. */
export async function clearConversation(memoryId) {
  const existing = await loadMemory(memoryId);
  return putItem({ pk: `user#${memoryId}`, history: [], notes: existing.notes, lastTurnAt: 0 });
}

/** Wipe everything about this person — history AND notes. */
export async function clearAll(memoryId) {
  return putItem({ pk: `user#${memoryId}`, history: [], notes: [], lastTurnAt: 0 });
}

/**
 * Count one Claude-backed turn against today's global cap.
 * Returns { allowed, count, cap }. Fails OPEN: if storage is unavailable the
 * turn is allowed (a broken counter must not silence Kyle).
 */
export async function bumpDailyCalls() {
  const cap = Math.max(1, parseInt(process.env.DAILY_CALL_CAP ?? '300', 10) || 300);
  const today = new Date().toISOString().slice(0, 10);
  const pk = 'global#daily-calls';

  const item = await getItem(pk);
  const count = item?.date === today ? (item.count ?? 0) : 0;
  if (count >= cap) return { allowed: false, count, cap };

  const wrote = await putItem({ pk, date: today, count: count + 1 });
  return { allowed: true, count: wrote ? count + 1 : count, cap };
}

/** Read today's usage without incrementing (for diagnostics). */
export async function getDailyCalls() {
  const cap = Math.max(1, parseInt(process.env.DAILY_CALL_CAP ?? '300', 10) || 300);
  const today = new Date().toISOString().slice(0, 10);
  const item = await getItem('global#daily-calls');
  return { count: item?.date === today ? (item.count ?? 0) : 0, cap };
}
