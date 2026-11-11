from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


SPEC = importlib.util.spec_from_file_location(
    "sync_hermes_vendor", Path(__file__).resolve().parents[1] / "tools/sync_hermes_vendor.py"
)
sync_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync_module)


def sources(root: Path) -> None:
    for relative in ("src/session_navigation", "adapters/hermes"):
        package = root / relative
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("VALUE = 1\n")


def test_sync_and_check_missing_changed_and_extra_files(tmp_path: Path) -> None:
    sources(tmp_path)
    assert len(sync_module.sync(tmp_path, check=True)) == 2
    assert not (tmp_path / "hermes-plugin").exists()
    assert len(sync_module.sync(tmp_path, check=False)) == 2
    assert sync_module.sync(tmp_path, check=True) == []
    target = tmp_path / "hermes-plugin/vendor/session_navigation"
    (target / "__init__.py").write_text("VALUE = 0\n")
    (target / "obsolete.py").write_text("")
    assert len(sync_module.sync(tmp_path, check=True)) == 2
    assert len(sync_module.sync(tmp_path, check=False)) == 2
    assert not (target / "obsolete.py").exists()
    assert sync_module.sync(tmp_path, check=True) == []


def test_empty_or_incomplete_sources_cannot_overwrite_vendor(tmp_path: Path) -> None:
    sources(tmp_path)
    sync_module.sync(tmp_path, check=False)
    before = sync_module.files(tmp_path / "hermes-plugin")
    (tmp_path / "adapters/hermes/__init__.py").unlink()
    with pytest.raises(ValueError, match="missing source package"):
        sync_module.sync(tmp_path, check=False)
    assert sync_module.files(tmp_path / "hermes-plugin") == before
