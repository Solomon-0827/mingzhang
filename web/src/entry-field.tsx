import { Check, PencilLine, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useState } from "react";
import { Popover } from "antd";
import { Entry, Kind, State, cents, labels, money, today, ordered } from "./types";
import { AccountSelect, StyledDate, StyledSelect, CategorySelect } from "./controls";
import { categoriesForKind, defaultCategoryForKind } from "./category-groups";

type Field =
  | "date"
  | "category"
  | "amount_cents"
  | "account_id"
  | "to_account_id"
  | "kind"
  | "counterparty";
const fieldLabels: Record<Field, string> = {
  date: "日期",
  category: "分类",
  amount_cents: "金额",
  account_id: "账户",
  to_account_id: "转入账户",
  kind: "类型",
  counterparty: "往来对象",
};
export function EntryField({
  entry,
  field,
  state,
  children,
  onSave,
  onEdit,
}: {
  entry: Entry;
  field: Field;
  state: State;
  children: React.ReactNode;
  onSave: (entry: Entry) => Promise<void>;
  onEdit: (entry: Entry) => void;
}) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState(entry),
    [amount, setAmount] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const autoSave = ["date", "category", "account_id", "to_account_id", "kind"].includes(field);
  async function save(next: Entry) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onSave({
        ...next,
        amount_cents: field === "amount_cents" ? cents(amount) : next.amount_cents,
      });
      setOpen(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function ready(next: Entry) {
    if (next.kind === "transfer") return Boolean(next.to_account_id && next.to_account_id !== next.account_id);
    if (next.kind === "refund") return Boolean(next.reference_id);
    if (["repay", "collect"].includes(next.kind)) return Boolean(next.reference_id || next.to_account_id);
    if (["lend", "borrow"].includes(next.kind)) return Boolean(next.counterparty.trim());
    if (["balance_in", "balance_out"].includes(next.kind)) return true;
    return Boolean(next.category);
  }
  function selectField(key: "date" | "category" | "account_id" | "to_account_id", value: string) {
    if (busy) return;
    const next = { ...draft, [key]: value };
    setDraft(next);
    if (value && (field === key || (field === "kind" && ready(next)))) void save(next);
  }
  const set = <K extends keyof Entry>(key: K, value: Entry[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const refKind = draft.kind === "refund" ? "expense" : undefined;
  const categoryOptions = ordered(state.category_catalog ? categoriesForKind(state.category_catalog, draft.kind) : Array.from(
    new Set([
      ...(draft.kind === "income"
        ? ["收入/工资", "收入/其他"]
        : [
            "日常/餐饮",
            "日常/购物",
            "日常/交通",
            "居住/房租",
            "居住/水电",
            "生活/娱乐",
            "生活/旅行",
            "健康/医疗",
            "学习/书籍",
          ]),
      ...state.entries
        .filter((item) => !item.deleted && item.kind === draft.kind)
        .map((item) => item.category),
      draft.category,
      "未分类",
    ]),
  ).filter(Boolean), state.ordering?.categories);
  const chooseCategory = (
    <CategorySelect options={categoryOptions} aria-label="修改分类" value={draft.category} disabled={busy}
      onChange={e => selectField("category", e.target.value)} />
  );
  const chooseAccount = (target: "account_id" | "to_account_id") => (
    <AccountSelect
      aria-label={target === "account_id" ? "修改账户" : draft.kind === "repay" ? "修改负债账户" : draft.kind === "collect" ? "修改债权账户" : "修改转入账户"}
      accounts={state.accounts.filter(
        (account) =>
          target === "account_id"
            ? !["repay", "collect"].includes(draft.kind) || !["receivable", "liability"].includes(account.kind)
            : account.id !== draft.account_id && (draft.kind === "repay" ? account.kind === "liability" : draft.kind === "collect" ? account.kind === "receivable" : true),
      )}
      groups={state.account_groups}
      value={draft[target] || ""}
      disabled={busy}
      onChange={(e) => selectField(target, e.target.value)}
      placeholder={target === "account_id" ? "请选择账户" : draft.kind === "repay" ? "请选择负债账户" : draft.kind === "collect" ? "请选择债权账户" : "请选择转入账户"}
    />
  );
  return (
    <span
      className="entry-field"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {open &&
        createPortal(
          <div
            className="field-editor-backdrop"
            aria-label="关闭字段编辑"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!busy) setOpen(false);
            }}
          />,
          document.body,
        )}
      <Popover
        destroyOnHidden
        zIndex={1200}
        trigger="click"
        open={open}
        onOpenChange={(next) => {
          if (busy) return;
          if (next) {
            setDraft({ ...entry });
            setAmount(String(entry.amount_cents / 100));
            setError("");
          }
          setOpen(next);
        }}
        title={`修改${fieldLabels[field]}`}
        getPopupContainer={(trigger) => trigger.parentElement!}
        content={
          <form
            className="field-editor"
            onSubmit={async (event) => {
              event.preventDefault();
              await save(draft);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy) {
                event.preventDefault();
                setOpen(false);
              }
            }}
          >
            {field === "date" && (
              <StyledDate
                aria-label="修改日期"
                type="date"
                value={draft.date}
                max={today()}
                disabled={busy}
                open={open && !busy}
                onOpenChange={(next) => {
                  if (!next && !busy) setOpen(false);
                }}
                onChange={(event) => selectField("date", event.target.value)}
              />
            )}
            {field === "amount_cents" && (
              <input
                autoFocus
                aria-label="修改金额"
                required
                inputMode="decimal"
                enterKeyHint="done"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!busy) event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
            )}
            {field === "category" &&
              (refKind ? (
                <p>分类跟随关联的原交易，请在完整编辑中调整关联交易。</p>
              ) : (
                chooseCategory
              ))}
            {(field === "account_id" || field === "to_account_id") &&
              chooseAccount(field)}
            {field === "counterparty" && (
              <input
                autoFocus
                aria-label="修改往来对象"
                required
                value={draft.counterparty}
                onChange={(e) => set("counterparty", e.target.value)}
              />
            )}
            {field === "kind" && (
              <>
                <StyledSelect
                  aria-label="修改类型"
                  value={draft.kind}
                  disabled={busy}
                  onChange={(e) => {
                    const kind = e.target.value as Kind;
                    if (kind === draft.kind) return;
                    const next = {
                      ...draft,
                      kind,
                      account_id: ["repay", "collect"].includes(kind) && ["receivable", "liability"].includes(state.accounts.find(a => a.id === draft.account_id)?.kind || "")
                        ? state.accounts.find(a => !["receivable", "liability"].includes(a.kind))?.id || "" : draft.account_id,
                      to_account_id: null,
                      reference_id: null,
                      category: defaultCategoryForKind(state.category_catalog, kind, state.ordering?.categories),
                    };
                    setDraft(next);
                    if (ready(next)) void save(next);
                  }}
                >
                  {Object.entries(labels).filter(([kind]) => !["refund", "balance_in", "balance_out"].includes(kind) || kind === entry.kind).map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))}
                </StyledSelect>
                {["income", "expense"].includes(draft.kind) && (
                  <label>分类{chooseCategory}</label>
                )}
                {["transfer", "repay", "collect"].includes(draft.kind) && (
                  <label>{draft.kind === "repay" ? "负债账户" : draft.kind === "collect" ? "债权账户" : "转入账户"}{chooseAccount("to_account_id")}</label>
                )}
                {["lend", "borrow"].includes(draft.kind) && (
                  <label>
                    往来对象
                    <input
                      required
                      value={draft.counterparty}
                      onChange={(e) => set("counterparty", e.target.value)}
                    />
                  </label>
                )}
                {refKind && (
                  <label>
                    关联原交易
                    <StyledSelect
                      aria-label="修改关联原交易"
                      value={draft.reference_id || ""}
                      disabled={busy}
                      onChange={(e) => {
                        const next = { ...draft, reference_id: e.target.value };
                        setDraft(next);
                        if (ready(next)) void save(next);
                      }}
                    >
                      <option value="">请选择原交易</option>
                      {state.entries
                        .filter(
                          (item) =>
                            !item.deleted &&
                            item.id !== entry.id &&
                            item.kind === refKind &&
                            (item.remaining_cents > 0 ||
                              item.id === entry.reference_id),
                        )
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.date} · {item.counterparty || item.category} ·{" "}
                            {money(item.amount_cents)}
                          </option>
                        ))}
                    </StyledSelect>
                  </label>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="field-editor-actions">
              <button aria-label="完整编辑" title="完整编辑"
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  onEdit(entry);
                }}
              ><PencilLine size={18} aria-hidden="true" /></button>
              <button aria-label="取消" title="取消"
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
              ><X size={18} aria-hidden="true" /></button>
              {(!autoSave || Boolean(error) || (field === "kind" && ["lend", "borrow"].includes(draft.kind))) && !(field === "category" && refKind) && (
                <button aria-label={busy ? "保存中…" : "保存"} title={busy ? "保存中…" : "保存"} className="primary" disabled={busy}><Check size={18} aria-hidden="true" /></button>
              )}
            </div>
          </form>
        }
      >
        <button
          type="button"
          className="entry-field-trigger"
          aria-label={`修改${fieldLabels[field]}：${typeof children === "string" ? children : fieldLabels[field]}`}
        >
          {children}
        </button>
      </Popover>
    </span>
  );
}
