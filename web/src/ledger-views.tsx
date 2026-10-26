import { ChevronLeft, ChevronRight, ListFilter, PencilLine, Plus, Search, Trash2, Wallet, X } from "lucide-react";
import { useRef, useState } from "react";
import {
  Account,
  Entry,
  State,
  accountLabels,
  labels,
  money,
  today,
} from "./types";
import { EntryField } from "./entry-field";
import { StyledSelect, StyledDate } from "./controls";

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
}: {
  state: State;
  month: string;
  onMonth: (month: string) => void;
  onEdit: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
  onSave: (entry: Entry) => Promise<void>;
}) {
  const [category, setCategory] = useState(""),
    [account, setAccount] = useState(""),
    [query, setQuery] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
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
      (!category || entry.category === category) &&
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
            setCategory("");
            setAccount("");
            setQuery("");
            setPage(0);
          }}
        ><ListFilter size={18} aria-hidden="true" /></button>
        <StyledSelect
          size="small"
          aria-label="清单分类"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setPage(0);
          }}
        >
          <option value="">全部分类</option>
          {Array.from(new Set(active.map((entry) => entry.category)))
            .filter(Boolean)
            .map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
        </StyledSelect>
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
        </div>
      </div>
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
          <table>
            <thead>
              <tr>
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
                  <td colSpan={6}>
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
                      className="editable-entry-row"
                      tabIndex={0}
                      aria-label={`编辑 ${entry.date} ${entry.category || labels[entry.kind]} ${money(entry.amount_cents)}`}
                      onClick={() => onEdit(entry)}
                      onKeyDown={(event) => {
                        if (
                          event.target === event.currentTarget &&
                          event.key === "Enter"
                        )
                          onEdit(entry);
                      }}
                    >
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
                            →{" "}
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
                      <td>
                        <div
                          className="row-actions"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <button aria-label="删除账目" title="删除账目" onClick={() => onDelete(entry)}><Trash2 size={18} aria-hidden="true" /></button>
                        </div>
                      </td>
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
          <p className="book-note">
            收支合计扣除退款；转账和借还款本金不计入收支。
          </p>
        </div>
      </div>
    </section>
  );
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
    if (entry.kind === "transfer" && ids.has(entry.to_account_id || ""))
      inflow += entry.amount_cents;
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
                  <td className="numeric">{money(account.balance_cents)}</td>
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
