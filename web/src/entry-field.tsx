import { Check, PencilLine, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useState } from "react";
import { Popover } from "antd";
import { Entry, State, cents, money, today } from "./types";
import { AccountSelect, StyledDate, StyledSelect, CategorySelect } from "./controls";
import { categoryOptions, changeEntryKind, entryAccountOptions, entryError, entryRoles, kindOptions,
  referenceOptions, type Kind } from "./entry-kinds";

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
      const value = { ...next, amount_cents: field === "amount_cents" ? cents(amount) : next.amount_cents };
      const reason = entryError(value, state);
      if (reason) throw new Error(reason);
      await onSave(value);
      setOpen(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function selectField(key: "date" | "category" | "account_id" | "to_account_id", value: string) {
    if (busy) return;
    const next = { ...draft, [key]: value };
    setDraft(next);
    if (value && (field === key || (field === "kind" && !entryError(next, state)))) void save(next);
  }
  const set = <K extends keyof Entry>(key: K, value: Entry[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const roles = entryRoles(draft);
  const accountLabel = (target: "account_id" | "to_account_id") =>
    target === "account_id" ? roles.account : roles.target?.label ?? fieldLabels.to_account_id;
  const fieldLabel = field === "account_id" || field === "to_account_id" ? accountLabel(field) : fieldLabels[field];
  const chooseCategory = (
    <CategorySelect options={categoryOptions(state, draft, "field")} aria-label="修改分类" value={draft.category} disabled={busy}
      onChange={e => selectField("category", e.target.value)} />
  );
  const chooseAccount = (target: "account_id" | "to_account_id") => {
    if (!open) return null;
    const { accounts, accountGroups } = entryAccountOptions(state, draft, target);
    return <AccountSelect
      aria-label={`修改${accountLabel(target)}`}
      accounts={accounts}
      groups={accountGroups}
      value={draft[target] || ""}
      disabled={busy}
      onChange={(e) => selectField(target, e.target.value)}
      placeholder={`请选择${accountLabel(target)}`}
    />;
  };
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
        title={`修改${fieldLabel}`}
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
              (roles.reference ? (
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
                    const next = changeEntryKind(draft, kind, state);
                    setDraft(next);
                    if (!entryError(next, state)) void save(next);
                  }}
                >
                  {kindOptions(entry.kind).map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))}
                </StyledSelect>
                {roles.category && (
                  <label>分类{chooseCategory}</label>
                )}
                {roles.target && (
                  <label>{roles.target.label}{chooseAccount("to_account_id")}</label>
                )}
                {roles.counterparty && (
                  <label>
                    往来对象
                    <input
                      required
                      value={draft.counterparty}
                      onChange={(e) => set("counterparty", e.target.value)}
                    />
                  </label>
                )}
                {roles.reference && (
                  <label>
                    关联原交易
                    <StyledSelect
                      aria-label="修改关联原交易"
                      value={draft.reference_id || ""}
                      disabled={busy}
                      onChange={(e) => {
                        const next = { ...draft, reference_id: e.target.value };
                        setDraft(next);
                        if (!entryError(next, state)) void save(next);
                      }}
                    >
                      <option value="">请选择原交易</option>
                      {referenceOptions({ ...draft, reference_id: entry.reference_id }, state.entries)
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
              {(!autoSave || Boolean(error) || (field === "kind" && draft.kind !== entry.kind)) && !(field === "category" && roles.reference) && (
                <button aria-label={busy ? "保存中…" : "保存"} title={busy ? "保存中…" : "保存"} className="primary" disabled={busy}><Check size={18} aria-hidden="true" /></button>
              )}
            </div>
          </form>
        }
      >
        <button
          type="button"
          className="entry-field-trigger"
          aria-label={`修改${fieldLabel}：${typeof children === "string" ? children : fieldLabel}`}
        >
          {children}
        </button>
      </Popover>
    </span>
  );
}
