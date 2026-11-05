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
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from backend.auth import authenticated, hash_password, token_hash, verify_password
from backend.categories import CategoryChange, catalog, change_category
from backend.db import backup, connect, db_path, initialize
from backend.importing import commit_import, preview, read_file
from backend.ledger import Account, AccountUpdate, Entry, audit, fail, report, save_entry, set_deleted, snapshot, today

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
        result = snapshot(db)
        result["demo"] = bool(db.execute("SELECT 1 FROM settings WHERE key='demo'").fetchone())
    result["server_time"] = datetime.now().isoformat()
    result["backup_date"] = max((p.name for p in BACKUP_DIR.glob("ledger-*.sqlite3")), default=None)
    return result


@app.post("/api/categories", dependencies=[Depends(authenticated)])
def manage_categories(body: CategoryChange):
    with connect() as db:
        return change_category(db, body)


class DisplayOrder(BaseModel):
    accounts: list[str] = Field(max_length=1000)
    account_groups: list[str] | None = Field(default=None, max_length=1000)
    categories: list[str] = Field(max_length=1000)
    favorites: list[str] | None = Field(default=None, max_length=9)
    version: int = Field(ge=0)


@app.put("/api/display-order", dependencies=[Depends(authenticated)])
def save_display_order(body: DisplayOrder):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        current = db.execute("SELECT value FROM settings WHERE key='display_order'").fetchone()
        version = json.loads(current[0])["version"] if current else 0
        if body.version != version:
            fail("排序已在另一端修改，请关闭设置并刷新后重试", 409)
        for values in [body.accounts, body.categories]:
            if len(set(values)) != len(values) or any(not v.strip() or len(v) > 120 for v in values):
                fail("排序项目不能为空或重复")
        ids = {r[0] for r in db.execute("SELECT id FROM accounts")}
        if not set(body.accounts) <= ids:
            fail("排序包含不存在的账户")
        payload = body.model_dump()
        groups = body.account_groups if body.account_groups is not None else (json.loads(current[0]).get("account_groups", []) if current else [])
        known_groups = {r[0] for r in db.execute("SELECT id FROM account_groups")}
        if len(groups) != len(set(groups)) or not set(groups) <= known_groups:
            fail("账户类型排序包含重复或不存在的类型")
        payload["account_groups"] = groups
        favorites = body.favorites if body.favorites is not None else (json.loads(current[0]).get("favorites", []) if current else [])
        active = catalog(db)["items"]
        if len(favorites) != len(set(favorites)) or any(p not in active for p in favorites):
            fail("常用分类不能重复，且必须是未删除的分类")
        payload["favorites"] = favorites
        payload["version"] += 1
        db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES ('display_order',?)",
                   (json.dumps(payload, ensure_ascii=False),))
        audit(db, "display_order.update", payload)
    return {"ok": True}


class AccountGroup(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    kind: str


@app.post("/api/account-groups", dependencies=[Depends(authenticated)])
def create_account_group(body: AccountGroup):
    name = body.name.strip()
    if not name or body.kind not in {"bank", "wallet", "cash", "credit", "receivable", "liability"}:
        fail("请填写类型名称并选择账户性质")
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM account_groups WHERE name=?", (name,)).fetchone()
        if existing:
            if not existing["deleted"] or existing["kind"] != body.kind:
                fail("账户类型名称已存在")
            gid = existing["id"]
            db.execute("UPDATE account_groups SET deleted=0 WHERE id=?", (gid,))
        else:
            gid = str(uuid4())
            db.execute("INSERT INTO account_groups(id,name,kind) VALUES (?,?,?)", (gid, name, body.kind))
        audit(db, "account_group.create", body.model_dump())
    return {"id": gid}


class AccountGroupRename(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    expected_name: str


@app.put("/api/account-groups/{gid}", dependencies=[Depends(authenticated)])
def rename_account_group(gid: str, body: AccountGroupRename):
    name = body.name.strip()
    if not name:
        fail("账户类型名称不能为空")
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
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


@app.post("/api/account-groups/{gid}/delete", dependencies=[Depends(authenticated)])
def delete_account_group(gid: str):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        if not db.execute("SELECT 1 FROM account_groups WHERE id=? AND deleted=0", (gid,)).fetchone():
            fail("账户类型不存在", 404)
        if db.execute("SELECT 1 FROM accounts WHERE COALESCE(group_id,kind)=?", (gid,)).fetchone():
            fail("请先移走或删除该类型下的账户")
        db.execute("UPDATE account_groups SET deleted=1 WHERE id=?", (gid,))
        audit(db, "account_group.delete", {"id": gid})
    return {"ok": True}


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
def create_account(body: Account):
    aid = str(uuid4())
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        gid = resolve_account_group(db, body)
        try:
            db.execute(
                "INSERT INTO accounts(id,name,kind,opening_cents,group_id) VALUES (?,?,?,?,?)",
                (aid, body.name, body.kind, body.opening_cents, gid),
            )
        except sqlite3.IntegrityError:
            fail("账户名称已存在")
        audit(db, "account.create", body.model_dump())
    return {"id": aid}


@app.put("/api/accounts/{aid}", dependencies=[Depends(authenticated)])
def update_account(aid: str, body: AccountUpdate):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
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
        audit(db, "account.update", body.model_dump())
    return {"ok": True}


@app.post("/api/entries", dependencies=[Depends(authenticated)])
def create_entry(body: Entry):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        return save_entry(db, body)


@app.put("/api/entries/{eid}", dependencies=[Depends(authenticated)])
def update_entry(eid: str, body: Entry):
    if eid != str(body.id):
        fail("交易编号不匹配")
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        return save_entry(db, body, editing=True)


class Version(BaseModel):
    version: int


@app.post("/api/accounts/{aid}/delete", dependencies=[Depends(authenticated)])
def delete_account(aid: str, body: Version):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
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


@app.post("/api/entries/{eid}/delete", dependencies=[Depends(authenticated)])
def delete_entry(eid: str, body: Version):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        set_deleted(db, eid, body.version, True)
    return {"ok": True}


@app.post("/api/entries/{eid}/restore", dependencies=[Depends(authenticated)])
def restore_entry(eid: str, body: Version):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        set_deleted(db, eid, body.version, False)
    return {"ok": True}


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
    return {"ok": True}


@app.get("/api/export.csv", dependencies=[Depends(authenticated)])
def export_csv():
    with connect() as db:
        data = snapshot(db)
    accounts = {a["id"]: a["name"] for a in data["accounts"]}
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["日期", "类型", "金额", "账户", "转入账户", "分类", "商家", "备注", "关联交易", "交易编号"])
    labels = dict(
        income="收入",
        expense="支出",
        transfer="转账",
        refund="退款",
        lend="借出",
        borrow="借入",
        repay="还款",
        collect="回款",
    )

    def safe(value):
        value = str(value or "")
        return "'" + value if value.startswith(("=", "+", "-", "@", "\t", "\r")) else value

    for x in data["entries"]:
        if not x["deleted"]:
            writer.writerow(
                [
                    x["date"],
                    labels[x["kind"]],
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
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True, follow_symlink=True), name="web")
