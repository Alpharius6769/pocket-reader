"""Fail closed unless a Pocket TTS WebGPU R3 bundle meets its runtime contract."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

import onnx


EXPECTED_BUNDLE = "english_2026-04-webgpu-fp16-r3"
EXPECTED_REVISION = "english-2026-04-fp16-r3"
REQUIRED_MODELS = {
    "flow_lm_decode_block4": "flow_lm_decode_block4_fp16.onnx",
    "mimi_decoder_fp16": "mimi_decoder_fp16.onnx",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def certify(bundle_dir: Path) -> dict[str, object]:
    manifest = json.loads((bundle_dir / "bundle.json").read_text(encoding="utf-8"))
    errors: list[str] = []
    if manifest.get("bundle_name") != EXPECTED_BUNDLE:
        errors.append(f"bundle_name must be {EXPECTED_BUNDLE}")
    if manifest.get("model_revision") != EXPECTED_REVISION:
        errors.append(f"model_revision must be {EXPECTED_REVISION}")

    contract = manifest.get("execution_contract") or {}
    expected_contract = {
        "core_provider": "webgpu-only",
        "prefill_provider": "wasm-threaded",
        "mimi_provider": "benchmark-gated-webgpu",
        "mimi_fallback_provider": "wasm-threaded",
        "decode_block_frames": 4,
        "steady_sync_blocks": 4,
        "graph_capture": "benchmark-gated",
        "recurrent_state_location": "gpu-buffer",
        "mixed_provider_fallback": False,
    }
    for key, expected in expected_contract.items():
        if contract.get(key) != expected:
            errors.append(f"execution_contract.{key} must be {expected!r}")

    reports: dict[str, object] = {}
    model_files = manifest.get("model_files") or {}
    for role, filename in REQUIRED_MODELS.items():
        path = bundle_dir / filename
        if model_files.get(role) != filename or not path.is_file():
            errors.append(f"missing model_files.{role}={filename}")
            continue
        model = onnx.load(str(path), load_external_data=True)
        onnx.checker.check_model(model, full_check=True)
        counts = Counter(node.op_type for node in model.graph.node)
        forbidden = sorted(op for op in ("Loop", "Scan") if counts[op])
        if forbidden:
            errors.append(f"{filename} contains forbidden operators: {', '.join(forbidden)}")
        if role == "flow_lm_decode_block4" and (counts["If"] or counts["IsNaN"]):
            errors.append(f"{filename} contains control/fallback-prone core operators")
        reports[role] = {
            "file": filename,
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
            "nodes": len(model.graph.node),
            "operators": dict(sorted(counts.items())),
            "requires_mimi_operator_fallback": role == "mimi_decoder_fp16" and bool(counts["ScatterElements"] or counts["IsNaN"]),
        }

    shared = manifest.get("shared_wasm_bundle") or {}
    if shared.get("bundle_name") != "english_2026-04":
        errors.append("shared_wasm_bundle.bundle_name must be english_2026-04")
    if set(shared.get("roles") or []) != {"text_conditioner", "flow_lm_prefill", "mimi_decoder", "tokenizer"}:
        errors.append("shared_wasm_bundle roles are incomplete")
    if not (bundle_dir / "flow_lm_bos.npy").is_file():
        errors.append("flow_lm_bos.npy is missing")
    if errors:
        raise RuntimeError("WebGPU R3 certification failed:\n- " + "\n- ".join(errors))

    report = {
        "certified": True,
        "bundle": EXPECTED_BUNDLE,
        "revision": EXPECTED_REVISION,
        "execution_contract": contract,
        "shared_wasm_bundle": shared,
        "models": reports,
    }
    certification_path = bundle_dir / "certification.json"
    certification_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    integrity = {
        path.name: {"bytes": path.stat().st_size, "sha256": sha256(path)}
        for path in sorted(bundle_dir.iterdir())
        if path.is_file() and path.name != "integrity.json"
    }
    (bundle_dir / "integrity.json").write_text(json.dumps(integrity, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle_dir", type=Path)
    args = parser.parse_args()
    print(json.dumps(certify(args.bundle_dir), indent=2))


if __name__ == "__main__":
    main()
