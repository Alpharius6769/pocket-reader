"""Apply static-shape ONNX simplification to a fixed Pocket block core."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import onnx
import onnxsim


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    shapes = {
        "sequence": [1, 1, int(bundle["latent_dim"])],
        "random_latents": [1, 4, int(bundle["latent_dim"])],
    }
    for spec in bundle["flow_lm_state_manifest"]:
        shapes[str(spec["input_name"])] = [int(value) for value in spec["shape"]]

    source = onnx.load(str(args.model))
    before = Counter(node.op_type for node in source.graph.node)
    simplified, check = onnxsim.simplify(
        source,
        check_n=0,
        perform_optimization=True,
        overwrite_input_shapes=shapes,
        skip_constant_folding=False,
        skip_shape_inference=False,
    )
    onnx.checker.check_model(simplified)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(simplified, str(args.output))
    serialized = onnx.load(str(args.output))
    onnx.checker.check_model(serialized)
    after = Counter(node.op_type for node in serialized.graph.node)
    report = {
        "schemaVersion": 1,
        "source": str(args.model.resolve()),
        "output": str(args.output.resolve()),
        "check": bool(check),
        "beforeBytes": args.model.stat().st_size,
        "afterBytes": args.output.stat().st_size,
        "beforeNodes": sum(before.values()),
        "afterNodes": sum(after.values()),
        "removedByOp": {
            name: count - after.get(name, 0)
            for name, count in before.items()
            if count - after.get(name, 0) > 0
        },
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
