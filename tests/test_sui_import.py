from datetime import date

import pytest

from backend.db import connect
from backend.ledger import report, snapshot
from backend.sui_import import import_sui, normalize


def test_sui_preserves_identical_rows_and_adjustments_without_inflating_income(client, monkeypatch):
    records = [
        normalize("收入", 2, {"收入账户": "银行", "金额": 100, "日期": "2025-01-01 12:00"}),
        normalize("支出", 2, {"支出账户": "银行", "金额": 10, "日期": "2025-01-02 12:00"}),
        normalize("支出", 3, {"支出账户": "银行", "金额": 10, "日期": "2025-01-02 12:00"}),
        normalize("余额变更", 2, {"账户1": "银行", "金额": -5, "日期": "2025-01-03"}),
        normalize("负债变更", 2, {"账户1": "借款", "金额": 20, "日期": "2025-01-03"}),
        normalize("债权变更", 2, {"账户1": "应收", "金额": 30, "日期": "2025-01-03"}),
        normalize("转账", 2, {"转出账户": "银行", "转入账户": "现金", "金额": 15, "日期": "2025-01-03"}),
    ]
    monkeypatch.setattr("backend.sui_import.parse_sui", lambda _: records)
    with connect() as db:
        result = import_sui(db, b"synthetic", "test.xls", {"借款": "liability", "应收": "receivable"})
        state = snapshot(db)
        assert result["records"] == 7
        assert {a["name"]: a["balance_cents"] for a in state["accounts"]} == {
            "银行": 6000, "现金": 1500, "借款": -2000, "应收": 3000,
        }
        assert state["assets"] == 10500
        assert state["liabilities"] == 2000
        assert state["receivable"] == 3000
        assert state["payable"] == 2000
        totals = report(state["entries"], date(2025, 1, 1), date(2025, 1, 31))
        assert (totals["income"], totals["expense"]) == (10000, 2000)
    with pytest.raises(ValueError, match="已导入"), connect() as db:
        import_sui(db, b"synthetic", "test.xls")
    with connect() as db:
        assert db.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 7


def test_sui_import_failure_rolls_back_accounts_and_entries(client, monkeypatch):
    good = normalize("收入", 2, {"收入账户": "银行", "金额": 100, "日期": "2025-01-01"})
    invalid = normalize("收入", 3, {"收入账户": "银行", "金额": 100, "日期": "9999-01-01"})
    monkeypatch.setattr("backend.sui_import.parse_sui", lambda _: [good, invalid])
    with pytest.raises(ValueError), connect() as db:
        import_sui(db, b"invalid", "bad.xls")
    with connect() as db:
        assert db.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM entries").fetchone()[0] == 0
