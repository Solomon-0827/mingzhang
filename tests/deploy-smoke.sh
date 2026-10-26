#!/usr/bin/env bash
# Isolated Linux container smoke test; systemd/HTTP are simulated, filesystem and SQLite are real.
set -euo pipefail
mkdir -p /opt/mingzhang/{app,venv,backups,data} /fixture/{backend,scripts,web/dist,deploy} /stubs
groupadd mingzhang
useradd -g mingzhang mingzhang
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
runuser -u mingzhang -- "$first_venv/bin/python" -c "from pathlib import Path; assert Path('/opt/mingzhang/app/REVISION').read_text().strip() == 'a' * 40"
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
