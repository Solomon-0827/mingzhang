import { replayMutations, type OfflineMutation } from "./offline-mutations";
import {
  evictCaches, isQuota, localStorageStore, openMutationStore, readJson, readLegacy,
  removeImported, snapshotKey, type QueueRecord,
} from "./mutation-store";
import { RequestError, requestDeadlineMs, type State } from "./types";

const syncLock = "mingzhang.offline-mutations.v1.sync";
// Allow a send and two snapshot requests, plus a full request deadline of margin.
export const inFlightTimeout = 4 * requestDeadlineMs;

export type BlockedMutation = OfflineMutation & { blocked: NonNullable<QueueRecord["blocked"]> };
type NewMutation = Omit<OfflineMutation, "id" | "createdAt">;
export type QueueAction =
  | { kind: "retry"; target: BlockedMutation }
  | { kind: "discard"; target: BlockedMutation; confirm: (snapshot: State) => boolean }
  | { kind: "edit"; target: BlockedMutation; change: NewMutation };
export type SyncSnapshot = { snapshot: State; committed: string[]; observed_at?: string };
export type ReceiptStatus = { committed: boolean; result: unknown };
type FlushResult = "idle" | "synced" | "blocked" | "retryable" | "unauthorized" | "changed" | "in-flight" |
  "already-synced" | "cancelled" | "no-snapshot" | "receipt-unavailable" | "storage-full" |
  { wait: "retry" | "sending"; until: number };

function ready(record: QueueRecord, blocked = record.blocked): QueueRecord {
  const { item, retryAt, legacy } = record;
  return { item, retryAt, legacy, status: blocked ? "blocked" : "pending", blocked };
}

export function createSyncQueue({
  storage, database, locks, send, fetchSnapshot, fetchReceipt, onStoredChange = () => {},
}: {
  storage: Storage;
  database?: IDBFactory;
  locks?: LockManager;
  send: (item: OfflineMutation) => Promise<unknown>;
  fetchSnapshot: (ids: string[]) => Promise<SyncSnapshot>;
  fetchReceipt: (id: string) => Promise<ReceiptStatus>;
  onStoredChange?: (uncachedSnapshot?: SyncSnapshot) => void;
}) {
  let fallback = false;
  const opened = openMutationStore(database).then(store => {
    fallback = !store;
    return store ?? localStorageStore(storage);
  });
  let records: QueueRecord[] = [];
  let memory: OfflineMutation[] = [];
  let cache: SyncSnapshot | null = null;
  let cachedRaw: string | null = null;
  let revision = 0;
  let memoryWrites = Promise.resolve();
  let loadNumber = 0;
  const listeners = new Set<() => void>();

  function notify() {
    revision += 1;
    for (const listener of listeners) listener();
  }

  function takeSnapshot(saved: SyncSnapshot) {
    if (!cache?.observed_at || (saved.observed_at !== undefined && saved.observed_at >= cache.observed_at))
      cache = saved;
  }

  function readCache() {
    const raw = storage.getItem(snapshotKey);
    if (raw === cachedRaw) return;
    cachedRaw = raw;
    const saved = readJson(raw);
    if (saved?.snapshot && Array.isArray(saved.committed)) takeSnapshot(saved);
  }

  function writeCache(saved: SyncSnapshot) {
    readCache();
    takeSnapshot(saved);
    try {
      const raw = JSON.stringify(cache);
      storage.setItem(snapshotKey, raw);
      cachedRaw = raw;
      return undefined;
    } catch {
      storage.removeItem(snapshotKey);
      cachedRaw = null;
      return cache ?? undefined;
    }
  }

  async function importLegacy() {
    const store = await opened;
    if (!store.importLegacy) return true;
    const { records: legacy } = readLegacy(storage);
    if (!legacy.length) return true;
    let length = legacy.length;
    while (length) {
      const batch = legacy.slice(0, length);
      try {
        await store.importLegacy(batch);
      } catch (error) {
        if (!isQuota(error)) throw error;
        length = Math.floor(length / 2);
        continue;
      }
      // The source may have grown while IndexedDB was committing. Remove only IDs now durable.
      const ids = new Set(batch.map(record => record.item.id));
      try { removeImported(storage, ids); }
      catch (error) { if (!isQuota(error)) throw error; }
      onStoredChange();
      return length === legacy.length;
    }
    return false;
  }

  async function readRecords() {
    const store = await opened;
    return store.list(fallback ? undefined : readLegacy(storage).records);
  }

  async function load(uncachedSnapshot?: SyncSnapshot) {
    const number = ++loadNumber;
    if (uncachedSnapshot) takeSnapshot(uncachedSnapshot);
    while (number === loadNumber) {
      readCache();
      const snapshot = cache;
      const current = await readRecords();
      if (number !== loadNumber) return;
      readCache();
      if (snapshot !== cache) continue;
      records = current;
      notify();
      return;
    }
  }

  function blocked() {
    const head = records[0];
    return head?.blocked ? { ...head.item, blocked: head.blocked } : null;
  }

  function derive() {
    const durable = records.map(record => record.item);
    const ids = new Set(durable.map(item => item.id));
    const items = [...durable, ...memory.filter(item => !ids.has(item.id))];
    const committed = new Set(cache?.committed);
    return {
      items, count: items.length, blocked: blocked(), snapshot: cache?.snapshot ?? null,
      state: cache ? replayMutations(cache.snapshot, items.filter(item => !committed.has(item.id))) : null,
      fallback, memoryCount: memory.length, storageError: Boolean(memory.length),
    };
  }
  let viewed = -1;
  let cachedView: ReturnType<typeof derive>;
  function view() {
    if (viewed !== revision) {
      cachedView = derive();
      viewed = revision;
    }
    return cachedView;
  }

  function saveMemory() {
    const write = memoryWrites.then(async () => {
      const store = await opened;
      let saved = false;
      const legacyImported = !memory.length || await importLegacy();
      while (legacyImported && memory.length) {
        const item = memory[0];
        try {
          if (fallback) {
            try { await store.append(item); }
            catch (error) {
              if (!isQuota(error)) throw error;
              readCache();
              evictCaches(storage);
              await store.append(item);
            }
          } else {
            await store.append(item);
          }
        } catch (error) {
          if (!isQuota(error)) throw error;
          break;
        }
        memory = memory.slice(1);
        saved = true;
      }
      if (saved) onStoredChange();
      await load();
    });
    memoryWrites = write.catch(() => {});
    return write;
  }

  // The server reads receipts and the ledger together. A change that appeared while
  // the request was running may already be in that snapshot, especially from a v1 tab.
  async function fetchCoveredSnapshot(claim?: { id: string; attempt: string }) {
    for (let request = 0; request < 2; request += 1) {
      const ids = new Set((await readRecords()).map(record => record.item.id));
      const requested = claim ? new Set([...ids, claim.id]) : ids;
      const saved = await fetchSnapshot([...requested]);
      const current = await readRecords();
      const unchanged = current.filter(record => ids.has(record.item.id)).length === ids.size;
      // While this head is held, a new IndexedDB record cannot have been sent.
      // A v1 tab can still send an item before or during its import.
      const holdingHead = claim && current[0]?.attempt === claim.attempt;
      const covered = current.every(record => ids.has(record.item.id) || (holdingHead && !record.legacy));
      if (unchanged && covered && (!claim || saved.committed.includes(claim.id))) return saved;
    }
    throw new RequestError("unavailable", "同步期间账本仍在变化，请稍后重试。");
  }

  async function refresh() {
    await importLegacy();
    await load();
    const saved = await fetchCoveredSnapshot();
    const uncached = writeCache(saved);
    if (uncached) onStoredChange(uncached);
    await load();
    return cache!.snapshot;
  }

  async function runFlush(action?: QueueAction): Promise<FlushResult> {
    const store = await opened;
    let synced = false;
    while (true) {
      await importLegacy();
      let head = await store.head();
      if (!head && memory.length) {
        await saveMemory();
        head = await store.head();
      }
      if (action && (action.target.id !== head?.item.id || !head.blocked))
        return cache?.committed.includes(action.target.id) ? "already-synced" : "changed";
      if (!head || (!action && head.blocked)) {
        await load();
        if (!head && (records.length || memory.length)) return "storage-full";
        return synced ? "synced" : "idle";
      }

      const id = head.item.id;
      const attempt = (locks ? "locked:" : "") + crypto.randomUUID();
      const recovery = action?.kind === "discard" || action?.kind === "edit" ? action : undefined;
      const now = Date.now();
      let wait: FlushResult = "changed";
      const claimed = await store.changeHead(id, current => {
        if (action && !current.blocked) return undefined;
        const canReplay = !recovery && locks && current.attempt?.startsWith("locked:");
        if (!canReplay && current.status === "in_flight" && current.since! + inFlightTimeout > now) {
          wait = recovery ? "in-flight" : { wait: "sending", until: current.since! + inFlightTimeout };
          return undefined;
        }
        if (!action && current.blocked) return undefined;
        if (!recovery && current.retryAt && current.retryAt > now) {
          wait = { wait: "retry", until: current.retryAt };
          return undefined;
        }
        if (recovery?.kind === "discard" && !cache) {
          wait = "no-snapshot";
          return undefined;
        }
        return { ...current, status: "in_flight", since: now, attempt };
      });
      if (!claimed) return wait;

      let accepted = false;
      const finish = (change: (current: QueueRecord) => QueueRecord | null | undefined) =>
        store.changeHead(id, current => current.attempt === attempt ? change(current) : undefined);
      try {
        if (Date.now() >= now + inFlightTimeout) return "changed";
        if (recovery) {
          const receipt = await fetchReceipt(id);
          accepted = receipt.committed;
          if (!accepted) {
            if (recovery.kind === "discard" && !recovery.confirm(cache!.snapshot)) return "cancelled";
            const changed = await finish(current => {
              // Confirmation may have been open longer than the in-flight deadline.
              if (Date.now() >= now + inFlightTimeout) return undefined;
              if (recovery.kind === "discard") return null;
              return { item: { ...recovery.change, id: crypto.randomUUID(), createdAt: current.item.createdAt }, status: "pending" };
            });
            if (!changed) return "changed";
            onStoredChange();
            await load();
            action = undefined;
            synced ||= recovery.kind === "discard";
            continue;
          }
        } else {
          await send(head.item);
          accepted = true;
        }
        const saved = await fetchCoveredSnapshot({ id, attempt });
        // Publish the confirmed server snapshot before removing the matching local change.
        const uncached = writeCache(saved);
        const acknowledged = await finish(() => null);
        onStoredChange(uncached);
        if (!acknowledged) return recovery ? "already-synced" : "changed";
        await saveMemory();
        synced = true;
        if (recovery) return "already-synced";
        action = undefined;
      } catch (error) {
        if (isQuota(error) && recovery) throw new Error("本机空间不足，原修改仍在待同步列表，请释放空间后重试。");
        if (!(error instanceof RequestError)) throw error;
        if (error.kind === "unauthorized") return "unauthorized";
        if (accepted && recovery) return "already-synced";
        if (recovery) return "receipt-unavailable";
        if (error.kind === "rejected" && !accepted) {
          const blocked = { status: error.status!, message: error.message, at: Date.now() };
          if (await finish(current => ready(current, blocked))) onStoredChange();
          return "blocked";
        }
        if (error.retryAfterMs !== undefined) {
          const until = Date.now() + error.retryAfterMs;
          if (await finish(current => ({
            ...ready(current), retryAt: until, ...(accepted && { status: "pending", blocked: undefined }),
          }))) onStoredChange();
          return { wait: "retry", until };
        }
        return "retryable";
      } finally {
        if (await finish(current => accepted
          ? { item: current.item, legacy: current.legacy, status: "pending" }
          : ready(current))) onStoredChange();
        await load();
      }
    }
  }

  async function flush(action?: QueueAction): Promise<FlushResult> {
    readCache();
    if (!locks) return runFlush(action);
    if (action) {
      // Refuse an action on the active head instead of queuing it behind a send.
      return locks.request(syncLock, { ifAvailable: true }, async (lock): Promise<FlushResult> => lock ? runFlush(action) : "in-flight");
    }
    return locks.request(syncLock, () => runFlush());
  }

  return {
    view, load, refresh, flush, blocked,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    hasReadyHead: () => records[0] ? !records[0].blocked : Boolean(memory.length),
    enqueue: async (item: NewMutation) => {
      memory = [...memory, { ...item, id: crypto.randomUUID(), createdAt: Date.now() }];
      await saveMemory();
    },
    retryStorage: saveMemory,
  };
}
