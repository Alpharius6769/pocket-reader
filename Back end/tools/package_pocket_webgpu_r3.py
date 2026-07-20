"""Package the benchmark-gated Pocket TTS WebGPU R3 bundle for B2."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
import onnx


BUNDLE_NAME = "english_2026-04-webgpu-fp16-r3"
MODEL_REVISION = "english-2026-04-fp16-r3"


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
        dimensions.append(int(dimension.dim_value) if dimension.HasField("dim_value") else dimension.dim_param)
    return {"name": value.name, "elem_type": int(tensor.elem_type), "shape": dimensions}


def describe_model(path: Path) -> dict[str, object]:
    model = onnx.load(str(path), load_external_data=True)
    onnx.checker.check_model(model, full_check=True)
    return {
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "interface": {
            "inputs": [tensor_interface(value) for value in model.graph.input],
            "outputs": [tensor_interface(value) for value in model.graph.output],
        },
    }


def package(core_model: Path, mimi_model: Path, bos_path: Path, output_dir: Path) -> dict[str, object]:
    output_dir.mkdir(parents=True, exist_ok=True)
    artifacts = {
        "flow_lm_decode_block4_fp16.onnx": core_model,
        "mimi_decoder_fp16.onnx": mimi_model,
        "flow_lm_bos.npy": bos_path,
    }
    for filename, source in artifacts.items():
        shutil.copy2(source, output_dir / filename)

    bos = np.load(output_dir / "flow_lm_bos.npy")
    if bos.shape != (1, 1, 32) or bos.dtype != np.float32:
        raise RuntimeError(f"Unexpected FlowLM BOS tensor: shape={bos.shape}, dtype={bos.dtype}")

    manifest = {
        "schema_version": 4,
        "bundle_name": BUNDLE_NAME,
        "model_revision": MODEL_REVISION,
        "language": "english_2026-04",
        "precision": "fp16",
        "model_files": {
            "flow_lm_decode_block4": "flow_lm_decode_block4_fp16.onnx",
            "mimi_decoder_fp16": "mimi_decoder_fp16.onnx",
        },
        "flow_lm_bos_file": "flow_lm_bos.npy",
        "shared_wasm_bundle": {
            "bundle_name": "english_2026-04",
            "model_revision": "english-2026-04-int8-r1",
            "roles": ["text_conditioner", "flow_lm_prefill", "mimi_decoder", "tokenizer"],
        },
        "execution_contract": {
            "core_provider": "webgpu-only",
            "prefill_provider": "wasm-threaded",
            "mimi_provider": "benchmark-gated-webgpu",
            "mimi_fallback_provider": "wasm-threaded",
            "decode_block_frames": 4,
            "steady_sync_blocks": 4,
            "graph_capture": "benchmark-gated",
            "eos_readbacks_per_sync_group": 1,
            "latent_transfers_per_sync_group": 1,
            "recurrent_state_location": "gpu-buffer",
            "mixed_provider_fallback": False,
            "mimi_mixed_provider_candidate": True,
        },
        "artifacts": {
            "flow_lm_decode_block4_fp16.onnx": describe_model(output_dir / "flow_lm_decode_block4_fp16.onnx"),
            "mimi_decoder_fp16.onnx": describe_model(output_dir / "mimi_decoder_fp16.onnx"),
            "flow_lm_bos.npy": {
                "bytes": (output_dir / "flow_lm_bos.npy").stat().st_size,
                "sha256": sha256(output_dir / "flow_lm_bos.npy"),
                "shape": list(bos.shape),
                "dtype": str(bos.dtype),
            },
        },
    }
    manifest_path = output_dir / "bundle.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core-model", type=Path, required=True)
    parser.add_argument("--mimi-model", type=Path, required=True)
    parser.add_argument("--bos", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(package(args.core_model, args.mimi_model, args.bos, args.output_dir), indent=2))


if __name__ == "__main__":
    main()
