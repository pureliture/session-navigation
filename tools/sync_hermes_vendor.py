"""Synchronize the standalone Hermes runtime with the canonical Python sources."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def files(directory: Path) -> dict[Path, bytes]:
    return {
        path.relative_to(directory): path.read_bytes()
        for path in directory.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts
        and path.suffix not in {".pyc", ".pyo"}
    }


def sync(root: Path, *, check: bool) -> list[str]:
    pairs = [
        (root / "src/session_navigation", root / "hermes-plugin/vendor/session_navigation"),
        (root / "adapters/hermes", root / "hermes-plugin/vendor/session_navigation_hermes"),
    ]
    snapshots = []
    for source, target in pairs:
        if not (source / "__init__.py").is_file():
            raise ValueError(f"missing source package: {source}")
        snapshots.append((target, files(source), files(target)))
    drift = []
    for target, source, current in snapshots:
        for name in sorted(source.keys() | current.keys()):
            if source.get(name) == current.get(name):
                continue
            path = target / name
            drift.append(str(path.relative_to(root)))
            if check:
                continue
            if name in source:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(source[name])
            else:
                path.unlink()
    return drift


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="report drift without writing")
    args = parser.parse_args()
    try:
        drift = sync(Path(__file__).resolve().parents[1], check=args.check)
    except (OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if args.check and drift:
        print("Hermes vendor drift:\n" + "\n".join(drift), file=sys.stderr)
        return 1
    print("PASS Hermes vendor parity" if args.check else f"Synchronized {len(drift)} Hermes vendor files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
