import { expect, it } from "vitest";
import reportRanges from "../../tests/fixtures/report-date-ranges.json";
import reportTotals from "../../tests/fixtures/report-totals.json";
import historical from "../../tests/fixtures/ledger-projection/historical-over-settlement.json";
import monthClose from "../../tests/fixtures/ledger-projection/month-close.json";
import { accountFlows, accountPostings, entryMovement, outstandingEntries, periodTotals, projectLedger, projectReport } from "./ledger-projection";
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
