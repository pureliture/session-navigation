from __future__ import annotations

import stat
from pathlib import Path

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
