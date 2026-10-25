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

from backend.auth import authenticated, token_hash, verify_password
from backend.db import backup, connect, db_path, initialize
from backend.importing import commit_import, preview, read_file
from backend.ledger import Account, Entry, audit, fail, report, save_entry, set_deleted, snapshot

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


@app.post("/api/accounts", dependencies=[Depends(authenticated)])
def create_account(body: Account):
    aid = str(uuid4())
    with connect() as db:
        try:
            db.execute(
                "INSERT INTO accounts(id,name,kind,opening_cents) VALUES (?,?,?,?)",
                (aid, body.name, body.kind, body.opening_cents),
            )
        except sqlite3.IntegrityError:
            fail("账户名称已存在")
        audit(db, "account.create", body.model_dump())
    return {"id": aid}


@app.put("/api/accounts/{aid}", dependencies=[Depends(authenticated)])
def update_account(aid: str, body: Account):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM accounts WHERE id=?", (aid,)).fetchone()
        if not row:
            fail("账户不存在", 404)
        if row["version"] != body.version:
            fail("账户已被修改，请刷新", 409)
        try:
            db.execute(
                "UPDATE accounts SET name=?,kind=?,opening_cents=?,version=version+1 WHERE id=?",
                (body.name, body.kind, body.opening_cents, aid),
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
        collect="收回",
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
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
