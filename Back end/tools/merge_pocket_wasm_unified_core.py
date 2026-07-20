"""Merge Pocket's INT8 prefill and block4 graphs into one weight-sharing ONNX.

The deployed WASM path currently keeps flow_lm_main (prefill) and an unrolled
block4 decoder in separate ORT sessions. Most transformer weights are therefore
resident twice. This tool places both graphs behind an ONNX If node and hoists
byte-identical initializers to the parent graph so ORT loads one shared copy.

The unified graph accepts ``decode_mode`` (false=prefill, true=block decode),
``sequence``, ``random_latents``, ``text_embeddings``, and the normal flattened
flow state. Both branches expose the block graph's output signature; prefill
returns zero placeholders for the three decode-only outputs.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


OUTPUT_NAME = "flow_lm_unified_block4_int8.onnx"


def _tensor_key(tensor: onnx.TensorProto) -> str:
    array = numpy_helper.to_array(tensor)
    digest = hashlib.sha256()
    digest.update(str(tensor.data_type).encode("ascii"))
    digest.update(b"|")
    digest.update(",".join(str(value) for value in tensor.dims).encode("ascii"))
    digest.update(b"|")
    digest.update(array.tobytes())
    return digest.hexdigest()


def _rewrite_inputs(graph: onnx.GraphProto, rename: dict[str, str]) -> None:
    for node in graph.node:
        for index, name in enumerate(node.input):
            if name in rename:
                node.input[index] = rename[name]
        for attribute in node.attribute:
            if attribute.type == onnx.AttributeProto.GRAPH:
                _rewrite_inputs(attribute.g, rename)
            elif attribute.type == onnx.AttributeProto.GRAPHS:
                for subgraph in attribute.graphs:
                    _rewrite_inputs(subgraph, rename)


def dedupe_initializers(
    graphs: list[onnx.GraphProto],
) -> tuple[list[onnx.TensorProto], int]:
    """Hoist and content-deduplicate every branch initializer."""

    key_to_name: dict[str, str] = {}
    parent_initializers: list[onnx.TensorProto] = []
    duplicate_count = 0
    for graph in graphs:
        rename: dict[str, str] = {}
        for initializer in graph.initializer:
            key = _tensor_key(initializer)
            shared_name = key_to_name.get(key)
            if shared_name is None:
                shared_name = f"shared_init_{len(parent_initializers):04d}"
                key_to_name[key] = shared_name
                hoisted = copy.deepcopy(initializer)
                hoisted.name = shared_name
                parent_initializers.append(hoisted)
            else:
                duplicate_count += 1
            rename[initializer.name] = shared_name
        _rewrite_inputs(graph, rename)
        del graph.initializer[:]
    return parent_initializers, duplicate_count


def _eliminate_dead_nodes(graph: onnx.GraphProto) -> int:
    live_values = {output.name for output in graph.output}
    live_nodes: set[int] = set()
    changed = True
    while changed:
        changed = False
        for index, node in enumerate(graph.node):
            if index in live_nodes or not any(name in live_values for name in node.output):
                continue
            live_nodes.add(index)
            for name in node.input:
                if name and name not in live_values:
                    live_values.add(name)
                    changed = True
    kept = [graph.node[index] for index in range(len(graph.node)) if index in live_nodes]
    removed = len(graph.node) - len(kept)
    del graph.node[:]
    graph.node.extend(kept)
    return removed


def _referenced_values(graph: onnx.GraphProto) -> set[str]:
    values: set[str] = set()
    for node in graph.node:
        values.update(name for name in node.input if name)
        for attribute in node.attribute:
            if attribute.type == onnx.AttributeProto.GRAPH:
                values.update(_referenced_values(attribute.g))
            elif attribute.type == onnx.AttributeProto.GRAPHS:
                for subgraph in attribute.graphs:
                    values.update(_referenced_values(subgraph))
    return values


def _copy_input(value: onnx.ValueInfoProto, name: str | None = None) -> onnx.ValueInfoProto:
    result = copy.deepcopy(value)
    if name is not None:
        result.name = name
    return result


def _make_prefill_branch(main: onnx.ModelProto, block: onnx.ModelProto) -> onnx.GraphProto:
    graph = copy.deepcopy(main.graph)
    _rewrite_inputs(graph, {"sequence": "prefill_empty_sequence"})
    empty_sequence = helper.make_node(
        "Constant",
        [],
        ["prefill_empty_sequence"],
        name="PrefillEmptySequence",
        value=numpy_helper.from_array(np.zeros((1, 0, 32), dtype=np.float32)),
    )
    dummy_outputs = [
        helper.make_node(
            "Constant", [], ["prefill_latents"], name="PrefillDummyLatents",
            value=numpy_helper.from_array(np.zeros((1, 4, 32), dtype=np.float32)),
        ),
        helper.make_node(
            "Constant", [], ["prefill_next_sequence"], name="PrefillDummySequence",
            value=numpy_helper.from_array(np.zeros((1, 1, 32), dtype=np.float32)),
        ),
        helper.make_node(
            "Constant", [], ["prefill_eos_logits"], name="PrefillDummyEos",
            value=numpy_helper.from_array(np.zeros((1, 4), dtype=np.float32)),
        ),
    ]
    graph.node.insert(0, empty_sequence)
    graph.node.extend(dummy_outputs)

    state_outputs = [copy.deepcopy(value) for value in main.graph.output[2:]]
    del graph.output[:]
    graph.output.extend([
        _copy_input(block.graph.output[0], "prefill_latents"),
        _copy_input(block.graph.output[1], "prefill_next_sequence"),
        _copy_input(block.graph.output[2], "prefill_eos_logits"),
        *state_outputs,
    ])
    del graph.input[:]
    graph.name = "pocket_prefill_branch"
    _eliminate_dead_nodes(graph)
    return graph


def _make_decode_branch(block: onnx.ModelProto) -> onnx.GraphProto:
    graph = copy.deepcopy(block.graph)
    del graph.input[:]
    graph.name = "pocket_decode_block4_branch"
    _eliminate_dead_nodes(graph)
    return graph


def merge(main_path: Path, block_path: Path, output_dir: Path) -> dict[str, object]:
    main = onnx.load(str(main_path))
    block = onnx.load(str(block_path))
    if [value.name for value in main.graph.output[2:]] != [value.name for value in block.graph.output[3:]]:
        raise ValueError("Prefill and block state output manifests do not match.")
    if [value.name for value in main.graph.input[2:]] != [value.name for value in block.graph.input[2:]]:
        raise ValueError("Prefill and block state input manifests do not match.")

    prefill_graph = _make_prefill_branch(main, block)
    decode_graph = _make_decode_branch(block)
    parent_initializers, duplicate_count = dedupe_initializers([prefill_graph, decode_graph])

    parent_inputs = [
        helper.make_tensor_value_info("decode_mode", TensorProto.BOOL, []),
        _copy_input(block.graph.input[0]),
        _copy_input(block.graph.input[1]),
        _copy_input(main.graph.input[1]),
        *[_copy_input(value) for value in block.graph.input[2:]],
    ]
    parent_outputs = [_copy_input(value) for value in block.graph.output]
    if_node = helper.make_node(
        "If",
        ["decode_mode"],
        [value.name for value in parent_outputs],
        name="PocketPrefillOrDecodeBlock4",
        then_branch=decode_graph,
        else_branch=prefill_graph,
    )
    graph = helper.make_graph(
        [if_node],
        "pocket_flow_lm_unified_block4_int8",
        parent_inputs,
        parent_outputs,
        initializer=parent_initializers,
    )
    model = helper.make_model(
        graph,
        opset_imports=[copy.deepcopy(value) for value in block.opset_import],
        producer_name="pocket-reader-unified-core",
    )
    model.ir_version = max(main.ir_version, block.ir_version)

    referenced = _referenced_values(model.graph)
    kept = [value for value in model.graph.initializer if value.name in referenced]
    pruned = len(model.graph.initializer) - len(kept)
    del model.graph.initializer[:]
    model.graph.initializer.extend(kept)

    onnx.checker.check_model(model)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / OUTPUT_NAME
    onnx.save(model, str(output_path))
    # Recheck the serialized form as well; this catches oversized-field or
    # external-data mistakes that an in-memory check can miss.
    onnx.checker.check_model(onnx.load(str(output_path)))

    metadata = {
        "schemaVersion": 1,
        "file": output_path.name,
        "bytes": output_path.stat().st_size,
        "prefillSourceBytes": main_path.stat().st_size,
        "decodeSourceBytes": block_path.stat().st_size,
        "sourceBytesTotal": main_path.stat().st_size + block_path.stat().st_size,
        "duplicateInitializersMerged": duplicate_count,
        "unusedInitializersPruned": pruned,
        "initializerCount": len(model.graph.initializer),
    }
    (output_dir / "wasm_unified_core.json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8",
    )
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--main", type=Path, required=True)
    parser.add_argument("--block", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(merge(args.main, args.block, args.output_dir), indent=2))


if __name__ == "__main__":
    main()
