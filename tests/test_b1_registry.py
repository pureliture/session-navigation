"""B1 regression tests: adapter_registry DBError normalization, fingerprint units, CHECK."""

import sqlite3

import pytest

from session_navigation.sqlite_store import SQLiteContextStore


def register(store, scope="hermes:default:s:unknown", **kwargs):
    return store.register_adapter(scope, adapter_id="hermes", instance_id="one",
                                  capabilities={"hide": True, "summarize": True, "unhide": True}, **kwargs)



def test_registry_normalizes_sqlite_errors_to_dberror(tmp_path, monkeypatch):
    """B1: the registry mixin must not leak bare sqlite3.Error (locked/full DBs)."""
    from session_navigation.db import DBError, DBFullError

    store = SQLiteContextStore(tmp_path / "norm.db")
    register(store)

    class _FailingConn:
        def __init__(self, message):
            self.message = message

        def execute(self, *args, **kwargs):
            raise sqlite3.OperationalError(self.message)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False
    monkeypatch.setattr(store, "_conn", _FailingConn("database is locked"))
    scope = "hermes:default:s:unknown"
    with pytest.raises(DBError) as exc:
        store.adapter_session(scope)
    assert exc.value.code == "db_error"
    assert not isinstance(exc.value, DBFullError)
    with pytest.raises(DBError, match="locked"):
        store.get_adapter_control("hermes")
    with pytest.raises(DBError, match="locked"):
        store.set_adapter_control("hermes", True)
    with pytest.raises(DBError, match="locked"):
        register(store)
    with pytest.raises(DBError, match="locked"):
        store.adapter_targets(scope)
    with pytest.raises(DBError, match="locked"):
        store.child_scopes("hermes:default:s:unknown")

    monkeypatch.setattr(store, "_conn", _FailingConn("database or disk is full"))
    with pytest.raises(DBFullError) as full:
        store.adapter_session(scope)
    assert full.value.code == "db_full"
    with pytest.raises(DBFullError):
        store.set_adapter_control("hermes", True)
    store.close()

    # Input validation still raises ValueError, never DBError.
    store = SQLiteContextStore(tmp_path / "norm2.db")
    with pytest.raises(ValueError, match="invalid_adapter_registration"):
        store.set_adapter_control("  ", True)
    with pytest.raises(ValueError, match="invalid_adapter_registration"):
        store.register_adapter("bogus", adapter_id="hermes", instance_id="i",
                               capabilities={"hide": True})
    store.close()


def test_adapter_control_write_on_readonly_db_raises_dberror(tmp_path):
    """B12: real read-only DB write failure surfaces as normalized DBError.

    P0-5 already covers middleware redaction on real read-only DBs; this
    covers the adapter_control write path the get_adapter_control mock
    cannot exercise.
    """
    import os
    from session_navigation.db import DBError

    path = tmp_path / "ro-control.db"
    store = SQLiteContextStore(path)
    register(store)
    assert store.get_adapter_control("hermes") is None
    store.set_adapter_control("hermes", True)
    assert store.get_adapter_control("hermes")["enabled"] is True
    store.close()

    os.chmod(path, 0o444)
    reopened = SQLiteContextStore(path)
    try:
        # Reads still work on a read-only database.
        assert reopened.get_adapter_control("hermes")["enabled"] is True
        # Writes fail closed with the normalized contract error, never a
        # raw sqlite3.OperationalError.
        with pytest.raises(DBError) as exc:
            reopened.set_adapter_control("hermes", False)
        assert exc.value.code == "db_error"
        assert not isinstance(exc.value, sqlite3.Error)
        with pytest.raises(DBError):
            reopened.register_adapter("hermes:default:s:unknown", adapter_id="hermes",
                                      instance_id="two", capabilities={"hide": True})
    finally:
        reopened.close()


def test_bundle_fingerprint_bound_is_utf16_units(tmp_path):
    """B1: the 128 bound counts UTF-16 code units like TypeScript String.length."""
    from session_navigation.adapter_registry import _utf16_len

    assert _utf16_len("fp-1234") == 7
    assert _utf16_len("a" * 128) == 128
    assert len("\U0001F600" * 64) == 64
    assert _utf16_len("\U0001F600" * 64) == 128

    store = SQLiteContextStore(tmp_path / "fp.db")
    store.register_adapter("hermes:default:ascii:unknown", adapter_id="hermes", instance_id="i",
                           capabilities={"hide": True, "bundle_fingerprint": "f" * 128})
    assert store.adapter_session("hermes:default:ascii:unknown")["capabilities"]["bundle_fingerprint"] == "f" * 128
    store.register_adapter("hermes:default:too-long:unknown", adapter_id="hermes", instance_id="i",
                           capabilities={"hide": True, "bundle_fingerprint": "f" * 129})
    assert "bundle_fingerprint" not in store.adapter_session("hermes:default:too-long:unknown")["capabilities"]
    # 64 non-BMP chars are 64 code points but 128 UTF-16 units: accepted.
    store.register_adapter("hermes:default:non-bmp-ok:unknown", adapter_id="hermes", instance_id="i",
                           capabilities={"hide": True, "bundle_fingerprint": "\U0001F600" * 64})
    assert store.adapter_session("hermes:default:non-bmp-ok:unknown")["capabilities"]["bundle_fingerprint"] == "\U0001F600" * 64
    # 65 non-BMP chars are 130 UTF-16 units: dropped, matching TS semantics.
    store.register_adapter("hermes:default:non-bmp-long:unknown", adapter_id="hermes", instance_id="i",
                           capabilities={"hide": True, "bundle_fingerprint": "\U0001F600" * 65})
    assert "bundle_fingerprint" not in store.adapter_session("hermes:default:non-bmp-long:unknown")["capabilities"]
    store.close()


def test_adapter_control_enabled_check_constraint(tmp_path):
    """B1: the python-managed schema enforces CHECK(enabled IN (0,1))."""
    store = SQLiteContextStore(tmp_path / "check.db")
    store.set_adapter_control("hermes", True)
    store.set_adapter_control("hermes", False)
    assert store.get_adapter_control("hermes")["enabled"] is False
    with pytest.raises(sqlite3.IntegrityError):
        store.connection.execute(
            "INSERT INTO adapter_control(adapter_id, enabled, revision, updated_at)"
            " VALUES ('evil', 2, 1, 0.0)")
    store.close()
