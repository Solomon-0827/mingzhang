import { useState } from "react";
import { DisplayOrder, State, ordered } from "./types";

export function OrderSettings({ state, defaults, onSave }: {
  state: State; defaults: string[]; onSave: (value: DisplayOrder) => Promise<void>;
}) {
  const [accounts, setAccounts] = useState(state.accounts.map(a => a.id));
  const [categories, setCategories] = useState(() => ordered(
    Array.from(new Set([...defaults, ...state.entries.filter(e => !e.deleted && ["income", "expense"].includes(e.kind)).map(e => e.category)])).filter(Boolean),
    state.ordering?.categories,
  ));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const move = (items: string[], from: number, to: number, setItems: (value: string[]) => void) => {
    const next = [...items]; const [item] = next.splice(from, 1); next.splice(to, 0, item); setItems(next);
  };
  return <form onSubmit={async e => {
    e.preventDefault(); if (busy) return; setBusy(true); setError("");
    try { await onSave({ accounts, categories, version: state.ordering?.version ?? 0 }); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }}>
    <p className="order-help">用置顶、上移或下移调整顺序。保存后，记账和编辑时的下拉列表都会同步更新。</p>
    <div className="order-columns">
      {([{ title: "分类", items: categories, update: setCategories, name: (id: string) => id.replace("/", " · ") },
        { title: "账户", items: accounts, update: setAccounts, name: (id: string) => state.accounts.find(a => a.id === id)?.name || id }]).map(group =>
        <section key={group.title}><h3>{group.title}</h3><ol className="order-list">
          {group.items.map((id, i) => <li key={id}><span>{group.name(id)}</span><div>
            <button type="button" disabled={busy || i === 0} aria-label={`置顶${group.title}：${group.name(id)}`} onClick={() => move(group.items, i, 0, group.update)}>置顶</button>
            <button type="button" disabled={busy || i === 0} aria-label={`上移${group.title}：${group.name(id)}`} onClick={() => move(group.items, i, i - 1, group.update)}>↑</button>
            <button type="button" disabled={busy || i === group.items.length - 1} aria-label={`下移${group.title}：${group.name(id)}`} onClick={() => move(group.items, i, i + 1, group.update)}>↓</button>
          </div></li>)}
        </ol></section>)}
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="modal-footer"><small>顺序保存在账本中，网页版与 Mac 共用。</small><button className="primary" disabled={busy}>{busy ? "保存中…" : "保存排序"}</button></div>
  </form>;
}
