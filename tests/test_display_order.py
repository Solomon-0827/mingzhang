def test_display_order_persists_and_rejects_stale_or_invalid_updates(client):
    a = client.post('/api/accounts', json={'name': 'A'}).json()['id']
    b = client.post('/api/accounts', json={'name': 'B'}).json()['id']
    initial = client.get('/api/state').json()
    assert initial['ordering']['version'] == 0
    payload = {'accounts': [b, a], 'categories': ['其他/分类', '日常/餐饮'], 'version': 0}
    assert client.put('/api/display-order', json=payload).status_code == 200
    state = client.get('/api/state').json()
    assert [x['id'] for x in state['accounts']] == [b, a]
    assert state['ordering']['categories'] == payload['categories']
    assert state['ordering']['version'] == 1
    assert client.put('/api/display-order', json=payload).status_code == 409
    payload['version'] = 1
    payload['accounts'] = [a, a]
    assert client.put('/api/display-order', json=payload).status_code == 400
    payload['accounts'] = ['missing']
    assert client.put('/api/display-order', json=payload).status_code == 400
    c = client.post('/api/accounts', json={'name': 'C'}).json()['id']
    assert [x['id'] for x in client.get('/api/state').json()['accounts']] == [b, a, c]
    client.post('/api/logout')
    assert client.put('/api/display-order', json=payload).status_code == 401
