from tests.test_ledger import account, entry, report


def balances(client):
    state = client.get('/api/state').json()
    return {a['id']: a['balance_cents'] for a in state['accounts']}, state


def debt_account(client, name, kind, opening):
    response = client.post('/api/accounts', json=dict(name=name, kind=kind, opening_cents=opening))
    assert response.status_code == 200
    return response.json()['id']


def test_collect_and_repay_between_accounts(client):
    cash = account(client, opening=100000)
    receivable = debt_account(client, '弟', 'receivable', 200000)
    liability = debt_account(client, '借款', 'liability', -150000)
    before = balances(client)[1]
    received = entry(client, cash, 'collect', 100000, to_account_id=receivable)
    paid = entry(client, cash, 'repay', 50000, to_account_id=liability)
    amounts, state = balances(client)
    assert amounts == {cash: 150000, receivable: 100000, liability: -100000}
    assert state['net_assets'] == before['net_assets']
    assert state['receivable'] == 100000
    assert state['payable'] == 100000
    assert report(client)['income'] == report(client)['expense'] == 0
    assert received['reference_id'] is None
    assert received['counterparty'] == '弟'
    # Editing and deleting change both sides.
    response = client.put(f"/api/entries/{received['id']}", json={**received, 'amount_cents': 80000})
    assert response.status_code == 200, response.text
    assert balances(client)[0][receivable] == 120000
    assert client.post(f"/api/entries/{paid['id']}/delete", json={'version': paid['version']}).status_code == 200
    assert balances(client)[0][liability] == -150000
    assert client.post(f"/api/entries/{paid['id']}/restore", json={'version': 2}).status_code == 200
    assert balances(client)[0][liability] == -100000
    assert balances(client)[1]['net_assets'] == before['net_assets']


def test_wrong_account_types_and_mixed_links_rejected(client):
    from uuid import uuid4

    cash = account(client)
    debt = debt_account(client, '负债', 'liability', -100000)
    loan = entry(client, cash, 'borrow', 1000, counterparty='朋友')
    for kind, source, target, reference in [
        ('collect', cash, debt, None),
        ('repay', debt, cash, None),
        ('repay', cash, cash, None),
        ('repay', cash, debt, loan['id']),
    ]:
        response = client.post('/api/entries', json=dict(
            id=str(uuid4()), date='2026-01-15', kind=kind, amount_cents=1000,
            account_id=source, to_account_id=target, reference_id=reference,
        ))
        assert response.status_code == 400, response.text
    assert balances(client)[0][debt] == -100000
