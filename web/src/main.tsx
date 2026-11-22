import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, BookOpen, ChartNoAxesCombined, Check, CircleAlert, ChevronLeft, ChevronRight, CircleArrowUp, Copy, Database, Download, FileUp, Import, LayoutDashboard, LoaderCircle, LogIn, LogOut, PanelLeftClose, PanelLeftOpen, PencilLine, Plus, RefreshCw, RotateCcw, ScanEye, Search, Settings, Trash2, Undo2, Wallet, X } from "lucide-react";
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
  Entry,
  Report,
  State,
  accountLabels,
  api,
  cents,
  isUnauthorized,
  money,
  today,
} from "./types";
import { AccountSelect, ControlTheme, StyledDate, StyledSelect, CategorySelect } from "./controls";
import { categoryLeaf } from "./category-groups";
import { allKindOptions, categoryOptions, changeEntryKind, defaultCategories, entryAccounts, entryError,
  entryRoles, initializeEntryDraft, kindLabel, kindOptions, referenceOptions } from "./entry-kinds";
import { balanceTotal, emptyReport, entryMovement, outstandingEntries, periodTotals, projectReport } from "./ledger-projection";
import { BookList, AccountWorkspace } from "./ledger-views";
import "./style.css";
import "./paper-theme.css";
import { OrderSettings } from "./order-settings";
import type { OfflineMutation } from "./offline-mutations";
import { createSyncQueue, type BlockedMutation, type LedgerEpoch, type QueueAction, type ReceiptStatus, type SyncSnapshot } from "./sync-queue";
import { isQueueStorageKey, queueSignalKey } from "./mutation-store";
import { BlockedSyncDetails, EntryRecoveryComparison, describeBlocked, entryRecoveryChange, prepareEntryRecovery, rebaseChange, recoverySettings } from "./blocked-sync";

const queueChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("mingzhang.mutations") : null;
const syncQueue = createSyncQueue({
  storage: localStorage,
  database: window.indexedDB,
  locks: navigator.locks,
  send: item => api<LedgerEpoch>(item.path, item.body, item.method, item.id),
  fetchSnapshot: mutation_ids => api<SyncSnapshot>("/sync-state", { mutation_ids }),
  fetchReceipt: id => api<ReceiptStatus>(`/mutation-receipts/${encodeURIComponent(id)}`),
  cancelMutation: (id, ledger_epoch) => api<ReceiptStatus>(`/mutation-receipts/${encodeURIComponent(id)}/cancel`, { ledger_epoch }),
  onStoredChange: snapshot => {
    try {
      if (queueChannel) queueChannel.postMessage(snapshot ?? null);
      else localStorage.setItem(queueSignalKey, crypto.randomUUID());
    } catch { /* Other tabs also read the queue on focus and refresh. */ }
  },
});

type DesktopUpdateState = {
  status: "idle" | "available" | "downloading" | "installing";
  currentVersion: string;
  release?: { version: string };
  error?: string;
};
type NavigationSnapshot = {
  page: string;
  period: string;
  anchor: string;
  customStart: string;
  customEnd: string;
  bookMonth: string;
  curve: string;
  visibleCurves: { income: boolean; expense: boolean; cumulative: boolean };
  query: string;
  type: string;
  accountFilter: string;
  categoryFilter: string;
  day: string;
  trash: boolean;
  scrollY: number;
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

const newEntry = (account = ""): Entry => ({
  id: crypto.randomUUID(),
  date: today(),
  kind: "expense",
  amount_cents: 0,
  account_id: account,
  to_account_id: null,
  category: defaultCategories[0],
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
    [editorMode, setEditorMode] = useState<"new" | "copy" | "edit">("new"),
    [accountEditor, setAccountEditor] = useState<Account | null>(null);
  const [lastSync, setLastSync] = useState(""),
    [online, setOnline] = useState(navigator.onLine);
  const [queueView, setQueueView] = useState(syncQueue.view);
  const { count: pendingCount, blocked, snapshot: serverSnapshot, storageError, statusUnsaved, memoryCount, fallback, headSending } = queueView;
  const [showBlocked, setShowBlocked] = useState(false);
  const [blockedEditor, setBlockedEditor] = useState<{ target: BlockedMutation } & ReturnType<typeof prepareEntryRecovery> | null>(null);
  const loginEpoch = useRef(0);
  const [settingsRecovery, setSettingsRecovery] = useState<{ id: string; section: "accounts" | "categories" } | null>(null);
  const latestSettings = settingsRecovery?.id === blocked?.id ? settingsRecovery : null;
  useEffect(() => { if (!pendingCount) setShowBlocked(false); }, [pendingCount]);
  useEffect(() => {
    if (!memoryCount) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [memoryCount]);
  const backgroundRefresh = useRef<number | null>(null);
  const pendingFlush = useRef(0);
  const pendingRetry = useRef<number | null>(null);
  const retryDelay = useRef(5000);
  const backHistory = useRef<NavigationSnapshot[]>([]);
  const forwardHistory = useRef<NavigationSnapshot[]>([]);
  const pendingScrollRestore = useRef<number | null>(null);
  const [, setHistoryRevision] = useState(0);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateState | null>(null);
  const captureNavigation = useCallback((): NavigationSnapshot => ({
    page, period, anchor, customStart, customEnd, bookMonth, curve, visibleCurves,
    query, type, accountFilter, categoryFilter, day, trash, scrollY: window.scrollY,
  }), [page, period, anchor, customStart, customEnd, bookMonth, curve, visibleCurves, query, type, accountFilter, categoryFilter, day, trash]);
  const restoreNavigation = useCallback((snapshot: NavigationSnapshot) => {
    setPage(snapshot.page); setPeriod(snapshot.period); setAnchor(snapshot.anchor);
    setCustomStart(snapshot.customStart); setCustomEnd(snapshot.customEnd); setBookMonth(snapshot.bookMonth);
    setCurve(snapshot.curve); setVisibleCurves(snapshot.visibleCurves); setQuery(snapshot.query);
    setType(snapshot.type); setAccountFilter(snapshot.accountFilter); setCategoryFilter(snapshot.categoryFilter);
    setDay(snapshot.day); setTrash(snapshot.trash);
    pendingScrollRestore.current = snapshot.scrollY;
    const restore = () => window.scrollTo({top:snapshot.scrollY,behavior:"auto"});
    window.requestAnimationFrame(() => { restore(); window.setTimeout(restore, 80); window.setTimeout(restore, 280); });
    window.setTimeout(() => { if (pendingScrollRestore.current === snapshot.scrollY) pendingScrollRestore.current = null; }, 5000);
  }, []);
  const navigate = useCallback((nextPage: string, changes: Partial<NavigationSnapshot> = {}) => {
    const current = captureNavigation();
    const unchanged = Object.entries(changes).every(([key, value]) =>
      JSON.stringify(current[key as keyof NavigationSnapshot]) === JSON.stringify(value));
    if (nextPage === current.page && unchanged) return;
    backHistory.current = [...backHistory.current.slice(-19), current];
    forwardHistory.current = [];
    restoreNavigation({...current, ...changes, page:nextPage, scrollY:changes.scrollY ?? 0});
    setHistoryRevision(value => value + 1);
  }, [captureNavigation, restoreNavigation]);
  const travelHistory = useCallback((direction: "back" | "forward") => {
    const source = direction === "back" ? backHistory : forwardHistory;
    const destination = direction === "back" ? forwardHistory : backHistory;
    const target = source.current.at(-1);
    if (!target) return;
    source.current = source.current.slice(0, -1);
    destination.current = [...destination.current.slice(-19), captureNavigation()];
    restoreNavigation(target);
    setHistoryRevision(value => value + 1);
  }, [captureNavigation, restoreNavigation]);
  const resetHistory = useCallback(() => {
    backHistory.current = [];
    forwardHistory.current = [];
    setHistoryRevision(value => value + 1);
  }, []);
  useEffect(() => {
    const historyKey = (event: KeyboardEvent) => {
      const back = event.altKey && event.key === "ArrowLeft" || event.metaKey && event.key === "[";
      const forward = event.altKey && event.key === "ArrowRight" || event.metaKey && event.key === "]";
      if (!back && !forward) return;
      event.preventDefault();
      travelHistory(back ? "back" : "forward");
    };
    window.addEventListener("keydown", historyKey);
    return () => window.removeEventListener("keydown", historyKey);
  }, [travelHistory]);
  useEffect(() => {
    const cancelRestore = () => { pendingScrollRestore.current = null; };
    window.addEventListener("wheel", cancelRestore, {passive:true});
    window.addEventListener("touchmove", cancelRestore, {passive:true});
    return () => {
      window.removeEventListener("wheel", cancelRestore);
      window.removeEventListener("touchmove", cancelRestore);
    };
  }, []);
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
  useEffect(() => {
    if (pendingScrollRestore.current === null) return;
    const top = pendingScrollRestore.current;
    window.requestAnimationFrame(() => window.scrollTo({top,behavior:"auto"}));
  }, [page, report]);
  const readQueue = useCallback(() => {
    const view = syncQueue.view();
    setQueueView(view);
    setState(view.state);
  }, []);
  useEffect(() => syncQueue.subscribe(readQueue), [readQueue]);
  const closeSession = useCallback(() => {
    loginEpoch.current += 1;
    setBlockedEditor(null);
    setShowBlocked(false);
    setSettingsRecovery(null);
    setAccountEditor(null);
    setLogged(false);
    setState(null);
  }, []);
  const requireLogin = useCallback(() => {
    closeSession();
    setError("请重新登录");
  }, [closeSession, setError]);
  const refresh = useCallback(async () => {
    const epoch = loginEpoch.current;
    try {
      const snapshot = await syncQueue.refresh();
      if (epoch === loginEpoch.current) {
        clearConnectionError();
        setLogged(true);
        setLastSync(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
      }
      return snapshot;
    } catch (error) {
      if (isUnauthorized(error) && epoch === loginEpoch.current) requireLogin();
      throw error;
    }
  }, [requireLogin, clearConnectionError]);
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
        if (isUnauthorized(e)) {
          setError("");
          return;
        }
        if (syncQueue.view().state) {
          readQueue();
          setLogged(true);
          setError("当前使用本机账本，恢复联网后会自动同步。");
        } else {
          setError(e.message);
        }
      })
      .finally(() => setChecked(true));
  }, [refresh, readQueue, setError]);
  useEffect(() => {
    if (!logged) return;
    const timer = setInterval(() => refresh().catch((e) => setError(e.message)), 30000);
    const focus = () => refresh().catch((e) => setError(e.message));
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [logged, refresh, setError]);
  useEffect(() => {
    const load = (snapshot?: SyncSnapshot) => syncQueue.load(snapshot).catch(error => setError(error.message));
    const storage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && isQueueStorageKey(event.key)) void load();
    };
    const receive = (event: MessageEvent<SyncSnapshot | null>) => { void load(event.data ?? undefined); };
    const focus = () => { void load(); };
    window.addEventListener("focus", focus);
    window.addEventListener("storage", storage);
    queueChannel?.addEventListener("message", receive);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("storage", storage);
      queueChannel?.removeEventListener("message", receive);
    };
  }, [setError]);
  useEffect(() => {
    const reconnect = () => {
      readQueue();
      setOnline(true);
      refresh().catch(e => setError(e.message));
    };
    const disconnect = () => setOnline(false);
    window.addEventListener("online", reconnect);
    window.addEventListener("offline", disconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", disconnect);
    };
  }, [readQueue, refresh, setError]);
  useEffect(() => {
    const updater = window.mingzhangUpdate;
    if (!updater) return;
    const receive = (value: DesktopUpdateState) => setDesktopUpdate(value);
    const unsubscribe = updater.onState(receive);
    updater.getState().then(receive).then(() => updater.check()).then(receive).catch(() => undefined);
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (!logged || !["overview", "reports"].includes(page)) return;
    if (state && (pendingCount || !online)) {
      try {
        setReport(projectReport(state.entries, range[0], range[1]));
      } catch (error) {
        setReport(emptyReport);
        // Only the reports page lets the user pick the range, so only it reports an invalid one.
        if (page === "reports") setError((error as Error).message);
      }
      return;
    }
    let current = true;
    const epoch = loginEpoch.current;
    api<Report>(`/report?start=${range[0]}&end=${range[1]}`)
      .then(value => {
        if (current && epoch === loginEpoch.current) setReport(value);
      })
      .catch(error => {
        if (!current || epoch !== loginEpoch.current) return;
        if (isUnauthorized(error)) requireLogin();
        else setError(error.message);
      });
    return () => { current = false; };
  }, [logged, range, state, page, pendingCount, online, setError, requireLogin]);
  const openNew = useCallback(() => {
    if (!state?.accounts.length) {
      navigate("accounts");
      setNotice("先添加一个资金账户，再开始记账。");
      return;
    }
    if (page === "entry") {
      document.getElementById("home-amount")?.focus();
      return;
    }
    setEditor(newEntry(state.accounts[0].id));
    setEditorMode("new");
  }, [state, page, navigate, setNotice]);
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
  const cancelPendingRetry = useCallback(() => {
    if (pendingRetry.current !== null) window.clearTimeout(pendingRetry.current);
    pendingRetry.current = null;
  }, []);
  const flushPendingMutations = useCallback(async function flush(action?: QueueAction) {
    if (!action && (!logged || !navigator.onLine || pendingFlush.current || pendingRetry.current !== null)) return;
    if (action) cancelPendingRetry();
    pendingFlush.current += 1;
    const epoch = loginEpoch.current;
    let checkTail = false;
    try {
      const result = await syncQueue.flush(action, () => navigator.onLine && epoch === loginEpoch.current);
      if (epoch !== loginEpoch.current) return;
      checkTail = result === "idle" || result === "synced" || result === "changed" ||
        result === "already-synced" || result === "discarded-elsewhere" || result === "cancelled";
      if (result === "in-flight") throw new Error("这条修改正在同步，请等本次同步结束。");
      if (result === "no-snapshot") throw new Error("联网后才能放弃这条修改");
      if (result === "receipt-unavailable") throw new Error("暂时无法核对同步状态，请刷新后重试。");
      if (result === "already-synced") setNotice("这条修改已同步到服务器。");
      if (result === "discarded-elsewhere") setNotice("这条修改已在其他窗口放弃。");
      if (result === "changed" && action) throw new Error("这条修改已在其他窗口处理，请查看当前待处理内容。");
      if (result === "retryable" || typeof result === "object") {
        const needsManualRetry = Boolean(syncQueue.blocked());
        const wait = typeof result === "object" ? result : null;
        if (wait?.wait !== "sending")
          setError(needsManualRetry ? "暂时无法同步，修改仍在本机，请稍后重试。" : "暂时无法同步，稍后会自动重试。");
        if (!needsManualRetry || (!action && wait?.wait === "sending")) {
          cancelPendingRetry();
          const delay = wait ? Math.max(0, wait.until - Date.now()) : retryDelay.current;
          pendingRetry.current = window.setTimeout(() => {
            pendingRetry.current = null;
            if (epoch === loginEpoch.current) void flush().catch(e => setError(e.message));
          }, Math.min(delay, 2_147_483_647));
          if (!wait) retryDelay.current = Math.min(retryDelay.current * 2, 60000);
        }
      } else {
        retryDelay.current = 5000;
        if (result === "unauthorized") requireLogin();
        if (result === "synced" || result === "discarded-elsewhere" || action?.kind === "discard") scheduleRefresh();
        if (result === "synced") clearConnectionError();
      }
    } finally {
      pendingFlush.current -= 1;
      if (checkTail && navigator.onLine && syncQueue.hasReadyHead())
        void flush().catch(e => setError(e.message));
    }
  }, [logged, cancelPendingRetry, requireLogin, clearConnectionError, scheduleRefresh, setError, setNotice]);
  useEffect(() => {
    if (!logged || !online) return;
    cancelPendingRetry();
    void flushPendingMutations().catch(e => setError(e.message));
  }, [logged, online, cancelPendingRetry, flushPendingMutations, setError]);
  useEffect(() => {
    if (!logged || !online || !pendingCount || !syncQueue.hasReadyHead()) return;
    if (blocked && !headSending) cancelPendingRetry();
    void flushPendingMutations().catch(e => setError(e.message));
  }, [logged, online, blocked?.id, headSending, pendingCount, cancelPendingRetry, flushPendingMutations, setError]);
  useEffect(() => {
    if (!logged) cancelPendingRetry();
    return cancelPendingRetry;
  }, [logged, cancelPendingRetry]);

  async function queueMutation(value: Omit<OfflineMutation, "id" | "createdAt">) {
    await syncQueue.enqueue(value);
    setError("");
    void flushPendingMutations().catch(e => setError(e.message));
  }
  async function queueMutations(values: Omit<OfflineMutation, "id" | "createdAt">[]) {
    await syncQueue.enqueueMany(values);
    setError("");
    void flushPendingMutations().catch(e => setError(e.message));
  }
  async function saveEntry(value: Entry, editing = false) {
    await queueMutation({ type: editing ? "entry.update" : "entry.create", path: editing ? `/entries/${value.id}` : "/entries",
      method: editing ? "PUT" : "POST", body: value as unknown as Record<string, unknown> });
  }
  async function openBlockedEditor(target: BlockedMutation) {
    const epoch = loginEpoch.current;
    const snapshot = await refresh();
    if (epoch === loginEpoch.current)
      setBlockedEditor({ target, ...prepareEntryRecovery(target, snapshot, newEntry()) });
  }
  async function rebaseBlocked(target: BlockedMutation) {
    const epoch = loginEpoch.current;
    const snapshot = await refresh();
    if (epoch === loginEpoch.current)
      await flushPendingMutations({ kind: "edit", target, change: rebaseChange(target, snapshot) });
  }
  async function openLatestSettings(target: BlockedMutation) {
    const section = recoverySettings(target);
    if (!section) return;
    const epoch = loginEpoch.current;
    const snapshot = await refresh();
    if (epoch !== loginEpoch.current || syncQueue.blocked()?.id !== target.id) return;
    setSettingsRecovery({ id: target.id, section });
    setShowBlocked(false);
    navigate("settings");
    if (target.type === "account.update") {
      const account = snapshot.accounts.find(value => value.id === target.path.split("/")[2]);
      if (account) setAccountEditor(account);
    }
  }
  async function retryQueueStorage() {
    try {
      await syncQueue.retryStorage();
      await flushPendingMutations();
    } catch (error) {
      setError((error as Error).message);
    }
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
  const overviewFlow = useMemo(() => periodTotals((state?.entries ?? []).filter(entry =>
    entry.date.startsWith(overviewMonth))), [state?.entries, overviewMonth]);
  const overviewAccounts = useMemo(() => (state?.account_groups || []).map(group => ({
    id: group.id,
    name: group.name,
    balance: balanceTotal((state?.accounts ?? []).filter(account => (account.group_id || account.kind) === group.id)),
  })).filter(group => (state?.accounts || []).some(account => (account.group_id || account.kind) === group.id)), [state?.account_groups, state?.accounts]);
  const queueNotice = blocked ? "有 1 项修改未能同步，点此处理" : `${pendingCount} 项等待同步，点此查看`;
  const queueHead = blocked ?? queueView.items[0];
  const storageNotice = (storageError || fallback) && <div className="queue-storage-notice" role={storageError ? "alert" : undefined}>
    {storageError && <>
      {memoryCount > 0 && <span>{memoryCount} 项修改只保留在此页面，请勿关闭或刷新。</span>}
      {statusUnsaved && <span>本机空间不足，同步状态暂时只保留在此页面。</span>}
      <button type="button" className="secondary" onClick={() => void retryQueueStorage()}>重试本机保存</button>
    </>}
    {fallback && <span>本机使用兼容存储，多窗口同步保护有限。</span>}
  </div>;
  const queuePanel = showBlocked && pendingCount > 0 && !blockedEditor && (
    <Modal title={blocked ? "处理未同步的修改" : "等待同步的修改"} onClose={() => setShowBlocked(false)}>
      <BlockedSyncDetails key={queueHead.id} item={queueHead} state={serverSnapshot} waiting={pendingCount - 1}
        onRetry={() => flushPendingMutations({ kind: "retry", target: queueHead })}
        onEdit={blocked ? () => openBlockedEditor(blocked) : undefined}
        onRebase={blocked ? () => rebaseBlocked(blocked) : undefined}
        onOpenSettings={blocked ? () => openLatestSettings(blocked) : undefined}
        onDiscard={confirm => flushPendingMutations({ kind: "discard", target: queueHead, confirm })} />
      {!blocked && pendingCount > 1 && <ol>{queueView.items.slice(1).map(item =>
        <li key={item.id}>{describeBlocked(item, null).title}</li>)}</ol>}
    </Modal>
  );
  if (!checked && !pendingCount)
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
              loginEpoch.current += 1;
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
          {pendingCount > 0 && <button type="button" className="secondary sync-blocked" onClick={() => setShowBlocked(true)}>{queueNotice}</button>}
          <DesktopDownloads />
        </form>
        {storageNotice}
        {queuePanel}
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
        <div className="sidebar-history" aria-label="页面历史">
          <button type="button" aria-label="返回上一个页面" title="返回上一个页面"
            disabled={!backHistory.current.length} onClick={() => travelHistory("back")}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button type="button" aria-label="前进到下一个页面" title="前进到下一个页面"
            disabled={!forwardHistory.current.length} onClick={() => travelHistory("forward")}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <span className="nav-text">页面历史</span>
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
                navigate(String(id), {day:"",categoryFilter:""});
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
          {pendingCount > 0 ? (
            <button type="button" className="sync-blocked" aria-label={queueNotice}
              title={queueNotice} onClick={() => setShowBlocked(true)}>
              <CircleAlert size={18} aria-hidden="true" />
              <span className="nav-text">{queueNotice}</span>
              <span className="sync-blocked-short" aria-hidden="true">{blocked ? "待处理" : "待同步"}</span>
            </button>
          ) : (
            <div className={"sync " + (!online ? "offline" : "")} title={online ? `最近同步 ${lastSync}` : "当前离线"}>
              <i />
              <span className="nav-text">{online ? `最近同步 ${lastSync}` : "当前离线，修改会先保存到本机"}</span>
            </div>
          )}
          <button aria-label="退出账本" title="退出账本"
            onClick={() => {
              api("/logout", {}).then(() => {
                resetHistory();
                closeSession();
              });
            }}
          ><LogOut size={18} aria-hidden="true" /></button>
          <small>明账 v0.1 · 让每一笔都有来处</small>
        </div>
      </aside>
      {pendingCount > 0 && <button type="button" className="sync-blocked-mobile" onClick={() => setShowBlocked(true)}>
        {queueNotice}
      </button>}
      {storageNotice}
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
                <button aria-label="添加资金账户" title="添加资金账户" className="primary" onClick={() => navigate("accounts")}><Plus size={18} aria-hidden="true" /></button>
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
                  <button className="text-button" aria-label="查看收支报表" title="查看收支报表" onClick={() => navigate("reports")}><ArrowUpRight size={18} /></button>
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
                  <button className="text-button" aria-label="查看资金账户" title="查看资金账户" onClick={() => navigate("accounts")}><ArrowUpRight size={18} /></button>
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
                          navigate("transactions", {day:String(label),categoryFilter:""});
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
                          navigate("transactions", {day:String(s.activeLabel),categoryFilter:""});
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
                        navigate("transactions", {categoryFilter:name,day:""});
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
                            navigate("transactions", {period:"month",anchor:m.month,day:"",categoryFilter:""});
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
              await queueMutations(entries.map(entry => ({
                type: "entry.update" as const,
                path: `/entries/${entry.id}`,
                method: "PUT" as const,
                body: entry as unknown as Record<string, unknown>,
              })));
            }}
            onEdit={(entry) => {
              setEditor({ ...entry });
              setEditorMode("edit");
            }}
            onDelete={(entry) => {
              void queueMutation({type:"entry.delete",path:`/entries/${entry.id}/delete`,method:"POST",body:{version:entry.version}}).catch(e => setError(e.message));
            }}
          />
        )}
        {(page === "overview" || page === "transactions") && (
          <section className="panel">
            <div className="panel-head">
              <h2>
                {page !== "transactions" ? "最近记录" : "交易明细"}{" "}
                <span className="count">{entries.length}</span>
              </h2>
              {page !== "transactions" ? (
                <button aria-label="查看全部" title="查看全部"
                  className="text-button"
                  onClick={() => navigate("transactions", {day:"",categoryFilter:""})}
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
                  {allKindOptions.map(([k, v]) => (
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
                      .slice(0, page === "overview" ? 6 : 500)
                      .map((x) => {
                        const movement = entryMovement(x.kind);
                        return (
                          <tr key={x.id}>
                            <td className="muted">
                              {x.date.slice(5)}
                              <small>{x.date.slice(0, 4)}</small>
                            </td>
                            <td>
                              <div className="transaction-title">
                                <span className={"transaction-icon " + x.kind}>
                                  {movement.direction === "in" ? (
                                    <ArrowDownLeft size={17} />
                                  ) : movement.direction === "transfer" ? (
                                    <ArrowLeftRight size={17} />
                                  ) : (
                                    <ArrowUpRight size={17} />
                                  )}
                                </span>
                                <div>
                                  <strong>{x.category || kindLabel(x.kind)}</strong>
                                  <small>
                                    {kindLabel(x.kind)}
                                    {x.merchant ? " · " + x.merchant : ""}
                                    {x.counterparty ? " · " + x.counterparty : ""}
                                  </small>
                                </div>
                              </div>
                            </td>
                            <td>
                              {accountName(x.account_id)}
                              {x.to_account_id && (
                                <small>{movement.targetSign < 0 ? "←" : "→"} {accountName(x.to_account_id)}</small>
                              )}
                            </td>
                            <td className={`numeric ${movement.tone}`}>
                              {movement.sign}
                              {money(x.amount_cents)}
                            </td>
                            <td>
                              <div className="row-actions">
                                {page === "transactions" && trash ? (
                                  <button aria-label="恢复交易" title="恢复交易"
                                    onClick={() =>
                                      void queueMutation({type:"entry.restore",path:`/entries/${x.id}/restore`,method:"POST",body:{version:x.version}}).catch(e => setError(e.message))
                                    }
                                  ><RotateCcw size={18} aria-hidden="true" /></button>
                                ) : (
                                  <>
                                    <button aria-label="编辑" title="编辑"
                                      onClick={() => {
                                        setEditor({ ...x });
                                        setEditorMode("edit");
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
                                        setEditorMode("copy");
                                      }}
                                    >
                                      <Copy size={14} />
                                    </button>
                                    <button
                                      aria-label="删除交易" title="删除交易"
                                      onClick={() =>
                                        void queueMutation({type:"entry.delete",path:`/entries/${x.id}/delete`,method:"POST",body:{version:x.version}}).catch(e => setError(e.message))
                                      }
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
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
                text={trash ? "回收站是空的" : "这段时间还没有匹配的流水"}
                action={trash ? undefined : openNew}
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
              {outstandingEntries(state.entries)
                .map((x) => (
                  <div className="loan-row" key={x.id}>
                    <div>
                      <strong>{x.counterparty}</strong>
                      <small>
                        {x.date} · {kindLabel(x.kind)} ¥ {money(x.amount_cents)}
                      </small>
                    </div>
                    <span>
                      {x.remaining_cents < 0 ? "多" : "待"}{x.kind === "lend" ? "收" : "还"} ¥{" "}
                      {money(Math.abs(x.remaining_cents))}
                    </span>
                    {x.remaining_cents > 0 && <button aria-label={x.kind === "lend" ? "记录回款" : "记录还款"} title={x.kind === "lend" ? "记录回款" : "记录还款"}
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
                        setEditorMode("new");
                      }}
                    ><ArrowLeftRight size={18} aria-hidden="true" /></button>}
                  </div>
                ))}
            </section>
          </>
        )}
        {page === "settings" && state && <OrderSettings
          key={latestSettings?.id ?? "settings"} initialSection={latestSettings?.section}
          state={(latestSettings && serverSnapshot) || state} defaults={defaultCategories}
          onCategoryChange={async value => { await queueMutation({type:"category.change",path:"/categories",method:"POST",body:value as unknown as Record<string,unknown>}); }}
          onPasswordChanged={() => { resetHistory(); closeSession(); setPassword(""); setPage("entry"); setNotice("密码已修改，请使用新密码登录。"); }}
          onEditAccount={setAccountEditor}
          onRenameAccountGroup={async (id,name,expected_name) => {await queueMutation({type:"account-group.rename",path:`/account-groups/${id}`,method:"PUT",body:{name,expected_name}});}}
          onAccountGroupChange={async (id, value) => {
            if (id) await queueMutation({type:"account-group.delete",path:`/account-groups/${id}/delete`,method:"POST",body:{}});
            else { const group={...value!,id:crypto.randomUUID()}; await queueMutation({type:"account-group.create",path:"/account-groups",method:"POST",body:group}); }
          }}
          onDeleteAccount={async account => { await queueMutation({type:"account.delete",path:`/accounts/${account.id}/delete`,method:"POST",body:{version:account.version}}); }}
          onSave={async value => { await queueMutation({type:"order.update",path:"/display-order",method:"PUT",body:value as unknown as Record<string,unknown>}); }} />}
        {page === "data" && state && (
          <DataPage
            state={state}
            onRefresh={async () => { await refresh(); }}
            onError={setError}
            onNotice={setNotice}
          />
        )}
        <footer>
          个人账本 · Asia/Shanghai <span>{storageError ? "有修改等待保存到本机" : blocked ? "有修改未能同步" : pendingCount ? `${pendingCount} 项已存本机，等待同步` : "本机与云端已同步"}</span>
          <DesktopDownloads />
        </footer>
      </motion.main>
      {queuePanel}
      {blockedEditor && state && (
        <EntryDialog
          key={blockedEditor.target.id}
          initial={blockedEditor.entry}
          editing={Boolean(blockedEditor.current)}
          recoveryQueued={blockedEditor.current ? blockedEditor.queued : undefined}
          recovering
          validationState={serverSnapshot ?? undefined}
          accounts={state.accounts}
          accountGroups={state.account_groups}
          entries={state.entries}
          categoryOrder={state.ordering?.categories}
          favorites={state.ordering?.favorites}
          catalog={state.category_catalog}
          onClose={() => setBlockedEditor(null)}
          onSave={async value => {
            const change = entryRecoveryChange(blockedEditor.entry, Boolean(blockedEditor.current), value);
            await flushPendingMutations({ kind: "edit", target: blockedEditor.target, change });
            setBlockedEditor(null);
          }}
        />
      )}
      {editor && state && (
        <EntryDialog
          key={editor.id}
          initial={editor}
          editing={editorMode === "edit"}
          copying={editorMode === "copy"}
          accounts={state.accounts}
          accountGroups={state.account_groups}
          entries={state.entries}
                categoryOrder={state.ordering?.categories}
                favorites={state.ordering?.favorites}
                catalog={state.category_catalog}
          onClose={() => setEditor(null)}
          onSave={async (value) => {
            await saveEntry(value, editorMode === "edit");
            setEditor(null);
          }}
        />
      )}
      {accountEditor && (
        <AccountDialog
          initial={accountEditor}
          groups={((latestSettings && serverSnapshot) || state)?.account_groups ?? []}
          onClose={() => setAccountEditor(null)}
          onSave={async (value) => {
            const creating = !value.id;
            const account = creating ? {...value,id:crypto.randomUUID(),balance_cents:value.opening_cents} : {
              ...value,
              ...(value.target_balance_cents !== undefined && value.target_balance_cents !== value.expected_balance_cents
                ? {adjustment_id: crypto.randomUUID()} : {}),
            };
            await queueMutation({type:creating?"account.create":"account.update",path:creating?"/accounts":`/accounts/${account.id}`,
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
  recovering = false,
  copying = false,
  recoveryQueued,
  validationState,
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
  recovering?: boolean;
  copying?: boolean;
  recoveryQueued?: Entry;
  validationState?: State;
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
  const context = { accounts, entries, category_catalog: catalog, ordering: { categories: categoryOrder } };
  const newDraft = !editing && !recovering && !copying;
  const [value, setValue] = useState(() => initializeEntryDraft(initial, context,
    copying ? "copy" : newDraft ? "new" : "edit")),
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
  const roles = entryRoles(value);
  const options = categoryOptions(context, value);
  useEffect(() => {
    if (!editing && !recovering && catalog && roles.category && !options.includes(value.category)) {
      setValue(old => ({ ...old, category: options[0] ?? "" }));
    }
  }, [catalog, value.kind, value.category, editing, recovering]);
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
  let recoveryAmount = value.amount_cents;
  if (recoveryQueued) {
    try { recoveryAmount = cents(amount); }
    catch { /* The form reports an invalid amount on submit. */ }
  }
  const saveLabel = recovering ? "保存并重新同步" : "记一笔";
  const form = (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setBusy(true);
        try {
          const current = validationState ?? context;
          const draft = copying ? initializeEntryDraft(value, current, "copy") : value;
          const next = { ...draft, amount_cents: cents(amount) };
          const error = entryError(next, current);
          if (error) throw new Error(error);
          await onSave(next);
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
        {kindOptions(newDraft ? undefined : initial.kind).map(([k, v]) => (
          <button
            type="button"
            className={value.kind === k ? "selected" : ""}
            key={k}
            onClick={() => setValue(changeEntryKind(value, k, context))}
          >
            {value.kind === k && <motion.span className="kind-selection" layoutId={`entry-kind-${kindMotionId}`} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} />}
            <span className="kind-label">{v}</span>
          </button>
        ))}
      </div>
      {!inline && amountField}
        {roles.category && (
          <label className="entry-category">
            分类
            <CategorySelect options={options} value={value.category}
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
            <span>{roles.account}</span>
            {selectedAccount && <span className="entry-account-balance" role="status" aria-live="polite"
              title={`${selectedAccount.name}当前余额`}>
              余额 <motion.strong key={`${selectedAccount.id}-${selectedAccount.balance_cents}`} initial={{ opacity: 0.35 }} animate={{ opacity: 1 }} transition={{ duration: 0.35 }} className={selectedAccount.balance_cents < 0 ? "negative-balance" : undefined}>
                ¥{money(selectedAccount.balance_cents)}
              </motion.strong>
            </span>}
          </span>
          <AccountSelect
            aria-label={roles.account}
            accounts={entryAccounts(value, accounts, "account_id")}
            groups={accountGroups}
            value={value.account_id}
            onChange={(e) => set("account_id", e.target.value)}
          />
        </label>
        {roles.target && (
          <label className="full">
            {roles.target.label}
            <AccountSelect required aria-label={roles.target.label}
              accounts={entryAccounts(value, accounts, "to_account_id")}
              groups={accountGroups}
              value={value.to_account_id || ""} onChange={e => set("to_account_id", e.target.value)}
              placeholder={`请选择${roles.target.label}`} />
            <small>{roles.target.hint}</small>
          </label>
        )}
        {roles.legacySettlement && <small>此历史记录保留原借款关联，避免重复调整余额。</small>}
        {roles.reference && (
          <label className="full">
            关联原交易
            <StyledSelect
              required
              value={value.reference_id || ""}
              onChange={(e) => set("reference_id", e.target.value)}
            >
              <option value="">选择原始{kindLabel(roles.reference)}记录</option>
              {referenceOptions({ ...value, reference_id: initial.reference_id }, entries)
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
        {roles.counterparty && (
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
      {inline && roles.category && favorites.some(p => options.includes(p)) && (
        <div className="favorite-shortcuts" role="group" aria-label="常用分类">
          <span className="favorite-caption">常用分类</span>
          {favorites.filter(p => options.includes(p)).slice(0, 9).map(path => (
            <button type="button" key={path} title={path} aria-pressed={value.category === path}
              className={value.category === path ? "selected" : ""}
              onClick={() => {set("category", path); amountRef.current?.focus();}}>
              {path.includes("/") ? categoryLeaf(path) : path}
            </button>
          ))}
        </div>
      )}
      {recovering && <label>备注<input value={value.memo} onChange={event => set("memo", event.target.value)} /></label>}
      {recovering && <label>商家<input value={value.merchant} onChange={event => set("merchant", event.target.value)} /></label>}
      {recoveryQueued && <EntryRecoveryComparison current={initial} queued={recoveryQueued}
        value={{ ...value, amount_cents: recoveryAmount }}
        accounts={accounts} entries={entries} onChoose={(key, source) => {
          if (key === "amount_cents") setAmount(String(source.amount_cents / 100));
          else set(key, source[key]);
        }} />}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <small>
          {recovering && editing ? "保存后将用当前填写的内容更新服务器上的这笔流水。"
            : inline ? "Enter 保存 · 连续记账" : "保存失败时，输入内容会保留。"}
        </small>
        {inline && <button type="button" className="icon-button" aria-label="刷新账本" title="刷新账本" onClick={onRefresh}><RefreshCw size={18} /></button>}
        <button aria-label={busy ? "正在保存…" : saveLabel} title={busy ? "正在保存…" : saveLabel} className="primary" disabled={busy}>{busy ? "正在保存…" : saveLabel}</button>
      </div>
    </form>
  );
  return inline ? (
    form
  ) : (
    <Modal title={recovering ? "修改后重新同步" : editing ? "编辑交易" : "记一笔"} onClose={onClose}>
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
