import { replayMutations, type OfflineMutation } from "./offline-mutations";
import { RequestError, type State } from "./types";

export const queueKey = "mingzhang.offline-mutations.v2";
const legacyQueueKey = "mingzhang.offline-mutations.v1";
const legacyStateKey = "mingzhang.local-state.v1";
const legacyPrefix = "mingzhang.pending-entry.v1.";

type BlockedMutation = OfflineMutation & { blocked: NonNullable<OfflineMutation["blocked"]> };
type NewMutation = Omit<OfflineMutation, "id" | "createdAt" | "blocked">;
type QueueAction =
  | { kind: "retry" | "discard"; target: BlockedMutation }
  | { kind: "edit"; target: BlockedMutation; body: OfflineMutation["body"] };

type QueueData = {
  pending: OfflineMutation[];
  snapshot: State | null;
  accepted: OfflineMutation[];
};
type QueueView = { count: number; blocked: BlockedMutation | null; state: State | null; beforeBlocked: State | null };
type FlushResult = "idle" | "synced" | "blocked" | "retryable" | "unauthorized" | "changed";

export function createSyncQueue({
  storage, lock, send, fetchSnapshot,
}: {
  storage: Storage;
  lock: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  send: (item: OfflineMutation) => Promise<unknown>;
  fetchSnapshot: () => Promise<State>;
}) {
  function read(): QueueData {
    const current = storage.getItem(queueKey);
    if (current) return JSON.parse(current);
    const stored = readLegacyJSON(legacyQueueKey);
    const legacy = Array.isArray(stored) ? stored : [];
    const pending: OfflineMutation[] = legacy.filter(item => item?.id && item?.path && item?.type);
    const ids = new Set(pending.map(item => item.id));
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(legacyPrefix)) continue;
      const value = readLegacyJSON(key);
      const entry = value?.entry ?? value;
      if (!entry?.id || ids.has(entry.id)) continue;
      ids.add(entry.id);
      pending.push({ id: entry.id, type: "entry.create", path: "/entries", method: "POST", body: entry,
        createdAt: Number.isFinite(value?.queued_at) ? value.queued_at : 0 });
    }
    pending.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return { pending, snapshot: null, accepted: [] };
  }

  function readLegacyJSON(key: string) {
    try {
      return JSON.parse(storage.getItem(key) || "null");
    } catch {
      return null;
    }
  }

  function write(data: QueueData) {
    const migrating = !storage.getItem(queueKey);
    storage.setItem(queueKey, JSON.stringify(data));
    if (migrating) {
      storage.removeItem(legacyQueueKey);
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (!key?.startsWith(legacyPrefix)) continue;
        const value = readLegacyJSON(key);
        if ((value?.entry ?? value)?.id) storage.removeItem(key);
      }
    }
    if (data.snapshot) storage.removeItem(legacyStateKey);
  }

  function view(): QueueView {
    const { pending, snapshot, accepted } = read();
    const head = pending[0];
    const blocked = head?.blocked ? head as BlockedMutation : null;
    if (snapshot) {
      const base = replayMutations(snapshot, accepted);
      return { count: pending.length, blocked, state: replayMutations(base, pending), beforeBlocked: blocked ? base : null };
    }
    // Older clients cached a ledger that already included some queued changes.
    const cached = readLegacyJSON(legacyStateKey);
    const state = cached?.state ?? cached;
    const applied = new Set<string>(cached?.applied ?? []);
    return { count: pending.length, blocked, state: state?.account_groups
      ? replayMutations(state, [...accepted, ...pending].filter(item => !applied.has(item.id))) : null, beforeBlocked: null };
  }

  const update = <T>(edit: (data: QueueData) => T) => lock(queueKey, () => {
    const data = read();
    const result = edit(data);
    write(data);
    return result;
  });

  async function refreshSnapshot() {
    const snapshot = await fetchSnapshot();
    await update(data => {
      data.snapshot = snapshot;
      data.accepted = [];
    });
    return snapshot;
  }

  async function flush(action?: QueueAction, onAction = () => {}): Promise<FlushResult> {
    return lock(queueKey + ".sync", async () => {
      const data = read();
      let head = data.pending[0];
      if (action && JSON.stringify(head) !== JSON.stringify(action.target)) return "changed";
      if (head?.blocked && !action) return "idle";

      if (head && !data.snapshot) {
        try {
          await refreshSnapshot();
        } catch (error) {
          if (!(error instanceof RequestError) || error.kind === "rejected") throw error;
          return error.kind === "unauthorized" ? "unauthorized" : "retryable";
        }
      }

      if (action?.kind === "edit") {
        // An edited payload needs its own receipt in case the old request was applied.
        const replacement = { ...action.target, id: crypto.randomUUID(), body: action.body };
        await update(current => { current.pending[0] = replacement; });
        head = replacement;
        onAction();
      } else if (action?.kind === "discard") {
        head = await update(current => {
          current.pending.shift();
          return current.pending[0];
        });
        onAction();
      }

      let synced = false;
      while (head && (!head.blocked || action?.kind === "retry" || action?.kind === "edit")) {
        const item = head;
        try {
          await send(item);
        } catch (error) {
          if (!(error instanceof RequestError)) throw error;
          if (error.kind === "unauthorized") return "unauthorized";
          if (error.kind !== "rejected") return "retryable";
          await update(current => {
            current.pending[0] = { ...item, blocked: { status: error.status!, message: error.message, at: Date.now() } };
          });
          return "blocked";
        }
        head = await update(current => {
          // Keep successful changes in the ledger until a fresh server snapshot includes them.
          current.accepted.push(item);
          current.pending.shift();
          return current.pending[0];
        });
        synced = true;
        action = undefined;
      }
      return synced ? "synced" : "idle";
    });
  }

  return {
    view,
    hasReadyHead: () => {
      const head = read().pending[0];
      return Boolean(head && !head.blocked);
    },
    blocked: () => {
      const head = read().pending[0];
      return head?.blocked ? head as BlockedMutation : null;
    },
    enqueue: (item: NewMutation) => update(data => {
      data.pending.push({ ...item, id: crypto.randomUUID(), createdAt: Date.now() });
    }),
    refresh: () => lock(queueKey + ".sync", refreshSnapshot),
    flush,
  };
}

export type { BlockedMutation, QueueAction };
