import { useState, useRef, type ReactNode } from "react";
import { GripVertical, ChevronRight, Folder } from "lucide-react";
import { Account, DisplayOrder, State, ordered, accountLabels } from "./types";
import { categoryGroups, categoryLeaf } from "./category-groups";

function SortList({ items, scope, disabled, onMove, render }: {
  items: string[]; scope: string; disabled: boolean;
  onMove: (from: number, to: number) => void; render: (id: string) => ReactNode;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const pointer = useRef<{ from: number; to: number; y: number } | null>(null);
  return <ul className="sort-list" aria-label={scope === "accounts" ? "账户排序" : scope === "parents" ? "一级分类排序" : "二级分类排序"}>
    {items.map((id, index) => <li key={id} className={`${dragging === index ? "is-dragging" : ""} ${over === index && dragging !== index ? "drop-target" : ""}`}>
      <button type="button" className="drag-handle" disabled={disabled}
        aria-label={`拖动排序：${id}`} title="拖动排序；也可按 Alt + 上下方向键"
        onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); pointer.current = {from:index,to:index,y:e.clientY}; setDragging(index); }}
        onPointerMove={e => {
          if (!pointer.current) return;
          const list = e.currentTarget.closest("ul")!; const bounds = list.getBoundingClientRect();
          if (e.clientX < bounds.left || e.clientX > bounds.right) {pointer.current.to = pointer.current.from; setOver(null); return;}
          if (e.clientY < bounds.top + 28) list.scrollTop -= 14;
          if (e.clientY > bounds.bottom - 28) list.scrollTop += 14;
          const rows = Array.from(list.children);
          const to = rows.findIndex(row => { const box = row.getBoundingClientRect(); return e.clientY >= box.top && e.clientY <= box.bottom; });
          if (to >= 0) {pointer.current.to = to; setOver(to);}
        }}
        onPointerUp={e => { const p = pointer.current; pointer.current = null; if (p && Math.abs(e.clientY-p.y)>4 && p.from !== p.to) onMove(p.from,p.to); setDragging(null);setOver(null); }}
        onPointerCancel={() => {pointer.current=null;setDragging(null);setOver(null);}}
        onLostPointerCapture={() => {pointer.current=null;setDragging(null);setOver(null);}}
        onKeyDown={e => { if (e.altKey && ["ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); const to = index + (e.key === "ArrowUp" ? -1 : 1); if (to >= 0 && to < items.length) onMove(index, to); } }}><GripVertical size={18} /></button>
      {render(id)}
    </li>)}
  </ul>;
}
const move = (items: string[], from: number, to: number) => {
  const result = [...items]; const [item] = result.splice(from, 1); result.splice(to, 0, item); return result;
};
export function OrderSettings({ state, defaults, onSave, onEditAccount }: {
  state: State; defaults: string[]; onSave: (value: DisplayOrder) => Promise<void>; onEditAccount: (value: Account) => void;
}) {
  const initialCategories = () => ordered(Array.from(new Set([...defaults, ...state.entries.filter(e => !e.deleted && ["income", "expense"].includes(e.kind)).map(e => e.category)])).filter(Boolean), state.ordering?.categories);
  const [accounts, setAccounts] = useState(state.accounts.map(a => a.id));
  const [categories, setCategories] = useState(initialCategories);
  const [section, setSection] = useState("categories");
  const groups = categoryGroups(categories);
  const [selected, setSelected] = useState(groups[0]?.name ?? "");
  const group = groups.find(g => g.name === selected) ?? groups[0];
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  return <section className="panel settings-panel">
    <div className="settings-tabs" role="tablist" aria-label="设置">
      <button role="tab" aria-selected={section === "categories"} onClick={() => setSection("categories")}>分类管理</button>
      <button role="tab" aria-selected={section === "accounts"} onClick={() => setSection("accounts")}>账户管理</button>
    </div>
    <div className="settings-intro"><h2>{section === "categories" ? "分类层级与排序" : "账户排序与设置"}</h2>
      <p>{section === "categories" ? "拖动左侧手柄调整顺序。一级分类整组移动，二级分类在所属组内移动。" : "拖动左侧手柄调整账户顺序，点击编辑修改账户信息。"}</p></div>
    {section === "categories" ? <div className="category-manager">
      <section className="parent-column"><div className="settings-column-heading">一级分类 <small>{groups.length} 个</small></div>
        <SortList scope="parents" items={groups.map(g => g.name)} disabled={busy} onMove={(from,to) => {
          setCategories(move(groups.map(g => g.name),from,to).flatMap(name => groups.find(g => g.name === name)!.items)); setDirty(true);
        }} render={name => <button type="button" className={`parent-choice ${group?.name === name ? "selected" : ""}`} onClick={() => setSelected(name)}>
          <Folder size={17}/><strong>{name}</strong><small>{groups.find(g => g.name === name)!.items.length}</small><ChevronRight size={16}/></button>} />
      </section>
      <section className="child-column"><div className="settings-column-heading"><span>{group?.name} <ChevronRight size={14}/> 二级分类</span><small>{group?.items.length ?? 0} 个</small></div>
        {group && <SortList key={group.name} scope="children" items={group.items} disabled={busy} onMove={(from,to) => {
          setCategories(groups.flatMap(g => g.name === group.name ? move(g.items,from,to) : g.items)); setDirty(true);
        }} render={id => <div className="child-label"><span className="tree-branch">└</span><strong>{categoryLeaf(id)}</strong><small>属于 {group.name}</small></div>} />}
      </section>
    </div> : <div className="account-settings-list"><div className="settings-column-heading">账户 <small>{accounts.length} 个</small></div>
      <SortList scope="accounts" items={accounts} disabled={busy} onMove={(from,to) => {setAccounts(move(accounts,from,to));setDirty(true);}}
        render={id => { const account = state.accounts.find(a => a.id === id)!; return <><div className="account-setting-name"><strong>{account.name}</strong><small>{accountLabels[account.kind]}</small></div><button type="button" className="text-button" disabled={busy} onClick={() => onEditAccount(account)}>编辑</button></>; }} />
    </div>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="settings-save"><span>{dirty ? "有未保存的排序调整" : "顺序已保存，记账与编辑下拉列表共用。"}</span>
      <button disabled={!dirty || busy} onClick={() => {setAccounts(state.accounts.map(a=>a.id));setCategories(initialCategories());setDirty(false);setError("");}}>撤销调整</button>
      <button className="primary" disabled={!dirty || busy} onClick={async () => {setBusy(true);setError("");try {await onSave({accounts,categories,version:state.ordering?.version ?? 0});setDirty(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>{busy ? "保存中…" : "保存排序"}</button>
    </div>
  </section>;
}
