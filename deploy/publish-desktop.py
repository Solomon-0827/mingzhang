"""Atomically publish one signed desktop release and discard older installers."""
import base64
import fcntl
import hashlib
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

PLATFORMS = {
    "darwin-arm64": "mingzhang-mac-arm64.zip",
    "win32-x64": "mingzhang-windows11-x64.zip",
}


def _version(value: str) -> tuple[int, int, int]:
    parts = value.split(".")
    if len(parts) != 3 or any(not part.isdigit() for part in parts):
        raise ValueError("Invalid release version")
    return tuple(map(int, parts))


def _read_envelope(source: Path) -> tuple[dict, dict]:
    envelope = json.loads(source.read_text())
    if envelope.get("schema") != 1 or not isinstance(envelope.get("payload"), str) or not isinstance(envelope.get("signature"), str):
        raise ValueError("Invalid signed manifest envelope")
    payload = json.loads(base64.b64decode(envelope["payload"], validate=True))
    if payload.get("schema") != 1 or set(payload.get("platforms", {})) != set(PLATFORMS):
        raise ValueError("Invalid release manifest")
    source_hash = payload.get("source_hash", "")
    if len(source_hash) != 64 or any(char not in "0123456789abcdef" for char in source_hash):
        raise ValueError("Invalid source hash")
    versions = {_version(item.get("version", "")) for item in payload["platforms"].values()}
    if len(versions) != 1:
        raise ValueError("Platform versions do not match")
    return envelope, payload


def _current_payload(downloads: Path) -> dict | None:
    try:
        return _read_envelope(downloads / "latest.json")[1]
    except (FileNotFoundError, ValueError, KeyError, json.JSONDecodeError):
        return None


def publish_release(mac: Path, windows: Path, manifest: Path, root: Path = Path("/opt/mingzhang")):
    sources = {"darwin-arm64": mac, "win32-x64": windows}
    envelope, payload = _read_envelope(manifest)
    version = next(iter(payload["platforms"].values()))["version"]
    release_id = f"{version}-{payload['source_hash'][:12]}"
    with (root / "deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        downloads = root / "downloads"
        current = _current_payload(downloads) if downloads.exists() else None
        if current:
            current_version = next(iter(current["platforms"].values()))["version"]
            if current.get("source_hash") == payload["source_hash"]:
                print(f"Desktop release already current: {current_version}")
                return False
            if _version(version) <= _version(current_version):
                raise ValueError("Desktop version must increase when sources change")
        releases = root / "desktop-releases"
        releases.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".publish-", dir=releases) as temporary:
            stage = Path(temporary)
            for key, name in PLATFORMS.items():
                source = sources[key]
                destination = stage / name
                shutil.copyfile(source, destination)
                with destination.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                item = payload["platforms"][key]
                if item.get("url") != f"/downloads/{name}" or item.get("sha256") != digest:
                    raise ValueError(f"Manifest does not match {name}")
                with zipfile.ZipFile(destination) as archive:
                    if archive.testzip() is not None:
                        raise ValueError(f"Corrupt installer ZIP: {name}")
                destination.chmod(0o644)
                checksum = stage / f"{name}.sha256"
                checksum.write_text(f"{digest}  {name}\n")
                checksum.chmod(0o644)
            signed_manifest = stage / "latest.json"
            signed_manifest.write_text(json.dumps(envelope, separators=(",", ":")) + "\n")
            signed_manifest.chmod(0o644)
            stage.chmod(0o755)
            final = releases / release_id
            if final.exists():
                raise ValueError("Release directory already exists with different content")
            os.replace(stage, final)
        next_link = root / "downloads.next"
        next_link.unlink(missing_ok=True)
        next_link.symlink_to(final)
        try:
            os.replace(next_link, downloads)
        except Exception:
            next_link.unlink(missing_ok=True)
            shutil.rmtree(final)
            raise
        for candidate in releases.iterdir():
            if candidate != final:
                shutil.rmtree(candidate)
        print(f"Published desktop release {release_id}")
        return True


if __name__ == "__main__":
    publish_release(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
