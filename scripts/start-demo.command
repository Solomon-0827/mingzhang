#!/bin/zsh
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
export LEDGER_DB=data/demo.sqlite3
export LEDGER_BACKUPS=backups/demo
if [ ! -f "$LEDGER_DB" ]; then uv run python -m scripts.demo; fi
printf '\n演示账本： http://127.0.0.1:8765\n密码：Mingzhang-Demo-2026\n全部为虚构数据。保持此窗口运行；按 Control+C 停止。\n\n'
exec uv run uvicorn backend.main:app --host 127.0.0.1 --port 8765
