"""After the web build, run with PYTHONPATH=. uv run python tests/browser/run_regressions.py.

Set MZ_PLAYWRIGHT_MODULE to the absolute path of an installed Playwright index.mjs.
Set MZ_CHROMIUM to use an installed Chromium executable instead of Playwright's browser.
"""

import json
import os
import socket
import subprocess
import tempfile
import threading
from pathlib import Path

import uvicorn

from backend.auth import authenticated
from backend.db import connect, initialize
from backend.ledger import today
from backend.main import DIST, app

HERE = Path(__file__).resolve().parent


def seed_report():
    cases = json.loads((HERE.parent / "fixtures/report-totals.json").read_text())
    precision = next(case for case in cases if case["name"] == "one cent left after large offsetting totals")
    day = today().isoformat()
    with connect() as db:
        db.execute("INSERT INTO accounts(id,name,kind,opening_cents) VALUES ('report','Report Bank','bank',0)")
        rows = (
            (f"report-{index}-{i}", day, row["kind"], row["amount_cents"], row["category"])
            for index, row in enumerate(precision["entries"])
            for i in range(row["count"])
        )
        db.executemany(
            "INSERT INTO entries(id,date,kind,amount_cents,category,account_id) VALUES (?,?,?,?,?,'report')",
            rows,
        )


def run(case, directory):
    os.environ["LEDGER_DB"] = str(directory / f"{case}.sqlite3")
    initialize()
    if case == "report":
        seed_report()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        origin = f"http://127.0.0.1:{listener.getsockname()[1]}"
        os.environ["APP_ORIGIN"] = origin
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        thread.start()
        try:
            subprocess.run(["node", str(HERE / "entry-and-report-regressions.mjs"), case, origin], check=True, timeout=60)
        finally:
            server.should_exit = True
            thread.join()


if __name__ == "__main__":
    if not (DIST / "index.html").exists():
        raise SystemExit("Build the web app first with npm --prefix web run build.")
    app.dependency_overrides[authenticated] = lambda: None
    with tempfile.TemporaryDirectory(prefix="mingzhang-regressions-") as temp:
        os.environ["LEDGER_BACKUPS"] = str(Path(temp) / "backups")
        for scenario in ("rename", "swap", "copy", "report", "restore"):
            run(scenario, Path(temp))
