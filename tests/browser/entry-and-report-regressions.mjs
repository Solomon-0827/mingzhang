import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const [mode, origin] = process.argv.slice(2);
const playwright = process.env.MZ_PLAYWRIGHT_MODULE;
assert(playwright, "Set MZ_PLAYWRIGHT_MODULE to the absolute path of Playwright's index.mjs.");
const { chromium } = await import(pathToFileURL(playwright));

for (let attempt = 0; attempt < 100; attempt++) {
  if (await fetch(origin + "/api/state").then(r => r.ok).catch(() => false)) break;
  await new Promise(resolve => setTimeout(resolve, 50));
}
const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
async function api(path, body, method = "POST", status = 200) {
  const response = await fetch(origin + "/api" + path, body === undefined ? {} : {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

const a = (await api("/accounts", { name: "Wallet A", kind: "wallet" })).id;
const b = (await api("/accounts", { name: "Bank B", kind: "bank" })).id;
const add = (kind, fields = {}) => api("/entries", { date, kind, account_id: a, amount_cents: 100, ...fields });
const parent = "ShortReview";
const child = "C".repeat(40);
const renamePath = parent + "/" + child;
const copyPath = "ReviewCat/DeletedWhileCopying";
if (mode === "rename") await add("expense", { category: renamePath });
if (mode === "swap") await add("transfer", { to_account_id: b, merchant: "Reversal transfer" });
if (mode === "copy") await add("expense", { category: copyPath });
if (mode === "restore") {
  const purchase = await add("expense", { category: "日常/餐饮", amount_cents: 5000 });
  const refund = await add("refund", { reference_id: purchase.id, amount_cents: 4000, merchant: "Restore refund" });
  await api(`/entries/${refund.id}/delete`, { version: refund.version });
  await api(`/entries/${purchase.id}`, { ...purchase, amount_cents: 3000 }, "PUT");
  const rejected = await api(`/entries/${refund.id}/restore`, { version: refund.version + 1 }, "POST", 400);
  assert.match(rejected.detail, /金额超过原交易/);
}

const browser = await chromium.launch({ executablePath: process.env.MZ_CHROMIUM,
  args: ["--no-proxy-server"], headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1450, height: 1050 } });
  const writes = [];
  const reports = [];
  context.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (response.request().headers()["x-mingzhang-mutation"])
      writes.push([path, response.status(), response.request().postDataJSON()]);
    if (path === "/api/report") reports.push(response);
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(origin);
  const nav = (name, target = page) => target.locator("#workspace-nav").getByRole("button", { name, exact: true }).click();
  const button = (name, target = page) => target.getByRole("button", { name, exact: true });
  const row = name => page.locator("tr").filter({ hasText: name });
  const footer = (part, target = page) => target.locator("footer").getByText(part, { exact: false }).waitFor();
  const synced = () => footer("本机与云端已同步");

  if (mode === "rename") {
    await nav("设置");
    await button("查看二级分类：" + parent).click();
    await context.setOffline(true);
    await button("收藏分类：" + renamePath).click();
    await footer("1 项");
    await button("拖动排序：" + parent).press("Alt+ArrowUp");
    await footer("2 项");
    await button("编辑分类：" + parent).click();
    await page.getByRole("textbox", { name: "分类名称" }).fill("");

    await page.keyboard.insertText("😀".repeat(40));
    const length = [...await page.getByRole("textbox", { name: "分类名称" }).inputValue()].length;
    await button("确认分类修改").click();
    await footer("3 项");
    await context.setOffline(false);
    await page.waitForFunction(() => /本机与云端已同步|有修改未能同步/.test(document.querySelector("footer")?.textContent));
    console.log("Rename emoji count and queued responses", length, writes.map(w => w[1]));
    assert.equal(length, 20);
    assert.deepEqual(writes.map(w => w[1]), [200, 200, 200]);
    assert((await api("/state")).ordering.favorites.includes("😀".repeat(20) + "/" + child));
  }
  if (mode === "swap") {
    await nav("全部流水");
    await row("Reversal transfer").getByRole("button", { name: "编辑", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const comboboxes = dialog.getByRole("combobox");
    async function choose(index, group, name) {
      await comboboxes.nth(index).click();
      const popup = page.locator(".account-cascader-popup:visible").last();
      const groupOption = popup.getByText(group, { exact: true });
      await popup.waitFor();
      assert.equal(await groupOption.count(), 1, name + " missing in the picker");
      await groupOption.hover();
      await popup.getByText(name, { exact: true }).click();
    }
    await choose(0, "银行卡", "Bank B");
    await choose(1, "电子钱包", "Wallet A");
    await button("记一笔", dialog).click();
    await dialog.waitFor({ state: "hidden" });
    await synced();
    assert.deepEqual(writes.map(w => [w[1], w[2].account_id, w[2].to_account_id]), [[200, b, a]]);
    console.log("Swapped transfer synced with HTTP 200");

    const debt = await api("/accounts", { name: "Debt C", kind: "liability" });
    await add("repay", { to_account_id: debt.id });
    await page.reload();
    await nav("记一笔");
    await button("批量修改账目").click();
    await page.locator(".editable-entry-row").filter({
      has: page.locator(".book-kind").getByText("还款", { exact: true }),
    }).getByRole("checkbox").check();
    await button("修改所选").click();
    const bulk = page.getByRole("dialog", { name: "批量修改账目" });
    await bulk.getByRole("checkbox", { name: "启用账户修改" }).check();
    await bulk.getByRole("combobox", { name: "批量修改账户" }).click();
    await page.locator(".account-cascader-popup:visible").getByText("负债", { exact: true }).hover();
    await page.locator(".account-cascader-popup:visible").getByText("Debt C", { exact: true }).click();
    await button("应用修改", bulk).click();
    await bulk.getByRole("alert").getByText("还款请选择付款资金账户和负债账户；回款请选择收款资金账户和债权账户").waitFor();
    assert.equal(writes.length, 1);
  }
  if (mode === "copy") {
    await nav("全部流水");
    await row(copyPath).getByRole("button", { name: "复制交易" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const settings = await context.newPage();
    await settings.goto(origin);
    await nav("设置", settings);
    await button("查看二级分类：ReviewCat", settings).click();
    await context.setOffline(true);
    await button("删除分类：" + copyPath, settings).click();
    await button("确认分类修改", settings).click();
    await footer("1 项");
    await button("记一笔", dialog).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]') || document.querySelector('[role="dialog"] .error'));
    await context.setOffline(false);
    await synced();
    assert.deepEqual(writes.map(w => w[1]), [200, 200]);
    assert.equal(writes[1][2].category, "日常/餐饮");
    console.log("Copy picked 日常/餐饮 after deletion and both writes synced");
  }
  if (mode === "report") {
    const server = await api(`/report?start=${date}&end=${date}`);
    assert.equal(server.net, 1);
    assert.equal(server.daily[0].cumulative, 1);
    // Submit another entry from outside the browser after it has loaded its ledger.
    // The online report should see it while the browser's offline ledger is still stale.
    await page.locator("#workspace-nav").waitFor();
    await add("income", { amount_cents: 2, category: "income" });
    await nav("收支报表");
    const net = page.locator(".metric.balance strong");
    await page.waitForFunction(() => document.querySelector(".metric.balance strong")?.textContent.includes("0.03"));
    assert(reports.length > 0);
    assert.equal((await reports.at(-1).json()).net, 3);
    const onlineCalls = reports.length;
    await context.setOffline(true);
    await page.waitForFunction(() => document.querySelector(".metric.balance strong")?.textContent.includes("0.01"));
    assert.match(await net.textContent(), /0\.01/);
    assert.equal(reports.length, onlineCalls);
    console.log("API returned a 1-cent net and cumulative balance. Report showed 3 cents online and 1 cent offline.");
  }
  if (mode === "restore") {
    await nav("全部流水");
    await button("回收站").click();
    await button("恢复交易", row("Restore refund")).click();
    await page.waitForFunction(() => /金额超过原交易|有修改未能同步/.test(document.body.textContent));
    console.log("Restore write statuses", writes.map(w => w[1]));
    assert.equal(writes.length, 0);
    assert.equal(await row("Restore refund").count(), 1);
    await synced();
  }
} finally {
  await browser.close();
}
