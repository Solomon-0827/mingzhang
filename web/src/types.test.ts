import { describe, expect, it } from "vitest";
import { orderedAccountOptions, type State } from "./types";

describe("entry account options", () => {
  it("uses account and account-type order from settings, including the default account", () => {
    const state = {
      accounts: [
        { id: "icbc", name: "工商银行", kind: "bank", group_id: "banks", opening_cents: 0, balance_cents: 0, version: 1 },
        { id: "ccb", name: "建设银行", kind: "bank", group_id: "banks", opening_cents: 0, balance_cents: 0, version: 1 },
        { id: "alipay", name: "支付宝", kind: "wallet", group_id: "wallets", opening_cents: 0, balance_cents: 0, version: 1 },
        { id: "cash", name: "现金", kind: "cash", group_id: "cash-group", opening_cents: 0, balance_cents: 0, version: 1 },
      ],
      account_groups: [
        { id: "banks", name: "银行卡", kind: "bank" },
        { id: "wallets", name: "电子钱包", kind: "wallet" },
        { id: "cash-group", name: "现金", kind: "cash" },
      ],
      ordering: {
        accounts: ["ccb", "icbc", "cash", "alipay"],
        account_groups: ["wallets", "cash-group", "banks"],
        categories: [],
        version: 2,
      },
    } as Pick<State, "accounts" | "account_groups" | "ordering">;

    const options = orderedAccountOptions(state);

    expect(options.accounts.map(account => account.id)).toEqual(["alipay", "cash", "ccb", "icbc"]);
    expect(options.accountGroups.map(group => group.id)).toEqual(["wallets", "cash-group", "banks"]);
    expect(options.accounts[0].name).toBe("支付宝");
  });
});
