import asyncio
import csv
import fcntl
import io
import json
import logging
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager, closing
from datetime import date, datetime
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import Depends, FastAPI, File, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from backend.auth import authenticated, hash_password, token_hash, verify_password
from backend.categories import CategoryChange, catalog, change_category
from backend.db import advance_ledger_revision, backup, connect, db_path, initialize, ledger_epoch
from backend.importing import commit_import, preview, read_file
from backend.ledger import (
    KIND_LABELS,
    Account,
    AccountUpdate,
    Entry,
    audit,
    fail,
    report,
    save_entry,
    set_deleted,
    snapshot,
    today,
)

BACKUP_DIR = Path(os.environ.get("LEDGER_BACKUPS", "backups"))


async def daily_backup():
    while True:
        destination = BACKUP_DIR / f"ledger-{date.today().isoformat()}.sqlite3"
        if not destination.exists():
            try:
                await asyncio.to_thread(backup, destination)
                for old in sorted(BACKUP_DIR.glob("ledger-*.sqlite3"))[:-30]:
                    old.unlink()
            except Exception:
                logging.exception("Automatic backup failed; will retry in one hour")
        await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(app):
    lock_path = Path(str(db_path()) + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_file = lock_path.open("a")
    fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    initialize()
    task = asyncio.create_task(daily_backup())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    finally:
        lock_file.close()


app = FastAPI(title="明账", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def protect(request, call_next):
    origin = request.headers.get("origin")
    configured = os.environ.get("APP_ORIGIN", "http://127.0.0.1:8765")
    allowed = {configured}
    if configured.startswith("http://127.0.0.1:"):
        allowed.update(["http://127.0.0.1:5187", "http://localhost:5187", "http://localhost:8765"])
    if request.method not in ["GET", "HEAD", "OPTIONS"] and origin and origin not in allowed:
        return JSONResponse({"detail": "请求来源不匹配"}, status_code=403)
    if request.method not in ["GET", "HEAD", "OPTIONS"] and request.headers.get("sec-fetch-site") == "cross-site":
        return JSONResponse({"detail": "拒绝跨站请求"}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api") else "no-cache"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    return response


def run_mutation(request: Request, apply):
    mutation_id = request.headers.get("x-mingzhang-mutation", "")
    if mutation_id:
        validate_mutation_id(mutation_id)
    with connect() as db:
        # Replay, cancellation and commit all acquire the same SQLite write lock.
        db.execute("BEGIN IMMEDIATE")
        epoch = ledger_epoch(db)
        if mutation_id:
            receipt = db.execute("SELECT result FROM mutation_receipts WHERE id=?", (mutation_id,)).fetchone()
            if receipt is not None:
                return {**receipt_result(receipt), "ledger_epoch": epoch}
            if db.execute("SELECT 1 FROM cancelled_mutations WHERE id=?", (mutation_id,)).fetchone():
                return JSONResponse({"code": "mutation_cancelled", "detail": "这条修改已被放弃", "ledger_epoch": epoch},
                                    status_code=409)
            restored = db.execute("SELECT cancelled FROM restored_mutations WHERE id=?", (mutation_id,)).fetchone()
            if restored is not None:
                detail = ("恢复备份前已放弃这条修改，请核对后处理。" if restored[0]
                          else "恢复的备份已包含这条修改，请核对后处理。")
                return JSONResponse({"detail": detail, "ledger_epoch": epoch}, status_code=409)
        result = apply(db)
        advance_ledger_revision(db)
        if mutation_id:
            db.execute("INSERT INTO mutation_receipts(id,result) VALUES (?,?)", (mutation_id, json.dumps(result)))
        return {**result, "ledger_epoch": epoch} if mutation_id else result


def validate_mutation_id(mutation_id):
    if len(mutation_id) > 100 or not mutation_id.replace("-", "").isalnum():
        fail("同步任务编号无效")


def receipt_result(receipt):
    return json.loads(receipt["result"]) if receipt["result"] is not None else {"ok": True, "duplicate": True}


def receipt_status(epoch, receipt):
    return {"ledger_epoch": epoch, "committed": receipt is not None,
            "result": receipt_result(receipt) if receipt is not None else None}


@app.get("/api/mutation-receipts/{mutation_id}", dependencies=[Depends(authenticated)])
def mutation_receipt(mutation_id: str):
    validate_mutation_id(mutation_id)
    with connect() as db:
        # Check after any writer already committing this receipt has finished.
        db.execute("BEGIN IMMEDIATE")
        receipt = db.execute("SELECT result FROM mutation_receipts WHERE id=?", (mutation_id,)).fetchone()
        return receipt_status(ledger_epoch(db), receipt)


class CancelMutation(BaseModel):
    ledger_epoch: str | None = None


@app.post("/api/mutation-receipts/{mutation_id}/cancel", dependencies=[Depends(authenticated)])
def cancel_mutation(mutation_id: str, body: CancelMutation | None = None):
    validate_mutation_id(mutation_id)
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        epoch = ledger_epoch(db)
        if body and body.ledger_epoch is not None and body.ledger_epoch != epoch:
            return JSONResponse({"code": "ledger_epoch_changed", "detail": "账本已恢复，请刷新后再处理这条修改。",
                                 "ledger_epoch": epoch}, status_code=409)
        receipt = db.execute("SELECT result FROM mutation_receipts WHERE id=?", (mutation_id,)).fetchone()
        if receipt is None:
            db.execute("INSERT OR IGNORE INTO cancelled_mutations(id) VALUES (?)", (mutation_id,))
        return receipt_status(epoch, receipt)


class Login(BaseModel):
    password: str = Field(min_length=1, max_length=1024)


attempts = {}


@app.post("/api/login")
def login(body: Login, request: Request, response: Response):
    host = request.client.host if request.client else "local"
    now = time.time()
    recent = [t for t in attempts.get(host, []) if now - t < 300]
    if len(recent) >= 10:
        fail("尝试次数过多，请 5 分钟后重试", 429)
    attempts[host] = recent + [now]
    with connect() as db:
        stored = db.execute("SELECT value FROM settings WHERE key='password'").fetchone()
        if not stored:
            fail("账本尚未初始化，请先运行初始化命令", 503)
        if not verify_password(body.password, stored["value"]):
            fail("密码不正确", 401)
        token = secrets.token_urlsafe(32)
        db.execute("DELETE FROM sessions WHERE expires<?", (int(now),))
        db.execute("INSERT INTO sessions VALUES (?,?)", (token_hash(token), int(now) + 86400 * 7))
    attempts.pop(host, None)
    response.set_cookie(
        "ledger_session",
        token,
        httponly=True,
        secure=os.environ.get("APP_ORIGIN", "").startswith("https:"),
        samesite="strict",
        max_age=86400 * 7,
    )
    return {"ok": True}


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=12, max_length=1024)
    confirm_password: str = Field(min_length=12, max_length=1024)


@app.post("/api/password", dependencies=[Depends(authenticated)])
def update_password(body: PasswordChange, request: Request, response: Response):
    host = 'password:' + (request.client.host if request.client else 'local')
    now = time.time()
    recent = [t for t in attempts.get(host, []) if now - t < 300]
    if len(recent) >= 10:
        fail("尝试次数过多，请 5 分钟后重试", 429)
    attempts[host] = recent + [now]
    if body.new_password != body.confirm_password:
        fail("两次输入的新密码不一致")
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        stored = db.execute("SELECT value FROM settings WHERE key='password'").fetchone()
        if not stored or not verify_password(body.current_password, stored[0]):
            fail("当前密码不正确")
        db.execute("UPDATE settings SET value=? WHERE key='password'", (hash_password(body.new_password),))
        db.execute("DELETE FROM sessions")
        audit(db, 'password.change', {})
    attempts.pop(host, None)
    response.delete_cookie('ledger_session')
    return {"ok": True}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    with connect() as db:
        db.execute("DELETE FROM sessions WHERE token=?", (token_hash(request.cookies.get("ledger_session", "")),))
    response.delete_cookie("ledger_session")
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True, "version": "0.1.0"}


@app.get("/api/state", dependencies=[Depends(authenticated)])
def state():
    with connect() as db:
        db.execute("BEGIN")
        return ledger_state(db)


def ledger_state(db):
    result = snapshot(db)
    result["ledger_epoch"] = ledger_epoch(db)
    result["revision"] = db.execute("SELECT revision FROM ledger_revision WHERE id=1").fetchone()[0]
    result["demo"] = bool(db.execute("SELECT 1 FROM settings WHERE key='demo'").fetchone())
    result["server_time"] = datetime.now().isoformat()
    result["backup_date"] = max((p.name for p in BACKUP_DIR.glob("ledger-*.sqlite3")), default=None)
    return result


class SyncStateRequest(BaseModel):
    mutation_ids: list[str]


@app.post("/api/sync-state", dependencies=[Depends(authenticated)])
def sync_state(body: SyncStateRequest):
    with connect() as db:
        # Read the ledger and receipts from the same SQLite snapshot.
        db.execute("BEGIN")
        result = ledger_state(db)
        # A restored mutation can be covered by the snapshot without a current-epoch receipt.
        committed = [row[0] for row in db.execute(
            """WITH requested(id) AS (SELECT value FROM json_each(?))
               SELECT id FROM mutation_receipts WHERE id IN requested
               UNION
               SELECT id FROM restored_mutations WHERE cancelled = 0 AND id IN requested""",
            (json.dumps(body.mutation_ids),),
        )]
    return {"snapshot": result, "committed": committed, "revision": result["revision"],
            "ledger_epoch": result["ledger_epoch"]}


@app.post("/api/categories", dependencies=[Depends(authenticated)])
def manage_categories(request: Request, body: CategoryChange):
    return run_mutation(request, lambda db: change_category(db, body))


class DisplayOrder(BaseModel):
    accounts: list[str] = Field(max_length=1000)
    account_groups: list[str] | None = Field(default=None, max_length=1000)
    categories: list[str] = Field(max_length=1000)
    favorites: list[str] | None = None
    version: int = Field(ge=0)


@app.put("/api/display-order", dependencies=[Depends(authenticated)])
def save_display_order(request: Request, body: DisplayOrder):
    def apply(db):
        row = db.execute("SELECT value FROM settings WHERE key='display_order'").fetchone()
        current = json.loads(row[0]) if row else {}
        # Older clients incremented their local order version on category rename.
        if body.version < current.get("version", 0):
            fail("排序已在另一端修改，请关闭设置并刷新后重试", 409)
        ids = {r[0] for r in db.execute("SELECT id FROM accounts")}
        groups = body.account_groups if body.account_groups is not None else current.get("account_groups", [])
        known_groups = {r[0] for r in db.execute("SELECT id FROM account_groups")}
        favorites = body.favorites if body.favorites is not None else current.get("favorites", [])
        active = catalog(db)["items"]
        payload = {
            "accounts": list(dict.fromkeys(a for a in body.accounts if a in ids)),
            "account_groups": list(dict.fromkeys(g for g in groups if g in known_groups)),
            "categories": list(dict.fromkeys(p for p in body.categories if p.strip() and len(p) <= 120)),
            "favorites": list(dict.fromkeys(p for p in favorites if p in active))[:9],
            "version": body.version + 1,
        }
        db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES ('display_order',?)",
                   (json.dumps(payload, ensure_ascii=False),))
        audit(db, "display_order.update", payload)
        return {"ok": True}

    return run_mutation(request, apply)


class AccountGroup(BaseModel):
    id: UUID | None = None
    name: str = Field(min_length=1, max_length=60)
    kind: str


@app.post("/api/account-groups", dependencies=[Depends(authenticated)])
def create_account_group(request: Request, body: AccountGroup):
    def apply(db):
        name = body.name.strip()
        if not name or body.kind not in {"bank", "wallet", "cash", "credit", "receivable", "liability"}:
            fail("请填写类型名称并选择账户性质")
        existing = db.execute("SELECT * FROM account_groups WHERE name=?", (name,)).fetchone()
        if existing:
            if not existing["deleted"] or existing["kind"] != body.kind:
                fail("账户类型名称已存在")
            gid = str(body.id) if body.id else existing["id"]
            if gid == existing["id"]:
                db.execute("UPDATE account_groups SET deleted=0 WHERE id=?", (gid,))
            else:
                db.execute("DELETE FROM account_groups WHERE id=?", (existing["id"],))
                db.execute("INSERT INTO account_groups(id,name,kind) VALUES (?,?,?)", (gid, name, body.kind))
        else:
            gid = str(body.id or uuid4())
            db.execute("INSERT INTO account_groups(id,name,kind) VALUES (?,?,?)", (gid, name, body.kind))
        audit(db, "account_group.create", body.model_dump(mode="json"))
        return {"id": gid}

    return run_mutation(request, apply)


class AccountGroupRename(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    expected_name: str


@app.put("/api/account-groups/{gid}", dependencies=[Depends(authenticated)])
def rename_account_group(request: Request, gid: str, body: AccountGroupRename):
    def apply(db):
        name = body.name.strip()
        if not name:
            fail("账户类型名称不能为空")
        group = db.execute("SELECT * FROM account_groups WHERE id=?", (gid,)).fetchone()
        if not group:
            fail("账户类型不存在", 404)
        if group["name"] != body.expected_name:
            fail("账户类型已被修改，请刷新后重试", 409)
        if group["deleted"] and not db.execute("SELECT 1 FROM accounts WHERE COALESCE(group_id,kind)=?", (gid,)).fetchone():
            fail("账户类型已删除，请刷新", 409)
        try:
            db.execute("UPDATE account_groups SET name=? WHERE id=?", (name, gid))
        except sqlite3.IntegrityError:
            fail("账户类型名称已存在")
        audit(db, "account_group.rename", {"id": gid, "name": name})
        return {"ok": True}

    return run_mutation(request, apply)


@app.post("/api/account-groups/{gid}/delete", dependencies=[Depends(authenticated)])
def delete_account_group(request: Request, gid: str):
    def apply(db):
        if not db.execute("SELECT 1 FROM account_groups WHERE id=? AND deleted=0", (gid,)).fetchone():
            fail("账户类型不存在", 404)
        if db.execute("SELECT 1 FROM accounts WHERE COALESCE(group_id,kind)=?", (gid,)).fetchone():
            fail("请先移走或删除该类型下的账户")
        db.execute("UPDATE account_groups SET deleted=1 WHERE id=?", (gid,))
        audit(db, "account_group.delete", {"id": gid})
        return {"ok": True}

    return run_mutation(request, apply)


def resolve_account_group(db, body):
    gid = body.group_id or body.kind
    group = db.execute("SELECT * FROM account_groups WHERE id=?", (gid,)).fetchone()
    populated = db.execute("SELECT 1 FROM accounts WHERE COALESCE(group_id,kind)=?", (gid,)).fetchone()
    if not group or (group["deleted"] and body.group_id and not populated):
        fail("账户类型不存在，请刷新")
    if group["kind"] != body.kind:
        fail("账户性质与所属类型不一致")
    db.execute("UPDATE account_groups SET deleted=0 WHERE id=?", (gid,))
    return gid


@app.post("/api/accounts", dependencies=[Depends(authenticated)])
def create_account(request: Request, body: Account):
    def apply(db):
        aid = str(body.id or uuid4())
        gid = resolve_account_group(db, body)
        try:
            db.execute(
                "INSERT INTO accounts(id,name,kind,opening_cents,group_id) VALUES (?,?,?,?,?)",
                (aid, body.name, body.kind, body.opening_cents, gid),
            )
        except sqlite3.IntegrityError:
            fail("账户名称已存在")
        audit(db, "account.create", body.model_dump(mode="json"))
        return {"id": aid}

    return run_mutation(request, apply)


@app.put("/api/accounts/{aid}", dependencies=[Depends(authenticated)])
def update_account(request: Request, aid: str, body: AccountUpdate):
    def apply(db):
        row = db.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()
        if not row:
            fail("账户不存在", 404)
        if row["version"] != body.version:
            fail("账户已被修改，请刷新", 409)
        gid = resolve_account_group(db, body)
        if body.target_balance_cents is not None:
            current = next(a["balance_cents"] for a in snapshot(db)["accounts"] if a["id"] == aid)
            if body.expected_balance_cents != current:
                fail("账户余额已变化，请刷新后重新调整", 409)
            if body.opening_cents != row["opening_cents"]:
                fail("调整当前余额时不能同时修改期初余额")
            difference = body.target_balance_cents - current
            if abs(difference) > 10**12:
                fail("单次余额调整差额过大")
            if difference:
                save_entry(db, Entry(
                    id=body.adjustment_id or uuid4(),
                    date=today(), kind="balance_in" if difference > 0 else "balance_out",
                    amount_cents=abs(difference), account_id=aid, memo="账户余额调整",
                ))
        try:
            db.execute(
                "UPDATE accounts SET name=?,kind=?,opening_cents=?,group_id=?,version=version+1 WHERE id=?",
                (body.name, body.kind, body.opening_cents, gid, aid),
            )
        except sqlite3.IntegrityError:
            fail("账户名称已存在")
        audit(db, "account.update", body.model_dump(mode="json"))
        return {"ok": True}

    return run_mutation(request, apply)


@app.post("/api/entries", dependencies=[Depends(authenticated)])
def create_entry(request: Request, body: Entry):
    def apply(db):
        return save_entry(db, body)

    return run_mutation(request, apply)


@app.put("/api/entries/{eid}", dependencies=[Depends(authenticated)])
def update_entry(request: Request, eid: str, body: Entry):
    def apply(db):
        if eid != str(body.id):
            fail("交易编号不匹配")
        return save_entry(db, body, editing=True)

    return run_mutation(request, apply)


class Version(BaseModel):
    version: int


@app.post("/api/accounts/{aid}/delete", dependencies=[Depends(authenticated)])
def delete_account(request: Request, aid: str, body: Version):
    def apply(db):
        row = db.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()
        if not row:
            fail("账户不存在", 404)
        if row["version"] != body.version:
            fail("账户已被修改，请刷新", 409)
        if db.execute("SELECT 1 FROM entries WHERE account_id=? OR to_account_id=?", (aid, aid)).fetchone():
            fail("账户有历史流水，不能删除；可修改名称或所属类型")
        if row["opening_cents"]:
            fail("账户余额不为零，不能删除")
        db.execute("DELETE FROM accounts WHERE id=?", (aid,))
        audit(db, "account.delete", dict(row))
        return {"ok": True}

    return run_mutation(request, apply)


@app.post("/api/entries/{eid}/delete", dependencies=[Depends(authenticated)])
def delete_entry(request: Request, eid: str, body: Version):
    def apply(db):
        set_deleted(db, eid, body.version, True)
        return {"ok": True}

    return run_mutation(request, apply)


@app.post("/api/entries/{eid}/restore", dependencies=[Depends(authenticated)])
def restore_entry(request: Request, eid: str, body: Version):
    def apply(db):
        set_deleted(db, eid, body.version, False)
        return {"ok": True}

    return run_mutation(request, apply)


@app.get("/api/report", dependencies=[Depends(authenticated)])
def get_report(start: date, end: date):
    with connect() as db:
        return report([dict(x) for x in db.execute("SELECT * FROM entries")], start, end)


@app.post("/api/imports/upload", dependencies=[Depends(authenticated)])
async def upload(file: UploadFile = File(...)):
    content = await file.read(5 * 1024 * 1024 + 1)
    headers, rows, mapping = read_file(content, file.filename or "")
    bid = str(uuid4())
    with connect() as db:
        db.execute(
            "INSERT INTO imports(id,name,payload) VALUES (?,?,?)",
            (bid, (file.filename or "")[:200], json.dumps(dict(headers=headers, rows=rows, mapping=mapping))),
        )
        advance_ledger_revision(db)
    return dict(id=bid, headers=headers, mapping=mapping, sample=rows[:3], count=len(rows))


class Mapping(BaseModel):
    mapping: dict[str, str]


def get_batch(db, bid):
    row = db.execute("SELECT * FROM imports WHERE id=?", (bid,)).fetchone()
    if not row:
        fail("导入批次不存在", 404)
    return row


@app.post("/api/imports/{bid}/preview", dependencies=[Depends(authenticated)])
def preview_import(bid: str, body: Mapping):
    with connect() as db:
        batch = get_batch(db, bid)
        if batch["status"] != "preview":
            fail("该批次已经处理")
        payload = json.loads(batch["payload"])
        payload["mapping"] = body.mapping
        db.execute("UPDATE imports SET payload=? WHERE id=?", (json.dumps(payload), bid))
        return preview(db, payload["rows"], payload["headers"], body.mapping)


class Selection(BaseModel):
    rows: list[int]


@app.post("/api/imports/{bid}/commit", dependencies=[Depends(authenticated)])
def commit(bid: str, body: Selection):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        batch = get_batch(db, bid)
        if batch["status"] != "preview":
            fail("该批次已经处理，未重复导入", 409)
        count = commit_import(db, batch, set(body.rows))
        audit(db, "import.commit", {"id": bid, "count": count})
        advance_ledger_revision(db)
    return {"count": count}


@app.post("/api/imports/{bid}/rollback", dependencies=[Depends(authenticated)])
def rollback(bid: str):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        batch = get_batch(db, bid)
        if batch["status"] != "committed":
            fail("仅已导入批次可撤销")
        rows = list(db.execute("SELECT * FROM entries WHERE batch_id=? AND deleted=0", (bid,)))
        for row in rows:
            set_deleted(db, row["id"], row["version"], True)
        db.execute("UPDATE imports SET status='rolled_back' WHERE id=?", (bid,))
        advance_ledger_revision(db)
    return {"ok": True}


@app.get("/api/export.csv", dependencies=[Depends(authenticated)])
def export_csv():
    with connect() as db:
        data = snapshot(db)
    accounts = {a["id"]: a["name"] for a in data["accounts"]}
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["日期", "类型", "金额", "账户", "转入账户", "分类", "商家", "备注", "关联交易", "交易编号"])
    def safe(value):
        value = str(value or "")
        return "'" + value if value.startswith(("=", "+", "-", "@", "\t", "\r")) else value

    for x in data["entries"]:
        if not x["deleted"]:
            writer.writerow(
                [
                    x["date"],
                    KIND_LABELS[x["kind"]],
                    f"{x['amount_cents'] / 100:.2f}",
                    safe(accounts[x["account_id"]]),
                    safe(accounts.get(x["to_account_id"], "")),
                    safe(x["category"]),
                    safe(x["merchant"]),
                    safe(x["memo"]),
                    x["reference_id"],
                    x["id"],
                ]
            )
    return StreamingResponse(
        iter([("\ufeff" + output.getvalue()).encode()]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="mingzhang.csv"'},
    )


@app.get("/api/backup", dependencies=[Depends(authenticated)])
def download_backup():
    path = backup(BACKUP_DIR / f"export-{uuid4()}.sqlite3")
    # Session credentials are not useful in a downloadable accounting backup.
    with closing(sqlite3.connect(path)) as db:
        db.execute("PRAGMA secure_delete=ON")
        db.execute("DELETE FROM sessions")
        db.commit()
        db.execute("VACUUM")
    return FileResponse(
        path, filename=f"mingzhang-{date.today()}.sqlite3", background=BackgroundTask(path.unlink, missing_ok=True)
    )


DIST = Path(__file__).resolve().parent.parent / "web/dist"


def mount_web(application: FastAPI, directory: Path):
    if directory.exists():
        application.mount("/", StaticFiles(directory=directory, html=True, follow_symlink=True), name="web")


mount_web(app, DIST)
