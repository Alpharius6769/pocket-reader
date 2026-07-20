"""Audit a Pocket INT8 ONNX bundle before attempting a WebGPU experiment."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import onnx


MODEL_FILES = (
    "text_conditioner_int8.onnx",
    "flow_lm_main_int8.onnx",
    "flow_lm_flow_int8.onnx",
    "mimi_decoder_int8.onnx",
)

# These operators make the current dynamic-quantized export CPU-oriented in
# ONNX Runtime Web 1.27. A future WebGPU export must replace them with a
# certified GPU quantization form before runtime calibration is allowed.
PURE_WEBGPU_BLOCKERS = {
    "DynamicQuantizeLinear",
    "MatMulInteger",
    "ScatterElements",
    "ScatterND",
    "IsNaN",
}


def audit(bundle_dir: Path) -> dict[str, object]:
    models: dict[str, object] = {}
    bundle_blockers: set[str] = set()
    for filename in MODEL_FILES:
        path = bundle_dir / filename
        if not path.is_file():
            raise FileNotFoundError(path)
        model = onnx.load(str(path), load_external_data=False)
        counts = Counter(node.op_type for node in model.graph.node)
        blockers = sorted(operator for operator in PURE_WEBGPU_BLOCKERS if counts[operator])
        bundle_blockers.update(blockers)
        models[filename] = {
            "nodes": len(model.graph.node),
            "operators": dict(sorted(counts.items())),
            "pure_webgpu_blockers": blockers,
        }

    return {
        "schema_version": 1,
        "bundle": bundle_dir.name,
        "ort_web_version": "1.27.0",
        "pure_webgpu_candidate": not bundle_blockers,
        "runtime_enabled": False,
        "decision": (
            "eligible for isolated benchmark certification"
            if not bundle_blockers
            else "rejected: current dynamic INT8 export would require CPU fallback partitions"
        ),
        "blocking_operators": sorted(bundle_blockers),
        "models": models,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle_dir", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = audit(args.bundle_dir)
    rendered = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
