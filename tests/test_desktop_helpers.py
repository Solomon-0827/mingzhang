from pathlib import Path

DESKTOP = Path(__file__).parents[1] / "desktop"


def test_windows_update_helper_is_legacy_powershell_safe():
    script = (DESKTOP / "update-windows.ps1").read_bytes()
    assert script.isascii()
    text = script.decode()
    assert ".mingzhang-managed" in text
    assert "$Target.previous-$([guid]::NewGuid())" in text
    assert "Split-Path -Parent $Target" in text
    assert "-ErrorAction SilentlyContinue" in text


def test_mac_update_helper_validates_bundle_and_clears_partial_target():
    text = (DESKTOP / "update-mac.sh").read_text()
    assert "local.mingzhang.ledger" in text
    assert 'dirname "$target"' in text
    assert 'rm -rf "$target"\n  mv "$backup" "$target"' in text
