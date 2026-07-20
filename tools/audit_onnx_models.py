"""Tier 2a/2b read-only audit of the deployed INT8 WASM models.

2a: quantization coverage - which ops carry the heavy math, and how many are
    still fp32 (MatMul/Gemm/Conv) vs dynamically quantized (MatMulInteger).
2b: KV-cache attention pattern - does flow_lm_main attend over the full
    1000-slot preallocated cache every step, or slice to the filled region?
"""
import json
import sys
from collections import Counter
from pathlib import Path

import onnx

BUNDLE = Path(__file__).resolve().parents[1] / "pocket-tts-onnx-b2-upload" / "onnx" / "english_2026-04"

HEAVY_FP32 = {"MatMul", "Gemm", "Conv", "ConvTranspose"}
HEAVY_INT8 = {"MatMulInteger", "QLinearMatMul", "QLinearConv", "ConvInteger", "DynamicQuantizeLinear"}


def audit(name):
    path = BUNDLE / name
    model = onnx.load(str(path), load_external_data=False)
    ops = Counter(node.op_type for node in model.graph.node)
    heavy_fp = {op: n for op, n in ops.items() if op in HEAVY_FP32}
    heavy_q = {op: n for op, n in ops.items() if op in HEAVY_INT8}
    print(f"\n== {name} ({path.stat().st_size/1048576:.1f} MB, {sum(ops.values())} nodes) ==")
    print(f"  fp32 heavy ops: {heavy_fp}")
    print(f"  int8 heavy ops: {heavy_q}")
    # For fp32 MatMuls, report their weight sizes (are the stragglers big?)
    inits = {i.name: i for i in model.graph.initializer}
    fp32_weight_bytes = 0
    examples = []
    for node in model.graph.node:
        if node.op_type in HEAVY_FP32:
            for inp in node.input:
                if inp in inits:
                    t = inits[inp]
                    elems = 1
                    for d in t.dims:
                        elems *= d
                    fp32_weight_bytes += elems * 4
                    if len(examples) < 6:
                        examples.append(f"{node.op_type}[{node.name or '?'}] w={list(t.dims)}")
    print(f"  fp32 heavy-op weight bytes: {fp32_weight_bytes/1048576:.1f} MB")
    for e in examples:
        print(f"    e.g. {e}")
    return ops


def audit_attention(name):
    """Look at how the cache state inputs feed attention: full-window or sliced."""
    path = BUNDLE / name
    model = onnx.load(str(path), load_external_data=False)
    graph = model.graph
    ops = Counter(n.op_type for n in graph.node)
    interesting = {k: v for k, v in ops.items() if k in (
        "Slice", "Gather", "GatherElements", "ScatterND", "ScatterElements",
        "Where", "Range", "Softmax", "Concat", "Trilu", "Attention", "MultiHeadAttention")}
    print(f"\n== attention/cache ops in {name} ==")
    print(f"  {interesting}")
    # Trace what consumes the big cache states: find nodes whose input is a state_N input
    state_inputs = [i.name for i in graph.input if i.name.startswith("state_")]
    consumers = Counter()
    for node in graph.node:
        for inp in node.input:
            if inp in state_inputs:
                consumers[node.op_type] += 1
    print(f"  direct consumers of state_* inputs: {dict(consumers)}")


if __name__ == "__main__":
    for f in ["flow_lm_main_int8.onnx", "flow_lm_flow_int8.onnx",
              "mimi_decoder_int8.onnx", "text_conditioner_int8.onnx"]:
        audit(f)
    audit_attention("flow_lm_main_int8.onnx")
