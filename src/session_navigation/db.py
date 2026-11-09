"""SQLite path resolution, connection setup, and schema management."""
from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "1"

DB_FILENAME = "state.sqlite3"
APP_DIRNAME = "session-navigation"


class DBError(Exception):
    """Generic SQLite-backed persistence error."""

    code = "db_error"


class DBFullError(DBError):
    """Raised when the underlying SQLite database is full."""

    code = "db_full"


def _parse_version(value: str) -> tuple[int, ...]:
    parts = []
    for chunk in str(value).split("."):
        try:
            parts.append(int(chunk))
        except ValueError:
            parts.append(0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def wal_supported(version: str | None = None) -> bool:
    """Return whether WAL journal mode should be enabled."""
    ver = version or sqlite3.sqlite_version
    if _parse_version(ver) >= (3, 51, 3):
        return True
    return str(ver) in {"3.44.6", "3.50.7"}


def resolve_path(explicit: str | os.PathLike[str] | None = None) -> Path:
    """Resolve the SQLite state file path with overrides and XDG support."""
    if explicit is not None and str(explicit).strip() != "":
        return Path(explicit).expanduser()
    env_path = os.environ.get("SESSION_NAVIGATION_STATE_PATH")
    if env_path:
        return Path(env_path).expanduser()
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        base = Path(xdg).expanduser()
    else:
        base = Path.home() / ".local" / "share"
    return base / APP_DIRNAME / DB_FILENAME


# Aliases for callers/tests that use different naming.
resolve_state_path = resolve_path
get_state_path = resolve_path
state_path = resolve_path
default_state_path = resolve_path


def _configure_connection(conn: sqlite3.Connection, path: Path) -> None:
    conn.execute("PRAGMA busy_timeout=5000")
    want = "wal" if wal_supported() else "delete"
    # Gate per D7: WAL only on SQLite >= 3.51.3 (or backported 3.44.6/3.50.7),
    # else rollback journal (delete). When the version gate blocks WAL, the
    # first attempt is DELETE; a WAL-mode file stays WAL until checkpointed,
    # so the fallback MUST allow WAL (live DB was created in WAL by the
    # newer OMP daemon Python). Accept either verified mode, never unverified.
    allowed = {want}
    if want == "delete":
        allowed.add("wal")
    else:
        allowed.add("delete")
    got = ""
    for mode in ([want, "delete", "wal"] if want == "delete" else [want]):
        try:
            row = conn.execute(f"PRAGMA journal_mode={mode.upper()}").fetchone()
            got = str(row[0]).lower() if row else ""
        except sqlite3.Error:
            got = ""
        if got in allowed:
            break
    if got not in allowed:
        try:
            row = conn.execute("PRAGMA journal_mode").fetchone()
            got = str(row[0]).lower() if row else ""
        except sqlite3.Error:
            pass
    if got not in allowed:
        raise DBError(f"journal_mode unverified (want={want}, got={got or 'unknown'})")
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA synchronous=NORMAL" if got == "wal" else "PRAGMA synchronous=FULL")
    except sqlite3.Error:
        pass


def _is_full_error(exc: BaseException) -> bool:
    message = str(exc).lower()
    if "full" in message or "disk" in message:
        return True
    code = getattr(exc, "sqlite_errorcode", None)
    if code in (13, 13):  # SQLITE_FULL
        return True
    return False


_SCHEMA_SQL = """
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS items (
            scope_key TEXT NOT NULL,
            item_id TEXT NOT NULL,
            tool_call_id TEXT,
            result_position INTEGER DEFAULT 0,
            content_sha256 TEXT,
            invocation_digest TEXT NOT NULL,
            original TEXT,
            compacted TEXT,
            excerpt_lines TEXT DEFAULT '[]',
            visibility TEXT CHECK(visibility IN ('hidden','visible')) DEFAULT 'hidden',
            version INTEGER DEFAULT 1,
            tool_name TEXT,
            compaction_source TEXT,
            invocation_snapshot TEXT,
            context_hint TEXT,
            invocation_options_omitted INTEGER DEFAULT 0,
            created_at REAL,
            updated_at REAL,
            PRIMARY KEY(scope_key, item_id),
            UNIQUE(scope_key, tool_call_id, content_sha256, invocation_digest, result_position)
        );

        CREATE TABLE IF NOT EXISTS identities (
            scope_key TEXT NOT NULL,
            tool_call_id TEXT NOT NULL,
            content_sha256 TEXT NOT NULL,
            invocation_digest TEXT NOT NULL,
            result_position INTEGER DEFAULT 0,
            item_id TEXT NOT NULL,
            version INTEGER DEFAULT 1,
            updated_at REAL,
            PRIMARY KEY(scope_key, tool_call_id, content_sha256, invocation_digest, result_position)
        );

        CREATE TABLE IF NOT EXISTS units (
            scope_key TEXT NOT NULL,
            unit_id TEXT NOT NULL,
            message_uid TEXT,
            kind TEXT CHECK(kind IN ('user','assistant','tool_call','tool_result')),
            parent_unit_id TEXT,
            tool_call_id TEXT,
            content_sha256 TEXT,
            char_count INTEGER DEFAULT 0,
            tokens_display TEXT DEFAULT '—',
            visibility TEXT DEFAULT 'visible',
            version INTEGER DEFAULT 1,
            updated_at REAL,
            PRIMARY KEY(scope_key, unit_id)
        );
        CREATE INDEX IF NOT EXISTS idx_units_scope_message ON units(scope_key, message_uid);

        CREATE TABLE IF NOT EXISTS calls (
            scope_key TEXT NOT NULL,
            call_key TEXT NOT NULL,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            total_tokens INTEGER,
            cost_usd REAL,
            recorded_at REAL,
            PRIMARY KEY(scope_key, call_key)
        );
        """


def create_schema(conn: sqlite3.Connection) -> None:
    """Create the v1 schema if it does not already exist."""
    conn.executescript(_SCHEMA_SQL)
    conn.execute(
        "INSERT INTO meta(key, value) VALUES ('schema_version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (SCHEMA_VERSION,),
    )
    conn.commit()


create_tables = create_schema
init_schema = create_schema
ensure_schema = create_schema


def open_db(path: str | os.PathLike[str] | None = None) -> sqlite3.Connection:
    """Open and configure a SQLite connection, creating parent dirs and schema."""
    resolved = resolve_path(path)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(resolved), timeout=30, check_same_thread=False)
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        _configure_connection(conn, resolved)
        # Concurrent first-open: serialize on BEGIN IMMEDIATE and verify ALL
        # tables (meta-first scripts commit mid-way; meta presence alone is
        # not proof the schema is complete). Read-only fast path first: a
        # complete schema never needs a write transaction.
        required = {"meta", "items", "identities", "units", "calls"}
        try:
            have = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        except sqlite3.OperationalError:
            have = set()
        if required.issubset(have):
            try:
                conn.execute("INSERT OR IGNORE INTO meta(key,value) VALUES ('schema_version','1')")
                conn.commit()
            except sqlite3.OperationalError:
                pass  # readonly: schema is complete, version bump is best-effort
            return conn
        for attempt in range(20):
            try:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    have = {r[0] for r in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'")}
                    if not required.issubset(have):
                        conn.executescript(_SCHEMA_SQL)
                        conn.execute(
                            "INSERT INTO meta(key, value) VALUES ('schema_version', ?) "
                            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                            (SCHEMA_VERSION,))
                    else:
                        conn.execute("INSERT OR IGNORE INTO meta(key,value) VALUES ('schema_version','1')")
                    conn.commit()
                    break
                except Exception:
                    try:
                        conn.rollback()
                    except sqlite3.Error:
                        pass
                    raise
            except sqlite3.OperationalError:
                if attempt == 19:
                    raise
                time.sleep(0.05 * (attempt + 1))
        have = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if not required.issubset(have):
            raise DBError(f"schema incomplete after open: missing={sorted(required - have)}")
    except Exception as exc:
        conn.close()
        if _is_full_error(exc):
            raise DBFullError(str(exc)) from exc
        raise DBError(str(exc)) from exc
    return conn


connect = open_db
connect_db = open_db
open_database = open_db
get_connection = open_db


def db_info(path: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Return basic metadata about the SQLite state file."""
    resolved = resolve_path(path)
    info: dict[str, Any] = {
        "path": str(resolved),
        "exists": resolved.exists(),
        "sqlite_version": sqlite3.sqlite_version,
        "wal_supported": wal_supported(),
    }
    if resolved.exists():
        try:
            conn = sqlite3.connect(str(resolved), timeout=5, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
            info["journal_mode"] = mode
            try:
                row = conn.execute(
                    "SELECT value FROM meta WHERE key='schema_version'"
                ).fetchone()
                info["schema_version"] = row[0] if row else None
            except sqlite3.Error:
                info["schema_version"] = None
            conn.close()
        except sqlite3.Error as exc:
            info["error"] = str(exc)
    return info


def now() -> float:
    return time.time()
