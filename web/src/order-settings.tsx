import { Check, ChevronRight, Folder, GripVertical, PencilLine, Plus, RotateCcw, Trash2, Undo2, X } from "lucide-react";
import { motion } from "motion/react";
import { PasswordSettings } from "./password-settings";
import { useState, useRef, useEffect, type ReactNode } from "react";
import { Account, CategoryChange, DisplayOrder, State, ordered, accountLabels } from "./types";
import { StyledSelect } from "./controls";
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
export function OrderSettings({ state, defaults, onSave, onEditAccount, onCategoryChange, onPasswordChanged }: {
  onPasswordChanged: () => void;
  onCategoryChange: (value: CategoryChange) => Promise<void>;
  state: State; defaults: string[]; onSave: (value: DisplayOrder) => Promise<void>; onEditAccount: (value: Account) => void;
}) {
  const initialCategories = () => ordered(state.category_catalog ? Object.keys(state.category_catalog.items) : Array.from(new Set([...defaults, ...state.entries.filter(e => !e.deleted && ["income", "expense"].includes(e.kind)).map(e => e.category)])).filter(Boolean), state.ordering?.categories);
  const [accounts, setAccounts] = useState(state.accounts.map(a => a.id));
  const [categories, setCategories] = useState(initialCategories);
  const [section, setSection] = useState("categories");
  const groups = categoryGroups(categories);
  const [selected, setSelected] = useState(groups[0]?.name ?? "");
  const group = groups.find(g => g.name === selected) ?? groups[0];
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {setCategories(initialCategories());setDirty(false);}, [state.category_catalog?.version]);
  // Follow accounts added or removed elsewhere; an unsaved drag order keeps its positions.
  const accountIds = state.accounts.map(a => a.id).join("\n");
  useEffect(() => {
    const ids = accountIds ? accountIds.split("\n") : [];
    setAccounts(current => dirty ? [...current.filter(id => ids.includes(id)), ...ids.filter(id => !current.includes(id))] : ids);
  }, [accountIds]);
  const [change, setChange] = useState<Omit<CategoryChange, "version"> | null>(null);
  const [name, setName] = useState("");
  const start = (action: CategoryChange["action"], level: CategoryChange["level"], path: string) => {
    setError(""); setChange({action, level, path, kind: state.category_catalog?.items[group?.items[0]]?.[0] ?? "expense"});
    setName(action === "rename" ? (level === "parent" ? path : categoryLeaf(path)) : "");
  };
  const submitChange = async () => {
    if (!change) return;
    setBusy(true);setError("");
    try {
      const path = change.action === "add" ? (change.level === "parent" ? name.trim() : change.path + "/" + name.trim()) : change.path;
      if (["add", "rename"].includes(change.action) && (!name.trim() || name.includes("/"))) throw new Error("名称不能为空或包含斜杠");
      await onCategoryChange({...change,path,name:name.trim(),version:state.category_catalog?.version ?? 0});
      if (change.action === "add" || change.action === "restore") setSelected(path.split("/")[0]);
      if (change.action === "rename" && change.level === "parent") setSelected(name.trim());
      setChange(null);
    } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
  };
  const inlineEditor = () => change && <form className="category-inline-editor" onSubmit={e => {e.preventDefault();void submitChange();}} onKeyDown={e => {if(e.key === "Escape" && !busy){e.preventDefault();setChange(null);setError("");}}}>
    {["add", "rename"].includes(change.action) ? <>
      <input autoFocus aria-label="分类名称" value={name} maxLength={40} onChange={e=>setName(e.target.value)} placeholder={change.level === "parent" ? "一级分类名称" : "二级分类名称"} disabled={busy}/>
      {change.action === "add" && change.level === "parent" && <StyledSelect aria-label="分类收支类型" value={change.kind} onChange={e=>setChange({...change,kind:e.target.value})}><option value="expense">支出</option><option value="income">收入</option></StyledSelect>}
    </> : <span className="inline-delete-copy">{change.action === "delete" ? "删除此分类？历史账目保留，可恢复。" : change.level === "parent" && (state.category_catalog?.hidden.filter(p => p.startsWith(change.path + "/")).length ?? 0) > 0 ? "恢复这一组全部已删除分类？" : "恢复此分类？"}</span>}
    <button className="category-tool confirm" title="确认（Enter）" aria-label="确认分类修改" disabled={busy}><Check size={17} strokeWidth={1.6}/></button>
    <button type="button" className="category-tool" title="取消（Esc）" aria-label="取消分类修改" disabled={busy} onClick={()=>{setChange(null);setError("");}}><X size={17} strokeWidth={1.6}/></button>
    {error && <small className="inline-category-error" role="alert">{error}</small>}
  </form>;
  const rowTools = (level: "parent" | "child", path: string) => <div className="category-row-tools">
    <button className="category-tool" title="编辑" aria-label={`编辑分类：${path}`} disabled={busy || dirty} onClick={()=>start("rename",level,path)}><PencilLine size={16} strokeWidth={1.5}/></button>
    <button className="category-tool delete" title="删除" aria-label={`删除分类：${path}`} disabled={busy || dirty} onClick={()=>start("delete",level,path)}><Trash2 size={16} strokeWidth={1.5}/></button>
  </div>;
  // A path without "/" restores the whole first-level group: the group itself and all of its deleted children.
  const removedRow = (path: string, label: string, action = "恢复") => <div key={path} className={path.includes("/") ? "removed-child" : undefined}>
    <span>{label}</span>
    {change?.action === "restore" && change.path === path ? inlineEditor() : <button aria-label={action} title={action} disabled={busy || dirty} onClick={()=>start("restore",path.includes("/") ? "child" : "parent",path)}><RotateCcw size={18} aria-hidden="true" /></button>}
  </div>;
  return <section className="panel settings-panel">
    <div className="settings-tabs" role="tablist" aria-label="设置">
      <button role="tab" aria-selected={section === "categories"} onClick={() => setSection("categories")}><span>分类管理</span>{section === "categories" && <motion.i className="settings-tab-indicator" layoutId="settings-tab-active" transition={{ type: "spring", stiffness: 450, damping: 34 }} />}</button>
      <button role="tab" aria-selected={section === "accounts"} onClick={() => setSection("accounts")}><span>账户管理</span>{section === "accounts" && <motion.i className="settings-tab-indicator" layoutId="settings-tab-active" transition={{ type: "spring", stiffness: 450, damping: 34 }} />}</button>
      <button role="tab" aria-selected={section === "password"} onClick={() => setSection("password")}><span>修改密码</span>{section === "password" && <motion.i className="settings-tab-indicator" layoutId="settings-tab-active" transition={{ type: "spring", stiffness: 450, damping: 34 }} />}</button>
    </div>
    {section === "password" ? <PasswordSettings onChanged={onPasswordChanged} /> : <>
    <div className="settings-intro"><h2>{section === "categories" ? "分类层级与排序" : "账户排序与设置"}</h2>
      <p>{section === "categories" ? "拖动左侧手柄调整顺序。一级分类整组移动，二级分类在所属组内移动。" : "拖动左侧手柄调整账户顺序，点击编辑修改账户信息。"}</p></div>
    {section === "categories" ? <div className="category-manager">
      <section className="parent-column"><div className="settings-column-heading"><span>一级分类 <small>{groups.length}</small></span><button className="category-tool add" title="新增一级分类" aria-label="新增一级分类" disabled={busy || dirty} onClick={()=>start("add","parent","")}><Plus size={19} strokeWidth={1.6}/></button></div>
        {change?.action === "add" && change.level === "parent" && <div className="category-new-row">{inlineEditor()}</div>}
        <SortList scope="parents" items={groups.map(g => g.name)} disabled={busy || !!change} onMove={(from,to) => {
          setCategories(move(groups.map(g => g.name),from,to).flatMap(name => groups.find(g => g.name === name)!.items)); setDirty(true);
        }} render={parent => change?.level === "parent" && change.path === parent && change.action !== "add" ? inlineEditor() : <>
          <button type="button" className={`parent-choice ${group?.name === parent ? "selected" : ""}`} onClick={() => {setSelected(parent);if(!busy){setChange(null);setError("");}}}>
            <Folder size={17} strokeWidth={1.5}/><strong>{parent}</strong><small>{groups.find(g => g.name === parent)!.items.length}</small></button>{rowTools("parent",parent)}<button type="button" className="category-tool" aria-label={`查看二级分类：${parent}`} onClick={() => {setSelected(parent);if(!busy){setChange(null);setError("");}}}><ChevronRight size={14}/></button></>} />
      </section>
      <section className="child-column"><div className="settings-column-heading"><span>{group?.name} <ChevronRight size={14}/> 二级分类</span><button className="category-tool add" title="新增二级分类" aria-label="新增二级分类" disabled={busy || dirty || !group} onClick={()=>start("add","child",group.name)}><Plus size={19} strokeWidth={1.6}/></button></div>
        {change?.action === "add" && change.level === "child" && <div className="category-new-row">{inlineEditor()}</div>}
        {group && <SortList key={group.name} scope="children" items={group.items} disabled={busy || !!change} onMove={(from,to) => {
          setCategories(groups.flatMap(g => g.name === group.name ? move(g.items,from,to) : g.items)); setDirty(true);
        }} render={id => change?.level === "child" && change.path === id && change.action !== "add" ? inlineEditor() : <div className="child-label"><span className="tree-branch">└</span><strong>{categoryLeaf(id)}</strong><small>属于 {group.name}</small>{id.includes("/") && rowTools("child",id)}</div>} />}
      </section>
    </div> : <div className="account-settings-list"><div className="settings-column-heading">账户 <small>{accounts.length} 个</small></div>
      <SortList scope="accounts" items={accounts} disabled={busy || !!change} onMove={(from,to) => {setAccounts(move(accounts,from,to));setDirty(true);}}
        render={id => { const account = state.accounts.find(a => a.id === id)!; return <><div className="account-setting-name"><strong>{account.name}</strong><small>{accountLabels[account.kind]}</small></div><button aria-label="编辑" title="编辑" type="button" className="text-button" disabled={busy} onClick={() => onEditAccount(account)}><PencilLine size={18} aria-hidden="true" /></button></>; }} />
    </div>}
    {section === "categories" && !!state.category_catalog?.hidden.length && <details className="category-removed"><summary>已删除分类（{state.category_catalog.hidden.length}）</summary>
      {categoryGroups(state.category_catalog.hidden).map(removed => removed.items.length === 1
        ? removedRow(removed.items[0], removed.items[0].includes("/") ? `${removed.name} · ${categoryLeaf(removed.items[0])}` : removed.name)
        : <div key={removed.name} className="category-removed-group">
          {removedRow(removed.name, removed.name, "整组恢复")}
          {removed.items.filter(path => path.includes("/")).map(path => removedRow(path, categoryLeaf(path)))}
        </div>)}
    </details>}
    {error && !change && <p role="alert" className="error">{error}</p>}
    <div className="settings-save"><span>{dirty ? "有未保存的排序调整，请先保存或撤销再编辑分类" : "顺序已保存，记账与编辑下拉列表共用。"}</span>
      <button aria-label="撤销调整" title="撤销调整" disabled={!dirty || busy} onClick={() => {setAccounts(state.accounts.map(a=>a.id));setCategories(initialCategories());setDirty(false);setError("");}}><Undo2 size={18} aria-hidden="true" /></button>
      <button aria-label={busy ? "保存中…" : "保存排序"} title={busy ? "保存中…" : "保存排序"} className="primary" disabled={!dirty || busy} onClick={async () => {setBusy(true);setError("");try {await onSave({accounts,categories,version:state.ordering?.version ?? 0});setDirty(false);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><Check size={18} aria-hidden="true" /></button>
    </div>
    </>}
  </section>;
}
