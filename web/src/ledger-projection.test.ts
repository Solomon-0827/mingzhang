import { expect, it } from "vitest";
import reportRanges from "../../tests/fixtures/report-date-ranges.json";
import reportTotals from "../../tests/fixtures/report-totals.json";
import historical from "../../tests/fixtures/ledger-projection/historical-over-settlement.json";
import monthClose from "../../tests/fixtures/ledger-projection/month-close.json";
import { accountFlows, accountPostings, accountReconciliation, entryMovement, outstandingEntries, periodTotals, projectLedger, projectReport } from "./ledger-projection";
import { applyMutations, type OfflineMutation } from "./offline-mutations";
import type { Account, Entry, State } from "./types";

const load = (fixture: typeof monthClose | typeof historical) => ({
  accounts: fixture.accounts.map(account => ({ ...account, name: account.id, balance_cents: 0, version: 1 })) satisfies Account[],
  entries: fixture.entries.map(entry => ({
    account_id: "cash", to_account_id: null, reference_id: null, category: "", merchant: "",
    memo: "", counterparty: "", deleted: 0, remaining_cents: 0, version: 1, ...entry,
  })) as Entry[],
});

it.each([["month close", monthClose], ["historical over-settlement", historical]] as const)(
  "matches the server projection for %s", (_name, fixture) => {
    const { accounts, entries } = load(fixture);
    const { expected } = fixture;
    const result = projectLedger(accounts, entries);
    expect(Object.fromEntries(result.accounts.map(a => [a.id, a.balance_cents]))).toEqual(expected.balances);
    expect(Object.fromEntries(result.entries.map(e => [e.id, e.remaining_cents]))).toEqual(expected.remaining);
    expect(result).toMatchObject(expected.totals);
    expect(Object.fromEntries(entries.filter(e => !e.deleted).map(e => [e.id, accountPostings(e)]))).toEqual(expected.postings);
    expect(Object.fromEntries(accounts.map(account => [account.id, accountFlows(entries, [account])]))).toEqual(expected.flows);
    expect(projectReport(entries, fixture.range[0], fixture.range[1])).toEqual(expected.report);
    expect(periodTotals(entries)).toEqual({
      income: expected.report.income, expense: expected.report.expense, net: expected.report.net,
    });
  },
);

it("treats balance increases as inflow on rows", () => {
  expect(entryMovement("balance_in")).toMatchObject({ direction: "in", sign: "+", tone: "book-in" });
  expect(entryMovement("transfer")).toMatchObject({ direction: "transfer", sign: "", tone: "book-neutral" });
  expect(entryMovement("refund")).toMatchObject({ sign: "+", tone: "book-in" });
  expect(entryMovement("expense")).toMatchObject({ sign: "−", tone: "book-out" });
});

it("includes historical over-settlements in Accounts detail", () => {
  const { accounts, entries } = load(historical);
  const projected = projectLedger(accounts, entries);
  expect(outstandingEntries(projected.entries).map(({ kind, remaining_cents }) => [kind, remaining_cents]))
    .toEqual([["lend", projected.receivable], ["borrow", projected.payable]]);
});

it("reconciles each account by day with opening, movements, and closing balance", () => {
  const wallet = { id: "wallet", name: "支付宝", kind: "wallet", opening_cents: 10_000, balance_cents: 0, version: 1 };
  const bank = { id: "bank", name: "工商银行", kind: "bank", opening_cents: 0, balance_cents: 0, version: 1 };
  const row = (id: string, date: string, kind: Entry["kind"], amount_cents: number, account_id = "wallet", to_account_id: string | null = null, deleted = 0): Entry => ({
    id, date, kind, amount_cents, account_id, to_account_id, deleted,
    category: kind === "expense" ? "日常/餐饮" : "", merchant: "", memo: "", counterparty: "",
    reference_id: null, version: 1, remaining_cents: amount_cents,
  });
  const entries = [
    row("adjust", "2026-11-03", "balance_in", 200),
    row("deleted", "2026-11-03", "expense", 900, "wallet", null, 1),
    row("transfer-in", "2026-11-02", "transfer", 3_000, "bank", "wallet"),
    row("transfer-out", "2026-11-02", "transfer", 2_000, "wallet", "bank"),
    row("expense", "2026-11-01", "expense", 1_200),
    row("income", "2026-11-01", "income", 5_000),
  ];

  expect(accountReconciliation(wallet, entries)).toEqual([
    { date: "2026-11-03", opening_cents: 14_800, inflow_cents: 200, outflow_cents: 0, closing_cents: 15_000,
      postings: [{ entry: entries[0], amount_cents: 200, balance_cents: 15_000 }] },
    { date: "2026-11-02", opening_cents: 13_800, inflow_cents: 3_000, outflow_cents: 2_000, closing_cents: 14_800,
      postings: [{ entry: entries[2], amount_cents: 3_000, balance_cents: 14_800 },
        { entry: entries[3], amount_cents: -2_000, balance_cents: 11_800 }] },
    { date: "2026-11-01", opening_cents: 10_000, inflow_cents: 5_000, outflow_cents: 1_200, closing_cents: 13_800,
      postings: [{ entry: entries[4], amount_cents: -1_200, balance_cents: 13_800 },
        { entry: entries[5], amount_cents: 5_000, balance_cents: 15_000 }] },
  ]);
});

it("keeps per-entry balances in server order after an offline date edit", () => {
  const wallet = { id: "wallet", name: "支付宝", kind: "wallet", opening_cents: 10_000, balance_cents: 0, version: 1 };
  const entry = (id: string, date: string, amount_cents: number, created_at: string, sort_order: number): Entry => ({
    id, date, kind: "expense", amount_cents, account_id: "wallet", to_account_id: null, category: "日常/餐饮",
    merchant: "", memo: "", counterparty: "", reference_id: null, version: 1, deleted: 0,
    remaining_cents: amount_cents, created_at, sort_order,
  });
  const older = entry("older", "2026-11-01", 1_000, "2026-11-01 09:00:00", 1);
  const newer = entry("newer", "2026-11-02", 2_000, "2026-11-02 09:00:00", 2);
  const state = { accounts: [wallet], entries: [newer, older] } as State;
  const moved = { ...older, date: "2026-11-02" };
  const updated = applyMutations(state, [{ id: "change-date", type: "entry.update", path: "/entries/older",
    method: "PUT", body: moved as unknown as Record<string, unknown>, createdAt: Date.parse("2026-11-03T00:00:00Z") }]);

  const day = accountReconciliation(wallet, updated.entries)[0];
  expect(day.postings.map(posting => [posting.entry.id, posting.balance_cents])).toEqual([
    ["newer", 7_000],
    ["older", 9_000],
  ]);
});

it.each(reportRanges)("report range: $name", ({ start, end, status, first_day }) => {
  if (status === 200) expect(projectReport([], start, end).daily[0].date).toBe(first_day ?? start);
  else expect(() => projectReport([], start, end)).toThrow("日期范围无效");
});

it.each(reportTotals)("matches the server report for $name", ({ entries: rows, day, expected }) => {
  const entries = rows.flatMap(({ count, ...row }) => Array<Entry>(count).fill({ ...row, date: day } as Entry));
  expect(projectReport(entries, day, day)).toEqual(expected);
  expect(periodTotals(entries)).toEqual({ income: expected.income, expense: expected.expense, net: expected.net });
});

it("projects refunds under the original category and preserves settlement counterparties during replay", () => {
  const { accounts, entries } = load(monthClose);
  const state = { accounts, entries: entries.filter(e => e.id === "meal") } as State;
  const changes = entries.filter(e => ["refund", "account-collection"].includes(e.id)).map(entry => ({
    id: `change-${entry.id}`, method: "POST", type: "entry.create", path: "/entries", createdAt: 0,
    body: { ...entry, category: "", counterparty: "" },
  } satisfies OfflineMutation));
  const replay = applyMutations(state, changes);
  expect(replay.entries.find(e => e.id === "refund")?.category).toBe("餐饮");
  expect(replay.entries.find(e => e.id === "account-collection")?.counterparty).toBe("");
  expect(projectReport(replay.entries, "2026-02-01", "2026-02-01").categories).toEqual([["餐饮", -200]]);
  const collection = replay.entries.find(e => e.id === "account-collection")!;
  const edited = applyMutations(replay, [{ ...changes[0], type: "entry.update", method: "PUT",
    body: { ...collection, counterparty: "Original counterparty" } }]);
  expect(edited.entries.find(e => e.id === collection.id)?.counterparty).toBe("Original counterparty");
});
