from backend.db import connect
from tests.conftest import PASSWORD


def body(**extra):
    return dict(current_password=PASSWORD, new_password='new-api-password-123',
                confirm_password='new-api-password-123') | extra


def test_change_password_invalidates_all_sessions(client):
    with connect() as db:
        before = [tuple(r) for r in db.execute('SELECT * FROM entries')]
        db.execute("INSERT INTO sessions VALUES ('other-device',9999999999)")
    assert client.post('/api/password', json=body()).status_code == 200
    assert client.get('/api/state').status_code == 401
    with connect() as db:
        assert db.execute('SELECT count(*) FROM sessions').fetchone()[0] == 0
        assert [tuple(r) for r in db.execute('SELECT * FROM entries')] == before
        assert db.execute("SELECT payload FROM audit WHERE action='password.change'").fetchone()[0] == '{}'
    assert client.post('/api/login', json={'password': PASSWORD}).status_code == 401
    assert client.post('/api/login', json={'password': body()['new_password']}).status_code == 200


def test_password_validation_keeps_current_session(client):
    for payload, status in [(body(current_password='incorrect'), 400),
                            (body(confirm_password='different-password'), 400),
                            (body(new_password='short'), 422)]:
        assert client.post('/api/password', json=payload).status_code == status
        assert client.get('/api/state').status_code == 200
    assert client.post('/api/password', json=body(), headers={'origin': 'https://other.example'}).status_code == 403
    client.post('/api/logout')
    assert client.post('/api/password', json=body()).status_code == 401


def test_password_attempts_are_rate_limited(client):
    for _ in range(10):
        assert client.post('/api/password', json=body(current_password='incorrect')).status_code == 400
    assert client.post('/api/password', json=body()).status_code == 429
