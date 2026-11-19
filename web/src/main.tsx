import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, BookOpen, ChartNoAxesCombined, Check, ChevronLeft, ChevronRight, CircleArrowUp, Copy, Database, Download, FileUp, Import, LayoutDashboard, LoaderCircle, LogIn, LogOut, PanelLeftClose, PanelLeftOpen, PencilLine, Plus, RefreshCw, RotateCcw, ScanEye, Search, Settings, Trash2, Undo2, Wallet, X } from "lucide-react";
import { DesktopDownloads } from "./desktop-downloads";
import { motion, MotionConfig } from "motion/react";
import React, {
  useCallback,
  useId,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { useFeedback } from "./feedback";
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
  Account,
  AccountGroup,
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
import { AccountSelect, ControlTheme, StyledDate, StyledSelect, CategorySelect } from "./controls";
import { categoryLeaf } from "./category-groups";
import { BookList, AccountWorkspace } from "./ledger-views";
import "./style.css";
import "./paper-theme.css";
import { OrderSettings } from "./order-settings";
import { applyMutation, enqueueMutation, loadLocalState, loadMutations, replayMutations, storeLocalState, storeMutations, type OfflineMutation } from "./offline-mutations";

type DesktopUpdateState = {
  status: "idle" | "available" | "downloading" | "installing";
  currentVersion: string;
  release?: { version: string };
  error?: string;
};
declare global {
  interface Window {
    mingzhangUpdate?: {
      getState(): Promise<DesktopUpdateState>;
      check(): Promise<DesktopUpdateState>;
      install(): Promise<boolean>;
      onState(listener: (state: DesktopUpdateState) => void): () => void;
    };
  }
}

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
function localReport(entries: Entry[], start: string, end: string): Report {
  const daily: Report["daily"] = [];
  const byDate = new Map<string, Report["daily"][number]>();
  for (let time = Date.parse(start + "T00:00:00Z"); time <= Date.parse(end + "T00:00:00Z"); time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10);
    const item = {date, income: 0, expense: 0, cumulative: 0};
    daily.push(item); byDate.set(date, item);
  }
  const categories = new Map<string, number>();
  for (const entry of entries) {
    const item = !entry.deleted ? byDate.get(entry.date) : undefined;
    if (!item) continue;
    if (entry.kind === "income") item.income += entry.amount_cents;
    if (["expense", "refund"].includes(entry.kind)) {
      const amount = entry.amount_cents * (entry.kind === "refund" ? -1 : 1);
      item.expense += amount;
      categories.set(entry.category, (categories.get(entry.category) || 0) + amount);
    }
  }
  let cumulative = 0;
  const months = new Map<string, Report["months"][number]>();
  for (const item of daily) {
    cumulative += item.income - item.expense; item.cumulative = cumulative;
    const month = item.date.slice(0, 7), value = months.get(month) || {month, income: 0, expense: 0};
    value.income += item.income; value.expense += item.expense; months.set(month, value);
  }
  const income = daily.reduce((sum, item) => sum + item.income, 0);
  const expense = daily.reduce((sum, item) => sum + item.expense, 0);
  return {income, expense, net: income - expense, daily, months: [...months.values()],
    categories: [...categories.entries()].sort((a, b) => b[1] - a[1])};
}
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
    [busy, setBusy] = useState(false);
  const { setError, setNotice, clearConnectionError, toast } = useFeedback();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
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
  const [visibleCurves, setVisibleCurves] = useState({income:true, expense:true, cumulative:true});
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
  const [pendingCount, setPendingCount] = useState(() => loadMutations().length);
  const mutationEpoch = useRef(0);
  const backgroundRefresh = useRef<number | null>(null);
  const pendingFlush = useRef(false);
  const pendingRetry = useRef<number | null>(null);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateState | null>(null);
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
    const requestedAt = mutationEpoch.current;
    let value = await api<State>("/state");
    // A slower full refresh must never overwrite a newer entry that was saved
    // while the request was in flight.
    if (requestedAt !== mutationEpoch.current) return;
    const local = replayMutations(value);
    storeLocalState(local);
    setState(local);
    clearConnectionError();
    setLogged(true);
    setLastSync(
      new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }, [clearConnectionError]);
  const scheduleRefresh = useCallback(() => {
    if (backgroundRefresh.current !== null)
      window.clearTimeout(backgroundRefresh.current);
    backgroundRefresh.current = window.setTimeout(() => {
      backgroundRefresh.current = null;
      refresh().catch((e) => setError(e.message));
    }, 2000);
  }, [refresh, setError]);
  useEffect(() => () => {
    if (backgroundRefresh.current !== null)
      window.clearTimeout(backgroundRefresh.current);
  }, []);
  useEffect(() => {
    refresh()
      .catch((e) => {
        const cached = loadLocalState();
        if (cached && e.message !== "请重新登录") {
          setState(cached);
          setLogged(true);
          setError("当前使用本机账本，恢复联网后会自动同步。");
        } else {
          setLogged(false);
          if (e.message !== "请重新登录") setError(e.message);
        }
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
    const updater = window.mingzhangUpdate;
    if (!updater) return;
    const receive = (value: DesktopUpdateState) => setDesktopUpdate(value);
    const unsubscribe = updater.onState(receive);
    updater.getState().then(receive).then(() => updater.check()).then(receive).catch(() => undefined);
    return unsubscribe;
  }, []);
  useEffect(() => {
    let current = true;
    if (logged && state && ["overview", "reports"].includes(page) && (pendingCount || !online)) {
      setReport(localReport(state.entries, range[0], range[1]));
      return () => { current = false; };
    }
    if (logged && ["overview", "reports"].includes(page))
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
  }, [logged, range, state, page, pendingCount, online, setError]);
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
  const flushPendingMutations = useCallback(async () => {
    if (pendingFlush.current) return;
    pendingFlush.current = true;
    let blocked = false;
    try {
      while (loadMutations().length) {
        const mutation = loadMutations()[0];
        try {
          await api(mutation.path, mutation.body, mutation.method, mutation.id);
          const remaining = loadMutations().filter(item => item.id !== mutation.id);
          storeMutations(remaining);
          setPendingCount(remaining.length);
          clearConnectionError();
        } catch (error) {
          const message = (error as Error).message;
          const retryable = message.includes("无法连接") || message.includes("请求超时") || message.includes("服务暂时不可用");
          blocked = !retryable;
          setError(retryable ? "修改已保存在本机，联网后会自动同步。" : `有一项本地修改等待处理：${message}`);
          if (pendingRetry.current !== null) window.clearTimeout(pendingRetry.current);
          if (retryable) pendingRetry.current = window.setTimeout(() => {
            pendingRetry.current = null; flushPendingMutations();
          }, 5000);
          break;
        }
      }
      if (!loadMutations().length) scheduleRefresh();
    } finally {
      pendingFlush.current = false;
      if (!blocked && loadMutations().length && navigator.onLine && pendingRetry.current === null)
        window.setTimeout(() => flushPendingMutations(), 0);
    }
  }, [clearConnectionError, scheduleRefresh, setError]);
  useEffect(() => {
    if (logged && online) flushPendingMutations();
  }, [logged, online, flushPendingMutations]);
  useEffect(() => () => {
    if (pendingRetry.current !== null) window.clearTimeout(pendingRetry.current);
  }, []);
  function queueMutation(value: Omit<OfflineMutation, "id" | "createdAt">) {
    const mutation = enqueueMutation(value);
    mutationEpoch.current += 1;
    setState(current => {
      if (!current) return current;
      const next = applyMutation(current, mutation);
      storeLocalState(next);
      return next;
    });
    setPendingCount(loadMutations().length);
    setError("");
    void flushPendingMutations();
  }
  async function saveEntry(value: Entry, editing = false) {
    queueMutation({ type: editing ? "entry.update" : "entry.create", path: editing ? `/entries/${value.id}` : "/entries",
      method: editing ? "PUT" : "POST", body: value as unknown as Record<string, unknown> });
  }
  const entries =
    page === "entry" || page === "overview"
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
  const overviewMonth = today().slice(0, 7);
  const overviewFlow = useMemo(() => {
    let income = 0;
    let expense = 0;
    for (const entry of state?.entries || []) {
      if (entry.deleted || !entry.date.startsWith(overviewMonth)) continue;
      if (entry.kind === "income") income += entry.amount_cents;
      if (entry.kind === "expense") expense += entry.amount_cents;
      if (entry.kind === "refund") expense -= entry.amount_cents;
    }
    return { income, expense, net: income - expense };
  }, [state?.entries, overviewMonth]);
  const overviewAccounts = useMemo(() => (state?.account_groups || []).map(group => ({
    id: group.id,
    name: group.name,
    balance: (state?.accounts || [])
      .filter(account => (account.group_id || account.kind) === group.id)
      .reduce((sum, account) => sum + account.balance_cents, 0),
  })).filter(group => (state?.accounts || []).some(account => (account.group_id || account.kind) === group.id)), [state?.account_groups, state?.accounts]);
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
            <img src="/icon.png?v=paper-large" alt="" width={40} height={40} />
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
          {toast}
          <button aria-label={busy ? "正在登录…" : "打开我的账本"} title={busy ? "正在登录…" : "打开我的账本"} className="primary" disabled={busy}><LogIn size={18} aria-hidden="true" /></button>
          <small>网页版、Mac 与 Windows 客户端使用同一个账本密码。</small>
          <DesktopDownloads />
        </form>
      </div>
    );
  return (
    <div className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside aria-label="主导航">
        <button className="sidebar-toggle" type="button"
          aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          aria-expanded={!sidebarCollapsed} aria-controls="workspace-nav"
          onClick={() => setSidebarCollapsed(value => !value)}>
          {sidebarCollapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
        </button>
        <div className="brand">
          <img src="/icon.png?v=paper-large" alt="" width={40} height={40} />
          <b className="brand-name">明账</b><span>个人账本</span>
        </div>
        <div className="workspace">
          <div className="avatar">S</div>
          <div>
            {state?.demo ? "演示账本（虚构数据）" : "我的生活账本"}
            <small>CNY · 人民币</small>
          </div>
        </div>
        <p className="nav-label">工作空间</p>
        <nav id="workspace-nav">
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
              aria-label={String(label)}
              title={String(label)}
              aria-current={page === id ? "page" : undefined}
              className={page === id ? "active" : ""}
              onClick={() => {
                setPage(String(id));
                setDay("");
                setCategoryFilter("");
              }}
            >
              {page === id && <motion.span className="nav-selection" layoutId="main-navigation-active" transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }} />}
              {React.createElement(Icon as typeof Wallet, { size: 19 })}
              <span className="nav-text">{String(label)}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {desktopUpdate && desktopUpdate.status !== "idle" && (
            <button
              className="desktop-update"
              data-mingzhang-update-action="install"
              aria-label={desktopUpdate.status === "available" ? `更新到明账 ${desktopUpdate.release?.version}` : "正在更新明账"}
              title={desktopUpdate.status === "available" ? `有新版本 ${desktopUpdate.release?.version}，点击自动更新` : "正在下载并安装更新"}
              disabled={desktopUpdate.status !== "available"}
              onClick={() => window.mingzhangUpdate?.install().catch((error: Error) => setError(error.message))}
            >
              {desktopUpdate.status === "available" ? <CircleArrowUp size={19} aria-hidden="true" /> : <LoaderCircle className="spin" size={19} aria-hidden="true" />}
              <span className="nav-text">{desktopUpdate.status === "available" ? `更新到 ${desktopUpdate.release?.version}` : "正在更新…"}</span>
            </button>
          )}
          <div className={"sync " + (!online ? "offline" : "")} title={online ? `最近同步 ${lastSync}` : "当前离线"}>
            <i />
            <span className="nav-text">{online ? (pendingCount ? `${pendingCount} 项等待同步` : `最近同步 ${lastSync}`) : "当前离线，修改会先保存到本机"}</span>
          </div>
          <button aria-label="退出账本" title="退出账本"
            onClick={() => {
              api("/logout", {}).then(() => {
                setLogged(false);
                setState(null);
              });
            }}
          ><LogOut size={18} aria-hidden="true" /></button>
          <small>明账 v0.1 · 让每一笔都有来处</small>
        </div>
      </aside>
      <motion.main key={page} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.22 }} className={page === "entry" ? "entry-workspace" : undefined}>
        {(page !== "entry" || !state?.accounts.length) && <header>
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
                  overview: "先看资产与本月状态，再决定下一步关注什么。",
                  transactions: "每一笔收支，都有清楚的来龙去脉。",
                  reports: "从每一天，到每一年。",
                  accounts: "账户余额与借贷往来，一起看清。",
                  data: "你的数据，由你掌握。",
                  settings: "按你的习惯整理分类和账户。",
                }[page]
              }
            </p>
          </div>
        </header>}
        {toast}
        {page === "entry" && state && (
          <section className="entry-home">
            {state.accounts.length ? (
              <EntryDialog
                inline
                onRefresh={() => refresh().then(() => setNotice("已同步最新账本")).catch((e) => setError(e.message))}
                initial={newEntry(state.accounts[0].id)}
                editing={false}
                accounts={state.accounts}
                accountGroups={state.account_groups}
                entries={state.entries}
                categoryOrder={state.ordering?.categories}
                favorites={state.ordering?.favorites}
                catalog={state.category_catalog}
                onClose={() => {}}
                onSave={async (value) => {
                  await saveEntry(value);
                  setBookMonth(value.date.slice(0, 7));
                }}
              />
            ) : (
              <div className="entry-empty">
                <h2>从第一个账户开始</h2>
                <p>添加现金、银行卡或支付宝等账户，就可以记下第一笔收支。</p>
                <button aria-label="添加资金账户" title="添加资金账户" className="primary" onClick={() => setPage("accounts")}><Plus size={18} aria-hidden="true" /></button>
              </div>
            )}
          </section>
        )}
        {["transactions", "reports"].includes(page) && (
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
        {page === "overview" && state && (
          <>
            <section className="overview-balance">
              <div className="overview-net">
                <span>当前净资产</span>
                <strong><small>¥</small>{money(state.net_assets)}</strong>
                <p>总资产减去总负债，包含债权与待还款项。</p>
              </div>
              <div className="overview-balance-grid">
                <div><span>总资产</span><b className="income-text">¥ {money(state.assets)}</b></div>
                <div><span>总负债</span><b className="expense-text">¥ {money(state.liabilities)}</b></div>
                <div><span>待收</span><b>¥ {money(state.receivable)}</b></div>
                <div><span>待还</span><b>¥ {money(state.payable)}</b></div>
              </div>
            </section>
            <div className="overview-columns">
              <section className="panel overview-cashflow">
                <div className="panel-head">
                  <div><h2>本月现金流</h2><p>{Number(overviewMonth.slice(5))} 月截至今天</p></div>
                  <button className="text-button" aria-label="查看收支报表" title="查看收支报表" onClick={() => setPage("reports")}><ArrowUpRight size={18} /></button>
                </div>
                <div className="overview-flow-values">
                  <div><span>收入</span><b className="income-text">+{money(overviewFlow.income)}</b></div>
                  <div><span>支出</span><b className="expense-text">−{money(overviewFlow.expense)}</b></div>
                  <div><span>结余</span><b>{overviewFlow.net >= 0 ? "+" : "−"}{money(Math.abs(overviewFlow.net))}</b></div>
                </div>
                <div className="overview-flow-bar" aria-label="本月收入与支出比例">
                  <i style={{width: `${overviewFlow.income + overviewFlow.expense > 0 ? overviewFlow.income / (overviewFlow.income + overviewFlow.expense) * 100 : 50}%`}} />
                </div>
                <small>收入与支出对比 · 转账及借还款本金不计入收支</small>
              </section>
              <section className="panel overview-account-groups">
                <div className="panel-head">
                  <div><h2>账户分布</h2><p>{state.accounts.length} 个账户</p></div>
                  <button className="text-button" aria-label="查看资金账户" title="查看资金账户" onClick={() => setPage("accounts")}><ArrowUpRight size={18} /></button>
                </div>
                <div className="overview-account-list">
                  {overviewAccounts.map(group => (
                    <div key={group.id}>
                      <span><Wallet size={15} />{group.name}</span>
                      <b className={group.balance < 0 ? "expense-text" : undefined}>¥ {money(group.balance)}</b>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </>
        )}
        {page === "reports" && (
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
                note="收入 − 支出"
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
                        stroke="#d9d2c3"
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
                        hide={!visibleCurves.income}
                        type="monotone"
                        dataKey="income"
                        stroke="#4a5d4e"
                        strokeWidth={2.5}
                        dot={false}
                      />
                      <Line
                        name="支出"
                        hide={!visibleCurves.expense}
                        type="monotone"
                        dataKey="expense"
                        stroke="#a64036"
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
                            stopColor="#4a5d4e"
                            stopOpacity={0.22}
                          />
                          <stop
                            offset="100%"
                            stopColor="#4a5d4e"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid
                        vertical={false}
                        stroke="#d9d2c3"
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
                        hide={!visibleCurves.cumulative}
                        type="monotone"
                        dataKey="cumulative"
                        stroke="#4a5d4e"
                        fill="url(#balanceFill)"
                        strokeWidth={2.5}
                      />
                    </AreaChart>
                  )}
                </ResponsiveContainer>
              </div>
              <div className="chart-footer">
                <div className="chart-series-controls" role="group" aria-label="显示曲线">
                  <span>显示曲线</span>
                  {(curve === "daily" ? ["income", "expense"] as const : ["cumulative"] as const).map(key => (
                    <button type="button" key={key} aria-pressed={visibleCurves[key]}
                      className={visibleCurves[key] ? "selected" : ""}
                      title={`${visibleCurves[key] ? "隐藏" : "显示"}${key === "income" ? "收入" : key === "expense" ? "支出" : "累计结余"}曲线`}
                      onClick={() => setVisibleCurves(current => ({...current, [key]: !current[key]}))}>
                      <i className={key === "expense" ? "amber-dot" : "green-dot"}/>
                      {key === "income" ? "收入" : key === "expense" ? "支出" : "累计结余"}
                      {visibleCurves[key] ? <Check size={14}/> : <span className="curve-hidden-mark">—</span>}
                    </button>
                  ))}
                </div>
                {(curve === "daily" ? !visibleCurves.income && !visibleCurves.expense : !visibleCurves.cumulative) && <span className="chart-empty-hint" role="status">曲线已全部隐藏，点击项目重新显示</span>}
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
              await saveEntry(entry, true);
            }}
            onBulkSave={async entries => {
              for (const entry of entries) await saveEntry(entry, true);
            }}
            onEdit={(entry) => {
              setEditor({ ...entry });
              setEditing(true);
            }}
            onDelete={(entry) => {
              queueMutation({type:"entry.delete",path:`/entries/${entry.id}/delete`,method:"POST",body:{version:entry.version}});
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
                <button aria-label="查看全部" title="查看全部"
                  className="text-button"
                  onClick={() => setPage("transactions")}
                ><ArrowUpRight size={18} aria-hidden="true" /></button>
              ) : (
                <button aria-label={trash ? "返回正常流水" : "回收站"} title={trash ? "返回正常流水" : "回收站"}
                  className="text-button"
                  onClick={() => setTrash(!trash)}
                ><Trash2 size={18} aria-hidden="true" /></button>
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
                              <small>{x.kind === "collect" ? "←" : "→"} {accountName(x.to_account_id)}</small>
                            )}
                          </td>
                          <td
                            className={
                              "numeric " +
                              (["income", "refund"].includes(x.kind)
                                ? "income-text"
                                : x.kind === "expense" ? "book-out" : "")
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
                                <button aria-label="恢复交易" title="恢复交易"
                                  onClick={() =>
                                    queueMutation({type:"entry.restore",path:`/entries/${x.id}/restore`,method:"POST",body:{version:x.version}})
                                  }
                                ><RotateCcw size={18} aria-hidden="true" /></button>
                              ) : (
                                <>
                                  <button aria-label="编辑" title="编辑"
                                    onClick={() => {
                                      setEditor({ ...x });
                                      setEditing(true);
                                    }}
                                  ><PencilLine size={18} aria-hidden="true" /></button>
                                  <button
                                    aria-label="复制交易" title="复制交易"
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
                                    aria-label="删除交易" title="删除交易"
                                    onClick={() =>
                                      queueMutation({type:"entry.delete",path:`/entries/${x.id}/delete`,method:"POST",body:{version:x.version}})
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
                    <button aria-label={x.kind === "lend" ? "记录回款" : "记录还款"} title={x.kind === "lend" ? "记录回款" : "记录还款"}
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
                    ><ArrowLeftRight size={18} aria-hidden="true" /></button>
                  </div>
                ))}
            </section>
          </>
        )}
        {page === "settings" && state && <OrderSettings state={state} defaults={categories}
          onCategoryChange={async value => { queueMutation({type:"category.change",path:"/categories",method:"POST",body:value as unknown as Record<string,unknown>}); }}
          onPasswordChanged={() => { setLogged(false); setState(null); setPassword(""); setPage("entry"); setNotice("密码已修改，请使用新密码登录。"); }}
          onEditAccount={setAccountEditor}
          onRenameAccountGroup={async (id,name,expected_name) => {queueMutation({type:"account-group.rename",path:`/account-groups/${id}`,method:"PUT",body:{name,expected_name}});}}
          onAccountGroupChange={async (id, value) => {
            if (id) queueMutation({type:"account-group.delete",path:`/account-groups/${id}/delete`,method:"POST",body:{}});
            else { const group={...value!,id:crypto.randomUUID()}; queueMutation({type:"account-group.create",path:"/account-groups",method:"POST",body:group}); }
          }}
          onDeleteAccount={async account => { queueMutation({type:"account.delete",path:`/accounts/${account.id}/delete`,method:"POST",body:{version:account.version}}); }}
          onSave={async value => { queueMutation({type:"order.update",path:"/display-order",method:"PUT",body:value as unknown as Record<string,unknown>}); }} />}
        {page === "data" && state && (
          <DataPage
            state={state}
            onRefresh={refresh}
            onError={setError}
            onNotice={setNotice}
          />
        )}
        <footer>
          个人账本 · Asia/Shanghai <span>{pendingCount ? `${pendingCount} 项已存本机，等待同步` : "本机与云端已同步"}</span>
          <DesktopDownloads />
        </footer>
      </motion.main>
      {editor && state && (
        <EntryDialog
          key={editor.id}
          initial={editor}
          editing={editing}
          accounts={state.accounts}
          accountGroups={state.account_groups}
          entries={state.entries}
                categoryOrder={state.ordering?.categories}
                favorites={state.ordering?.favorites}
                catalog={state.category_catalog}
          onClose={() => setEditor(null)}
          onSave={async (value) => {
            await saveEntry(value, editing);
            setEditor(null);
          }}
        />
      )}
      {accountEditor && (
        <AccountDialog
          initial={accountEditor}
          groups={state?.account_groups ?? []}
          onClose={() => setAccountEditor(null)}
          onSave={async (value) => {
            const creating = !value.id;
            const account = creating ? {...value,id:crypto.randomUUID(),balance_cents:value.opening_cents} : {
              ...value,
              ...(value.target_balance_cents !== undefined && value.target_balance_cents !== value.expected_balance_cents
                ? {adjustment_id: crypto.randomUUID()} : {}),
            };
            queueMutation({type:creating?"account.create":"account.update",path:creating?"/accounts":`/accounts/${account.id}`,
              method:creating?"POST":"PUT",body:account as unknown as Record<string,unknown>});
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
        <button aria-label="开始记录" title="开始记录" className="text-button" onClick={action}><Plus size={18} aria-hidden="true" /></button>
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
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <motion.section
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
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
            aria-label="关闭窗口" title="关闭窗口"
            className="icon-button"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </motion.section>
    </motion.div>
  );
}
function EntryDialog({
  inline = false,
  onRefresh,
  initial,
  editing,
  accounts,
  accountGroups,
  categoryOrder = [],
  favorites = [],
  catalog,
  entries,
  onClose,
  onSave,
}: {
  inline?: boolean;
  onRefresh?: () => void;
  initial: Entry;
  editing: boolean;
  accounts: Account[];
  accountGroups: AccountGroup[];
  categoryOrder?: string[];
  favorites?: string[];
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
  const kindMotionId = useId();
  const selectedAccount = accounts.find(account => account.id === value.account_id);
  const amountRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Entry>(key: K, v: Entry[K]) =>
    setValue((old) => ({ ...old, [key]: v }));
  const legacySettlement = Boolean(value.reference_id && ["repay", "collect"].includes(value.kind) && !value.to_account_id);
  const refKind = value.kind === "refund" ? "expense" : undefined;
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
  const amountField = (
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
  );
  const form = (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        if (!value.account_id) {
          setError("请选择账户");
          return;
        }
        if ((value.kind === "transfer" || (["repay", "collect"].includes(value.kind) && !legacySettlement)) && !value.to_account_id) {
          setError(value.kind === "transfer" ? "请选择转入账户" : `请选择${value.kind === "repay" ? "负债" : "债权"}账户`);
          return;
        }
        if (value.kind === "transfer" && value.to_account_id === value.account_id) {
          setError("转入账户不能与转出账户相同");
          return;
        }
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
        {inline && <h1 className="entry-inline-title">记一笔</h1>}
        {Object.entries(labels).filter(([k]) => !["refund", "balance_in", "balance_out"].includes(k) || (editing && k === initial.kind)).map(([k, v]) => (
          <button
            type="button"
            className={value.kind === k ? "selected" : ""}
            key={k}
            onClick={() =>
              setValue({
                ...value,
                kind: k as Kind,
                account_id: ["repay", "collect"].includes(k) && ["receivable", "liability"].includes(selectedAccount?.kind || "")
                  ? accounts.find(a => !["receivable", "liability"].includes(a.kind))?.id || "" : value.account_id,
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
            {value.kind === k && <motion.span className="kind-selection" layoutId={`entry-kind-${kindMotionId}`} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} />}
            <span className="kind-label">{v}</span>
          </button>
        ))}
      </div>
      {!inline && amountField}
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
          <span className="entry-account-heading">
            <span>{value.kind === "transfer" ? "转出账户" : value.kind === "repay" ? "付款账户" : value.kind === "collect" ? "收款账户" : "账户"}</span>
            {selectedAccount && <span className="entry-account-balance" role="status" aria-live="polite"
              title={`${selectedAccount.name}当前余额`}>
              余额 <motion.strong key={`${selectedAccount.id}-${selectedAccount.balance_cents}`} initial={{ opacity: 0.35 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }} className={selectedAccount.balance_cents < 0 ? "negative-balance" : undefined}>
                ¥{money(selectedAccount.balance_cents)}
              </motion.strong>
            </span>}
          </span>
          <AccountSelect
            accounts={accounts.filter(a => !["repay", "collect"].includes(value.kind) || !["receivable", "liability"].includes(a.kind))}
            groups={accountGroups}
            value={value.account_id}
            onChange={(e) => set("account_id", e.target.value)}
          />
        </label>
        {value.kind === "transfer" && (
          <label className="full">
            转入账户
            <AccountSelect
              accounts={accounts.filter((a) => a.id !== value.account_id)}
              groups={accountGroups}
              required
              value={value.to_account_id || ""}
              onChange={(e) => set("to_account_id", e.target.value)}
              placeholder="请选择转入账户"
            />
            <small>信用卡还本金也使用账户间转账。</small>
          </label>
        )}
        {["repay", "collect"].includes(value.kind) && !legacySettlement && (
          <label className="full">
            {value.kind === "repay" ? "负债账户" : "债权账户"}
            <AccountSelect required aria-label={value.kind === "repay" ? "负债账户" : "债权账户"}
              accounts={accounts.filter(a => a.kind === (value.kind === "repay" ? "liability" : "receivable") && a.id !== value.account_id)}
              groups={accountGroups}
              value={value.to_account_id || ""} onChange={e => set("to_account_id", e.target.value)}
              placeholder={`请选择${value.kind === "repay" ? "负债" : "债权"}账户`} />
            <small>{value.kind === "repay" ? "付款账户余额减少，同时减少对应负债。" : "收款账户余额增加，同时减少对应债权。"}本金不计入收支。</small>
          </label>
        )}
        {legacySettlement && <small>此历史记录保留原借款关联，避免重复调整余额。</small>}
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
      {inline && amountField}
      {inline && ["income", "expense"].includes(value.kind) && favorites.some(p => categoryOptions.includes(p)) && (
        <div className="favorite-shortcuts" role="group" aria-label="常用分类">
          <span className="favorite-caption">常用分类</span>
          {favorites.filter(p => categoryOptions.includes(p)).slice(0, 9).map(path => (
            <button type="button" key={path} title={path} aria-pressed={value.category === path}
              className={value.category === path ? "selected" : ""}
              onClick={() => {set("category", path); amountRef.current?.focus();}}>
              {path.includes("/") ? categoryLeaf(path) : path}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <small>
          {inline ? "Enter 保存 · 连续记账" : "保存失败时，输入内容会保留。"}
        </small>
        {inline && <button type="button" className="icon-button" aria-label="刷新账本" title="刷新账本" onClick={onRefresh}><RefreshCw size={18} /></button>}
        <button aria-label={busy ? "正在保存…" : "记一笔"} title={busy ? "正在保存…" : "记一笔"} className="primary" disabled={busy}>{busy ? "正在保存…" : "记一笔"}</button>
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
  groups,
  onClose,
  onSave,
}: {
  initial: Account;
  groups: import("./types").AccountGroup[];
  onClose: () => void;
  onSave: (value: Account) => Promise<void>;
}) {
  const [value, setValue] = useState(() => {
    if (initial.id) return initial;
    const group = groups.find(g => g.id === initial.group_id) ?? groups.find(g => g.kind === initial.kind) ?? groups[0];
    return group ? {...initial,group_id:group.id,kind:group.kind} : initial;
  }),
    [amount, setAmount] = useState(String((initial.id ? initial.balance_cents : initial.opening_cents) / 100)),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title={initial.id ? "编辑账户" : "添加账户"} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!groups.length) return;
          setBusy(true);
          try {
            await onSave(initial.id
              ? { ...value, target_balance_cents: cents(amount), expected_balance_cents: initial.balance_cents }
              : { ...value, opening_cents: cents(amount) });
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
            value={value.group_id || value.kind}
            onChange={(e) => {const group=groups.find(g=>g.id===e.target.value);if(group)setValue({ ...value, group_id:group.id, kind:group.kind });}}
          >
            {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
          </StyledSelect>
        </label>
        <label>
          {initial.id ? "当前余额（元）" : "初始余额（元）"}
          <input
            required
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <small>
            填写账户实际余额，信用卡欠款填负数。修改后自动记录差额，不计入收入或支出。
          </small>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!groups.length && <p role="alert" className="error">请先在设置的账户管理中添加账户类型。</p>}
        <div className="modal-footer">
          <small>余额调整不计入收支，按回车保存。</small>
          <button aria-label="保存账户" title="保存账户" className="primary" disabled={busy || !groups.length}><Check size={18} aria-hidden="true" /></button>
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
          <button aria-label={busy ? "正在处理…" : "读取文件"} title={busy ? "正在处理…" : "读取文件"}
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
          ><FileUp size={18} aria-hidden="true" /></button>
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
            <button aria-label="生成导入预览" title="生成导入预览"
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
            ><ScanEye size={18} aria-hidden="true" /></button>
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
            <button aria-label={`确认导入 ${selected.length} 笔`} title={`确认导入 ${selected.length} 笔`}
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
            ><Import size={18} aria-hidden="true" /></button>
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
                        <button aria-label="撤销此批次" title="撤销此批次"
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            action(async () => {
                              await api(`/imports/${x.id}/rollback`, {});
                              await onRefresh();
                              onNotice("该批次已撤销；已创建的账户保留。");
                            })
                          }
                        ><Undo2 size={18} aria-hidden="true" /></button>
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
  <MotionConfig reducedMotion="user">
    <ControlTheme><App /></ControlTheme>
  </MotionConfig>,
);
