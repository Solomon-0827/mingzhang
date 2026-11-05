from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient

from backend.main import app


def test_web_mount_allows_managed_download_symlink():
    web = next(route for route in app.routes if route.name == "web")
    assert web.app.follow_symlink is True


def test_downloads_outside_web_release_are_served(tmp_path):
    dist = tmp_path / "release" / "web" / "dist"
    shared = tmp_path / "downloads"
    dist.mkdir(parents=True)
    shared.mkdir()
    (shared / "latest.json").write_text('{"ok":true}')
    (dist / "downloads").symlink_to(shared)
    static = FastAPI()
    static.mount("/", StaticFiles(directory=dist, html=True, follow_symlink=True))
    response = TestClient(static).get("/downloads/latest.json")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
