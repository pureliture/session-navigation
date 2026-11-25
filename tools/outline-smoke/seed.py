#!/usr/bin/env python3
"""Idempotent Paseo outline-smoke sandbox seeder.

Builds an isolated Paseo home and fake HOME under --root (default: /tmp/paseo-sandbox),
prunes a read-only snapshot of the target Hermes session, starts `paseo daemon run`
with web UI and session-navigation plugin enabled, verifies agent listing and
ServiceClient scope/timeline gates, and prints the ready Web UI URL and agent IDs.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_ROOT = Path("/tmp/paseo-sandbox")
# Loopback only: the sandbox daemon must never listen on all interfaces.
LISTEN_ADDR = "127.0.0.1:17680"
WEB_UI_URL = "http://127.0.0.1:17680/"
OMP_AGENT_ID = "5c4bc793-eb5d-40c4-9dc2-1fe5f3f4ff4f"
OMP_SESSION_ID = "01a1dcda-2be6-71ff-adad-5dd591ed6d51"
OMP_SCOPE_KEY = f"omp:default:{OMP_SESSION_ID}:default"
OMP_JSONL_NAME = f"2026-11-15T01-37-28-038Z_{OMP_SESSION_ID}.jsonl"
OMP_CWD_KEY = "-Projects"

HERMES_AGENT_ID = "7b2e4a11-9c3d-4e5f-8a6b-1d2f3a4b5c6d"
HERMES_SESSION_ID = "local-19b60bfd28c6c4fb469bd8ad331ff646dfec6c3e9ebd3ed3f1e2419e0ca59826"
HERMES_SCOPE_KEY = f"hermes:default:{HERMES_SESSION_ID}:unknown"
HERMES_WORKSPACE_ID = "wks_6e914dd0930622d7"
HERMES_MODEL = "opencode-go:beam-free"
HERMES_THINKING = "max"
HERMES_PROVIDER = "hermes-default"

STUB_MODEL = "gpt-4o-mini"
STUB_BASE_URL = "http://127.0.0.1:19080/v1"
def target_cwd() -> str:
    return str(Path.home() / "Projects")

def project_dir_key() -> str:
    # Derive the paseo agents directory name from the real checkout path
    # without assuming a hardcoded "Users-" prefix or separator style: older
    # checkouts used dashes, newer ones underscores. The first variant that
    # exists on disk wins; otherwise fall back to dashes.
    parts = Path(target_cwd()).parts[1:]
    for key in ("-".join(parts), "_".join(parts)):
        if (real_home() / ".paseo" / "agents" / key).is_dir():
            return key
    return "-".join(parts)

EXPECTED_HERMES_MESSAGES = 1089
EXPECTED_HERMES_SESSIONS = 1
EXPECTED_LIST_LIMIT = 150
EXPECTED_LIST_TOTAL_ROWS = 755


def real_home() -> Path:
    return Path.home()


def write_text_if_changed(path: Path, content: str) -> None:
    if path.is_file():
        try:
            if path.read_text(encoding="utf-8") == content:
                return
        except OSError:
            pass
    path.write_text(content, encoding="utf-8")


def write_synthetic_model_configs(fakehome: Path) -> None:
    """Offline provider configs: no real credentials or remote model catalogs."""
    hermes_home = fakehome / ".hermes"
    hermes_home.mkdir(parents=True, exist_ok=True)
    hermes_config = {
        "gateway": {"multiplex_profiles": False},
        "approvals": {"mode": "manual", "timeout": 60},
        "model": {"provider": "openai", "default": STUB_MODEL, "base_url": STUB_BASE_URL},
        "auxiliary": {"title_generation": {"enabled": False}},
        "model_catalog": {"enabled": False},
        "models_dev": {"url": STUB_BASE_URL.replace("/v1", "/models-dev-offline")},
    }
    write_text_if_changed(
        hermes_home / "config.yaml",
        json.dumps(hermes_config, indent=2, ensure_ascii=False) + "\n",
    )

    omp_agent = fakehome / ".omp" / "agent"
    omp_agent.mkdir(parents=True, exist_ok=True)
    omp_models = {
        "providers": {
            "jetbrains-bridge": {
                "baseUrl": STUB_BASE_URL,
                "apiKey": "local",
                "api": "openai-completions",
                "auth": "none",
                "models": [
                    {
                        "id": model_id,
                        "name": model_id,
                        "input": ["text"],
                        "contextWindow": 200000,
                        "maxTokens": 8192,
                        "supportsTools": True,
                    }
                    for model_id in (
                        "jetbrains:claude-haiku-5-5",
                        "jetbrains:gemini-4-carbon",
                        "jetbrains:gpt-6.1-terra",
                        "gpt-6.1-terra",
                    )
                ],
            },
            "openai-codex": {
                "baseUrl": STUB_BASE_URL,
                "apiKey": "local",
                "api": "openai-completions",
                "auth": "none",
                "models": [
                    {
                        "id": "gpt-6.1-terra",
                        "name": "gpt-6.1-terra",
                        "input": ["text"],
                        "contextWindow": 200000,
                        "maxTokens": 8192,
                        "supportsTools": True,
                    }
                ],
            },
        }
    }
    write_text_if_changed(
        omp_agent / "models.yml",
        json.dumps(omp_models, indent=2, ensure_ascii=False) + "\n",
    )



def write_direct_acp_wrapper(fakehome: Path) -> Path:
    """Run Hermes ACP in-process so the sandbox never needs a gateway."""
    hermes_root = real_home() / ".hermes" / "hermes-agent"
    wrapper = fakehome / ".hermes" / "direct_acp.py"
    source = f'''\
#!/usr/bin/env python3
import asyncio
import sys

sys.path.insert(0, {str(hermes_root)!r})

import hermes_bootstrap

hermes_bootstrap.harden_import_path()

import acp
from acp_adapter.entry import _load_env, _setup_logging
from acp_adapter.server import HermesACPAgent
from acp_adapter.session import SessionManager


def main() -> None:
    _setup_logging()
    _load_env()
    agent = HermesACPAgent(session_manager=SessionManager())

    async def serve() -> None:
        try:
            await acp.run_agent(agent, use_unstable_protocol=True)
        finally:
            close = getattr(agent, "aclose", None)
            if close is not None:
                await close()
    asyncio.run(serve())


if __name__ == "__main__":
    main()
'''
    write_text_if_changed(wrapper, source)
    os.chmod(wrapper, 0o700)
    return wrapper

def read_server_id(paseo_home: Path) -> str | None:
    sid_path = paseo_home / "server-id"
    if not sid_path.is_file():
        return None
    val = sid_path.read_text(encoding="utf-8").strip()
    return val or None


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def iso_utc(ts: float | None) -> str:
    if ts is None:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def read_pid_lock(paseo_home: Path) -> int | None:
    pid_file = paseo_home / "paseo.pid"
    if not pid_file.exists():
        return None
    try:
        raw = pid_file.read_text(encoding="utf-8").strip()
        if not raw:
            return None
        if raw.startswith("{"):
            data = json.loads(raw)
            pid = int(data["pid"])
        else:
            pid = int(raw)
        # Never trust a non-positive PID: 0/-1 would signal the whole process
        # group (or every process) instead of one daemon, and 1 is init.
        if pid <= 1:
            return None
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError, KeyError, TypeError):
        return None

def stop_sandbox_daemon(paseo_home: Path) -> None:
    pid = read_pid_lock(paseo_home)
    if pid is None:
        return
    try:
        subprocess.run(
            ["paseo", "daemon", "stop", "--home", str(paseo_home)],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        pass
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        if read_pid_lock(paseo_home) is None:
            return
        time.sleep(0.2)
    pid = read_pid_lock(paseo_home)
    if pid is not None:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            return
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if read_pid_lock(paseo_home) is None:
                return
            time.sleep(0.2)
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass



def stop_sandbox_hermes(fakehome: Path) -> None:
    """Stop stale Hermes processes pinned to this sandbox HOME.

    A prior gateway can hold a deleted state.db WAL inode, which blocks every
    later ACP session restore with `storage_unavailable`/`not_found`.
    """
    root = str(fakehome)
    markers = ("gateway run", "hermes_cli.main", "acp_adapter.entry")
    pids: list[int] = []
    try:
        proc = subprocess.run(
            ["ps", "-axo", "pid=,command="],
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return
    for line in proc.stdout.splitlines():
        if root not in line or not any(marker in line for marker in markers):
            continue
        try:
            pid = int(line.strip().split(None, 1)[0])
        except (ValueError, IndexError):
            continue
        if pid != os.getpid():
            pids.append(pid)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        if not pids:
            return
        alive = []
        for pid in pids:
            try:
                os.kill(pid, 0)
                alive.append(pid)
            except OSError:
                pass
        pids = alive
        if not pids:
            return
        time.sleep(0.2)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass

def health_ok(url: str = "http://127.0.0.1:17680/api/health") -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1.5) as resp:
            if resp.status != 200:
                return False
            data = json.load(resp)
            return data.get("status") == "ok"
    except (OSError, ValueError, urllib.error.URLError):
        return False


def stage_omp_session(fakehome: Path) -> Path:
    src = real_home() / ".omp" / "agent" / "sessions" / OMP_CWD_KEY / OMP_JSONL_NAME
    if not src.is_file():
        raise FileNotFoundError(f"Missing real OMP session file: {src}")
    dst_dir = fakehome / ".omp" / "agent" / "sessions" / OMP_CWD_KEY
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / OMP_JSONL_NAME
    src_size = src.stat().st_size
    if dst.is_file() and dst.stat().st_size == src_size:
        return dst
    tmp = dst.with_suffix(".jsonl.tmp")
    shutil.copy2(src, tmp)
    tmp.replace(dst)
    return dst


def is_pruned_hermes_db_valid(db_path: Path) -> bool:
    if not db_path.is_file():
        return False
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            sess_cnt = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
            msg_cnt = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            has_target = conn.execute(
                "SELECT 1 FROM sessions WHERE id = ?", (HERMES_SESSION_ID,)
            ).fetchone()
            return (
                sess_cnt == EXPECTED_HERMES_SESSIONS
                and msg_cnt == EXPECTED_HERMES_MESSAGES
                and has_target is not None
            )
        finally:
            conn.close()
    except sqlite3.Error:
        return False

# Sandbox-generated Hermes env: the seeder must never copy the real ~/.hermes
# .env (API keys and other secrets) into the /tmp sandbox.
SYNTHETIC_HERMES_ENV = """\
# Generated by tools/outline-smoke/seed.py — synthetic sandbox env, no secrets.
# The smoke sandbox verifies outline reads only; no provider credentials needed.
HERMES_PROFILE=default
"""


def write_synthetic_hermes_env(fakehome: Path) -> None:
    root_env = fakehome / ".hermes" / ".env"
    write_text_if_changed(root_env, SYNTHETIC_HERMES_ENV)
    os.chmod(root_env, 0o600)


def stage_hermes_default_profile(fakehome: Path) -> Path:
    """Stage the sandbox `default` Hermes profile directory.

    Copies only non-secret `profile.yaml`; always writes a synthetic `.env`
    (0600) instead of copying the real one.
    """
    src_default_dir = real_home() / ".hermes" / "profiles" / "default"
    dst_default_dir = fakehome / ".hermes" / "profiles" / "default"
    dst_default_dir.mkdir(parents=True, exist_ok=True)

    src_profile = src_default_dir / "profile.yaml"
    if src_profile.is_file():
        shutil.copy2(src_profile, dst_default_dir / "profile.yaml")

    dst_env = dst_default_dir / ".env"
    write_text_if_changed(dst_env, SYNTHETIC_HERMES_ENV)
    os.chmod(dst_env, 0o600)
    return dst_default_dir


def stage_hermes_profile(fakehome: Path) -> tuple[Path, dict[str, object]]:
    src_atlas_db = real_home() / ".hermes" / "profiles" / "atlas" / "state.db"
    if not src_atlas_db.is_file():
        raise FileNotFoundError(f"Missing real Hermes atlas DB: {src_atlas_db}")

    stage_hermes_default_profile(fakehome)
    write_synthetic_hermes_env(fakehome)
    root_dir = fakehome / ".hermes"
    dst_db = root_dir / "state.db"
    if not is_pruned_hermes_db_valid(dst_db):
        for suffix in ("", "-wal", "-shm", ".tmp"):
            candidate = Path(str(dst_db) + suffix)
            if candidate.exists():
                candidate.unlink()

        tmp_db = dst_db.with_suffix(".db.tmp")
        ro_conn = sqlite3.connect(f"file:{src_atlas_db}?mode=ro", uri=True)
        try:
            escaped = str(tmp_db).replace("'", "''")
            ro_conn.execute(f"VACUUM INTO '{escaped}'")
        finally:
            ro_conn.close()

        rw_conn = sqlite3.connect(tmp_db)
        try:
            rw_conn.execute("PRAGMA journal_mode=DELETE")
            with rw_conn:
                # Strict delete order to satisfy sessions_runtime_ledger_delete_guard.
                rw_conn.execute("DELETE FROM worker_receipts")
                rw_conn.execute("DELETE FROM worker_executions")
                rw_conn.execute("DELETE FROM session_admissions")
                rw_conn.execute(
                    "DELETE FROM session_model_usage WHERE session_id != ?",
                    (HERMES_SESSION_ID,),
                )
                rw_conn.execute(
                    "DELETE FROM messages WHERE session_id != ?",
                    (HERMES_SESSION_ID,),
                )
                rw_conn.execute(
                    "DELETE FROM sessions WHERE id != ?",
                    (HERMES_SESSION_ID,),
                )
                rw_conn.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
                rw_conn.execute(
                    "INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('rebuild')"
                )
            rw_conn.execute("VACUUM")
        finally:
            rw_conn.close()

        tmp_db.replace(dst_db)

    if not is_pruned_hermes_db_valid(dst_db):
        raise RuntimeError(f"Pruned Hermes DB validation failed: {dst_db}")

    rw_conn = sqlite3.connect(dst_db)
    try:
        sandbox_cwd = target_cwd()
        model_config = json.dumps(
            {
                "cwd": sandbox_cwd,
                "provider": "openai",
                "api_mode": "chat_completions",
                "base_url": STUB_BASE_URL,
            }
        )
        with rw_conn:
            rw_conn.execute(
                "UPDATE sessions SET cwd = ?, source = 'acp', model = ?, "
                "model_config = ?, ended_at = NULL WHERE id = ?",
                (sandbox_cwd, STUB_MODEL, model_config, HERMES_SESSION_ID),
            )
    finally:
        rw_conn.close()

    conn = sqlite3.connect(f"file:{dst_db}?mode=ro", uri=True)
    try:
        row = conn.execute(
            "SELECT id, started_at, ended_at, title FROM sessions WHERE id = ?",
            (HERMES_SESSION_ID,),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"Target session {HERMES_SESSION_ID} missing after prune")
        session_meta = {
            "id": row[0],
            "started_at": row[1],
            "ended_at": row[2],
            "title": row[3] or "Hermes smoke session",
        }
    finally:
        conn.close()

    return dst_db, session_meta


def write_sandbox_config(paseo_home: Path, fakehome: Path) -> Path:
    paseo_home.mkdir(parents=True, exist_ok=True)
    plugin_dir = repo_root() / "paseo-plugin"
    if not (plugin_dir / "paseo-plugin.json").is_file():
        raise FileNotFoundError(f"Missing paseo-plugin directory: {plugin_dir}")
    wrapper = write_direct_acp_wrapper(fakehome)
    hermes_python = real_home() / ".hermes/hermes-agent/.venv/bin/python"

    config = {
        "version": 1,
        "daemon": {
            "listen": LISTEN_ADDR,
            "cors": {
                "allowedOrigins": ["https://app.paseo.sh"],
            },
            "relay": {
                "enabled": False,
            },
        },
        "app": {
            "baseUrl": "https://app.paseo.sh",
        },
        "pluginsEnabled": True,
        "plugins": {
            "paseo-plugin": {
                "source": "directory",
                "path": str(plugin_dir),
                "enabled": True,
            },
        },
        "agents": {
            "providers": {
                "omp": {
                    "enabled": True,
                    "env": {
                        "OMP_MODEL": "jetbrains-bridge/jetbrains:gpt-6.1-terra",
                        "OPENAI_API_KEY": "local-smoke",
                        "OLLAMA_HOST": "http://127.0.0.1:1",
                    },
                },
                "hermes": {
                    "extends": "acp",
                    "label": "Hermes",
                    "description": "Nous Research self-improving AI agent",
                    "command": [str(hermes_python), str(wrapper)],
                    "env": {
                        "HERMES_HOME": str(fakehome / ".hermes"),
                        "HERMES_PROFILE": "default",
                        "HERMES_PYTHON": str(
                            real_home() / ".hermes/hermes-agent/.venv/bin/python"
                        ),
                        "HERMES_ACP_SKIP_CONFIGURED_MCP": "1",
                        "OPENAI_API_KEY": "local-smoke",
                        "OPENAI_BASE_URL": STUB_BASE_URL,
                    },
                },
                "hermes-default": {
                    "extends": "acp",
                    "label": "Hermes (default)",
                    "description": "Nous Research self-improving AI agent — profile: default",
                    "command": [str(hermes_python), str(wrapper)],
                    "env": {
                        "HERMES_HOME": str(fakehome / ".hermes"),
                        "HERMES_PROFILE": "default",
                        "HERMES_PYTHON": str(
                            real_home() / ".hermes/hermes-agent/.venv/bin/python"
                        ),
                        "HERMES_ACP_SKIP_CONFIGURED_MCP": "1",
                        "OPENAI_API_KEY": "local-smoke",
                        "OPENAI_BASE_URL": STUB_BASE_URL,
                    },
                },
            },
        },
    }
    config_path = paseo_home / "config.json"
    write_text_if_changed(
        config_path,
        json.dumps(config, indent=2, ensure_ascii=False) + "\n",
    )
    return config_path


def ensure_workspace_registry(paseo_home: Path, workspace_ids: list[str]) -> None:
    """Ensure every seeded agent workspaceId exists in projects/workspaces.json.

    Paseo's `fetch_agents` drops stored agents whose workspaceId is absent from
    workspaces.json, and `bootstrapWorkspaceRegistries` generates a random ID on
    fresh homes without updating records that already carry a workspaceId.
    """
    projects_dir = paseo_home / "projects"
    projects_dir.mkdir(parents=True, exist_ok=True)
    projects_path = projects_dir / "projects.json"
    workspaces_path = projects_dir / "workspaces.json"

    project_id = "prj_64b1a7ce436dfcc7"
    now = "2026-11-18T12:34:11.828Z"

    projects: list[dict[str, object]] = []
    if projects_path.is_file():
        try:
            loaded = json.loads(projects_path.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                projects = loaded
        except (OSError, ValueError):
            projects = []

    if not any(
        isinstance(p, dict) and (p.get("projectId") == project_id or p.get("rootPath") == target_cwd())
        for p in projects
    ):
        projects.append(
            {
                "projectId": project_id,
                "rootPath": target_cwd(),
                "kind": "non_git",
                "displayName": "Projects",
                "projectKey": f"local:{target_cwd()}",
                "customName": None,
                "customIconRevision": None,
                "createdAt": "2026-11-15T01:37:28.323Z",
                "updatedAt": now,
                "archivedAt": None,
            }
        )
    else:
        existing_project = next(
            p
            for p in projects
            if isinstance(p, dict) and (p.get("projectId") == project_id or p.get("rootPath") == target_cwd())
        )
        project_id = str(existing_project["projectId"])

    write_text_if_changed(
        projects_path,
        json.dumps(projects, indent=2, ensure_ascii=False) + "\n",
    )

    workspaces: list[dict[str, object]] = []
    if workspaces_path.is_file():
        try:
            loaded = json.loads(workspaces_path.read_text(encoding="utf-8"))
            if isinstance(loaded, list):
                workspaces = loaded
        except (OSError, ValueError):
            workspaces = []

    existing_ws_ids = {
        str(w.get("workspaceId"))
        for w in workspaces
        if isinstance(w, dict) and w.get("workspaceId")
    }
    for ws_id in workspace_ids:
        if ws_id in existing_ws_ids:
            continue
        workspaces.append(
            {
                "workspaceId": ws_id,
                "projectId": project_id,
                "cwd": target_cwd(),
                "kind": "directory",
                "displayName": "Projects",
                "title": "Paseo outline smoke sandbox",
                "branch": None,
                "worktreeRoot": None,
                "baseBranch": None,
                "isPaseoOwnedWorktree": False,
                "mainRepoRoot": None,
                "createdAt": "2026-11-15T01:37:28.323Z",
                "updatedAt": now,
                "archivedAt": None,
                "autoArchivedChangeRequestUrl": None,
                "pinnedAt": None,
                "metadata": {},
                "background": False,
            }
        )
        existing_ws_ids.add(ws_id)

    write_text_if_changed(
        workspaces_path,
        json.dumps(workspaces, indent=2, ensure_ascii=False) + "\n",
    )


def write_agent_records(
    paseo_home: Path,
    omp_jsonl_path: Path,
    hermes_meta: dict[str, object],
) -> tuple[Path, Path]:
    agents_dir = paseo_home / "agents" / project_dir_key()
    agents_dir.mkdir(parents=True, exist_ok=True)

    src_omp_record = (
        real_home()
        / ".paseo"
        / "agents"
        / project_dir_key()
        / f"{OMP_AGENT_ID}.json"
    )
    if not src_omp_record.is_file():
        raise FileNotFoundError(f"Missing real OMP agent record: {src_omp_record}")

    omp_record = json.loads(src_omp_record.read_text(encoding="utf-8"))
    omp_record["id"] = OMP_AGENT_ID
    omp_record["provider"] = "omp"
    omp_record.pop("archivedAt", None)
    omp_record.setdefault("runtimeInfo", {})
    omp_record["runtimeInfo"]["provider"] = "omp"
    omp_record["runtimeInfo"].setdefault("sessionId", OMP_SESSION_ID)
    omp_record.setdefault("persistence", {})
    omp_record["persistence"]["provider"] = "omp"
    omp_record["persistence"]["sessionId"] = OMP_SESSION_ID
    omp_record["persistence"]["nativeHandle"] = str(omp_jsonl_path)
    omp_ws_id = str(omp_record.get("workspaceId") or HERMES_WORKSPACE_ID)
    omp_record["workspaceId"] = omp_ws_id

    omp_dst = agents_dir / f"{OMP_AGENT_ID}.json"
    write_text_if_changed(
        omp_dst,
        json.dumps(omp_record, indent=2, ensure_ascii=False) + "\n",
    )

    started_at = iso_utc(
        float(hermes_meta["started_at"])
        if hermes_meta.get("started_at") is not None
        else None
    )
    ended_at = iso_utc(
        float(hermes_meta["ended_at"])
        if hermes_meta.get("ended_at") is not None
        else None
    )
    title = str(hermes_meta.get("title") or "Hermes smoke session")

    hermes_record = {
        "id": HERMES_AGENT_ID,
        "provider": HERMES_PROVIDER,
        "cwd": target_cwd(),
        "workspaceId": HERMES_WORKSPACE_ID,
        "createdAt": started_at,
        "updatedAt": ended_at,
        "lastActivityAt": ended_at,
        "lastUserMessageAt": ended_at,
        "title": title,
        "labels": {},
        "metadata": {},
        "lastStatus": "idle",
        "resumeOnStartup": False,
        "lastModeId": "accept_edits",
        "config": {
            "modeId": "accept_edits",
            "model": HERMES_MODEL,
            "thinkingOptionId": HERMES_THINKING,
        },
        "runtimeInfo": {
            "provider": HERMES_PROVIDER,
            "sessionId": HERMES_SESSION_ID,
            "model": HERMES_MODEL,
            "thinkingOptionId": HERMES_THINKING,
            "modeId": "accept_edits",
        },
        "controls": [
            {
                "type": "toggle",
                "key": "auto_accept",
                "label": "Auto Accept",
                "description": "Automatically approves ACP permission prompts.",
                "tooltip": "Auto accept permission prompts",
                "icon": "shield-check",
            }
        ],
        "persistence": {
            "provider": HERMES_PROVIDER,
            "sessionId": HERMES_SESSION_ID,
            "nativeHandle": HERMES_SESSION_ID,
            "metadata": {
                "provider": "acp",
                "profile": "default",
                "cwd": target_cwd(),
                "modeId": "accept_edits",
                "model": HERMES_MODEL,
                "thinkingOptionId": HERMES_THINKING,
                "title": title,
            },
        },
        "requiresAttention": False,
        "attentionReason": None,
        "attentionTimestamp": None,
        "internal": False,
    }

    hermes_dst = agents_dir / f"{HERMES_AGENT_ID}.json"
    write_text_if_changed(
        hermes_dst,
        json.dumps(hermes_record, indent=2, ensure_ascii=False) + "\n",
    )
    ensure_workspace_registry(paseo_home, [omp_ws_id, HERMES_WORKSPACE_ID])
    return omp_dst, hermes_dst


def build_daemon_env(fakehome: Path, paseo_home: Path) -> dict[str, str]:
    nav_state_dir = paseo_home / "nav-state"
    nav_state_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["HOME"] = str(fakehome)
    env["PASEO_HOME"] = str(paseo_home)
    env["PASEO_WEB_UI_ENABLED"] = "true"
    env["SESSION_NAVIGATION_STATE_PATH"] = str(nav_state_dir / "state.sqlite3")
    return env


def ensure_daemon_running(fakehome: Path, paseo_home: Path) -> dict[str, str]:
    env = build_daemon_env(fakehome, paseo_home)
    if read_pid_lock(paseo_home) is not None and health_ok():
        return env

    stop_sandbox_daemon(paseo_home)
    stdout_log = paseo_home / "daemon-stdout.log"
    daemon_log = paseo_home / "daemon.log"
    with open(stdout_log, "ab") as log_fp:
        proc = subprocess.Popen(
            ["paseo", "daemon", "run", "--home", str(paseo_home)],
            env=env,
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    deadline = time.monotonic() + 30.0
    seen_registry = False
    seen_listening = False
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            tail = ""
            if stdout_log.is_file():
                tail = stdout_log.read_text(encoding="utf-8", errors="replace")[-2000:]
            raise RuntimeError(f"Sandbox daemon exited early (code={proc.returncode}):\n{tail}")
        combined = ""
        if daemon_log.is_file():
            combined += daemon_log.read_text(encoding="utf-8", errors="replace")
        if stdout_log.is_file():
            combined += "\n" + stdout_log.read_text(encoding="utf-8", errors="replace")
        if "Agent registry loaded" in combined:
            seen_registry = True
        if "Server listening" in combined:
            seen_listening = True
        if seen_registry and seen_listening and health_ok():
            return env
        time.sleep(0.25)

    raise RuntimeError(
        f"Timed out waiting for sandbox daemon (registry={seen_registry}, listening={seen_listening}, health={health_ok()})"
    )


def verify_agent_ls(env: dict[str, str], paseo_home: Path) -> None:
    proc = subprocess.run(
        ["paseo", "agent", "ls", "-a", "--home", str(paseo_home), "--json"],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"paseo agent ls -a failed ({proc.returncode}): {proc.stderr or proc.stdout}")
    data = json.loads(proc.stdout)
    if isinstance(data, dict):
        entries = data.get("agents") or data.get("data") or []
    elif isinstance(data, list):
        entries = data
    else:
        entries = []
    short_ids = {str(entry.get("id", ""))[:8] for entry in entries}
    expected = {OMP_AGENT_ID[:8], HERMES_AGENT_ID[:8]}
    if not expected.issubset(short_ids):
        raise RuntimeError(
            f"paseo agent ls -a missing expected agents: got={sorted(short_ids)}, expected={sorted(expected)}"
        )


def verify_service_client_gate(env: dict[str, str]) -> dict[str, object]:
    plugin_client = (repo_root() / "paseo-plugin" / "server" / "client.ts").resolve()
    # Do not pass --input-type=module: Node propagates that flag to Worker(..., { eval: true })
    # inside ServiceClient, breaking its bundled CommonJS worker_source.
    node_script = f"""
(async () => {{
  const {{ ServiceClient }} = await import({json.dumps(plugin_client.as_uri())});
  const client = new ServiceClient();
  try {{
    const scopesReply = await client.request("scopes", {{}});
    const listReply = await client.request("list", {{
      scope_key: {json.dumps(HERMES_SCOPE_KEY)},
      limit: {EXPECTED_LIST_LIMIT},
    }});
    console.log(JSON.stringify({{ scopesReply, listReply }}));
  }} finally {{
    client.close();
  }}
}})().catch((err) => {{
  console.error(err);
  process.exit(1);
}});
"""
    proc = subprocess.run(
        ["node", "--experimental-strip-types", "-e", node_script],
        env=env,
        cwd=str(repo_root() / "paseo-plugin"),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"ServiceClient verification failed ({proc.returncode}): {proc.stderr or proc.stdout}"
        )
    payload = json.loads(proc.stdout)
    scopes_reply = payload.get("scopesReply", {})
    list_reply = payload.get("listReply", {})
    if not scopes_reply.get("ok"):
        raise RuntimeError(f"ServiceClient scopes failed: {scopes_reply}")
    scopes = scopes_reply.get("scopes", [])
    hermes_scope = next((s for s in scopes if s.get("scope_key") == HERMES_SCOPE_KEY), None)
    if not hermes_scope or hermes_scope.get("agent_id") != HERMES_AGENT_ID:
        raise RuntimeError(
            f"Hermes scope binding mismatch: found={hermes_scope}, expected agent_id={HERMES_AGENT_ID}"
        )
    omp_scope = next((s for s in scopes if s.get("scope_key") == OMP_SCOPE_KEY), None)
    if not omp_scope or omp_scope.get("agent_id") != OMP_AGENT_ID:
        raise RuntimeError(
            f"OMP scope binding mismatch: found={omp_scope}, expected agent_id={OMP_AGENT_ID}"
        )
    if not list_reply.get("ok"):
        raise RuntimeError(f"ServiceClient list failed: {list_reply}")
    items = list_reply.get("items", [])
    totals = list_reply.get("totals", {})
    has_older = list_reply.get("has_older")
    if (
        len(items) != EXPECTED_LIST_LIMIT
        or has_older is not True
        or totals.get("total_rows") != EXPECTED_LIST_TOTAL_ROWS
    ):
        raise RuntimeError(
            "ServiceClient list gate mismatch: "
            f"len(items)={len(items)} (expected {EXPECTED_LIST_LIMIT}), "
            f"has_older={has_older} (expected True), "
            f"total_rows={totals.get('total_rows')} (expected {EXPECTED_LIST_TOTAL_ROWS})"
        )
    return {
        "scopes_count": len(scopes),
        "hermes_agent_id": hermes_scope.get("agent_id"),
        "omp_agent_id": omp_scope.get("agent_id"),
        "list_items": len(items),
        "has_older": has_older,
        "total_rows": totals.get("total_rows"),
    }


def reset_sandbox_targets(fakehome: Path, paseo_home: Path) -> None:
    stop_sandbox_hermes(fakehome)
    if paseo_home.exists():
        shutil.rmtree(paseo_home)
    for target in (
        fakehome / ".omp",
        fakehome / ".hermes" / "profiles" / "default",
        fakehome / ".hermes" / "state.db",
        fakehome / ".hermes" / "state.db-wal",
        fakehome / ".hermes" / "state.db-shm",
        fakehome / ".hermes" / "config.yaml",
        fakehome / ".hermes" / ".env",
    ):
        if target.exists():
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(DEFAULT_ROOT), help="Sandbox root directory")
    parser.add_argument("--reset", action="store_true", help="Reset sandbox state before seeding")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    fakehome = root / "fakehome"
    paseo_home = root / "home"

    if args.reset:
        reset_sandbox_targets(fakehome, paseo_home)

    root.mkdir(parents=True, exist_ok=True)
    write_synthetic_model_configs(fakehome)
    omp_jsonl = stage_omp_session(fakehome)
    hermes_db, hermes_meta = stage_hermes_profile(fakehome)
    write_sandbox_config(paseo_home, fakehome)
    write_agent_records(paseo_home, omp_jsonl, hermes_meta)

    env = ensure_daemon_running(fakehome, paseo_home)
    verify_agent_ls(env, paseo_home)
    gate = verify_service_client_gate(env)

    db_bytes = hermes_db.stat().st_size
    server_id = read_server_id(paseo_home)
    workspace_url = (
        f"{WEB_UI_URL.rstrip('/')}/h/{server_id}/workspace/{HERMES_WORKSPACE_ID}"
        if server_id
        else WEB_UI_URL
    )
    print(f"PASEO_WEB_UI_URL={WEB_UI_URL}")
    if server_id:
        print(f"PASEO_WORKSPACE_URL={workspace_url}")
        print(f"PASEO_SERVER_ID={server_id}")
    print(f"AGENTS={OMP_AGENT_ID},{HERMES_AGENT_ID}")
    print(
        json.dumps(
            {
                "url": WEB_UI_URL,
                "workspace_url": workspace_url,
                "server_id": server_id,
                "agents": [OMP_AGENT_ID, HERMES_AGENT_ID],
                "hermes_db_bytes": db_bytes,
                "hermes_db_mb_decimal": round(db_bytes / 1_000_000, 1),
                "hermes_db_mib": round(db_bytes / (1024 * 1024), 1),
                "gate": gate,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
