import os
import subprocess
import sys
from uuid import uuid4

from fastapi.testclient import TestClient

from backend.db import backup, connect
from backend.main import app, attempts
from tests.conftest import PASSWORD
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


def test_restore_starts_a_new_epoch_and_revalidates_queued_changes(tmp_path, monkeypatch):
    from backend import main
    from backend.auth import hash_password

    ledger = tmp_path / "ledger.sqlite3"
    monkeypatch.setenv("LEDGER_DB", str(ledger))
    monkeypatch.setattr(main, "BACKUP_DIR", tmp_path / "backups")
    attempts.clear()

    def save(client, name, mutation_id):
        return client.post("/api/accounts", json={
            "id": mutation_id, "name": name, "kind": "cash", "opening_cents": 0,
        }, headers={"X-Mingzhang-Mutation": mutation_id})

    included, later, cancelled, cancelled_later = [str(uuid4()) for _ in range(4)]

    def sync(client):
        return client.post("/api/sync-state", json={"mutation_ids": [included, later]}).json()

    def cancel(client, mutation_id):
        return client.post(f"/api/mutation-receipts/{mutation_id}/cancel").json()

    with TestClient(app) as client:
        with connect() as db:
            db.execute("INSERT INTO settings VALUES ('password',?)", (hash_password(PASSWORD),))
        assert client.post("/api/login", json={"password": PASSWORD}).status_code == 200
        included_result = save(client, "In the backup", included)
        assert included_result.status_code == 200
        assert cancel(client, cancelled)["committed"] is False
        old = sync(client)
        saved = backup(tmp_path / "old.sqlite3")
        assert save(client, "After backup", later).status_code == 200
        assert cancel(client, cancelled_later)["committed"] is False
        before = sync(client)

    command = [sys.executable, "-m", "scripts.manage", "restore", "--file", str(saved)]
    restored = subprocess.run(command, capture_output=True, text=True)
    assert restored.returncode == 0, restored.stderr

    with TestClient(app) as client:
        assert client.post("/api/login", json={"password": PASSWORD}).status_code == 200
        after = sync(client)
        assert old["revision"] == after["revision"] < before["revision"]
        assert old["ledger_epoch"] == before["ledger_epoch"] == included_result.json()["ledger_epoch"]
        assert after["ledger_epoch"] != before["ledger_epoch"]
        assert client.get("/api/state").json()["ledger_epoch"] == after["ledger_epoch"]
        assert after["committed"] == []
        assert [row["id"] for row in after["snapshot"]["accounts"]] == [included]
        for historical_id in [included, cancelled, cancelled_later]:
            receipt = client.get(f"/api/mutation-receipts/{historical_id}").json()
            assert receipt == {"committed": False, "result": None, "ledger_epoch": after["ledger_epoch"]}
            rejected = save(client, "Needs review", historical_id)
            assert rejected.status_code == 409
            assert rejected.json().get("code") != "mutation_cancelled"
        stale_cancel = client.post(f"/api/mutation-receipts/{later}/cancel", json={"ledger_epoch": before["ledger_epoch"]})
        assert stale_cancel.status_code == 409
        assert stale_cancel.json()["ledger_epoch"] == after["ledger_epoch"]
        assert save(client, "After backup", later).status_code == 200
        assert sync(client)["committed"] == [later]
        assert cancel(client, included)["ledger_epoch"] == after["ledger_epoch"]
        assert save(client, "Needs review", included).json()["code"] == "mutation_cancelled"

    restored = subprocess.run(command, capture_output=True, text=True)
    assert restored.returncode == 0, restored.stderr
    with TestClient(app) as client:
        assert client.post("/api/login", json={"password": PASSWORD}).status_code == 200
        assert sync(client)["ledger_epoch"] not in {before["ledger_epoch"], after["ledger_epoch"]}
