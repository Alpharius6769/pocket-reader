"""Remove zero-sized recurrent I/O that prevents ORT WebGPU graph capture."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import onnx


def has_zero_dim(value) -> bool:
    dims = value.type.tensor_type.shape.dim
    return any(dim.HasField("dim_value") and dim.dim_value == 0 for dim in dims)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    model = onnx.load(str(args.input))
    graph = model.graph
    removed_inputs = [value.name for value in graph.input if has_zero_dim(value)]
    removed_outputs = [value.name for value in graph.output if has_zero_dim(value)]
    kept_outputs = [value for value in graph.output if value.name not in removed_outputs]

    # Keep exactly the nodes needed to produce non-empty public outputs.
    live_values = {value.name for value in kept_outputs}
    live_nodes = set()
    changed = True
    while changed:
        changed = False
        for index in range(len(graph.node) - 1, -1, -1):
            node = graph.node[index]
            if index in live_nodes or not any(name in live_values for name in node.output):
                continue
            live_nodes.add(index)
            for name in node.input:
                if name and name not in live_values:
                    live_values.add(name)
                    changed = True

    kept_nodes = [graph.node[index] for index in range(len(graph.node)) if index in live_nodes]
    kept_inputs = [value for value in graph.input if value.name in live_values]
    kept_initializers = [value for value in graph.initializer if value.name in live_values]
    before = {
        "bytes": args.input.stat().st_size,
        "nodes": len(graph.node),
        "inputs": len(graph.input),
        "outputs": len(graph.output),
        "initializers": len(graph.initializer),
    }
    del graph.node[:]
    graph.node.extend(kept_nodes)
    del graph.input[:]
    graph.input.extend(kept_inputs)
    del graph.output[:]
    graph.output.extend(kept_outputs)
    del graph.initializer[:]
    graph.initializer.extend(kept_initializers)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(args.output))
    onnx.checker.check_model(onnx.load(str(args.output)))
    after = {
        "bytes": args.output.stat().st_size,
        "nodes": len(graph.node),
        "inputs": len(graph.input),
        "outputs": len(graph.output),
        "initializers": len(graph.initializer),
    }
    report = {
        "schemaVersion": 1,
        "input": str(args.input.resolve()),
        "output": str(args.output.resolve()),
        "removedInputs": removed_inputs,
        "removedOutputs": removed_outputs,
        "before": before,
        "after": after,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(report, indent=2) + "\n"
    args.report.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
