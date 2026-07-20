"""Package immutable stock-WASM-only or relaxed-SIMD ORT Web runtimes."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--flavor", choices=("stock-wasm-only", "relaxed"), required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    if args.flavor == "stock-wasm-only":
        files = {
            "ort.wasm.min.mjs": "ort.min.mjs",
            "ort-wasm-simd-threaded.mjs": "ort-wasm-simd-threaded.mjs",
            "ort-wasm-simd-threaded.wasm": "ort-wasm-simd-threaded.wasm",
        }
    else:
        files = {
            "ort.min.mjs": "ort.min.mjs",
            "ort-wasm-relaxedsimd-threaded.mjs": "ort-wasm-relaxedsimd-threaded.mjs",
            "ort-wasm-relaxedsimd-threaded.wasm": "ort-wasm-relaxedsimd-threaded.wasm",
        }

    manifest_files: dict[str, object] = {}
    for source_name, output_name in files.items():
        source = args.source_dir / source_name
        if not source.is_file():
            raise FileNotFoundError(source)
        output = args.output_dir / output_name
        if source.resolve() != output.resolve():
            shutil.copy2(source, output)
        manifest_files[output_name] = {
            "bytes": output.stat().st_size,
            "sha256": sha256(output),
        }

    manifest = {
        "schema_version": 1,
        "onnxruntime_version": "1.27.0",
        "flavor": args.flavor,
        "jsep": False,
        "threaded": True,
        "simd": "relaxed" if args.flavor == "relaxed" else "fixed",
        "files": manifest_files,
    }
    (args.output_dir / "integrity.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
