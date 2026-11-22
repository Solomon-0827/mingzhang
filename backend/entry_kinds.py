from dataclasses import dataclass
from enum import StrEnum


@dataclass(frozen=True)
class EntryRule:
    label: str
    category_required: bool = False
    counterparty_required: bool = False
    target: str | None = None
    reference: str | None = None
    inflow: bool = False
    target_sign: int = 0
    income: bool = False
    expense_sign: int = 0


ENTRY_KINDS = {
    "income": EntryRule("收入", category_required=True, inflow=True, income=True),
    "expense": EntryRule("支出", category_required=True, expense_sign=1),
    "transfer": EntryRule("转账", target="any", target_sign=1),
    "refund": EntryRule("退款", reference="expense", inflow=True, expense_sign=-1),
    "lend": EntryRule("借出", counterparty_required=True),
    "borrow": EntryRule("借入", counterparty_required=True, inflow=True),
    "repay": EntryRule("还款", target="liability", reference="borrow", target_sign=1),
    "collect": EntryRule("回款", target="receivable", reference="lend", inflow=True, target_sign=-1),
    "balance_in": EntryRule("余额调增", inflow=True),
    "balance_out": EntryRule("余额调减"),
}

EntryKind = StrEnum("EntryKind", {kind: kind for kind in ENTRY_KINDS})
CATEGORY_KINDS = tuple(kind for kind, rule in ENTRY_KINDS.items() if rule.category_required)
CategoryKind = StrEnum("CategoryKind", {kind: kind for kind in CATEGORY_KINDS})
CATEGORY_KIND_MARKS = ",".join("?" for _ in CATEGORY_KINDS)
IMPORT_KINDS = {
    key: kind
    for kind, rule in ENTRY_KINDS.items()
    if rule.category_required or rule.target == "any"
    for key in (rule.label, kind)
}
