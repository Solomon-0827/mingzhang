import { useState } from "react";
import { applyMutation, type OfflineMutation } from "./offline-mutations";
import type { BlockedMutation } from "./sync-queue";
import { ordered, labels, money, type Entry, type State } from "./types";

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

const entryFields = {
  date: "日期", kind: "类型", amount_cents: "金额", account_id: "账户", to_account_id: "关联账户",
  category: "分类", merchant: "商家", memo: "备注", counterparty: "往来对象", reference_id: "关联原交易",
} as const;
type EntryField = keyof typeof entryFields;
const entryKeys = Object.keys(entryFields) as EntryField[];

export function prepareEntryRecovery(target: BlockedMutation, snapshot: State, defaults: Entry) {
  const queued = { ...defaults, ...target.body } as Entry;
  const id = target.type === "entry.update" ? target.path.split("/")[2] : queued.id;
  const current = snapshot.entries.find(entry => entry.id === id);
  if (current?.deleted || (!current && target.type === "entry.update")) {
    throw new Error("服务器上的这笔流水已不存在，无法编辑。你仍可复制内容或放弃这条修改。");
  }
  return { entry: current ?? queued, queued, current };
}

export function entryRecoveryChange(initial: Entry, editing: boolean, value: Entry) {
  // The editable fields below are also the fields displayed in the comparison.
  const body = { id: initial.id, version: initial.version,
    ...Object.fromEntries(entryKeys.map(key => [key, value[key]])) };
  return editing
    ? { type: "entry.update", path: `/entries/${initial.id}`, method: "PUT", body } as const
    : { type: "entry.create", path: "/entries", method: "POST", body } as const;
}

export function canRebase(item: OfflineMutation, state: State | null) {
  const catalog = state?.category_catalog;
  if (item.type !== "category.change" || item.body.action !== "add" || !catalog || typeof item.body.path !== "string")
    return false;
  // Catalog paths have no stable identity. Retrying a rename, delete or restore against
  // a new version could change categories or entries that were outside the original intent.
  const path = item.body.path.trim();
  const [parent] = path.split("/");
  const retired = [...catalog.hidden, ...(catalog.retired ?? [])];
  if (Object.hasOwn(catalog.items, path) ||
    retired.some(name => name === path || (item.body.level === "parent" && name.startsWith(path + "/"))))
    return false;
  const children = Object.keys(catalog.items).some(name => name.startsWith(parent + "/"));
  return item.body.level === "parent" ? !children : children && !Object.hasOwn(catalog.items, parent);
}

export function rebaseChange(item: OfflineMutation, snapshot: State) {
  if (!canRebase(item, snapshot)) throw new Error("最新分类与这条修改冲突，请在设置中重新操作。");
  const { type, path, method, body } = item;
  return { type, path, method, body: { ...body, version: snapshot.category_catalog!.version } };
}

export function recoverySettings(item: OfflineMutation) {
  if (item.type === "account.update" || item.type === "account.delete") return "accounts";
  if (item.type === "order.update" || item.type === "category.change") return "categories";
  return null;
}

function entryFieldValue(key: EntryField, entry: Entry, accounts: State["accounts"], entries: Entry[]) {
  const value = entry[key];
  if (key === "kind") return labels[entry.kind];
  if (key === "amount_cents") return `¥${money(entry.amount_cents)}`;
  if (key === "account_id" || key === "to_account_id") {
    const account = accounts.find(item => item.id === value);
    return account ? `${account.name}（${account.id}）` : value || "空";
  }
  if (key === "reference_id") {
    const source = entries.find(item => item.id === value);
    return source ? `${source.date} · ${source.category} · ¥${money(source.amount_cents)}（${source.id}）` : value || "空";
  }
  return value || "空";
}

export function EntryRecoveryComparison({ current, queued, value, accounts, entries, onChoose }: {
  current: Entry;
  queued: Entry;
  value: Entry;
  accounts: State["accounts"];
  entries: Entry[];
  onChoose: (key: EntryField, source: Entry) => void;
}) {
  const differences = entryKeys.filter(key => current[key] !== queued[key] || current[key] !== value[key]);
  return (
    <fieldset className="entry-recovery-comparison">
      <legend>与服务器当前流水对照</legend>
      {differences.length ? differences.map(key => (
        <div key={key}>
          <strong>{entryFields[key]}</strong>
          <p>服务器：{entryFieldValue(key, current, accounts, entries)}</p>
          {current[key] !== queued[key] && <p>排队修改：{entryFieldValue(key, queued, accounts, entries)}</p>}
          <p>将保存：{entryFieldValue(key, value, accounts, entries)}</p>
          <button type="button" className="secondary" aria-label={`保留服务器${entryFields[key]}`}
            disabled={current[key] === value[key]} onClick={() => onChoose(key, current)}>保留服务器值</button>
          {current[key] !== queued[key] && <button type="button" className="secondary" aria-label={`采用排队${entryFields[key]}`}
            disabled={queued[key] === value[key]} onClick={() => onChoose(key, queued)}>采用排队值</button>}
        </div>
      )) : <p>排队修改与服务器当前流水一致。</p>}
    </fieldset>
  );
}

function describeOrder(item: OfflineMutation, state: State | null, field: (label: string, value: string) => void) {
  const next = state ? applyMutation(state, item) : null;
  const quote = (value: string) => `「${value}」`;
  const list = (values: string[]) => values.map(quote).join("、") || "无";
  const categoryNames = (value: State) => ordered(value.category_catalog ? Object.keys(value.category_catalog.items) : value.ordering?.categories ?? [],
    value.ordering?.categories);
  const scopes = [
    { label: "账户顺序", key: "accounts", read: (value: State) => value.accounts.map(a => a.id),
      name: (id: string) => state?.accounts.find(a => a.id === id)?.name ?? id },
    { label: "账户类型顺序", key: "account_groups", read: (value: State) => value.account_groups.map(g => g.id),
      name: (id: string) => state?.account_groups.find(g => g.id === id)?.name ?? id },
    { label: "分类顺序", key: "categories", read: categoryNames, name: (path: string) => path },
    { label: "常用分类", key: "favorites", read: (value: State) => value.ordering?.favorites ?? [], name: (path: string) => path },
  ];
  for (const { label, key, read, name } of scopes) {
    const queued = item.body[key];
    if (!Array.isArray(queued)) continue;
    if (!state || !next) {
      field(label, `排队设置为${list(queued.map(name))}（本机暂无原顺序）`);
      continue;
    }
    const before = read(state);
    const after = read(next);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const removed = before.filter(id => !after.includes(id)).map(name);
    const added = after.filter(id => !before.includes(id)).map(name);
    const membership = [removed.length && `移除${list(removed)}`, added.length && `加入${list(added)}`].filter(Boolean).join("，");
    const order = `${list(before.map(name))} → ${list(after.map(name))}`;
    field(label, membership ? `${membership}（${order}）` : order);
  }
}

export function describeBlocked(item: OfflineMutation, state: State | null) {
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
        : state?.entries.find(value => value.id === targetId);
      field("日期", entry?.date);
      field("类型", entry && (labels[entry.kind] || entry.kind));
      field("金额", amount(entry?.amount_cents));
      field("账户", account(entry?.account_id));
      if (entry?.to_account_id) field("关联账户", account(entry.to_account_id));
      field("分类", entry?.category);
      field("备注", entry?.memo);
      if (entry?.merchant) field("商家", entry.merchant);
      if (entry?.counterparty) field("往来对象", entry.counterparty);
      if (entry?.reference_id) field("关联原交易", entryFieldValue("reference_id", entry, state?.accounts ?? [], state?.entries ?? []));
      if (!entry) field("流水编号", targetId);
    } else if (item.type.startsWith("account.")) {
      const old = state?.accounts.find(value => value.id === targetId);
      field("账户", old && body.name && body.name !== old.name ? `${old.name} → ${body.name}` : body.name || account(targetId));
      if (body.group_id || body.kind) {
        const group = state?.account_groups.find(value => value.id === (body.group_id || body.kind));
        field("账户类型", group?.name ?? body.group_id ?? body.kind);
      }
      if (body.target_balance_cents !== undefined) field("调整后余额", amount(body.target_balance_cents));
      else if (body.opening_cents !== undefined) field("期初余额", amount(body.opening_cents));
    } else if (item.type.startsWith("account-group.")) {
      const name = state?.account_groups.find(group => group.id === targetId)?.name;
      field("账户类型", name || body.name || targetId);
      if (name && body.name) field("新名称", body.name);
      if (body.kind) field("账户性质", state?.account_groups.find(group => group.id === body.kind)?.name ?? body.kind);
    } else if (item.type === "order.update") {
      describeOrder(item, state, field);
      if (!fields.length) field("显示顺序和常用分类", "与当前设置一致");
    }
  }
  return { title, fields };
}

export function BlockedSyncDetails({ item, state, waiting, onRetry, onEdit, onRebase, onOpenSettings, onDiscard }: {
  item: OfflineMutation & Partial<Pick<BlockedMutation, "blocked">>;
  state: State | null;
  waiting: number;
  onRetry: () => Promise<void>;
  onEdit?: () => Promise<void>;
  onRebase?: () => Promise<void>;
  onOpenSettings?: () => Promise<void>;
  onDiscard: (confirm: (snapshot: State) => boolean) => Promise<void>;
}) {
  const { title, fields } = describeBlocked(item, state);
  const rebase = item.blocked?.status === 409 && canRebase(item, state);
  const settings = item.blocked?.status === 409 && !rebase && recoverySettings(item);
  const discard = (snapshot: State) => {
    const contents = describeBlocked(item, snapshot).fields.map(([label, value]) => `${label}：${value}`).join("\n");
    return window.confirm(`确定放弃「${title}」？\n\n${contents}\n\n这条本机修改将被移除，无法撤销。后续 ${waiting} 项修改仍会保留。`);
  };
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [copyText, setCopyText] = useState("");
  const reason = item.blocked && `${item.blocked.message}（${item.blocked.status}）`;
  const rejectedAt = item.blocked && new Date(item.blocked.at).toLocaleString("zh-CN");
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
      {reason && <p><strong>上次拒绝原因</strong> {reason}</p>}
      <p><small>{rejectedAt && `${rejectedAt} · `}后续 {waiting} 项修改正在等待同步</small></p>
      {settings && <p>{item.type === "account.update" || item.type === "order.update"
        ? "这条修改使用的是旧设置，直接套用可能覆盖其他设备的账户资料、余额或排序。请打开最新设置重做，再回来放弃这条旧修改。"
        : "对应的设置已发生变化。请打开最新设置重新操作，再回来放弃这条旧修改。"}</p>}
      {!state && <p>联网后才能放弃这条修改</p>}
      <div className="blocked-sync-actions">
        <button type="button" className="primary" autoFocus disabled={busy} onClick={() => void run(onRetry)}>重新同步</button>
        {onEdit && (item.type === "entry.create" || item.type === "entry.update") &&
          <button type="button" className="secondary" disabled={busy} onClick={() => void run(onEdit)}>修改后重新同步</button>}
        {rebase && onRebase && <button type="button" className="secondary" disabled={busy} onClick={() => {
          if (window.confirm(`确定基于最新数据重新同步「${title}」？这会将排队的修改应用到服务器的最新数据上。`))
            void run(onRebase);
        }}>基于最新数据重新同步</button>}
        {settings && onOpenSettings && <button type="button" className="secondary" disabled={busy}
          onClick={() => void run(onOpenSettings)}>打开最新设置</button>}
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
          const text = [title, ...fields.map(([label, value]) => `${label}：${value}`),
            ...(reason ? [`拒绝原因：${reason}`, `拒绝时间：${rejectedAt}`] : []),
            "", "原始 JSON", JSON.stringify(item, null, 2)].join("\n");
          try {
            await navigator.clipboard.writeText(text);
            setCopyText("");
            setMessage("已复制修改内容");
          } catch {
            setCopyText(text);
            setMessage("无法访问剪贴板，请选中下方内容手动复制。");
          }
        })}>复制内容</button>
        <button type="button" className="secondary discard-sync" disabled={busy || !state}
          onClick={() => void run(() => onDiscard(discard))}>放弃这条修改</button>
      </div>
      {message && <p role="status">{message}</p>}
      {copyText && <textarea aria-label="修改内容" readOnly value={copyText} onFocus={event => event.currentTarget.select()} />}
    </div>
  );
}
