import { kindRule, type Kind } from "./entry-kinds";
import { entriesNewestFirst, type Account, type Entry, type Report } from "./types";

export function entryMovement(kind: Kind) {
  const rule = kindRule(kind);
  const tone = rule?.expenseSign === 1 ? "book-out"
    : rule?.income || rule?.expenseSign === -1 || kind === "balance_in" ? "book-in" : "book-neutral";
  return {
    direction: rule?.target && !rule.target.kind ? "transfer" : rule?.inflow ? "in" : "out",
    primarySign: rule?.inflow ? 1 : -1,
    targetSign: rule?.targetSign ?? 0,
    tone,
    sign: tone === "book-in" ? "+" : tone === "book-out" ? "−" : "",
  } as const;
}

export function outstandingEntries(entries: readonly Entry[]) {
  return entries.filter(entry => !entry.deleted && (entry.kind === "lend" || entry.kind === "borrow") && entry.remaining_cents !== 0);
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

export type ReconciliationPosting = { entry: Entry; amount_cents: number; balance_cents: number };
export type ReconciliationDay = {
  date: string;
  opening_cents: number;
  inflow_cents: number;
  outflow_cents: number;
  closing_cents: number;
  postings: ReconciliationPosting[];
};

export function accountReconciliation(account: Account, entries: readonly Entry[]): ReconciliationDay[] {
  const postings = new Map<string, Omit<ReconciliationPosting, "balance_cents">[]>();
  for (const entry of entries) {
    if (entry.deleted) continue;
    const amount_cents = accountPostings(entry).find(([id]) => id === account.id)?.[1];
    if (amount_cents === undefined) continue;
    const day = postings.get(entry.date) ?? [];
    day.push({ entry, amount_cents });
    postings.set(entry.date, day);
  }
  let balance = account.opening_cents;
  const days = [...postings].sort(([a], [b]) => a.localeCompare(b)).map(([date, unsortedPostings]) => {
    const dayPostings = [...unsortedPostings].sort((a, b) => entriesNewestFirst(a.entry, b.entry));
    const opening_cents = balance;
    const inflow_cents = dayPostings.reduce((sum, posting) => sum + Math.max(0, posting.amount_cents), 0);
    const outflow_cents = dayPostings.reduce((sum, posting) => sum - Math.min(0, posting.amount_cents), 0);
    balance += inflow_cents - outflow_cents;
    let postingBalance = balance;
    const balancedPostings = dayPostings.map(posting => {
      const balanced = { ...posting, balance_cents: postingBalance };
      postingBalance -= posting.amount_cents;
      return balanced;
    });
    return { date, opening_cents, inflow_cents, outflow_cents, closing_cents: balance, postings: balancedPostings };
  });
  return days.reverse();
}

export function balanceTotal(accounts: readonly Account[]) {
  return accounts.reduce((total, account) => total + account.balance_cents, 0);
}

function entryPeriodAmounts(entry: Entry) {
  const rule = kindRule(entry.kind);
  return {
    income: rule?.income ? BigInt(entry.amount_cents) : 0n,
    expense: rule?.expenseSign ? BigInt(rule.expenseSign * entry.amount_cents) : 0n,
  };
}

type FlowTotals = ReturnType<typeof entryPeriodAmounts>;
const numericFlow = ({ income, expense }: FlowTotals) => ({ income: Number(income), expense: Number(expense) });

export function periodTotals(entries: readonly Entry[]) {
  let income = 0n, expense = 0n;
  for (const entry of entries) {
    if (entry.deleted) continue;
    const amounts = entryPeriodAmounts(entry);
    income += amounts.income;
    expense += amounts.expense;
  }
  return { ...numericFlow({ income, expense }), net: Number(income - expense) };
}

export const emptyReport: Report = { income: 0, expense: 0, net: 0, daily: [], months: [], categories: [] };

const dayMs = 86_400_000;

export function projectReport(entries: readonly Entry[], start: string, end: string): Report {
  const startTime = calendarDay(start), endTime = calendarDay(end);
  const length = (endTime - startTime) / dayMs;
  if (!Number.isFinite(length) || length < 0 || length > 3660)
    throw new Error("日期范围无效，请选择十年以内的范围");
  const daily = new Map<string, FlowTotals>();
  for (let time = startTime; time <= endTime; time += dayMs) {
    const date = new Date(time).toISOString().slice(0, 10);
    daily.set(date, { income: 0n, expense: 0n });
  }
  const categories = new Map<string, bigint>();
  for (const entry of entries) {
    const item = entry.deleted ? undefined : daily.get(entry.date);
    if (!item) continue;
    const amounts = entryPeriodAmounts(entry);
    item.income += amounts.income;
    item.expense += amounts.expense;
    if (amounts.expense)
      categories.set(entry.category, (categories.get(entry.category) ?? 0n) + amounts.expense);
  }
  let income = 0n, expense = 0n;
  const months = new Map<string, FlowTotals>();
  const days = [...daily].map(([date, item]) => {
    income += item.income;
    expense += item.expense;
    const month = date.slice(0, 7);
    const total = months.get(month) ?? { income: 0n, expense: 0n };
    total.income += item.income;
    total.expense += item.expense;
    months.set(month, total);
    return { date, ...numericFlow(item), cumulative: Number(income - expense) };
  });
  return {
    ...numericFlow({ income, expense }), net: Number(income - expense), daily: days,
    months: [...months].map(([month, total]) => ({ month, ...numericFlow(total) })),
    categories: [...categories].sort(([, a], [, b]) => a === b ? 0 : a > b ? -1 : 1)
      .map(([category, amount]) => [category, Number(amount)]),
  };
}

function calendarDay(value: string) {
  // The API accepts dates and exact local-midnight datetimes. Offsets don't change the date.
  const midnight = /^(\d{4}-\d{2}-\d{2})(?:[Tt _]00:00(?::00(?:[.,](?:0{6}\d*|0{1,5}))?)?(?:[Zz]|[+−-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/.exec(value);
  if (midnight?.[0] === value) {
    const date = midnight[1];
    const time = Date.parse(date + "T00:00:00Z");
    return Number.isFinite(time) && date >= "0001-01-01" && new Date(time).toISOString().slice(0, 10) === date
      ? time : NaN;
  }
  const unix = /^[+-]?(?:\d+|(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?)$/.exec(value);
  if (unix?.[0] !== value) return NaN;
  const timestamp = unixTimestamp(value);
  const millisecondThreshold = 20_000_000_000;
  // The pinned API parser converts fractional timestamps to seconds and rounds to microseconds
  // before applying its usual unit inference to the integer part.
  const normalized = value.includes(".") && Math.abs(timestamp) > millisecondThreshold
    ? timestamp / 1_000 : timestamp;
  const whole = Math.floor(normalized);
  const micros = Math.round((normalized - whole) * 1_000_000);
  const unitsPerSecond = Math.abs(whole) > millisecondThreshold ? 1_000 : 1;
  const unitsPerDay = 86_400 * unitsPerSecond;
  const microsPerDay = 86_400_000_000;
  const remainder = (whole % unitsPerDay) * (1_000_000 / unitsPerSecond) + micros;
  if (remainder % microsPerDay !== 0) return NaN;
  const time = (Math.trunc(whole / unitsPerDay) + remainder / microsPerDay) * dayMs;
  return time >= Date.parse("0001-01-01") && time <= Date.parse("9999-12-31") ? time : NaN;
}

function unixTimestamp(value: string) {
  const whole = value.split(".", 1)[0];
  if (whole.length <= 16) return Number(value);
  // The API's integer parser uses signed 64-bit arithmetic before trying decimal syntax.
  let parsed = 0n;
  for (const digit of whole.replace(/^[+-]/, "")) {
    parsed = BigInt.asIntN(64, parsed * 10n + BigInt(digit));
    if (parsed < 0n) return NaN;
  }
  return value.includes(".") ? Number(value) : Number(whole.startsWith("-") ? -parsed : parsed);
}
