"""Losslessly archive completed wire with a larger compression dictionary."""
import gzip
import hashlib
import json
import lzma
from pathlib import Path
import shutil
import sys


def archive(directory):
    source = directory / "wire.jsonl.gz"
    target = directory / "wire.jsonl.xz"
    assert source.exists() and not target.exists()
    checksum = hashlib.sha256()
    with gzip.open(source, "rb") as original, lzma.open(target, "wb", preset=9) as packed:
        while block := original.read(1024 * 1024):
            checksum.update(block)
            packed.write(block)
    verified = hashlib.sha256()
    with lzma.open(target, "rb") as packed:
        while block := packed.read(1024 * 1024):
            verified.update(block)
    assert checksum.digest() == verified.digest()
    report = {"decompressed_sha256": verified.hexdigest(), "gzip_bytes": source.stat().st_size, "xz_bytes": target.stat().st_size}
    (directory / "archive.json").write_text(json.dumps(report, indent=2))
    source.unlink()
    print(json.dumps(report))


if __name__ == "__main__":
    archive(Path(sys.argv[1]))
