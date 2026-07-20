"""Package the certified Pocket TTS hybrid WebGPU R2 bundle for B2."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
import onnx


BUNDLE_NAME = "english_2026-04-webgpu-fp16-r2"
MODEL_REVISION = "english-2026-04-fp16-r2"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tensor_interface(value: onnx.ValueInfoProto) -> dict[str, object]:
    tensor = value.type.tensor_type
    dimensions: list[int | str] = []
    for dimension in tensor.shape.dim:
        if dimension.HasField("dim_value"):
            dimensions.append(int(dimension.dim_value))
        else:
            dimensions.append(dimension.dim_param)
    return {
        "name": value.name,
        "elem_type": int(tensor.elem_type),
        "shape": dimensions,
    }


def package(model_path: Path, bos_path: Path, output_dir: Path) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    packaged_model = output_dir / "flow_lm_decode_block4_fp16.onnx"
    packaged_bos = output_dir / "flow_lm_bos.npy"
    shutil.copy2(model_path, packaged_model)
    shutil.copy2(bos_path, packaged_bos)

    bos = np.load(packaged_bos)
    if bos.shape != (1, 1, 32) or bos.dtype != np.float32:
        raise RuntimeError(f"Unexpected FlowLM BOS tensor: shape={bos.shape}, dtype={bos.dtype}")

    model = onnx.load(str(packaged_model), load_external_data=True)
    onnx.checker.check_model(model, full_check=True)
    artifact = {
        "bytes": packaged_model.stat().st_size,
        "sha256": sha256(packaged_model),
        "interface": {
            "inputs": [tensor_interface(value) for value in model.graph.input],
            "outputs": [tensor_interface(value) for value in model.graph.output],
        },
    }
    bos_artifact = {
        "bytes": packaged_bos.stat().st_size,
        "sha256": sha256(packaged_bos),
        "shape": list(bos.shape),
        "dtype": str(bos.dtype),
    }
    manifest = {
        "schema_version": 3,
        "bundle_name": BUNDLE_NAME,
        "model_revision": MODEL_REVISION,
        "language": "english_2026-04",
        "precision": "fp16",
        "model_files": {
            "flow_lm_decode_block4": packaged_model.name,
        },
        "flow_lm_bos_file": packaged_bos.name,
        "shared_wasm_bundle": {
            "bundle_name": "english_2026-04",
            "model_revision": "english-2026-04-int8-r1",
            "roles": ["text_conditioner", "flow_lm_prefill", "mimi_decoder", "tokenizer"],
        },
        "execution_contract": {
            "core_provider": "webgpu-only",
            "prefill_provider": "wasm-threaded",
            "mimi_provider": "wasm-threaded",
            "decode_block_frames": 4,
            "eos_readbacks_per_block": 1,
            "latent_transfers_per_block": 1,
            "recurrent_state_location": "gpu-buffer",
            "mixed_provider_fallback": False,
        },
        "artifacts": {
            packaged_model.name: artifact,
            packaged_bos.name: bos_artifact,
        },
    }
    manifest_path = output_dir / "bundle.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    integrity = {
        name: {"bytes": path.stat().st_size, "sha256": sha256(path)}
        for name, path in {
            packaged_model.name: packaged_model,
            packaged_bos.name: packaged_bos,
            manifest_path.name: manifest_path,
        }.items()
    }
    (output_dir / "integrity.json").write_text(json.dumps(integrity, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--bos", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(package(args.model, args.bos, args.output_dir), indent=2))


if __name__ == "__main__":
    main()
