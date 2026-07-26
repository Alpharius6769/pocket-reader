"""Build dynamic INT8 quantization variants of Pocket's fixed block4 core."""

from __future__ import annotations

import argparse
import importlib.util
import json
from collections import Counter
from pathlib import Path

import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic


CONFIGS = [
    ("s8_tensor_full", QuantType.QInt8, False, False),
    ("s8_tensor_reduced", QuantType.QInt8, False, True),
    ("s8_channel_full", QuantType.QInt8, True, False),
    ("s8_channel_reduced", QuantType.QInt8, True, True),
    ("u8_tensor_full", QuantType.QUInt8, False, False),
    ("u8_tensor_reduced", QuantType.QUInt8, False, True),
    ("u8_channel_full", QuantType.QUInt8, True, False),
    ("u8_channel_reduced", QuantType.QUInt8, True, True),
]


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
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    helpers = load_helpers(root)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"schemaVersion": 1, "source": str(args.model.resolve()), "variants": {}}

    for name, weight_type, per_channel, reduce_range in CONFIGS:
        output = args.output_dir / f"flow_lm_decode_block4_{name}.onnx"
        print(f"building {name}", flush=True)
        quantize_dynamic(
            model_input=str(args.model),
            model_output=str(output),
            op_types_to_quantize=["MatMul"],
            per_channel=per_channel,
            reduce_range=reduce_range,
            weight_type=weight_type,
            extra_options={"ForceQuantizeNoType": True, "DefaultTensorType": 1},
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
    destination = args.output_dir / "dynamic_quantization_sweep.json"
    destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
