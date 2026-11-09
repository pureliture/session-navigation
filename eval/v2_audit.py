"""Audit actual key bytes and known credential prefixes without printing values."""
import gzip
import json
import lzma
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def audit(output):
    key = os.environ["OPENROUTER_API_KEY"].encode()
    paths = {ROOT / name.decode() for name in subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).split(b"\0") if name}
    for base in (ROOT / "eval", Path.home() / ".session-navigation-eval-v2"):
        paths.update(p for p in base.rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".lock")
    leaks, prefixes, checked = [], [], 0
    for path in sorted(paths):
        raw = path.read_bytes()
        if path.suffix == ".gz":
            raw = gzip.decompress(raw)
        elif path.suffix == ".xz":
            raw = lzma.decompress(raw)
        checked += 1
        if key in raw:
            leaks.append(str(path))
        if re.search(rb"sk-or-v1-[A-Za-z0-9_-]{24,}", raw):
            prefixes.append(str(path))
    result = {"files_checked": checked, "actual_key_matches": leaks, "credential_prefix_matches": prefixes,
              "note": "Opaque encrypted model reasoning is not a credential; only actual key bytes and known OpenRouter prefix are checked."}
    (output / "final-audit.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({"files_checked": checked, "actual_key_matches": len(leaks), "credential_prefix_matches": len(prefixes)}))
    assert not leaks and not prefixes


if __name__ == "__main__":
    audit(Path(sys.argv[1]))
