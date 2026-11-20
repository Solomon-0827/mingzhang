import os
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path
from uuid import uuid4


def db_path():
    return Path(os.environ.get("LEDGER_DB", "data/ledger.sqlite3"))


@contextmanager
def connect():
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        with db:
            yield db
    finally:
        db.close()


def initialize():
    with connect() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts(
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
          opening_cents INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS account_groups(
          id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS entries(
          id TEXT PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL, amount_cents INTEGER NOT NULL,
          account_id TEXT NOT NULL REFERENCES accounts(id), to_account_id TEXT REFERENCES accounts(id),
          category TEXT NOT NULL DEFAULT '', merchant TEXT NOT NULL DEFAULT '', memo TEXT NOT NULL DEFAULT '',
          counterparty TEXT NOT NULL DEFAULT '', reference_id TEXT REFERENCES entries(id),
          version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
          batch_id TEXT, fingerprint TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS entries_date ON entries(date);
        CREATE INDEX IF NOT EXISTS entries_ref ON entries(reference_id);
        CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'preview', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, action TEXT NOT NULL, payload TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS mutation_receipts(
          id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, result TEXT);
        """)

        if "result" not in {r[1] for r in db.execute("PRAGMA table_info(mutation_receipts)")}:
            db.execute("ALTER TABLE mutation_receipts ADD COLUMN result TEXT")

        columns = {r[1] for r in db.execute("PRAGMA table_info(accounts)")}
        if "group_id" not in columns:
            db.execute("ALTER TABLE accounts ADD COLUMN group_id TEXT")
        for kind, name in [("bank", "银行卡"), ("wallet", "电子钱包"), ("cash", "现金"),
                           ("credit", "信用卡"), ("receivable", "债权"), ("liability", "负债")]:
            db.execute("INSERT OR IGNORE INTO account_groups(id,name,kind) VALUES (?,?,?)", (kind, name, kind))


def backup(destination):
    destination = Path(destination)
    if destination.resolve() == db_path().resolve():
        raise ValueError("备份目标不能是正在使用的数据库")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".tmp-" + str(uuid4()))
    try:
        with connect() as source, closing(sqlite3.connect(temporary)) as target:
            source.backup(target)
            target.execute("PRAGMA journal_mode=DELETE")
        os.chmod(temporary, 0o600)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination
