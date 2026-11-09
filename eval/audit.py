"""Final key audit: emit counts/paths only, never secret values."""
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path


def audit(directory):
    root = Path(__file__).resolve().parents[1]
    key = os.environ["OPENROUTER_API_KEY"].encode()
    paths = {root / p.decode() for p in subprocess.check_output(["git", "ls-files", "-z"], cwd=root).split(b"\0") if p}
    paths.update(p for p in (root / "eval").rglob("*") if p.is_file() and "__pycache__" not in p.parts)
    workspace = Path.home() / ".session-navigation-eval"
    paths.update(p for p in workspace.rglob("*") if p.is_file() and p.suffix not in [".lock"])
    leaks, patterns, checked = [], [], 0
    for path in sorted(paths):
        raw = path.read_bytes()
        if path.suffix == ".gz":
            raw = gzip.decompress(raw)
        checked += 1
        if key in raw:
            leaks.append(str(path))
        if path.is_relative_to(root / "eval") and re.search(rb"sk-(?:or-v1-)?[A-Za-z0-9_-]{24,}", raw):
            patterns.append(str(path))
    sources = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in [root / "extensions/pi/session-navigation.ts", root / "docs/evaluation/design.md", root / "eval/fixtures/cases.json", root / "eval/run.py", root / "eval/proxy.py"]}
    result = {"files_checked": checked, "actual_key_matches": leaks, "secret_pattern_matches": patterns,
        "source_sha256": sources, "model": "z-ai/glm-5.3-flash"}
    (directory / "final-audit.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({"files_checked": checked, "actual_key_matches": len(leaks), "secret_pattern_matches": len(patterns)}))
    assert not leaks and not patterns, "Secret audit requires review"


if __name__ == "__main__":
    audit(Path(sys.argv[1]))
