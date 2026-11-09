"""Global pytest fixtures for test suite isolation."""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def isolate_session_navigation_db(tmp_path, monkeypatch):
    """Isolate all test DB access to a disposable temporary directory.

    Ensures tests never read or write to the live user state DB (~/.local/share/session-navigation/state.sqlite3).
    """
    test_db = tmp_path / "test_isolated_state.sqlite3"
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(test_db))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg_data"))
    yield
