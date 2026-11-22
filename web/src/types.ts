import type { Kind } from "./entry-kinds";
export type Account = {
  id: string;
  name: string;
  kind: string;
  group_id?: string | null;
  opening_cents: number;
  target_balance_cents?: number;
  expected_balance_cents?: number;
  adjustment_id?: string;
  balance_cents: number;
  version: number;
};
export type Entry = {
  id: string;
  date: string;
  kind: Kind;
  amount_cents: number;
  account_id: string;
  to_account_id: string | null;
  category: string;
  merchant: string;
  memo: string;
  counterparty: string;
  reference_id: string | null;
  version: number;
  deleted: number;
  remaining_cents: number;
};
export type DisplayOrder = { account_groups?: string[]; accounts: string[]; categories: string[]; favorites?: string[]; version: number };
export function ordered(values: string[], order: string[] = []) {
  const ranks = new Map(order.map((v, i) => [v, i]));
  return [...values].sort((a, b) => (ranks.get(a) ?? order.length) - (ranks.get(b) ?? order.length));
}
export function orderedAccountOptions(state: Pick<State, "accounts" | "account_groups" | "ordering">) {
  const accounts = new Map(state.accounts.map(account => [account.id, account]));
  const accountGroups = new Map(state.account_groups.map(group => [group.id, group]));
  const groups = ordered([...accountGroups.keys()], state.ordering?.account_groups).map(id => accountGroups.get(id)!);
  const accountOrder = ordered([...accounts.keys()], state.ordering?.accounts).map(id => accounts.get(id)!);
  const groupedAccounts = groups.flatMap(group => accountOrder.filter(account => (account.group_id || account.kind) === group.id));
  const groupedIds = new Set(groupedAccounts.map(account => account.id));
  return {
    accounts: [...groupedAccounts, ...accountOrder.filter(account => !groupedIds.has(account.id))],
    accountGroups: groups,
  };
}
export type CategoryCatalog = { items: Record<string, string[]>; hidden: string[]; retired?: string[]; removed_kinds?: Record<string, string[]>; version: number };
export type CategoryChange = { action: "add" | "rename" | "delete" | "restore"; level: "parent" | "child"; path: string; name?: string; kind?: string; version: number };
export type AccountGroup = { id: string; name: string; kind: string; deleted?: number };
export type State = {
  account_groups: AccountGroup[];
  category_catalog?: CategoryCatalog;
  ordering?: DisplayOrder;
  demo: boolean;
  accounts: Account[];
  entries: Entry[];
  assets: number;
  liabilities: number;
  net_assets: number;
  receivable: number;
  payable: number;
  imports: { id: string; name: string; status: string; created_at: string }[];
  backup_date: string | null;
  server_time: string;
};
export type Report = {
  income: number;
  expense: number;
  net: number;
  daily: {
    date: string;
    income: number;
    expense: number;
    cumulative: number;
  }[];
  months: { month: string; income: number; expense: number }[];
  categories: [string, number][];
};
export const accountLabels: Record<string, string> = {
  bank: "银行卡",
  wallet: "电子钱包",
  cash: "现金",
  credit: "信用卡",
  receivable: "债权",
  liability: "负债",
};
export const money = (n: number) =>
  (n / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export function cents(value: string) {
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) throw new Error("金额最多两位小数");
  const negative = value.startsWith("-");
  const [a, b = ""] = value.replace("-", "").split(".");
  const n = Number(a) * 100 + Number(b.padEnd(2, "0"));
  if (!Number.isSafeInteger(n)) throw new Error("金额超出范围");
  return negative ? -n : n;
}
export type RequestFailure = "network" | "timeout" | "unavailable" | "unauthorized" | "rejected" | "cancelled";

export class RequestError extends Error {
  constructor(readonly kind: RequestFailure, message: string, readonly status?: number, readonly retryAfterMs?: number,
    readonly ledgerEpoch?: string) {
    super(message);
    this.name = "RequestError";
  }
}

function retryAfter(header: string | null) {
  if (!header?.trim()) return undefined;
  const value = header.trim();
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 :
    /[a-z]{3}/i.test(value) ? Date.parse(value) - Date.now() : NaN;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

export function isUnauthorized(error: unknown) {
  return error instanceof RequestError && error.kind === "unauthorized";
}

function connectionFailure(error: unknown) {
  return error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
    ? new RequestError("timeout", "请求超时，请检查网络后重试；输入内容已保留。")
    : new RequestError("network", "无法连接账本服务，请检查网络后重试。");
}

export const requestDeadlineMs = 45_000;

export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  mutationId?: string,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    signal: AbortSignal.timeout(requestDeadlineMs),
    headers: {
      ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(mutationId ? { "X-Mingzhang-Mutation": mutationId } : {}),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  }).catch((error: unknown) => { throw connectionFailure(error); });
  if (!response.ok) {
    if (response.status === 401)
      throw new RequestError("unauthorized", "请重新登录", response.status);
    const failure = await response.json().catch(() => undefined);
    const detail = failure?.detail;
    const status = response.status;
    const epoch = typeof failure?.ledger_epoch === "string" ? failure.ledger_epoch : undefined;
    if (status === 409 && failure?.code === "mutation_cancelled")
      throw new RequestError("cancelled", "这条修改已被放弃", status, undefined, epoch);
    if (status === 408 || status === 429)
      throw new RequestError(status === 408 ? "timeout" : "unavailable",
        typeof detail === "string" ? detail : "服务暂时不可用", status, retryAfter(response.headers.get("Retry-After")));
    if (status < 400 || status >= 500)
      throw new RequestError("unavailable", typeof detail === "string" ? detail : "服务暂时不可用", status);
    const message = typeof detail === "string" ? detail
      : Array.isArray(detail) ? detail.map(item => [Array.isArray(item?.loc) ? item.loc.slice(1).join(".") : "", item?.msg]
        .filter(Boolean).join("：")).filter(Boolean).join("；")
      : "请检查必填项、金额和日期";
    throw new RequestError("rejected", message || "请检查必填项、金额和日期", status, undefined, epoch);
  }
  return response.json().catch((error: unknown) => { throw connectionFailure(error); });
}
