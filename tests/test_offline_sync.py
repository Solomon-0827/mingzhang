from uuid import uuid4


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
    assert second.json() == {"ok": True, "duplicate": True}
    assert [account["name"] for account in client.get("/api/state").json()["accounts"]] == ["只创建一次"]


def test_mutation_receipt_requires_login(client):
    client.post("/api/logout")
    response = client.post(
        "/api/accounts",
        json={"id": str(uuid4()), "name": "未登录", "kind": "cash", "opening_cents": 0},
        headers={"X-Mingzhang-Mutation": str(uuid4())},
    )
    assert response.status_code == 401


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
