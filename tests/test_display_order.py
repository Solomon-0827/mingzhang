import pytest

from backend.db import connect


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
    version = state['ordering']['version']
    renamed = client.get('/api/state').json()['ordering']
    with connect() as db:
        row_exists = db.execute("SELECT 1 FROM settings WHERE key='display_order'").fetchone() is not None
    payload = {'accounts': [], 'categories': ['日常/购物', '日常/吃饭'], 'version': version}
    assert client.put('/api/display-order', json=payload).status_code == 200
    assert row_exists == stored
    assert renamed['version'] == version
    if stored:
        assert renamed['categories'] == renamed['favorites'] == ['日常/吃饭']
    saved = client.get('/api/state').json()['ordering']
    assert saved['version'] == version + 1
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
    assert after['version'] == before['version']
    assert client.put('/api/display-order', json=after).status_code == 200
    restored = change('restore', 'parent', '日用')
    assert restored['favorites'] == ['收入/工资']
    assert restored['version'] == after['version'] + 1


def test_adding_child_hides_favorited_parent_placeholder(client):
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
    assert order['version'] == 1
    assert client.put('/api/display-order', json=order).status_code == 200


@pytest.mark.parametrize("send_stale_favorite", [False, True], ids=["omit-favorites", "carry-favorites"])
def test_order_save_after_orphaned_import_favorite_and_unrelated_rename(client, send_stale_favorite):
    path = '历史/午餐'
    content = f"日期,类型,金额,账户,分类\n2026-01-15,支出,10.00,现金,{path}\n"
    upload = client.post('/api/imports/upload', files={'file': ('old.csv', content.encode(), 'text/csv')})
    assert upload.status_code == 200
    bid = upload.json()['id']
    assert client.post(f'/api/imports/{bid}/commit', json={'rows': [2]}).json() == {'count': 1}
    assert client.put('/api/display-order', json={
        'accounts': [], 'categories': [], 'favorites': [path], 'version': 0,
    }).status_code == 200
    state = client.get('/api/state').json()
    assert state['ordering']['favorites'] == [path]
    original = state['entries'][0]
    assert client.put(f"/api/entries/{original['id']}", json={**original, 'category': '日常/餐饮'}).status_code == 200
    moved = client.get('/api/state').json()['ordering']
    assert client.post('/api/categories', json={
        'action': 'rename', 'path': '日常/购物', 'name': '采购', 'version': state['category_catalog']['version'],
    }).status_code == 200
    order = {'accounts': [], 'categories': ['日常/采购'], 'version': state['ordering']['version']}
    if send_stale_favorite:
        order['favorites'] = [path]
    assert client.put('/api/display-order', json=order).status_code == 200
    assert moved['favorites'] == []
    saved = client.get('/api/state').json()['ordering']
    assert saved['favorites'] == []
    assert saved['version'] == order['version'] + 1


def test_order_save_after_renaming_favorite_to_proto(client):
    assert client.put('/api/display-order', json={
        'accounts': [], 'categories': ['未分类'], 'favorites': ['未分类'], 'version': 0,
    }).status_code == 200
    state = client.get('/api/state').json()
    assert client.post('/api/categories', json={
        'action': 'rename', 'level': 'parent', 'path': '未分类', 'name': '__proto__',
        'version': state['category_catalog']['version'],
    }).status_code == 200
    renamed = client.get('/api/state').json()['ordering']
    payload = {**state['ordering'], 'categories': ['__proto__'], 'favorites': ['__proto__']}
    assert client.put('/api/display-order', json=payload).status_code == 200
    assert renamed['categories'] == renamed['favorites'] == ['__proto__']
    assert renamed['version'] == payload['version']
    saved = client.get('/api/state').json()['ordering']
    assert saved['favorites'] == ['__proto__']
    assert saved['version'] == payload['version'] + 1
