import pytest
from fastapi.testclient import TestClient

from backend.auth import hash_password
from backend.db import connect
from backend.main import app, attempts

PASSWORD = "test-only-password-123"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("LEDGER_DB", str(tmp_path / "ledger.sqlite3"))
    import backend.main as main

    monkeypatch.setattr(main, "BACKUP_DIR", tmp_path / "backups")
    attempts.clear()
    with TestClient(app) as c:
        with connect() as db:
            db.execute("INSERT INTO settings VALUES ('password',?)", (hash_password(PASSWORD),))
        assert c.post("/api/login", json={"password": PASSWORD}).status_code == 200
        yield c
