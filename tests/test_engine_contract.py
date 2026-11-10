from dataclasses import replace
import sqlite3

import pytest

from session_navigation import db
from session_navigation.adapter_registry import MAX_TARGETS
from session_navigation.model import ToolResultRecord, compute_invocation_digest, compute_sha256
from session_navigation.sqlite_store import SQLiteContextStore


def record(index=0, content="alpha details " * 200):
    invocation = {"tool_name": "read_file", "arguments": {"path": "source.txt"}}
    return ToolResultRecord(str(index), content=content, content_sha256=compute_sha256(content),
                            invocation=invocation, invocation_digest=compute_invocation_digest(invocation))


def register(store, scope="hermes:default:s:unknown", **kwargs):
    return store.register_adapter(scope, adapter_id="hermes", instance_id="one",
                                  capabilities={"hide": True, "summarize": True, "unhide": True}, **kwargs)


def test_adopts_v1_in_place(tmp_path):
    path = tmp_path / "legacy.db"
    conn = sqlite3.connect(path)
    for sql in db._SCHEMA_SQL.split(";"):
        if sql.strip() and "adapter_" not in sql:
            conn.execute(sql)
    conn.execute("INSERT INTO meta VALUES ('schema_version','1')")
    conn.execute("INSERT INTO calls(scope_key,call_key,total_tokens) VALUES ('old','call',42)")
    conn.commit()
    conn.close()
    conn = db.open_db(path)
    assert dict(conn.execute("SELECT key,value FROM meta")) == {"schema_version": "2", "engine_protocol_version": "1"}
    assert conn.execute("SELECT total_tokens FROM calls").fetchone()[0] == 42
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    conn.close()


def test_migration_rollback_is_atomic(tmp_path, monkeypatch):
    path = tmp_path / "broken.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)")
    conn.execute("INSERT INTO meta VALUES ('schema_version','1')")
    conn.commit()
    monkeypatch.setattr(db, "_SCHEMA_SQL", db._SCHEMA_SQL + "; THIS IS INVALID SQL;")
    with pytest.raises(sqlite3.Error):
        db.create_schema(conn)
    assert conn.execute("SELECT value FROM meta").fetchone()[0] == "1"
    assert conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [("meta",)]
    conn.close()


@pytest.mark.parametrize("version", ["2", "999", "invalid"])
def test_future_protocol_refused_without_writes(tmp_path, version):
    path = tmp_path / "future.db"
    conn = db.open_db(path)
    conn.execute("UPDATE meta SET value=? WHERE key='engine_protocol_version'", (version,))
    conn.commit()
    conn.close()
    before = path.read_bytes()
    with pytest.raises(db.EngineProtocolError) as error:
        db.open_db(path)
    assert error.value.code == "engine_protocol_incompatible"
    assert path.read_bytes() == before


def test_long_lived_writer_refuses_protocol_upgrade(tmp_path):
    path = tmp_path / "future.db"
    conn = db.open_db(path)
    other = sqlite3.connect(path)
    other.execute("UPDATE meta SET value='2' WHERE key='engine_protocol_version'")
    other.commit()
    with pytest.raises(db.EngineProtocolError):
        conn.execute("INSERT INTO calls(scope_key,call_key) VALUES ('x','y')")
    other.close()
    conn.close()


def test_existing_wal_converts_to_delete(tmp_path):
    path = tmp_path / "wal.db"
    conn = db.open_db(path)
    conn.close()
    other = sqlite3.connect(path)
    other.execute("PRAGMA journal_mode=WAL")
    other.close()
    conn = db.open_db(path)
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    conn.close()


@pytest.mark.parametrize("safe", [True, False])
def test_busy_wal_retained_only_by_safe_runtime(tmp_path, monkeypatch, safe):
    path = tmp_path / "busy.db"
    seed = db.open_db(path)
    seed.close()
    reader = sqlite3.connect(path)
    reader.execute("PRAGMA journal_mode=WAL")
    reader.execute("BEGIN")
    reader.execute("SELECT * FROM meta").fetchall()
    monkeypatch.setattr(db, "wal_supported", lambda: safe)
    if safe:
        conn = db.open_db(path)
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        conn.execute("INSERT INTO calls(scope_key,call_key) VALUES ('x','y')")
        conn.commit()
        conn.close()
    else:
        with pytest.raises(db.UnsafeJournalError, match="below the WAL safety gate"):
            db.open_db(path)
    reader.rollback()
    reader.close()


def test_registration_rate_limit_capability_change_and_alias(tmp_path):
    with_store = SQLiteContextStore(tmp_path / "s.db", scope_aliases={"hermes": ("unknown", "default")})
    assert register(with_store, now=100)
    assert not register(with_store, now=101)
    assert register(with_store, now=400)
    assert with_store.adapter_can("hermes:default:s:default", "hide")
    assert register(with_store, enabled=False, now=401)
    assert not with_store.adapter_can("hermes:default:s:unknown", "hide")
    assert register(with_store, adapter_protocol=2, now=402)
    assert not with_store.adapter_can("hermes:default:s:unknown", "hide")
    assert with_store.adapter_session("hermes:default:other:unknown") is None
    with_store.close()


def test_targets_verified_bounded_and_do_not_seed_items(tmp_path):
    store = SQLiteContextStore(tmp_path / "s.db", scope_aliases={"hermes": ("unknown", "default")})
    scope = "hermes:default:s:unknown"
    register(store)
    store.publish_targets(scope, [(record(i), {}) for i in range(MAX_TARGETS + 2)])
    targets = store.adapter_targets("hermes:default:s:default")
    assert len(targets) == MAX_TARGETS
    assert targets[0]["tool_call_id"] == "2"
    assert targets[0]["tool_name"] == "read_file"
    assert store.items(scope) == ()
    store.publish_targets(scope, [])
    with pytest.raises(ValueError, match="invalid_target_identity"):
        store.publish_targets(scope, [(record("good"), {}), (replace(record("bad"), content_sha256="bad"), {})])
    assert len(store.adapter_targets(scope)) == MAX_TARGETS
    store.close()


def test_target_byte_bound_and_missing_adapter(tmp_path, monkeypatch):
    import session_navigation.adapter_registry as registry
    monkeypatch.setattr(registry, "MAX_TARGET_BYTES", 200)
    store = SQLiteContextStore(tmp_path / "s.db")
    scope = "hermes:default:s:unknown"
    with pytest.raises(ValueError, match="adapter_unavailable"):
        store.publish_targets(scope, [(record(), {})])
    register(store)
    store.publish_targets(scope, [(record(0, "x" * 80), {}), (record(1, "y" * 80), {})])
    assert len(store.adapter_targets(scope)) == 1
    store.publish_targets(scope, [(record(2, "z" * 201), {})])
    assert len(store.adapter_targets(scope)) == 1
    store.close()
