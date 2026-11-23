import { entryDetails } from "./entry-kinds";
import { projectLedger } from "./ledger-projection";
import { entriesNewestFirst, type Account, type CategoryChange, type DisplayOrder, type Entry, type State } from "./types";

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

function rebuild(state: State): State {
  return { ...state, ...projectLedger(state.accounts, state.entries) };
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
    if (mutation.type === "entry.update") return applyMutations(state, [mutation]);
    const entry = body as unknown as Entry;
    let entries = [...state.entries];
    if (mutation.type === "entry.create") {
      const original = entry.kind === "refund" ? entries.find(item => item.id === entry.reference_id) : undefined;
      const { category } = entryDetails(entry, undefined, original);
      entries = [{ ...entry, category, created_at: entry.created_at ?? new Date(mutation.createdAt).toISOString(),
        sort_order: entry.sort_order ?? mutation.createdAt }, ...entries.filter(item => item.id !== entry.id)];
    }
    if (mutation.type === "entry.delete" || mutation.type === "entry.restore") entries = entries.map(item => item.id === mutation.path.split("/")[2]
      ? { ...item, deleted: mutation.type === "entry.delete" ? 1 : 0, version: item.version + 1 } : item);
    entries.sort(entriesNewestFirst);
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
          counterparty: "", reference_id: null, version: 1, deleted: 0, remaining_cents: Math.abs(difference),
          created_at: new Date(mutation.createdAt).toISOString(), sort_order: mutation.createdAt };
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
    const byId = new Map(state.entries.map(entry => [entry.id, entry]));
    for (const mutation of mutations) {
      const entry = mutation.body as unknown as Entry;
      if (!byId.has(entry.id)) continue;
      const original = entry.kind === "refund" && entry.reference_id ? byId.get(entry.reference_id) : undefined;
      const { category } = entryDetails(entry, undefined, original);
      const current = byId.get(entry.id)!;
      byId.set(entry.id, { ...entry, category, created_at: current.created_at ?? entry.created_at,
        sort_order: current.sort_order ?? entry.sort_order, version: entry.version + 1 });
    }
    const entries = [...byId.values()];
    entries.sort(entriesNewestFirst);
    return rebuild({ ...state, entries });
  }
  return mutations.reduce(applyMutation, state);
}

export function replayMutations(state: State, mutations: OfflineMutation[]) {
  return applyMutations(state, mutations);
}
