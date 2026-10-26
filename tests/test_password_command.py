import runpy

import pytest

from backend.auth import verify_password
from backend.db import connect
from tests.conftest import PASSWORD


def run_password(monkeypatch, answers):
    responses = iter(answers)
    monkeypatch.setattr('sys.argv', ['manage', 'password'])
    monkeypatch.setattr('getpass.getpass', lambda _: next(responses))
    runpy.run_module('scripts.manage', run_name='__main__')


def test_password_change_revokes_sessions(client, monkeypatch):
    new_password = 'new-test-password-456'
    run_password(monkeypatch, [PASSWORD, new_password, new_password])
    assert client.get('/api/state').status_code == 401
    assert client.post('/api/login', json={'password': PASSWORD}).status_code == 401
    assert client.post('/api/login', json={'password': new_password}).status_code == 200
    with connect() as db:
        row = db.execute("SELECT payload FROM audit WHERE action='password.change'").fetchone()
        assert row[0] == '{}'


@pytest.mark.parametrize('answers', [
    ['wrong-password'],
    [PASSWORD, 'short'],
    [PASSWORD, 'new-test-password-456', 'different-password'],
])
def test_rejected_password_change_preserves_login(client, monkeypatch, answers):
    with pytest.raises(SystemExit):
        run_password(monkeypatch, answers)
    assert client.get('/api/state').status_code == 200
    with connect() as db:
        stored = db.execute("SELECT value FROM settings WHERE key='password'").fetchone()[0]
        assert verify_password(PASSWORD, stored)
