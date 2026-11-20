import type { OfflineMutation } from "./offline-mutations";

export const queueKey = "mingzhang.offline-mutations.v1";
export const blockedKey = "mingzhang.offline-mutations.blocked.v1";
export const snapshotKey = "mingzhang.sync-snapshot.v1";
export const queueSignalKey = "mingzhang.mutations.changed";
const legacyStateKey = "mingzhang.local-state.v1";
const legacyPrefix = "mingzhang.pending-entry.v1.";

export type Rejection = { status: number; message: string; at: number };
type QueueStatus = {
  status: "pending" | "blocked" | "in_flight";
  blocked?: Rejection;
  since?: number;
  attempt?: string;
  retryAt?: number;
};
export type QueueRecord = QueueStatus & {
  item: OfflineMutation;
  legacy?: true;
  statusUnsaved?: true;
};
type StoredChange = Pick<QueueRecord, "item" | "legacy"> & Partial<QueueStatus>;
type StoredStatus = QueueStatus & { key: IDBValidKey };

type HeadChange = (head: QueueRecord) => QueueRecord | null | undefined;
export type MutationStore = {
  list(legacy?: QueueRecord[]): Promise<QueueRecord[]>;
  head(): Promise<QueueRecord | undefined>;
  append(item: OfflineMutation, status?: QueueStatus): Promise<void>;
  changeHead(id: string, change: HeadChange): Promise<boolean>;
  importLegacy?(records: QueueRecord[]): Promise<void>;
};

export function readJson(raw: string | null) {
  try { return JSON.parse(raw || "null"); }
  catch { return null; }
}

export function isQuota(error: unknown) {
  return error instanceof Error && error.name === "QuotaExceededError";
}

export function isQueueStorageKey(key: string | null) {
  return key === null || [queueKey, blockedKey, snapshotKey, queueSignalKey].includes(key) || key.startsWith(legacyPrefix);
}

function readV1(storage: Storage): OfflineMutation[] {
  const saved = readJson(storage.getItem(queueKey));
  return Array.isArray(saved) ? saved : [];
}

export function readLegacy(storage: Storage) {
  const ids = new Set<string>();
  const items = readV1(storage).filter(item => {
    if (!item?.id || !item?.path || !item?.type || ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  });
  const rejections = readJson(storage.getItem(blockedKey));
  const entryKeys = new Map<string, string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(legacyPrefix)) continue;
    const value = readJson(storage.getItem(key));
    const entry = value?.entry ?? value;
    if (!entry?.id) continue;
    entryKeys.set(entry.id, key);
    if (ids.has(entry.id)) continue;
    ids.add(entry.id);
    items.push({ id: entry.id, type: "entry.create", path: "/entries", method: "POST", body: entry,
      createdAt: Number.isFinite(value?.queued_at) ? value.queued_at : 0 });
  }
  const records = items.map((item): QueueRecord => {
    const value = Object.hasOwn(rejections ?? {}, item.id) ? rejections[item.id] : null;
    const blocked = value && Number.isInteger(value.status) && value.status >= 400 && value.status < 500 &&
      typeof value.message === "string" && Number.isFinite(value.at) ? value as Rejection : undefined;
    return blocked ? { item, status: "blocked", blocked, legacy: true } : { item, status: "pending", legacy: true };
  });
  return { records, entryKeys };
}

function writeV1(storage: Storage, items: OfflineMutation[]) {
  if (items.length) storage.setItem(queueKey, JSON.stringify(items));
  else storage.removeItem(queueKey);
}

export function evictCaches(storage: Storage) {
  storage.removeItem(snapshotKey);
  storage.removeItem(legacyStateKey);
}

export function removeImported(storage: Storage, ids: Set<string>) {
  const { entryKeys } = readLegacy(storage);
  const current = readV1(storage);
  const remaining = current.filter(item => !ids.has(item?.id));
  if (remaining.length !== current.length) writeV1(storage, remaining);
  for (const id of ids) {
    const key = entryKeys.get(id);
    if (key) storage.removeItem(key);
  }
  const rejections = readJson(storage.getItem(blockedKey));
  if (rejections && Object.keys(rejections).some(id => ids.has(id))) {
    const remaining = Object.fromEntries(Object.entries(rejections).filter(([id]) => !ids.has(id)));
    if (Object.keys(remaining).length) storage.setItem(blockedKey, JSON.stringify(remaining));
    else storage.removeItem(blockedKey);
  }
}

export function openMutationStore(database?: IDBFactory): Promise<MutationStore | null> {
  if (!database) return Promise.resolve(null);
  return new Promise<IDBDatabase | null>(resolve => {
    const request = database.open("mingzhang.mutations", 2);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("changes")) {
        const changes = db.createObjectStore("changes", { autoIncrement: true });
        changes.createIndex("id", "item.id", { unique: true });
        // An old tab can write back a v1 ID after its IndexedDB record has already been removed.
        db.createObjectStore("imported");
      }
      // Version 1 inline status remains readable until a sidecar supersedes it.
      db.createObjectStore("status", { keyPath: "key" });
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      }
    };
    request.onblocked = () => { blocked = true; resolve(null); };
    request.onerror = () => resolve(null);
  }).then(db => db && indexedDbStore(db), () => null);
}

function statusOf(record: Partial<QueueStatus>): QueueStatus {
  const { status = "pending", blocked, since, attempt, retryAt } = record;
  return { status, blocked, since, attempt, retryAt };
}

function indexedDbStore(db: IDBDatabase): MutationStore {
  let runtime: { id: string; base: string; status: QueueStatus } | undefined;

  function run<T>(stores: string[], mode: IDBTransactionMode, work: (
    tx: IDBTransaction, result: (value: T) => void, abort: (error: unknown) => void,
  ) => void) {
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value: T;
      let requestError: DOMException | null = null;
      let synchronousError: unknown;
      const abort = (error: unknown) => { synchronousError = error; tx.abort(); };
      tx.onerror = event => { requestError = (event.target as IDBRequest).error; };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(synchronousError ?? requestError ?? tx.error);
      try { work(tx, result => { value = result; }, abort); }
      catch (error) { abort(error); }
    });
  }

  function addChange(tx: IDBTransaction, change: StoredChange, status: QueueStatus, abort: (error: unknown) => void) {
    const added = tx.objectStore("changes").add(change);
    if (!status.blocked && status.retryAt === undefined) return;
    added.onsuccess = () => {
      try { tx.objectStore("status").put({ key: added.result, ...statusOf(status) }); }
      catch (error) { abort(error); }
    };
  }

  function withStatus(change: StoredChange, status: QueueStatus | undefined): QueueRecord {
    const durable = statusOf(status ?? change);
    const volatile = runtime?.id === change.item.id && runtime.base === JSON.stringify(durable) ? runtime : undefined;
    return { item: change.item, legacy: change.legacy, ...(volatile?.status ?? durable),
      statusUnsaved: volatile ? true : undefined };
  }

  const head = async () => (await list([], 1))[0];
  function list(legacy: QueueRecord[], limit?: number) {
    const stores = legacy.length ? ["changes", "status", "imported"] : ["changes", "status"];
    return run<QueueRecord[]>(stores, "readonly", (tx, result) => {
      const changes = tx.objectStore("changes");
      const items = changes.getAll(undefined, limit);
      const keys = changes.getAllKeys(undefined, limit);
      const statuses = tx.objectStore("status").getAll();
      let pending: QueueRecord[];
      statuses.onsuccess = () => {
        const byKey = new Map((statuses.result as StoredStatus[]).map(status => [status.key, status]));
        pending = (items.result as StoredChange[]).map((item, index) => withStatus(item, byKey.get(keys.result[index])));
        result(pending);
      };
      if (legacy.length) {
        const imported = tx.objectStore("imported");
        for (const record of legacy) {
          const seen = imported.getKey(record.item.id);
          seen.onsuccess = () => { if (seen.result === undefined) pending.push(record); };
        }
      }
    });
  }

  return {
    list: (legacy = []) => list(legacy),
    head,
    append: (item, status) => run<void>(status ? ["changes", "status"] : ["changes"], "readwrite", (tx, _, abort) => {
      addChange(tx, { item }, status ?? { status: "pending" }, abort);
    }),
    changeHead: async (id, change) => {
      let attemptedStatus: typeof runtime;
      try {
        const changed = await run<boolean>(["changes", "status"], "readwrite", (tx, result, abort) => {
          const statuses = tx.objectStore("status");
          const request = tx.objectStore("changes").openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || cursor.value.item.id !== id) return result(false);
            const saved = statuses.get(cursor.primaryKey);
            saved.onsuccess = () => {
              try {
                const next = change(withStatus(cursor.value, saved.result));
                if (next === undefined) return result(false);
                if (next === null) {
                  cursor.delete();
                  statuses.delete(cursor.primaryKey);
                } else if (next.item.id !== id) {
                  cursor.update({ item: next.item, legacy: next.legacy });
                  statuses.delete(cursor.primaryKey);
                } else {
                  const base = JSON.stringify(statusOf(saved.result ?? cursor.value));
                  const status = statusOf(next);
                  attemptedStatus = { id, base, status };
                  if (base !== JSON.stringify(status)) statuses.put({ key: cursor.primaryKey, ...status });
                }
                result(true);
              } catch (error) { abort(error); }
            };
          };
        });
        if (changed && runtime?.id === id) runtime = undefined;
        return changed;
      } catch (error) {
        if (!attemptedStatus || !isQuota(error)) throw error;
        runtime = attemptedStatus;
        return true;
      }
    },
    importLegacy: records => run<void>(["changes", "imported", "status"], "readwrite", (tx, _, abort) => {
      const changes = tx.objectStore("changes");
      const imported = tx.objectStore("imported");
      const ids = changes.index("id");
      // Chain requests so writes (including repeated IDs) follow the original array order.
      let index = 0;
      function next() {
        const record = records[index++];
        if (!record) return;
        const id = record.item.id;
        const seen = imported.getKey(id);
        seen.onsuccess = () => {
          if (seen.result !== undefined) return next();
          const existing = ids.getKey(id);
          existing.onsuccess = () => {
            try {
              if (existing.result === undefined) addChange(tx, { item: record.item, legacy: true }, record, abort);
              imported.add(true, id);
              next();
            } catch (error) { abort(error); }
          };
        };
      }
      next();
    }),
  };
}

export function localStorageStore(storage: Storage): MutationStore {
  let runtime: QueueRecord | undefined;
  let unsavedRejection = false;
  function read(): QueueRecord[] {
    return readLegacy(storage).records.map(record => {
      if (runtime?.item.id !== record.item.id) return record;
      if (runtime.status === "in_flight" || unsavedRejection)
        return { ...runtime, statusUnsaved: unsavedRejection ? true : undefined };
      return { ...record, retryAt: runtime.retryAt };
    });
  }
  function setRejection(id: string, value?: Rejection) {
    const saved = readJson(storage.getItem(blockedKey)) ?? {};
    const rejections = Object.fromEntries(Object.entries(saved).filter(([key]) => key !== id));
    if (value) Object.defineProperty(rejections, id, { value, enumerable: true });
    if (Object.keys(rejections).length) storage.setItem(blockedKey, JSON.stringify(rejections));
    else if (saved[id]) storage.removeItem(blockedKey);
  }
  return {
    list: async () => read(),
    head: async () => read()[0],
    append: async (item, status) => {
      const { records, entryKeys } = readLegacy(storage);
      if (status?.blocked) setRejection(item.id, status.blocked);
      writeV1(storage, [...records.map(record => record.item), item]);
      for (const key of entryKeys.values()) storage.removeItem(key);
    },
    changeHead: async (id, change) => {
      const head = read()[0];
      if (head?.item.id !== id) return false;
      const next = change(head);
      if (next === undefined) return false;
      if (next === null) {
        removeImported(storage, new Set([id]));
        runtime = undefined;
        unsavedRejection = false;
      } else if (next.item.id !== id) {
        const current = readLegacy(storage);
        const array = readV1(storage);
        const inArray = array.some(item => item?.id === id);
        writeV1(storage, inArray ? array.map(item => item?.id === id ? next.item : item) : [...array, next.item]);
        const key = current.entryKeys.get(id);
        if (key) storage.removeItem(key);
        runtime = undefined;
        unsavedRejection = false;
        setRejection(id);
      } else {
        // A full v1 array must be sendable without allocating another localStorage key.
        runtime = next;
        if (unsavedRejection || next.blocked?.at !== head.blocked?.at || next.blocked?.message !== head.blocked?.message ||
          next.blocked?.status !== head.blocked?.status) {
          try {
            try { setRejection(id, next.blocked); }
            catch (error) {
              if (!isQuota(error)) throw error;
              evictCaches(storage);
              setRejection(id, next.blocked);
            }
            unsavedRejection = false;
          } catch (error) {
            if (!isQuota(error)) throw error;
            unsavedRejection = true;
          }
        }
      }
      return true;
    },
  };
}
