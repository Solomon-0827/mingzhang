import json
from datetime import date
from pathlib import Path

import pytest

from backend.ledger import account_postings, project_ledger, report


@pytest.mark.parametrize("path", sorted(Path(__file__).with_name("fixtures").joinpath("ledger-projection").glob("*.json")),
                         ids=lambda path: path.stem)
def test_projection(path):
    fixture = json.loads(path.read_text())
    expected = fixture["expected"]
    accounts = fixture["accounts"]
    entries = [
        dict(account_id="cash", to_account_id=None, reference_id=None, category="", deleted=0) | entry
        for entry in fixture["entries"]
    ]
    result = project_ledger(accounts, entries)
    assert {a["id"]: a["balance_cents"] for a in result["accounts"]} == expected["balances"]
    assert {e["id"]: e["remaining_cents"] for e in result["entries"]} == expected["remaining"]
    assert {key: result[key] for key in expected["totals"]} == expected["totals"]
    postings = {e["id"]: [list(posting) for posting in account_postings(e)] for e in entries if not e["deleted"]}
    assert postings == expected["postings"]
    assert json.loads(json.dumps(report(entries, *map(date.fromisoformat, fixture["range"])))) == expected["report"]
