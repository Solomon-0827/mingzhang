def test_category_lifecycle_keeps_history_and_versions(client):
    aid = client.post('/api/accounts', json={'name': '测试'}).json()['id']
    entry = {'date': '2026-01-01', 'kind': 'expense', 'amount_cents': 100,
             'account_id': aid, 'category': '日常/餐饮'}
    assert client.post('/api/entries', json=entry).status_code == 200
    def change(action, level, path, **extra):
        version = client.get('/api/state').json()['category_catalog']['version']
        return client.post('/api/categories', json=dict(action=action, level=level, path=path, version=version, **extra))
    assert change('rename', 'parent', '日常', name='日用').status_code == 200
    state = client.get('/api/state').json()
    assert state['entries'][0]['category'] == '日用/餐饮'
    assert state['entries'][0]['version'] == 2
    assert '日常/餐饮' not in state['category_catalog']['items']
    assert change('rename', 'child', '日用/餐饮', name='吃饭').status_code == 200
    assert change('delete', 'parent', '日用').status_code == 200
    state = client.get('/api/state').json()
    assert state['entries'][0]['category'] == '日用/吃饭'
    assert state['entries'][0]['amount_cents'] == 100
    assert '日用/吃饭' in state['category_catalog']['hidden']
    assert not any(p.startswith('日用/') for p in state['category_catalog']['items'])
    entry['category'] = '日用/吃饭'
    assert client.post('/api/entries', json=entry).status_code == 400
    assert change('restore', 'child', '日用/吃饭').status_code == 200
    assert change('add', 'parent', '奖金', kind='income').status_code == 200
    assert change('add', 'child', '奖金/年终', kind='income').status_code == 200
    assert change('add', 'child', '奖金/年终').status_code == 400
    assert change('delete', 'child', '奖金/年终').status_code == 200
    assert change('restore', 'child', '奖金/年终').status_code == 200
    assert client.get('/api/state').json()['category_catalog']['items']['奖金/年终'] == ['income']
    assert change('rename', 'parent', '奖金', name='收入').status_code == 400
    assert change('add', 'child', '不存在/分类').status_code == 400
    assert client.post('/api/categories', json=dict(action='delete', level='parent', path='奖金', version=0)).status_code == 409
    client.post('/api/logout')
    assert client.post('/api/categories', json=dict(action='delete', level='parent', path='奖金', version=0)).status_code == 401
