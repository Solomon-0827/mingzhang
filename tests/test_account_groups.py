from backend.db import connect, initialize
from tests.test_ledger import account, entry


def test_custom_groups_keep_account_nature_and_balance(client):
    response = client.post('/api/account-groups', json={'name': '家人往来', 'kind': 'receivable'})
    assert response.status_code == 200
    gid = response.json()['id']
    body = {'name': '弟弟', 'kind': 'receivable', 'group_id': gid, 'opening_cents': 100000}
    aid = client.post('/api/accounts', json=body).json()['id']
    state = client.get('/api/state').json()
    assert state['accounts'][0]['group_id'] == gid
    assert state['accounts'][0]['balance_cents'] == 100000
    assert state['receivable'] == 100000
    assert client.post(f'/api/account-groups/{gid}/delete').status_code == 400
    bad = client.post('/api/accounts', json={**body, 'name': '错配', 'kind': 'bank'})
    assert bad.status_code == 400
    assert client.post(f'/api/accounts/{aid}/delete', json={'version': 1}).status_code == 400


def test_empty_account_and_group_delete_and_restore(client):
    gid = client.post('/api/account-groups', json={'name': '备用', 'kind': 'bank'}).json()['id']
    aid = client.post('/api/accounts', json={'name': '空账户', 'kind': 'bank', 'group_id': gid}).json()['id']
    assert client.post(f'/api/accounts/{aid}/delete', json={'version': 0}).status_code == 409
    assert client.post(f'/api/accounts/{aid}/delete', json={'version': 1}).status_code == 200
    assert client.post(f'/api/account-groups/{gid}/delete').status_code == 200
    assert not any(g['id'] == gid for g in client.get('/api/state').json()['account_groups'])
    restored = client.post('/api/account-groups', json={'name': '备用', 'kind': 'bank'})
    assert restored.json()['id'] == gid


def test_account_with_history_cannot_be_deleted(client):
    aid = account(client)
    entry(client, aid)
    assert client.post(f'/api/accounts/{aid}/delete', json={'version': 1}).status_code == 400
    assert len(client.get('/api/state').json()['entries']) == 1


def test_default_group_hide_survives_initialize_and_old_account_insert(client):
    assert client.post('/api/account-groups/cash/delete').status_code == 200
    initialize()
    assert not any(g['id'] == 'cash' for g in client.get('/api/state').json()['account_groups'])
    # Old importers still insert accounts without a group_id.
    with connect() as db:
        db.execute("INSERT INTO accounts(id,name,kind,opening_cents) VALUES ('legacy','旧现金','cash',50)")
    state = client.get('/api/state').json()
    assert any(g['id'] == 'cash' for g in state['account_groups'])
    assert state['assets'] == 50


def test_old_database_migration_preserves_balance(client):
    with connect() as db:
        db.execute('ALTER TABLE accounts DROP COLUMN group_id')
        db.execute("INSERT INTO accounts(id,name,kind,opening_cents) VALUES ('old','原账户','bank',12345)")
    initialize()
    state = client.get('/api/state').json()
    assert state['accounts'][0]['balance_cents'] == 12345
    assert state['accounts'][0]['group_id'] is None
