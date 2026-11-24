import { expect, it } from "vitest";
import { canOpenCachedLedgerBeforeAuthentication } from "./startup-policy";

it("opens a cached ledger before the network only inside the trusted desktop shell", () => {
  expect(canOpenCachedLedgerBeforeAuthentication(true, true)).toBe(true);
  expect(canOpenCachedLedgerBeforeAuthentication(false, true)).toBe(false);
  expect(canOpenCachedLedgerBeforeAuthentication(true, false)).toBe(false);
});
