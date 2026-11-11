"""The Python engine wheel must not revive the retired OMP executables."""
from pathlib import Path
import tomllib


def test_python_distribution_has_no_omp_runtime_or_cli_entrypoints():
    root = Path(__file__).resolve().parents[1]
    project = tomllib.loads((root / "pyproject.toml").read_text())
    scripts = project["project"].get("scripts", {})
    assert "session-navigation-daemon" not in scripts
    assert "session-navigation" not in scripts
    assert "src/session_navigation_omp" not in project["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"]
    assert not (root / "src/session_navigation_omp").exists()
