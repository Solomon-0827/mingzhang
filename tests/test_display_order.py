import pytest


@pytest.mark.parametrize("stored", [False, True], ids=["default-order", "stored-order"])
def test_category_rename_then_save_display_order(client, stored):
    state = client.get('/api/state').json()
    assert state['ordering']['version'] == 0
    if stored:
        initial = {**state['ordering'], 'categories': ['日常/餐饮'], 'favorites': ['日常/餐饮']}
        assert client.put('/api/display-order', json=initial).status_code == 200
        state = client.get('/api/state').json()

    response = client.post('/api/categories', json={
        'action': 'rename', 'path': '日常/餐饮', 'name': '吃饭', 'version': state['category_catalog']['version'],
    })
    assert response.status_code == 200
    renamed_version = state['ordering']['version'] + 1
    renamed = client.get('/api/state').json()['ordering']
    payload = {'accounts': [], 'categories': ['日常/购物', '日常/吃饭'], 'version': renamed_version}
    assert client.put('/api/display-order', json=payload).status_code == 200
    assert renamed['version'] == renamed_version
    if stored:
        assert renamed['categories'] == renamed['favorites'] == ['日常/吃饭']
    saved = client.get('/api/state').json()['ordering']
    assert saved['version'] == renamed_version + 1
    assert saved['categories'] == payload['categories']


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


def test_favorites_limits_persistence_and_legacy_save(client):
    state = client.get('/api/state').json()
    choices = list(state['category_catalog']['items'])
    payload = {'accounts': [], 'categories': choices, 'favorites': choices[:9], 'version': 0}
    assert client.put('/api/display-order', json={**payload, 'favorites': choices[:10]}).status_code == 422
    for invalid in [[choices[0], choices[0]], ['missing']]:
        assert client.put('/api/display-order', json={**payload, 'favorites': invalid}).status_code == 400
    assert client.put('/api/display-order', json=payload).status_code == 200
    assert client.get('/api/state').json()['ordering']['favorites'] == choices[:9]
    assert client.put('/api/display-order', json=payload).status_code == 409
    payload.pop('favorites')
    payload['version'] = 1
    assert client.put('/api/display-order', json=payload).status_code == 200
    assert client.get('/api/state').json()['ordering']['favorites'] == choices[:9]
    payload.update(version=2, favorites=list(reversed(choices[:9])))
    assert client.put('/api/display-order', json=payload).status_code == 200
    assert client.get('/api/state').json()['ordering']['favorites'] == list(reversed(choices[:9]))
    payload.update(version=3, favorites=[])
    assert client.put('/api/display-order', json=payload).status_code == 200
    assert client.get('/api/state').json()['ordering']['favorites'] == []


def test_favorites_follow_category_rename_and_removal(client):
    payload = {'accounts': [], 'categories': [], 'favorites': ['日常/餐饮', '收入/工资'], 'version': 0}
    assert client.put('/api/display-order', json=payload).status_code == 200

    def change(action, level, path, name=''):
        version = client.get('/api/state').json()['category_catalog']['version']
        assert client.post('/api/categories', json=dict(action=action, level=level, path=path,
                                                       name=name, version=version)).status_code == 200
        return client.get('/api/state').json()['ordering']

    assert change('rename', 'parent', '日常', '日用')['favorites'] == ['日用/餐饮', '收入/工资']
    assert change('rename', 'child', '日用/餐饮', '吃饭')['favorites'] == ['日用/吃饭', '收入/工资']
    before = client.get('/api/state').json()['ordering']
    after = change('delete', 'parent', '日用')
    assert after['favorites'] == ['收入/工资']
    assert after['version'] == before['version'] + 1
    assert client.put('/api/display-order', json=before).status_code == 409
    restored = change('restore', 'parent', '日用')
    assert restored['favorites'] == ['收入/工资']
    assert restored['version'] == after['version']


def test_adding_child_prunes_favorited_parent_placeholder(client):
    assert client.post('/api/categories', json={
        'action': 'add', 'level': 'parent', 'path': '旅行', 'version': 0,
    }).status_code == 200
    assert client.put('/api/display-order', json={
        'accounts': [], 'categories': [], 'favorites': ['旅行'], 'version': 0,
    }).status_code == 200
    assert client.post('/api/categories', json={
        'action': 'add', 'path': '旅行/机票', 'version': 1,
    }).status_code == 200
    order = client.get('/api/state').json()['ordering']
    assert order['favorites'] == []
    assert order['version'] == 2
