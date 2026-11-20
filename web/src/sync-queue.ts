import { replayMutations, type OfflineMutation } from "./offline-mutations";
import { RequestError, type State } from "./types";

export const queueKey = "mingzhang.offline-mutations.v1";
export const blockedKey = "mingzhang.offline-mutations.blocked.v1";
const snapshotKey = "mingzhang.sync-snapshot.v1";
const legacyStateKey = "mingzhang.local-state.v1";
const legacyPrefix = "mingzhang.pending-entry.v1.";

type Rejection = { status: number; message: string; at: number };
type BlockedMutation = OfflineMutation & { blocked: Rejection };
type NewMutation = Omit<OfflineMutation, "id" | "createdAt">;
type QueueAction =
  | { kind: "retry" | "discard"; target: BlockedMutation }
  | { kind: "edit"; target: BlockedMutation; change: Pick<OfflineMutation, "type" | "path" | "method" | "body"> };
type SnapshotCache = { snapshot: State; accepted: OfflineMutation[] };
type FlushResult = "idle" | "synced" | "blocked" | "retryable" | "unauthorized" | "changed";

export function createQueueLock(locks?: LockManager) {
  const local = new Map<string, Promise<unknown>>();
  return async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
    if (locks) return locks.request(name, () => Promise.resolve(run()));
    // Serialize this tab; receipts deduplicate replays from other tabs.
    const next = (local.get(name) ?? Promise.resolve()).then(run);
    local.set(name, next.catch(() => undefined));
    return next;
  };
}

export function isQueueStorageKey(key: string | null) {
  return key === null || [queueKey, blockedKey, snapshotKey, legacyStateKey].includes(key) || key.startsWith(legacyPrefix);
}

export function createSyncQueue({
  storage, lock, send, fetchSnapshot,
}: {
  storage: Storage;
  lock: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  send: (item: OfflineMutation) => Promise<unknown>;
  fetchSnapshot: () => Promise<State>;
}) {
  let cache: SnapshotCache | null = null;
  let cachedRaw: string | null = null;
  let unsaved: OfflineMutation[] = [];
  let unsavedRejection: { id: string; value: Rejection } | null = null;
  let storageError = false;

  function parse(raw: string | null) {
    try { return JSON.parse(raw || "null"); }
    catch { return null; }
  }

  function readQueue() {
    const stored = parse(storage.getItem(queueKey));
    const pending: OfflineMutation[] = Array.isArray(stored) ? stored.filter(item => item?.id && item?.path && item?.type) : [];
    const ids = new Set(pending.map(item => item.id));
    const legacyKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(legacyPrefix)) continue;
      const value = parse(storage.getItem(key));
      const entry = value?.entry ?? value;
      if (!entry?.id) continue;
      legacyKeys.push(key);
      if (ids.has(entry.id)) continue;
      ids.add(entry.id);
      pending.push({ id: entry.id, type: "entry.create", path: "/entries", method: "POST", body: entry,
        createdAt: Number.isFinite(value?.queued_at) ? value.queued_at : 0 });
    }
    pending.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return { pending, legacyKeys };
  }

  function writePriority(key: string, value: unknown) {
    const json = JSON.stringify(value);
    try {
      storage.setItem(key, json);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "QuotaExceededError") throw error;
      readCache();
      storage.removeItem(snapshotKey);
      storage.removeItem(legacyStateKey);
      cachedRaw = null;
      storage.setItem(key, json);
    }
  }

  function writeQueue(data: ReturnType<typeof readQueue>, pending: OfflineMutation[]) {
    try {
      writePriority(queueKey, pending);
    } catch {
      storageError = true;
      throw new Error("本机存储写入失败，请释放空间后重试。");
    }
    for (const key of data.legacyKeys) storage.removeItem(key);
  }

  function readCache() {
    const raw = storage.getItem(snapshotKey);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      // A quota eviction can remove the shared cache while this tab still has a usable snapshot.
      if (raw !== null) cache = parse(raw);
    }
    return cache;
  }

  function writeCache(value: SnapshotCache) {
    cache = value;
    try {
      const raw = JSON.stringify(value);
      storage.setItem(snapshotKey, raw);
      cachedRaw = raw;
    } catch {
      storage.removeItem(snapshotKey);
      cachedRaw = null;
    }
  }

  function readBlocked(item?: OfflineMutation): BlockedMutation | null {
    if (!item) return null;
    const value = unsavedRejection?.id === item.id ? unsavedRejection.value :
      parse(storage.getItem(blockedKey))?.[item.id];
    return value && Number.isInteger(value.status) && value.status >= 400 && value.status < 500 &&
      typeof value.message === "string" && Number.isFinite(value.at) ? { ...item, blocked: value } : null;
  }

  function persistRejection(id: string, value: Rejection) {
    try {
      const stored = parse(storage.getItem(blockedKey));
      const rejections = Object.fromEntries(readQueue().pending
        .filter(item => stored?.[item.id])
        .map(item => [item.id, stored[item.id]]));
      writePriority(blockedKey, { ...rejections, [id]: value });
      unsavedRejection = null;
    } catch {
      storageError = true;
      unsavedRejection = { id, value };
    }
  }

  function clearRejection(id: string) {
    if (unsavedRejection?.id === id) unsavedRejection = null;
    const stored = parse(storage.getItem(blockedKey));
    if (stored?.[id]) {
      delete stored[id];
      try {
        if (Object.keys(stored).length) storage.setItem(blockedKey, JSON.stringify(stored));
        else storage.removeItem(blockedKey);
      } catch {
        // A stale rejection is ignored once its mutation leaves the queue.
      }
    }
  }

  function view() {
    const { pending } = readQueue();
    const blocked = readBlocked(pending[0]);
    const items = [...pending, ...unsaved];
    const saved = readCache();
    if (saved) {
      const base = replayMutations(saved.snapshot, saved.accepted);
      return { count: items.length, blocked, state: replayMutations(base, items), beforeBlocked: blocked ? base : null, storageError };
    }
    // The old snapshot can already contain queued changes. It is only a display fallback.
    const cached = parse(storage.getItem(legacyStateKey));
    const state = cached?.state ?? cached;
    const applied = new Set<string>(Array.isArray(cached?.applied) ? cached.applied : []);
    const base: State | null = state?.account_groups ? state : null;
    return { count: items.length, blocked, state: base ? replayMutations(base, items.filter(item => !applied.has(item.id))) : null,
      beforeBlocked: blocked && !applied.has(blocked.id) ? base : null, storageError };
  }

  async function refreshSnapshot() {
    const snapshot = await fetchSnapshot();
    writeCache({ snapshot, accepted: [] });
    return snapshot;
  }

  function replaceHead(expected: OfflineMutation, replacement?: OfflineMutation) {
    const data = readQueue();
    if (data.pending[0]?.id !== expected.id) return false;
    const tail = data.pending.slice(1);
    writeQueue(data, replacement ? [replacement, ...tail] : tail);
    clearRejection(expected.id);
    return true;
  }

  async function flush(action?: QueueAction, onAction = () => {}): Promise<FlushResult> {
    return lock(queueKey + ".sync", async () => {
      let head = readQueue().pending[0];
      const blocked = readBlocked(head);
      if (action && (action.target.id !== head?.id || !blocked)) return "changed";
      if (!action && (blocked || storageError)) return "idle";

      if (head && !readCache()) {
        try {
          await refreshSnapshot();
        } catch (error) {
          if (!(error instanceof RequestError) || error.kind === "rejected") throw error;
          return error.kind === "unauthorized" ? "unauthorized" : "retryable";
        }
        if (readQueue().pending[0]?.id !== head.id) return "changed";
      }

      if (action?.kind === "edit" || action?.kind === "discard") {
        // A replacement gets a new receipt and an empty rejection history.
        const replacement = action.kind === "edit"
          ? { ...action.change, id: crypto.randomUUID(), createdAt: head.createdAt }
          : undefined;
        if (!await lock(queueKey, () => replaceHead(head, replacement))) return "changed";
        head = readQueue().pending[0];
        action = undefined;
        onAction();
      }

      let synced = false;
      while (head && (!readBlocked(head) || action?.kind === "retry")) {
        const item = head;
        try {
          await send(item);
        } catch (error) {
          if (!(error instanceof RequestError)) throw error;
          if (error.kind === "unauthorized") return "unauthorized";
          if (error.kind !== "rejected") return "retryable";
          return lock(queueKey, () => {
            if (readQueue().pending[0]?.id !== item.id) return "changed";
            persistRejection(item.id, { status: error.status!, message: error.message, at: Date.now() });
            return "blocked";
          });
        }
        const removed = await lock(queueKey, () => {
          if (!replaceHead(item)) return false;
          const base = readCache();
          if (base) writeCache({ ...base, accepted: [...base.accepted, item] });
          return true;
        });
        if (!removed) return "changed";
        head = readQueue().pending[0];
        synced = true;
        action = undefined;
      }
      return synced ? "synced" : "idle";
    });
  }

  function saveUnsaved() {
    if (!unsaved.length) return;
    const data = readQueue();
    writeQueue(data, [...data.pending, ...unsaved]);
    unsaved = [];
    if (!unsavedRejection) storageError = false;
  }

  return {
    view,
    hasReadyHead: () => {
      const head = readQueue().pending[0];
      return Boolean(!storageError && head && !readBlocked(head));
    },
    blocked: () => readBlocked(readQueue().pending[0]),
    enqueue: (item: NewMutation) => lock(queueKey, () => {
      const previous = unsaved.at(-1) ?? readQueue().pending.at(-1);
      const createdAt = Math.max(Date.now(), (previous?.createdAt ?? 0) + 1);
      unsaved.push({ ...item, id: crypto.randomUUID(), createdAt });
      try { saveUnsaved(); }
      catch { /* Keep the change in memory and expose the write failure in the queue view. */ }
    }),
    retryStorage: () => lock(queueKey, () => {
      saveUnsaved();
      storageError = false;
      if (unsavedRejection) {
        const { id, value } = unsavedRejection;
        if (readQueue().pending[0]?.id === id) persistRejection(id, value);
        else unsavedRejection = null;
      }
    }),
    refresh: () => lock(queueKey + ".sync", refreshSnapshot),
    flush,
  };
}

export type { BlockedMutation, QueueAction };
