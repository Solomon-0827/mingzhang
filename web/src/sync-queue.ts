import { replayMutations, type OfflineMutation } from "./offline-mutations";
import { RequestError, type State } from "./types";

export const queueKey = "mingzhang.offline-mutations.v1";
export const blockedKey = "mingzhang.offline-mutations.blocked.v1";
const leaseKey = queueKey + ".lease";
const syncLock = queueKey + ".sync";
const snapshotKey = "mingzhang.sync-snapshot.v1";
const legacyStateKey = "mingzhang.local-state.v1";
const legacyPrefix = "mingzhang.pending-entry.v1.";
// Both requests have a 45-second timeout. Expiration also lets a tab recover a closed sender.
const leaseDuration = 120_000;

type Rejection = { status: number; message: string; at: number };
type BlockedMutation = OfflineMutation & { blocked: Rejection };
type NewMutation = Omit<OfflineMutation, "id" | "createdAt">;
type QueueAction =
  | { kind: "retry"; target: BlockedMutation }
  | { kind: "discard"; target: BlockedMutation }
  | { kind: "edit"; target: BlockedMutation; change: NewMutation };
export type SyncSnapshot = { snapshot: State; committed: string[] };
type Lease = { id: string; owner: string; until: number; kind: "sending" | "retry" };
type LeaseStore = { value: Lease | null; save: (lease: Lease | null) => void };
type QueueTask<T> = (leaseStore?: LeaseStore) => T | Promise<T>;
type QueueLock = <T>(name: string, run: QueueTask<T>) => Promise<T>;
type FlushResult = "idle" | "synced" | "blocked" | "retryable" | "unauthorized" | "changed" | "in-flight" |
  { wait: "retry" | "sending"; until: number };

export function createQueueLock(locks?: LockManager, database = globalThis.indexedDB): QueueLock {
  const local = new Map<string, Promise<unknown>>();
  let opened: Promise<IDBDatabase | null> | undefined;

  function openStorageLock() {
    return opened ??= new Promise<IDBDatabase | null>(resolve => {
      const request = database.open("mingzhang.sync", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("queue");
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); opened = undefined; };
        resolve(request.result);
      };
      request.onerror = request.onblocked = () => resolve(null);
    }).catch(() => null);
  }

  async function storageTask<T>(run: QueueTask<T>): Promise<T> {
    const db = database && await openStorageLock();
    if (!db) return run();
    let transaction: IDBTransaction;
    try { transaction = db.transaction("queue", "readwrite"); }
    catch { return run(); }
    // Both kinds of tabs share this short transaction. Only synchronous storage work runs here.
    return new Promise((resolve, reject) => {
      const store = transaction.objectStore("queue");
      const request = store.get("lease");
      let result: T | Promise<T>;
      request.onsuccess = () => {
        try { result = run({ value: request.result ?? null, save: lease => { store.put(lease, "lease"); } }); }
        catch (error) { reject(error); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  return async <T>(name: string, run: QueueTask<T>): Promise<T> => {
    const task = () => name === queueKey ? storageTask(run) : run();
    if (locks) return await locks.request(name, () => Promise.resolve(task()));
    const next = (local.get(name) ?? Promise.resolve()).then(task);
    local.set(name, next.catch(() => undefined));
    return next;
  };
}

export function isQueueStorageKey(key: string | null) {
  return key === null || [queueKey, blockedKey, snapshotKey, legacyStateKey].includes(key) || key.startsWith(legacyPrefix);
}

function parse(raw: string | null) {
  try { return JSON.parse(raw || "null"); }
  catch { return null; }
}

export function createSyncQueue({
  storage, lock, send, fetchSnapshot,
}: {
  storage: Storage;
  lock: QueueLock;
  send: (item: OfflineMutation) => Promise<unknown>;
  fetchSnapshot: (ids: string[]) => Promise<SyncSnapshot>;
}) {
  const owner = crypto.randomUUID();
  let cache: SyncSnapshot | null = null;
  let cachedRaw: string | null = null;
  let unsaved: OfflineMutation[] = [];
  let unsavedRejection: { id: string; value: Rejection } | null = null;

  function readQueue() {
    const legacy: OfflineMutation[] = [];
    const legacyKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(legacyPrefix)) continue;
      const value = parse(storage.getItem(key));
      const entry = value?.entry ?? value;
      if (!entry?.id) continue;
      legacyKeys.push(key);
      legacy.push({ id: entry.id, type: "entry.create", path: "/entries", method: "POST", body: entry,
        createdAt: Number.isFinite(value?.queued_at) ? value.queued_at : 0 });
    }
    const stored = parse(storage.getItem(queueKey));
    const pending: OfflineMutation[] = Array.isArray(stored) ? stored.filter(item => item?.id && item?.path && item?.type) : [];
    const ids = new Set(pending.map(item => item.id));
    for (const item of legacy) {
      if (ids.has(item.id)) continue;
      ids.add(item.id);
      pending.push(item);
    }
    return { pending, legacyKeys };
  }

  function withCacheEviction<T>(write: () => T): T {
    try {
      return write();
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "QuotaExceededError") throw error;
      readCache();
      storage.removeItem(snapshotKey);
      storage.removeItem(legacyStateKey);
      cachedRaw = null;
      return write();
    }
  }

  // Re-read even on the quota retry so a legacy append during eviction is kept.
  function updateQueue(change: (current: OfflineMutation[]) => OfflineMutation[] | null) {
    return withCacheEviction(() => {
      const { pending, legacyKeys } = readQueue();
      const next = change(pending);
      if (!next) return false;
      storage.setItem(queueKey, JSON.stringify(next));
      for (const key of legacyKeys) storage.removeItem(key);
      return true;
    });
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

  function writeCache(value: SyncSnapshot) {
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
      withCacheEviction(() => {
        const { pending } = readQueue();
        if (pending[0]?.id !== id) return;
        const stored = parse(storage.getItem(blockedKey));
        const rejections = Object.fromEntries(pending.filter(item => stored?.[item.id]).map(item => [item.id, stored[item.id]]));
        storage.setItem(blockedKey, JSON.stringify({ ...rejections, [id]: value }));
      });
      unsavedRejection = null;
    } catch {
      unsavedRejection = { id, value };
    }
  }

  function clearRejection(id: string) {
    if (unsavedRejection?.id === id) unsavedRejection = null;
    const stored = parse(storage.getItem(blockedKey));
    if (!stored?.[id]) return;
    delete stored[id];
    if (Object.keys(stored).length) storage.setItem(blockedKey, JSON.stringify(stored));
    else storage.removeItem(blockedKey);
  }

  function storedLease(store?: LeaseStore): Lease | null {
    return store?.value ?? parse(storage.getItem(leaseKey));
  }

  function readLease(id: string, store?: LeaseStore) {
    const lease = storedLease(store);
    return lease?.id === id && lease.until > Date.now() ? lease : null;
  }

  function writeLease(lease: Lease | null, store?: LeaseStore) {
    // Reserve a fixed-size slot before new queue writes, so a full queue can still start sending.
    try {
      withCacheEviction(() => storage.setItem(leaseKey, JSON.stringify(lease).padEnd(256)));
      if (store?.value) store.save(null);
    } catch (error) {
      // An old tab may have filled localStorage before the slot could be reserved.
      if (!store || !(error instanceof Error) || error.name !== "QuotaExceededError") throw error;
      store.save(lease);
    }
  }

  function reserveLease(store?: LeaseStore) {
    if (storage.getItem(leaseKey) === null && !store?.value) writeLease(null, store);
  }

  function releaseLease(id: string, store?: LeaseStore, retryAt?: number) {
    const lease = storedLease(store);
    if (lease?.id !== id || lease.owner !== owner || lease.kind !== "sending") return;
    writeLease(retryAt === undefined ? null : { ...lease, kind: "retry", until: retryAt }, store);
  }

  function view() {
    const { pending } = readQueue();
    const blocked = readBlocked(pending[0]);
    const items = [...pending, ...unsaved];
    const memoryCount = unsaved.length;
    const storageError = Boolean(memoryCount || (blocked?.id && blocked.id === unsavedRejection?.id));
    const saved = readCache();
    if (saved) {
      const committed = new Set(saved.committed);
      return { items, count: items.length, blocked, state: replayMutations(saved.snapshot, items.filter(item => !committed.has(item.id))),
        beforeBlocked: blocked ? saved.snapshot : null, storageError, memoryCount };
    }
    // The old snapshot can already contain queued changes. It is only a display fallback.
    const cached = parse(storage.getItem(legacyStateKey));
    const state = cached?.state ?? cached;
    const applied = new Set<string>(Array.isArray(cached?.applied) ? cached.applied : []);
    const base: State | null = state?.account_groups ? state : null;
    return { items, count: items.length, blocked, state: base ? replayMutations(base, items.filter(item => !applied.has(item.id))) : null,
      beforeBlocked: blocked && !applied.has(blocked.id) ? base : null, storageError, memoryCount };
  }

  async function reconcile<T>(apply: (saved: SyncSnapshot, store?: LeaseStore) => T, sendingId?: string): Promise<T> {
    while (true) {
      const ids = new Set(readQueue().pending.map(item => item.id));
      const saved = await fetchSnapshot([...ids]);
      const result = await lock(queueKey, store => {
        if (readQueue().pending.every(item => ids.has(item.id))) return { value: apply(saved, store) };
        // An earlier client may have appended and committed a change while the snapshot was loading.
        const lease = sendingId && readLease(sendingId, store);
        if (lease && lease.owner === owner) writeLease({ ...lease, until: Date.now() + leaseDuration }, store);
        return null;
      });
      if (result) return result.value;
    }
  }

  async function refreshSnapshot() {
    const previous = readCache();
    return reconcile(saved => {
      const latest = readCache();
      if (latest && latest !== previous) return latest.snapshot;
      writeCache(saved);
      return saved.snapshot;
    });
  }

  function changeHead(action: Exclude<QueueAction, { kind: "retry" }>, store?: LeaseStore) {
    const head = readQueue().pending[0];
    if (head?.id !== action.target.id || !readBlocked(head)) return "changed";
    if (readLease(head.id, store)?.kind === "sending") return "in-flight";
    if (readCache()?.committed?.includes(head.id)) return "changed";
    // A replacement stays in the same slot and gets a fresh receipt.
    const replacement = action.kind === "edit" ? { ...action.change, id: crypto.randomUUID(), createdAt: head.createdAt } : null;
    try {
      const changed = updateQueue(current => current[0]?.id !== head.id ? null
        : replacement ? current.map(item => item.id === head.id ? replacement : item) : current.filter(item => item.id !== head.id));
      if (!changed) return "changed";
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "QuotaExceededError") throw error;
      throw new Error("本机空间不足，原修改仍在待同步列表，请释放空间后重试。");
    }
    clearRejection(head.id);
    return null;
  }

  function saveUnsaved(store?: LeaseStore) {
    if (!unsaved.length) return;
    try { reserveLease(store); }
    catch (error) {
      if (error instanceof Error && error.name === "QuotaExceededError") return;
      throw error;
    }
    try {
      updateQueue(current => [...current, ...unsaved]);
      unsaved = [];
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "QuotaExceededError") throw error;
      while (unsaved.length) {
        try {
          updateQueue(current => [...current, unsaved[0]]);
          unsaved.shift();
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "QuotaExceededError") throw error;
          break;
        }
      }
    }
  }

  function retryStorage(store?: LeaseStore) {
    saveUnsaved(store);
    if (unsavedRejection) persistRejection(unsavedRejection.id, unsavedRejection.value);
  }

  async function flush(action?: QueueAction, onAction = () => {}): Promise<FlushResult> {
    if (action?.kind === "edit" || action?.kind === "discard") {
      const recovery = action;
      const refused = await lock(queueKey, store => changeHead(recovery, store));
      if (refused) return refused;
      action = undefined;
      onAction();
    }

    return lock(syncLock, async () => {
      let synced = false;
      while (true) {
        const attempt = await lock(queueKey, store => {
          if (!readQueue().pending.length) saveUnsaved(store);
          const head = readQueue().pending[0];
          const blocked = readBlocked(head);
          if (action && (action.target.id !== head?.id || !blocked)) return { stop: "changed" as const };
          if (!head || (blocked && !action)) return { stop: synced ? "synced" as const : "idle" as const };
          const lease = readLease(head.id, store);
          if (lease) return { stop: lease.kind === "sending" && action ? "in-flight" as const : { wait: lease.kind, until: lease.until } };
          writeLease({ id: head.id, owner, until: Date.now() + leaseDuration, kind: "sending" }, store);
          return { item: head };
        });
        if (!attempt.item) return attempt.stop;
        const item = attempt.item;
        let accepted = false;
        let retryAt: number | undefined;
        try {
          if (!readCache()) await refreshSnapshot();
          const pending = await lock(queueKey, store =>
            readQueue().pending[0]?.id === item.id && readLease(item.id, store)?.owner === owner);
          if (!pending || readQueue().pending[0]?.id !== item.id) return "changed";
          await send(item);
          accepted = true;
          await reconcile((saved, store) => {
            updateQueue(current => current.some(entry => entry.id === item.id) ? current.filter(entry => entry.id !== item.id) : null);
            clearRejection(item.id);
            saveUnsaved(store);
            writeCache(saved);
          }, item.id);
          synced = true;
          action = undefined;
        } catch (error) {
          if (!(error instanceof RequestError)) throw error;
          if (accepted) await lock(queueKey, () => clearRejection(item.id));
          if (error.kind === "unauthorized") return "unauthorized";
          if (error.kind !== "rejected" || accepted) {
            retryAt = error.retryAfterMs === undefined ? undefined : Date.now() + error.retryAfterMs;
            return retryAt === undefined ? "retryable" : { wait: "retry", until: retryAt };
          }
          return await lock(queueKey, () => {
            if (readQueue().pending[0]?.id !== item.id) return "changed";
            persistRejection(item.id, { status: error.status!, message: error.message, at: Date.now() });
            return "blocked";
          });
        } finally {
          await lock(queueKey, store => releaseLease(item.id, store, retryAt));
        }
      }
    });
  }

  return {
    view,
    hasReadyHead: (includeMemory = true) => {
      const head = readQueue().pending[0];
      return head ? !readBlocked(head) : includeMemory && Boolean(unsaved.length);
    },
    blocked: () => readBlocked(readQueue().pending[0]),
    enqueue: (item: NewMutation) => lock(queueKey, store => {
      unsaved.push({ ...item, id: crypto.randomUUID(), createdAt: Date.now() });
      saveUnsaved(store);
    }),
    retryStorage: () => lock(queueKey, retryStorage),
    refresh: () => lock(syncLock, refreshSnapshot),
    flush,
  };
}

export type { BlockedMutation, QueueAction };
