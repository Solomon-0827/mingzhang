#!/usr/bin/env bash
# Run from the extracted, trusted release directory as root on the ECS host.
set -Eeuo pipefail
umask 027
[[ $(id -u) == 0 ]] || { echo 'Run with sudo' >&2; exit 1; }
revision=${1:?Git commit required}
[[ $revision =~ ^[0-9a-f]{40}$ ]] || exit 2
root=/opt/mingzhang
[[ -f web/dist/index.html && -f deploy/requirements.txt && -f "$root/config.env" && -d "$root/app" ]] || exit 3
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 4; }
install -d -m 750 -o root -g mingzhang "$root/releases"
release="$root/releases/$revision-$(date -u +%Y%m%dT%H%M%S)"
mkdir -p "$release/app"
cp -R backend scripts web deploy "$release/app/"
# Web-only releases keep the last published installers without rebuilding/uploading them.
if [[ ! -d "$release/app/web/dist/downloads" && -d "$root/app/web/dist/downloads" ]]; then
  cp -R "$root/app/web/dist/downloads" "$release/app/web/dist/downloads"
fi
# Install in a new environment; a dependency failure cannot damage the running version.
python3 -m venv "$release/venv"
"$release/venv/bin/pip" install --disable-pip-version-check -r "$release/app/deploy/requirements.txt"
"$release/venv/bin/pip" check
printf '%s\n' "$revision" > "$release/app/REVISION"
chmod -R o-rwx "$release"
chown -R root:mingzhang "$release"
chmod -R g+rX "$release"
# Back up via SQLite's online backup API, never copy an open database file.
set -a
source "$root/config.env"
set +a
export DEPLOY_BACKUP="$root/backups/predeploy-$(date -u +%Y%m%dT%H%M%S).sqlite3"
"$release/venv/bin/python" - <<'PY'
import os, sqlite3
from pathlib import Path
source = Path(os.environ['LEDGER_DB'])
if not source.is_file():
    raise SystemExit('Existing ledger is missing; refusing to initialize an empty ledger')
with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as db:
    if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise SystemExit('Ledger integrity check failed')
    with sqlite3.connect(os.environ['DEPLOY_BACKUP']) as dest:
        db.backup(dest)
os.chmod(os.environ['DEPLOY_BACKUP'], 0o600)
PY
previous_app=$(readlink -f "$root/app")
previous_venv=$(readlink -f "$root/venv")
# Convert the original directory installation to versioned releases once.
if [[ ! -L "$root/app" ]]; then
  previous_app="$root/releases/legacy-app-$(date -u +%Y%m%dT%H%M%S)"
fi
if [[ ! -L "$root/venv" ]]; then
  previous_venv="$root/releases/legacy-venv-$(date -u +%Y%m%dT%H%M%S)"
fi
rollback() {
  trap - ERR
  ln -sfn "$previous_app" "$root/app.next"
  mv -Tf "$root/app.next" "$root/app"
  ln -sfn "$previous_venv" "$root/venv.next"
  mv -Tf "$root/venv.next" "$root/venv"
  systemctl restart mingzhang
  echo 'Deployment failed: previous application restored; ledger was not overwritten.' >&2
  exit 1
}
systemctl stop mingzhang
# Keep every old path valid before arming the rollback handler.
if [[ ! -L "$root/app" ]]; then
  if ! mv "$root/app" "$previous_app"; then systemctl start mingzhang; exit 1; fi
  ln -s "$previous_app" "$root/app"
fi
if [[ ! -L "$root/venv" ]]; then
  if ! mv "$root/venv" "$previous_venv"; then systemctl start mingzhang; exit 1; fi
  ln -s "$previous_venv" "$root/venv"
fi
trap rollback ERR
ln -sfn "$release/app" "$root/app.next"
mv -Tf "$root/app.next" "$root/app"
ln -sfn "$release/venv" "$root/venv.next"
mv -Tf "$root/venv.next" "$root/venv"
systemctl start mingzhang
healthy=false
for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8765/api/health | "$release/venv/bin/python" -c 'import json,sys; assert json.load(sys.stdin)["ok"] is True' 2>/dev/null && curl --fail --silent --max-time 2 http://127.0.0.1:8765/ >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
[[ $healthy == true ]]
systemctl is-active --quiet mingzhang
trap - ERR
# Cleanup never runs after failed health checks. A cleanup error does not undo a healthy release.
if ! python3 "$release/app/deploy/prune-releases.py" "$root" "$previous_app" "$previous_venv"; then
  echo 'Warning: release cleanup failed; application remains healthy.' >&2
fi
printf 'Deployed %s\n' "$revision"
