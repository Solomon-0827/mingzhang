"""Lossless migration of Sui's six-sheet legacy XLS export, without fuzzy deduplication."""
import hashlib
import json
from decimal import Decimal
from uuid import NAMESPACE_URL, uuid5

import xlrd

from backend.db import advance_ledger_revision
from backend.ledger import Account, Entry, audit, save_entry

SHEETS = {"收入", "支出", "转账", "余额变更", "负债变更", "债权变更"}


def parse_sui(content):
    book = xlrd.open_workbook(file_contents=content)
    records = []
    for sheet in book.sheets():
        if not sheet.nrows:
            continue
        if sheet.name not in SHEETS:
            raise ValueError(f"不支持的工作表：{sheet.name}，未导入任何数据")
        headers = sheet.row_values(0)
        for index in range(1, sheet.nrows):
            raw = dict(zip(headers, sheet.row_values(index), strict=True))
            if not any(str(v).strip() for v in raw.values()):
                continue
            records.append(normalize(sheet.name, index + 1, raw))
    if not records:
        raise ValueError("文件中没有账目")
    return records


def normalize(sheet, row, raw):
    amount = Decimal(str(raw["金额"])) * 100
    if not amount.is_finite() or amount != amount.to_integral_value() or amount == 0:
        raise ValueError(f"{sheet} 第 {row} 行金额无效")
    signed = int(amount)
    if sheet in {"收入", "支出", "转账"} and signed < 0:
        raise ValueError(f"{sheet} 第 {row} 行出现负金额，需要人工核对")
    account_key = {"收入": "收入账户", "支出": "支出账户", "转账": "转出账户"}.get(sheet, "账户1")
    account = str(raw[account_key]).strip()
    target = str(raw.get("转入账户", "")).strip()
    if not account or (sheet == "转账" and (not target or account == target)):
        raise ValueError(f"{sheet} 第 {row} 行账户无效")
    kind = {"收入": "income", "支出": "expense", "转账": "transfer"}.get(sheet)
    if kind is None:
        signed *= -1 if sheet == "负债变更" else 1
        kind = "balance_in" if signed > 0 else "balance_out"
    category = "/".join(str(raw.get(k, "")).strip() for k in ["一级分类", "二级分类"] if raw.get(k))
    details = [str(raw.get("备注", "")).strip(), f"随手记：{sheet} 第{row}行；时间 {raw['日期']}"]
    details += [f"{k}：{raw[k]}" for k in ["成员", "项目"] if raw.get(k)]
    return dict(sheet=sheet, row=row, raw=raw, account=account, target=target, entry=dict(
        date=str(raw["日期"]).split(" ")[0], kind=kind, amount_cents=abs(signed),
        category=category or ("未分类" if kind in {"income", "expense"} else sheet),
        merchant=str(raw.get("商家", "")), memo="；".join(filter(None, details)),
    ))


def import_sui(db, content, name, account_kinds=None, calibrations=None):
    digest = hashlib.sha256(content).hexdigest()
    batch_id = str(uuid5(NAMESPACE_URL, "sui-xls:" + digest))
    if db.execute("SELECT 1 FROM imports WHERE id=?", (batch_id,)).fetchone():
        raise ValueError("该文件已导入，未重复写入")
    records = parse_sui(content)
    account_kinds = account_kinds or {}
    names = sorted({r[k] for r in records for k in ["account", "target"] if r[k]})
    accounts = {}
    for name_ in names:
        existing = db.execute("SELECT id FROM accounts WHERE name=?", (name_,)).fetchone()
        if existing:
            accounts[name_] = existing[0]
        else:
            account = Account(name=name_, kind=account_kinds.get(name_, "bank"))
            aid = str(uuid5(NAMESPACE_URL, "sui-account:" + name_))
            db.execute("INSERT INTO accounts(id,name,kind,opening_cents) VALUES (?,?,?,0)",
                       (aid, account.name, account.kind))
            accounts[name_] = aid
    for record in records:
        eid = str(uuid5(NAMESPACE_URL, f"{digest}:{record['sheet']}:{record['row']}"))
        entry = Entry(**record["entry"], id=eid, account_id=accounts[record["account"]],
                      to_account_id=accounts[record["target"]] if record["target"] else None)
        save_entry(db, entry, batch_id=batch_id, fingerprint=eid)
    for index, adjustment in enumerate(calibrations or []):
        delta = adjustment["delta_cents"]
        entry = Entry(id=uuid5(NAMESPACE_URL, f"{digest}:calibration:{index}"),
                      date=adjustment["date"], kind="balance_in" if delta > 0 else "balance_out",
                      amount_cents=abs(delta), account_id=accounts[adjustment["account"]],
                      category="迁移余额校准", memo=adjustment["reason"])
        save_entry(db, entry, batch_id=batch_id)
    payload = dict(source_sha256=digest, records=records, calibrations=calibrations or [])
    db.execute("INSERT INTO imports(id,name,payload,status) VALUES (?,?,?,'committed')",
               (batch_id, name, json.dumps(payload, ensure_ascii=False)))
    audit(db, "import.sui", dict(batch_id=batch_id, records=len(records), sha256=digest))
    advance_ledger_revision(db)
    return dict(batch_id=batch_id, records=len(records), accounts=len(accounts), sha256=digest)
