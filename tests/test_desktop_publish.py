import base64
import hashlib
import json
import os
import runpy
import zipfile
from pathlib import Path

import pytest

module = runpy.run_path(str(Path(__file__).parents[1] / "deploy/publish-desktop.py"))
publish_release = module["publish_release"]
MAC = "mingzhang-mac-arm64.zip"
WIN = "mingzhang-windows11-x64.zip"


def installer(path: Path, marker: str):
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(f"app/{marker}.txt", marker)


def envelope(mac: Path, windows: Path, version="0.2.0", source_hash="a" * 64):
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    payload = {
        "schema": 1,
        "source_hash": source_hash,
        "platforms": {
            "darwin-arm64": {"version": version, "url": f"/downloads/{MAC}", "sha256": digest(mac)},
            "win32-x64": {"version": version, "url": f"/downloads/{WIN}", "sha256": digest(windows)},
        },
    }
    return {"schema": 1, "payload": base64.b64encode(json.dumps(payload).encode()).decode(), "signature": "fixture"}


def write_manifest(path: Path, value: dict):
    path.write_text(json.dumps(value))


def test_publish_switches_both_platforms_atomically_and_keeps_one_release(tmp_path):
    root = tmp_path / "server"
    root.mkdir()
    mac, windows, manifest = tmp_path / MAC, tmp_path / WIN, tmp_path / "latest.json"
    installer(mac, "mac-v1")
    installer(windows, "win-v1")
    write_manifest(manifest, envelope(mac, windows))

    assert publish_release(mac, windows, manifest, root) is True
    assert (root / "downloads").is_symlink()
    assert (root / "downloads" / MAC).read_bytes() == mac.read_bytes()
    assert (root / "downloads" / WIN).read_bytes() == windows.read_bytes()
    assert len(list((root / "desktop-releases").iterdir())) == 1
    assert publish_release(mac, windows, manifest, root) is False

    installer(mac, "mac-v2")
    installer(windows, "win-v2")
    write_manifest(manifest, envelope(mac, windows, "0.3.0", "b" * 64))
    assert publish_release(mac, windows, manifest, root) is True
    assert len(list((root / "desktop-releases").iterdir())) == 1
    assert "0.3.0" in os.readlink(root / "downloads")


def test_publish_rejects_mismatch_nonincreasing_versions_and_failed_switch(tmp_path, monkeypatch):
    root = tmp_path / "server"
    root.mkdir()
    mac, windows, manifest = tmp_path / MAC, tmp_path / WIN, tmp_path / "latest.json"
    installer(mac, "mac")
    installer(windows, "windows")
    write_manifest(manifest, envelope(mac, windows))
    publish_release(mac, windows, manifest, root)
    previous = os.readlink(root / "downloads")

    write_manifest(manifest, envelope(mac, windows, "0.3.0", "b" * 64))
    installer(mac, "changed")
    with pytest.raises(ValueError, match="does not match"):
        publish_release(mac, windows, manifest, root)
    write_manifest(manifest, envelope(mac, windows, "0.2.0", "c" * 64))
    with pytest.raises(ValueError, match="must increase"):
        publish_release(mac, windows, manifest, root)

    write_manifest(manifest, envelope(mac, windows, "0.3.0", "d" * 64))
    replace = os.replace

    def fail_switch(source, destination):
        if Path(source).name == "downloads.next":
            raise OSError("simulated switch failure")
        return replace(source, destination)

    monkeypatch.setattr(os, "replace", fail_switch)
    with pytest.raises(OSError, match="switch failure"):
        publish_release(mac, windows, manifest, root)
    assert os.readlink(root / "downloads") == previous
    assert len(list((root / "desktop-releases").iterdir())) == 1
