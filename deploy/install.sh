#!/usr/bin/env bash
set -euo pipefail
# Run from an extracted release directory on Ubuntu 24.04, as root.
if [ "$(id -u)" -ne 0 ]; then echo 'Run with sudo.' >&2; exit 1; fi
if [ ! -f web/dist/index.html ]; then echo 'Missing prebuilt web/dist.' >&2; exit 1; fi
if [ -e /opt/mingzhang/app ]; then echo 'Existing installation found; use the documented upgrade procedure.' >&2; exit 1; fi
apt-get update
apt-get install -y python3-venv python3-pip
id mingzhang >/dev/null 2>&1 || useradd --system --home-dir /opt/mingzhang --shell /usr/sbin/nologin mingzhang
install -d -m 750 -o mingzhang -g mingzhang /opt/mingzhang /opt/mingzhang/data /opt/mingzhang/backups
install -d -m 755 /opt/mingzhang/app
cp -R backend scripts web deploy /opt/mingzhang/app/
python3 -m venv /opt/mingzhang/venv
/opt/mingzhang/venv/bin/pip install -r deploy/requirements.txt
printf '%s\n' 'LEDGER_DB=/opt/mingzhang/data/ledger.sqlite3' 'LEDGER_BACKUPS=/opt/mingzhang/backups' 'APP_ORIGIN=http://127.0.0.1:8765' > /opt/mingzhang/config.env
chmod 640 /opt/mingzhang/config.env
chown root:mingzhang /opt/mingzhang/config.env
install -m 644 deploy/mingzhang.service /etc/systemd/system/mingzhang.service
systemctl daemon-reload
printf '\nInstalled. Initialize the password, configure HTTPS, then enable the service. See README.md.\n'
