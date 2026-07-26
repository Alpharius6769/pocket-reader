"""Build representative static QDQ variants of Pocket's block4 core."""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
from collections import Counter
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnxruntime.quantization import (
    CalibrationDataReader,
    CalibrationMethod,
    QuantFormat,
    QuantType,
    quantize_static,
)


DTYPES = {"float32": np.float32, "int64": np.int64, "bool": np.bool_}
CONFIGS = [
    ("qdq_s8_tensor_full", QuantType.QInt8, False, False),
    ("qdq_s8_tensor_reduced", QuantType.QInt8, False, True),
    ("qdq_s8_channel_full", QuantType.QInt8, True, False),
    ("qdq_s8_channel_reduced", QuantType.QInt8, True, True),
    ("qdq_u8_tensor_full", QuantType.QUInt8, False, False),
    ("qdq_u8_tensor_reduced", QuantType.QUInt8, False, True),
    ("qdq_u8_channel_full", QuantType.QUInt8, True, False),
    ("qdq_u8_channel_reduced", QuantType.QUInt8, True, True),
]


class Reader(CalibrationDataReader):
    def __init__(self, samples: list[dict[str, np.ndarray]]):
        self.samples = samples
        self.iterator = iter(samples)

    def get_next(self):
        return next(self.iterator, None)

    def rewind(self):
        self.iterator = iter(self.samples)


def make_state(manifest: list[dict[str, object]]) -> dict[str, np.ndarray]:
    result = {}
    for spec in manifest:
        shape = tuple(int(value) for value in spec["shape"])
        dtype = DTYPES[str(spec["dtype"])]
        if spec.get("fill") == "nan":
            value = np.full(shape, np.nan, dtype=dtype)
        elif spec.get("fill") == "ones":
            value = np.ones(shape, dtype=dtype)
        else:
            value = np.zeros(shape, dtype=dtype)
        result[str(spec["input_name"])] = value
    return result


def build_samples(
    main_path: Path,
    block_path: Path,
    manifest: list[dict[str, object]],
    bos: np.ndarray,
    latent_dim: int,
    conditioning_dim: int,
    count: int,
) -> list[dict[str, np.ndarray]]:
    rng = np.random.default_rng(20260716)
    state = make_state(manifest)
    main = ort.InferenceSession(str(main_path), providers=["CPUExecutionProvider"])
    main_values = main.run(None, {
        "sequence": np.zeros((1, 0, latent_dim), dtype=np.float32),
        "text_embeddings": rng.standard_normal((1, 64, conditioning_dim)).astype(np.float32),
        **state,
    })
    main_outputs = dict(zip((item.name for item in main.get_outputs()), main_values))
    for spec in manifest:
        state[str(spec["input_name"])] = main_outputs[str(spec["output_name"])]
    del main

    baseline = ort.InferenceSession(str(block_path), providers=["CPUExecutionProvider"])
    sequence = bos
    samples = []
    for _ in range(count):
        random_latents = rng.standard_normal((1, 4, latent_dim)).astype(np.float32)
        samples.append({
            "sequence": sequence.copy(),
            "random_latents": random_latents.copy(),
            **{name: value.copy() for name, value in state.items()},
        })
        values = baseline.run(None, {
            "sequence": sequence,
            "random_latents": random_latents,
            **state,
        })
        outputs = dict(zip((item.name for item in baseline.get_outputs()), values))
        sequence = outputs["next_sequence"]
        for spec in manifest:
            state[str(spec["input_name"])] = outputs[str(spec["output_name"])]
    return samples


def load_helpers(root: Path):
    path = root / "backend/tools/export_pocket_wasm_block_core.py"
    spec = importlib.util.spec_from_file_location("pocket_block_export", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--main", type=Path, required=True)
    parser.add_argument("--baseline-block", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--bos", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=3)
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    helpers = load_helpers(root)
    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    manifest = bundle["flow_lm_state_manifest"]
    samples = build_samples(
        args.main,
        args.baseline_block,
        manifest,
        np.load(args.bos).astype(np.float32),
        int(bundle["latent_dim"]),
        int(bundle["conditioning_dim"]),
        args.samples,
    )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {"schemaVersion": 1, "calibrationSamples": len(samples), "variants": {}}
    for name, weight_type, per_channel, reduce_range in CONFIGS:
        print(f"building {name}", flush=True)
        output = args.output_dir / f"flow_lm_decode_block4_{name}.onnx"
        quantize_static(
            model_input=str(args.model),
            model_output=str(output),
            calibration_data_reader=Reader(samples),
            quant_format=QuantFormat.QDQ,
            op_types_to_quantize=["MatMul"],
            per_channel=per_channel,
            reduce_range=reduce_range,
            activation_type=QuantType.QUInt8,
            weight_type=weight_type,
            calibrate_method=CalibrationMethod.MinMax,
            extra_options={
                "ActivationSymmetric": False,
                "WeightSymmetric": weight_type == QuantType.QInt8,
                "DedicatedQDQPair": False,
            },
        )
        model = onnx.load(str(output))
        model = helpers.toposort_graph(model)
        model, dead = helpers.eliminate_dead_nodes(model)
        model, duplicates = helpers.dedupe_initializers(model)
        model, pruned = helpers.prune_unused_initializers(model)
        onnx.checker.check_model(model)
        onnx.save(model, str(output))
        nodes = Counter(node.op_type for node in model.graph.node)
        report["variants"][name] = {
            "file": output.name,
            "bytes": output.stat().st_size,
            "weightType": "uint8" if weight_type == QuantType.QUInt8 else "int8",
            "perChannel": per_channel,
            "reduceRange": reduce_range,
            "deadNodesRemoved": dead,
            "duplicateInitializersMerged": duplicates,
            "unusedInitializersPruned": pruned,
            "nodes": dict(nodes),
        }
    (args.output_dir / "qdq_quantization_sweep.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8",
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
