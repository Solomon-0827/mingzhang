import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyncQueue } from "./sync-queue";
import { api, RequestError, type Entry, type State } from "./types";
import type { OfflineMutation } from "./offline-mutations";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
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

function setup(initial = snapshot) {
  const storage = new MemoryStorage();
  const locks = new Map<string, Promise<unknown>>();
  const lock = <T>(name: string, run: () => Promise<T> | T) => {
    const next = (locks.get(name) ?? Promise.resolve()).then(run);
    locks.set(name, next.catch(() => undefined));
    return next;
  };
  const send = vi.fn(async (_item: OfflineMutation): Promise<unknown> => undefined);
  const fetchSnapshot = vi.fn(async () => initial);
  const open = () => createSyncQueue({ storage, lock, send, fetchSnapshot });
  return { storage, send, fetchSnapshot, open, queue: open() };
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
    expect(await queue.flush({ kind: "edit", target, body })).toBe("blocked");
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
});
