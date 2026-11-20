import { replayMutations, type OfflineMutation } from "./offline-mutations";
import {
  evictCaches, isQuota, localStorageStore, openMutationStore, readJson,
  removeImported, snapshotKey, type QueueRecord,
} from "./mutation-store";
import { RequestError, requestDeadlineMs, type State } from "./types";

const syncLock = "mingzhang.offline-mutations.v1.sync";
// Allow a send and two snapshot requests, plus a full request deadline of margin.
export const inFlightTimeout = 4 * requestDeadlineMs;

export type BlockedMutation = OfflineMutation & { blocked: NonNullable<QueueRecord["blocked"]> };
type NewMutation = Omit<OfflineMutation, "id" | "createdAt">;
export type QueueAction =
  | { kind: "retry"; target: OfflineMutation }
  | { kind: "discard"; target: OfflineMutation; confirm: (snapshot: State) => boolean }
  | { kind: "edit"; target: BlockedMutation; change: NewMutation };
export type LedgerEpoch = { ledger_epoch: string };
export type SyncSnapshot = LedgerEpoch & { snapshot: State; committed: string[]; revision: number };
export type ReceiptStatus = LedgerEpoch & { committed: boolean; result: unknown };
type FlushResult = "idle" | "synced" | "blocked" | "retryable" | "unauthorized" | "changed" | "in-flight" |
  "already-synced" | "discarded-elsewhere" | "cancelled" | "no-snapshot" | "receipt-unavailable" | "storage-full" |
  { wait: "retry" | "sending"; until: number };

function ready(record: QueueRecord, blocked = record.blocked): QueueRecord {
  const { item, retryAt, legacy } = record;
  return { item, retryAt, legacy, status: blocked ? "blocked" : "pending", blocked };
}

export function createSyncQueue({
  storage, database, locks, send, fetchSnapshot, fetchReceipt, cancelMutation, onStoredChange = () => {},
}: {
  storage: Storage;
  database?: IDBFactory;
  locks?: LockManager;
  send: (item: OfflineMutation) => Promise<LedgerEpoch>;
  fetchSnapshot: (ids: string[]) => Promise<SyncSnapshot>;
  fetchReceipt: (id: string) => Promise<ReceiptStatus>;
  cancelMutation: (id: string, epoch: string) => Promise<ReceiptStatus>;
  onStoredChange?: (uncachedSnapshot?: SyncSnapshot) => void;
}) {
  let fallback = false;
  const v1Store = localStorageStore(storage);
  const opened = openMutationStore(database).then(store => {
    fallback = !store;
    return store ?? v1Store;
  });
  let records: QueueRecord[] = [];
  let memory: QueueRecord[] = [];
  let sendingMemory = false;
  let cache: SyncSnapshot | null = null;
  const retiredEpochs = new Set<string>();
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
    if (!saved.ledger_epoch) {
      // A cache from before epochs is useful offline, but its receipts have no history identity.
      if (!cache) cache = { ...saved, committed: [] };
      return;
    }
    if (!Number.isSafeInteger(saved.revision) || retiredEpochs.has(saved.ledger_epoch)) return;
    if (saved.ledger_epoch !== cache?.ledger_epoch) {
      if (cache?.ledger_epoch) retiredEpochs.add(cache.ledger_epoch);
      cache = saved;
      return;
    }
    // A receipt observed at an earlier revision is still reflected at every later revision.
    const latest = saved.revision >= cache.revision ? saved : cache;
    const committed = new Set([...cache.committed, ...saved.committed]);
    if (latest !== cache || committed.size !== cache.committed.length) cache = { ...latest, committed: [...committed] };
  }

  function readCache() {
    const raw = storage.getItem(snapshotKey);
    if (raw === cachedRaw) return;
    cachedRaw = raw;
    const saved = readJson(raw);
    if (saved?.snapshot && Array.isArray(saved.committed)) takeSnapshot(saved);
  }

  function writeCache(saved: SyncSnapshot, covered: Set<string>) {
    takeSnapshot(saved);
    cache = { ...cache!, committed: cache!.committed.filter(id => covered.has(id)) };
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
    const legacy = await v1Store.list();
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
    return store.list(fallback ? undefined : await v1Store.list());
  }

  async function load(uncachedSnapshot?: SyncSnapshot) {
    const number = ++loadNumber;
    readCache();
    // A delayed quota fallback broadcast must not replace a persisted epoch.
    if (uncachedSnapshot && (!cachedRaw || uncachedSnapshot.ledger_epoch === cache?.ledger_epoch))
      takeSnapshot(uncachedSnapshot);
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
    const head = records[0] ?? memory[0];
    return head?.blocked ? { ...head.item, blocked: head.blocked } : null;
  }

  function derive() {
    const durable = records.map(record => record.item);
    const ids = new Set(durable.map(item => item.id));
    const items = [...durable, ...memory.map(record => record.item).filter(item => !ids.has(item.id))];
    const committed = new Set(cache?.committed);
    return {
      items, count: items.length, blocked: blocked(), snapshot: cache?.snapshot ?? null,
      state: cache ? replayMutations(cache.snapshot, items.filter(item => !committed.has(item.id))) : null,
      fallback, memoryCount: memory.length, statusUnsaved: Boolean(records[0]?.statusUnsaved),
      storageError: Boolean(memory.length || records[0]?.statusUnsaved),
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
      while (legacyImported && memory.length && !sendingMemory) {
        const { item, blocked, retryAt } = memory[0];
        const status = blocked || retryAt !== undefined ? ready(memory[0]) : undefined;
        try {
          if (fallback) {
            try { await store.append(item, status); }
            catch (error) {
              if (!isQuota(error)) throw error;
              readCache();
              evictCaches(storage);
              await store.append(item, status);
            }
          } else {
            await store.append(item, status);
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
  async function fetchAndCacheSnapshot(claim?: { id: string; attempt?: string }) {
    for (let request = 0; request < 2; request += 1) {
      const ids = new Set((await readRecords()).map(record => record.item.id));
      const requested = claim ? new Set([...ids, claim.id]) : ids;
      readCache();
      const startedIn = cache?.ledger_epoch;
      const saved = await fetchSnapshot([...requested]);
      const current = await readRecords();
      const unchanged = current.filter(record => ids.has(record.item.id)).length === ids.size;
      // While this head is held, a new IndexedDB record cannot have been sent.
      // A v1 tab can still send an item before or during its import.
      const holdingHead = claim && current[0]?.item.id === claim.id &&
        (claim.attempt === undefined || current[0]?.attempt === claim.attempt);
      const covered = current.every(record => ids.has(record.item.id) || (holdingHead && !record.legacy));
      readCache();
      const currentEpoch = cache?.ledger_epoch;
      // Retry if another refresh changed the history while this request was in flight.
      if (!saved.ledger_epoch || !Number.isSafeInteger(saved.revision) || retiredEpochs.has(saved.ledger_epoch) ||
        (currentEpoch !== startedIn && currentEpoch !== saved.ledger_epoch) || !unchanged || !covered) continue;
      const uncached = writeCache(saved, requested);
      if (uncached) onStoredChange(uncached);
      return cache!;
    }
    throw new RequestError("unavailable", "同步期间账本仍在变化，请稍后重试。");
  }

  async function refresh() {
    await importLegacy();
    await load();
    await fetchAndCacheSnapshot();
    await load();
    return cache!.snapshot;
  }

  async function runFlush(action?: QueueAction, startup = false): Promise<FlushResult> {
    const durable = await opened;
    let synced = false;
    while (true) {
      const imported = await importLegacy();
      let store = durable;
      let head = await durable.head();
      if (!head && !imported) {
        // If even the first v1 change cannot fit in IndexedDB, drain it in place.
        const [current] = await readRecords();
        head = await durable.head();
        if (!head && current) {
          store = v1Store;
          head = current;
        }
      }
      let pageOnly = false;
      if (!head && imported && memory.length) {
        if (sendingMemory) return action ? "in-flight" : "idle";
        await saveMemory();
        if (sendingMemory) return action ? "in-flight" : "idle";
        sendingMemory = true;
        // Prevent a concurrent save from persisting the same page-only head mid-send.
        await memoryWrites;
        try { head = await durable.head(); }
        finally { sendingMemory = false; }
        pageOnly = !head && memory.length > 0;
        if (pageOnly) head = memory[0];
      }
      if (startup && head?.blocked) action = { kind: "retry", target: head.item };
      startup = false;
      if (action && (action.target.id !== head?.item.id || (action.kind === "edit" && !head.blocked)))
        return cache?.committed.includes(action.target.id) ? "already-synced" : "changed";
      if (!head || (!action && head.blocked)) {
        await load();
        if (!head && (records.length || memory.length)) return "storage-full";
        return synced ? "synced" : "idle";
      }

      const id = head.item.id;
      const changeHead: typeof store.changeHead = async (id, change) => {
        if (!pageOnly) return store.changeHead(id, change);
        if (!sendingMemory || memory[0]?.item.id !== id) return false;
        const next = change(memory[0]);
        if (next === undefined) return false;
        memory = next === null ? memory.slice(1) : [next, ...memory.slice(1)];
        return true;
      };
      const attempt = locks ? undefined : crypto.randomUUID();
      const recovery = action?.kind === "discard" || action?.kind === "edit" ? action : undefined;
      const now = Date.now();
      let wait: FlushResult = "changed";
      function canClaim(current: QueueRecord) {
        if (action?.kind === "edit" && !current.blocked) return false;
        const canReplay = locks && current.attempt?.startsWith("locked:");
        if (!canReplay && current.status === "in_flight" && current.since! + inFlightTimeout > now) {
          wait = recovery ? "in-flight" : { wait: "sending", until: current.since! + inFlightTimeout };
          return false;
        }
        if (!action && current.blocked) return false;
        if (!action && current.retryAt && current.retryAt > now) {
          wait = { wait: "retry", until: current.retryAt };
          return false;
        }
        if (recovery?.kind === "discard" && !cache) {
          wait = "no-snapshot";
          return false;
        }
        return true;
      }
      if (pageOnly) sendingMemory = true;
      const claimed = attempt === undefined ? canClaim(head) : await changeHead(id, current => canClaim(current)
        ? { ...current, status: "in_flight", since: now, attempt } : undefined);
      if (!claimed) {
        if (pageOnly) sendingMemory = false;
        return wait;
      }

      let accepted = false;
      let released = false;
      const finish = async (change: (current: QueueRecord) => QueueRecord | null | undefined) => {
        const changed = await changeHead(id, current => attempt === undefined || current.attempt === attempt ? change(current) : undefined);
        if (pageOnly) sendingMemory = false;
        return changed;
      };
      try {
        if (recovery) {
          const expectedEpoch = cache?.ledger_epoch;
          let receipt = await fetchReceipt(id);
          readCache();
          if (!expectedEpoch || receipt.ledger_epoch !== expectedEpoch || cache?.ledger_epoch !== expectedEpoch) {
            const confirmed = await fetchAndCacheSnapshot({ id, attempt });
            if (expectedEpoch || confirmed.ledger_epoch !== receipt.ledger_epoch) return "receipt-unavailable";
          }
          const epoch = receipt.ledger_epoch;
          if (!receipt.committed && recovery.kind === "discard") {
            if (!recovery.confirm(cache!.snapshot)) return "cancelled";
            receipt = await cancelMutation(id, epoch);
          }
          if (receipt.committed || recovery.kind === "discard") {
            const confirmed = await fetchAndCacheSnapshot({ id, attempt });
            if (receipt.ledger_epoch !== epoch || confirmed.ledger_epoch !== epoch ||
              (receipt.committed && !confirmed.committed.includes(id))) return "receipt-unavailable";
          }
          if (!receipt.committed) {
            const changed = await finish(current => {
              if (recovery.kind === "discard") return null;
              if (attempt && Date.now() >= now + inFlightTimeout) return undefined;
              return { item: { ...recovery.change, id: crypto.randomUUID(), createdAt: current.item.createdAt }, status: "pending" };
            });
            if (!changed) return "changed";
            released = true;
            onStoredChange();
            await load();
            action = undefined;
            synced ||= recovery.kind === "discard";
            continue;
          }
        } else {
          let sent: { ledger_epoch?: string; cancelled?: true };
          try { sent = await send(head.item); }
          catch (error) {
            if (!(error instanceof RequestError) || error.kind !== "cancelled") throw error;
            sent = { ledger_epoch: error.ledgerEpoch, cancelled: true };
          }
          accepted = true;
          const confirmed = await fetchAndCacheSnapshot({ id, attempt });
          if (confirmed.ledger_epoch !== sent.ledger_epoch) return "retryable";
          if (sent.cancelled) {
            const removed = await finish(() => null);
            released = true;
            if (removed) onStoredChange();
            await saveMemory();
            return removed ? "discarded-elsewhere" : "synced";
          }
          if (!confirmed.committed.includes(id)) return "retryable";
        }
        // Publish the confirmed server snapshot before removing the matching local change.
        const acknowledged = await finish(() => null);
        released = true;
        onStoredChange();
        if (!acknowledged) return recovery ? "already-synced" : "changed";
        await saveMemory();
        synced = true;
        if (recovery) return "already-synced";
        action = undefined;
      } catch (error) {
        if (isQuota(error) && recovery) throw new Error("本机空间不足，原修改仍在待同步列表，请释放空间后重试。");
        if (!(error instanceof RequestError)) throw error;
        if (error.kind === "unauthorized") return "unauthorized";
        if (recovery && error.ledgerEpoch && error.ledgerEpoch !== cache?.ledger_epoch) {
          try { await fetchAndCacheSnapshot({ id, attempt }); }
          catch (refreshError) {
            if (refreshError instanceof RequestError && refreshError.kind === "unauthorized") return "unauthorized";
            if (!(refreshError instanceof RequestError)) throw refreshError;
          }
        }
        if (recovery) return "receipt-unavailable";
        if (error.kind === "rejected" && !accepted) {
          const blocked = { status: error.status!, message: error.message, at: Date.now() };
          if (await finish(current => ready(current, blocked))) onStoredChange();
          released = true;
          return "blocked";
        }
        if (head.blocked) return "retryable";
        if (error.retryAfterMs !== undefined) {
          const until = Date.now() + error.retryAfterMs;
          if (await finish(current => ({
            ...ready(current), retryAt: until,
          }))) onStoredChange();
          released = true;
          return { wait: "retry", until };
        }
        return "retryable";
      } finally {
        if (!released && attempt !== undefined && await finish(current => ready(current))) onStoredChange();
        if (pageOnly) sendingMemory = false;
        await load();
      }
    }
  }

  async function flush(action?: QueueAction, startup = false): Promise<FlushResult> {
    readCache();
    if (!locks) return runFlush(action, startup);
    if (action) {
      // Refuse an action on the active head instead of queuing it behind a send.
      return locks.request(syncLock, { ifAvailable: true }, async (lock): Promise<FlushResult> => lock ? runFlush(action) : "in-flight");
    }
    return locks.request(syncLock, () => runFlush(undefined, startup));
  }

  return {
    view, load, refresh, flush, blocked,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    hasReadyHead: () => Boolean((records[0] ?? memory[0]) && !blocked()),
    enqueue: async (item: NewMutation) => {
      memory = [...memory, { item: { ...item, id: crypto.randomUUID(), createdAt: Date.now() }, status: "pending" }];
      await saveMemory();
    },
    retryStorage: async () => {
      const store = await opened;
      const head = await store.head();
      if (head?.statusUnsaved) {
        await store.changeHead(head.item.id, current => current);
        onStoredChange();
      }
      await saveMemory();
    },
  };
}
