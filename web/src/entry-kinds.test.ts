import { describe, expect, it } from "vitest";
import fixture from "../../tests/fixtures/entry-rules/editors.json";
import { categoryOptions, changeEntryKind, entryError, entryRoles, kindOptions, validateEntries } from "./entry-kinds";
import type { Account, Entry } from "./types";

const draft = (fields: object) => ({ id: "candidate", ...fixture.defaults, ...fields }) as Entry;
const entries = fixture.originals.map(draft);
const state = {
  accounts: fixture.accounts.map(account => ({ ...account, opening_cents: 0, balance_cents: 0, version: 1 })) satisfies Account[],
  category_catalog: fixture.catalog,
  entries,
};

describe("entry rules shared with the server", () => {
  it.each(fixture.cases)("$name", ({ entry, valid, reason }) => {
    const error = entryError(draft(entry), state, "2026-11-21");
    expect(error === undefined).toBe(valid);
    if (reason) expect(error).toBe(reason);
  });
});

it("offers only compatible bulk categories and preserves special kinds on their own entries", () => {
  expect(categoryOptions(state, "expense", "income")).toEqual(["未分类"]);
  expect(categoryOptions(state, "expense", "refund")).toEqual([]);
  expect(kindOptions().map(([kind]) => kind)).not.toContain("refund");
  expect(kindOptions("balance_out").map(([kind]) => kind)).toContain("balance_out");
});

it("resets links and selects an eligible funding account on a kind change", () => {
  const previous = draft({ kind: "transfer", account_id: "debt", to_account_id: "cash", category: "日常/餐饮" });
  const changed = changeEntryKind(previous, "collect", state);
  expect(changed).toMatchObject({ kind: "collect", account_id: "cash", to_account_id: null, reference_id: null, category: "" });
  expect(entryRoles(changed)).toMatchObject({ account: "收款账户", target: { label: "债权账户" } });
});

it("checks a bulk update in queue order when entries depend on each other", () => {
  const purchase = entries.find(entry => entry.id === "purchase")!;
  const refund = entries.find(entry => entry.id === "refund")!;
  const resizedPurchase = { ...purchase, amount_cents: 300 };
  const resizedRefund = { ...refund, amount_cents: 200 };
  expect(validateEntries([resizedPurchase, resizedRefund], state)).toBe("修改会使已关联交易的金额或日期无效");
  expect(validateEntries([resizedRefund, resizedPurchase], state)).toBeUndefined();
});
