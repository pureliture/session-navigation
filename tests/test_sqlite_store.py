import os
import sqlite3
import time

import pytest

from session_navigation.db import resolve_path, wal_supported
from session_navigation.model import ContextItem, Scope
from session_navigation.sqlite_store import SQLiteContextStore


def _item(item_id="item_1", tool_call_id="call_1", sha="sha1", digest="dig1", pos=0, visibility="hidden", version=1):
    return ContextItem(
        item_id=item_id,
        tool_call_id=tool_call_id,
        content_sha256=sha,
        original="original body",
        compacted="[hidden:item_1]\nbody",
        excerpt_lines=("body",),
        visibility=visibility,
        version=version,
        invocation_digest=digest,
        result_position=pos,
    )


def test_path_resolution_xdg_and_override(tmp_path, monkeypatch):
    monkeypatch.delenv("SESSION_NAVIGATION_STATE_PATH", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    p = resolve_path()
    assert str(p).endswith("session-navigation/state.sqlite3")
    assert "xdg" in str(p)

    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(tmp_path / "custom.sqlite3"))
    assert resolve_path() == tmp_path / "custom.sqlite3"

    assert resolve_path(tmp_path / "explicit.sqlite3") == tmp_path / "explicit.sqlite3"


def test_crud_and_4tuple_key(tmp_path):
    store = SQLiteContextStore(tmp_path / "s.sqlite3")
    scope = Scope("a", "p", "s")
    item = _item()
    assert store.put(scope, item).ok
    assert store.get(scope, item.item_id) is not None
    items = store.items(scope)
    assert len(items) == 1
    # fence durable
    store.fence_set(scope, item.tool_call_id, item.content_sha256, item.invocation_digest, item.result_position, item.item_id, item.version)
    assert store.fence_get(scope, item.tool_call_id, item.content_sha256, item.invocation_digest, item.result_position) == item.item_id
    store.close()


def test_cas_stale_reject(tmp_path):
    store = SQLiteContextStore(tmp_path / "s.sqlite3")
    scope = "scope1"
    item = _item(version=1)
    store.put(scope, item)
    # stale expected version
    from dataclasses import replace
    updated = replace(item, visibility="visible", version=2)
    res = store.put(scope, updated, expected_version=0)
    assert res.ok is False
    assert res.error == "version_conflict"
    assert res.item is not None
    store.close()


def test_fork_copy(tmp_path):
    store = SQLiteContextStore(tmp_path / "s.sqlite3")
    src = "src_scope"
    dst = "dst_scope"
    item = _item()
    store.put(src, item)
    store.upsert_unit(src, {"unit_id": "msg_1", "message_uid": "m1", "kind": "user"})
    store.record_call(src, "callkey", prompt_tokens=10, completion_tokens=5, total_tokens=15, cost_usd=0.1)
    counts = store.fork_scope(src, dst)
    assert counts.items == 1
    assert counts.units == 1
    assert counts.calls == 1
    assert len(store.items(dst)) == 1
    assert store.get_call(dst, "callkey") is not None
    store.close()


def test_fence_durable_across_reopen(tmp_path):
    db = tmp_path / "s.sqlite3"
    store = SQLiteContextStore(db)
    scope = "scope"
    item = _item()
    store.put(scope, item)
    store.fence_set(scope, item.tool_call_id, item.content_sha256, item.invocation_digest, item.result_position, item.item_id, item.version)
    store.close()

    store2 = SQLiteContextStore(db)
    assert store2.fence_get(scope, item.tool_call_id, item.content_sha256, item.invocation_digest, item.result_position) == item.item_id
    store2.close()


def test_wal_rollback_gating(monkeypatch, tmp_path):
    # forced DELETE by monkeypatching wal_supported False
    import session_navigation.sqlite_store as ss
    import session_navigation.db as dbmod
    monkeypatch.setattr(dbmod, "wal_supported", lambda *a, **k: False)
    monkeypatch.setattr(ss, "wal_supported", lambda *a, **k: False, raising=False)
    db = tmp_path / "s.sqlite3"
    store = SQLiteContextStore(db)
    # journal mode should be delete
    conn = sqlite3.connect(str(db))
    mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "delete"
    conn.close()
    store.close()


def test_db_full_simulation(tmp_path, monkeypatch):
    store = SQLiteContextStore(tmp_path / "s.sqlite3")
    scope = "scope"
    item = _item()

    class BoomConn:
        def execute(self, *a, **k):
            raise sqlite3.OperationalError("database or disk is full")
        def commit(self):
            pass
        def rollback(self):
            pass
    store._conn = BoomConn()
    res = store.put(scope, item)
    assert res.ok is False
    assert res.error == "db_full"
    store.close()


def test_no_ttl_cap_proof(tmp_path):
    store = SQLiteContextStore(tmp_path / "s.sqlite3")
    scope = "scope"
    # insert many items
    for i in range(50):
        it = _item(item_id=f"item_{i}", tool_call_id=f"call_{i}", sha=f"sha{i}", digest=f"dig{i}", version=1)
        assert store.put(scope, it).ok
    assert len(store.items(scope)) == 50
    # reopen keeps all
    db = store.path
    store.close()
    store2 = SQLiteContextStore(db)
    assert len(store2.items(scope)) == 50
    store2.close()


def test_restore_expected_version(tmp_path):
    store = SQLiteContextStore(tmp_path / "s.sqlite3")
    scope = "scope"
    item = _item(version=1)
    store.put(scope, item)
    res = store.restore(scope, item.item_id, expected_version=1)
    assert res.ok
    assert res.item.visibility == "visible"
    # stale
    res2 = store.restore(scope, item.item_id, expected_version=1)
    assert res2.ok is False
    assert res2.error == "version_conflict"
    store.close()


def test_units_list_and_calls(tmp_path):
    store = SQLiteContextStore(tmp_path / "s.sqlite3")
    scope = "scope"
    store.upsert_unit(scope, unit_id="u1", message_uid="m1", kind="user", char_count=10)
    assert len(store.list_units(scope)) == 1
    assert len(store.list_units(scope, message_uid="m1")) == 1
    store.record_call(scope, "ck", prompt_tokens=1, completion_tokens=2, total_tokens=3, cost_usd=0.5)
    c = store.get_call(scope, "ck")
    assert c is not None
    assert c["total_tokens"] == 3
    store.close()

def test_concurrent_first_open_creates_schema_once(tmp_path):
    import threading
    db = tmp_path / "concurrent.sqlite3"
    errors: list[str] = []
    barrier = threading.Barrier(8)

    def _opener(n: int):
        try:
            barrier.wait(timeout=10)
            store = SQLiteContextStore(str(db))
            store.upsert_unit("scope", unit_id=f"u{n}", kind="tool_result")
            store.close()
        except Exception as exc:
            errors.append(f"{n}: {exc}")

    threads = [threading.Thread(target=_opener, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert errors == [], errors
    store = SQLiteContextStore(str(db))
    assert len(store.list_units("scope")) == 8
    store.close()
