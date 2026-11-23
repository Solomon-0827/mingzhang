import { CalendarDays, CheckSquare, ChevronLeft, ChevronRight, ListChecks, ListFilter, PencilLine, Plus, Search, Trash2, Wallet, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Account,
  Entry,
  State,
  accountLabels,
  money,
  ordered,
  orderedAccountOptions,
  today,
  cents,
} from "./types";
import { EntryField } from "./entry-field";
import { AccountSelect, CategorySelect, StyledSelect, StyledDate, CategoryMultiSelect } from "./controls";
import { accountFlows, accountReconciliation, balanceTotal, entryMovement, periodTotals } from "./ledger-projection";
import { bulkCategoryOptions, entryAccountOptions, kindLabel, kindRule, validateEntries } from "./entry-kinds";

function Sum({ entries }: { entries: Entry[] }) {
  const total = periodTotals(entries);
  return (
    <div className="book-sums">
      <span>
        支出 <b className="book-out">{money(total.expense)}</b>
      </span>
      <span>
        收入 <b className="book-in">{money(total.income)}</b>
      </span>
      <span>
        结余 <b>{money(total.net)}</b>
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
        [entry.category, kindLabel(entry.kind), entry.counterparty]
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
            const total = periodTotals(
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
                  .map((entry) => {
                    const { tone, sign, targetSign } = entryMovement(entry.kind);
                    return (
                      <tr
                        key={entry.id}
                        className={`editable-entry-row ${selected.includes(entry.id) ? "selected" : ""}`}
                        tabIndex={0}
                        aria-label={`编辑 ${entry.date} ${entry.category || kindLabel(entry.kind)} ${money(entry.amount_cents)}`}
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
                          <input type="checkbox" aria-label={`选择 ${entry.date} ${entry.category || kindLabel(entry.kind)}`}
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
                                : kindRule(entry.kind).counterparty
                                  ? "counterparty"
                                  : "kind"
                            }
                            onSave={onSave}
                            onEdit={onEdit}
                          >
                            {entry.category.split("/").pop() ||
                              entry.counterparty ||
                              kindLabel(entry.kind)}
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
                              className={`book-kind ${tone}`}
                            >
                              {kindLabel(entry.kind)}
                            </span>
                          </EntryField>
                        </td>
                        <td
                          className={`numeric book-amount ${tone}`}
                        >
                          <EntryField
                            entry={entry}
                            state={state}
                            field="amount_cents"
                            onSave={onSave}
                            onEdit={onEdit}
                          >
                            {" "}
                            {sign}
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
                              {targetSign < 0 ? "←" : "→"}{" "}
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
                    );
                  })}
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
  const categories = bulkCategoryOptions(state, entries);
  const { accounts: accountOptions, accountGroups: accountGroupOptions } = entryAccountOptions(state);
  const enabled=fields.category || fields.amount || fields.account || fields.date;
  const submit=async()=>{
    if(!enabled)return;
    setBusy(true);setError("");
    try {
      if (fields.category && !categories.includes(category))
        throw new Error("请选择适用于所选账目的分类");
      const updates = entries.map(entry => ({
        ...entry,
        category: fields.category ? category : entry.category,
        amount_cents: fields.amount ? cents(amount) : entry.amount_cents,
        account_id: fields.account ? account : entry.account_id,
        date: fields.date ? date : entry.date,
      }));
      const reason = validateEntries(updates, state);
      if (reason) throw new Error(reason);
      await onSave(updates);
    } catch(reason){setError((reason as Error).message);} finally{setBusy(false);}
  };
  return <div className="modal-backdrop" onClick={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}>
    <section className="modal bulk-entry-dialog" role="dialog" aria-modal="true" aria-label="批量修改账目" onKeyDown={event=>{if(event.key==="Escape"&&!busy)onClose();}}>
      <div className="modal-head"><div><h2>批量修改账目</h2><small>已选择 {entries.length} 笔，只修改勾选的字段</small></div>
        <button className="icon-button" aria-label="关闭批量修改" onClick={onClose} disabled={busy}><X size={20}/></button></div>
      <form onSubmit={event=>{event.preventDefault();void submit();}}>
        <div className="bulk-field" role="group" aria-label="批量修改分类"><input type="checkbox" aria-label="启用分类修改" checked={fields.category} onChange={event=>setFields({...fields,category:event.target.checked})}/><span>分类</span>
          <CategorySelect aria-label="批量修改分类" options={categories} value={category} disabled={!fields.category||busy} onChange={event=>setCategory(event.target.value)}/></div>
        <div className="bulk-field" role="group" aria-label="批量修改金额"><input type="checkbox" aria-label="启用金额修改" checked={fields.amount} onChange={event=>setFields({...fields,amount:event.target.checked})}/><span>金额</span>
          <input aria-label="批量修改金额" inputMode="decimal" placeholder="元" value={amount} disabled={!fields.amount||busy} onChange={event=>setAmount(event.target.value)}/></div>
        <div className="bulk-field" role="group" aria-label="批量修改账户"><input type="checkbox" aria-label="启用账户修改" checked={fields.account} onChange={event=>setFields({...fields,account:event.target.checked})}/><span>账户</span>
          <AccountSelect aria-label="批量修改账户" accounts={accountOptions} groups={accountGroupOptions} value={account} disabled={!fields.account||busy} onChange={event=>setAccount(event.target.value)}/></div>
        <div className="bulk-field" role="group" aria-label="批量修改日期"><input type="checkbox" aria-label="启用日期修改" checked={fields.date} onChange={event=>setFields({...fields,date:event.target.checked})}/><span>日期</span>
          <StyledDate aria-label="批量修改日期" type="date" value={date} max={today()} disabled={!fields.date||busy} onChange={event=>setDate(event.target.value)}/></div>
        {error&&<p className="error" role="alert">{error}</p>}
        <div className="modal-footer"><small>保存后会先写入本机，再在后台同步</small><button className="primary" disabled={!enabled||busy}>{busy?"正在保存…":"应用修改"}</button></div>
      </form>
    </section>
  </div>;
}

export function AccountWorkspace({
  state,
  onEdit,
  onEditEntry,
}: {
  state: State;
  onEdit: (account: Account) => void;
  onEditEntry: (entry: Entry) => void;
}) {
  const [kind, setKind] = useState("bank");
  const [view, setView] = useState<"overview" | "reconciliation">("overview");
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const accounts = orderedAccountOptions(state).accounts.filter((account) => account.kind === kind);
  const { inflow, outflow } = accountFlows(state.entries, accounts);
  const selectedAccount = accounts.find(account => account.id === selectedAccountId) ?? accounts[0];
  const reconciliation = selectedAccount ? accountReconciliation(selectedAccount, state.entries) : [];
  const accountNames = new Map(state.accounts.map(account => [account.id, account.name]));
  const selectedFlows = selectedAccount ? accountFlows(state.entries, [selectedAccount]) : {inflow:0,outflow:0};
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
            onClick={() => {setKind(id);setSelectedAccountId("");}}
          >
            <Wallet size={22} />
            <span>
              <b>
                {money(
                  balanceTotal(state.accounts.filter(account => account.kind === id)),
                )}
              </b>
              <small>{label}账户</small>
            </span>
          </button>
        ))}
      </div>
      <div className="account-detail">
        <div className="account-detail-heading">
          <div><h2>{accountLabels[kind]}账户</h2><div className="account-view-tabs" role="tablist" aria-label="资金账户视图">
            <button role="tab" aria-selected={view === "overview"} className={view === "overview" ? "active" : ""} onClick={()=>setView("overview")}><Wallet size={15}/>账户概览</button>
            <button role="tab" aria-selected={view === "reconciliation"} className={view === "reconciliation" ? "active" : ""} onClick={()=>setView("reconciliation")}><CalendarDays size={15}/>逐日对账</button>
          </div></div>
          {view === "overview" && <button aria-label="添加账户" title="添加账户"
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
          ><Plus size={18} aria-hidden="true" /></button>}
        </div>
        {view === "overview" ? <>
        <div className="account-flow">
          <div>
            <small>余额</small>
            <strong>
              {money(balanceTotal(accounts))}
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
        </> : <div className="reconciliation-view">
          {accounts.length ? <>
            <div className="reconciliation-accounts" role="tablist" aria-label="选择对账账户">
              {accounts.map(account=><button key={account.id} role="tab" aria-selected={selectedAccount?.id===account.id}
                className={selectedAccount?.id===account.id?"active":""} onClick={()=>setSelectedAccountId(account.id)}>
                <span>{account.name}</span><strong>¥ {money(account.balance_cents)}</strong>
              </button>)}
            </div>
            {selectedAccount && <>
              <div className="reconciliation-summary">
                <div><small>期初余额</small><strong>¥ {money(selectedAccount.opening_cents)}</strong></div>
                <div><small>累计流入</small><strong className="book-in">+ ¥ {money(selectedFlows.inflow)}</strong></div>
                <div><small>累计流出</small><strong className="book-out">− ¥ {money(selectedFlows.outflow)}</strong></div>
                <div><small>当前账面余额</small><strong>¥ {money(selectedAccount.balance_cents)}</strong></div>
              </div>
              <p className="reconciliation-tip">从最近一天向前核对；第一次与{selectedAccount.name}实际余额不同的日终余额附近，通常就是遗漏或记错的流水。</p>
              <div className="reconciliation-days">
                {reconciliation.map(day=><section className="reconciliation-day" key={day.date}>
                  <header><div><strong>{day.date}</strong><small>{day.postings.length} 笔变动</small></div>
                    <div className="reconciliation-day-totals"><span>期初 ¥ {money(day.opening_cents)}</span><span className="book-in">流入 +{money(day.inflow_cents)}</span><span className="book-out">流出 −{money(day.outflow_cents)}</span><b>日终 ¥ {money(day.closing_cents)}</b></div></header>
                  <div className="reconciliation-postings">{day.postings.map(({entry,amount_cents,balance_cents})=>{
                    const otherId=entry.account_id===selectedAccount.id?entry.to_account_id:entry.account_id;
                    const detail=entry.category || kindLabel(entry.kind);
                    return <button key={entry.id} onClick={()=>onEditEntry(entry)} title="打开并编辑这条流水">
                      <span><strong>{detail}</strong><small>{kindLabel(entry.kind)}{otherId&&accountNames.get(otherId)?` · ${accountNames.get(otherId)}`:""}</small></span>
                      <span className="reconciliation-posting-amount"><b className={amount_cents>0?"book-in":"book-out"}>{amount_cents>0?"+":"−"} ¥ {money(Math.abs(amount_cents))}</b><small>余额 ¥ {money(balance_cents)}</small></span>
                    </button>;
                  })}</div>
                </section>)}
                {!reconciliation.length&&<div className="empty">这个账户还没有流水，当前余额就是期初余额。</div>}
              </div>
            </>}
          </> : <div className="empty">当前类型下还没有账户。</div>}
        </div>}
      </div>
    </section>
  );
}
