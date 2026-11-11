from __future__ import annotations

import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest


def test_wheel_plugin_root_imports_in_fresh_processes(tmp_path: Path) -> None:
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is required for the wheel installation smoke")
    repo = Path(__file__).resolve().parents[1]
    output = tmp_path / "dist"
    subprocess.run([uv, "build", "--wheel", "--out-dir", str(output)], cwd=repo, check=True)
    wheel = next(output.glob("*.whl"))
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        assert not any(name.endswith((".pyc", ".pyo")) for name in names)
        for source, package in [
            (repo / "vendor/session_navigation", "session_navigation"),
            (repo / "vendor/session_navigation_hermes", "session_navigation_hermes"),
        ]:
            for path in source.rglob("*.py"):
                bundled = f"session_navigation_plugin_root/vendor/{package}/{path.relative_to(source).as_posix()}"
                assert archive.read(bundled) == path.read_bytes()
    environment = tmp_path / "venv"
    subprocess.run([uv, "venv", "--python", sys.executable, str(environment)], check=True)
    python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    subprocess.run([uv, "pip", "install", "--python", str(python), str(wheel)], check=True)
    check = (
        "import session_navigation_plugin_root as plugin; "
        "from session_navigation.engine import SessionNavigationEngine; "
        "from session_navigation_hermes.plugin import register; "
        "assert callable(plugin.register); "
        "assert plugin.register is register; "
        "assert plugin.SessionNavigationEngine is SessionNavigationEngine"
    )
    for preload in ("", "import session_navigation, session_navigation_hermes.plugin; "):
        subprocess.run([str(python), "-I", "-B", "-c", preload + check], cwd=tmp_path, check=True)
