from dataclasses import dataclass
from enum import StrEnum


@dataclass(frozen=True)
class EntryRule:
    label: str
    category_required: bool = False
    counterparty_required: bool = False
    target: str | None = None
    reference: str | None = None


ENTRY_KINDS = {
    "income": EntryRule("收入", category_required=True),
    "expense": EntryRule("支出", category_required=True),
    "transfer": EntryRule("转账", target="any"),
    "refund": EntryRule("退款", reference="expense"),
    "lend": EntryRule("借出", counterparty_required=True),
    "borrow": EntryRule("借入", counterparty_required=True),
    "repay": EntryRule("还款", target="liability", reference="borrow"),
    "collect": EntryRule("回款", target="receivable", reference="lend"),
    "balance_in": EntryRule("余额调增"),
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
