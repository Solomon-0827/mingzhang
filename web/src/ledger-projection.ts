import { kindRule, type Kind } from "./entry-kinds";
import type { Account, Entry, Report } from "./types";

export function entryMovement(kind: Kind) {
  const rule = kindRule(kind);
  return {
    direction: rule?.target && !rule.target.kind ? "transfer" : rule?.inflow ? "in" : "out",
    primarySign: rule?.inflow ? 1 : -1,
    targetSign: rule?.targetSign ?? 0,
  } as const;
}

export function accountPostings(entry: Entry): [string, number][] {
  const { primarySign, targetSign } = entryMovement(entry.kind);
  const postings: [string, number][] = [[entry.account_id, primarySign * entry.amount_cents]];
  if (entry.to_account_id && targetSign) postings.push([entry.to_account_id, targetSign * entry.amount_cents]);
  return postings;
}

export function projectLedger(accounts: readonly Account[], entries: readonly Entry[]) {
  const balances = new Map(accounts.map(account => [account.id, account.opening_cents]));
  const settled = new Map<string, number>();
  for (const entry of entries) {
    if (entry.deleted) continue;
    for (const [id, amount] of accountPostings(entry)) {
      // Replay can contain a blocked change whose account has since disappeared.
      if (balances.has(id)) balances.set(id, balances.get(id)! + amount);
    }
    if (entry.reference_id)
      settled.set(entry.reference_id, (settled.get(entry.reference_id) ?? 0) + entry.amount_cents);
  }
  let receivable = 0, payable = 0;
  const projectedEntries = entries.map(entry => {
    const remaining_cents = entry.amount_cents - (settled.get(entry.id) ?? 0);
    if (!entry.deleted && entry.kind === "lend") receivable += remaining_cents;
    if (!entry.deleted && entry.kind === "borrow") payable += remaining_cents;
    return { ...entry, remaining_cents };
  });
  let assets = receivable, liabilities = payable;
  const projectedAccounts = accounts.map(account => {
    const balance_cents = balances.get(account.id)!;
    assets += Math.max(0, balance_cents);
    liabilities -= Math.min(0, balance_cents);
    if (account.kind === "receivable") receivable += Math.max(0, balance_cents);
    if (account.kind === "liability") payable -= Math.min(0, balance_cents);
    return { ...account, balance_cents };
  });
  return { accounts: projectedAccounts, entries: projectedEntries, assets, liabilities,
    net_assets: assets - liabilities, receivable, payable };
}

export function accountFlows(entries: readonly Entry[], accounts: readonly Account[]) {
  const ids = new Set(accounts.map(account => account.id));
  let inflow = 0, outflow = 0;
  for (const entry of entries) {
    if (entry.deleted) continue;
    for (const [id, amount] of accountPostings(entry)) {
      if (!ids.has(id)) continue;
      inflow += Math.max(0, amount);
      outflow -= Math.min(0, amount);
    }
  }
  return { inflow, outflow };
}

export function balanceTotal(accounts: readonly Account[]) {
  return accounts.reduce((total, account) => total + account.balance_cents, 0);
}

export function entryPeriodAmounts(entry: Entry) {
  const rule = kindRule(entry.kind);
  return {
    income: rule?.income ? entry.amount_cents : 0,
    expense: rule?.expenseSign ? rule.expenseSign * entry.amount_cents : 0,
  };
}

export function periodTotals(entries: readonly Entry[]) {
  let income = 0, expense = 0;
  for (const entry of entries) {
    if (entry.deleted) continue;
    const amounts = entryPeriodAmounts(entry);
    income += amounts.income;
    expense += amounts.expense;
  }
  return { income, expense, net: income - expense };
}

export const emptyReport: Report = { income: 0, expense: 0, net: 0, daily: [], months: [], categories: [] };

export function projectReport(entries: readonly Entry[], start: string, end: string): Report {
  const startTime = Date.parse(start + "T00:00:00Z"), endTime = Date.parse(end + "T00:00:00Z");
  const dayMs = 86400000;
  const length = (endTime - startTime) / dayMs;
  if (!Number.isFinite(length) || length < 0 || length > 3660)
    throw new Error("日期范围无效，请选择十年以内的范围");
  const daily = new Map<string, Report["daily"][number]>();
  for (let time = startTime; time <= endTime; time += dayMs) {
    const date = new Date(time).toISOString().slice(0, 10);
    daily.set(date, { date, income: 0, expense: 0, cumulative: 0 });
  }
  const categories = new Map<string, number>();
  for (const entry of entries) {
    const item = entry.deleted ? undefined : daily.get(entry.date);
    if (!item) continue;
    const amounts = entryPeriodAmounts(entry);
    item.income += amounts.income;
    item.expense += amounts.expense;
    if (amounts.expense)
      categories.set(entry.category, (categories.get(entry.category) ?? 0) + amounts.expense);
  }
  let income = 0, expense = 0;
  const months = new Map<string, Report["months"][number]>();
  for (const item of daily.values()) {
    income += item.income;
    expense += item.expense;
    item.cumulative = income - expense;
    const month = item.date.slice(0, 7);
    const total = months.get(month) ?? { month, income: 0, expense: 0 };
    total.income += item.income;
    total.expense += item.expense;
    months.set(month, total);
  }
  return { income, expense, net: income - expense, daily: [...daily.values()], months: [...months.values()],
    categories: [...categories].sort(([a, amountA], [b, amountB]) => amountB - amountA || (a < b ? -1 : a > b ? 1 : 0)) };
}
