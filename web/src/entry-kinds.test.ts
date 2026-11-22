import { describe, expect, it } from "vitest";
import fixture from "../../tests/fixtures/entry-rules/editors.json";
import { bulkCategoryOptions, categoryOptions, changeEntryKind, entryAccountOptions, entryError, entryRoles,
  initializeEntryDraft, kindOptions, validateEntries } from "./entry-kinds";
import type { Account, Entry } from "./types";

const draft = (fields: object) => ({ id: "candidate", ...fixture.defaults, ...fields }) as Entry;
const entries = fixture.originals.map(draft);
const state = {
  accounts: fixture.accounts.map(account => ({ ...account, opening_cents: 0, balance_cents: 0, version: 1 })) satisfies Account[],
  account_groups: fixture.accounts.map(({ name, kind }) => ({ id: kind, name, kind })),
  category_catalog: fixture.catalog,
  entries,
};

describe("entry rules shared with the server", () => {
  it.each(fixture.cases)("$name", ({ entry, valid, reason, repeat }) => {
    const fields = repeat ? { ...entry, [repeat.field]: "🐱".repeat(repeat.count) } : entry;
    const error = entryError(draft(fields), state, "2026-11-21");
    expect(error === undefined).toBe(valid);
    if (reason) expect(error).toBe(reason);
  });
});

it("filters bulk categories by income and expense kinds, retaining legacy uncataloged choices", () => {
  const expense = draft({ kind: "expense" });
  const context = { ...state, entries: [...entries, draft({ kind: "transfer", category: "Sui/原始用途" })] };
  expect(bulkCategoryOptions(context, [expense, draft({ kind: "income" })])).toEqual(["未分类", "Sui/原始用途"]);
  expect(bulkCategoryOptions(context, [expense, draft({ kind: "refund" })]))
    .toEqual(["日常/餐饮", "未分类", "Sui/原始用途"]);
});

it("preserves special kinds on their own entries", () => {
  expect(kindOptions().map(([kind]) => kind)).not.toContain("refund");
  expect(kindOptions("balance_out").map(([kind]) => kind)).toContain("balance_out");
});

it("keeps the dialog and inline category order in older snapshots without a catalog", () => {
  const expense = draft({ kind: "expense", category: "旧/当前分类" });
  const deleted = draft({ kind: "expense", category: "旧/回收站分类", deleted: 1 });
  const context = { accounts: state.accounts, account_groups: state.account_groups,
    entries: [deleted, draft({ kind: "expense", category: "旧/自定义分类" })] };
  expect(categoryOptions(context, expense).slice(-3)).toEqual(["未分类", "旧/自定义分类", "旧/当前分类"]);
  expect(categoryOptions(context, expense, "field").slice(-3)).toEqual(["旧/自定义分类", "旧/当前分类", "未分类"]);
  expect(changeEntryKind(expense, "income", context).category).toBe("");
});

it("keeps the starter expense default when available and otherwise honors the saved order", () => {
  const expense = draft({ kind: "expense", category: "日常/餐饮" });
  const context = { ...state, ordering: { accounts: [], categories: ["未分类", "日常/餐饮"], version: 1 } };
  expect(initializeEntryDraft(expense, context, "new").category).toBe("日常/餐饮");
  expect(changeEntryKind(draft({ kind: "transfer" }), "expense", context).category).toBe("未分类");
});

it("resets links and selects an eligible funding account on a kind change", () => {
  const previous = draft({ kind: "transfer", account_id: "debt", to_account_id: "cash", category: "日常/餐饮" });
  const changed = changeEntryKind(previous, "collect", state);
  expect(changed).toMatchObject({ kind: "collect", account_id: "cash", to_account_id: null, reference_id: null, category: "" });
  expect(entryRoles(changed)).toMatchObject({ account: "收款账户", target: { label: "债权账户" } });
});

it("uses display order for new drafts and single, inline, and bulk account choices", () => {
  const anotherBank = { ...state.accounts.find(account => account.id === "bank")!, id: "another-bank" };
  const context = {
    ...state,
    accounts: [...state.accounts, anotherBank],
    ordering: {
      accounts: ["cash", "another-bank", "bank", "asset", "debt"],
      account_groups: ["liability", "bank", "cash", "receivable"],
      categories: [],
      version: 2,
    },
  };
  const transfer = draft({ kind: "transfer", account_id: "bank", to_account_id: "cash" });
  const expected = ["debt", "another-bank", "bank", "cash", "asset"];

  expect(initializeEntryDraft(draft({ kind: "expense", account_id: "" }), context, "new").account_id).toBe("debt");
  expect(initializeEntryDraft(transfer, context, "edit").account_id).toBe("bank");
  expect(initializeEntryDraft(transfer, context, "copy").account_id).toBe("bank");
  expect(entryAccountOptions(context).accounts.map(account => account.id)).toEqual(expected);
  expect(entryAccountOptions(context, transfer).accounts.map(account => account.id)).toEqual(expected);
  const destination = entryAccountOptions(context, transfer, "to_account_id");
  expect(destination.accounts.map(account => account.id)).toEqual(["debt", "another-bank", "cash", "asset"]);
  expect(destination.accountGroups.map(group => group.id)).toEqual(context.ordering.account_groups);
  expect(changeEntryKind({ ...transfer, account_id: "debt" }, "collect", context).account_id).toBe("another-bank");
  expect(changeEntryKind(draft({ kind: "expense", account_id: "deleted" }), "income", context).account_id).toBe("");
});

it("lets a transfer select its current destination as the new source before swapping", () => {
  const context = { ...state, accounts: state.accounts.slice(0, 2) };
  const transfer = draft({ kind: "transfer", to_account_id: "bank" });
  expect(entryAccountOptions(context, transfer).accounts.map(account => account.id)).toEqual(["cash", "bank"]);
  const halfway = { ...transfer, account_id: "bank" };
  expect(entryError(halfway, state)).toBe("转账需要两个不同的账户");
  expect(entryAccountOptions(context, halfway, "to_account_id").accounts.map(account => account.id)).toEqual(["cash"]);
  expect(entryError({ ...halfway, to_account_id: "cash" }, state)).toBeUndefined();
});

it.each([["repay", "borrowed"], ["collect", "lent"]])("limits legacy %s funding accounts", (kind, reference_id) => {
  const entry = draft({ kind, reference_id });
  expect(entryAccountOptions(state, entry).accounts.map(account => account.id)).toEqual(["cash", "bank"]);
});

it.each(["transfer", "balance_in", "balance_out"])("preserves the imported category when copying or editing %s", kind => {
  const imported = draft({ kind, category: "Sui/原始用途", to_account_id: kind === "transfer" ? "bank" : null });
  const copied = initializeEntryDraft(imported, state, "copy");
  expect(copied.category).toBe("Sui/原始用途");
  expect(entryError(copied, state)).toBeUndefined();
  expect(initializeEntryDraft(imported, state, "edit").category).toBe("Sui/原始用途");
});

it("copies a deleted expense category using the first available category in display order", () => {
  const copied = draft({ kind: "expense", category: "日常/已删除" });
  const context = { ...state, ordering: { accounts: [], categories: ["未分类", "日常/餐饮"], version: 1 } };
  const initialized = initializeEntryDraft(copied, context, "copy");
  expect(initialized.category).toBe("未分类");
  expect(entryError(initialized, context)).toBeUndefined();
});

it("checks a bulk update in queue order when entries depend on each other", () => {
  const purchase = entries.find(entry => entry.id === "purchase")!;
  const refund = entries.find(entry => entry.id === "refund")!;
  const resizedPurchase = { ...purchase, amount_cents: 300 };
  const resizedRefund = { ...refund, amount_cents: 200 };
  expect(validateEntries([resizedPurchase, resizedRefund], state)).toBe("修改会使已关联交易的金额或日期无效");
  expect(validateEntries([resizedRefund, resizedPurchase], state)).toBeUndefined();
});
