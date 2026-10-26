#!/bin/zsh
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
export LEDGER_DB=data/ledger.sqlite3
export LEDGER_BACKUPS=backups/personal
export APP_ORIGIN=http://127.0.0.1:8766
umask 077
uv run python -m scripts.manage init
printf '\n个人账本：http://127.0.0.1:8766\n保持此窗口运行；按 Control+C 停止。\n\n'
exec uv run uvicorn backend.main:app --host 127.0.0.1 --port 8766
