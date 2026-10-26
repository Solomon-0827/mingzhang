import argparse
import fcntl
import getpass
import os
import shutil
import sqlite3
from pathlib import Path

from backend.auth import hash_password
from backend.db import backup, connect, db_path, initialize

parser = argparse.ArgumentParser()
parser.add_argument("command", choices=["init", "backup", "restore"])
parser.add_argument("--file")
args = parser.parse_args()
if args.command == "init":
    initialize()
    with connect() as db:
        if db.execute("SELECT 1 FROM settings WHERE key='password'").fetchone():
            print("账本已初始化，未改动密码。")
            raise SystemExit(0)
        password = os.environ.get("LEDGER_INITIAL_PASSWORD") or getpass.getpass("设置账本密码（至少 12 位）：")
        if len(password) < 12:
            raise SystemExit("密码至少 12 位")
        db.execute("INSERT INTO settings VALUES ('password',?)", (hash_password(password),))
    os.chmod(db_path(), 0o600)
    print("账本已初始化。")
elif args.command == "backup":
    if not args.file:
        raise SystemExit("请指定 --file")
    print(backup(args.file))
else:
    if not args.file:
        raise SystemExit("先停止服务器，再指定 --file 备份文件")
    lock_path = Path(str(db_path()) + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    restore_lock = lock_path.open("a")
    try:
        fcntl.flock(restore_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("账本服务仍在运行；先停止服务，再恢复备份。") from None
    source = Path(args.file).resolve()
    target = db_path().resolve()
    if source == target:
        raise SystemExit("源文件不能等于当前数据库")
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as db:
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        for table in ["settings", "accounts", "entries", "imports", "audit", "sessions"]:
            db.execute(f"SELECT 1 FROM {table} LIMIT 1")
    if target.exists():
        backup(str(target) + ".before-restore")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    for suffix in ["-wal", "-shm"]:
        Path(str(target) + suffix).unlink(missing_ok=True)
    with sqlite3.connect(target) as db:
        db.execute("DELETE FROM sessions")
    os.chmod(target, 0o600)
    print("恢复完成，旧账本保存在 .before-restore 文件；请重新登录。")
