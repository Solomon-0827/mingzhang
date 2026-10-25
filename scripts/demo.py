"""Create an explicitly separate, fictional demo ledger; never modify a real ledger."""

import os
import random
from datetime import timedelta
from uuid import uuid4

from backend.auth import hash_password
from backend.db import connect, initialize
from backend.ledger import Entry, save_entry, today

if not os.environ.get("LEDGER_DB", "").endswith("/demo.sqlite3"):
    raise SystemExit("Only runs when LEDGER_DB ends with /demo.sqlite3")
initialize()
rng = random.Random(20261025)
with connect() as db:
    if db.execute("SELECT 1 FROM entries").fetchone():
        raise SystemExit("Demo already populated")
    db.execute("INSERT INTO settings VALUES ('password',?)", (hash_password("Mingzhang-Demo-2026"),))
    db.execute("INSERT INTO settings VALUES ('demo','true')")
    ids = [str(uuid4()) for _ in range(3)]
    for aid, name, kind, amount in zip(
        ids,
        ["示例 · 招商银行", "示例 · 微信零钱", "示例 · 现金"],
        ["bank", "wallet", "cash"],
        [3500000, 180000, 50000],
        strict=True,
    ):
        db.execute("INSERT INTO accounts(id,name,kind,opening_cents) VALUES (?,?,?,?)", (aid, name, kind, amount))
    end = today()
    for offset in range(119, -1, -1):
        day = end - timedelta(days=offset)
        if day.day in [5, 20]:
            save_entry(
                db,
                Entry(
                    date=day,
                    kind="income",
                    amount_cents=1850000 if day.day == 5 else 320000,
                    account_id=ids[0],
                    category="收入/工资" if day.day == 5 else "收入/其他",
                    memo="演示数据",
                ),
            )
        if day.day == 1:
            save_entry(
                db,
                Entry(
                    date=day,
                    kind="expense",
                    amount_cents=420000,
                    account_id=ids[0],
                    category="居住/房租",
                    memo="演示数据",
                ),
            )
        if rng.random() < 0.9:
            for _ in range(rng.randint(1, 3)):
                category = rng.choice(["日常/餐饮", "日常/交通", "日常/购物", "生活/娱乐", "学习/书籍"])
                save_entry(
                    db,
                    Entry(
                        date=day,
                        kind="expense",
                        amount_cents=rng.randint(1600, 24000),
                        account_id=ids[1],
                        category=category,
                        merchant=rng.choice(["便利店", "咖啡馆", "线上购物", "街角小馆"]),
                        memo="演示数据",
                    ),
                )
    save_entry(
        db,
        Entry(date=end, kind="transfer", amount_cents=200000, account_id=ids[0], to_account_id=ids[1], memo="演示数据"),
    )
print("Fictional demo ledger ready.")
