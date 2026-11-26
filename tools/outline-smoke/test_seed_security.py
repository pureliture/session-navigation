"""Security smoke tests for tools/outline-smoke/seed.py (P1-14).

- Sandbox daemon binds loopback only (never 0.0.0.0).
- Only a synthetic `.env` (no real secrets) is staged into the /tmp sandbox.
- PID-file values that would signal a process group (0/-1) or init (1) are
  rejected before any os.kill call.
"""

import importlib.util
import os
import stat
from pathlib import Path

import pytest

SEED_PATH = Path(__file__).resolve().parent / "seed.py"


@pytest.fixture()
def seed():
    spec = importlib.util.spec_from_file_location("outline_smoke_seed", SEED_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_daemon_listens_on_loopback_only(seed, tmp_path):
    host, _, port = seed.LISTEN_ADDR.partition(":")
    assert host in ("127.0.0.1", "localhost"), seed.LISTEN_ADDR
    assert port == "17680"

    paseo_home = tmp_path / "home"
    fakehome = tmp_path / "fakehome"
    config_path = seed.write_sandbox_config(paseo_home, fakehome)
    config_text = config_path.read_text(encoding="utf-8")
    assert "0.0.0.0" not in config_text
    assert seed.LISTEN_ADDR in config_text
    wrapper = fakehome / ".hermes" / "direct_acp.py"
    assert wrapper.is_file()
    assert stat.S_IMODE(wrapper.stat().st_mode) == 0o700
    assert str(fakehome / ".hermes") in config_text


@pytest.mark.parametrize("raw", ["0", "-1", "1", "", "   ", "not-a-pid", "{bad json"])
def test_pid_lock_rejects_unsafe_or_invalid_pids(seed, tmp_path, raw):
    (tmp_path / "paseo.pid").write_text(raw, encoding="utf-8")
    assert seed.read_pid_lock(tmp_path) is None


def test_pid_lock_rejects_missing_file(seed, tmp_path):
    assert seed.read_pid_lock(tmp_path / "does-not-exist") is None


def test_pid_lock_accepts_live_pid(seed, tmp_path):
    (tmp_path / "paseo.pid").write_text(str(os.getpid()), encoding="utf-8")
    assert seed.read_pid_lock(tmp_path) == os.getpid()


def test_default_profile_stages_synthetic_env_only(seed, tmp_path, monkeypatch):
    canary = "sk-canary-secret-12345"
    fake_real_home = tmp_path / "realhome"
    src_default = fake_real_home / ".hermes" / "profiles" / "default"
    src_default.mkdir(parents=True)
    (src_default / ".env").write_text(f"API_KEY={canary}\n", encoding="utf-8")
    (src_default / "profile.yaml").write_text("profile: default\n", encoding="utf-8")
    monkeypatch.setattr(seed, "real_home", lambda: fake_real_home)

    fakehome = tmp_path / "fakehome"
    dst_default = seed.stage_hermes_default_profile(fakehome)

    dst_env = dst_default / ".env"
    env_text = dst_env.read_text(encoding="utf-8")
    assert canary not in env_text
    assert env_text == seed.SYNTHETIC_HERMES_ENV
    mode = stat.S_IMODE(dst_env.stat().st_mode)
    assert mode == 0o600
    # Non-secret profile config still stages.
    assert (dst_default / "profile.yaml").read_text(encoding="utf-8") == "profile: default\n"
