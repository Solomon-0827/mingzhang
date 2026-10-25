import hashlib
import hmac
import secrets
import time

from fastapi import HTTPException, Request

from backend.db import connect


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    value = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
    return f"{salt}:{value}"


def verify_password(password, encoded):
    return hmac.compare_digest(hash_password(password, encoded.split(":")[0]), encoded)


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def authenticated(request: Request):
    token = request.cookies.get("ledger_session", "")
    with connect() as db:
        found = db.execute(
            "SELECT 1 FROM sessions WHERE token=? AND expires>?", (token_hash(token), int(time.time()))
        ).fetchone()
    if not found:
        raise HTTPException(401, "请先登录账本")
