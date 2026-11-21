import { IDBCursor, IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyncQueue, inFlightTimeout, type BlockedMutation, type SyncSnapshot } from "./sync-queue";
import { blockedKey, openMutationStore, queueKey, snapshotKey } from "./mutation-store";
import {
  BlockedSyncDetails, canRebase, describeBlocked, EntryRecoveryComparison,
  entryRecoveryChange, prepareEntryRecovery, rebaseChange,
} from "./blocked-sync";
import { api, RequestError, requestDeadlineMs, type Entry, type State } from "./types";
import { applyMutation, type OfflineMutation } from "./offline-mutations";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  maxCharacters = Infinity;
  rejectWritesTo: string[] = [];
  setItem(key: string, value: string) {
    const otherSize = [...this.values].reduce((sum, [name, raw]) => name === key ? sum : sum + raw.length, 0);
    if (this.rejectWritesTo.includes(key) || otherSize + value.length > this.maxCharacters) {
      throw new DOMException("storage is full", "QuotaExceededError");
    }
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
}

const snapshot: State = {
  accounts: [{ id: "cash", name: "现金", kind: "cash", opening_cents: 10000, balance_cents: 10000, version: 1 }],
  entries: [], account_groups: [], demo: false, assets: 10000, liabilities: 0, net_assets: 10000,
  receivable: 0, payable: 0, imports: [], backup_date: null, server_time: "",
};

function entry(id: string, amount = 100, version = 1): Entry {
  return {
    id, version, amount_cents: amount, date: "2026-01-01", kind: "expense", account_id: "cash",
    category: "日常/餐饮", memo: "", merchant: "", counterparty: "",
    to_account_id: null, reference_id: null, deleted: 0, remaining_cents: amount,
  };
}

function createEntry(id: string) {
  return { type: "entry.create", path: "/entries", method: "POST", body: entry(id) } as const;
}

function setup(initial = snapshot, database = new IDBFactory(), ledger_epoch = "original") {
  const storage = new MemoryStorage();
  let server = initial;
  const receipts = new Set<string>();
  const send = vi.fn(async (_item: OfflineMutation): Promise<unknown> => undefined);
  function commit(item: OfflineMutation) {
    if (receipts.has(item.id)) return;
    server = applyMutation(server, item);
    receipts.add(item.id);
  }
  const serverSnapshot = (ids: string[]): SyncSnapshot => ({
    snapshot: server, committed: ids.filter(id => receipts.has(id)), revision: receipts.size, ledger_epoch,
  });
  const fetchSnapshot = vi.fn(async (ids: string[]) => serverSnapshot(ids));
  const fetchReceipt = vi.fn(async (id: string) => ({ committed: receipts.has(id), result: null, ledger_epoch }));
  const cancelMutation = vi.fn(async (id: string, _epoch: string) => ({ committed: receipts.has(id), result: null, ledger_epoch }));
  const open = (locks?: LockManager) => {
    const options = { storage, database, locks,
      send: async (item: OfflineMutation) => { await send(item); commit(item); return { ledger_epoch }; },
      fetchSnapshot, fetchReceipt, cancelMutation };
    return createSyncQueue(options);
  };
  return { storage, database, send, fetchSnapshot, fetchReceipt, cancelMutation, commit, serverSnapshot, receipts, open, queue: open() };
}

const reject = (message = "请选择有效的账户", status = 400) => new RequestError("rejected", message, status);
const rawEntry = (id: string, createdAt = 1): OfflineMutation => ({ ...createEntry(id), id, createdAt });
const oldestEntryKey = "mingzhang.pending-entries.v1";
const category = (path: string, version: number) => ({
  type: "category.change", method: "POST", path: "/categories",
  body: { action: "add", path, level: "parent", kind: "expense", version },
}) as const;
const withCatalog = { ...snapshot, category_catalog: { items: {}, hidden: [], version: 1 } };
const discard = (target: OfflineMutation, confirm = vi.fn(() => true)) =>
  ({ kind: "discard", target, confirm } as const);

afterEach(() => vi.restoreAllMocks());

describe("transactional sync queue", () => {
  it("queues a batch together and derives all local entry updates before syncing", async () => {
    const initial = { ...snapshot, entries: [entry("first"), entry("second")] };
    const { queue, send } = setup(initial);
    await queue.refresh();
    await queue.enqueueMany([
      { type: "entry.update", path: "/entries/first", method: "PUT", body: entry("first", 200) },
      { type: "entry.update", path: "/entries/second", method: "PUT", body: entry("second", 300) },
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(queue.view().count).toBe(2);
    expect(queue.view().state?.entries.map(item => [item.id, item.amount_cents, item.version]))
      .toEqual([["first", 200, 2], ["second", 300, 2]]);
  });

  it("sends through claim quota errors and keeps the rejection actionable through status quota errors", async () => {
    const { queue, send, cancelMutation } = setup();
    await queue.refresh();
    await queue.enqueue(createEntry("durable"));
    const update = IDBCursor.prototype.update;
    const payloadWrites = vi.spyOn(IDBCursor.prototype, "update").mockImplementation(function (this: IDBCursor, value) {
      if ((this.source as IDBObjectStore).name === "changes") throw new DOMException("full", "QuotaExceededError");
      return update.call(this, value);
    });
    const put = IDBObjectStore.prototype.put;
    const statusWrites = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "status") throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args);
    });
    send.mockRejectedValueOnce(reject("server rejected", 422)).mockRejectedValueOnce(reject("still rejected", 409));
    expect(await queue.flush()).toBe("blocked");
    expect(send).toHaveBeenCalledOnce();
    expect(payloadWrites).not.toHaveBeenCalled();
    expect(statusWrites).toHaveBeenCalled();
    expect(queue.view()).toMatchObject({ count: 1, memoryCount: 0, storageError: true,
      blocked: { blocked: { message: "server rejected" } } });
    const target = queue.blocked()!;
    expect(await queue.flush({ kind: "retry", target })).toBe("blocked");
    expect(queue.blocked()?.blocked.message).toBe("still rejected");
    expect(await queue.flush(discard(target))).toBe("synced");
    expect(cancelMutation).toHaveBeenCalledWith(target.id, "original");
    expect(queue.view()).toMatchObject({ count: 0, storageError: false });
  });

  it("retries or discards a pending head after transport failures", async () => {
    const { queue, send, cancelMutation } = setup();
    await queue.refresh();
    await queue.enqueue(createEntry("pending"));
    const unavailable = new RequestError("unavailable", "temporarily unavailable");
    send.mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable);
    expect(await queue.flush()).toBe("retryable");
    const [target] = queue.view().items;
    const panel = renderToStaticMarkup(createElement(BlockedSyncDetails, {
      item: target, state: snapshot, waiting: 0, onRetry: vi.fn(), onDiscard: vi.fn(),
    }));
    expect(panel).toContain("重新同步</button>");
    expect(panel).toMatch(/discard-sync">放弃这条修改/);
    expect(await queue.flush({ kind: "retry", target })).toBe("retryable");
    expect(await queue.flush({ kind: "discard", target, confirm: () => true })).toBe("synced");
    expect(cancelMutation).toHaveBeenCalledWith(target.id, "original");
    expect(queue.view().count).toBe(0);
  });

  it("sends a blocked head under Web Locks without writing any in-flight status", async () => {
    const { open, send } = setup();
    const locks = { request: (_name: string, ...args: Array<(lock: object) => unknown>) => args.at(-1)!({}) } as unknown as LockManager;
    const queue = open(locks);
    await queue.enqueue(createEntry("locked"));
    send.mockRejectedValueOnce(reject());
    expect(await queue.flush()).toBe("blocked");
    const writes = vi.spyOn(IDBObjectStore.prototype, "put");
    const updates = vi.spyOn(IDBCursor.prototype, "update");
    expect(await queue.flush({ kind: "retry", target: queue.blocked()! })).toBe("synced");
    expect(writes).not.toHaveBeenCalled();
    expect(updates).not.toHaveBeenCalled();
  });

  it("can discard a page-only head when no durable payload fits", async () => {
    const { queue, send, cancelMutation } = setup();
    await queue.refresh();
    const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "changes") throw new DOMException("full", "QuotaExceededError");
      return add.apply(this, args);
    });
    await queue.enqueue(createEntry("page-only"));
    send.mockRejectedValueOnce(new RequestError("unavailable", "unavailable"));
    expect(await queue.flush()).toBe("retryable");
    expect(queue.view().memoryCount).toBe(1);
    const [target] = queue.view().items;
    expect(await queue.flush({ kind: "discard", target, confirm: () => true })).toBe("synced");
    expect(cancelMutation).toHaveBeenCalledWith(target.id, "original");
    expect(queue.view()).toMatchObject({ count: 0, storageError: false });
  });

  it("acknowledges when a commit wins between the receipt lookup and confirmed cancellation", async () => {
    const { queue, commit, cancelMutation } = setup();
    await queue.refresh();
    await queue.enqueue(createEntry("commit-first"));
    const [target] = queue.view().items;
    const confirm = vi.fn(() => { commit(target); return true; });
    expect(await queue.flush({ kind: "discard", target, confirm })).toBe("already-synced");
    expect(confirm).toHaveBeenCalledOnce();
    expect(cancelMutation).toHaveBeenCalledWith(target.id, "original");
    expect(queue.view().state?.entries.map(entry => entry.id)).toEqual(["commit-first"]);
    expect(queue.view().count).toBe(0);
  });

  it.each([true, false])("re-derives on a cancelled send with local head still present: %s", async stillPresent => {
    const { queue, database, send } = setup();
    await queue.refresh();
    await queue.enqueue(createEntry("cancelled"));
    const [target] = queue.view().items;
    send.mockImplementationOnce(async () => {
      if (!stillPresent) await (await openMutationStore(database))!.changeHead(target.id, () => null);
      throw new RequestError("cancelled", "已放弃", 409, undefined, "original");
    });
    expect(await queue.flush()).toBe(stillPresent ? "discarded-elsewhere" : "synced");
    expect(queue.view().count).toBe(0);
    expect(queue.view().state?.entries).toEqual([]);
  });

  it("keeps a newer ledger when the acknowledgement arrives with an older revision", async () => {
    const { queue, fetchSnapshot, serverSnapshot, commit } = setup();
    await queue.enqueue(createEntry("committed"));
    const [head] = queue.view().items;
    commit(head);
    const older = { ...serverSnapshot([head.id]), observed_at: "999" };
    commit(rawEntry("newer"));
    await queue.load({ ...serverSnapshot([]), observed_at: "100" } as SyncSnapshot);
    fetchSnapshot.mockResolvedValueOnce(older);
    expect(await queue.flush()).toBe("synced");
    expect(queue.view().state?.entries.map(entry => entry.id).sort()).toEqual(["committed", "newer"]);
    expect(queue.view().count).toBe(0);
  });

  it("uses the restored snapshot at a lower revision and replays the whole queue without old receipt coverage", async () => {
    const { queue, open, fetchSnapshot, serverSnapshot, commit } = setup();
    await queue.enqueue(createEntry("replay-after-restore"));
    await queue.enqueue(createEntry("still-pending"));
    const items = queue.view().items;
    commit(items[0]);
    commit(rawEntry("removed-by-restore"));
    const before = { ...serverSnapshot([items[0].id]), ledger_epoch: "before" };
    fetchSnapshot.mockResolvedValueOnce(before);
    await queue.refresh();

    const after = { snapshot: { ...snapshot, entries: [entry("in-backup")] }, committed: [], revision: 0, ledger_epoch: "restored" };
    fetchSnapshot.mockResolvedValueOnce(after);
    await queue.refresh();
    await queue.load(before); // A delayed snapshot from another tab.
    const reloaded = open();
    await reloaded.load(before);
    for (const tab of [queue, reloaded]) {
      expect(tab.view().snapshot?.entries.map(entry => entry.id)).toEqual(["in-backup"]);
      expect(tab.view().items).toEqual(items);
      expect(tab.view().state?.entries.map(entry => entry.id).sort()).toEqual(["in-backup", "replay-after-restore", "still-pending"]);
    }
  });

  it("keeps a queued change when a pre-restore receipt arrives after the restored snapshot", async () => {
    const { queue, fetchSnapshot, fetchReceipt, serverSnapshot, commit } = setup(snapshot, new IDBFactory(), "before");
    await queue.enqueue(createEntry("keep-queued"));
    const [head] = queue.view().items;
    commit(head);
    const oldReceipt = { committed: true, result: null, ledger_epoch: "before" };
    const before = { ...serverSnapshot([head.id]), ledger_epoch: "before" };
    fetchSnapshot.mockResolvedValueOnce(before);
    await queue.refresh();

    const after = { snapshot, committed: [], revision: 0, ledger_epoch: "restored" };
    fetchReceipt.mockImplementationOnce(async () => {
      fetchSnapshot.mockResolvedValueOnce(after);
      await queue.refresh();
      return oldReceipt;
    });
    fetchSnapshot.mockResolvedValue(before);
    const confirm = vi.fn(() => true);
    expect(await queue.flush(discard(head, confirm))).toBe("receipt-unavailable");
    expect(confirm).not.toHaveBeenCalled();
    expect(queue.view().items).toEqual([head]);
  });

  it.each([false, true])("keeps a queued change when an old send returns after restore (cancelled: %s)", async cancelled => {
    const { queue, send, fetchSnapshot, serverSnapshot, commit } = setup(snapshot, new IDBFactory(), "before");
    await queue.enqueue(createEntry("keep-queued"));
    const [head] = queue.view().items;
    commit(rawEntry("lost-in-restore"));
    await queue.refresh();

    const after = { snapshot, committed: [], revision: 0, ledger_epoch: "restored" };
    send.mockImplementationOnce(async () => {
      await queue.refresh();
      // The old server returned this snapshot before the restore, but its reply arrives late.
      fetchSnapshot.mockImplementationOnce(async () => serverSnapshot([head.id]));
      if (cancelled) throw new RequestError("cancelled", "已放弃", 409, undefined, "before");
    });
    fetchSnapshot.mockResolvedValue(after);
    expect(await queue.flush()).toBe("retryable");
    expect(queue.view().items).toEqual([head]);
    expect(queue.view().snapshot?.entries).toEqual([]);
    expect(queue.view().state?.entries.map(entry => entry.id)).toEqual(["keep-queued"]);
  });

  it.each([408, 429])("attempts a blocked head once on startup after HTTP %i with Retry-After", async status => {
    const { queue, open, send } = setup();
    await queue.enqueue(createEntry("blocked-on-startup"));
    send.mockRejectedValueOnce(reject());
    expect(await queue.flush()).toBe("blocked");
    const tab = open();
    await tab.load();
    send.mockRejectedValueOnce(new RequestError(status === 408 ? "timeout" : "unavailable", "retry later", status, 1));
    const canRun = () => true;
    expect(await tab.flush(undefined, canRun)).toBe("retryable");
    expect(await tab.flush(undefined, canRun)).toBe("idle");
    expect(send).toHaveBeenCalledTimes(2);
    expect(tab.view().count).toBe(1);
    expect(await tab.flush({ kind: "retry", target: tab.blocked()! })).toBe("synced");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("defers the startup retry while offline or waiting for a claim", async () => {
    const { queue, open, send, database } = setup();
    await queue.enqueue(createEntry("blocked-on-startup"));
    send.mockRejectedValueOnce(reject());
    expect(await queue.flush()).toBe("blocked");

    const tab = open();
    expect(await tab.flush(undefined, () => false)).toBe("idle");
    expect(send).toHaveBeenCalledOnce();

    const store = (await openMutationStore(database))!;
    const head = (await store.head())!;
    await store.changeHead(head.item.id, current => ({
      ...current, status: "in_flight", since: Date.now(), attempt: "other-tab",
    }));
    const canRun = () => true;
    expect(await tab.flush(undefined, canRun)).toMatchObject({ wait: "sending" });
    expect(tab.view().headSending).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    await store.changeHead(head.item.id, () => head);
    await tab.load();
    expect(tab.view().headSending).toBe(false);

    send.mockRejectedValueOnce(reject());
    expect(await tab.flush(undefined, canRun)).toBe("blocked");
    expect(await tab.flush(undefined, canRun)).toBe("idle");
    expect(send).toHaveBeenCalledTimes(2);
    expect(tab.view()).toMatchObject({ count: 1, blocked: { body: { id: "blocked-on-startup" } } });
  });

  it("retries the blocked startup head once after signing in again when its send returned 401", async () => {
    const { queue, open, send } = setup();
    await queue.enqueue(createEntry("blocked-on-startup"));
    const [head] = queue.view().items;
    send.mockRejectedValueOnce(reject());
    expect(await queue.flush()).toBe("blocked");
    send.mockClear();

    const tab = open();
    let signedIn = true;
    const canRun = () => signedIn;
    send.mockRejectedValueOnce(new RequestError("unauthorized", "重新登录", 401));
    expect(await tab.flush(undefined, canRun)).toBe("unauthorized");
    expect(tab.blocked()).toMatchObject(head);
    signedIn = false;
    expect(await tab.flush(undefined, canRun)).toBe("idle");
    expect(send.mock.calls).toEqual([[head]]);

    signedIn = true;
    expect(await tab.flush(undefined, canRun)).toBe("synced");
    expect(await tab.flush(undefined, canRun)).toBe("idle");
    expect(send.mock.calls).toEqual([[head], [head]]);
    expect(tab.view().count).toBe(0);
  });

  it("keeps the startup retry pending if automatic sending is disabled after a claim without Web Locks", async () => {
    const { queue, open, send } = setup();
    await queue.enqueue(createEntry("blocked-on-startup"));
    const [head] = queue.view().items;
    send.mockRejectedValueOnce(reject());
    expect(await queue.flush()).toBe("blocked");
    send.mockClear();

    const tab = open();
    const canRun = vi.fn(() => false).mockReturnValueOnce(true);
    const result = await tab.flush(undefined, canRun);
    expect(send).not.toHaveBeenCalled();
    expect(result).toBe("idle");
    expect(tab.view()).toMatchObject({ headSending: false, blocked: head });
    expect(tab.hasReadyHead()).toBe(true);

    canRun.mockReturnValue(true);
    send.mockRejectedValueOnce(reject());
    expect(await tab.flush(undefined, canRun)).toBe("blocked");
    expect(await tab.flush(undefined, canRun)).toBe("idle");
    expect(send.mock.calls).toEqual([[head]]);
  });

  it.each(["before", "after"])("reports a partial drain when automatic sending stops %s the next claim", async when => {
    const { queue, send } = setup();
    await queue.enqueue(createEntry("sent"));
    await queue.enqueue(createEntry("waiting"));
    const [first, second] = queue.view().items;
    const canRun = vi.fn(() => false)
      .mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(when === "after");

    expect(await queue.flush(undefined, canRun)).toBe("synced");
    expect(send.mock.calls).toEqual([[first]]);
    expect(queue.view()).toMatchObject({ items: [second], headSending: false });
  });

  it("durably interleaves 400 saves from two tabs and sends them in IndexedDB key order without Web Locks", async () => {
    const { queue, open, send, receipts } = setup();
    const other = open();
    await Promise.all([queue, other].map(async (tab, index) => {
      for (let i = 0; i < 200; i += 1) await tab.enqueue(createEntry(`${index}-${i}`));
    }));
    const reloaded = open();
    await reloaded.load();
    const order = reloaded.view().items.map(item => item.id);
    expect(order).toHaveLength(400);
    expect(new Set(order).size).toBe(400);
    for (let i = 0; i < 2; i += 1)
      expect(reloaded.view().items.filter(item => String(item.body.id).startsWith(i + "-")).map(item => item.body.id))
        .toEqual(Array.from({ length: 200 }, (_, index) => `${i}-${index}`));
    await Promise.all([queue.flush(), other.flush()]);
    expect(send.mock.calls.map(([item]) => item.id)).toEqual(order);
    expect(receipts.size).toBe(400);
    await reloaded.load();
    expect(reloaded.view().count).toBe(0);
    expect(reloaded.view().state?.entries).toHaveLength(400);
  }, 15_000);

  it("imports v1 order, preserves an append during import, and remembers IDs after acknowledgement", async () => {
    const { storage, database, queue, open, send } = setup();
    const initial = [rawEntry("z", 99), rawEntry("a", 1)];
    const follower = rawEntry("later", 0);
    storage.setItem(queueKey, JSON.stringify(initial));
    const store = await openMutationStore(database);
    expect(store).toBeTruthy();
    const add = IDBObjectStore.prototype.add;
    let appended = false;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "changes" && !appended) {
        storage.setItem(queueKey, JSON.stringify([...initial, follower]));
        appended = true;
      }
      return add.apply(this, args);
    });

    await queue.refresh();
    expect(JSON.parse(storage.getItem(queueKey)!)).toEqual([follower]);
    expect(await queue.flush()).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.id)).toEqual(["z", "a", "later"]);
    const last = rawEntry("last");
    storage.setItem(queueKey, JSON.stringify([...initial, last]));
    expect(await open().flush()).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.id)).toEqual(["z", "a", "later", "last"]);
    expect(storage.getItem(queueKey)).toBeNull();
  });

  it("imports the oldest pending entries in order without dropping unsaved IDs or replaying duplicates", async () => {
    const { storage, database, queue, open, send } = setup();
    const newer = rawEntry("newer", 50);
    const prefixed = rawEntry("prefixed", 60);
    const first = rawEntry("z", 0);
    const second = rawEntry("a", 0);
    const later = rawEntry("later", 0);
    const prefixedKey = "mingzhang.pending-entry.v1.prefixed";
    const oldest = [first.body, entry("newer", 200), entry("prefixed", 300), second.body, entry("z", 400)];
    storage.setItem(queueKey, JSON.stringify([newer]));
    storage.setItem(prefixedKey, JSON.stringify({ entry: prefixed.body, queued_at: prefixed.createdAt }));
    storage.setItem(oldestEntryKey, JSON.stringify(oldest));

    const store = (await openMutationStore(database))!;
    const add = IDBObjectStore.prototype.add;
    let full = true;
    let appended = false;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "changes") {
        if (full) throw new DOMException("full", "QuotaExceededError");
        if (!appended) {
          storage.setItem(oldestEntryKey, JSON.stringify([...oldest, later.body]));
          appended = true;
        }
      }
      return add.apply(this, args);
    });

    await queue.refresh();
    expect(storage.getItem(oldestEntryKey)).toBe(JSON.stringify(oldest));
    expect(await store.list()).toEqual([]);

    full = false;
    await queue.refresh();
    expect((await store.list()).map(record => record.item)).toEqual([newer, prefixed, first, second]);
    expect(storage.getItem(oldestEntryKey)).toBe(JSON.stringify([later.body]));
    expect(storage.getItem(prefixedKey)).toBeNull();
    expect(storage.getItem(queueKey)).toBeNull();

    expect(await open().flush()).toBe("synced");
    storage.setItem(oldestEntryKey, JSON.stringify(oldest));
    expect(await open().flush()).toBe("idle");
    expect(send.mock.calls.map(([item]) => item)).toEqual([newer, prefixed, first, second, later]);
    expect(storage.getItem(oldestEntryKey)).toBeNull();
  });

  it("persists a blocked head across reloads and sends the replacement in the same position with a fresh receipt", async () => {
    const { queue, open, send } = setup();
    await queue.refresh();
    await queue.enqueue(createEntry("first"));
    await queue.enqueue(createEntry("later"));
    send.mockRejectedValueOnce(reject());
    expect(await queue.flush()).toBe("blocked");
    const reloaded = open();
    await reloaded.load();
    const target = reloaded.blocked()!;
    expect(target).toMatchObject({ body: { id: "first" }, blocked: { status: 400, at: expect.any(Number) } });
    expect(reloaded.view().state?.entries).toHaveLength(2);
    expect(await reloaded.flush()).toBe("idle");
    expect(await reloaded.flush({ kind: "edit", target, change: createEntry("replacement") })).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.body.id)).toEqual(["first", "replacement", "later"]);
    expect(send.mock.calls[1][0].id).not.toBe(target.id);
    expect(send.mock.calls[1][0].createdAt).toBe(target.createdAt);
    expect(reloaded.view().count).toBe(0);
  });

  it.each(["network", "timeout", "unavailable"] as const)("automatically retries an edited payload after %s", async kind => {
    const { queue, send, open } = setup();
    const replacement = createEntry("replacement");
    await queue.enqueue(createEntry("original"));
    send.mockRejectedValueOnce(reject()).mockRejectedValueOnce(new RequestError(kind, "temporary"));
    await queue.flush();
    expect(await queue.flush({ kind: "edit", target: queue.blocked()!, change: replacement })).toBe("retryable");
    const other = open();
    await other.load();
    expect(other.view()).toMatchObject({ count: 1, blocked: null });
    expect(await other.flush()).toBe("synced");
    expect(send.mock.calls[2][0].body).toEqual(replacement.body);
  });

  it("checks the live receipt before confirmation, removes only the confirmed discard and flushes the follower", async () => {
    const { queue, send, fetchReceipt } = setup();
    await queue.refresh();
    await queue.enqueue(createEntry("discard"));
    await queue.enqueue(createEntry("follower"));
    send.mockRejectedValueOnce(reject());
    await queue.flush();
    const confirm = vi.fn(() => {
      expect(fetchReceipt).toHaveBeenLastCalledWith(queue.blocked()!.id);
      return true;
    });
    const cancelled = discard(queue.blocked()!, vi.fn(() => false));
    expect(await queue.flush(cancelled)).toBe("cancelled");
    expect(queue.view().count).toBe(2);
    expect(await queue.flush(discard(queue.blocked()!, confirm))).toBe("synced");
    expect(queue.view().state?.entries.map(item => item.id)).toEqual(["follower"]);
    expect(queue.view().count).toBe(0);
    expect(send.mock.calls.map(([item]) => item.body.id)).toEqual(["discard", "follower"]);
  });

  it("acknowledges a retry with a lost response before offering discard confirmation", async () => {
    const { queue, send, commit, fetchReceipt, open } = setup(withCatalog);
    await queue.refresh();
    await queue.enqueue(category("已提交", 1));
    send.mockRejectedValueOnce(reject()).mockImplementationOnce(async item => {
      commit(item);
      throw new RequestError("network", "response lost");
    });
    await queue.flush();
    const target = queue.blocked()!;
    expect(await queue.flush({ kind: "retry", target })).toBe("retryable");
    const other = open();
    await other.load();
    const confirm = vi.fn(() => true);
    expect(await other.flush(discard(target, confirm))).toBe("already-synced");
    expect(fetchReceipt).toHaveBeenCalledWith(target.id);
    expect(confirm).not.toHaveBeenCalled();
    expect(other.view().state?.category_catalog?.version).toBe(2);
    expect(other.view().count).toBe(0);
  });

  it("guards an active retry in another tab for longer than three request deadlines", async () => {
    const { queue, open, send, fetchReceipt } = setup();
    await queue.refresh();
    await queue.enqueue(createEntry("race"));
    send.mockRejectedValueOnce(reject());
    await queue.flush();
    const target = queue.blocked()!;
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    let release!: () => void;
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    send.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; entered(); }));
    const retry = queue.flush({ kind: "retry", target });
    await sending;
    clock.mockReturnValue(start + 3 * requestDeadlineMs + 1000);
    expect(inFlightTimeout).toBeGreaterThan(3 * requestDeadlineMs);
    const other = open();
    await other.load();
    expect(await other.flush(discard(target))).toBe("in-flight");
    expect(fetchReceipt).not.toHaveBeenCalled();
    release();
    expect(await retry).toBe("synced");
    await other.load();
    expect(other.view().count).toBe(0);
  });

  it("checks the receipt after the record's in-flight timeout", async () => {
    const { queue, database, open, commit, send } = setup();
    await queue.refresh();
    await queue.enqueue(createEntry("abandoned"));
    send.mockRejectedValueOnce(reject());
    await queue.flush();
    const target = queue.blocked()!;
    const store = (await openMutationStore(database))!;
    await store.changeHead(target.id, head => ({ ...head, status: "in_flight", since: Date.now() - inFlightTimeout, attempt: "abandoned-tab" }));
    commit(target);
    const reloaded = open();
    await reloaded.load();
    expect(await reloaded.flush(discard(target))).toBe("already-synced");
    expect(reloaded.view().count).toBe(0);
  });

  it("keeps retry behind a discard in progress in another tab", async () => {
    const { queue, open, send, fetchReceipt } = setup();
    await queue.refresh();
    await queue.enqueue(createEntry("discard-race"));
    send.mockRejectedValueOnce(reject());
    await queue.flush();
    const target = queue.blocked()!;
    let reply!: () => void;
    let entered!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    fetchReceipt.mockImplementationOnce(() => new Promise(resolve => {
      reply = () => resolve({ committed: false, result: null, ledger_epoch: "original" });
      entered();
    }));

    const discarding = queue.flush(discard(target));
    await checking;
    expect(await open().flush({ kind: "retry", target })).toMatchObject({ wait: "sending" });
    reply();
    expect(await discarding).toBe("synced");
    expect(send).toHaveBeenCalledOnce();
    expect(queue.view().count).toBe(0);
  });

  it("acknowledges the current head while a new IndexedDB change is appended during the snapshot request", async () => {
    const { queue, open, fetchSnapshot, serverSnapshot, send } = setup();
    await queue.enqueue(createEntry("head"));
    fetchSnapshot.mockImplementationOnce(async ids => {
      await open().enqueue(createEntry("added-during-send"));
      return serverSnapshot(ids);
    });
    expect(await queue.flush()).toBe("synced");
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([item]) => item.body.id)).toEqual(["head", "added-during-send"]);
    expect(queue.view().count).toBe(0);
  });

  it("rebuilds from a receipt-covered snapshot without replaying a committed catalog change", async () => {
    const { queue, send, commit, open } = setup(withCatalog);
    await queue.enqueue(category("已提交", 1));
    send.mockImplementationOnce(async item => { commit(item); throw new RequestError("timeout", "response lost"); });
    expect(await queue.flush()).toBe("retryable");
    const other = open();
    await other.refresh();
    expect(other.view().state?.category_catalog?.version).toBe(2);
    await other.enqueue(category("随后提交", other.view().state!.category_catalog!.version));
    expect(await other.flush()).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.body.version)).toEqual([1, 1, 2]);
    expect(send.mock.calls[1][0].id).toBe(send.mock.calls[0][0].id);
    expect(other.view().state?.category_catalog?.version).toBe(3);
  });

  it("refreshes receipt coverage when a v1 tab appends and commits during a snapshot request", async () => {
    const { storage, queue, commit, serverSnapshot, fetchSnapshot } = setup(withCatalog);
    const head = { ...category("先提交", 1), id: "head", createdAt: 1 };
    const follower = { ...category("稍后提交", 2), id: "follower", createdAt: 2 };
    storage.setItem(queueKey, JSON.stringify([head]));
    commit(head);
    fetchSnapshot.mockImplementationOnce(async ids => {
      storage.setItem(queueKey, JSON.stringify([follower]));
      commit(follower);
      return serverSnapshot(ids);
    });
    await queue.refresh();
    expect(fetchSnapshot.mock.calls.map(([ids]) => ids)).toEqual([[head.id], [head.id, follower.id]]);
    expect(queue.view().state?.category_catalog?.version).toBe(3);
  });

  it("keeps a rejection visible and disables discard without a server snapshot", async () => {
    const { storage, queue, send, fetchReceipt, open } = setup();
    storage.setItem("mingzhang.local-state.v1", JSON.stringify({ state: snapshot, applied: [] }));
    await queue.enqueue(createEntry("offline"));
    send.mockRejectedValueOnce(reject());
    await queue.flush();
    const reloaded = open();
    await reloaded.load();
    const target = reloaded.blocked()!;
    const callbacks = { onRetry: vi.fn(), onEdit: vi.fn(), onRebase: vi.fn(), onOpenSettings: vi.fn(), onDiscard: vi.fn() };
    const panel = renderToStaticMarkup(createElement(BlockedSyncDetails, { item: target, state: null, waiting: 0, ...callbacks }));
    expect(panel).toContain("联网后才能放弃这条修改");
    expect(panel).toMatch(/discard-sync" disabled="">放弃这条修改/);
    expect(await reloaded.flush(discard(target))).toBe("no-snapshot");
    expect(fetchReceipt).not.toHaveBeenCalled();
    expect(reloaded.view()).toMatchObject({ count: 1, state: null, blocked: target });
  });

  it("leaves the blocked item untouched when the receipt check is offline", async () => {
    const { queue, send, fetchReceipt } = setup();
    await queue.refresh();
    await queue.enqueue(createEntry("offline"));
    send.mockRejectedValueOnce(reject());
    await queue.flush();
    fetchReceipt.mockRejectedValueOnce(new RequestError("network", "offline"));
    const action = discard(queue.blocked()!);
    expect(await queue.flush(action)).toBe("receipt-unavailable");
    expect(action.confirm).not.toHaveBeenCalled();
    expect(queue.view().count).toBe(1);
  });

  it("keeps FIFO memory saves after IndexedDB quota errors and persists them after acknowledgements", async () => {
    const { queue, database, send } = setup();
    await queue.refresh();
    await queue.enqueue(createEntry("durable"));
    const store = (await openMutationStore(database))!;
    const add = IDBObjectStore.prototype.add;
    let full = true;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "changes" && full) throw new DOMException("full", "QuotaExceededError");
      return add.apply(this, args);
    });
    await queue.enqueue(createEntry("memory1"));
    await queue.enqueue(createEntry("memory2"));
    expect(queue.view()).toMatchObject({ count: 3, memoryCount: 2, storageError: true });
    expect((await store.list()).map(record => record.item.body.id)).toEqual(["durable"]);
    send.mockImplementationOnce(async () => { full = false; })
      .mockImplementationOnce(async () => {
        expect((await store.list()).map(record => record.item.body.id)).toEqual(["memory1", "memory2"]);
      });
    expect(await queue.flush()).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.body.id)).toEqual(["durable", "memory1", "memory2"]);
    expect(queue.view()).toMatchObject({ count: 0, memoryCount: 0, storageError: false });
  });

  it("drains even with a full snapshot cache and preserves the latest snapshot in memory", async () => {
    const { queue, send, storage } = setup();
    storage.rejectWritesTo = [snapshotKey];
    await queue.enqueue(createEntry("durable"));
    expect(await queue.flush()).toBe("synced");
    expect(send).toHaveBeenCalledOnce();
    expect(queue.view().state?.entries[0].id).toBe("durable");
    expect(storage.getItem(snapshotKey)).toBeNull();
  });

  it.each(["startup", "snapshot write"])("frees space from the v1 snapshot at %s", async when => {
    const { queue, storage, database, fetchSnapshot, serverSnapshot } = setup();
    const legacySnapshotKey = "mingzhang.local-state.v1";
    const legacy = rawEntry("legacy");
    const v1 = JSON.stringify([legacy]);
    const unrelated = "keep";
    const oldCache = JSON.stringify({ state: snapshot, applied: [], padding: "x".repeat(2000) });
    storage.setItem(queueKey, v1);
    storage.setItem("other-app", unrelated);
    storage.maxCharacters = v1.length + oldCache.length + unrelated.length;
    if (when === "startup") storage.setItem(legacySnapshotKey, oldCache);
    const removeItem = storage.removeItem.bind(storage);
    vi.spyOn(storage, "removeItem").mockImplementation(key => {
      if (key === legacySnapshotKey && storage.getItem(key)) expect(storage.getItem(queueKey)).toBeNull();
      removeItem(key);
    });
    fetchSnapshot.mockImplementationOnce(async ids => {
      if (when === "snapshot write") {
        storage.maxCharacters = oldCache.length + unrelated.length;
        storage.setItem(legacySnapshotKey, oldCache);
      } else expect(storage.getItem(legacySnapshotKey)).toBeNull();
      return serverSnapshot(ids);
    });

    await queue.refresh();

    expect(storage.getItem(legacySnapshotKey)).toBeNull();
    expect(storage.getItem("other-app")).toBe(unrelated);
    expect(JSON.parse(storage.getItem(snapshotKey)!)).toEqual(serverSnapshot([]));
    expect(await (await openMutationStore(database))!.list()).toMatchObject([{ item: legacy }]);
  });

  it("evicts the obsolete snapshot to cache a refresh with IndexedDB disabled", async () => {
    const database = new IDBFactory();
    vi.spyOn(database, "open").mockImplementation(() => { throw new DOMException("disabled", "SecurityError"); });
    const { queue, storage, serverSnapshot } = setup(snapshot, database);
    const oldCache = JSON.stringify({ state: snapshot, applied: [], padding: "x".repeat(2000) });
    const legacySnapshotKey = "mingzhang.local-state.v1";
    const legacy = rawEntry("queued");
    const v1 = JSON.stringify([legacy]);
    const blocked = { status: 400, message: "rejected", at: 1 };
    const rejections = JSON.stringify({ [legacy.id]: blocked });
    const prefixedKey = "mingzhang.pending-entry.v1.prefixed";
    const prefixed = JSON.stringify(entry("prefixed"));
    const oldest = JSON.stringify([entry("oldest")]);
    storage.setItem(legacySnapshotKey, oldCache);
    storage.setItem(queueKey, v1);
    storage.setItem(blockedKey, rejections);
    storage.setItem(prefixedKey, prefixed);
    storage.setItem(oldestEntryKey, oldest);
    storage.maxCharacters = oldCache.length + v1.length + rejections.length + prefixed.length + oldest.length;

    await queue.refresh();

    expect(storage.getItem(legacySnapshotKey)).toBeNull();
    expect(JSON.parse(storage.getItem(snapshotKey)!)).toEqual(serverSnapshot([]));
    expect(storage.getItem(queueKey)).toBe(v1);
    expect(storage.getItem(blockedKey)).toBe(rejections);
    expect(storage.getItem(prefixedKey)).toBe(prefixed);
    expect(storage.getItem(oldestEntryKey)).toBe(oldest);
    expect(queue.view()).toMatchObject({ fallback: true, blocked: { ...legacy, blocked } });
  });

  it.each([queueKey, oldestEntryKey])("drains %s when IndexedDB open fails and storage is at quota", async key => {
    const database = new IDBFactory();
    vi.spyOn(database, "open").mockImplementation(() => { throw new DOMException("disabled", "SecurityError"); });
    const { queue, storage, send } = setup(snapshot, database);
    const legacy = { ...rawEntry("legacy"), body: { ...entry("legacy"), memo: "x".repeat(2000) } };
    const v1 = JSON.stringify([key === oldestEntryKey ? legacy.body : legacy]);
    storage.setItem(key, v1);
    storage.maxCharacters = v1.length;
    await queue.enqueue(createEntry("memory"));
    expect(queue.view()).toMatchObject({ fallback: true, count: 2, memoryCount: 1 });
    expect(storage.getItem(key)).toBe(v1);
    expect(await queue.flush()).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.body.id)).toEqual(["legacy", "memory"]);
    expect(storage.getItem(key)).toBeNull();
    expect(storage.getItem(queueKey)).toBeNull();
  });

  it("preserves blocked metadata and supports retry and discard in the v1 fallback", async () => {
    const database = new IDBFactory();
    vi.spyOn(database, "open").mockImplementation(() => { throw new DOMException("disabled", "SecurityError"); });
    const { queue, storage, open, send } = setup(snapshot, database);
    await queue.refresh();
    await queue.enqueue(createEntry("reject"));
    send.mockRejectedValueOnce(reject()).mockRejectedValueOnce(reject("still rejected", 409));
    expect(await queue.flush()).toBe("blocked");
    expect(storage.getItem(blockedKey)).toContain(queue.blocked()!.id);
    const other = open();
    await other.load();
    expect(await other.flush({ kind: "retry", target: other.blocked()! })).toBe("blocked");
    expect(other.blocked()?.blocked.status).toBe(409);
    expect(await other.flush(discard(other.blocked()!))).toBe("synced");
    expect(storage.getItem(queueKey)).toBeNull();
    expect(storage.getItem(blockedKey)).toBeNull();
  });

  it("shares Retry-After across tabs without marking the change blocked", async () => {
    const { queue, open, send } = setup();
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    await queue.enqueue(createEntry("rate-limited"));
    send.mockRejectedValueOnce(new RequestError("unavailable", "稍后再试", 429, 3000));
    expect(await queue.flush()).toEqual({ wait: "retry", until: 13_000 });
    expect(await open().flush()).toEqual({ wait: "retry", until: 13_000 });
    expect(send).toHaveBeenCalledOnce();
    clock.mockReturnValue(13_000);
    expect(await open().flush()).toBe("synced");
  });

  it("requires login after a head returns 401 and sends the same unblocked change after sign-in", async () => {
    const { queue, send, receipts, cancelMutation } = setup();
    await queue.enqueue(createEntry("auth"));
    const [head] = queue.view().items;
    send.mockRejectedValueOnce(new RequestError("unauthorized", "重新登录", 401));
    expect(await queue.flush()).toBe("unauthorized");
    expect(queue.view()).toMatchObject({ items: [head], count: 1, blocked: null });
    expect(queue.hasReadyHead()).toBe(true);
    expect(receipts.has(head.id)).toBe(false);
    expect(cancelMutation).not.toHaveBeenCalled();
    await queue.refresh();
    expect(await queue.flush(undefined, () => true)).toBe("synced");
    expect(send.mock.calls).toEqual([[head], [head]]);
    expect(receipts.has(head.id)).toBe(true);
    expect(queue.view()).toMatchObject({ count: 0, blocked: null });
  });
});

describe("blocked sync recovery", () => {
  it("only rebases category additions with no possible overwrite", () => {
    const add = { ...category("新分类", 0), id: "add", createdAt: 1 };
    const deleteCategory = { ...add, body: { ...add.body, action: "delete" } };
    const order = { ...rawEntry("order"), type: "order.update", path: "/display-order" } as const;
    const account = { ...rawEntry("account"), type: "account.update", path: "/accounts/cash" } as const;
    expect(canRebase(add, withCatalog)).toBe(true);
    expect(rebaseChange(add, withCatalog).body.version).toBe(1);
    expect(canRebase(add, { ...withCatalog, category_catalog: { ...withCatalog.category_catalog, hidden: ["新分类"] } })).toBe(false);
    for (const item of [deleteCategory, order, account]) expect(canRebase(item, withCatalog)).toBe(false);
  });

  it.each(["account.update", "order.update"] as const)("offers latest settings instead of rebase for %s", type => {
    const body = type === "order.update" ? { accounts: ["cash"], categories: [], version: 0 } : entry("cash");
    const item = { ...rawEntry("stale"), type, body, blocked: { status: 409, message: "过期", at: 1 } };
    const callbacks = { onRetry: vi.fn(), onEdit: vi.fn(), onRebase: vi.fn(), onOpenSettings: vi.fn(), onDiscard: vi.fn() };
    const panel = renderToStaticMarkup(createElement(BlockedSyncDetails, { item, state: snapshot, waiting: 0, ...callbacks }));
    expect(panel).toContain("打开最新设置");
    expect(panel).toContain("覆盖其他设备");
    expect(panel).not.toContain("基于最新数据重新同步");
  });

  it("starts stale edits with every current field and saves only visible choices", () => {
    const current = { ...entry("existing", 350, 4), merchant: "新商家", memo: "新备注", reference_id: "latest-reference" };
    const queued = { ...entry("existing", 200, 1), merchant: "旧商家", memo: "旧备注" };
    const target = { ...createEntry("existing"), type: "entry.update", method: "PUT", path: "/entries/existing",
      body: queued, id: "stale", createdAt: 1, blocked: { status: 409, at: 12, message: "版本已更新" } } as const;
    const recovery = prepareEntryRecovery(target, { ...snapshot, entries: [current] }, entry(""));
    expect(recovery.entry).toEqual(current);
    expect(recovery.queued).toMatchObject({ amount_cents: 200, merchant: "旧商家" });
    const value = { ...recovery.entry, amount_cents: 200 };
    const comparison = renderToStaticMarkup(createElement(EntryRecoveryComparison, {
      current, queued: recovery.queued, value, accounts: snapshot.accounts, entries: [], onChoose: () => {},
    }));
    expect(comparison).toContain("服务器：新商家");
    expect(comparison).toContain("排队修改：旧商家");
    expect(comparison).toContain("将保存：新商家");
    expect(comparison).toContain("服务器：latest-reference");
    expect(comparison).toContain("排队修改：空");
    expect(comparison).toContain("将保存：¥2.00");
    const change = entryRecoveryChange(recovery.entry, true, value);
    expect(change.body).toMatchObject({ amount_cents: 200, merchant: "新商家", memo: "新备注", reference_id: "latest-reference", version: 4 });
    expect(change.body).not.toHaveProperty("remaining_cents");
  });

  it("turns a colliding create into an update on the same entry and current version", () => {
    const current = { ...entry("existing", 350, 4), merchant: "服务器商家" };
    const item = { ...rawEntry("existing"), blocked: { status: 409, message: "编号已使用", at: 1 } };
    const recovery = prepareEntryRecovery(item, { ...snapshot, entries: [current] }, entry(""));
    const change = entryRecoveryChange(recovery.entry, Boolean(recovery.current), { ...recovery.entry, amount_cents: 200 });
    expect(change).toMatchObject({
      type: "entry.update", method: "PUT", path: "/entries/existing",
      body: { id: current.id, version: current.version, amount_cents: 200, merchant: current.merchant },
    });
  });

  it("lists named before-to-after order and favorite differences for discard", () => {
    const state = { ...snapshot, accounts: [...snapshot.accounts, { ...snapshot.accounts[0], id: "bank", name: "银行卡" }],
      ordering: { accounts: ["cash", "bank"], categories: ["A", "B"], favorites: ["A"], version: 3 },
      category_catalog: { items: { A: ["expense"], B: ["expense"] }, hidden: [], version: 1 } };
    const item = { id: "order", type: "order.update", path: "/display-order", method: "PUT", createdAt: 1,
      body: { accounts: ["bank", "cash"], categories: ["B", "A"], favorites: ["B"], version: 2 },
      blocked: { status: 409, message: "排序已更新", at: 1 } } as const;
    expect(describeBlocked(item, state).fields).toEqual([
      ["账户顺序", "「现金」、「银行卡」 → 「银行卡」、「现金」"],
      ["分类顺序", "「A」、「B」 → 「B」、「A」"],
      ["常用分类", "移除「A」，加入「B」（「A」 → 「B」）"],
    ]);
  });
});

describe("request failures", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("recognizes a cancellation separately from a normal HTTP 409 rejection", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({
      code: "mutation_cancelled", detail: "server wording",
    }, { status: 409 })));
    await expect(api("/entries", {})).rejects.toMatchObject({ kind: "cancelled", status: 409 });
  });

  it.each([
    [401, "any wording", "unauthorized", "请重新登录"],
    [400, "无法连接", "rejected", "无法连接"],
    [409, "请求超时", "rejected", "请求超时"],
    [503, "金额错误", "unavailable", "金额错误"],
  ])("classifies HTTP %i without interpreting its message", async (status, detail, kind, message) => {
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ detail }, { status })));
    await expect(api("/state")).rejects.toMatchObject({ status, kind, message });
  });

  it.each([
    [new TypeError("fetch failed"), "network"],
    [new DOMException("deadline", "TimeoutError"), "timeout"],
  ])("classifies transport failures", async (error, kind) => {
    vi.stubGlobal("fetch", () => Promise.reject(error));
    await expect(api("/state")).rejects.toMatchObject({ kind });
  });

  it.each([
    [408, "7", "timeout", 7000],
    [429, new Date("2026-04-02T12:00:09Z").toUTCString(), "unavailable", 9000],
    [429, "invalid", "unavailable", undefined],
  ])("honors HTTP %i Retry-After %s without classifying it as rejected", async (status, header, kind, retryAfterMs) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-02T12:00:00Z"));
    try {
      vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ detail: "稍后再试" }, { status, headers: { "Retry-After": header } })));
      await expect(api("/state")).rejects.toMatchObject({ kind, status, retryAfterMs });
    } finally {
      now.mockRestore();
    }
  });
});
