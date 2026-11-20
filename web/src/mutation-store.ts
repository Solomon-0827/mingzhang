import type { OfflineMutation } from "./offline-mutations";

export const queueKey = "mingzhang.offline-mutations.v1";
export const blockedKey = "mingzhang.offline-mutations.blocked.v1";
export const snapshotKey = "mingzhang.sync-snapshot.v1";
export const queueSignalKey = "mingzhang.mutations.changed";
const legacyStateKey = "mingzhang.local-state.v1";
const legacyPrefix = "mingzhang.pending-entry.v1.";

export type Rejection = { status: number; message: string; at: number };
export type QueueRecord = {
  item: OfflineMutation;
  status: "pending" | "blocked" | "in_flight";
  blocked?: Rejection;
  since?: number;
  attempt?: string;
  retryAt?: number;
  legacy?: true;
};

type HeadChange = (head: QueueRecord) => QueueRecord | null | undefined;
export type MutationStore = {
  list(legacy?: QueueRecord[]): Promise<QueueRecord[]>;
  head(): Promise<QueueRecord | undefined>;
  append(item: OfflineMutation): Promise<void>;
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
    const request = database.open("mingzhang.mutations", 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      const changes = db.createObjectStore("changes", { autoIncrement: true });
      changes.createIndex("id", "item.id", { unique: true });
      // An old tab can write back a v1 ID after its IndexedDB record has already been removed.
      db.createObjectStore("imported");
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

function indexedDbStore(db: IDBDatabase): MutationStore {
  function run<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction, result: (value: T) => void) => void) {
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value: T;
      let requestError: DOMException | null = null;
      tx.onerror = event => { requestError = (event.target as IDBRequest).error; };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? requestError);
      try { work(tx, result => { value = result; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }

  function withSpace(record: QueueRecord) {
    // Reserve space for the in-flight marker while the record is still pending.
    return { ...record, reserved: record.status === "in_flight" ? "" : " ".repeat(128) };
  }

  return {
    list: (legacy = []) => run<QueueRecord[]>(legacy.length ? ["changes", "imported"] : ["changes"], "readonly", (tx, result) => {
      const request = tx.objectStore("changes").getAll();
      let pending: QueueRecord[];
      request.onsuccess = () => { pending = request.result; result(pending); };
      if (legacy.length) {
        const imported = tx.objectStore("imported");
        for (const record of legacy) {
          const seen = imported.getKey(record.item.id);
          seen.onsuccess = () => { if (seen.result === undefined) pending.push(record); };
        }
      }
    }),
    head: () => run<QueueRecord | undefined>(["changes"], "readonly", (tx, result) => {
      const request = tx.objectStore("changes").getAll(undefined, 1);
      request.onsuccess = () => result(request.result[0]);
    }),
    append: item => run<void>(["changes"], "readwrite", tx => {
      tx.objectStore("changes").add(withSpace({ item, status: "pending" }));
    }),
    changeHead: (id, change) => run<boolean>(["changes"], "readwrite", (tx, result) => {
      const request = tx.objectStore("changes").openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || cursor.value.item.id !== id) return result(false);
        const next = change(cursor.value);
        if (next === undefined) return result(false);
        if (next === null) cursor.delete();
        else cursor.update(withSpace(next));
        result(true);
      };
    }),
    importLegacy: records => run<void>(["changes", "imported"], "readwrite", tx => {
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
            if (existing.result === undefined) changes.add(withSpace(record));
            imported.add(true, id);
            next();
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
  function read() {
    return readLegacy(storage).records.map(record => {
      if (runtime?.item.id !== record.item.id) return record;
      if (runtime.status === "in_flight" || unsavedRejection) return runtime;
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
    append: async item => {
      const { records, entryKeys } = readLegacy(storage);
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
        if (next.blocked?.at !== head.blocked?.at || next.blocked?.message !== head.blocked?.message ||
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
