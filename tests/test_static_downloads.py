from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.main import mount_web


def test_downloads_outside_web_release_are_served(tmp_path):
    dist = tmp_path / "release" / "web" / "dist"
    shared = tmp_path / "desktop-releases" / "current"
    dist.mkdir(parents=True)
    shared.mkdir(parents=True)
    (shared / "latest.json").write_text('{"ok":true}')
    downloads = tmp_path / "downloads"
    downloads.symlink_to(shared)
    (dist / "downloads").symlink_to(downloads)
    static = FastAPI()
    mount_web(static, dist)
    response = TestClient(static).get("/downloads/latest.json")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
