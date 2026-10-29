from tests.test_ledger import account, entry, report


def state_account(client):
    return client.get("/api/state").json()["accounts"][0]


def adjust(client, original, target):
    return client.put(f"/api/accounts/{original['id']}", json={
        **original, "target_balance_cents": target,
        "expected_balance_cents": original["balance_cents"],
    })


def test_set_balance_preserves_opening_and_reports(client):
    aid = account(client)
    entry(client, aid, amount=1000)
    before_report = report(client)
    for target in (150000, -20000, 0):
        original = state_account(client)
        assert adjust(client, original, target).status_code == 200
        updated = state_account(client)
        assert updated["balance_cents"] == target
        assert updated["opening_cents"] == 100000
        assert report(client)["expense"] == before_report["expense"]
        assert report(client)["income"] == before_report["income"]
    count = len(client.get("/api/state").json()["entries"])
    assert adjust(client, state_account(client), 0).status_code == 200
    assert len(client.get("/api/state").json()["entries"]) == count


def test_stale_balance_and_duplicate_submit_rejected(client):
    aid = account(client)
    original = state_account(client)
    entry(client, aid, amount=1000)
    assert adjust(client, original, 50000).status_code == 409
    assert state_account(client)["balance_cents"] == 99000
    original = state_account(client)
    assert adjust(client, original, 50000).status_code == 200
    assert adjust(client, original, 50000).status_code == 409
    assert state_account(client)["balance_cents"] == 50000


def test_failed_account_update_rolls_back_adjustment(client):
    account(client)
    account(client, "另一账户")
    original = state_account(client)
    original["name"] = "另一账户"
    assert adjust(client, original, 0).status_code == 400
    assert state_account(client)["balance_cents"] == 100000
    assert client.get("/api/state").json()["entries"] == []
