#!/usr/bin/env bash
# Isolated Linux container smoke test; systemd/HTTP are simulated, filesystem and SQLite are real.
set -euo pipefail
mkdir -p /opt/mingzhang/{app,venv,backups,data} /fixture/{backend,scripts,web/dist,deploy} /stubs
groupadd mingzhang
useradd -g mingzhang mingzhang
mkdir -p /opt/mingzhang/app/web/dist/downloads /opt/mingzhang/app/backend
printf 'existing installer\n' > /opt/mingzhang/app/web/dist/downloads/mingzhang-mac-arm64.zip
printf 'app.mount("/", StaticFiles(directory=DIST, html=True), name="web")\n' > /opt/mingzhang/app/backend/main.py
printf 'old\n' > /opt/mingzhang/app/marker
printf 'old\n' > /opt/mingzhang/venv/marker
printf 'LEDGER_DB=/opt/mingzhang/data/ledger.sqlite3\n' > /opt/mingzhang/config.env
python3 - <<'PY'
import sqlite3
with sqlite3.connect('/opt/mingzhang/data/ledger.sqlite3') as db:
    db.execute('CREATE TABLE sentinel(value TEXT)')
    db.execute("INSERT INTO sentinel VALUES ('keep my ledger')")
PY
cp /source/deploy/upgrade.sh /source/deploy/prune-releases.py /fixture/deploy/
touch /fixture/deploy/requirements.txt /fixture/web/dist/index.html
printf '#!/bin/sh\nexit 0\n' > /stubs/systemctl
cat > /stubs/curl <<'CURL'
#!/bin/sh
if [ "${FAIL_HEALTH:-0}" = 1 ]; then exit 22; fi
printf '{"ok":true}'
CURL
printf '#!/bin/sh\nexit 0\n' > /stubs/sleep
chmod +x /stubs/*
export PATH="/stubs:$PATH"
cd /fixture
bash deploy/upgrade.sh aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
first_app=$(readlink -f /opt/mingzhang/app)
first_venv=$(readlink -f /opt/mingzhang/venv)
test -f "$first_app/REVISION"
test "$(cat "$first_app/web/dist/downloads/mingzhang-mac-arm64.zip")" = 'existing installer'
# Web releases never replace or duplicate the shared desktop download directory.
mkdir -p web/dist/downloads
printf 'replacement installer\n' > web/dist/downloads/mingzhang-mac-arm64.zip
bash deploy/upgrade.sh cccccccccccccccccccccccccccccccccccccccc
first_app=$(readlink -f /opt/mingzhang/app)
first_venv=$(readlink -f /opt/mingzhang/venv)
test -L "$first_app/web/dist/downloads"
test "$(cat "$first_app/web/dist/downloads/mingzhang-mac-arm64.zip")" = 'existing installer'
test "$(find /opt/mingzhang -type f -name 'mingzhang-*.zip' | wc -l)" -eq 1
test -z "$(find /opt/mingzhang/releases -type d -path '*/web/dist/downloads' -print -quit)"
runuser -u mingzhang -- "$first_venv/bin/python" -c "from pathlib import Path; assert Path('/opt/mingzhang/app/REVISION').read_text().strip() == 'c' * 40"
# Force health-check failure: both application and Python environment must roll back.
if FAIL_HEALTH=1 bash deploy/upgrade.sh bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; then
  echo 'Expected deployment to fail' >&2; exit 1
fi
test "$(readlink -f /opt/mingzhang/app)" = "$first_app"
test "$(readlink -f /opt/mingzhang/venv)" = "$first_venv"
python3 - <<'PY'
import glob, sqlite3
paths = ['/opt/mingzhang/data/ledger.sqlite3', *glob.glob('/opt/mingzhang/backups/predeploy-*.sqlite3')]
assert len(paths) >= 2
for path in paths:
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT value FROM sentinel').fetchone()[0] == 'keep my ledger'
print('PASS: deploy, rollback, ledger preservation and SQLite backups')
PY
