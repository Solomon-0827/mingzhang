import hashlib
import runpy
import zipfile
from pathlib import Path

import pytest

publish = runpy.run_path(str(Path(__file__).parents[1] / "deploy/publish-desktop.py"))["publish"]
MAC = "mingzhang-mac-arm64.zip"
WIN = "mingzhang-windows11-x64.zip"


def test_publish_validates_before_replacing_and_preserves_other_platform(tmp_path):
    root = tmp_path / "server"
    downloads = root / "app/web/dist/downloads"
    downloads.mkdir(parents=True)
    (downloads / MAC).write_bytes(b"previous")
    (downloads / WIN).write_bytes(b"windows")
    source = tmp_path / "new.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("明账.app/Contents/Info.plist", "fixture")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    with pytest.raises(ValueError, match="checksum"):
        publish(source, MAC, "0" * 64, root)
    assert (downloads / MAC).read_bytes() == b"previous"
    publish(source, MAC, digest, root)
    assert (downloads / MAC).read_bytes() == source.read_bytes()
    assert (downloads / (MAC + ".sha256")).read_text() == f"{digest}  {MAC}\n"
    assert (downloads / WIN).read_bytes() == b"windows"
    assert not list(downloads.glob(".publish-*"))
    source.write_bytes(b"not a zip")
    with pytest.raises(zipfile.BadZipFile):
        publish(source, MAC, hashlib.sha256(source.read_bytes()).hexdigest(), root)
    assert hashlib.sha256((downloads / MAC).read_bytes()).hexdigest() == digest
    with pytest.raises(ValueError, match="Unsupported"):
        publish(source, "../../ledger.sqlite3", digest, root)
