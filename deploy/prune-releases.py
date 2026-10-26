"""Remove obsolete managed releases after a healthy deployment, preserving rollback."""

import re
import shutil
import sys
from pathlib import Path


def prune(root: Path, previous: list[Path], keep: int = 5) -> None:
    releases = root / "releases"
    # Resolve both app and venv: legacy or manually split installations stay safe.
    protected = [p.resolve(strict=True) for p in [root / "app", root / "venv", *previous]]
    candidates = [
        p for p in releases.iterdir()
        if not p.is_symlink() and p.is_dir()
        and re.fullmatch(r"[0-9a-f]{40}-\d{8}T\d{6}", p.name)
    ]
    retained = {
        p for p in candidates
        if any(target == p or p in target.parents for target in protected)
    }
    for candidate in sorted(candidates, key=lambda p: p.name[-15:], reverse=True):
        if len(retained) >= keep:
            break
        retained.add(candidate)
    for candidate in candidates:
        if candidate not in retained:
            shutil.rmtree(candidate)
            print(f"Removed obsolete release: {candidate.name}")


if __name__ == "__main__":
    prune(Path(sys.argv[1]), [Path(value) for value in sys.argv[2:]])
