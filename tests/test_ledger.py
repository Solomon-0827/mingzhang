import io
import json
import sqlite3
from uuid import uuid4

import openpyxl

from backend.db import backup, connect
from tests.conftest import PASSWORD


def account(client, name="现金", opening=100000):
    r = client.post("/api/accounts", json={"name": name, "kind": "cash", "opening_cents": opening})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def entry(client, aid, kind="expense", amount=1000, **kw):
    body = dict(
        id=str(uuid4()),
        date="2026-01-15",
        kind=kind,
        amount_cents=amount,
        account_id=aid,
        category={"expense": "日常/餐饮", "income": "收入/工资"}.get(kind, ""),
        **kw,
    )
    r = client.post("/api/entries", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def report(client):
    return client.get("/api/report?start=2026-01-01&end=2026-12-31").json()


def test_entry_rejects_category_for_other_kind(client):
    aid = account(client)
    payload = dict(date="2026-01-15", kind="income", amount_cents=1000, account_id=aid, category="日常/餐饮")
    response = client.post("/api/entries", json=payload)
    assert response.status_code == 400
    assert response.json()["detail"] == "分类不适用于此交易类型，请重新选择"
    expense = entry(client, aid)
    assert client.put(f"/api/entries/{expense['id']}", json={**expense, "kind": "income"}).status_code == 400


def test_entry_accepts_new_category_matching_kind_and_refund(client):
    aid = account(client)
    payload = dict(date="2026-01-15", kind="income", amount_cents=1000, account_id=aid, category="奖金/季度")
    assert client.post("/api/entries", json=payload).status_code == 200
    purchase = entry(client, aid)
    refund = entry(client, aid, "refund", 400, reference_id=purchase["id"])
    assert refund["category"] == purchase["category"] == "日常/餐饮"


def test_legacy_mismatched_category_can_be_edited_and_restored(client):
    original = entry(client, account(client))
    eid = original["id"]
    with connect() as db:
        db.execute("UPDATE entries SET kind='income' WHERE id=?", (eid,))
        db.execute("INSERT INTO settings VALUES ('category_catalog',?)", (json.dumps({
            "authoritative": True, "items": {"日常/餐饮": ["expense"]}, "hidden": [], "version": 1,
        }),))

    response = client.put(f"/api/entries/{eid}", json={**original, "kind": "income", "memo": "历史记录"})
    assert response.status_code == 200
    assert response.json()["category"] == original["category"]
    assert client.post(f"/api/entries/{eid}/delete", json={"version": 2}).status_code == 200
    assert client.post(f"/api/entries/{eid}/restore", json={"version": 3}).status_code == 200


def test_import_keeps_historical_category_kind(client):
    content = "日期,类型,金额,账户,分类\n2026-01-15,收入,10.00,现金,日常/餐饮\n"
    upload = client.post("/api/imports/upload", files={"file": ("old.csv", content.encode(), "text/csv")})
    assert upload.status_code == 200
    bid = upload.json()["id"]
    assert client.post(f"/api/imports/{bid}/commit", json={"rows": [2]}).json() == {"count": 1}
    imported = client.get("/api/state").json()["entries"][0]
    assert (imported["kind"], imported["category"]) == ("income", "日常/餐饮")


def test_transfer_and_credit_payment_are_not_expenses(client):
    cash = account(client)
    credit = account(client, "信用卡", -20000)
    entry(client, cash, "transfer", 20000, to_account_id=credit)
    state = client.get("/api/state").json()
    assert state["net_assets"] == 80000
    assert state["accounts"][1]["balance_cents"] == 0
    assert report(client)["expense"] == 0


def test_refund_partial_limit_and_date(client):
    aid = account(client)
    purchase = entry(client, aid, amount=1000)
    entry(client, aid, "refund", 400, reference_id=purchase["id"])
    assert report(client)["expense"] == 600
    bad = dict(
        id=str(uuid4()), date="2026-01-16", kind="refund", amount_cents=601, account_id=aid, reference_id=purchase["id"]
    )
    assert client.post("/api/entries", json=bad).status_code == 400
    bad["amount_cents"] = 100
    bad["date"] = "2026-01-01"
    assert client.post("/api/entries", json=bad).status_code == 400
    assert client.post(f"/api/entries/{purchase['id']}/delete", json={"version": 1}).status_code == 400


def test_borrow_lend_preserve_net_worth(client):
    aid = account(client)
    loan = entry(client, aid, "lend", 10000, counterparty="测试甲")
    borrowed = entry(client, aid, "borrow", 20000, counterparty="测试乙")
    entry(client, aid, "collect", 3000, reference_id=loan["id"])
    entry(client, aid, "repay", 5000, reference_id=borrowed["id"])
    state = client.get("/api/state").json()
    assert (state["receivable"], state["payable"], state["net_assets"]) == (7000, 15000, 100000)
    assert report(client)["income"] == report(client)["expense"] == 0


def test_idempotency_and_optimistic_conflict(client):
    aid = account(client)
    original = entry(client, aid)
    assert client.post("/api/entries", json=original).status_code == 200
    assert len(client.get("/api/state").json()["entries"]) == 1
    changed = {**original, "amount_cents": 2000}
    assert client.put("/api/entries/" + original["id"], json=changed).status_code == 200
    assert client.put("/api/entries/" + original["id"], json=original).status_code == 409
    assert client.post("/api/entries/" + original["id"] + "/delete", json={"version": 1}).status_code == 409
    assert client.post("/api/entries/" + original["id"] + "/delete", json={"version": 2}).status_code == 200
    assert report(client)["expense"] == 0
    assert client.post("/api/entries/" + original["id"] + "/restore", json={"version": 3}).status_code == 200
    assert report(client)["expense"] == 2000


def test_auth_origin_and_rate_limit(client):
    assert (
        client.post("/api/accounts", json={"name": "恶意"}, headers={"Origin": "https://evil.example"}).status_code
        == 403
    )
    client.post("/api/logout")
    assert client.get("/api/state").status_code == 401
    for _ in range(10):
        assert client.post("/api/login", json={"password": "bad"}).status_code == 401
    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 429


def test_import_preview_duplicate_errors_and_rollback(client):
    aid = account(client)
    entry(client, aid)
    content = "日期,类型,金额,账户,分类\n2026-01-15,支出,10.00,现金,日常/餐饮\n2026-01-16,收入,20.10,新钱包,收入/其他\n2026-01-16,收入,20.10,新钱包,收入/其他\n2026-01-16,支出,abc,现金,日常/餐饮\n"
    upload = client.post("/api/imports/upload", files={"file": ("old.csv", content.encode(), "text/csv")}).json()
    bid = upload["id"]
    preview = client.post(f"/api/imports/{bid}/preview", json={"mapping": upload["mapping"]}).json()
    assert [x["duplicate"] for x in preview["rows"]] == [True, False, True, False]
    assert preview["rows"][3]["error"]
    assert client.post(f"/api/imports/{bid}/commit", json={"rows": [3]}).json() == {"count": 1}
    assert report(client)["income"] == 2010
    assert client.post(f"/api/imports/{bid}/commit", json={"rows": [3]}).status_code == 409
    assert client.post(f"/api/imports/{bid}/rollback").status_code == 200
    assert report(client)["income"] == 0


def test_xlsx_and_decimal_validation(client):
    book = openpyxl.Workbook()
    book.active.append(["日期", "类型", "金额", "账户", "分类"])
    book.active.append(["2026-01-01", "支出", 1.23, "现金", "餐饮"])
    output = io.BytesIO()
    book.save(output)
    result = client.post("/api/imports/upload", files={"file": ("data.xlsx", output.getvalue())})
    assert result.status_code == 200
    aid = account(client)
    body = dict(date="2026-01-01", kind="expense", amount_cents=1.5, account_id=aid, category="餐饮")
    assert client.post("/api/entries", json=body).status_code == 422


def test_backup_integrity_and_restored_accounting(client, tmp_path):
    aid = account(client)
    entry(client, aid, "income", 123456)
    before = client.get("/api/state").json()
    path = backup(tmp_path / "backup.sqlite3")
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert db.execute("SELECT SUM(amount_cents) FROM entries").fetchone()[0] == 123456
    exported = client.get("/api/backup")
    assert exported.status_code == 200
    download = tmp_path / "download.sqlite3"
    download.write_bytes(exported.content)
    with sqlite3.connect(download) as db:
        assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
        assert (
            db.execute("SELECT opening_cents FROM accounts").fetchone()[0]
            + db.execute("SELECT amount_cents FROM entries").fetchone()[0]
            == before["net_assets"]
        )


def test_refund_retry_is_idempotent(client):
    aid = account(client)
    original = entry(client, aid)
    payload = dict(
        id=str(uuid4()), date="2026-01-15", kind="refund", amount_cents=500, account_id=aid, reference_id=original["id"]
    )
    assert client.post("/api/entries", json=payload).status_code == 200
    assert client.post("/api/entries", json=payload).status_code == 200
    assert report(client)["expense"] == 500


def test_cross_month_refund_and_monthly_reconciliation(client):
    aid = account(client)
    original = entry(client, aid, amount=10000)
    payload = dict(date="2026-02-01", kind="refund", amount_cents=2500, account_id=aid, reference_id=original["id"])
    assert client.post("/api/entries", json=payload).status_code == 200
    result = report(client)
    assert result["months"][0]["expense"] == 10000
    assert result["months"][1]["expense"] == -2500
    assert sum(m["expense"] for m in result["months"]) == result["expense"] == 7500
    assert result["daily"][-1]["cumulative"] == -7500


def test_concurrent_refunds_cannot_exceed_original(client):
    from concurrent.futures import ThreadPoolExecutor

    aid = account(client)
    original = entry(client, aid, amount=10000)

    def refund():
        return client.post(
            "/api/entries",
            json=dict(
                id=str(uuid4()),
                date="2026-01-15",
                kind="refund",
                amount_cents=6000,
                account_id=aid,
                reference_id=original["id"],
            ),
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: refund(), range(2)))
    assert sorted(results) == [200, 400]
    assert report(client)["expense"] == 4000
