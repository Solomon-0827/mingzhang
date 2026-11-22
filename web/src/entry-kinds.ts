import { ordered, orderedAccountOptions, today, type Account, type CategoryCatalog, type Entry, type State } from "./types";
import { hasLoneSurrogate, textLength, trimLedgerText } from "./validation";

type Target = { label: string; kind?: string; hint: string };
type KindRule = {
  label: string;
  account?: string;
  target?: Target;
  reference?: Kind;
  category?: boolean;
  counterparty?: boolean;
  existingOnly?: boolean;
  inflow?: boolean;
  targetSign?: 1 | -1;
  income?: boolean;
  expenseSign?: 1 | -1;
};
const rules = {
  income: { label: "收入", category: true, inflow: true, income: true },
  expense: { label: "支出", category: true, expenseSign: 1 },
  transfer: { label: "转账", targetSign: 1, account: "转出账户", target: { label: "转入账户", hint: "信用卡还本金也使用账户间转账。" } },
  refund: { label: "退款", inflow: true, expenseSign: -1, reference: "expense", existingOnly: true },
  lend: { label: "借出", counterparty: true },
  borrow: { label: "借入", inflow: true, counterparty: true },
  repay: { label: "还款", targetSign: 1, account: "付款账户", target: { label: "负债账户", kind: "liability", hint: "付款账户余额减少，同时减少对应负债。本金不计入收支。" }, reference: "borrow" },
  collect: { label: "回款", inflow: true, targetSign: -1, account: "收款账户", target: { label: "债权账户", kind: "receivable", hint: "收款账户余额增加，同时减少对应债权。本金不计入收支。" }, reference: "lend" },
  balance_in: { label: "余额调增", inflow: true, existingOnly: true },
  balance_out: { label: "余额调减", existingOnly: true },
} as const;
export type Kind = keyof typeof rules;
const kinds = Object.keys(rules) as Kind[];

export const kindRule = (kind: Kind): KindRule => rules[kind];
export const kindLabel = (kind: Kind) => rules[kind]?.label;
export const kindOptions = (existing?: Kind) => kinds
  .filter(kind => !kindRule(kind).existingOnly || kind === existing)
  .map(kind => [kind, kindLabel(kind)] as const);
export const allKindOptions = kinds.map(kind => [kind, kindLabel(kind)] as const);

const fallbackCategories = {
  "日常/餐饮": ["expense"], "日常/购物": ["expense"], "日常/交通": ["expense"],
  "居住/房租": ["expense"], "居住/水电": ["expense"], "生活/娱乐": ["expense"],
  "生活/旅行": ["expense"], "健康/医疗": ["expense"], "学习/书籍": ["expense"],
  "收入/工资": ["income"], "收入/其他": ["income"], "未分类": ["income", "expense"],
};
export const defaultCategories = Object.keys(fallbackCategories);

type EntryContext = {
  accounts: readonly Account[];
  entries: readonly Entry[];
  category_catalog?: CategoryCatalog;
  ordering?: { categories: string[] };
};
type EntryAccountContext = Pick<State, "accounts" | "account_groups" | "ordering">;

export function categoryOptions(context: EntryContext, entry: Pick<Entry, "kind" | "category">, editor: "dialog" | "field" = "dialog") {
  const { kind, category } = entry;
  const catalog = context.category_catalog;
  if (catalog) return ordered(Object.keys(catalog.items).filter(path =>
    activeCategory(catalog, path) && catalog.items[path].includes(kind),
  ), context.ordering?.categories);
  const defaults = Object.entries(fallbackCategories).filter(([path, kinds]) =>
    (path !== "未分类" || editor === "dialog") && kinds.includes(kind === "income" ? "income" : "expense"),
  ).map(([path]) => path);
  const used = context.entries.filter(entry => !entry.deleted && entry.kind === kind).map(entry => entry.category);
  const options = [...defaults, ...used, category];
  if (editor === "field") options.push("未分类");
  return ordered([...new Set(options)].filter(Boolean), context.ordering?.categories);
}

function activeCategory(catalog: CategoryCatalog, path: string) {
  return !catalog.hidden.includes(path) && !catalog.retired?.includes(path);
}

export function bulkCategoryOptions(context: EntryContext, selected: readonly Entry[]) {
  const catalog = context.category_catalog;
  const kinds = [...new Set(selected.map(entry => entry.kind).filter(kind => kindRule(kind).category))];
  const paths = new Set([...Object.keys(catalog?.items ?? {}), ...context.entries.map(entry => entry.category)]);
  return ordered([...paths].filter(path => path.trim() && (!catalog || (
    activeCategory(catalog, path) &&
    (!Object.hasOwn(catalog.items, path) || kinds.every(kind => catalog.items[path].includes(kind)))
  ))), context.ordering?.categories);
}

export function initializeEntryDraft(initial: Entry, context: EntryContext & EntryAccountContext, mode: "new" | "copy" | "edit") {
  if (mode === "edit") return initial;
  const { kind, category } = initial;
  const catalog = context.category_catalog;
  const options = categoryOptions(context, initial);
  const required = kindRule(kind).category;
  if (mode === "copy") {
    const available = !catalog || activeCategory(catalog, category);
    if (available && textLength(category) <= 80 && !hasLoneSurrogate(category) &&
        (!required || (trimLedgerText(category) && options.includes(category)))) return initial;
    return { ...initial, category: required ? options[0] ?? "" : "" };
  }
  return {
    ...initial,
    account_id: initial.account_id || (entryAccountOptions(context, initial).accounts[0]?.id ?? ""),
    category: required && catalog && !options.includes(category) ? options[0] ?? "" : category,
  };
}

export function entryRoles(entry: Entry) {
  const rule = kindRule(entry.kind);
  const legacySettlement = Boolean(rule.target && rule.reference && entry.reference_id && !entry.to_account_id);
  return {
    ...rule,
    account: rule.account ?? "账户",
    target: legacySettlement ? undefined : rule.target,
    reference: rule.target ? undefined : rule.reference,
    legacySettlement,
  };
}

const fundingAccount = (account: Account) => account.kind !== "receivable" && account.kind !== "liability";

export function entryAccountOptions(context: EntryAccountContext, entry?: Entry, field: "account_id" | "to_account_id" = "account_id") {
  const { accounts, accountGroups } = orderedAccountOptions(context);
  if (!entry) return { accounts, accountGroups };
  const { target, legacySettlement } = entryRoles(entry);
  const eligible = accounts.filter(account => field === "account_id"
    ? (!(target?.kind || legacySettlement) || fundingAccount(account))
    : target && account.id !== entry.account_id && (!target.kind || account.kind === target.kind));
  return { accounts: eligible, accountGroups };
}

export function changeEntryKind(entry: Entry, kind: Kind, context: EntryContext & EntryAccountContext): Entry {
  if (kind === entry.kind) return entry;
  const next = { ...entry, kind, to_account_id: null, reference_id: null,
    category: context.category_catalog && kindRule(kind).category
      ? categoryOptions(context, { kind, category: "" })[0] ?? "" : "" };
  // A deleted account is never replaced silently: the user must choose where the money went.
  if (!context.accounts.some(account => account.id === next.account_id)) return { ...next, account_id: "" };
  const { accounts } = entryAccountOptions(context, next);
  return accounts.some(account => account.id === next.account_id)
    ? next : { ...next, account_id: accounts[0]?.id ?? "" };
}

export function referenceOptions(entry: Entry, entries: readonly Entry[]) {
  const { reference } = entryRoles(entry);
  return entries.filter(original => !original.deleted && original.id !== entry.id &&
    original.kind === reference && (original.remaining_cents > 0 || original.id === entry.reference_id));
}

export function entryDetails(entry: Entry, target?: Account, original?: Entry) {
  const rule = kindRule(entry.kind);
  if (rule?.target?.kind && target) return { category: "", counterparty: target.name };
  if (rule?.reference && original && !original.deleted && original.kind === rule.reference)
    return { category: rule.target ? "" : original.category, counterparty: original.counterparty };
  return { category: entry.category, counterparty: entry.counterparty };
}

export function entryError(entry: Entry, context: EntryContext, latestDate = today()) {
  return validateEntries([entry], context, latestDate);
}

export function validateEntries(drafts: readonly Entry[], context: EntryContext, latestDate = today()): string | undefined {
  const accounts = new Map(context.accounts.map(account => [account.id, account]));
  const entries = new Map(context.entries.map(entry => [entry.id, entry]));
  const linked = new Map<string, Map<string, Entry>>();
  for (const entry of context.entries) {
    if (entry.deleted || !entry.reference_id) continue;
    if (!linked.has(entry.reference_id)) linked.set(entry.reference_id, new Map());
    linked.get(entry.reference_id)!.set(entry.id, entry);
  }
  const unavailable = new Set([...context.category_catalog?.hidden ?? [], ...context.category_catalog?.retired ?? []]);
  for (const entry of drafts) {
    const rule = Object.hasOwn(rules, entry.kind) ? kindRule(entry.kind) : undefined;
    if (!rule) return "请选择有效的交易类型";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || entry.date < "1900-01-01" ||
      entry.date > latestDate || new Date(entry.date).toJSON()?.slice(0, 10) !== entry.date)
      return "请选择 1900 年至今天之间的实际发生日期";
    if (!Number.isInteger(entry.amount_cents) || entry.amount_cents <= 0) return "金额必须大于 0";
    if (entry.amount_cents > 10 ** 12) return "金额超出范围";
    if (textLength(entry.category) > 80 || textLength(entry.merchant) > 120 ||
      textLength(entry.memo) > 1000 || textLength(entry.counterparty) > 80) return "分类、商家、备注或往来对象超出长度限制";
    if ([entry.category, entry.merchant, entry.memo, entry.counterparty].some(hasLoneSurrogate))
      return "分类、商家、备注或往来对象含无效字符";
    const previous = entries.get(entry.id);
    const source = accounts.get(entry.account_id);
    const target = entry.to_account_id ? accounts.get(entry.to_account_id) : undefined;
    if (!source || (entry.to_account_id && !target)) return "账户不存在";
    if (unavailable.has(entry.category) && previous?.category !== entry.category)
      return "分类已删除或更名，请重新选择";
    const original = entry.reference_id ? entries.get(entry.reference_id) : undefined;
    if (rule.target && !rule.target.kind) {
      if (!target || target.id === source.id) return "转账需要两个不同的账户";
    } else if (rule.target && target) {
      if (entry.reference_id) return "不能同时关联账户和原交易";
      if (!fundingAccount(source) || target.kind !== rule.target.kind)
        return "还款请选择付款资金账户和负债账户；回款请选择收款资金账户和债权账户";
    } else if (target) {
      return "只有转账、还款和回款可以关联另一账户";
    }
    if (rule.target?.kind && !target && !entry.reference_id) return `请选择${rule.target.label}`;
    if (rule.reference && !target) {
      if (!original || original.deleted || original.kind !== rule.reference || original.id === entry.id)
        return "请选择有效的原始交易";
      if (entry.date < original.date) return "退款或还款日期不能早于原始交易";
      const related = linked.get(original.id);
      const used = [...related?.values() ?? []].reduce((sum, item) => sum + (item.id === entry.id ? 0 : item.amount_cents), 0);
      if (used + entry.amount_cents > original.amount_cents) return "金额超过原交易尚未退款或结清的金额";
    } else if (entry.reference_id) {
      return "该交易类型不应关联原交易";
    }
    const { category, counterparty } = entryDetails(entry, target, original);
    if (rule.counterparty && !trimLedgerText(counterparty)) return "借贷需要填写往来对象";
    if (rule.category && !trimLedgerText(category)) return "请选择或填写分类";
    const dependents = linked.get(entry.id);
    if (previous && dependents?.size) {
      if (entry.kind !== previous.kind || category !== previous.category || counterparty !== previous.counterparty)
        return "已有关联退款或还款，不能修改类型、分类或往来对象";
      const related = [...dependents.values()];
      if (related.some(item => item.date < entry.date) ||
        related.reduce((sum, item) => sum + item.amount_cents, 0) > entry.amount_cents)
        return "修改会使已关联交易的金额或日期无效";
    }
    if (previous?.reference_id) linked.get(previous.reference_id)?.delete(entry.id);
    const saved = { ...entry, category, counterparty };
    entries.set(entry.id, saved);
    if (saved.reference_id && !saved.deleted) {
      if (!linked.has(saved.reference_id)) linked.set(saved.reference_id, new Map());
      linked.get(saved.reference_id)!.set(saved.id, saved);
    }
  }
}
