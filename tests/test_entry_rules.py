import json
from pathlib import Path
from uuid import UUID, uuid5

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from backend.db import connect, initialize
from backend.ledger import Entry, validate_entry

FIXTURE = json.loads((Path(__file__).parent / "fixtures/entry-rules/editors.json").read_text())


def entry_id(value):
    return str(uuid5(UUID(int=0), value)) if value else None


def entry_model(fields):
    data = FIXTURE["defaults"] | fields
    return Entry(**(data | {"id": entry_id(data.get("id", "candidate")), "reference_id": entry_id(data["reference_id"])}))


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda case: case["name"])
def test_entry_rules(case, tmp_path, monkeypatch):
    monkeypatch.setenv("LEDGER_DB", str(tmp_path / "entries.sqlite3"))
    initialize()
    with connect() as db:
        db.execute("INSERT INTO settings VALUES ('category_catalog',?)", (json.dumps(FIXTURE["catalog"]),))
        for account in FIXTURE["accounts"]:
            db.execute("INSERT INTO accounts(id,name,kind,opening_cents) VALUES (:id,:name,:kind,0)", account)
        for entry in FIXTURE["originals"]:
            data = entry_model(entry).model_dump(mode="json") | {"deleted": entry.get("deleted", 0)}
            db.execute(f"INSERT INTO entries ({','.join(data)}) VALUES ({','.join('?' for _ in data)})", list(data.values()))
        try:
            fields = case["entry"]
            if repeat := case.get("repeat"):
                fields = fields | {repeat["field"]: "🐱" * repeat["count"]}
            model = entry_model(fields)
            validate_entry(db, model.model_dump(mode="json"), str(model.id) if "id" in case["entry"] else None)
        except (HTTPException, ValidationError) as error:
            assert not case["valid"]
            if "reason" in case:
                assert isinstance(error, HTTPException)
                assert error.detail == case["reason"]
        else:
            assert case["valid"]
