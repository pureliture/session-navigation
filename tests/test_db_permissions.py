from __future__ import annotations

import stat
from pathlib import Path

import pytest
from session_navigation.db import open_db


def test_open_db_creates_user_only_file(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    conn = open_db(path)
    try:
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    finally:
        conn.close()


def test_open_db_tightens_existing_file(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    open_db(path).close()
    path.chmod(0o644)
    conn = open_db(path)
    try:
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    finally:
        conn.close()


def test_open_db_never_adds_write_to_readonly_file(tmp_path: Path) -> None:
    """P1-10: a read-only DB must NOT get chmod +w; hardening only strips."""
    import os

    from session_navigation.db import open_db

    path = tmp_path / "state.sqlite3"
    conn = open_db(path)
    conn.execute("SELECT 1")
    conn.close()
    path.chmod(0o444)
    conn = open_db(path)
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
        assert not mode & stat.S_IWUSR, f"read-only DB gained owner-write: {oct(mode)}"
        assert mode & 0o077 == 0, f"group/other bits remain: {oct(mode)}"
        assert conn.execute("SELECT 1").fetchone() is not None
    finally:
        conn.close()


def test_open_db_rejects_future_protocol_before_touching_permissions(tmp_path: Path) -> None:
    """P1-10: checkProtocol runs before any chmod/configure write."""
    import sqlite3

    import pytest

    from session_navigation.db import EngineProtocolError, open_db

    path = tmp_path / "state.sqlite3"
    open_db(path).close()
    raw = sqlite3.connect(str(path))
    raw.execute("UPDATE meta SET value='99' WHERE key='engine_protocol_version'")
    raw.commit()
    raw.close()
    path.chmod(0o640)
    with pytest.raises(EngineProtocolError):
        open_db(path)
    assert stat.S_IMODE(path.stat().st_mode) == 0o640


def test_harden_permissions_strips_sidecars_without_adding_access(tmp_path: Path) -> None:
    """P1-10: WAL/SHM/journal sidecars get the same strip-only treatment."""
    from session_navigation.db import _harden_permissions

    path = tmp_path / "state.sqlite3"
    path.write_bytes(b"fake")
    sidecars = [tmp_path / f"state.sqlite3{suffix}" for suffix in ("-wal", "-shm", "-journal")]
    for sidecar in sidecars:
        sidecar.write_bytes(b"fake")
        sidecar.chmod(0o644)
    path.chmod(0o644)
    _harden_permissions(path)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    for sidecar in sidecars:
        assert stat.S_IMODE(sidecar.stat().st_mode) == 0o600


def test_harden_permissions_skips_symlinks_toctou(tmp_path: Path) -> None:
    """P1-10: no chmod through symlinks (O_NOFOLLOW); the target is untouched."""
    import os

    from session_navigation.db import _harden_permissions, open_db

    if not hasattr(os, "O_NOFOLLOW"):
        pytest.skip("O_NOFOLLOW unavailable")
    real = tmp_path / "real.sqlite3"
    open_db(real).close()
    real.chmod(0o644)
    link = tmp_path / "link.sqlite3"
    os.symlink(real, link)
    _harden_permissions(link)
    assert stat.S_IMODE(real.stat().st_mode) == 0o644
    conn = open_db(link)
    try:
        assert conn.execute("SELECT 1").fetchone() is not None
    finally:
        conn.close()
    assert stat.S_IMODE(real.stat().st_mode) == 0o644
