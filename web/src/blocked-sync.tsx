import { useState } from "react";
import type { BlockedMutation } from "./sync-queue";
import { labels, money, type Entry, type State } from "./types";

const titles = {
  "entry.create": "新增流水",
  "entry.update": "修改流水",
  "entry.delete": "删除流水",
  "entry.restore": "恢复流水",
  "account.create": "新增账户",
  "account.update": "修改账户",
  "account.delete": "删除账户",
  "account-group.create": "新增账户类型",
  "account-group.rename": "修改账户类型",
  "account-group.delete": "删除账户类型",
  "order.update": "修改显示顺序和常用分类",
} as const;

export function describeBlocked(item: BlockedMutation, state: State | null) {
  const fields: [string, string][] = [];
  const field = (label: string, value: unknown) => fields.push([label, String(value || "—")]);
  const amount = (value: unknown) => typeof value === "number" ? `¥${money(value)}` : undefined;
  const account = (id?: string | null) => state?.accounts.find(value => value.id === id)?.name || id;
  const targetId = item.path.split("/")[2];
  const body = item.body;
  let title: string;
  if (item.type === "category.change") {
    const actions: Record<string, string> = { add: "新增", rename: "修改", delete: "删除", restore: "恢复" };
    title = (actions[String(body.action)] || "修改") + "分类";
    field("分类", body.path);
    if (body.name) field("新名称", body.name);
  } else {
    title = titles[item.type];
    if (item.type.startsWith("entry.")) {
      const entry = (item.type === "entry.create" || item.type === "entry.update")
        ? body as unknown as Entry
        : item.entryDetails ?? state?.entries.find(value => value.id === targetId);
      field("日期", entry?.date);
      field("类型", entry && (labels[entry.kind] || entry.kind));
      field("金额", amount(entry?.amount_cents));
      field("账户", account(entry?.account_id));
      if (entry?.to_account_id) field("关联账户", account(entry.to_account_id));
      field("分类", entry?.category);
      field("备注", entry?.memo);
      if (entry?.merchant) field("商家", entry.merchant);
      if (entry?.counterparty) field("往来对象", entry.counterparty);
      if (!entry) field("流水编号", targetId);
    } else if (item.type.startsWith("account.")) {
      field("账户", body.name || account(targetId));
      if (body.target_balance_cents !== undefined) field("调整后余额", amount(body.target_balance_cents));
      else if (body.opening_cents !== undefined) field("期初余额", amount(body.opening_cents));
    } else if (item.type.startsWith("account-group.")) {
      const name = state?.account_groups.find(group => group.id === targetId)?.name;
      field("账户类型", name || body.name || targetId);
      if (name && body.name) field("新名称", body.name);
    } else if (item.type === "order.update") {
      for (const [label, values] of [["账户", body.accounts], ["账户类型", body.account_groups],
        ["分类", body.categories], ["常用分类", body.favorites]] as const) {
        if (Array.isArray(values)) field(label, `${values.length} 项`);
      }
    }
  }
  return { title, fields };
}

export function BlockedSyncDetails({ item, state, waiting, onRetry, onEdit, onDiscard }: {
  item: BlockedMutation;
  state: State | null;
  waiting: number;
  onRetry: () => Promise<void>;
  onEdit: () => Promise<void>;
  onDiscard: () => Promise<void>;
}) {
  const { title, fields } = describeBlocked(item, state);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [copyText, setCopyText] = useState("");
  const reason = `${item.blocked.message}（${item.blocked.status}）`;
  const rejectedAt = new Date(item.blocked.at).toLocaleString("zh-CN");
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="blocked-sync-details" aria-busy={busy}>
      <h3>{title}</h3>
      <dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p><strong>上次拒绝原因</strong> {reason}</p>
      <p><small>{rejectedAt} · 后续 {waiting} 项修改正在等待同步</small></p>
      <div className="blocked-sync-actions">
        <button type="button" className="primary" autoFocus disabled={busy} onClick={() => void run(onRetry)}>重新同步</button>
        {(item.type === "entry.create" || item.type === "entry.update") &&
          <button type="button" className="secondary" disabled={busy} onClick={() => void run(onEdit)}>修改后重新同步</button>}
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
          const text = [title, ...fields.map(([label, value]) => `${label}：${value}`),
            `拒绝原因：${reason}`, `拒绝时间：${rejectedAt}`, "", "原始 JSON", JSON.stringify(item, null, 2)].join("\n");
          try {
            await navigator.clipboard.writeText(text);
            setCopyText("");
            setMessage("已复制修改内容");
          } catch {
            setCopyText(text);
            setMessage("无法访问剪贴板，请选中下方内容手动复制。");
          }
        })}>复制内容</button>
        <button type="button" className="secondary discard-sync" disabled={busy} onClick={() => {
          const contents = fields.map(([label, value]) => `${label}：${value}`).join("\n");
          if (window.confirm(`确定放弃「${title}」？\n\n${contents}\n\n这条本机修改将被移除，无法撤销。后续 ${waiting} 项修改仍会保留。`))
            void run(onDiscard);
        }}>放弃这条修改</button>
      </div>
      {message && <p role="status">{message}</p>}
      {copyText && <textarea aria-label="修改内容" readOnly value={copyText} onFocus={event => event.currentTarget.select()} />}
    </div>
  );
}
