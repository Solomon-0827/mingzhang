import json
from datetime import date, datetime, timedelta
from typing import Literal
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator

KINDS = ["income", "expense", "transfer", "refund", "lend", "borrow", "repay", "collect", "balance_in", "balance_out"]


def today():
    return datetime.now(ZoneInfo("Asia/Shanghai")).date()


class Account(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    kind: Literal["bank", "wallet", "cash", "credit", "receivable", "liability"] = "bank"
    opening_cents: int = Field(default=0, ge=-(10**12), le=10**12, strict=True)
    version: int = 1

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        if not value.strip():
            raise ValueError("账户名称不能为空")
        return value.strip()


class Entry(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    date: date
    kind: Literal["income", "expense", "transfer", "refund", "lend", "borrow", "repay", "collect", "balance_in", "balance_out"]
    amount_cents: int = Field(gt=0, le=10**12, strict=True)
    account_id: str
    to_account_id: str | None = None
    category: str = Field(default="", max_length=80)
    merchant: str = Field(default="", max_length=120)
    memo: str = Field(default="", max_length=1000)
    counterparty: str = Field(default="", max_length=80)
    reference_id: str | None = None
    version: int = Field(default=1, ge=1)

    @field_validator("date")
    @classmethod
    def actual_date(cls, value):
        if value > today() or value < date(1900, 1, 1):
            raise ValueError("请选择 1900 年至今天之间的实际发生日期")
        return value


def fail(message, status=400):
    raise HTTPException(status, message)


def audit(db, action, payload):
    db.execute("INSERT INTO audit(action,payload) VALUES (?,?)", (action, json.dumps(payload, ensure_ascii=False)))


def validate_entry(db, data, exclude=None):
    for aid in [data["account_id"]] + ([data["to_account_id"]] if data["to_account_id"] else []):
        if not db.execute("SELECT id FROM accounts WHERE id=?", (aid,)).fetchone():
            fail("账户不存在")
    kind = data["kind"]
    if kind == "transfer":
        if not data["to_account_id"] or data["to_account_id"] == data["account_id"]:
            fail("转账需要两个不同的账户")
    elif data["to_account_id"]:
        fail("只有转账可以指定转入账户")
    references = {"refund": "expense", "collect": "lend", "repay": "borrow"}
    if kind in references:
        original = db.execute("SELECT * FROM entries WHERE id=? AND deleted=0", (data["reference_id"],)).fetchone()
        if not original or original["kind"] != references[kind] or original["id"] == exclude:
            fail("请选择有效的原始交易")
        if data["date"] < original["date"]:
            fail("退款或还款日期不能早于原始交易")
        used = db.execute(
            "SELECT COALESCE(SUM(amount_cents),0) FROM entries WHERE reference_id=? AND deleted=0 AND id!=?",
            (original["id"], exclude or ""),
        ).fetchone()[0]
        if used + data["amount_cents"] > original["amount_cents"]:
            fail("金额超过原交易尚未退款或结清的金额")
        data["category"] = original["category"] if kind == "refund" else ""
        data["counterparty"] = original["counterparty"]
    elif data["reference_id"]:
        fail("该交易类型不应关联原交易")
    if kind in ["lend", "borrow"] and not data["counterparty"].strip():
        fail("借贷需要填写往来对象")
    if kind in ["income", "expense"] and not data["category"].strip():
        fail("请选择或填写分类")
    if exclude:
        linked = list(db.execute("SELECT * FROM entries WHERE reference_id=? AND deleted=0", (exclude,)))
        if linked:
            old = db.execute("SELECT * FROM entries WHERE id=?", (exclude,)).fetchone()
            if (
                kind != old["kind"]
                or data["category"] != old["category"]
                or data["counterparty"] != old["counterparty"]
            ):
                fail("已有关联退款或还款，不能修改类型、分类或往来对象")
            if sum(x["amount_cents"] for x in linked) > data["amount_cents"] or any(
                x["date"] < data["date"] for x in linked
            ):
                fail("修改会使已关联交易的金额或日期无效")


def save_entry(db, entry, editing=False, batch_id=None, fingerprint=None):
    data = entry.model_dump(mode="json")
    existing = db.execute("SELECT * FROM entries WHERE id=?", (data["id"],)).fetchone()
    if not editing and existing:
        validate_entry(db, data, data["id"])
        if all(existing[k] == v for k, v in data.items() if k != "version") and not existing["deleted"]:
            return dict(existing)
        fail("交易编号已使用，请刷新后重试", 409)
    if editing and (not existing or existing["deleted"]):
        fail("交易不存在", 404)
    if editing and data["version"] != existing["version"]:
        fail("这笔交易已在另一端修改，请刷新后重新编辑", 409)
    validate_entry(db, data, data["id"] if editing else None)
    if editing:
        data["version"] += 1
        keys = [k for k in data if k != "id"]
        db.execute(
            f"UPDATE entries SET {','.join(k + '=?' for k in keys)} WHERE id=?", [data[k] for k in keys] + [data["id"]]
        )
    else:
        data.update(batch_id=batch_id, fingerprint=fingerprint)
        db.execute(
            f"INSERT INTO entries ({','.join(data)}) VALUES ({','.join('?' for _ in data)})", list(data.values())
        )
    audit(db, "entry.update" if editing else "entry.create", data)
    return dict(db.execute("SELECT * FROM entries WHERE id=?", (data["id"],)).fetchone())


def set_deleted(db, eid, version, deleted):
    row = db.execute("SELECT * FROM entries WHERE id=?", (eid,)).fetchone()
    if not row:
        fail("交易不存在", 404)
    if version != row["version"]:
        fail("这笔交易已更新，请刷新", 409)
    if deleted and db.execute("SELECT 1 FROM entries WHERE reference_id=? AND deleted=0", (eid,)).fetchone():
        fail("请先删除关联的退款或还款记录")
    if not deleted:
        validate_entry(db, dict(row), eid)
    db.execute("UPDATE entries SET deleted=?, version=version+1 WHERE id=?", (int(deleted), eid))
    audit(db, "entry.delete" if deleted else "entry.restore", dict(row))


def snapshot(db):
    accounts = [dict(x) for x in db.execute("SELECT * FROM accounts ORDER BY rowid")]
    setting = db.execute("SELECT value FROM settings WHERE key='display_order'").fetchone()
    ordering = json.loads(setting[0]) if setting else dict(accounts=[], categories=[], version=0)
    ranks = {aid: i for i, aid in enumerate(ordering["accounts"])}
    accounts.sort(key=lambda a: ranks.get(a["id"], len(ranks)))
    entries = [dict(x) for x in db.execute("SELECT * FROM entries ORDER BY date DESC,created_at DESC,rowid DESC")]
    balances = {a["id"]: a["opening_cents"] for a in accounts}
    active = [x for x in entries if not x["deleted"]]
    for x in active:
        sign = 1 if x["kind"] in ["income", "refund", "borrow", "collect", "balance_in"] else -1
        balances[x["account_id"]] += sign * x["amount_cents"]
        if x["kind"] == "transfer":
            balances[x["to_account_id"]] += x["amount_cents"]
    receivable = payable = 0
    settled = {}
    for item in active:
        ref = item["reference_id"]
        if ref:
            settled[ref] = settled.get(ref, 0) + item["amount_cents"]
    for x in entries:
        x["remaining_cents"] = x["amount_cents"] - settled.get(x["id"], 0)
        if not x["deleted"] and x["kind"] == "lend":
            receivable += x["remaining_cents"]
        if not x["deleted"] and x["kind"] == "borrow":
            payable += x["remaining_cents"]
    for a in accounts:
        a["balance_cents"] = balances[a["id"]]
    assets = sum(max(0, n) for n in balances.values()) + receivable
    liabilities = -sum(min(0, n) for n in balances.values()) + payable
    receivable += sum(max(0, a["balance_cents"]) for a in accounts if a["kind"] == "receivable")
    payable += sum(max(0, -a["balance_cents"]) for a in accounts if a["kind"] == "liability")
    return dict(
        accounts=accounts,
        ordering=ordering,
        entries=entries,
        assets=assets,
        liabilities=liabilities,
        net_assets=assets - liabilities,
        receivable=receivable,
        payable=payable,
        imports=[dict(x) for x in db.execute("SELECT id,name,status,created_at FROM imports ORDER BY created_at DESC")],
    )


def report(entries, start, end):
    if end < start or (end - start).days > 3660:
        fail("日期范围无效，请选择十年以内的范围")
    daily = {}
    d = start
    while d <= end:
        daily[d.isoformat()] = dict(date=d.isoformat(), income=0, expense=0)
        d += timedelta(days=1)
    categories = {}
    for x in entries:
        if x["deleted"] or not start.isoformat() <= x["date"] <= end.isoformat():
            continue
        if x["kind"] == "income":
            daily[x["date"]]["income"] += x["amount_cents"]
        if x["kind"] in ["expense", "refund"]:
            amount = x["amount_cents"] * (-1 if x["kind"] == "refund" else 1)
            daily[x["date"]]["expense"] += amount
            categories[x["category"]] = categories.get(x["category"], 0) + amount
    cumulative = 0
    months = {}
    for x in daily.values():
        cumulative += x["income"] - x["expense"]
        x["cumulative"] = cumulative
        month = x["date"][:7]
        m = months.setdefault(month, dict(month=month, income=0, expense=0))
        m["income"] += x["income"]
        m["expense"] += x["expense"]
    income = sum(x["income"] for x in daily.values())
    expense = sum(x["expense"] for x in daily.values())
    return dict(
        income=income,
        expense=expense,
        net=income - expense,
        daily=list(daily.values()),
        months=list(months.values()),
        categories=sorted(categories.items(), key=lambda x: x[1], reverse=True),
    )
