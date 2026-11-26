"""Safe bounded performance diagnostics for Hermes session-navigation integration."""

from __future__ import annotations

from collections import deque
import json
import logging
import os
import re
import sys
import threading
import time
from typing import Any

MAX_PERF_DIAG_ENTRIES = 128
DEFAULT_SLOW_MS = 100.0
_SAFE_OP_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_SAFE_CODE_RE = re.compile(r"^[A-Za-z0-9_.-]{1,40}$")
_ALLOWLIST_KEYS = (
    "plugin",
    "op",
    "ts",
    "duration_ms",
    "ok",
    "error_code",
    "row_count",
    "unit_count",
    "byte_count",
    "cache_hit",
    "batch_size",
)

_logger = logging.getLogger("session_navigation.perf")
_lock = threading.Lock()
_ring: deque[dict[str, Any]] = deque(maxlen=MAX_PERF_DIAG_ENTRIES)


_DIAG_MODES = {
    "slow": "slow",
    "1": "verbose",
    "true": "verbose",
    "verbose": "verbose",
    "debug": "verbose",
}
_ERROR_ALIASES = {
    "DBFullError": "db_full",
    "DBError": "db_error",
    "TimeoutError": "timeout",
}


def perf_diag_mode() -> str:
    raw = os.environ.get("SESSION_NAVIGATION_PERF_DIAG", "").strip().lower()
    resolved = _DIAG_MODES.get(raw, "off")
    return resolved


def sanitize_error_code(error: BaseException | str | None) -> str:
    """Return a short bounded ASCII error code without exception messages."""
    code = "error"
    if isinstance(error, str):
        trimmed = error.strip().lower()
        if _SAFE_CODE_RE.match(trimmed):
            code = trimmed
    elif isinstance(error, BaseException):
        name = type(error).__name__
        if name in _ERROR_ALIASES:
            code = _ERROR_ALIASES[name]
        else:
            lowered = name.strip().lower()
            if _SAFE_CODE_RE.match(lowered):
                code = lowered
    return code


def _nonneg_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if value >= 0 else None


def _nonneg_float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    if f < 0 or f != f:  # NaN / negative guard
        return None
    return round(f, 2)


def record_perf(
    op: str,
    *,
    duration_ms: float,
    ok: bool,
    ts: int | None = None,
    error_code: str | None = None,
    row_count: int | None = None,
    unit_count: int | None = None,
    byte_count: int | None = None,
    cache_hit: bool | None = None,
    batch_size: int | None = None,
    slow_threshold_ms: float = DEFAULT_SLOW_MS,
) -> dict[str, Any]:
    """Record a sanitized diagnostic metric in memory and optionally to stderr."""
    mode = perf_diag_mode()
    dur = _nonneg_float(duration_ms)
    if dur is None:
        dur = 0.0
    safe_op = op if isinstance(op, str) and _SAFE_OP_RE.match(op) else "unknown_op"
    safe_ts = _nonneg_int(ts)
    if safe_ts is None:
        safe_ts = int(time.time() * 1000)

    entry: dict[str, Any] = {
        "plugin": "hermes",
        "op": safe_op,
        "ts": safe_ts,
        "duration_ms": dur,
        "ok": bool(ok),
    }

    if not ok and error_code is not None:
        entry["error_code"] = sanitize_error_code(error_code)

    for key, val in (
        ("row_count", _nonneg_int(row_count)),
        ("unit_count", _nonneg_int(unit_count)),
        ("byte_count", _nonneg_int(byte_count)),
        ("batch_size", _nonneg_int(batch_size)),
    ):
        if val is not None:
            entry[key] = val

    if isinstance(cache_hit, bool):
        entry["cache_hit"] = cache_hit

    filtered = {key: entry[key] for key in _ALLOWLIST_KEYS if key in entry}

    with _lock:
        _ring.append(filtered)

    is_slow = (not filtered["ok"]) or dur >= max(0.0, float(slow_threshold_ms))
    if mode == "verbose" or (mode == "slow" and is_slow):
        payload = f"[session-nav:perf] {json.dumps(filtered, separators=(',', ':'))}\n"
        _logger.debug("%s", payload.rstrip())
        try:
            sys.stderr.write(payload)
        except OSError:
            pass

    return dict(filtered)


def recent_perf(limit: int = MAX_PERF_DIAG_ENTRIES) -> list[dict[str, Any]]:
    n = max(0, min(MAX_PERF_DIAG_ENTRIES, int(limit)))
    if n == 0:
        return []
    with _lock:
        items = list(_ring)[-n:]
    return [dict(item) for item in items]


def clear_perf() -> None:
    with _lock:
        _ring.clear()
