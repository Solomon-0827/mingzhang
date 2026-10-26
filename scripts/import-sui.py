"""Import a legacy Sui XLS with optional account classifications and explicit balance calibrations."""
import argparse
import json
from pathlib import Path

from backend.db import backup, connect, db_path, initialize
from backend.ledger import snapshot
from backend.sui_import import import_sui, parse_sui

parser = argparse.ArgumentParser()
parser.add_argument("file", type=Path)
parser.add_argument("--config", type=Path, help="Local-only JSON: account_kinds and calibrations")
parser.add_argument("--commit", action="store_true")
args = parser.parse_args()
content = args.file.read_bytes()
records = parse_sui(content)
print(json.dumps({"rows": len(records), "sheets": {name: sum(r["sheet"] == name for r in records)
                 for name in sorted({r["sheet"] for r in records})}}, ensure_ascii=False))
if args.commit:
    config = json.loads(args.config.read_text()) if args.config else {}
    if db_path().exists():
        backup(str(db_path()) + ".before-sui-import")
    initialize()
    with connect() as db:
        result = import_sui(db, content, args.file.name, **config)
        state = snapshot(db)
        result.update(assets=state["assets"], liabilities=state["liabilities"], net_assets=state["net_assets"])
    print(json.dumps(result, ensure_ascii=False))
else:
    print("仅预览，使用 --commit 写入 LEDGER_DB 指定的账本。")
