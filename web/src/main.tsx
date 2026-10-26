import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  BookOpen,
  ChartNoAxesCombined,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Download,
  LayoutDashboard,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import {
  Account,
  CategoryCatalog,
  ordered,
  Entry,
  Kind,
  Report,
  State,
  accountLabels,
  api,
  cents,
  labels,
  money,
  today,
} from "./types";
import { ControlTheme, StyledDate, StyledSelect, CategorySelect } from "./controls";
import { BookList, AccountWorkspace } from "./ledger-views";
import "./style.css";
import { OrderSettings } from "./order-settings";

const categories = [
  "日常/餐饮",
  "日常/购物",
  "日常/交通",
  "居住/房租",
  "居住/水电",
  "生活/娱乐",
  "生活/旅行",
  "健康/医疗",
  "学习/书籍",
  "收入/工资",
  "收入/其他",
  "未分类",
];
const emptyReport: Report = {
  income: 0,
  expense: 0,
  net: 0,
  daily: [],
  months: [],
  categories: [],
};
const newEntry = (account = ""): Entry => ({
  id: crypto.randomUUID(),
  date: today(),
  kind: "expense",
  amount_cents: 0,
  account_id: account,
  to_account_id: null,
  category: "日常/餐饮",
  merchant: "",
  memo: "",
  counterparty: "",
  reference_id: null,
  version: 1,
  deleted: 0,
  remaining_cents: 0,
});
function App() {
  const [state, setState] = useState<State | null>(null),
    [logged, setLogged] = useState(false),
    [checked, setChecked] = useState(false);
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [bookMonth, setBookMonth] = useState(today().slice(0, 7));
  const [page, setPage] = useState("entry"),
    [period, setPeriod] = useState("month"),
    [anchor, setAnchor] = useState(today().slice(0, 7));
  const [customStart, setCustomStart] = useState(
      today().slice(0, 4) + "-01-01",
    ),
    [customEnd, setCustomEnd] = useState(today());
  const [report, setReport] = useState<Report>(emptyReport),
    [curve, setCurve] = useState("daily");
  const [query, setQuery] = useState(""),
    [type, setType] = useState(""),
    [accountFilter, setAccountFilter] = useState(""),
    [categoryFilter, setCategoryFilter] = useState(""),
    [day, setDay] = useState(""),
    [trash, setTrash] = useState(false);
  const [editor, setEditor] = useState<Entry | null>(null),
    [editing, setEditing] = useState(false),
    [accountEditor, setAccountEditor] = useState<Account | null>(null);
  const [lastSync, setLastSync] = useState(""),
    [online, setOnline] = useState(navigator.onLine);
  const range = useMemo(() => {
    const [y, m] = anchor.split("-").map(Number);
    const startMonth =
      period === "year"
        ? 1
        : period === "quarter"
          ? Math.floor((m - 1) / 3) * 3 + 1
          : m;
    const endMonth =
      period === "year" ? 12 : period === "quarter" ? startMonth + 2 : m;
    return period === "custom"
      ? [customStart, customEnd]
      : [
          `${y}-${String(startMonth).padStart(2, "0")}-01`,
          `${y}-${String(endMonth).padStart(2, "0")}-${new Date(y, endMonth, 0).getDate()}`,
        ];
  }, [anchor, period, customStart, customEnd]);
  const refresh = useCallback(async () => {
    const value = await api<State>("/state");
    setState(value);
    setLogged(true);
    setLastSync(
      new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }, []);
  useEffect(() => {
    refresh()
      .catch((e) => {
        setLogged(false);
        if (e.message !== "请重新登录") setError(e.message);
      })
      .finally(() => setChecked(true));
  }, [refresh]);
  useEffect(() => {
    if (!logged) return;
    const timer = setInterval(
      () => refresh().catch((e) => setError(e.message)),
      30000,
    );
    const focus = () => refresh().catch((e) => setError(e.message));
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [logged, refresh]);
  useEffect(() => {
    const fn = () => setOnline(navigator.onLine);
    window.addEventListener("online", fn);
    window.addEventListener("offline", fn);
    return () => {
      window.removeEventListener("online", fn);
      window.removeEventListener("offline", fn);
    };
  }, []);
  useEffect(() => {
    let current = true;
    if (logged)
      api<Report>(`/report?start=${range[0]}&end=${range[1]}`)
        .then((value) => {
          if (current) setReport(value);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [logged, range, state]);
  const openNew = useCallback(() => {
    if (!state?.accounts.length) {
      setPage("accounts");
      setNotice("先添加一个资金账户，再开始记账。");
      return;
    }
    if (page === "entry") {
      document.getElementById("home-amount")?.focus();
      return;
    }
    setEditor(newEntry(state.accounts[0].id));
    setEditing(false);
  }, [state, page]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        if (logged) openNew();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [logged, openNew]);
  async function run(action: () => Promise<unknown>, message = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const entries =
    page === "entry"
      ? (state?.entries || []).filter((x) => !x.deleted)
      : (state?.entries || []).filter(
          (x) =>
            Boolean(x.deleted) === trash &&
            x.date >= range[0] &&
            x.date <= range[1] &&
            (!day || x.date === day) &&
            (!type || x.kind === type) &&
            (!accountFilter ||
              x.account_id === accountFilter ||
              x.to_account_id === accountFilter) &&
            (!categoryFilter || x.category === categoryFilter) &&
            (!query ||
              [x.category, x.merchant, x.memo, x.counterparty]
                .join(" ")
                .toLowerCase()
                .includes(query.toLowerCase())),
        );
  const accountName = (id: string | null) =>
    state?.accounts.find((x) => x.id === id)?.name || "—";
  function move(direction: number) {
    const [y, m] = anchor.split("-").map(Number);
    const d = new Date(
      y,
      m -
        1 +
        direction * (period === "year" ? 12 : period === "quarter" ? 3 : 1),
      1,
    );
    setAnchor(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
    );
    setDay("");
  }
  const periodTitle =
    period === "year"
      ? `${anchor.slice(0, 4)} 年`
      : period === "quarter"
        ? `${anchor.slice(0, 4)} 年 · 第 ${Math.ceil(Number(anchor.slice(5)) / 3)} 季度`
        : period === "custom"
          ? "自定义时间"
          : `${anchor.slice(0, 4)} 年 ${Number(anchor.slice(5))} 月`;
  if (!checked)
    return (
      <div className="loading">
        <BookOpen size={32} />
        正在打开账本…
      </div>
    );
  if (!logged)
    return (
      <div className="login">
        <div className="login-story">
          <div className="brand">
            <img src="/icon.svg" alt="" width={40} height={40} />
            明账 <span>MINGZHANG</span>
          </div>
          <div>
            <p className="eyebrow">YOUR MONEY, CLEARLY.</p>
            <h1>
              把日子过好，
              <br />
              把每一笔记清。
            </h1>
            <p>
              收支、账户与生活的轨迹，
              <br />
              在一个属于你的账本里。
            </p>
          </div>
          <small>私人账本 · 人民币 · 云端同步</small>
        </div>
        <form
          className="login-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api("/login", { password });
              await refresh();
              setPassword("");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="pill">明账 / 个人版</span>
          <h2>欢迎回来</h2>
          <p>输入密码，继续记录你的生活。</p>
          <label>
            账本密码
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "正在登录…" : "打开我的账本"} <ArrowUpRight size={18} />
          </button>
          <small>网页版与 Mac 客户端使用同一个账本密码。</small>
        </form>
      </div>
    );
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <img src="/icon.svg" alt="" width={40} height={40} />
          明账<span>个人账本</span>
        </div>
        <div className="workspace">
          <div className="avatar">S</div>
          <div>
            {state?.demo ? "演示账本（虚构数据）" : "我的生活账本"}
            <small>CNY · 人民币</small>
          </div>
        </div>
        <p className="nav-label">工作空间</p>
        <nav>
          {[
            ["entry", "记一笔", Plus],
            ["overview", "账本总览", LayoutDashboard],
            ["transactions", "全部流水", ArrowLeftRight],
            ["reports", "收支报表", ChartNoAxesCombined],
            ["accounts", "资金账户", Wallet],
            ["data", "数据管理", Database],
            ["settings", "设置", Settings],
          ].map(([id, label, Icon]) => (
            <button
              key={String(id)}
              className={page === id ? "active" : ""}
              onClick={() => {
                setPage(String(id));
                setDay("");
                setCategoryFilter("");
              }}
            >
              {React.createElement(Icon as typeof Wallet, { size: 19 })}
              {String(label)}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className={"sync " + (!online ? "offline" : "")}>
            <i />
            {online ? `最近同步 ${lastSync}` : "当前离线，恢复联网后再保存"}
          </div>
          <button
            onClick={() => {
              api("/logout", {}).then(() => {
                setLogged(false);
                setState(null);
              });
            }}
          >
            <LogOut size={16} />
            退出账本
          </button>
          <small>明账 v0.1 · 让每一笔都有来处</small>
        </div>
      </aside>
      <main className={page === "entry" ? "entry-workspace" : undefined}>
        <header>
          <div>
            <p className="eyebrow">
              {page === "overview"
                ? "A CLEARER PICTURE"
                : "YOUR PERSONAL LEDGER"}
            </p>
            <h1>
              {
                {
                  entry: "记一笔",
                  overview: "账本总览",
                  transactions: "全部流水",
                  reports: "收支报表",
                  accounts: "资金账户",
                  data: "数据管理",
                  settings: "设置",
                }[page]
              }
            </h1>
            <p className="subtitle">
              {
                {
                  entry: "记下当下这一笔，让生活的收支清清楚楚。",
                  overview: "看清钱的去向，也看见生活的节奏。",
                  transactions: "每一笔收支，都有清楚的来龙去脉。",
                  reports: "从每一天，到每一年。",
                  accounts: "账户余额与借贷往来，一起看清。",
                  data: "你的数据，由你掌握。",
                  settings: "按你的习惯整理分类和账户。",
                }[page]
              }
            </p>
          </div>
          <div className="header-actions">
            <button
              className="icon-button"
              aria-label="刷新账本"
              onClick={() =>
                refresh()
                  .then(() => setNotice("已同步最新账本"))
                  .catch((e) => setError(e.message))
              }
            >
              <RefreshCw size={18} />
            </button>
            {page !== "entry" && (
              <button className="primary" onClick={openNew}>
                <Plus size={18} />
                记一笔 <kbd>⌘ N</kbd>
              </button>
            )}
          </div>
        </header>
        {error && (
          <div className="banner error" role="alert">
            {error}
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="banner" role="status">
            {notice}
            <button aria-label="关闭提示" onClick={() => setNotice("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {page === "entry" && state && (
          <section className="entry-home">
            {state.accounts.length ? (
              <EntryDialog
                inline
                initial={newEntry(state.accounts[0].id)}
                editing={false}
                accounts={state.accounts}
                entries={state.entries}
                categoryOrder={state.ordering?.categories}
                catalog={state.category_catalog}
                onClose={() => {}}
                onSave={async (value) => {
                  await run(() => api("/entries", value, "POST"), "");
                  setBookMonth(value.date.slice(0, 7));
                }}
              />
            ) : (
              <div className="entry-empty">
                <h2>从第一个账户开始</h2>
                <p>添加现金、银行卡或支付宝等账户，就可以记下第一笔收支。</p>
                <button className="primary" onClick={() => setPage("accounts")}>
                  添加资金账户
                </button>
              </div>
            )}
          </section>
        )}
        {["overview", "transactions", "reports"].includes(page) && (
          <div className="period-bar">
            <div className="segments">
              {[
                ["month", "月度"],
                ["quarter", "季度"],
                ["year", "年度"],
                ["custom", "自定义"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={period === id ? "selected" : ""}
                  onClick={() => {
                    setPeriod(id);
                    setDay("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="period-picker">
              {period !== "custom" ? (
                <>
                  <button aria-label="上一期" onClick={() => move(-1)}>
                    <ChevronLeft size={18} />
                  </button>
                  <strong>{periodTitle}</strong>
                  <StyledDate
                    aria-label="选择月份"
                    type="month"
                    value={anchor}
                    onChange={(e) => {
                      if (e.target.value) {
                        setAnchor(e.target.value);
                        setDay("");
                      }
                    }}
                  />
                  <button aria-label="下一期" onClick={() => move(1)}>
                    <ChevronRight size={18} />
                  </button>
                </>
              ) : (
                <>
                  <StyledDate
                    aria-label="开始日期"
                    type="date"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                  />
                  <span>至</span>
                  <StyledDate
                    aria-label="结束日期"
                    type="date"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                  />
                </>
              )}
            </div>
          </div>
        )}
        {["overview", "reports"].includes(page) && (
          <>
            <div className="stats">
              <Metric
                label="本期收入"
                value={report.income}
                icon={<ArrowDownLeft />}
                tone="income"
              />
              <Metric
                label="本期支出"
                value={report.expense}
                icon={<ArrowUpRight />}
                tone="expense"
              />
              <Metric
                label="本期结余"
                value={report.net}
                note="收入 − 支出（已抵扣退款）"
                tone="balance"
              />
            </div>
            <section className="panel chart-panel">
              <div className="panel-head">
                <div>
                  <h2>收支动态</h2>
                  <p>
                    {range[0]} — {range[1]} <span>· 点击曲线查看当天流水</span>
                  </p>
                </div>
                <div className="segments small">
                  <button
                    className={curve === "daily" ? "selected" : ""}
                    onClick={() => setCurve("daily")}
                  >
                    每日收支
                  </button>
                  <button
                    className={curve === "cumulative" ? "selected" : ""}
                    onClick={() => setCurve("cumulative")}
                  >
                    累计结余
                  </button>
                </div>
              </div>
              <div className="chart">
                <ResponsiveContainer width="100%" height="100%">
                  {curve === "daily" ? (
                    <LineChart
                      data={report.daily}
                      onClick={(s) => {
                        const label = s?.activeLabel;
                        if (label) {
                          setDay(String(label));
                          setPage("transactions");
                        }
                      }}
                    >
                      <CartesianGrid
                        vertical={false}
                        stroke="#e9ede9"
                        strokeDasharray="3 4"
                      />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(v) => String(v).slice(5)}
                        tickLine={false}
                        axisLine={false}
                        minTickGap={35}
                      />
                      <YAxis
                        tickFormatter={(v) => `${Number(v) / 100}`}
                        tickLine={false}
                        axisLine={false}
                        width={65}
                      />
                      <Tooltip
                        formatter={(v) => `¥ ${money(Number(v))}`}
                        labelFormatter={(v) => String(v)}
                      />
                      <Line
                        name="收入"
                        type="monotone"
                        dataKey="income"
                        stroke="#257864"
                        strokeWidth={2.5}
                        dot={false}
                      />
                      <Line
                        name="支出"
                        type="monotone"
                        dataKey="expense"
                        stroke="#d69957"
                        strokeWidth={2.5}
                        dot={false}
                      />
                    </LineChart>
                  ) : (
                    <AreaChart
                      data={report.daily}
                      onClick={(s) => {
                        if (s?.activeLabel) {
                          setDay(String(s.activeLabel));
                          setPage("transactions");
                        }
                      }}
                    >
                      <defs>
                        <linearGradient
                          id="balanceFill"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor="#257864"
                            stopOpacity={0.22}
                          />
                          <stop
                            offset="100%"
                            stopColor="#257864"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        vertical={false}
                        stroke="#e9ede9"
                        strokeDasharray="3 4"
                      />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(v) => String(v).slice(5)}
                        tickLine={false}
                        axisLine={false}
                        minTickGap={35}
                      />
                      <YAxis
                        tickFormatter={(v) => `${Number(v) / 100}`}
                        tickLine={false}
                        axisLine={false}
                        width={65}
                      />
                      <Tooltip formatter={(v) => `¥ ${money(Number(v))}`} />
                      <Area
                        name="累计结余"
                        type="monotone"
                        dataKey="cumulative"
                        stroke="#257864"
                        fill="url(#balanceFill)"
                        strokeWidth={2.5}
                      />
                    </AreaChart>
                  )}
                </ResponsiveContainer>
              </div>
              <div className="chart-footer">
                <span>
                  <i className="green-dot" />
                  收入
                </span>
                <span>
                  <i className="amber-dot" />
                  支出（扣除退款）
                </span>
                <small>单位：人民币元 · 转账及借还款本金不计入收支</small>
              </div>
            </section>
            <div className="two-columns">
              <section className="panel">
                <div className="panel-head">
                  <h2>支出构成</h2>
                  <span className="muted">按净支出排序</span>
                </div>
                {report.categories.length ? (
                  report.categories.map(([name, amount], i) => (
                    <button
                      className="category-row"
                      key={name}
                      onClick={() => {
                        setCategoryFilter(name);
                        setPage("transactions");
                      }}
                    >
                      <span className="category-rank">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <strong>{name}</strong>
                        <div className="bar">
                          <i
                            style={{
                              width: `${(Math.max(0, amount) / Math.max(1, ...report.categories.map((x) => x[1]))) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                      <b>¥ {money(amount)}</b>
                      <small>
                        {report.expense > 0
                          ? ((amount / report.expense) * 100).toFixed(1) + "%"
                          : "—"}
                      </small>
                    </button>
                  ))
                ) : (
                  <Empty text="这段时间还没有支出" action={openNew} />
                )}
              </section>
              <section className="panel">
                <div className="panel-head">
                  <h2>月度明细</h2>
                  <span className="muted">精确到分</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>月份</th>
                        <th className="numeric">收入</th>
                        <th className="numeric">支出</th>
                        <th className="numeric">结余</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.months.map((m) => (
                        <tr
                          key={m.month}
                          onClick={() => {
                            setPeriod("month");
                            setAnchor(m.month);
                            setDay("");
                            setPage("transactions");
                          }}
                          className="clickable"
                        >
                          <td>{m.month}</td>
                          <td className="numeric income-text">
                            {money(m.income)}
                          </td>
                          <td className="numeric">{money(m.expense)}</td>
                          <td className="numeric">
                            {money(m.income - m.expense)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </>
        )}
        {page === "entry" && state && (
          <BookList
            state={state}
            month={bookMonth}
            onMonth={setBookMonth}
            onSave={async (entry) => {
              await run(() => api(`/entries/${entry.id}`, entry, "PUT"));
            }}
            onEdit={(entry) => {
              setEditor({ ...entry });
              setEditing(true);
            }}
            onDelete={(entry) => {
              run(
                () =>
                  api(`/entries/${entry.id}/delete`, {
                    version: entry.version,
                  }),
                "已移入回收站，可随时恢复",
              ).catch(() => {});
            }}
          />
        )}
        {["overview", "transactions"].includes(page) && (
          <section className="panel">
            <div className="panel-head">
              <h2>
                {page !== "transactions" ? "最近记录" : "交易明细"}{" "}
                <span className="count">{entries.length}</span>
              </h2>
              {page !== "transactions" ? (
                <button
                  className="text-button"
                  onClick={() => setPage("transactions")}
                >
                  查看全部 <ArrowUpRight size={15} />
                </button>
              ) : (
                <button
                  className="text-button"
                  onClick={() => setTrash(!trash)}
                >
                  <Trash2 size={15} />
                  {trash ? "返回正常流水" : "回收站"}
                </button>
              )}
            </div>
            {page === "transactions" && (
              <div className="filters">
                <label className="search">
                  <Search size={17} />
                  <input
                    placeholder="搜索分类、商家、备注或往来对象"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <StyledSelect
                  aria-label="交易类型筛选"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                >
                  <option value="">全部类型</option>
                  {Object.entries(labels).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </StyledSelect>
                <StyledSelect
                  aria-label="账户筛选"
                  value={accountFilter}
                  onChange={(e) => setAccountFilter(e.target.value)}
                >
                  <option value="">全部账户</option>
                  {state?.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </StyledSelect>
                {(day || categoryFilter) && (
                  <button
                    className="chip"
                    onClick={() => {
                      setDay("");
                      setCategoryFilter("");
                    }}
                  >
                    {day || categoryFilter}
                    <X size={13} />
                  </button>
                )}
              </div>
            )}
            {entries.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>交易 / 分类</th>
                      <th>账户</th>
                      <th className="numeric">金额</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries
                      .slice(
                        0,
                        page === "overview" ? 6 : page === "entry" ? 20 : 500,
                      )
                      .map((x) => (
                        <tr key={x.id}>
                          <td className="muted">
                            {x.date.slice(5)}
                            <small>{x.date.slice(0, 4)}</small>
                          </td>
                          <td>
                            <div className="transaction-title">
                              <span className={"transaction-icon " + x.kind}>
                                {[
                                  "income",
                                  "refund",
                                  "collect",
                                  "borrow",
                                ].includes(x.kind) ? (
                                  <ArrowDownLeft size={17} />
                                ) : x.kind === "transfer" ? (
                                  <ArrowLeftRight size={17} />
                                ) : (
                                  <ArrowUpRight size={17} />
                                )}
                              </span>
                              <div>
                                <strong>{x.category || labels[x.kind]}</strong>
                                <small>
                                  {labels[x.kind]}
                                  {x.merchant ? " · " + x.merchant : ""}
                                  {x.counterparty ? " · " + x.counterparty : ""}
                                </small>
                              </div>
                            </div>
                          </td>
                          <td>
                            {accountName(x.account_id)}
                            {x.to_account_id && (
                              <small>→ {accountName(x.to_account_id)}</small>
                            )}
                          </td>
                          <td
                            className={
                              "numeric " +
                              (["income", "refund"].includes(x.kind)
                                ? "income-text"
                                : "")
                            }
                          >
                            {["income", "refund"].includes(x.kind)
                              ? "+"
                              : x.kind === "expense"
                                ? "−"
                                : ""}
                            {money(x.amount_cents)}
                          </td>
                          <td>
                            <div className="row-actions">
                              {page === "transactions" && trash ? (
                                <button
                                  onClick={() =>
                                    run(
                                      () =>
                                        api(`/entries/${x.id}/restore`, {
                                          version: x.version,
                                        }),
                                      "已恢复",
                                    ).catch(() => {})
                                  }
                                >
                                  恢复
                                </button>
                              ) : (
                                <>
                                  <button
                                    onClick={() => {
                                      setEditor({ ...x });
                                      setEditing(true);
                                    }}
                                  >
                                    编辑
                                  </button>
                                  <button
                                    aria-label="复制交易"
                                    onClick={() => {
                                      setEditor({
                                        ...x,
                                        id: crypto.randomUUID(),
                                        date: today(),
                                        version: 1,
                                      });
                                      setEditing(false);
                                    }}
                                  >
                                    <Copy size={14} />
                                  </button>
                                  <button
                                    aria-label="删除交易"
                                    onClick={() =>
                                      run(
                                        () =>
                                          api(`/entries/${x.id}/delete`, {
                                            version: x.version,
                                          }),
                                        "已移入回收站，可随时恢复",
                                      ).catch(() => {})
                                    }
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {page === "transactions" && entries.length > 500 && (
                  <p className="muted">
                    当前展示前 500 笔，请缩小日期范围或使用搜索。
                  </p>
                )}
              </div>
            ) : (
              <Empty
                text={
                  page === "entry"
                    ? "还没有记录，在上方记下第一笔吧。"
                    : trash
                      ? "回收站是空的"
                      : "这段时间还没有匹配的流水"
                }
                action={page === "entry" || trash ? undefined : openNew}
              />
            )}
          </section>
        )}
        {page === "accounts" && state && (
          <>
            <AccountWorkspace state={state} onEdit={setAccountEditor} />
            <section className="panel">
              <div className="panel-head">
                <h2>未结清往来</h2>
                <span className="muted">
                  待收 ¥ {money(state.receivable)} · 待还 ¥{" "}
                  {money(state.payable)}
                </span>
              </div>
              {state.entries
                .filter(
                  (x) =>
                    !x.deleted &&
                    ["lend", "borrow"].includes(x.kind) &&
                    x.remaining_cents > 0,
                )
                .map((x) => (
                  <div className="loan-row" key={x.id}>
                    <div>
                      <strong>{x.counterparty}</strong>
                      <small>
                        {x.date} · {labels[x.kind]} ¥ {money(x.amount_cents)}
                      </small>
                    </div>
                    <span>
                      待{x.kind === "lend" ? "收" : "还"} ¥{" "}
                      {money(x.remaining_cents)}
                    </span>
                    <button
                      className="text-button"
                      onClick={() => {
                        setEditor({
                          ...newEntry(x.account_id),
                          kind: x.kind === "lend" ? "collect" : "repay",
                          reference_id: x.id,
                          amount_cents: x.remaining_cents,
                          counterparty: x.counterparty,
                          category: "",
                        });
                        setEditing(false);
                      }}
                    >
                      记录{x.kind === "lend" ? "收回" : "还款"}
                    </button>
                  </div>
                ))}
            </section>
          </>
        )}
        {page === "settings" && state && <OrderSettings state={state} defaults={categories}
          onCategoryChange={async value => { await run(() => api("/categories", value)); }}
          onEditAccount={setAccountEditor}
          onSave={async value => { await run(() => api("/display-order", value, "PUT")); }} />}
        {page === "data" && state && (
          <DataPage
            state={state}
            onRefresh={refresh}
            onError={setError}
            onNotice={setNotice}
          />
        )}
        <footer>
          个人账本 · Asia/Shanghai <span>数据以服务端保存结果为准</span>
        </footer>
      </main>
      {editor && state && (
        <EntryDialog
          key={editor.id}
          initial={editor}
          editing={editing}
          accounts={state.accounts}
          entries={state.entries}
                categoryOrder={state.ordering?.categories}
                catalog={state.category_catalog}
          onClose={() => setEditor(null)}
          onSave={async (value) => {
            await run(() =>
              api(
                "/entries" + (editing ? "/" + value.id : ""),
                value,
                editing ? "PUT" : "POST",
              ),
            );
            setEditor(null);
          }}
        />
      )}
      {accountEditor && (
        <AccountDialog
          initial={accountEditor}
          onClose={() => setAccountEditor(null)}
          onSave={async (value) => {
            await run(() =>
              api(
                "/accounts" + (value.id ? "/" + value.id : ""),
                value,
                value.id ? "PUT" : "POST",
              ),
            );
            setAccountEditor(null);
          }}
        />
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  note,
  tone,
  icon,
}: {
  label: string;
  value: number;
  note?: string;
  tone: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={"metric " + tone}>
      <div>
        <span>{label}</span>
        {icon}
      </div>
      <strong>
        <small>¥</small> {money(value)}
      </strong>
      <p>{note || "按交易实际发生日期统计"}</p>
    </div>
  );
}
function Empty({ text, action }: { text: string; action?: () => void }) {
  return (
    <div className="empty">
      <BookOpen size={28} />
      <p>{text}</p>
      {action && (
        <button className="text-button" onClick={action}>
          开始记录 <Plus size={15} />
        </button>
      )}
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <section
        className="modal"
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const fields = dialogRef.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
            );
            if (!fields?.length) return;
            const first = fields[0],
              last = fields[fields.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button
            aria-label="关闭窗口"
            className="icon-button"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function EntryDialog({
  inline = false,
  initial,
  editing,
  accounts,
  categoryOrder = [],
  catalog,
  entries,
  onClose,
  onSave,
}: {
  inline?: boolean;
  initial: Entry;
  editing: boolean;
  accounts: Account[];
  categoryOrder?: string[];
  catalog?: CategoryCatalog;
  entries: Entry[];
  onClose: () => void;
  onSave: (entry: Entry) => Promise<void>;
}) {
  const [value, setValue] = useState(initial),
    [amount, setAmount] = useState(
      initial.amount_cents ? String(initial.amount_cents / 100) : "",
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Entry>(key: K, v: Entry[K]) =>
    setValue((old) => ({ ...old, [key]: v }));
  const refKind = { refund: "expense", repay: "borrow", collect: "lend" }[
    value.kind as "refund" | "repay" | "collect"
  ];
  const categoryOptions = ordered(catalog ? Object.keys(catalog.items).filter(p => catalog.items[p].includes(value.kind)) : Array.from(
    new Set([
      ...categories.filter((category) =>
        value.kind === "income"
          ? category.startsWith("收入/") || category === "未分类"
          : !category.startsWith("收入/"),
      ),
      ...entries
        .filter((entry) => !entry.deleted && entry.kind === value.kind)
        .map((entry) => entry.category),
      value.category,
    ]),
  ).filter(Boolean), categoryOrder);
  useEffect(() => {
    if (!editing && catalog && ["income", "expense"].includes(value.kind) && !categoryOptions.includes(value.category)) {
      setValue(old => ({...old, category: categoryOptions[0] ?? ""}));
    }
  }, [catalog, value.kind, value.category, editing]);
  const form = (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setBusy(true);
        try {
          await onSave({ ...value, amount_cents: cents(amount) });
          if (inline) {
            setValue({
              ...newEntry(value.account_id),
              kind: value.kind,
              category: value.category,
              date: value.date,
            });
            setAmount("");
            amountRef.current?.focus();
          }
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="entry-kinds">
        {Object.entries(labels).map(([k, v]) => (
          <button
            type="button"
            className={value.kind === k ? "selected" : ""}
            key={k}
            onClick={() =>
              setValue({
                ...value,
                kind: k as Kind,
                to_account_id: null,
                reference_id: null,
                category: ["income", "expense"].includes(k)
                  ? k === "income"
                    ? "收入/工资"
                    : "日常/餐饮"
                  : "",
              })
            }
          >
            {v}
          </button>
        ))}
      </div>
      <label className="amount-input">
        金额（人民币）
        <div>
          <span>¥</span>
          <input
            aria-label="金额"
            id={inline ? "home-amount" : undefined}
            ref={amountRef}
            autoFocus
            required
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </label>
        {["income", "expense"].includes(value.kind) && (
          <label className="entry-category">
            分类
            <CategorySelect options={categoryOptions} value={value.category}
              onChange={e => set("category", e.target.value)} />
          </label>
        )}
      <div className="form-grid">
        <label>
          日期
          <StyledDate
            aria-label="日期"
            type="date"
            required
            max={today()}
            value={value.date}
            onChange={(e) => set("date", e.target.value)}
          />
        </label>
        <label>
          {value.kind === "transfer" ? "转出账户" : "账户"}
          <StyledSelect
            value={value.account_id}
            onChange={(e) => set("account_id", e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </StyledSelect>
        </label>
        {value.kind === "transfer" && (
          <label className="full">
            转入账户
            <StyledSelect
              required
              value={value.to_account_id || ""}
              onChange={(e) => set("to_account_id", e.target.value)}
            >
              <option value="">请选择转入账户</option>
              {accounts
                .filter((a) => a.id !== value.account_id)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </StyledSelect>
            <small>信用卡还本金也使用账户间转账。</small>
          </label>
        )}
        {refKind && (
          <label className="full">
            关联原交易
            <StyledSelect
              required
              value={value.reference_id || ""}
              onChange={(e) => set("reference_id", e.target.value)}
            >
              <option value="">选择原始{labels[refKind as Kind]}记录</option>
              {entries
                .filter(
                  (x) =>
                    !x.deleted &&
                    x.kind === refKind &&
                    (x.remaining_cents > 0 || x.id === initial.reference_id),
                )
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.date} · {x.counterparty || x.category} · ¥{" "}
                    {money(x.amount_cents)}
                  </option>
                ))}
            </StyledSelect>
            <small>退款在实际退款日抵扣原分类支出。</small>
          </label>
        )}
        {["lend", "borrow"].includes(value.kind) && (
          <label className="full">
            往来对象
            <input
              required
              value={value.counterparty}
              onChange={(e) => set("counterparty", e.target.value)}
              placeholder="例如：张先生"
            />
          </label>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <small>
          {inline ? "Enter 保存 · 连续记账" : "保存失败时，输入内容会保留。"}
        </small>
        <button className="primary" disabled={busy}>
          {busy ? "正在保存…" : "保存交易"}
        </button>
      </div>
    </form>
  );
  return inline ? (
    form
  ) : (
    <Modal title={editing ? "编辑交易" : "记一笔"} onClose={onClose}>
      {form}
    </Modal>
  );
}
function AccountDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: Account;
  onClose: () => void;
  onSave: (value: Account) => Promise<void>;
}) {
  const [value, setValue] = useState(initial),
    [amount, setAmount] = useState(String(initial.opening_cents / 100)),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title={initial.id ? "编辑账户" : "添加账户"} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave({ ...value, opening_cents: cents(amount) });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          账户名称
          <input
            autoFocus
            required
            value={value.name}
            onChange={(e) => setValue({ ...value, name: e.target.value })}
            maxLength={60}
            placeholder="例如：招商银行"
          />
        </label>
        <label>
          账户类型
          <StyledSelect
            value={value.kind}
            onChange={(e) => setValue({ ...value, kind: e.target.value })}
          >
            {Object.entries(accountLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </StyledSelect>
        </label>
        <label>
          期初余额（元）
          <input
            required
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <small>
            开始使用此账本之前的余额；信用卡欠款填负数。导入历史账单时，填写历史第一笔之前的余额。
          </small>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <small>期初余额不计入收入。</small>
          <button className="primary" disabled={busy}>
            保存账户
          </button>
        </div>
      </form>
    </Modal>
  );
}

type ImportInfo = {
  id: string;
  headers: string[];
  mapping: Record<string, string>;
  sample: string[][];
  count: number;
};
type Preview = {
  rows: {
    row: number;
    entry?: Entry;
    account?: string;
    duplicate: boolean;
    error: string;
  }[];
  new_accounts: Record<string, string>;
};
function DataPage({
  state,
  onRefresh,
  onError,
  onNotice,
}: {
  state: State;
  onRefresh: () => Promise<void>;
  onError: (s: string) => void;
  onNotice: (s: string) => void;
}) {
  const [upload, setUpload] = useState<ImportInfo | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [selected, setSelected] = useState<number[]>([]),
    [busy, setBusy] = useState(false),
    [file, setFile] = useState<File | null>(null);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    onError("");
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const fieldLabels: Record<string, string> = {
    date: "日期 *",
    kind: "收支类型 *",
    amount: "金额 *",
    account: "账户 *",
    to_account: "转入账户",
    category: "一级分类",
    subcategory: "二级分类",
    merchant: "商家",
    memo: "备注",
    currency: "币种",
  };
  return (
    <>
      <div className="two-columns">
        <section className="panel data-card">
          <span className="feature-icon">
            <Download />
          </span>
          <h2>导出与备份</h2>
          <p>
            CSV
            用于查看和分析；完整备份包含账户、流水、导入记录与账本密码的加密校验值。
          </p>
          <div className="button-row">
            <a className="secondary" href="/api/export.csv">
              <Download size={16} />
              导出流水 CSV
            </a>
            <a className="primary" href="/api/backup">
              <Database size={16} />
              下载完整备份
            </a>
          </div>
          <small>
            最近服务端备份：{state.backup_date || "尚未生成"}
            。请定期下载一份保存在其他设备。恢复需停止服务后执行恢复命令。
          </small>
        </section>
        <section className="panel data-card">
          <span className="feature-icon warm">
            <ArrowLeftRight />
          </span>
          <h2>迁入历史账本</h2>
          <p>
            支持 CSV /
            XLSX。先映射列、预览和排除重复，再确认导入。首版导入人民币收入、支出与转账。
          </p>
          <input
            aria-label="选择历史账单文件"
            type="file"
            accept=".csv,.xlsx"
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setUpload(null);
              setPreview(null);
            }}
          />
          <button
            className="secondary"
            disabled={!file || busy}
            onClick={() =>
              action(async () => {
                const form = new FormData();
                form.append("file", file!);
                setUpload(await api<ImportInfo>("/imports/upload", form));
                setPreview(null);
              })
            }
          >
            {busy ? "正在处理…" : "读取文件"}
          </button>
          <small>
            每次最多 5 MB、10,000 行。旧版 XLS 请先另存为 XLSX 或 CSV。
          </small>
        </section>
      </div>
      {upload && (
        <section className="panel">
          <div className="panel-head">
            <h2>1. 确认字段对应关系</h2>
            <span className="muted">识别到 {upload.count} 行</span>
          </div>
          <div className="mapping-grid">
            {Object.entries(fieldLabels).map(([key, label]) => (
              <label key={key}>
                {label}
                <StyledSelect
                  value={upload.mapping[key] || ""}
                  onChange={(e) => {
                    setUpload({
                      ...upload,
                      mapping: { ...upload.mapping, [key]: e.target.value },
                    });
                    setPreview(null);
                  }}
                >
                  <option value="">不导入此列</option>
                  {upload.headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </StyledSelect>
              </label>
            ))}
          </div>
          <div className="panel-actions">
            <button
              className="primary"
              disabled={
                busy ||
                ["date", "kind", "amount", "account"].some(
                  (k) => !upload.mapping[k],
                )
              }
              onClick={() =>
                action(async () => {
                  const p = await api<Preview>(
                    `/imports/${upload.id}/preview`,
                    { mapping: upload.mapping },
                  );
                  setPreview(p);
                  setSelected(
                    p.rows
                      .filter((x) => !x.error && !x.duplicate)
                      .map((x) => x.row),
                  );
                })
              }
            >
              生成导入预览
            </button>
          </div>
        </section>
      )}
      {preview && upload && (
        <section className="panel">
          <div className="panel-head">
            <h2>2. 检查并确认导入</h2>
            <strong>已选 {selected.length} 笔</strong>
          </div>
          <div className="import-summary">
            重复 {preview.rows.filter((x) => x.duplicate).length} 笔 · 异常{" "}
            {preview.rows.filter((x) => x.error).length}{" "}
            笔。将按选中记录创建缺少的账户，期初余额为 0：
            {Object.keys(preview.new_accounts).join("、") || "无"}
            。同日同金额同内容的记录按疑似重复处理。
          </div>
          <div className="preview-table table-wrap">
            <table>
              <thead>
                <tr>
                  <th>选择</th>
                  <th>原行号</th>
                  <th>日期</th>
                  <th>账户 / 分类</th>
                  <th>金额</th>
                  <th>检查结果</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.row}>
                    <td>
                      <input
                        aria-label={`导入第${r.row}行`}
                        type="checkbox"
                        disabled={!!r.error || r.duplicate}
                        checked={selected.includes(r.row)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, r.row]
                              : selected.filter((x) => x !== r.row),
                          )
                        }
                      />
                    </td>
                    <td>{r.row}</td>
                    <td>{r.entry?.date || "—"}</td>
                    <td>
                      {r.account} / {r.entry?.category}
                    </td>
                    <td>{r.entry ? money(r.entry.amount_cents) : "—"}</td>
                    <td className={r.error ? "error" : "muted"}>
                      {r.error || (r.duplicate ? "疑似重复，已跳过" : "可导入")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-actions">
            <button
              className="primary"
              disabled={busy || !selected.length}
              onClick={() =>
                action(async () => {
                  const result = await api<{ count: number }>(
                    `/imports/${upload.id}/commit`,
                    { rows: selected },
                  );
                  setUpload(null);
                  setPreview(null);
                  await onRefresh();
                  onNotice(
                    `成功导入 ${result.count} 笔。可在下方撤销整个批次。`,
                  );
                })
              }
            >
              确认导入 {selected.length} 笔
            </button>
          </div>
        </section>
      )}
      <section className="panel">
        <div className="panel-head">
          <h2>导入记录</h2>
          <span className="muted">撤销后流水进入回收站</span>
        </div>
        {state.imports.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>文件</th>
                  <th>时间（UTC）</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {state.imports.map((x) => (
                  <tr key={x.id}>
                    <td>{x.name}</td>
                    <td>{x.created_at}</td>
                    <td>
                      {
                        {
                          preview: "未导入",
                          committed: "已导入",
                          rolled_back: "已撤销",
                        }[x.status]
                      }
                    </td>
                    <td>
                      {x.status === "committed" && (
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            action(async () => {
                              await api(`/imports/${x.id}/rollback`, {});
                              await onRefresh();
                              onNotice("该批次已撤销；已创建的账户保留。");
                            })
                          }
                        >
                          撤销此批次
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty text="尚无历史账单导入记录" />
        )}
      </section>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <ControlTheme>
    <App />
  </ControlTheme>,
);
