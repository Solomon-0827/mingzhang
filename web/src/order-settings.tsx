import { Check, ChevronRight, Folder, GripVertical, Star, PencilLine, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { motion } from "motion/react";
import { PasswordSettings } from "./password-settings";
import { useState, useRef, useEffect, type ReactNode } from "react";
import { Account, CategoryChange, DisplayOrder, State, ordered, orderedAccountOptions, accountLabels, money } from "./types";
import { StyledSelect } from "./controls";
import { categoryGroups, categoryLeaf } from "./category-groups";

function SortList({ items, scope, disabled, onMove, render }: {
  items: string[]; scope: string; disabled: boolean;
  onMove: (from: number, to: number) => void; render: (id: string) => ReactNode;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const pointer = useRef<{ from: number; to: number; y: number } | null>(null);
  return <ul className="sort-list" aria-label={scope === "favorites" ? "常用分类排序" : scope === "account-groups" ? "账户类型排序" : scope === "accounts" ? "账户排序" : scope === "parents" ? "一级分类排序" : "二级分类排序"}>
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
function FavoriteButtons({ items, disabled, onMove }: {
  items: string[]; disabled: boolean; onMove: (from: number, to: number) => void;
}) {
  const pointer = useRef<{from:number; to:number; x:number; y:number} | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const clear = () => {pointer.current=null;setDragging(null);setOver(null);};
  return <div className="favorite-button-order" role="group" aria-label="收藏按钮排序">
    {items.map((path,index) => <button key={path} type="button" disabled={disabled}
      className={`${dragging === index ? "is-dragging" : ""} ${over === index && dragging !== index ? "drop-target" : ""}`}
      aria-label={`调整收藏位置：${path}`} title={`${path} · 拖动排序`}
      onPointerDown={e => {if(e.button !== 0 || disabled)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);pointer.current={from:index,to:index,x:e.clientX,y:e.clientY};setDragging(index);}}
      onPointerMove={e => {const p=pointer.current;if(!p)return;
        const buttons=Array.from(e.currentTarget.parentElement!.children);
        const to=buttons.findIndex(button=>{const box=button.getBoundingClientRect();return e.clientX>=box.left && e.clientX<=box.right && e.clientY>=box.top && e.clientY<=box.bottom;});
        p.to=to>=0?to:p.from;setOver(to>=0?to:null);
      }}
      onPointerUp={e => {const p=pointer.current;if(p && Math.hypot(e.clientX-p.x,e.clientY-p.y)>4 && p.from!==p.to && !disabled)onMove(p.from,p.to);clear();}}
      onPointerCancel={clear} onLostPointerCapture={clear}
      onKeyDown={e=>{if(e.key==="Escape"){clear();return;}if(e.altKey && ["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)){e.preventDefault();const to=index+(["ArrowLeft","ArrowUp"].includes(e.key)?-1:1);if(to>=0 && to<items.length)onMove(index,to);}}}>
      <span className="favorite-position">{index+1}</span><Star size={14}/>{path.includes("/")?categoryLeaf(path):path}
    </button>)}
  </div>;
}
const move = (items: string[], from: number, to: number) => {
  const result = [...items]; const [item] = result.splice(from, 1); result.splice(to, 0, item); return result;
};
export function OrderSettings({ state, defaults, initialSection = "categories", onSave, onEditAccount, onCategoryChange, onPasswordChanged, onDeleteAccount, onAccountGroupChange, onRenameAccountGroup }: {
  initialSection?: "categories" | "accounts";
  onPasswordChanged: () => void;
  onRenameAccountGroup: (id: string, name: string, expectedName: string) => Promise<void>;
  onDeleteAccount: (account: Account) => Promise<void>;
  onAccountGroupChange: (id: string | null, value?: {name:string;kind:string}) => Promise<void>;
  onCategoryChange: (value: CategoryChange) => Promise<void>;
  state: State; defaults: string[]; onSave: (value: DisplayOrder) => Promise<void>; onEditAccount: (value: Account) => void;
}) {
  const initialCategories = () => ordered(state.category_catalog ? Object.keys(state.category_catalog.items) : Array.from(new Set([...defaults, ...state.entries.filter(e => !e.deleted && ["income", "expense"].includes(e.kind)).map(e => e.category)])).filter(Boolean), state.ordering?.categories);
  const initialAccountOptions = () => orderedAccountOptions(state);
  const [accountGroups,setAccountGroups]=useState(initialAccountOptions().accountGroups.map(g=>g.id));
  const [accounts, setAccounts] = useState(initialAccountOptions().accounts.map(a => a.id));
  const [categories, setCategories] = useState(initialCategories);
  const [section, setSection] = useState<string>(initialSection);
  const [favorites, setFavorites] = useState(state.ordering?.favorites ?? []);
  const groups = categoryGroups(categories);
  const [selected, setSelected] = useState(groups[0]?.name ?? "");
  const group = groups.find(g => g.name === selected) ?? groups[0];
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saving = useRef(false);
  useEffect(() => {const accountOptions=initialAccountOptions();setCategories(initialCategories());setFavorites(state.ordering?.favorites ?? []);setAccounts(accountOptions.accounts.map(a=>a.id));setAccountGroups(accountOptions.accountGroups.map(g=>g.id));}, [state.category_catalog?.version, state.ordering?.version, state.accounts, state.account_groups]);
  const saveOrder = async (next: Partial<DisplayOrder>) => {
    if (saving.current) return;
    saving.current=true;setBusy(true);setError("");
    const previous={accounts,categories,favorites,account_groups:accountGroups};
    const value={...previous,...next,version:state.ordering?.version ?? 0};
    setAccounts(value.accounts);setCategories(value.categories);setFavorites(value.favorites);setAccountGroups(value.account_groups);
    try {await onSave({...value,favorites:next.favorites});} catch(e) {setAccounts(previous.accounts);setCategories(previous.categories);setFavorites(previous.favorites);setAccountGroups(previous.account_groups);setError((e as Error).message);} finally {saving.current=false;setBusy(false);}
  };
  const [selectedAccountGroup,setSelectedAccountGroup]=useState("");
  const accountGroup=state.account_groups.find(g=>g.id===selectedAccountGroup) ?? state.account_groups[0];
  const groupAccounts=accounts.filter(id=>{const a=state.accounts.find(a=>a.id===id);return a && (a.group_id || a.kind)===accountGroup?.id;});
  const [addingGroup,setAddingGroup]=useState(false), [groupName,setGroupName]=useState(""), [groupKind,setGroupKind]=useState("bank");
  const accountAction=async(action:()=>Promise<void>)=>{if(saving.current)return;saving.current=true;setBusy(true);setError("");try{await action();}catch(e){setError((e as Error).message);}finally{saving.current=false;setBusy(false);}};
  const [editingGroup,setEditingGroup]=useState<{id:string;name:string} | null>(null);
  const [editGroupName,setEditGroupName]=useState("");
  const cancelGroupEdit=useRef(false);
  const saveGroupName=()=>{
    if (!editingGroup || cancelGroupEdit.current || saving.current) return;
    const name=editGroupName.trim();
    if(name===editingGroup.name){setEditingGroup(null);return;}
    void accountAction(async()=>{await onRenameAccountGroup(editingGroup.id,name,editingGroup.name);setEditingGroup(null);});
  };
  const addAccount=()=>{if(accountGroup)onEditAccount({id:"",name:"",kind:accountGroup.kind,group_id:accountGroup.id,opening_cents:0,balance_cents:0,version:1});};
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
    <button className="category-tool" title="编辑" aria-label={`编辑分类：${path}`} disabled={busy} onClick={()=>start("rename",level,path)}><PencilLine size={16} strokeWidth={1.5}/></button>
    <button className="category-tool delete" title="删除" aria-label={`删除分类：${path}`} disabled={busy} onClick={()=>start("delete",level,path)}><Trash2 size={16} strokeWidth={1.5}/></button>
  </div>;
  // A path without "/" restores the whole first-level group: the group itself and all of its deleted children.
  const removedRow = (path: string, label: string, action = "恢复") => <div key={path} className={path.includes("/") ? "removed-child" : undefined}>
    <span>{label}</span>
    {change?.action === "restore" && change.path === path ? inlineEditor() : <button aria-label={action} title={action} disabled={busy} onClick={()=>start("restore",path.includes("/") ? "child" : "parent",path)}><RotateCcw size={18} aria-hidden="true" /></button>}
  </div>;
  return <section className="panel settings-panel">
    <div className="settings-tabs" role="tablist" aria-label="设置">
      <button role="tab" aria-selected={section === "categories"} onClick={() => setSection("categories")}><span>分类管理</span>{section === "categories" && <motion.i className="settings-tab-indicator" layoutId="settings-tab-active" transition={{ type: "spring", stiffness: 450, damping: 34 }} />}</button>
      <button role="tab" aria-selected={section === "accounts"} onClick={() => setSection("accounts")}><span>账户管理</span>{section === "accounts" && <motion.i className="settings-tab-indicator" layoutId="settings-tab-active" transition={{ type: "spring", stiffness: 450, damping: 34 }} />}</button>
      <button role="tab" aria-selected={section === "password"} onClick={() => setSection("password")}><span>修改密码</span>{section === "password" && <motion.i className="settings-tab-indicator" layoutId="settings-tab-active" transition={{ type: "spring", stiffness: 450, damping: 34 }} />}</button>
    </div>
    {section === "password" ? <PasswordSettings onChanged={onPasswordChanged} /> : <>
    <div className="settings-intro"><h2>{section === "categories" ? "分类管理" : "账户管理"}</h2>
      <p>{section === "categories" ? "点击分类旁的星标收藏，最多 9 个。拖动下方快捷按钮调整它们在记一笔中的顺序。" : "按类型管理账户；拖动排序后自动保存，账户余额显示在名称旁。"}</p></div>
    {section === "categories" ? <>
      <div className="favorite-board">
        <div className="favorite-board-heading"><strong><Star size={16}/> 记一笔 · 收藏分类</strong><span>{favorites.length} / 9</span></div>
        <FavoriteButtons items={favorites} disabled={busy || !!change} onMove={(from,to) => {void saveOrder({favorites:move(favorites,from,to)});}} />
        <p>{favorites.length ? "直接拖动按钮排列顺序；也可聚焦按钮后按 Alt + 方向键。" : "点亮下方分类旁的 ☆，收藏的分类就会显示在这里。"}</p>
      </div>
      <div className="category-manager">
      <section className="parent-column"><div className="settings-column-heading"><span>一级分类 <small>{groups.length}</small></span><button className="category-tool add" title="新增一级分类" aria-label="新增一级分类" disabled={busy} onClick={()=>start("add","parent","")}><Plus size={19} strokeWidth={1.6}/></button></div>
        {change?.action === "add" && change.level === "parent" && <div className="category-new-row">{inlineEditor()}</div>}
        <SortList scope="parents" items={groups.map(g => g.name)} disabled={busy || !!change} onMove={(from,to) => {
          void saveOrder({categories:move(groups.map(g => g.name),from,to).flatMap(name => groups.find(g => g.name === name)!.items)});
        }} render={parent => change?.level === "parent" && change.path === parent && change.action !== "add" ? inlineEditor() : <>
          <button type="button" className={`parent-choice ${group?.name === parent ? "selected" : ""}`} onClick={() => {setSelected(parent);if(!busy){setChange(null);setError("");}}}>
            <Folder size={17} strokeWidth={1.5}/><strong>{parent}</strong><small>{groups.find(g => g.name === parent)!.items.length}</small></button>{rowTools("parent",parent)}<button type="button" className="category-tool" aria-label={`查看二级分类：${parent}`} onClick={() => {setSelected(parent);if(!busy){setChange(null);setError("");}}}><ChevronRight size={14}/></button></>} />
      </section>
      <section className="child-column"><div className="settings-column-heading"><span>二级分类</span><button className="category-tool add" title="新增二级分类" aria-label="新增二级分类" disabled={busy || !group} onClick={()=>start("add","child",group.name)}><Plus size={19} strokeWidth={1.6}/></button></div>
        {change?.action === "add" && change.level === "child" && <div className="category-new-row">{inlineEditor()}</div>}
        {group && <SortList key={group.name} scope="children" items={group.items} disabled={busy || !!change} onMove={(from,to) => {
          void saveOrder({categories:groups.flatMap(g => g.name === group.name ? move(g.items,from,to) : g.items)});
        }} render={id => change?.level === "child" && change.path === id && change.action !== "add" ? inlineEditor() : <div className="child-label"><span className="tree-branch">└</span><strong>{categoryLeaf(id)}</strong><button type="button" className={`category-tool favorite-star ${favorites.includes(id) ? "is-favorite" : ""}`}
          aria-label={`${favorites.includes(id) ? "取消收藏" : "收藏分类"}：${id}`} aria-pressed={favorites.includes(id)}
          title={favorites.includes(id) ? "取消收藏" : favorites.length >= 9 ? "最多收藏 9 个分类，请先取消一个" : "收藏，在记一笔中直接显示"}
          disabled={busy || !!change || (!favorites.includes(id) && favorites.length >= 9)}
          onClick={() => {void saveOrder({favorites:favorites.includes(id) ? favorites.filter(p => p !== id) : favorites.length < 9 ? [...favorites,id] : favorites});}}>
          <Star size={18} strokeWidth={1.6} fill={favorites.includes(id) ? "currentColor" : "none"}/></button>{id.includes("/") && rowTools("child",id)}</div>} />}
      </section>
    </div></> : <div className="category-manager account-manager">
      <section className="parent-column">
        <div className="settings-column-heading"><span>账户类型 <small>{state.account_groups.length}</small></span><button className="category-tool add" aria-label="新增账户类型" title="新增账户类型" disabled={busy} onClick={()=>setAddingGroup(true)}><Plus size={19}/></button></div>
        {addingGroup && <form className="category-inline-editor" onSubmit={e=>{e.preventDefault();void accountAction(async()=>{await onAccountGroupChange(null,{name:groupName.trim(),kind:groupKind});setAddingGroup(false);setGroupName("");});}}>
          <input autoFocus required maxLength={60} aria-label="账户类型名称" placeholder="账户类型名称" value={groupName} onChange={e=>setGroupName(e.target.value)} disabled={busy}/>
          <StyledSelect aria-label="账户性质" value={groupKind} disabled={busy} onChange={e=>setGroupKind(e.target.value)}>{Object.entries(accountLabels).map(([k,v])=><option key={k} value={k}>{v}{["credit","liability"].includes(k)?"（负债）":k==="receivable"?"（应收）":"（资产）"}</option>)}</StyledSelect>
          <button className="category-tool" title="添加（Enter）" aria-label="添加账户类型" disabled={busy}><Check size={17}/></button><button type="button" className="category-tool" title="取消" aria-label="取消添加账户类型" onClick={()=>setAddingGroup(false)}><X size={17}/></button>
        </form>}
        <SortList scope="account-groups" items={accountGroups} disabled={busy || !!editingGroup || addingGroup}
          onMove={(from,to)=>void saveOrder({account_groups:move(accountGroups,from,to)})}
          render={id=>{const g=state.account_groups.find(g=>g.id===id);if(!g)return null;
            return editingGroup?.id===id ? <form className="category-inline-editor" onSubmit={e=>{e.preventDefault();saveGroupName();}}>
              <input autoFocus aria-label="编辑账户类型名称" value={editGroupName} maxLength={60} disabled={busy}
                onChange={e=>setEditGroupName(e.target.value)} onBlur={saveGroupName}
                onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();cancelGroupEdit.current=true;setEditingGroup(null);setError("");}}}/>
            </form> : <>
              <button type="button" className={`parent-choice ${g.id===accountGroup?.id?"selected":""}`} onClick={()=>setSelectedAccountGroup(g.id)}><Folder size={17}/><strong>{g.name}</strong><small>{state.accounts.filter(a=>(a.group_id||a.kind)===g.id).length}</small></button>
              <div className="category-row-tools"><button className="category-tool" title="编辑类型名称" aria-label={`编辑账户类型：${g.name}`} disabled={busy || !!editingGroup} onClick={()=>{cancelGroupEdit.current=false;setEditingGroup({id:g.id,name:g.name});setEditGroupName(g.name);setError("");}}><PencilLine size={16}/></button>
              <button className="category-tool delete" title="删除类型（需为空）" aria-label={`删除账户类型：${g.name}`} disabled={busy || !!editingGroup} onClick={()=>void accountAction(()=>onAccountGroupChange(g.id))}><Trash2 size={16}/></button></div><ChevronRight size={14}/>
            </>;
          }}/>
      </section>
      <section className="child-column"><div className="settings-column-heading"><span>具体账户</span><button className="category-tool add" aria-label="新增账户" title="新增账户" disabled={busy || !accountGroup} onClick={addAccount}><Plus size={19}/></button></div>
        <SortList scope="accounts" items={groupAccounts} disabled={busy} onMove={(from,to)=>{const next=move(groupAccounts,from,to);let index=0;void saveOrder({accounts:accounts.map(id=>groupAccounts.includes(id)?next[index++]:id)});}} render={id=>{const account=state.accounts.find(a=>a.id===id)!;return <>
          <div className="account-setting-name"><strong>{account.name}</strong><small>¥ {money(account.balance_cents)}</small></div>
          <button className="category-tool" title="编辑账户" aria-label={`编辑账户：${account.name}`} disabled={busy} onClick={()=>onEditAccount(account)}><PencilLine size={16}/></button>
          <button className="category-tool delete" title="删除账户" aria-label={`删除账户：${account.name}`} disabled={busy} onClick={()=>void accountAction(()=>onDeleteAccount(account))}><Trash2 size={16}/></button>
        </>}}/>
      </section>
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
    </>}
  </section>;
}
