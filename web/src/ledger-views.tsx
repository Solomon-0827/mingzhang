import { CheckSquare, ChevronLeft, ChevronRight, ListChecks, ListFilter, PencilLine, Plus, Search, Trash2, Wallet, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Account,
  Entry,
  State,
  accountLabels,
  labels,
  money,
  today,
  cents,
} from "./types";
import { EntryField } from "./entry-field";
import { StyledSelect, StyledDate, CategoryMultiSelect } from "./controls";

function totals(entries: Entry[]) {
  return entries.reduce(
    (total, entry) => {
      if (entry.kind === "income") total.income += entry.amount_cents;
      if (entry.kind === "expense") total.expense += entry.amount_cents;
      if (entry.kind === "refund") total.expense -= entry.amount_cents;
      return total;
    },
    { income: 0, expense: 0 },
  );
}
function Sum({ entries }: { entries: Entry[] }) {
  const total = totals(entries);
  return (
    <div className="book-sums">
      <span>
        支出 <b className="book-out">{money(total.expense)}</b>
      </span>
      <span>
        收入 <b className="book-in">{money(total.income)}</b>
      </span>
      <span>
        结余 <b>{money(total.income - total.expense)}</b>
      </span>
    </div>
  );
}
export function BookList({
  state,
  month,
  onMonth,
  onEdit,
  onDelete,
  onSave,
  onBulkSave,
}: {
  state: State;
  month: string;
  onMonth: (month: string) => void;
  onEdit: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
  onSave: (entry: Entry) => Promise<void>;
  onBulkSave: (entries: Entry[]) => Promise<void>;
}) {
  const [categories, setCategories] = useState<string[]>([]),
    [account, setAccount] = useState(""),
    [query, setQuery] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [bulkMode, setBulkMode] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [bulkOpen, setBulkOpen] = useState(false),
    [page, setPage] = useState(0);
  const searchButton = useRef<HTMLButtonElement>(null);
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setPage(0);
    searchButton.current?.focus();
  };
  const active = state.entries.filter((entry) => !entry.deleted);
  const year = Number(month.slice(0, 4));
  const filtered = active.filter(
    (entry) =>
      entry.date.startsWith(month) &&
      (categories.length === 0 || categories.includes(entry.category)) &&
      (!account ||
        entry.account_id === account ||
        entry.to_account_id === account) &&
      (!query ||
        [entry.category, labels[entry.kind], entry.counterparty]
          .join(" ")
          .includes(query)),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const currentPage = Math.min(page, pages - 1);
  const shown = filtered.slice(currentPage * 50, (currentPage + 1) * 50);
  const groups = Array.from(new Set(shown.map((entry) => entry.date)));
  useEffect(() => {
    setSelected(current => current.filter(id => filtered.some(entry => entry.id === id)));
  }, [month, categories, account, query, state.entries]);
  const chooseMonth = (next: string) => {
    onMonth(next);
    setPage(0);
  };
  const accountName = (id: string | null) =>
    state.accounts.find((account) => account.id === id)?.name || "—";
  return (
    <section className="book-list panel">
      <div className="book-list-heading">
        <h2>
          账目清单 <small>{month.replace("-", " 年 ")} 月</small>
        </h2>
        <Sum entries={filtered} />
      </div>
      <div className="book-filters">
        <button aria-label="清除筛选" title="清除筛选"
          className="text-button"
          onClick={() => {
            setCategories([]);
            setAccount("");
            setQuery("");
            setPage(0);
          }}
        ><ListFilter size={18} aria-hidden="true" /></button>
        <CategoryMultiSelect
          options={Array.from(new Set(active.map(entry => entry.category))).filter(Boolean)}
          value={categories}
          onChange={next => { setCategories(next); setPage(0); }}
        />
        <StyledSelect
          size="small"
          aria-label="清单账户"
          value={account}
          onChange={(e) => {
            setAccount(e.target.value);
            setPage(0);
          }}
        >
          <option value="">全部账户</option>
          {state.accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </StyledSelect>
        <StyledDate
          size="small"
          aria-label="清单月份"
          type="month"
          value={month}
          onChange={(e) => chooseMonth(e.target.value)}
        />
        <div className="book-search">
          <button title="搜索账目"
            ref={searchButton}
            className="book-search-toggle"
            aria-label="搜索账目"
            aria-expanded={searchOpen}
            aria-controls="book-search-field"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          ><Search size={18} aria-hidden="true" /></button>
          {searchOpen && (
            <div className="book-search-input">
              <input
                id="book-search-field"
                aria-label="搜索账目关键词"
                autoFocus
                placeholder="分类、类型或往来对象"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeSearch();
                }}
              />
              <button aria-label="收起搜索" onClick={closeSearch}>
                <X size={15} />
              </button>
            </div>
          )}
          <button
            title={bulkMode ? "退出批量修改" : "批量修改"}
            className="book-search-toggle"
            aria-label={bulkMode ? "退出批量修改" : "批量修改账目"}
            aria-pressed={bulkMode}
            onClick={() => {
              setBulkMode(value => !value);
              setSelected([]);
              setBulkOpen(false);
            }}
          ><ListChecks size={18} aria-hidden="true" /></button>
        </div>
      </div>
      {bulkMode && (
        <div className="book-bulk-bar">
          <button className="text-button" onClick={() => setSelected(selected.length === filtered.length ? [] : filtered.map(entry => entry.id))}>
            <CheckSquare size={17} aria-hidden="true" />{selected.length === filtered.length && filtered.length ? "取消全选" : "全选当前筛选"}
          </button>
          <span>已选 {selected.length} 笔</span>
          <button className="primary" disabled={!selected.length} onClick={() => setBulkOpen(true)}>
            <PencilLine size={16} aria-hidden="true" />修改所选
          </button>
        </div>
      )}
      <div className="book-body">
        <div className="month-rail" aria-label="月份导航">
          <div className="year-switch">
            <button
              aria-label="清单上一年"
              onClick={() => chooseMonth(`${year - 1}${month.slice(4)}`)}
            >
              <ChevronLeft size={16} />
            </button>
            <b>{year} 年</b>
            <button
              aria-label="清单下一年"
              onClick={() => chooseMonth(`${year + 1}${month.slice(4)}`)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          {Array.from({ length: 12 }, (_, i) => 12 - i).map((number) => {
            const key = `${year}-${String(number).padStart(2, "0")}`;
            const total = totals(
              active.filter((entry) => entry.date.startsWith(key)),
            );
            return (
              <button
                key={key}
                aria-label={`${year}年${number}月账目`}
                aria-pressed={month === key}
                className={month === key ? "active" : ""}
                onClick={() => chooseMonth(key)}
              >
                <span>
                  <b>{number}</b> 月
                  {key === today().slice(0, 7) && <small>本月</small>}
                </span>
                <span>
                  <small className="book-in">收 +{money(total.income)}</small>
                  <small className="book-out">支 {money(total.expense)}</small>
                </span>
              </button>
            );
          })}
        </div>
        <div className="book-entries table-wrap">
          <table className={bulkMode ? "bulk-mode" : ""}>
            <thead>
              <tr>
                {bulkMode && <th className="book-select-column"><span className="sr-only">选择</span></th>}
                <th>分类</th>
                <th>类型</th>
                <th className="numeric">金额</th>
                <th>账户 / 对方账户</th>
                <th>日期</th>
                <th>操作</th>
              </tr>
            </thead>
            {groups.map((date) => (
              <tbody key={date}>
                <tr className="book-day">
                  <td colSpan={bulkMode ? 7 : 6}>
                    <div>
                      <strong>
                        {date.slice(8)}{" "}
                        <small>
                          / {date.slice(5, 7)} / {date.slice(0, 4)}
                        </small>
                      </strong>
                      <Sum
                        entries={filtered.filter(
                          (entry) => entry.date === date,
                        )}
                      />
                    </div>
                  </td>
                </tr>
                {shown
                  .filter((entry) => entry.date === date)
                  .map((entry) => (
                    <tr
                      key={entry.id}
                      className={`editable-entry-row ${selected.includes(entry.id) ? "selected" : ""}`}
                      tabIndex={0}
                      aria-label={`编辑 ${entry.date} ${entry.category || labels[entry.kind]} ${money(entry.amount_cents)}`}
                      onClick={() => bulkMode
                        ? setSelected(current => current.includes(entry.id) ? current.filter(id => id !== entry.id) : [...current, entry.id])
                        : onEdit(entry)}
                      onKeyDown={(event) => {
                        if (
                          event.target === event.currentTarget &&
                          event.key === "Enter"
                        )
                          bulkMode
                            ? setSelected(current => current.includes(entry.id) ? current.filter(id => id !== entry.id) : [...current, entry.id])
                            : onEdit(entry);
                      }}
                    >
                      {bulkMode && <td className="book-select-column" onClick={event => event.stopPropagation()}>
                        <input type="checkbox" aria-label={`选择 ${entry.date} ${entry.category || labels[entry.kind]}`}
                          checked={selected.includes(entry.id)}
                          onChange={() => setSelected(current => current.includes(entry.id) ? current.filter(id => id !== entry.id) : [...current, entry.id])} />
                      </td>}
                      <td>
                        <EntryField
                          entry={entry}
                          state={state}
                          field={
                            entry.category
                              ? "category"
                              : ["lend", "borrow"].includes(entry.kind)
                                ? "counterparty"
                                : "kind"
                          }
                          onSave={onSave}
                          onEdit={onEdit}
                        >
                          {entry.category.split("/").pop() ||
                            entry.counterparty ||
                            labels[entry.kind]}
                        </EntryField>
                      </td>
                      <td>
                        <EntryField
                          entry={entry}
                          state={state}
                          field="kind"
                          onSave={onSave}
                          onEdit={onEdit}
                        >
                          <span
                            className={`book-kind ${entry.kind === "expense" ? "book-out" : ["income", "refund"].includes(entry.kind) ? "book-in" : "book-neutral"}`}
                          >
                            {labels[entry.kind]}
                          </span>
                        </EntryField>
                      </td>
                      <td
                        className={`numeric book-amount ${entry.kind === "expense" ? "book-out" : ["income", "refund"].includes(entry.kind) ? "book-in" : "book-neutral"}`}
                      >
                        <EntryField
                          entry={entry}
                          state={state}
                          field="amount_cents"
                          onSave={onSave}
                          onEdit={onEdit}
                        >
                          {" "}
                          {entry.kind === "expense"
                            ? "−"
                            : ["income", "refund"].includes(entry.kind)
                              ? "+"
                              : ""}
                          {money(entry.amount_cents)}
                        </EntryField>
                      </td>
                      <td>
                        <EntryField
                          entry={entry}
                          state={state}
                          field="account_id"
                          onSave={onSave}
                          onEdit={onEdit}
                        >
                          {accountName(entry.account_id)}
                        </EntryField>
                        {entry.to_account_id && (
                          <small>
                            {entry.kind === "collect" ? "←" : "→"}{" "}
                            <EntryField
                              entry={entry}
                              state={state}
                              field="to_account_id"
                              onSave={onSave}
                              onEdit={onEdit}
                            >
                              {accountName(entry.to_account_id)}
                            </EntryField>
                          </small>
                        )}
                      </td>
                      <td>
                        <EntryField
                          entry={entry}
                          state={state}
                          field="date"
                          onSave={onSave}
                          onEdit={onEdit}
                        >
                          {entry.date}
                        </EntryField>
                      </td>
                      {!bulkMode && <td>
                        <div
                          className="row-actions"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <button aria-label="删除账目" title="删除账目" onClick={() => onDelete(entry)}><Trash2 size={18} aria-hidden="true" /></button>
                        </div>
                      </td>}
                      {bulkMode && <td />}
                    </tr>
                  ))}
              </tbody>
            ))}
          </table>
          {!filtered.length && (
            <div className="empty">本月没有符合条件的记录</div>
          )}
          <div className="book-pagination">
            <span>
              共 {filtered.length} 笔 · {currentPage + 1} / {pages} 页
            </span>
            <button aria-label="上一页" title="上一页"
              disabled={!currentPage}
              onClick={() => setPage(currentPage - 1)}
            ><ChevronLeft size={18} aria-hidden="true" /></button>
            <button aria-label="下一页" title="下一页"
              disabled={currentPage >= pages - 1}
              onClick={() => setPage(currentPage + 1)}
            ><ChevronRight size={18} aria-hidden="true" /></button>
          </div>

        </div>
      </div>
      {bulkOpen && (
        <BulkEntryDialog
          entries={state.entries.filter(entry => selected.includes(entry.id))}
          state={state}
          onClose={() => setBulkOpen(false)}
          onSave={async entries => {
            await onBulkSave(entries);
            setBulkOpen(false);
            setBulkMode(false);
            setSelected([]);
          }}
        />
      )}
    </section>
  );
}

function BulkEntryDialog({entries,state,onClose,onSave}:{entries:Entry[];state:State;onClose:()=>void;onSave:(entries:Entry[])=>Promise<void>}) {
  const [fields,setFields]=useState({category:false,amount:false,account:false,date:false});
  const [category,setCategory]=useState("");
  const [amount,setAmount]=useState("");
  const [account,setAccount]=useState("");
  const [date,setDate]=useState(today());
  const [busy,setBusy]=useState(false), [error,setError]=useState("");
  const categoryOptions=Array.from(new Set([
    ...Object.keys(state.category_catalog?.items || {}),
    ...state.entries.map(entry=>entry.category),
  ])).filter(Boolean);
  const enabled=fields.category || fields.amount || fields.account || fields.date;
  const submit=async()=>{
    if(!enabled)return;
    if(fields.category && !category){setError("请选择分类");return;}
    if(fields.account && !account){setError("请选择账户");return;}
    const invalid=fields.account && entries.some(entry=>entry.to_account_id===account && ["transfer","repay","collect"].includes(entry.kind));
    if(invalid){setError("所选账户与部分账目的对方账户相同，请换一个账户");return;}
    let amountCents:number|undefined;
    try { if(fields.amount) amountCents=cents(amount); } catch(reason){setError((reason as Error).message);return;}
    if(fields.amount && (!amountCents || amountCents <= 0)){setError("金额必须大于 0");return;}
    setBusy(true);setError("");
    try { await onSave(entries.map(entry=>({...entry,
      ...(fields.category?{category}:{}),
      ...(fields.amount?{amount_cents:amountCents}:{}),
      ...(fields.account?{account_id:account}:{}),
      ...(fields.date?{date}:{}),
    }))); } catch(reason){setError((reason as Error).message);} finally{setBusy(false);}
  };
  return <div className="modal-backdrop" onClick={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}>
    <section className="modal bulk-entry-dialog" role="dialog" aria-modal="true" aria-label="批量修改账目" onKeyDown={event=>{if(event.key==="Escape"&&!busy)onClose();}}>
      <div className="modal-head"><div><h2>批量修改账目</h2><small>已选择 {entries.length} 笔，只修改勾选的字段</small></div>
        <button className="icon-button" aria-label="关闭批量修改" onClick={onClose} disabled={busy}><X size={20}/></button></div>
      <form onSubmit={event=>{event.preventDefault();void submit();}}>
        <label className="bulk-field"><input type="checkbox" checked={fields.category} onChange={event=>setFields({...fields,category:event.target.checked})}/><span>分类</span>
          <StyledSelect aria-label="批量修改分类" value={category} disabled={!fields.category||busy} onChange={event=>setCategory(event.target.value)}>
            <option value="">请选择分类</option>{categoryOptions.map(value=><option key={value} value={value}>{value}</option>)}
          </StyledSelect></label>
        <label className="bulk-field"><input type="checkbox" checked={fields.amount} onChange={event=>setFields({...fields,amount:event.target.checked})}/><span>金额</span>
          <input aria-label="批量修改金额" inputMode="decimal" placeholder="元" value={amount} disabled={!fields.amount||busy} onChange={event=>setAmount(event.target.value)}/></label>
        <label className="bulk-field"><input type="checkbox" checked={fields.account} onChange={event=>setFields({...fields,account:event.target.checked})}/><span>账户</span>
          <StyledSelect aria-label="批量修改账户" value={account} disabled={!fields.account||busy} onChange={event=>setAccount(event.target.value)}>
            <option value="">请选择账户</option>{state.accounts.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}
          </StyledSelect></label>
        <label className="bulk-field"><input type="checkbox" checked={fields.date} onChange={event=>setFields({...fields,date:event.target.checked})}/><span>日期</span>
          <StyledDate aria-label="批量修改日期" type="date" value={date} max={today()} disabled={!fields.date||busy} onChange={event=>setDate(event.target.value)}/></label>
        {error&&<p className="error" role="alert">{error}</p>}
        <div className="modal-footer"><small>保存后会先写入本机，再在后台同步</small><button className="primary" disabled={!enabled||busy}>{busy?"正在保存…":"应用修改"}</button></div>
      </form>
    </section>
  </div>;
}

export function AccountWorkspace({
  state,
  onEdit,
}: {
  state: State;
  onEdit: (account: Account) => void;
}) {
  const [kind, setKind] = useState("bank");
  const accounts = state.accounts.filter((account) => account.kind === kind);
  const ids = new Set(accounts.map((account) => account.id));
  let inflow = 0,
    outflow = 0;
  for (const entry of state.entries.filter((entry) => !entry.deleted)) {
    if (ids.has(entry.account_id)) {
      if (["income", "refund", "borrow", "collect", "balance_in"].includes(entry.kind))
        inflow += entry.amount_cents;
      else outflow += entry.amount_cents;
    }
    if (ids.has(entry.to_account_id || "")) {
      if (["transfer", "repay"].includes(entry.kind)) inflow += entry.amount_cents;
      if (entry.kind === "collect") outflow += entry.amount_cents;
    }
  }
  return (
    <section className="account-workspace panel">
      <div className="account-rail">
        <div className="asset-overview">
          <span>总资产</span>
          <b className="book-in">{money(state.assets)}</b>
          <span>总负债</span>
          <b className="book-out">{money(state.liabilities)}</b>
          <span>净资产</span>
          <strong>{money(state.net_assets)}</strong>
        </div>
        {Object.entries(accountLabels).map(([id, label]) => (
          <button
            key={id}
            className={kind === id ? "active" : ""}
            onClick={() => setKind(id)}
          >
            <Wallet size={22} />
            <span>
              <b>
                {money(
                  state.accounts
                    .filter((account) => account.kind === id)
                    .reduce((sum, account) => sum + account.balance_cents, 0),
                )}
              </b>
              <small>{label}账户</small>
            </span>
          </button>
        ))}
      </div>
      <div className="account-detail">
        <div className="account-detail-heading">
          <h2>{accountLabels[kind]}账户</h2>
          <button aria-label="添加账户" title="添加账户"
            className="primary"
            onClick={() =>
              onEdit({
                id: "",
                name: "",
                kind,
                opening_cents: 0,
                balance_cents: 0,
                version: 1,
              })
            }
          ><Plus size={18} aria-hidden="true" /></button>
        </div>
        <div className="account-flow">
          <div>
            <small>余额</small>
            <strong>
              {money(
                accounts.reduce(
                  (sum, account) => sum + account.balance_cents,
                  0,
                ),
              )}
            </strong>
          </div>
          <div>
            <small>累计流入</small>
            <strong className="book-in">{money(inflow)}</strong>
          </div>
          <div>
            <small>累计流出</small>
            <strong className="book-out">{money(outflow)}</strong>
          </div>
        </div>
        <div className="table-wrap account-table">
          <table>
            <thead>
              <tr>
                <th>账户名称</th>
                <th className="numeric">当前余额</th>
                <th className="numeric">期初余额</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>
                    <Wallet size={18} />
                    {account.name}
                  </td>
                  <td className="numeric"><button className="text-button" title="修改当前余额"
                    aria-label={`修改${account.name}当前余额`} onClick={() => onEdit(account)}>
                    {money(account.balance_cents)}</button></td>
                  <td className="numeric">{money(account.opening_cents)}</td>
                  <td>
                    <button aria-label="编辑账户" title="编辑账户"
                      className="text-button"
                      onClick={() => onEdit(account)}
                    ><PencilLine size={18} aria-hidden="true" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!accounts.length && (
            <div className="empty">
              还没有{accountLabels[kind]}账户，点击右上方添加。
            </div>
          )}
        </div>
        <p className="book-note">
          单位：人民币元 · 累计流入、流出包含转账及借还款，不含期初余额。
        </p>
      </div>
    </section>
  );
}
