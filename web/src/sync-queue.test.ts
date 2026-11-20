import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueueLock, createSyncQueue } from "./sync-queue";
import { canRebase, describeBlocked, EntryRecoveryComparison, entryRecoveryChange, prepareEntryRecovery, rebaseChange } from "./blocked-sync";
import { api, RequestError, type Entry, type State } from "./types";
import { applyMutation, type OfflineMutation } from "./offline-mutations";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  onReadLength?: () => void;
  get length() {
    this.onReadLength?.();
    return this.values.size;
  }
  getItem(key: string) { return this.values.get(key) ?? null; }
  maxCharacters = Infinity;
  rejectWritesTo: string[] = [];
  rejectNextWriteTo?: string;
  onRemove?: (key: string) => void;
  setItem(key: string, value: string) {
    const otherSize = [...this.values].reduce((sum, [name, raw]) => name === key ? sum : sum + raw.length, 0);
    const rejectOnce = this.rejectNextWriteTo === key;
    if (rejectOnce) this.rejectNextWriteTo = undefined;
    if (rejectOnce || this.rejectWritesTo.includes(key) || otherSize + value.length > this.maxCharacters) {
      throw new DOMException("storage is full", "QuotaExceededError");
    }
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); this.onRemove?.(key); }
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

function setup(initial = snapshot, withoutWebLocks = false, withLeaseStore = false) {
  const storage = new MemoryStorage();
  const locks = new Map<string, Promise<unknown>>();
  type Lock = Parameters<typeof createSyncQueue>[0]["lock"];
  type LeaseStore = NonNullable<Parameters<Parameters<Lock>[1]>[0]>;
  let lease: LeaseStore["value"] = null;
  const lock: Lock = (name, run) => {
    const next = (locks.get(name) ?? Promise.resolve()).then(() =>
      run(withLeaseStore && name === sharedKey ? { value: lease, save: value => { lease = value; } } : undefined));
    locks.set(name, next.catch(() => undefined));
    return next;
  };
  const send = vi.fn(async (_item: OfflineMutation): Promise<unknown> => undefined);
  let server = initial;
  const receipts = new Set<string>();
  function commit(item: OfflineMutation) {
    if (receipts.has(item.id)) return;
    server = applyMutation(server, item);
    receipts.add(item.id);
  }
  const serverSnapshot = (ids: string[]) => ({ snapshot: server, committed: ids.filter(id => receipts.has(id)) });
  const fetchSnapshot = vi.fn(async (ids: string[]) => serverSnapshot(ids));
  const open = () => createSyncQueue({ storage, lock: withoutWebLocks ? createQueueLock() : lock,
    send: async item => { await send(item); commit(item); }, fetchSnapshot });
  return { storage, send, fetchSnapshot, commit, serverSnapshot, open, queue: open() };
}

const reject = (message = "请选择有效的账户", status = 400) => new RequestError("rejected", message, status);

describe("sync queue", () => {
  it("keeps a rejected head and its followers across reloads, without sending on automatic triggers", async () => {
    const { queue, send, open } = setup();
    await queue.enqueue(createEntry("first"));
    await queue.enqueue(createEntry("later"));
    send.mockRejectedValueOnce(reject());
    expect(await queue.flush()).toBe("blocked");
    const afterReload = open();
    const blocked = afterReload.view().blocked!;
    expect(blocked).toMatchObject({ body: { id: "first" }, blocked: { status: 400, message: "请选择有效的账户", at: expect.any(Number) } });
    expect(afterReload.view().count).toBe(2);
    await afterReload.enqueue(createEntry("newest"));
    expect(await afterReload.flush()).toBe("idle");
    expect(send.mock.calls.map(([item]) => item.body.id)).toEqual(["first"]);
    expect(afterReload.view().state?.entries).toHaveLength(3);
  });

  it("retries the same receipt and payload explicitly, then drains in order on success", async () => {
    const { queue, send } = setup();
    await queue.enqueue(createEntry("first"));
    await queue.enqueue(createEntry("later"));
    send.mockRejectedValueOnce(reject()).mockRejectedValueOnce(reject("版本已更新", 409));
    await queue.flush();
    const target = queue.view().blocked!;
    expect(await queue.flush({ kind: "retry", target })).toBe("blocked");
    const latest = queue.view().blocked!;
    expect(latest.blocked).toMatchObject({ status: 409, message: "版本已更新" });
    expect(queue.view().count).toBe(2);
    expect(await queue.flush({ kind: "retry", target: latest })).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.body.id)).toEqual(["first", "first", "first", "later"]);
    expect(send.mock.calls.slice(0, 3).map(([item]) => item.id)).toEqual(Array(3).fill(target.id));
    expect(send.mock.calls.slice(0, 3).map(([item]) => item.body)).toEqual(Array(3).fill(target.body));
    expect(queue.view().count).toBe(0);
  });

  it("edits in place with a new receipt and keeps the replacement if the retry fails", async () => {
    const original = entry("existing", 100, 4);
    const { queue, send, open } = setup({ ...snapshot, entries: [original] });
    await queue.enqueue({ ...createEntry(original.id), type: "entry.update", path: "/entries/existing", method: "PUT" });
    await queue.enqueue(createEntry("later"));
    send.mockRejectedValueOnce(reject("版本已更新", 409)).mockRejectedValueOnce(reject("金额无效"));
    await queue.flush();
    const target = queue.view().blocked!;
    const body = entry(original.id, 200, original.version);
    expect(await queue.flush({ kind: "edit", target, change: { type: target.type, path: target.path, method: target.method, body } })).toBe("blocked");
    const replacement = open().view().blocked!;
    expect(replacement).toMatchObject({ body, path: target.path, createdAt: target.createdAt });
    expect(replacement.id).not.toBe(target.id);
    expect(send.mock.calls[1][0].body).toEqual(body);
    expect(await queue.flush({ kind: "discard", target })).toBe("changed");
    expect(await queue.flush({ kind: "retry", target: replacement })).toBe("synced");
    expect(queue.view().state?.entries.find(item => item.id === original.id)).toMatchObject({ amount_cents: 200, version: 5 });
    expect(send.mock.calls.at(-1)?.[0].body.id).toBe("later");
  });

  it("discards only the confirmed change, rolls back its local effect, and retains earlier successes", async () => {
    const { queue, send, open } = setup();
    for (const id of ["accepted", "rejected", "later"]) await queue.enqueue(createEntry(id));
    send.mockResolvedValueOnce(undefined).mockRejectedValueOnce(reject())
      .mockRejectedValueOnce(new RequestError("network", "offline"));
    await queue.flush();
    const beforeDiscard = queue.view();
    expect(beforeDiscard.state?.accounts[0].balance_cents).toBe(9700);
    const onDiscard = vi.fn(() => expect(queue.view().state?.accounts[0].balance_cents).toBe(9800));
    expect(await queue.flush({ kind: "discard", target: beforeDiscard.blocked! }, onDiscard)).toBe("retryable");
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(open().view()).toMatchObject({ count: 1, blocked: null });
    expect(open().view().state?.entries.map(item => item.id)).toEqual(["later", "accepted"]);
    expect(await queue.flush()).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.body.id)).toEqual(["accepted", "rejected", "later", "later"]);
  });

  it.each(["network", "timeout", "unavailable"] as const)("allows automatic retry after %s", async kind => {
    const { queue, send } = setup();
    await queue.enqueue(createEntry("first"));
    send.mockRejectedValueOnce(new RequestError(kind, "temporary", kind === "unavailable" ? 503 : undefined));
    expect(await queue.flush()).toBe("retryable");
    expect(queue.view()).toMatchObject({ count: 1, blocked: null });
    expect(await queue.flush()).toBe("synced");
  });

  it("requests re-login on 401 and keeps the queue eligible after login", async () => {
    const { queue, send } = setup();
    await queue.enqueue(createEntry("first"));
    send.mockRejectedValueOnce(new RequestError("unauthorized", "请重新登录", 401));
    expect(await queue.flush()).toBe("unauthorized");
    expect(queue.view()).toMatchObject({ count: 1, blocked: null });
    expect(await queue.flush()).toBe("synced");
  });

  it("keeps the block if an explicit replay meets a temporary failure or expired session", async () => {
    const { queue, send } = setup();
    await queue.enqueue(createEntry("first"));
    send.mockRejectedValueOnce(reject())
      .mockRejectedValueOnce(new RequestError("timeout", "timeout"))
      .mockRejectedValueOnce(new RequestError("unauthorized", "expired", 401));
    await queue.flush();
    const target = queue.view().blocked!;
    expect(await queue.flush({ kind: "retry", target })).toBe("retryable");
    expect(await queue.flush()).toBe("idle");
    expect(await queue.flush({ kind: "retry", target })).toBe("unauthorized");
    expect(await queue.flush()).toBe("idle");
    expect(queue.view().blocked).toEqual(target);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("serializes two tabs while allowing either tab to save locally during a request", async () => {
    const { queue, send, open } = setup();
    const second = open();
    await queue.enqueue(createEntry("first"));
    let signalStarted!: () => void;
    let resolveResponse!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const response = new Promise<void>(resolve => { resolveResponse = resolve; });
    send.mockImplementationOnce(async () => {
      signalStarted();
      return response;
    });
    const firstFlush = queue.flush();
    await started;
    await second.enqueue(createEntry("later"));
    const secondFlush = second.flush();
    expect(second.view().count).toBe(2);
    expect(send).toHaveBeenCalledOnce();
    resolveResponse();
    expect(await firstFlush).toBe("synced");
    expect(await secondFlush).toBe("idle");
    expect(send.mock.calls.map(([item]) => item.body.id)).toEqual(["first", "later"]);
  });

  it("opens the previous queue and cached ledger offline without double-applying changes", async () => {
    const { storage, queue, fetchSnapshot, open } = setup();
    const previous = { ...createEntry("old"), id: "pending-old", createdAt: 100 };
    storage.setItem("mingzhang.offline-mutations.v1", JSON.stringify([previous]));
    storage.setItem("mingzhang.local-state.v1", JSON.stringify({ state: { ...snapshot, entries: [entry("old")] }, applied: [previous.id] }));
    fetchSnapshot.mockRejectedValueOnce(new RequestError("network", "offline"));
    await queue.enqueue(createEntry("later"));
    expect(await queue.flush()).toBe("retryable");
    expect(open().view().state?.entries.map(item => item.id)).toEqual(["later", "old"]);
    expect(open().view().count).toBe(2);
  });
});

const sharedKey = "mingzhang.offline-mutations.v1";
const sidecarKey = "mingzhang.offline-mutations.blocked.v1";
const cacheKey = "mingzhang.sync-snapshot.v1";
const openQueue = (storage: Storage): OfflineMutation[] => JSON.parse(storage.getItem(sharedKey) ?? "[]");

describe("review regressions", () => {
  it("shares the original array and sees an older tab append after rejection", async () => {
    const { storage, queue, send, open } = setup();
    const old = { ...createEntry("old"), id: "old-client", createdAt: 1 };
    storage.setItem(sharedKey, JSON.stringify([old]));
    send.mockRejectedValueOnce(reject());
    expect(await queue.flush()).toBe("blocked");
    expect(JSON.parse(storage.getItem(sharedKey)!)).toEqual([old]);
    expect(JSON.parse(storage.getItem(sidecarKey)!)).toEqual({ [old.id]: expect.objectContaining({ status: 400 }) });

    const appended = { ...createEntry("later"), id: "old-client-later", createdAt: 2 };
    storage.setItem(sharedKey, JSON.stringify([old, appended]));
    const reloaded = open();
    expect(reloaded.view().count).toBe(2);
    expect(reloaded.blocked()?.id).toBe(old.id);
    // An older client may remove the blocked head without knowing about its metadata.
    storage.setItem(sharedKey, JSON.stringify([appended]));
    expect(reloaded.blocked()).toBeNull();
    expect(await reloaded.flush()).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.id)).toEqual([old.id, appended.id]);
  });

  it("refreshes and flushes when an old snapshot leaves no quota for a new cache", async () => {
    const { storage, queue, send } = setup();
    const old = { ...createEntry("old"), id: "old-client", createdAt: 1 };
    storage.setItem(sharedKey, JSON.stringify([old]));
    storage.setItem("mingzhang.local-state.v1", "x".repeat(3700));
    storage.maxCharacters = 4050;
    await expect(queue.refresh()).resolves.toEqual(snapshot);
    expect(await queue.flush()).toBe("synced");
    expect(send).toHaveBeenCalledExactlyOnceWith(old);
    expect(queue.view().state?.entries.map(item => item.id)).toEqual(["old"]);
  });

  it("evicts cached state and drains the durable head before persisting an in-memory save", async () => {
    const { storage, queue, send } = setup();
    await queue.refresh();
    storage.setItem("mingzhang.local-state.v1", "x".repeat(3700));
    storage.maxCharacters = 4250;
    await queue.enqueue(createEntry("priority"));
    expect(storage.getItem("mingzhang.local-state.v1")).toBeNull();
    expect(queue.view()).toMatchObject({ count: 1, storageError: false });

    const durable = storage.getItem(sharedKey)!;
    storage.maxCharacters = durable.length + 256;
    await queue.enqueue(createEntry("memory"));
    await queue.enqueue(createEntry("memory2"));
    expect(queue.view()).toMatchObject({ count: 3, storageError: true });
    expect(openQueue(storage)).toEqual(JSON.parse(durable));
    expect(queue.view().state?.entries.map(value => value.id)).toContain("memory");
    send.mockImplementationOnce(async () => {
      expect(openQueue(storage)).toEqual(JSON.parse(durable));
    }).mockImplementationOnce(async () => {
      expect(openQueue(storage).map(item => item.body.id)).toEqual(["memory"]);
      expect(queue.view().memoryCount).toBe(1);
    }).mockImplementationOnce(async () => {
      expect(openQueue(storage).map(item => item.body.id)).toEqual(["memory2"]);
      expect(queue.view().memoryCount).toBe(0);
    });
    expect(await queue.flush()).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.body.id)).toEqual(["priority", "memory", "memory2"]);
    expect(queue.view()).toMatchObject({ count: 0, storageError: false, memoryCount: 0 });
  });

  it("refreshes, flushes, retries and discards without Web Locks", async () => {
    const { queue, send } = setup(snapshot, true);
    await expect(queue.refresh()).resolves.toEqual(snapshot);
    await queue.enqueue(createEntry("first"));
    await queue.enqueue(createEntry("later"));
    send.mockRejectedValueOnce(reject()).mockRejectedValueOnce(reject());
    expect(await queue.flush()).toBe("blocked");
    expect(await queue.flush({ kind: "retry", target: queue.blocked()! })).toBe("blocked");
    expect(await queue.flush({ kind: "discard", target: queue.blocked()! })).toBe("synced");
    expect(queue.view().count).toBe(0);
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

  it("turns a colliding create into a PUT using the same entry id and latest version", async () => {
    const current = { ...entry("existing", 350, 4), merchant: "服务器商家" };
    const server = { ...snapshot, entries: [current] };
    const { queue, send } = setup(server);
    await queue.enqueue(createEntry("existing"));
    await queue.enqueue(createEntry("later"));
    send.mockRejectedValueOnce(reject("编号已使用", 409));
    await queue.flush();
    const target = queue.blocked()!;
    const recovery = prepareEntryRecovery(target, server, entry(""));
    const change = entryRecoveryChange(recovery.entry, Boolean(recovery.current), { ...recovery.entry, amount_cents: 200 });
    expect(await queue.flush({ kind: "edit", target, change })).toBe("synced");
    expect(send.mock.calls[1][0]).toMatchObject({
      type: "entry.update", method: "PUT", path: "/entries/existing",
      body: { id: current.id, version: current.version, amount_cents: 200, merchant: current.merchant },
    });
    expect(send.mock.calls[2][0].body.id).toBe("later");
  });

  it.each(["network", "timeout", "unavailable"] as const)("automatically retries an edited payload after %s", async kind => {
    const { queue, send, open } = setup();
    const original = createEntry("original");
    await queue.enqueue(original);
    send.mockRejectedValueOnce(reject("版本已更新", 409));
    await queue.flush();
    const target = queue.blocked()!;
    const body = { ...original.body, amount_cents: 300 };
    send.mockRejectedValueOnce(new RequestError(kind, "temporary"));
    const action = { kind: "edit", target, body, change: { ...original, body } } as const;
    expect(await queue.flush(action)).toBe("retryable");
    expect(open().view()).toMatchObject({ count: 1, blocked: null });
    expect(queue.hasReadyHead()).toBe(true);
    expect(await queue.flush()).toBe("synced");
    expect(send.mock.calls[2][0].body).toEqual(body);
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

describe("second review regressions", () => {
  const rawEntry = (id: string, createdAt = 1): OfflineMutation => ({ ...createEntry(id), id, createdAt });
  const category = (path: string, version: number) => ({
    type: "category.change", method: "POST", path: "/categories",
    body: { action: "add", path, level: "parent", kind: "expense", version },
  }) as const;
  const withCatalog = { ...snapshot, category_catalog: { items: {}, hidden: [], version: 1 } };

  it("keeps an older tab's append interleaved with acknowledgement", async () => {
    const { storage, queue, send } = setup(snapshot, true);
    const head = rawEntry("head");
    const follower = rawEntry("follower", 2);
    storage.setItem(sharedKey, JSON.stringify([head]));
    send.mockImplementationOnce(async () => {
      storage.onReadLength = () => {
        storage.onReadLength = undefined;
        storage.setItem(sharedKey, JSON.stringify([...openQueue(storage), follower]));
      };
    });
    expect(await queue.flush()).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.id)).toEqual([head.id, follower.id]);
    expect(openQueue(storage)).toEqual([]);
  });

  it("re-reads the current array when cache eviction interleaves with a legacy append", async () => {
    const { storage, queue, send } = setup(snapshot, true);
    const head = rawEntry("head");
    const follower = rawEntry("follower", 2);
    storage.setItem(sharedKey, JSON.stringify([head]));
    send.mockImplementationOnce(async () => {
      storage.rejectNextWriteTo = sharedKey;
      storage.onRemove = key => {
        if (key !== cacheKey) return;
        storage.onRemove = undefined;
        storage.setItem(sharedKey, JSON.stringify([...openQueue(storage), follower]));
      };
    });
    expect(await queue.flush()).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.id)).toEqual([head.id, follower.id]);
  });

  it("drains a completely full legacy queue before a localStorage lease slot exists", async () => {
    const { storage, queue, send } = setup(snapshot, false, true);
    const original = rawEntry("legacy-head");
    const head = { ...original, body: { ...original.body, memo: "x".repeat(400) } };
    storage.setItem(sharedKey, JSON.stringify([head]));
    storage.maxCharacters = storage.getItem(sharedKey)!.length;
    await queue.enqueue(createEntry("z"));
    expect(queue.view()).toMatchObject({ count: 2, storageError: true });
    expect(await queue.flush()).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.body.id)).toEqual(["legacy-head", "z"]);
  });

  it("refuses discard from another tab for the full duration of a retry", async () => {
    const { storage, queue, open, send } = setup(snapshot, true);
    await queue.enqueue(createEntry("retry"));
    send.mockRejectedValueOnce(reject());
    await queue.flush();
    const second = open();
    const target = second.blocked()!;
    let started!: () => void;
    let reply!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    send.mockImplementationOnce(() => new Promise<void>(resolve => { reply = resolve; started(); }));

    const retry = queue.flush({ kind: "retry", target });
    await sending;
    try {
      expect(await second.flush({ kind: "discard", target })).toBe("in-flight");
      expect(openQueue(storage).map(item => item.id)).toEqual([target.id]);
    } finally {
      reply();
      await retry;
    }
    expect(openQueue(storage)).toEqual([]);
    expect(await second.flush({ kind: "retry", target })).toBe("changed");
  });

  it("protects a blocked head from discard while a retry loads its snapshot", async () => {
    const { storage, queue, open, send, fetchSnapshot } = setup(snapshot, true);
    await queue.enqueue(createEntry("discard-me"));
    send.mockRejectedValueOnce(reject());
    await queue.flush();
    const target = queue.blocked()!;
    storage.removeItem(cacheKey);
    const second = open();
    let started!: () => void;
    let finish!: () => void;
    const fetching = new Promise<void>(resolve => { started = resolve; });
    fetchSnapshot.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ snapshot, committed: [] });
      started();
    }));
    const retry = second.flush({ kind: "retry", target });
    await fetching;
    try {
      expect(await queue.flush({ kind: "discard", target })).toBe("in-flight");
    } finally {
      finish();
      await retry;
    }
    expect(send).toHaveBeenCalledTimes(2);
    expect(await queue.flush({ kind: "discard", target })).toBe("changed");
  });

  it("keeps an offline rejection actionable after a reload without a cached snapshot", async () => {
    const { storage, queue, send, fetchSnapshot, open } = setup();
    await queue.enqueue(createEntry("offline-rejected"));
    send.mockRejectedValueOnce(reject());
    await queue.flush();
    storage.removeItem(cacheKey);
    const reloaded = open();
    fetchSnapshot.mockRejectedValue(new RequestError("network", "offline"));
    const target = reloaded.blocked()!;
    expect(reloaded.view()).toMatchObject({ count: 1, blocked: target, state: null });
    expect(await reloaded.flush({ kind: "discard", target })).toBe("idle");
    expect(reloaded.view()).toMatchObject({ count: 0, blocked: null });
  });

  it("replays a committed category receipt without incrementing the catalog locally", async () => {
    const { queue, open, send, commit } = setup(withCatalog);
    await queue.enqueue(category("已提交", 1));
    send.mockImplementationOnce(async item => {
      commit(item);
      throw new RequestError("network", "response lost");
    });
    expect(await queue.flush()).toBe("retryable");

    const reloaded = open();
    await reloaded.refresh();
    expect(reloaded.view().state?.category_catalog?.version).toBe(2);
    await reloaded.enqueue(category("随后提交", reloaded.view().state!.category_catalog!.version));
    expect(await reloaded.flush()).toBe("synced");
    expect(send.mock.calls.map(([item]) => item.body.version)).toEqual([1, 1, 2]);
    expect(send.mock.calls[1][0].id).toBe(send.mock.calls[0][0].id);
    expect(reloaded.view().state?.category_catalog?.version).toBe(3);
  });

  it("refreshes receipt coverage when a legacy tab appends and commits during a snapshot request", async () => {
    const { storage, queue, commit, serverSnapshot, fetchSnapshot } = setup(withCatalog);
    const head = { ...category("先提交", 1), id: "head", createdAt: 1 };
    const follower = { ...category("稍后提交", 2), id: "follower", createdAt: 2 };
    storage.setItem(sharedKey, JSON.stringify([head]));
    commit(head);
    fetchSnapshot.mockImplementationOnce(async ids => {
      storage.setItem(sharedKey, JSON.stringify([head, follower]));
      commit(follower);
      return serverSnapshot(ids ?? []);
    });
    await queue.refresh();
    expect(fetchSnapshot.mock.calls.map(([ids]) => ids)).toEqual([[head.id], [head.id, follower.id]]);
    expect(queue.view().state?.category_catalog?.version).toBe(3);
  });

  it("replaces a blocked head in array order despite equal times and a new ID", async () => {
    const { storage, queue, send } = setup();
    const head = rawEntry("a");
    const follower = rawEntry("b");
    storage.setItem(sharedKey, JSON.stringify([head, follower]));
    send.mockRejectedValueOnce(reject());
    await queue.flush();
    const ids = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce("ffffffff-ffff-ffff-ffff-ffffffffffff");
    try {
      const target = queue.blocked()!;
      expect(await queue.flush({ kind: "edit", target, change: createEntry("replacement") })).toBe("synced");
    } finally {
      ids.mockRestore();
    }
    expect(send.mock.calls.map(([item]) => item.body.id)).toEqual(["a", "replacement", "b"]);
  });

  it("starts with the stored array order even if timestamps and IDs go backwards", async () => {
    const { storage, queue, send } = setup();
    storage.setItem(sharedKey, JSON.stringify([rawEntry("z", 10), rawEntry("a", 1)]));
    send.mockRejectedValueOnce(reject());
    expect(await queue.flush()).toBe("blocked");
    expect(queue.blocked()?.id).toBe("z");
  });

  it("rebases a versioned non-entry change only when the user replaces it", async () => {
    const { queue, send } = setup(withCatalog);
    await queue.enqueue(category("手动重试", 0));
    send.mockRejectedValueOnce(reject("分类已修改", 409));
    await queue.flush();
    const target = queue.blocked()!;
    expect(canRebase(target)).toBe(true);
    expect(await queue.flush()).toBe("idle");
    expect(send).toHaveBeenCalledTimes(1);
    const change = rebaseChange(target, await queue.refresh());
    expect(await queue.flush({ kind: "edit", target, change })).toBe("synced");
    expect(send.mock.calls[1][0]).toMatchObject({ body: { ...target.body, version: 1 } });
    expect(send.mock.calls[1][0].id).not.toBe(target.id);
  });

  it("rebases display order and versioned account changes with the latest metadata", () => {
    const server = { ...snapshot, ordering: { accounts: ["cash"], categories: ["B"], version: 3 } };
    const order = { ...rawEntry("order"), type: "order.update", path: "/display-order",
      body: { accounts: ["cash"], categories: ["A", "B"], version: 1 } } as const;
    const account = { ...rawEntry("account"), type: "account.update", path: "/accounts/cash",
      body: { id: "cash", version: 0, target_balance_cents: 20_000, expected_balance_cents: 8_000, opening_cents: 8_000 } } as const;
    const deletion = { ...account, type: "account.delete", path: "/accounts/cash/delete", body: { version: 0 } } as const;
    expect(rebaseChange(order, server).body).toEqual({ ...order.body, version: 3 });
    expect(rebaseChange(account, server).body).toEqual({ ...account.body, version: 1, expected_balance_cents: 10_000, opening_cents: 10_000 });
    expect(rebaseChange(deletion, server).body).toEqual({ version: 1 });
  });

  it("shares the Retry-After deadline across tabs and retries automatically after it", async () => {
    const { queue, open, send } = setup(snapshot, true);
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      await queue.enqueue(createEntry("rate-limited"));
      send.mockRejectedValueOnce(new RequestError("unavailable", "稍后再试", 429, 3000));
      expect(await queue.flush()).toEqual({ wait: "retry", until: 13_000 });
      expect(open().view()).toMatchObject({ count: 1, blocked: null });
      expect(await open().flush()).toEqual({ wait: "retry", until: 13_000 });
      expect(send).toHaveBeenCalledOnce();
      clock.mockReturnValue(13_000);
      expect(await open().flush()).toBe("synced");
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
});
