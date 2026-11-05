"""Publish a validated installer under the existing URL without restarting the app."""
import fcntl
import hashlib
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

NAMES = {"mingzhang-mac-arm64.zip", "mingzhang-windows11-x64.zip"}


def publish(source: Path, name: str, digest: str, version: str, root: Path = Path("/opt/mingzhang")):
    if name not in NAMES:
        raise ValueError("Unsupported installer name")
    if not version or any(not part.isdigit() for part in version.split(".")) or len(version.split(".")) != 3:
        raise ValueError("Invalid release version")
    with (root / "deploy.lock").open("a") as lock:
        # Same lock as web upgrades: neither publisher can lose the other's update.
        fcntl.flock(lock, fcntl.LOCK_EX)
        downloads = root / "app/web/dist/downloads"
        downloads.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".publish-", dir=downloads) as stage:
            candidate = Path(stage) / name
            shutil.copyfile(source, candidate)
            with candidate.open("rb") as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != digest:
                raise ValueError("Uploaded installer checksum mismatch")
            with zipfile.ZipFile(candidate) as archive:
                if archive.testzip() is not None:
                    raise ValueError("Corrupt installer ZIP")
            checksum = Path(stage) / (name + ".sha256")
            checksum.write_text(f"{digest}  {name}\n")
            # Each URL always serves a complete file, even during publication.
            for item in (candidate, checksum):
                item.chmod(0o644)
                os.replace(item, downloads / item.name)
            manifest_path = downloads / "latest.json"
            try:
                manifest = json.loads(manifest_path.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                manifest = {"schema": 1, "platforms": {}}
            if not isinstance(manifest, dict) or not isinstance(manifest.get("platforms"), dict):
                manifest = {"schema": 1, "platforms": {}}
            key = "darwin-arm64" if name == "mingzhang-mac-arm64.zip" else "win32-x64"
            manifest["schema"] = 1
            manifest["platforms"][key] = {
                "version": version,
                "url": f"/downloads/{name}",
                "sha256": digest,
            }
            staged_manifest = Path(stage) / "latest.json"
            staged_manifest.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n")
            staged_manifest.chmod(0o644)
            os.replace(staged_manifest, manifest_path)
            print(f"Published {name}: {digest}")


if __name__ == "__main__":
    publish(Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4])
