from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from sqlite3 import IntegrityError
from threading import Event
from types import SimpleNamespace
from uuid import uuid4

import pytest

from backend import main
from backend.categories import CategoryChange, change_category
from backend.db import connect


@pytest.mark.parametrize("first", ["cancel", "commit"])
def test_cancel_and_commit_are_exclusive(client, first):
    mutation_id = str(uuid4())
    path = f"/api/mutation-receipts/{mutation_id}/cancel"
    headers = {"X-Mingzhang-Mutation": mutation_id}
    body = {"id": str(uuid4()), "name": "取消验证", "kind": "cash", "opening_cents": 0}
    if first == "cancel":
        assert client.post(path).json() == {"committed": False, "result": None}
        refused = client.post("/api/accounts", json=body, headers=headers)
        assert refused.status_code == 409
        assert refused.json()["code"] == "mutation_cancelled"
        assert client.get("/api/state").json()["accounts"] == []
        assert client.post(path).json() == {"committed": False, "result": None}
        # A new payload version uses a different receipt ID.
        assert client.post("/api/accounts", json=body, headers={
            "X-Mingzhang-Mutation": str(uuid4()),
        }).status_code == 200
    else:
        committed = client.post("/api/accounts", json=body, headers=headers)
        assert committed.status_code == 200
        assert client.post(path).json() == {"committed": True, "result": committed.json()}
        assert client.post("/api/accounts", json=body, headers=headers).json() == committed.json()


@pytest.mark.parametrize("first", ["cancel", "commit"])
def test_concurrent_cancel_and_commit_serialize_on_two_connections(client, monkeypatch, first):
    mutation_id = str(uuid4())
    path = f"/api/mutation-receipts/{mutation_id}/cancel"
    headers = {"X-Mingzhang-Mutation": mutation_id}
    body = {"id": str(uuid4()), "name": "并发取消验证", "kind": "cash", "opening_cents": 0}
    winner_has_written, loser_began, release = Event(), Event(), Event()

    @contextmanager
    def controlled_connection():
        with connect() as db:
            winner = not winner_has_written.is_set()
            if not winner:
                db.set_trace_callback(lambda sql: loser_began.set() if sql == "BEGIN IMMEDIATE" else None)
            yield db
            if winner:
                winner_has_written.set()
                assert release.wait(5)

    monkeypatch.setattr(main, "connect", controlled_connection)

    def cancel():
        return client.post(path)

    def commit():
        return client.post("/api/accounts", json=body, headers=headers)

    lead, follow = (cancel, commit) if first == "cancel" else (commit, cancel)
    with ThreadPoolExecutor(max_workers=2) as workers:
        winning_request = workers.submit(lead)
        try:
            assert winner_has_written.wait(2), "first request never wrote"
            losing_request = workers.submit(follow)
            assert loser_began.wait(2), "second connection never attempted to acquire the write lock"
            assert not losing_request.done()
        finally:
            release.set()
        winner, loser = winning_request.result(), losing_request.result()
    assert winner.status_code == 200
    if first == "cancel":
        assert winner.json()["committed"] is False
        assert loser.status_code == 409
        assert loser.json()["code"] == "mutation_cancelled"
    else:
        assert loser.status_code == 200
        assert loser.json() == {"committed": True, "result": winner.json()}


def test_client_ids_allow_offline_dependency_chain(client):
    group_id = str(uuid4())
    account_id = str(uuid4())
    headers = {"X-Mingzhang-Mutation": str(uuid4())}
    response = client.post(
        "/api/account-groups",
        json={"id": group_id, "name": "离线账户", "kind": "wallet"},
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json()["id"] == group_id
    response = client.post(
        "/api/accounts",
        json={"id": account_id, "name": "离线钱包", "kind": "wallet", "group_id": group_id, "opening_cents": 100},
        headers={"X-Mingzhang-Mutation": str(uuid4())},
    )
    assert response.status_code == 200
    assert response.json()["id"] == account_id
    entry_id = str(uuid4())
    response = client.post(
        "/api/entries",
        json={
            "id": entry_id,
            "date": "2026-01-15",
            "kind": "expense",
            "amount_cents": 25,
            "account_id": account_id,
            "category": "日常/餐饮",
        },
        headers={"X-Mingzhang-Mutation": str(uuid4())},
    )
    assert response.status_code == 200
    state = client.get("/api/state").json()
    assert state["accounts"][0]["balance_cents"] == 75
    assert state["entries"][0]["id"] == entry_id


def test_mutation_receipt_prevents_duplicate_execution(client):
    mutation_id = str(uuid4())
    headers = {"X-Mingzhang-Mutation": mutation_id}
    body = {"id": str(uuid4()), "name": "只创建一次", "kind": "cash", "opening_cents": 0}
    first = client.post("/api/accounts", json=body, headers=headers)
    second = client.post("/api/accounts", json=body, headers=headers)
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json() == first.json()
    assert [account["name"] for account in client.get("/api/state").json()["accounts"]] == ["只创建一次"]


def test_receipt_failure_rolls_back_edit_and_replay_returns_original_result(client):
    account_id = client.post("/api/accounts", json={
        "name": "事务验证", "kind": "cash", "opening_cents": 0,
    }).json()["id"]
    original = client.post("/api/entries", json={
        "date": "2026-01-15", "kind": "expense", "amount_cents": 25,
        "account_id": account_id, "category": "日常/餐饮",
    }).json()
    path = f"/api/entries/{original['id']}"
    headers = {"X-Mingzhang-Mutation": str(uuid4())}
    edited = {**original, "amount_cents": 70}
    with connect() as db:
        db.execute("""
            CREATE TRIGGER reject_receipt BEFORE INSERT ON mutation_receipts
            BEGIN SELECT RAISE(ABORT, 'simulated receipt write failure'); END
        """)
    with pytest.raises(IntegrityError, match="simulated receipt write failure"):
        client.put(path, json=edited, headers=headers)
    assert client.get("/api/state").json()["entries"][0]["version"] == original["version"]

    with connect() as db:
        db.execute("DROP TRIGGER reject_receipt")
    first = client.put(path, json=edited, headers=headers)
    assert first.status_code == 200
    assert first.json()["amount_cents"] == 70
    assert first.json()["version"] == original["version"] + 1

    with connect() as db:
        db.execute("UPDATE mutation_receipts SET created_at=datetime('now','-120 days')")
    newer = client.put(path, json={**first.json(), "amount_cents": 90}, headers={
        "X-Mingzhang-Mutation": str(uuid4()),
    })
    assert newer.status_code == 200
    replay = client.put(path, json=edited, headers=headers)
    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert client.get("/api/state").json()["entries"][0]["amount_cents"] == 90


def test_mutation_receipt_requires_login(client):
    client.post("/api/logout")
    response = client.post(
        "/api/accounts",
        json={"id": str(uuid4()), "name": "未登录", "kind": "cash", "opening_cents": 0},
        headers={"X-Mingzhang-Mutation": str(uuid4())},
    )
    assert response.status_code == 401
    assert client.post(f"/api/mutation-receipts/{uuid4()}/cancel").status_code == 401


def test_sync_snapshot_reads_only_receipts_already_reflected_in_its_ledger(client, monkeypatch):
    version = client.get("/api/state").json()["category_catalog"]["version"]
    committed, concurrent, missing = [str(uuid4()) for _ in range(3)]
    body = {"action": "add", "path": "已提交分类", "level": "parent", "kind": "expense", "version": version}
    assert client.post("/api/categories", json=body, headers={"X-Mingzhang-Mutation": committed}).status_code == 200

    original_snapshot = main.snapshot

    def interleave(db):
        ledger = original_snapshot(db)
        change = CategoryChange(**{**body, "path": "稍后提交分类", "version": version + 1})
        main.run_mutation(
            SimpleNamespace(headers={"x-mingzhang-mutation": concurrent}),
            lambda writer: change_category(writer, change),
        )
        return ledger

    request = {"mutation_ids": [committed, concurrent, missing]}
    with monkeypatch.context() as patch:
        patch.setattr(main, "snapshot", interleave)
        response = client.post("/api/sync-state", json=request)
    assert response.status_code == 200
    result = response.json()
    assert result["committed"] == [committed]
    assert result["snapshot"]["category_catalog"]["version"] == version + 1
    assert "稍后提交分类" not in result["snapshot"]["category_catalog"]["items"]
    older_revision = result["revision"]

    result = client.post("/api/sync-state", json=request).json()
    assert set(result["committed"]) == {committed, concurrent}
    assert result["snapshot"]["category_catalog"]["version"] == version + 2
    assert result["revision"] == older_revision + 1
    assert "observed_at" not in result
    client.post("/api/logout")
    assert client.post("/api/sync-state", json=request).status_code == 401


def test_balance_adjustment_uses_client_entry_id(client):
    account_id = str(uuid4())
    adjustment_id = str(uuid4())
    assert client.post(
        "/api/accounts",
        json={"id": account_id, "name": "余额测试", "kind": "cash", "opening_cents": 100},
    ).status_code == 200
    response = client.put(
        f"/api/accounts/{account_id}",
        json={
            "id": account_id,
            "name": "余额测试",
            "kind": "cash",
            "opening_cents": 100,
            "version": 1,
            "target_balance_cents": 250,
            "expected_balance_cents": 100,
            "adjustment_id": adjustment_id,
        },
    )
    assert response.status_code == 200
    assert client.get("/api/state").json()["entries"][0]["id"] == adjustment_id


def test_recreated_group_keeps_new_client_id(client):
    old_id = client.post("/api/account-groups", json={"name": "临时类型", "kind": "bank"}).json()["id"]
    assert client.post(f"/api/account-groups/{old_id}/delete").status_code == 200
    new_id = str(uuid4())
    restored = client.post(
        "/api/account-groups",
        json={"id": new_id, "name": "临时类型", "kind": "bank"},
    )
    assert restored.status_code == 200
    assert restored.json()["id"] == new_id
    account_id = str(uuid4())
    assert client.post(
        "/api/accounts",
        json={"id": account_id, "name": "依赖新类型", "kind": "bank", "group_id": new_id, "opening_cents": 0},
    ).status_code == 200


def test_receipt_status_returns_the_original_committed_result(client):
    mutation_id = str(uuid4())
    path = f"/api/mutation-receipts/{mutation_id}"
    assert client.get(path).json() == {"committed": False, "result": None}
    headers = {"X-Mingzhang-Mutation": mutation_id}
    body = {"id": str(uuid4()), "name": "查回执", "kind": "cash", "opening_cents": 0}

    created = client.post("/api/accounts", json=body, headers=headers)
    assert created.status_code == 200
    assert client.get(path).json() == {"committed": True, "result": created.json()}
    assert client.post("/api/accounts", json=body, headers=headers).json() == created.json()
    assert client.get(path).headers["cache-control"] == "no-store"

    client.post("/api/logout")
    assert client.get(path).status_code == 401


def test_receipt_status_handles_legacy_receipts_and_invalid_ids(client):
    mutation_id = str(uuid4())
    with connect() as db:
        db.execute("INSERT INTO mutation_receipts(id) VALUES (?)", (mutation_id,))
    assert client.get(f"/api/mutation-receipts/{mutation_id}").json() == {
        "committed": True, "result": {"ok": True, "duplicate": True},
    }
    assert client.get("/api/mutation-receipts/invalid!").status_code == 400
