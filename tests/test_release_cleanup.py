import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "prune", Path(__file__).resolve().parents[1] / "deploy/prune-releases.py"
)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_cleanup_protects_old_current_and_split_rollback(tmp_path):
    releases = tmp_path / "releases"
    releases.mkdir()
    versions = []
    for number in range(9):
        release = releases / ("a" * 40 + f"-2026010{number + 1}T000000")
        (release / "app").mkdir(parents=True)
        (release / "venv").mkdir()
        versions.append(release)
    (tmp_path / "app").symlink_to(versions[0] / "app")
    (tmp_path / "venv").symlink_to(versions[0] / "venv")
    external = tmp_path / "data"
    external.mkdir()
    (external / "ledger.sqlite3").write_text("preserve")
    (releases / ("b" * 40 + "-20260101T000000")).symlink_to(external)
    legacy = releases / "legacy-app-old"
    legacy.mkdir()
    module.prune(tmp_path, [versions[1] / "app", versions[2] / "venv"])
    assert [p.exists() for p in versions] == [True, True, True, False, False, False, False, True, True]
    assert (external / "ledger.sqlite3").read_text() == "preserve"
    assert legacy.is_dir()
    assert (tmp_path / "app").resolve().is_dir()


def test_missing_protected_target_prevents_any_cleanup(tmp_path):
    releases = tmp_path / "releases"
    releases.mkdir()
    release = releases / ("a" * 40 + "-20260101T000000")
    release.mkdir()
    import pytest

    with pytest.raises(FileNotFoundError):
        module.prune(tmp_path, [tmp_path / "missing"])
    assert release.exists()
