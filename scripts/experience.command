#!/bin/zsh
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$PATH"
export LEDGER_DB=data/demo.sqlite3
export LEDGER_BACKUPS=backups/demo
umask 077
if [ ! -f "$LEDGER_DB" ]; then uv run python -m scripts.demo; fi
printf '\n明账演示版（全部为虚构数据）\n地址：http://127.0.0.1:8765\n密码：Mingzhang-Demo-2026\n\n'
if curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:8765/api/health >/dev/null 2>&1; then
  open http://127.0.0.1:8765
  if [ -d "$HOME/Applications/明账.app" ]; then open "$HOME/Applications/明账.app"; fi
  exit 0
fi
uv run uvicorn backend.main:app --host 127.0.0.1 --port 8765 &
ledger_pid=$!
trap 'kill "$ledger_pid" 2>/dev/null || true' EXIT INT TERM
for attempt in {1..30}; do
  if curl --noproxy '*' -fsS --max-time 1 http://127.0.0.1:8765/api/health >/dev/null 2>&1; then
    open http://127.0.0.1:8765
    if [ -d "$HOME/Applications/明账.app" ]; then open "$HOME/Applications/明账.app"; fi
    printf '\n服务已启动。保持此窗口运行，按 Control+C 停止。\n'
    wait "$ledger_pid"
    exit 0
  fi
  sleep 1
done
printf '服务未成功启动，请查看上面的错误信息。\n' >&2
exit 1
