import type { Account, CategoryChange, DisplayOrder, Entry, State } from "./types";

export type OfflineMutation = {
  id: string;
  type:
    | "entry.create" | "entry.update" | "entry.delete" | "entry.restore"
    | "account.create" | "account.update" | "account.delete"
    | "account-group.create" | "account-group.rename" | "account-group.delete"
    | "category.change" | "order.update";
  path: string;
  method: "POST" | "PUT";
  body: Record<string, unknown>;
  createdAt: number;
};

function entryDelta(entry: Entry, direction: number, changes: Map<string, number>) {
  if (entry.deleted) return;
  const sign = ["income", "refund", "borrow", "collect", "balance_in"].includes(entry.kind) ? 1 : -1;
  changes.set(entry.account_id, (changes.get(entry.account_id) || 0) + direction * sign * entry.amount_cents);
  if (entry.to_account_id && ["transfer", "repay", "collect"].includes(entry.kind)) {
    const targetSign = entry.kind === "collect" ? -1 : 1;
    changes.set(entry.to_account_id, (changes.get(entry.to_account_id) || 0) + direction * targetSign * entry.amount_cents);
  }
}

function rebuild(state: State): State {
  const balances = new Map(state.accounts.map(account => [account.id, account.opening_cents]));
  const active = state.entries.filter(entry => !entry.deleted);
  for (const entry of active) {
    const changes = new Map<string, number>();
    entryDelta(entry, 1, changes);
    for (const [id, amount] of changes) balances.set(id, (balances.get(id) || 0) + amount);
  }
  const settled = new Map<string, number>();
  for (const entry of active) if (entry.reference_id)
    settled.set(entry.reference_id, (settled.get(entry.reference_id) || 0) + entry.amount_cents);
  let receivable = 0, payable = 0;
  const entries = state.entries.map(entry => {
    const remaining_cents = Math.max(0, entry.amount_cents - (settled.get(entry.id) || 0));
    if (!entry.deleted && entry.kind === "lend") receivable += remaining_cents;
    if (!entry.deleted && entry.kind === "borrow") payable += remaining_cents;
    return { ...entry, remaining_cents };
  });
  const accounts = state.accounts.map(account => ({ ...account, balance_cents: balances.get(account.id) || 0 }));
  const assets = accounts.reduce((sum, account) => sum + Math.max(0, account.balance_cents), 0) + receivable;
  const liabilities = accounts.reduce((sum, account) => sum - Math.min(0, account.balance_cents), 0) + payable;
  receivable += accounts.filter(account => account.kind === "receivable").reduce((sum, account) => sum + Math.max(0, account.balance_cents), 0);
  payable += accounts.filter(account => account.kind === "liability").reduce((sum, account) => sum + Math.max(0, -account.balance_cents), 0);
  return { ...state, accounts, entries, assets, liabilities, net_assets: assets - liabilities, receivable, payable };
}

function changeCategory(state: State, change: CategoryChange): State {
  if (!state.category_catalog) return state;
  const catalog = structuredClone(state.category_catalog);
  // Category paths are user-entered keys, including names like "__proto__".
  const items = Object.assign(Object.create(null) as typeof catalog.items, catalog.items);
  catalog.items = items;
  const hidden = new Set(catalog.hidden);
  const retired = new Set(catalog.retired || []);
  const removedKinds = Object.assign(Object.create(null) as NonNullable<typeof catalog.removed_kinds>, catalog.removed_kinds);
  const parent = change.path.split("/")[0];
  const affected = Object.keys(items).filter(path => path === change.path || (change.level === "parent" && path.startsWith(change.path + "/")));
  let entries = state.entries;
  const ordering = state.ordering ? { ...state.ordering } : undefined;
  if (change.action === "add") {
    items[change.path] = [change.kind || "expense"];
    hidden.delete(change.path);
    retired.delete(change.path);
  } else if (change.action === "delete") {
    for (const path of affected) { removedKinds[path] = items[path]; delete items[path]; hidden.add(path); }
    if (change.level === "child" && !Object.keys(items).some(path => path === parent || path.startsWith(parent + "/")))
      items[parent] = [change.kind || "expense"];
  } else if (change.action === "restore") {
    const restored = [...hidden].filter(path => path === change.path || (change.level === "parent" && path.startsWith(change.path + "/")));
    for (const path of restored) { hidden.delete(path); items[path] = removedKinds[path] || [change.kind || "expense"]; delete removedKinds[path]; }
  } else {
    const target = change.level === "parent" ? change.name : `${parent}/${change.name}`;
    const movedHidden = [...hidden].filter(path => change.level === "parent" && (path === change.path || path.startsWith(change.path + "/")));
    const mapping = new Map([...affected, ...movedHidden].map(path => [path, target + path.slice(change.path.length)]));
    for (const [oldPath, newPath] of mapping) {
      if (hidden.delete(oldPath)) { hidden.add(newPath); if (removedKinds[oldPath]) { removedKinds[newPath] = removedKinds[oldPath]; delete removedKinds[oldPath]; } }
      else { items[newPath] = items[oldPath]; delete items[oldPath]; }
      retired.add(oldPath); retired.delete(newPath);
    }
    entries = entries.map(entry => mapping.has(entry.category) ? { ...entry, category: mapping.get(entry.category)!, version: entry.version + 1 } : entry);
    if (ordering) {
      ordering.categories = [...new Set(ordering.categories.map(path => mapping.get(path) ?? path))];
      if (ordering.favorites)
        ordering.favorites = [...new Set(ordering.favorites.map(path => mapping.get(path) ?? path))];
    }
  }
  if ((change.action === "add" || change.action === "restore") && Object.hasOwn(items, parent)
    && Object.keys(items).some(path => path.startsWith(parent + "/"))
    && !entries.some(entry => entry.category === parent)) {
    delete items[parent];
  }
  if (ordering?.favorites)
    ordering.favorites = ordering.favorites.filter(path => Object.hasOwn(items, path) && !hidden.has(path) && !retired.has(path));
  catalog.hidden = [...hidden].sort();
  catalog.retired = [...retired];
  catalog.removed_kinds = removedKinds;
  catalog.version += 1;
  return { ...state, entries, ordering, category_catalog: catalog };
}

export function applyMutation(state: State, mutation: OfflineMutation): State {
  const body = mutation.body;
  if (mutation.type.startsWith("entry.")) {
    const entry = body as unknown as Entry;
    let entries = [...state.entries];
    if (mutation.type === "entry.create") entries = [entry, ...entries.filter(item => item.id !== entry.id)];
    if (mutation.type === "entry.update") entries = entries.map(item => item.id === entry.id ? { ...entry, version: entry.version + 1 } : item);
    if (mutation.type === "entry.delete" || mutation.type === "entry.restore") entries = entries.map(item => item.id === mutation.path.split("/")[2]
      ? { ...item, deleted: mutation.type === "entry.delete" ? 1 : 0, version: item.version + 1 } : item);
    entries.sort((a, b) => b.date.localeCompare(a.date));
    return rebuild({ ...state, entries });
  }
  if (mutation.type === "account.create") {
    const account = body as unknown as Account;
    return rebuild({ ...state, accounts: [...state.accounts.filter(item => item.id !== account.id), account] });
  }
  if (mutation.type === "account.update") {
    const account = body as unknown as Account & { target_balance_cents?: number; expected_balance_cents?: number };
    let next = rebuild({ ...state, accounts: state.accounts.map(item => item.id === account.id
      ? { ...item, ...account, version: item.version + 1 } : item) });
    if (account.target_balance_cents !== undefined && account.expected_balance_cents !== undefined) {
      const difference = account.target_balance_cents - account.expected_balance_cents;
      if (difference) {
        const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(mutation.createdAt));
        const adjustment: Entry = { id: account.adjustment_id || `offline-balance-${mutation.id}`, date, kind: difference > 0 ? "balance_in" : "balance_out",
          amount_cents: Math.abs(difference), account_id: account.id, to_account_id: null, category: "", merchant: "", memo: "账户余额调整",
          counterparty: "", reference_id: null, version: 1, deleted: 0, remaining_cents: Math.abs(difference) };
        next = rebuild({ ...next, entries: [adjustment, ...next.entries.filter(item => item.id !== adjustment.id)] });
      }
    }
    return next;
  }
  if (mutation.type === "account.delete")
    return rebuild({ ...state, accounts: state.accounts.filter(account => account.id !== mutation.path.split("/")[2]) });
  if (mutation.type === "account-group.create")
    return { ...state, account_groups: [...state.account_groups.filter(group => group.id !== body.id), body as unknown as State["account_groups"][number]] };
  if (mutation.type === "account-group.rename")
    return { ...state, account_groups: state.account_groups.map(group => group.id === mutation.path.split("/")[2] ? { ...group, name: String(body.name) } : group) };
  if (mutation.type === "account-group.delete")
    return { ...state, account_groups: state.account_groups.filter(group => group.id !== mutation.path.split("/")[2]) };
  if (mutation.type === "category.change") return changeCategory(state, body as unknown as CategoryChange);
  if (mutation.type === "order.update") {
    const order = body as unknown as DisplayOrder;
    const catalog = state.category_catalog;
    const favorites = order.favorites ?? state.ordering?.favorites ?? [];
    const activeFavorites = catalog ? favorites.filter(path =>
      Object.hasOwn(catalog.items, path) && !catalog.hidden.includes(path) && !catalog.retired?.includes(path)
    ) : favorites;
    const ranks = new Map(order.accounts.map((id, index) => [id, index]));
    const groupRanks = new Map((order.account_groups || []).map((id, index) => [id, index]));
    return { ...state, ordering: { ...order, favorites: [...new Set(activeFavorites)].slice(0, 9), version: order.version + 1 },
      accounts: [...state.accounts].sort((a, b) => (ranks.get(a.id) ?? order.accounts.length) - (ranks.get(b.id) ?? order.accounts.length)),
      account_groups: [...state.account_groups].sort((a, b) => (groupRanks.get(a.id) ?? groupRanks.size) - (groupRanks.get(b.id) ?? groupRanks.size)) };
  }
  return state;
}

export function applyMutations(state: State, mutations: OfflineMutation[]): State {
  if (!mutations.length) return state;
  if (mutations.every(mutation => mutation.type === "entry.update")) {
    const updates = new Map(mutations.map(mutation => {
      const entry = mutation.body as unknown as Entry;
      return [entry.id, entry] as const;
    }));
    const entries = state.entries.map(item => {
      const entry = updates.get(item.id);
      return entry ? { ...entry, version: entry.version + 1 } : item;
    });
    entries.sort((a, b) => b.date.localeCompare(a.date));
    return rebuild({ ...state, entries });
  }
  return mutations.reduce(applyMutation, state);
}

export function replayMutations(state: State, mutations: OfflineMutation[]) {
  return applyMutations(state, mutations);
}
