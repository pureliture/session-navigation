"""Historical campaign metadata and offline helpers, not a campaign runner."""
import argparse
import io
import os
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
STAGES = {"crouton": ("stealth/crouton-alpha", "Stealth"),
          "nemotron": ("nvidia/nemotron-3.5-lightning:free", "Nvidia"),
          "deepseek-quality": ("deepseek/deepseek-v4.1-flash-1017", "Relace"),
          "deepseek": ("deepseek/deepseek-v4.1-flash-1017", "Relace")}
COMMITS = {"A": "fc07058", "B-old": "5017b97", "B-new": "37348b8"}
DEEPSEEK_REASONING = {"enabled": False, "exclude": True}
HERMES = "/Users/devin/hermes-nav-live/installs/a6031367d5037fff/environments/3be5d82bc8954afa9633eb60c0780749/workspace"


def positive_int(value):
    try:
        result = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("Expected a positive integer") from None
    if result < 1:
        raise argparse.ArgumentTypeError("Expected a positive integer")
    return result


def source_snapshot(base, commit):
    target = base / "sources" / commit
    if not target.exists():
        target.mkdir(parents=True)
        archive = subprocess.check_output(["git", "archive", commit], cwd=ROOT)
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(target, filter="data")
    return target


def child_environment(home, source, work, workspace):
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "SHELL", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR")}
    env.update(HOME=str(home), HERMES_HOME=str(home), PYTHONPATH=str(source / "src"),
               OMP_PACKAGE=os.environ.get("OMP_PACKAGE", "/opt/homebrew/lib/node_modules/@oh-my-pi/pi-coding-agent"),
               NODE_PATH=str(Path(os.environ.get("OMP_PACKAGE", "/opt/homebrew/lib/node_modules/@oh-my-pi/pi-coding-agent")) / "node_modules"),
               SESSION_NAVIGATION_STATE_PATH=str(work / "navigation.sqlite3"), TERMINAL_CWD=str(workspace), HERMES_YOLO="1")
    return env
