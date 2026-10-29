export type Kind =
  | "income"
  | "expense"
  | "transfer"
  | "refund"
  | "lend"
  | "borrow"
  | "repay"
  | "collect"
  | "balance_in"
  | "balance_out";
export type Account = {
  id: string;
  name: string;
  kind: string;
  opening_cents: number;
  target_balance_cents?: number;
  expected_balance_cents?: number;
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
export type DisplayOrder = { accounts: string[]; categories: string[]; favorites?: string[]; version: number };
export function ordered(values: string[], order: string[] = []) {
  const ranks = new Map(order.map((v, i) => [v, i]));
  return [...values].sort((a, b) => (ranks.get(a) ?? order.length) - (ranks.get(b) ?? order.length));
}
export type CategoryCatalog = { items: Record<string, string[]>; hidden: string[]; version: number };
export type CategoryChange = { action: "add" | "rename" | "delete" | "restore"; level: "parent" | "child"; path: string; name?: string; kind?: string; version: number };
export type State = {
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
export const labels: Record<Kind, string> = {
  income: "收入",
  expense: "支出",
  transfer: "转账",
  refund: "退款",
  lend: "借出",
  borrow: "借入",
  repay: "还款",
  collect: "回款",
  balance_in: "余额调增",
  balance_out: "余额调减",
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
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    signal: AbortSignal.timeout(45000),
    headers:
      body instanceof FormData ? {} : { "Content-Type": "application/json" },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  }).catch((error: Error) => {
    throw new Error(
      error.name === "TimeoutError" || error.name === "AbortError"
        ? "请求超时，请检查网络后重试；输入内容已保留。"
        : "无法连接账本服务，请检查网络后重试。",
    );
  });
  if (!response.ok) {
    const value = await response
      .json()
      .catch(() => ({ detail: "服务暂时不可用" }));
    throw new Error(
      response.status === 401
        ? "请重新登录"
        : typeof value.detail === "string"
          ? value.detail
          : "请检查必填项、金额和日期",
    );
  }
  return response.json();
}
