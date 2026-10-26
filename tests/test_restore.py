import os
import subprocess
import sys

from backend.db import backup, connect
from tests.test_ledger import account, entry


def test_restore_command_rejects_running_server_then_recovers(client, tmp_path):
    aid = account(client)
    entry(client, aid, amount=2750)
    snapshot = backup(tmp_path / "restore.sqlite3")
    command = [sys.executable, "-m", "scripts.manage", "restore", "--file", str(snapshot)]
    running = subprocess.run(command, capture_output=True, text=True)
    assert running.returncode != 0
    assert "仍在运行" in running.stderr
    restored_path = tmp_path / "restored.sqlite3"
    env = {**os.environ, "LEDGER_DB": str(restored_path)}
    restored = subprocess.run(command, env=env, capture_output=True, text=True)
    assert restored.returncode == 0, restored.stderr
    previous = os.environ["LEDGER_DB"]
    try:
        os.environ["LEDGER_DB"] = str(restored_path)
        with connect() as db:
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert db.execute("SELECT amount_cents FROM entries").fetchone()[0] == 2750
            assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    finally:
        os.environ["LEDGER_DB"] = previous


def test_initialization_can_resume_and_preserves_existing_password(tmp_path):
    import sqlite3

    from backend.auth import verify_password

    target = tmp_path / "personal.sqlite3"
    command = [sys.executable, "-m", "scripts.manage", "init"]
    env = {**os.environ, "LEDGER_DB": str(target), "LEDGER_INITIAL_PASSWORD": "short"}
    failed = subprocess.run(command, env=env, capture_output=True, text=True)
    assert failed.returncode != 0
    assert target.exists()
    env["LEDGER_INITIAL_PASSWORD"] = "local-test-password-123"
    resumed = subprocess.run(command, env=env, capture_output=True, text=True)
    assert resumed.returncode == 0, resumed.stderr
    env["LEDGER_INITIAL_PASSWORD"] = "must-not-replace-password"
    repeated = subprocess.run(command, env=env, capture_output=True, text=True)
    assert repeated.returncode == 0, repeated.stderr
    with sqlite3.connect(target) as db:
        encoded = db.execute("SELECT value FROM settings WHERE key='password'").fetchone()[0]
    assert verify_password("local-test-password-123", encoded)
