"""Fail closed unless a Pocket TTS WebGPU R2 bundle meets its runtime contract."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

import onnx


EXPECTED_REVISION = "english-2026-04-fp16-r2"
EXPECTED_BUNDLE = "english_2026-04-webgpu-fp16-r2"
REQUIRED_MODELS = {
    "flow_lm_decode_block4": "flow_lm_decode_block4_fp16.onnx",
}
FORBIDDEN_CORE_OPS = {"If", "Loop", "Scan", "IsNaN"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def symbolic_dimensions(model: onnx.ModelProto) -> list[str]:
    symbolic: list[str] = []
    for value in (*model.graph.input, *model.graph.output):
        for dimension in value.type.tensor_type.shape.dim:
            if dimension.dim_param:
                symbolic.append(f"{value.name}:{dimension.dim_param}")
    return symbolic


def certify(bundle_dir: Path) -> dict[str, object]:
    manifest_path = bundle_dir / "bundle.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    errors: list[str] = []

    if manifest.get("bundle_name") != EXPECTED_BUNDLE:
        errors.append(f"bundle_name must be {EXPECTED_BUNDLE}")
    if manifest.get("model_revision") != EXPECTED_REVISION:
        errors.append(f"model_revision must be {EXPECTED_REVISION}")
    contract = manifest.get("execution_contract") or {}
    expected_contract = {
        "core_provider": "webgpu-only",
        "prefill_provider": "wasm-threaded",
        "mimi_provider": "wasm-threaded",
        "decode_block_frames": 4,
        "eos_readbacks_per_block": 1,
        "latent_transfers_per_block": 1,
        "recurrent_state_location": "gpu-buffer",
        "mixed_provider_fallback": False,
    }
    for key, expected in expected_contract.items():
        if contract.get(key) != expected:
            errors.append(f"execution_contract.{key} must be {expected!r}")

    model_files = manifest.get("model_files") or {}
    reports: dict[str, object] = {}
    for role, filename in REQUIRED_MODELS.items():
        if model_files.get(role) != filename:
            errors.append(f"model_files.{role} must be {filename}")
            continue
        path = bundle_dir / filename
        if not path.is_file():
            errors.append(f"missing {filename}")
            continue
        model = onnx.load(str(path), load_external_data=True)
        onnx.checker.check_model(model, full_check=True)
        counts = Counter(node.op_type for node in model.graph.node)
        forbidden = sorted(op for op in FORBIDDEN_CORE_OPS if counts[op])
        symbolic = symbolic_dimensions(model)
        if forbidden:
            errors.append(f"{filename} contains forbidden core operators: {', '.join(forbidden)}")
        if symbolic:
            errors.append(f"{filename} has symbolic core dimensions: {', '.join(symbolic[:8])}")
        if role == "flow_lm_decode_block4" and counts["Cast"] > 64:
            errors.append(f"{filename} has {counts['Cast']} Cast nodes; maximum is 64")
        reports[role] = {
            "file": filename,
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
            "nodes": len(model.graph.node),
            "casts": counts["Cast"],
            "shape_ops": counts["Shape"],
            "forbidden_ops": forbidden,
            "symbolic_dimensions": symbolic,
        }

    shared = manifest.get("shared_wasm_bundle") or {}
    if shared.get("bundle_name") != "english_2026-04":
        errors.append("shared_wasm_bundle.bundle_name must be english_2026-04")
    required_roles = {"text_conditioner", "flow_lm_prefill", "mimi_decoder", "tokenizer"}
    if set(shared.get("roles") or []) != required_roles:
        errors.append(f"shared_wasm_bundle.roles must be {sorted(required_roles)!r}")

    bos_file = manifest.get("flow_lm_bos_file")
    if bos_file != "flow_lm_bos.npy" or not (bundle_dir / str(bos_file)).is_file():
        errors.append("flow_lm_bos_file must reference flow_lm_bos.npy")

    if errors:
        raise RuntimeError("WebGPU R2 certification failed:\n- " + "\n- ".join(errors))

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
